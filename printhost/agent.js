#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 *  POSTER PRINT AGENT  —  runs on the Windows box that has the Canon drivers
 * ============================================================================
 *  Deliberately small and dumb. It does four things:
 *
 *    1. Accepts a signed job envelope from the portal.
 *    2. Pulls the print raster itself (resumable), so the portal never has to
 *       push 300 MB through a request that might die.
 *    3. Shells out to Windows PowerShell 5.1 to hand the file to the driver,
 *       and captures the spooler JobId by matching on DocumentName.
 *    4. Polls the spooler and posts deltas back to the portal.
 *
 *  It holds no queue of its own beyond a small JSON file that survives a
 *  reboot. The portal is the system of record; if this box is rebuilt from
 *  scratch, nothing is lost but the in-flight page.
 * ============================================================================
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
require('dotenv').config();

const VERSION = '1.0.0';
const CFG = {
  hostCode: process.env.PP_HOST_CODE || 'bowman-01',
  portalUrl: (process.env.PP_PORTAL_URL || 'https://posters.kent.edu').replace(/\/$/, ''),
  hmacSecret: process.env.PP_HMAC_SECRET,
  listenPort: Number(process.env.PP_LISTEN_PORT || 8443),
  listenHost: process.env.PP_LISTEN_HOST || '0.0.0.0',
  tlsCert: process.env.PP_TLS_CERT || '',
  tlsKey: process.env.PP_TLS_KEY || '',
  spoolDir: process.env.PP_SPOOL_DIR || 'C:\\ProgramData\\PosterPrint\\spool',
  stateFile: process.env.PP_STATE_FILE || 'C:\\ProgramData\\PosterPrint\\state.json',
  scriptDir: process.env.PP_SCRIPT_DIR || path.join(__dirname, 'scripts'),
  // Windows PowerShell 5.1, not pwsh: System.Drawing.Printing is Windows-only
  // and PowerShell 7 needs a compat shim for it.
  powershell: process.env.PP_POWERSHELL ||
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  pollMs: Number(process.env.PP_POLL_MS || 4000),
  reapAfterHours: Number(process.env.PP_REAP_AFTER_HOURS || 48),
  keepSpoolFiles: /^(1|true|yes)$/i.test(process.env.PP_KEEP_SPOOL_FILES || 'false'),
};

if (!CFG.hmacSecret) {
  console.error('PP_HMAC_SECRET is not set. Get it from the portal seed output.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State — one small JSON file, written atomically
// ---------------------------------------------------------------------------
let state = { jobs: {} };   // docToken -> { hostJobId, printer, file, status, ... }

function loadState() {
  try { state = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); }
  catch { state = { jobs: {} }; }
  if (!state.jobs) state.jobs = {};
}
function saveState() {
  const tmp = `${CFG.stateFile}.tmp`;
  fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CFG.stateFile);
}

// ---------------------------------------------------------------------------
// Signing (mirrors webapp/src/security.js)
// ---------------------------------------------------------------------------
function signBody(rawBody, timestamp = Date.now().toString()) {
  const mac = crypto.createHmac('sha256', CFG.hmacSecret)
    .update(`${timestamp}.`).update(rawBody).digest('hex');
  return { timestamp, signature: `v1=${mac}` };
}
function verifyBody(rawBody, timestamp, signature, toleranceMs = 300000) {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > toleranceMs) return false;
  const expected = signBody(rawBody, timestamp).signature;
  const a = Buffer.from(expected); const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function postToPortal(pathname, payload) {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = signBody(body);
  const res = await fetch(CFG.portalUrl + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PP-Host': CFG.hostCode,
      'X-PP-Timestamp': timestamp,
      'X-PP-Signature': signature,
    },
    body,
  });
  if (!res.ok) throw new Error(`portal ${pathname} -> HTTP ${res.status}`);
  return res.json();
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
function report(level, message, extra = {}) {
  log(`[${level}]`, message);
  postToPortal('/api/agent/event', { level, message, ...extra }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Resumable download of the print raster
// ---------------------------------------------------------------------------
async function pullRaster(url, destPath, expectedBytes) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  let have = 0;
  try { have = (await fsp.stat(destPath)).size; } catch { have = 0; }
  if (expectedBytes && have === expectedBytes) return destPath;   // already here
  if (have > expectedBytes) { await fsp.unlink(destPath); have = 0; }

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const headers = { 'X-PP-Host': CFG.hostCode };
      if (have > 0) headers.Range = `bytes=${have}-`;
      const res = await fetch(url, { headers });
      if (!res.ok && res.status !== 206) throw new Error(`pull HTTP ${res.status}`);

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(destPath, { flags: have > 0 ? 'a' : 'w' });
        const reader = res.body.getReader();
        (async function pump() {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!out.write(Buffer.from(value))) {
                await new Promise((r) => out.once('drain', r));
              }
            }
            out.end(resolve);
          } catch (e) { out.destroy(); reject(e); }
        })();
        out.on('error', reject);
      });

      const size = (await fsp.stat(destPath)).size;
      if (expectedBytes && size !== expectedBytes) {
        have = size;
        throw new Error(`short read: ${size}/${expectedBytes}`);
      }
      return destPath;
    } catch (err) {
      log(`[pull] attempt ${attempt} failed: ${err.message}`);
      try { have = (await fsp.stat(destPath)).size; } catch { have = 0; }
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// PowerShell bridge
// ---------------------------------------------------------------------------
function runPowerShell(script, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const full = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(CFG.scriptDir, script), ...args,
    ];
    execFile(CFG.powershell, full, { timeout: timeoutMs, maxBuffer: 32 << 20 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          return reject(new Error(`${script}: ${err.message} ${String(stderr).slice(0, 500)}`));
        }
        // Scripts emit one JSON object on the last non-empty stdout line.
        const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1];
        try { resolve(JSON.parse(last)); }
        catch {
          reject(new Error(`${script}: unparseable output: ${String(stdout).slice(0, 500)}`));
        }
      });
  });
}

