'use strict';
/**
 * Portal -> Windows print host.
 *
 * The portal never pushes 300 MB at the agent. It posts a small job envelope
 * containing a signed, expiring pull URL; the agent downloads the raster on
 * its own schedule with Range support, so a restart resumes instead of
 * restarting. The agent then reports spooler state back to /api/agent/status.
 */
const crypto = require('crypto');
const config = require('./config');
const { q, logEvent, setStatus } = require('./db');
const storage = require('./storage');
const security = require('./security');
const events = require('./events');

let timer = null;

/** Short-lived signed URL the agent uses to pull the print raster. */
function signedPullUrl(job, host) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = `${job.public_id}.${exp}`;
  const sig = crypto.createHmac('sha256', host.hmac_secret).update(payload).digest('hex');
  return `${config.publicUrl}/api/agent/pull/${job.public_id}?exp=${exp}&sig=${sig}`;
}

function verifyPullSignature(publicId, exp, sig, host) {
  if (!exp || !sig) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  const expected = crypto.createHmac('sha256', host.hmac_secret)
    .update(`${publicId}.${exp}`).digest('hex');
  return security.timingSafeEqual(expected, sig);
}

/**
 * Send an approved job to its printer. Idempotent per (job, attempt) via the
 * unique doc_token, which is also the DocumentName in the Windows spooler —
 * that string is how we tie a spooler JobId back to our row.
 */
