'use strict';
/**
 * Windows print host <-> portal.
 *
 * Both ends are Node, so this side uses HMAC over the raw body with a
 * per-host secret, plus a 5-minute replay window. The raster download uses a
 * separate expiring signature so the URL can be handed around inside the
 * envelope without also handing over the host's API key.
 */
const express = require('express');
const { q, logEvent } = require('../db');
const storage = require('../storage');
const security = require('../security');
const dispatchLib = require('../dispatch');
const events = require('../events');

const router = express.Router();

// Raw body capture — HMAC has to cover the exact bytes, not a re-serialised object.
const rawJson = express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
});

function hostFromHeader(req) {
  const code = req.get('x-pp-host');
  if (!code) return null;
  return q.one('SELECT * FROM print_hosts WHERE code = ? AND is_active = 1', code);
}

const requireHost = (req, res, next) => {
  const host = hostFromHeader(req);
  if (!host) return res.status(401).json({ error: 'unknown_host' });
  const ok = security.verifyBody(
    host.hmac_secret, req.rawBody || Buffer.alloc(0),
    req.get('x-pp-timestamp'), req.get('x-pp-signature'));
  if (!ok) return res.status(401).json({ error: 'bad_signature' });
  req.printHost = host;
  next();
};

// ---------------------------------------------------------------------------
// GET /api/agent/pull/:publicId?exp=&sig=  — stream the print raster
// ---------------------------------------------------------------------------
router.get('/pull/:publicId', (req, res) => {
  const host = hostFromHeader(req);
  if (!host) return res.status(401).json({ error: 'unknown_host' });
  const ok = dispatchLib.verifyPullSignature(
    req.params.publicId, req.query.exp, req.query.sig, host);
  if (!ok) return res.status(403).json({ error: 'bad_or_expired_signature' });

  const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  const file = storage.getJobFile(job.id, 'print');
  if (!file) return res.status(409).json({ error: 'raster_not_ready' });

  // Range-capable, so a 300 MB pull survives a dropped link.
  storage.sendFile(res, file, { inline: false, maxAgeSec: 0 });
});

// ---------------------------------------------------------------------------
// POST /api/agent/status — spooler + device report, every few seconds
// ---------------------------------------------------------------------------
router.post('/status', rawJson, requireHost, (req, res) => {
  try {
    const result = dispatchLib.applyAgentReport(req.printHost.code, req.body || {});
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[agent] status', e);
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/agent/hello — heartbeat + capability advertisement on agent start
// ---------------------------------------------------------------------------
router.post('/hello', rawJson, requireHost, (req, res) => {
  const b = req.body || {};
  q.run(
    `UPDATE print_hosts SET last_seen_at = datetime('now'), status='online',
        agent_version = ? WHERE id = ?`,
    String(b.agentVersion || '').slice(0, 40) || null, req.printHost.id);

  // Report back which of the host's Windows printers we actually have
  // configured, so the agent can log a clear warning about the rest.
  const known = q.all(
    'SELECT code, windows_printer_name, roll_width_in FROM printers WHERE print_host_id = ? AND is_active = 1',
    req.printHost.id);
  const advertised = new Set((b.printers || []).map((p) => p.name));
  const missing = known.filter((k) => !advertised.has(k.windows_printer_name));

  events.toAdmin('host:online', {
    host: req.printHost.code, version: b.agentVersion,
    printers: b.printers?.length || 0, missing: missing.map((m) => m.windows_printer_name),
  });

  res.json({
    ok: true,
    expectedPrinters: known,
    missingOnHost: missing.map((m) => m.windows_printer_name),
    statusIntervalMs: 4000,
    reapAfterDays: require('../config').retention.spoolerRecordDays,
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/event — free-form log line from the agent (errors, reaps)
// ---------------------------------------------------------------------------
router.post('/event', rawJson, requireHost, (req, res) => {
  const b = req.body || {};
  const job = b.docToken
    ? q.one(`SELECT j.* FROM jobs j JOIN print_dispatches d ON d.job_id = j.id
              WHERE d.doc_token = ?`, b.docToken)
    : null;
  if (job) {
    logEvent({
      jobId: job.id, actor: `agent:${req.printHost.code}`,
      kind: b.level === 'error' ? 'error' : 'note',
      message: String(b.message || '').slice(0, 1000),
      data: b.data || null,
    });
    events.toJob(job, 'job:agent_note', { level: b.level, message: b.message });
  } else {
    events.toAdmin('agent:log', { host: req.printHost.code, ...b });
  }
  res.json({ ok: true });
});

module.exports = router;