// ---------------------------------------------------------------------------
// HTTP surface — one endpoint
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.post('/print', async (req, res) => {
  if (!verifyBody(req.rawBody || Buffer.alloc(0),
    req.get('x-pp-timestamp'), req.get('x-pp-signature'))) {
    return res.status(401).json({ error: 'bad_signature' });
  }
  const env = req.body;
  if (!env?.docToken || !env?.file?.url || !env?.windowsPrinterName) {
    return res.status(400).json({ error: 'bad_envelope' });
  }
  if (state.jobs[env.docToken]) {
    return res.json({ ok: true, agentVersion: VERSION, detail: 'already accepted' });
  }

  state.jobs[env.docToken] = {
    docToken: env.docToken, publicId: env.publicId,
    printer: env.windowsPrinterName, status: 'downloading',
    acceptedAt: new Date().toISOString(), media: env.media, copies: env.copies || 1,
  };
  saveState();

  // Answer immediately; the work happens behind the response.
  res.json({ ok: true, agentVersion: VERSION, detail: 'accepted' });

  // The portal decides PNG vs JPEG (see PRINT_FORMAT). Keep the real
  // extension: GDI+ picks its decoder from the file, not from us.
  const ext = (env.mime === 'image/jpeg') ? 'jpg' : 'png';
  const spoolPath = path.join(CFG.spoolDir, `${env.docToken.replace(/[#\\/:*?"<>|]/g, '_')}.${ext}`);
  try {
    await pullRaster(env.file.url, spoolPath, env.file.bytes);
    state.jobs[env.docToken].file = spoolPath;
    state.jobs[env.docToken].status = 'printing';
    saveState();

    const result = await runPowerShell('Print-Poster.ps1', [
      '-FilePath', spoolPath,
      '-PrinterName', env.windowsPrinterName,
      '-DocumentName', env.docToken,
      '-WidthIn', String(env.media.widthIn),
      '-HeightIn', String(env.media.heightIn),
      '-Copies', String(env.copies || 1),
      ...(env.driverPreset ? ['-Preset', env.driverPreset] : []),
    ]);

    if (!result.ok) throw new Error(result.error || 'print script reported failure');
    state.jobs[env.docToken].hostJobId = result.jobId ?? null;
    state.jobs[env.docToken].submittedAt = new Date().toISOString();
    saveState();
    report('info', `submitted ${env.docToken} to ${env.windowsPrinterName} ` +
      `as spooler job ${result.jobId ?? '(unknown)'}`, { docToken: env.docToken });
    pollOnce().catch(() => {});
  } catch (err) {
    state.jobs[env.docToken].status = 'error';
    state.jobs[env.docToken].error = String(err.message).slice(0, 500);
    saveState();
    report('error', `failed ${env.docToken}: ${err.message}`, { docToken: env.docToken });
    postToPortal('/api/agent/status', {
      agentVersion: VERSION,
      jobs: [{ docToken: env.docToken, state: 'Error', error: String(err.message).slice(0, 300) }],
    }).catch(() => {});
  }
});

app.get('/healthz', (_req, res) =>
  res.json({ ok: true, version: VERSION, host: CFG.hostCode, tracking: Object.keys(state.jobs).length }));