async function dispatchJob(jobId, { actor = 'system' } = {}) {
  const job = q.one('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) throw new Error('job not found');

  const printer = q.one('SELECT * FROM printers WHERE id = ? AND is_active = 1', job.printer_id);
  if (!printer) throw new Error('printer not configured or inactive');
  const host = q.one('SELECT * FROM print_hosts WHERE id = ? AND is_active = 1',
    printer.print_host_id);
  if (!host) throw new Error('print host not configured or inactive');

  const printFile = storage.getJobFile(job.id, 'print');
  if (!printFile) {
    const e = new Error('print raster not ready');
    e.code = 'RASTER_NOT_READY';
    throw e;
  }

  const attempt = (q.one(
    'SELECT COALESCE(MAX(attempt),0) AS a FROM print_dispatches WHERE job_id = ?', job.id).a) + 1;
  const docToken = `${job.public_id}#${attempt}`;

  const dispatchId = q.run(
    `INSERT INTO print_dispatches
       (job_id, printer_id, print_host_id, attempt, doc_token, status)
     VALUES (?,?,?,?,?,'sending')`,
    job.id, printer.id, host.id, attempt, docToken
  ).lastInsertRowid;

  const envelope = {
    docToken,
    publicId: job.public_id,
    title: job.title.slice(0, 120),
    requester: q.one('SELECT email FROM users WHERE id = ?', job.user_id)?.email,
    windowsPrinterName: printer.windows_printer_name,
    driverPreset: printer.driver_preset || null,
    copies: job.copies,
    media: {
      widthIn: job.finished_width_in,
      heightIn: job.finished_height_in,
      rollWidthIn: printer.roll_width_in,
      orientation: job.orientation,
      dpi: printFile.density_dpi || config.print.targetDpi,
      widthPx: printFile.width_px,
      heightPx: printFile.height_px,
    },
    file: {
      url: signedPullUrl(job, host),
      bytes: printFile.byte_size,
      sha256: null,                            // renditions aren't hashed; length + doc token suffice
      mime: printFile.mime,
    },
    callback: `${config.publicUrl}/api/agent/status`,
  };

  const body = JSON.stringify(envelope);
  const { timestamp, signature } = security.signBody(host.hmac_secret, body);

  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${host.base_url.replace(/\/$/, '')}/print`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PP-Timestamp': timestamp,
        'X-PP-Signature': signature,
        'X-PP-Host': host.code,
      },
      body,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `agent HTTP ${res.status}`);

    q.run(
      `UPDATE print_dispatches SET status = 'spooling', status_detail = ?,
          bytes_sent = ? WHERE id = ?`,
      json.detail || 'accepted by agent', printFile.byte_size, dispatchId);
    q.run("UPDATE print_hosts SET last_seen_at = datetime('now'), status='online', agent_version = ? WHERE id = ?",
      json.agentVersion || null, host.id);

    setStatus(job.id, 'queued', {
      actor, message: `Sent to ${printer.display_name}`,
      data: { docToken, dispatchId },
    });
    events.toJob(job, 'job:status', {
      status: 'queued', printer: printer.display_name, docToken,
    });
    return { dispatchId, docToken };
  } catch (err) {
    q.run('UPDATE print_dispatches SET status = ?, error = ? WHERE id = ?',
      'error', String(err.message).slice(0, 500), dispatchId);
    q.run("UPDATE print_hosts SET status='offline' WHERE id = ?", host.id);
    logEvent({ jobId: job.id, actor, kind: 'error',
      message: `Could not reach the print host: ${err.message}` });
    events.toAdmin('dispatch:failed', {
      jobId: job.public_id, printer: printer.display_name, error: String(err.message) });
    throw err;
  } finally {
    clearTimeout(abort);
  }
}

/**
 * Apply a status report from an agent. Called by /api/agent/status.
 * Windows spooler states map onto our own, and a job that vanishes from the
 * queue after we saw it printing counts as completed — which is what happens
 * when "keep printed documents" is off.
 */
const SPOOLER_MAP = {
  Spooling: 'spooling', Printing: 'printing', Paused: 'paused',
  Retained: 'completed', Printed: 'completed', Complete: 'completed',
  Deleting: 'deleted', Deleted: 'deleted', Error: 'error', Offline: 'error',
  PaperOut: 'error', UserIntervention: 'error', Blocked: 'error',
  Queued: 'queued', Restart: 'queued',
};

function applyAgentReport(hostCode, report) {
  const host = q.one('SELECT * FROM print_hosts WHERE code = ?', hostCode);
  if (!host) throw new Error('unknown host');
  q.run(
    `UPDATE print_hosts SET last_seen_at = datetime('now'), status = 'online',
        agent_version = COALESCE(?, agent_version) WHERE id = ?`,
    report.agentVersion || null, host.id);

  const results = [];
  for (const item of report.jobs || []) {
    const d = q.one('SELECT * FROM print_dispatches WHERE doc_token = ?', item.docToken);
    if (!d) continue;
    const job = q.one('SELECT * FROM jobs WHERE id = ?', d.job_id);
    const mapped = SPOOLER_MAP[item.state] || (item.gone ? 'completed' : d.status);

    q.run(
      `UPDATE print_dispatches SET status = ?, status_detail = ?, host_job_id = ?,
          position_in_queue = ?, last_polled_at = datetime('now'),
          first_seen_at = COALESCE(first_seen_at, datetime('now')),
          completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END,
          error = ? WHERE id = ?`,
      mapped, item.detail || null, item.hostJobId ?? d.host_job_id,
      item.position ?? null, mapped, item.error || null, d.id);

    if (job) {
      try {
        if (mapped === 'printing' && job.status === 'queued') {
          setStatus(job.id, 'printing', { actor: `agent:${hostCode}` });
        } else if (mapped === 'completed' && ['queued', 'printing'].includes(job.status)) {
          setStatus(job.id, 'printed', { actor: `agent:${hostCode}` });
        } else if (mapped === 'error' && !['failed', 'cancelled'].includes(job.status)) {
          setStatus(job.id, 'failed', {
            actor: `agent:${hostCode}`, message: item.error || item.detail || 'Printer reported an error',
          });
        }
      } catch { /* terminal state already reached */ }

      events.toJob(job, 'job:spooler', {
        status: mapped, detail: item.detail || null,
        position: item.position ?? null, hostJobId: item.hostJobId ?? null,
      });
    }
    results.push({ docToken: item.docToken, applied: mapped });
  }

  // Device-level snapshot: ink, roll, queue depth.
  for (const dev of report.printers || []) {
    const printer = q.one(
      'SELECT * FROM printers WHERE print_host_id = ? AND windows_printer_name = ?',
      host.id, dev.windowsPrinterName);
    if (!printer) continue;
    q.run(
      `INSERT INTO printer_status
         (printer_id, reported_at, device_state, loaded_roll_in, paper_remaining_ft,
          ink_levels_json, queued_jobs, active_job_label, message)
       VALUES (?, datetime('now'), ?,?,?,?,?,?,?)
       ON CONFLICT(printer_id) DO UPDATE SET
         reported_at=excluded.reported_at, device_state=excluded.device_state,
         loaded_roll_in=excluded.loaded_roll_in,
         paper_remaining_ft=excluded.paper_remaining_ft,
         ink_levels_json=excluded.ink_levels_json, queued_jobs=excluded.queued_jobs,
         active_job_label=excluded.active_job_label, message=excluded.message`,
      printer.id, dev.state || null, dev.loadedRollIn ?? null,
      dev.paperRemainingFt ?? null,
      dev.inkLevels ? JSON.stringify(dev.inkLevels) : null,
      dev.queuedJobs ?? 0, dev.activeJob || null, dev.message || null);

    events.toPrinter(printer.code, 'printer:status', {
      printer: printer.code, ...dev,
    });
    checkSupplyThresholds(printer, dev);
  }
  return { applied: results.length };
}

/** Nudge the operators before the ink actually runs out. */
function checkSupplyThresholds(printer, dev) {
  if (!config.features.supplies || !dev.inkLevels) return;
  const low = Object.entries(dev.inkLevels).filter(([, pct]) => pct <= 15);
  if (!low.length) return;
  const key = `ink-low:${printer.code}:${low.map(([c]) => c).join(',')}:${new Date().toISOString().slice(0, 10)}`;
  require('./outbox').enqueue({
    event: 'supplies.low', url: config.flow.notifyUrl, idempotencyKey: key,
    payload: {
      printer: printer.display_name, printerCode: printer.code,
      low: low.map(([code, pct]) => ({ code, percent: pct })),
      onHand: q.all(
        `SELECT sku, ink_code, on_hand, reorder_at FROM supplies
          WHERE kind = 'ink' AND ink_code IN (${low.map(() => '?').join(',')})`,
        ...low.map(([c]) => c)),
    },
  });
}

/** Anything we sent but never heard about again gets chased or abandoned. */
function reconcile() {
  const stale = q.all(
    `SELECT d.*, j.public_id FROM print_dispatches d JOIN jobs j ON j.id = d.job_id
      WHERE d.status IN ('sending','spooling','queued','printing')
        AND COALESCE(d.last_polled_at, d.submitted_at) < datetime('now','-15 minutes')`);
  for (const d of stale) {
    q.run("UPDATE print_dispatches SET status='abandoned', error=? WHERE id=?",
      'no status from the print agent for 15 minutes', d.id);
    try {
      setStatus(d.job_id, 'failed', {
        message: 'Lost contact with the print host while this job was in the queue',
      });
    } catch { /* already terminal */ }
    events.toAdmin('dispatch:abandoned', { jobId: d.public_id, dispatchId: d.id });
  }
  // Mark hosts offline if they stop checking in.
  q.run(
    `UPDATE print_hosts SET status = 'offline'
      WHERE is_active = 1 AND (last_seen_at IS NULL
        OR last_seen_at < datetime('now','-3 minutes')) AND status != 'offline'`);
  return stale.length;
}

function start() {
  timer = setInterval(reconcile, 60000);
  timer.unref?.();
}
function stop() { if (timer) clearInterval(timer); }

module.exports = {
  dispatchJob, applyAgentReport, verifyPullSignature, signedPullUrl,
  reconcile, start, stop,
};