// ---------------------------------------------------------------------------
// Spooler polling
// ---------------------------------------------------------------------------
let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const printers = [...new Set(Object.values(state.jobs).map((j) => j.printer))];
    const snapshot = await runPowerShell('Get-PosterQueue.ps1',
      printers.length ? ['-PrinterNames', printers.join(',')] : [], 60000);

    const seen = new Map();
    for (const j of snapshot.jobs || []) seen.set(j.documentName, j);

    const jobs = [];
    for (const [token, tracked] of Object.entries(state.jobs)) {
      const live = seen.get(token);
      if (live) {
        tracked.hostJobId = live.jobId;
        tracked.lastState = live.state;
        jobs.push({
          docToken: token, hostJobId: live.jobId, state: live.state,
          detail: live.statusText || null, position: live.position ?? null,
          error: live.error || null,
        });
      } else if (tracked.submittedAt) {
        // Gone from the spooler. If we ever saw it printing, it finished.
        // (With "keep printed documents" on, we'd see Retained instead.)
        const grace = Date.now() - new Date(tracked.submittedAt).getTime() > 20000;
        if (grace) {
          jobs.push({
            docToken: token, hostJobId: tracked.hostJobId ?? null,
            state: tracked.lastState === 'Error' ? 'Error' : 'Printed',
            gone: true, detail: 'no longer in the spooler',
          });
          tracked.status = 'done';
          tracked.completedAt = tracked.completedAt || new Date().toISOString();
        }
      }
    }

    if (jobs.length || (snapshot.printers || []).length) {
      await postToPortal('/api/agent/status', {
        agentVersion: VERSION,
        jobs,
        printers: (snapshot.printers || []).map((p) => ({
          windowsPrinterName: p.name, state: p.state, queuedJobs: p.queued,
          activeJob: p.activeJob || null, message: p.message || null,
          inkLevels: p.inkLevels || null, loadedRollIn: p.loadedRollIn ?? null,
          paperRemainingFt: p.paperRemainingFt ?? null,
        })),
      });
    }
    saveState();
  } catch (err) {
    log('[poll]', err.message);
  } finally {
    polling = false;
  }
}

/**
 * Reaper. The spooler is not a database: leaving "keep printed documents" on
 * without pruning fills the spool directory and eventually wedges the service.
 * Once the portal has the final status we drop both the spooler record and
 * our copy of the raster.
 */
async function reap() {
  const cutoff = Date.now() - CFG.reapAfterHours * 3600_000;
  const doomed = Object.entries(state.jobs).filter(([, j]) =>
    ['done', 'error'].includes(j.status) &&
    new Date(j.completedAt || j.acceptedAt).getTime() < cutoff);

  for (const [token, j] of doomed) {
    if (j.hostJobId && j.printer) {
      await runPowerShell('Get-PosterQueue.ps1',
        ['-RemoveJobId', String(j.hostJobId), '-PrinterNames', j.printer], 30000)
        .catch(() => {});
    }
    if (j.file && !CFG.keepSpoolFiles) await fsp.unlink(j.file).catch(() => {});
    delete state.jobs[token];
  }
  if (doomed.length) { saveState(); log(`[reap] cleared ${doomed.length} finished jobs`); }

  // Belt and braces: anything left in the spool dir older than the window.
  try {
    for (const f of await fsp.readdir(CFG.spoolDir)) {
      const p = path.join(CFG.spoolDir, f);
      const st = await fsp.stat(p);
      if (st.mtimeMs < cutoff && !CFG.keepSpoolFiles) await fsp.unlink(p).catch(() => {});
    }
  } catch { /* dir may not exist yet */ }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function hello() {
  try {
    const snapshot = await runPowerShell('Get-PosterQueue.ps1', ['-ListPrinters'], 60000);
    const res = await postToPortal('/api/agent/hello', {
      agentVersion: VERSION,
      hostname: os.hostname(),
      printers: (snapshot.printers || []).map((p) => ({ name: p.name, state: p.state })),
    });
    if (res.missingOnHost?.length) {
      report('error', `configured printers not found on this host: ${res.missingOnHost.join(', ')}`);
    }
    if (res.statusIntervalMs) CFG.pollMs = res.statusIntervalMs;
    log(`[agent] registered with portal — ${res.expectedPrinters?.length || 0} printers expected`);
  } catch (e) {
    log('[agent] hello failed (will retry):', e.message);
    setTimeout(hello, 30000).unref?.();
  }
}

loadState();
fs.mkdirSync(CFG.spoolDir, { recursive: true });

const server = (CFG.tlsCert && CFG.tlsKey)
  ? https.createServer({
      cert: fs.readFileSync(CFG.tlsCert), key: fs.readFileSync(CFG.tlsKey),
      minVersion: 'TLSv1.2',
    }, app)
  : http.createServer(app);

server.listen(CFG.listenPort, CFG.listenHost, () => {
  log(`[agent] ${VERSION} listening on ${CFG.listenHost}:${CFG.listenPort} ` +
      `(${CFG.tlsCert ? 'https' : 'http'}) as ${CFG.hostCode}`);
  if (!CFG.tlsCert) log('[agent] WARNING: no TLS cert — only acceptable on a trusted VLAN');
  hello();
});

setInterval(() => pollOnce().catch(() => {}), CFG.pollMs).unref();
setInterval(() => reap().catch(() => {}), 3600_000).unref();
setInterval(() => hello().catch(() => {}), 300_000).unref();   // heartbeat

process.on('SIGTERM', () => { saveState(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { saveState(); server.close(() => process.exit(0)); });
process.on('unhandledRejection', (e) => log('[unhandledRejection]', e));
