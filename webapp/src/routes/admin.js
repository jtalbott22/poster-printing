'use strict';
/**
 * Operations console API. Everything Power Automate can do, a human can do
 * here — that is the point. If Flow is down, SharePoint is down, or Teams is
 * having a day, printing still works from this screen.
 */
const express = require('express');
const config = require('../config');
const { q, logEvent, setStatus } = require('../db');
const storage = require('../storage');
const dispatch = require('../dispatch');
const pipeline = require('../pipeline');
const outbox = require('../outbox');
const render = require('../render');
const security = require('../security');
const events = require('../events');
const { requireRole } = require('../auth');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// Queue overview
// ---------------------------------------------------------------------------
router.get('/jobs', requireRole('approver'), (req, res) => {
  const status = req.query.status;
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
  const rows = status
    ? q.all(`SELECT * FROM v_job_overview WHERE status = ? ORDER BY id DESC LIMIT ?`, status, limit)
    : q.all(`SELECT * FROM v_job_overview ORDER BY id DESC LIMIT ?`, limit);
  res.json({
    jobs: rows.map((j) => ({
      ...j,
      thumbUrl: `${config.basePath}/api/jobs/${j.public_id}/file/thumb`,
      previewUrl: `/api/jobs/${j.public_id}/file/preview`,
    })),
    counts: Object.fromEntries(
      q.all('SELECT status, COUNT(*) n FROM jobs GROUP BY status').map((r) => [r.status, r.n])),
  });
});

router.get('/jobs/:publicId', requireRole('approver'), (req, res) => {
  const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  res.json({
    job: q.one('SELECT * FROM v_job_overview WHERE id = ?', job.id),
    preflight: job.preflight_json ? JSON.parse(job.preflight_json) : null,
    files: q.all('SELECT role, width_px, height_px, byte_size, mime, original_name, is_purged FROM job_files WHERE job_id = ?', job.id),
    events: q.all('SELECT at, actor, kind, from_status, to_status, message FROM job_events WHERE job_id = ? ORDER BY id', job.id),
    dispatches: q.all('SELECT * FROM print_dispatches WHERE job_id = ? ORDER BY id', job.id),
    cost: q.one('SELECT * FROM job_costs WHERE job_id = ?', job.id) || null,
  });
});

// ---------------------------------------------------------------------------
// Decide in the portal — the fallback path when Teams isn't available
// ---------------------------------------------------------------------------
router.post('/jobs/:publicId/decide', requireRole('approver'), async (req, res) => {
  const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  const decision = String(req.body.decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'bad_decision' });
  }
  if (!['pending_approval', 'expired', 'submitted'].includes(job.status)) {
    return res.status(409).json({ error: 'already_decided', status: job.status });
  }
  const comments = String(req.body.comments || '').slice(0, 2000) || null;

  q.run(
    `UPDATE approvals SET decided_at = datetime('now'), decision = ?, decided_by = ?,
        decided_via = 'portal', comments = ? WHERE job_id = ? AND is_current = 1`,
    decision, req.user.email, comments, job.id);
  setStatus(job.id, decision, { actor: req.user.email, message: comments });

  const fresh = q.one('SELECT * FROM jobs WHERE id = ?', job.id);
  events.toJob(fresh, 'job:status', { status: decision, decidedBy: req.user.email, comments });
  outbox.notify(fresh, decision === 'approved' ? 'job.approved' : 'job.rejected', {
    jobId: fresh.public_id, title: fresh.title, decidedBy: req.user.email, comments,
    requester: q.one('SELECT email, display_name FROM users WHERE id = ?', fresh.user_id),
  });

  if (decision === 'approved') {
    try {
      const r = await dispatch.dispatchJob(fresh.id, { actor: req.user.email });
      return res.json({ ok: true, status: 'queued', docToken: r.docToken });
    } catch (e) {
      if (e.code === 'RASTER_NOT_READY') {
        return res.json({ ok: true, status: 'approved', detail: 'awaiting_render' });
      }
      return res.status(502).json({ error: 'dispatch_failed', message: e.message });
    }
  }
  res.json({ ok: true, status: decision });
});

// Re-send a job that failed, or print one straight from the console.
router.post('/jobs/:publicId/print', requireRole('operator'), async (req, res) => {
  const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  if (req.body.printerCode) {
    const p = q.one('SELECT * FROM printers WHERE code = ? AND is_active = 1', req.body.printerCode);
    if (!p) return res.status(400).json({ error: 'unknown_printer' });
    q.run('UPDATE jobs SET printer_id = ?, location_id = ? WHERE id = ?', p.id, p.location_id, job.id);
  }
  if (['failed', 'cancelled'].includes(job.status)) {
    try { setStatus(job.id, 'queued', { actor: req.user.email, message: 'manual re-send' }); }
    catch { /* fall through, dispatchJob sets it too */ }
  }
  if (!storage.getJobFile(job.id, 'print')) {
    pipeline.enqueue(job.id, 'print');
    return res.status(202).json({ ok: true, detail: 'rendering — will need a second click' });
  }
  try {
    const r = await dispatch.dispatchJob(job.id, { actor: req.user.email });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(502).json({ error: 'dispatch_failed', message: e.message }); }
});

router.post('/jobs/:publicId/rerender', requireRole('operator'), (req, res) => {
  const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  const kind = req.body.kind === 'print' ? 'print' : 'preview';
  q.run('UPDATE render_tasks SET attempts = 0 WHERE job_id = ? AND kind = ?', job.id, kind);
  pipeline.enqueue(job.id, kind);
  logEvent({ jobId: job.id, actor: req.user.email, kind: 'note', message: `re-render ${kind}` });
  res.json({ ok: true, kind });
});

router.post('/jobs/:publicId/status', requireRole('operator'), (req, res) => {
  const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  try {
    const to = setStatus(job.id, String(req.body.status), {
      actor: req.user.email, message: String(req.body.message || '').slice(0, 500) || null,
    });
    events.toJob(job, 'job:status', { status: to });
    res.json({ ok: true, status: to });
  } catch (e) {
    res.status(400).json({ error: e.code || 'bad_transition', message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Printers, hosts, locations
// ---------------------------------------------------------------------------
router.get('/printers', requireRole('operator'), (_req, res) => {
  res.json({
    printers: q.all(
      `SELECT p.*, l.display_name AS location_name, h.code AS host_code, h.status AS host_status,
              h.last_seen_at AS host_last_seen, ps.device_state, ps.ink_levels_json,
              ps.loaded_roll_in, ps.paper_remaining_ft, ps.queued_jobs, ps.reported_at
         FROM printers p
         JOIN locations l ON l.id = p.location_id
         JOIN print_hosts h ON h.id = p.print_host_id
         LEFT JOIN printer_status ps ON ps.printer_id = p.id
        ORDER BY p.sort_order`),
    queue: q.all('SELECT * FROM v_printer_queue ORDER BY printer_id, place_in_line'),
    hosts: q.all('SELECT id, code, display_name, base_url, status, last_seen_at, agent_version, is_active FROM print_hosts'),
  });
});

router.post('/printers', requireRole('admin'), (req, res) => {
  const b = req.body;
  const host = q.one('SELECT id FROM print_hosts WHERE code = ?', b.hostCode);
  const loc = q.one('SELECT id FROM locations WHERE code = ?', b.locationCode);
  if (!host || !loc) return res.status(400).json({ error: 'unknown_host_or_location' });
  const rollWidth = Number(b.rollWidthIn);
  q.run(
    `INSERT INTO printers (code, display_name, print_host_id, location_id,
        windows_printer_name, roll_width_in, printable_width_in, max_length_in,
        driver_preset, target_dpi, cost_per_sq_ft_cents, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       display_name=excluded.display_name, print_host_id=excluded.print_host_id,
       location_id=excluded.location_id, windows_printer_name=excluded.windows_printer_name,
       roll_width_in=excluded.roll_width_in, printable_width_in=excluded.printable_width_in,
       max_length_in=excluded.max_length_in, driver_preset=excluded.driver_preset,
       target_dpi=excluded.target_dpi, cost_per_sq_ft_cents=excluded.cost_per_sq_ft_cents,
       sort_order=excluded.sort_order`,
    b.code, b.displayName, host.id, loc.id, b.windowsPrinterName, rollWidth,
    Number(b.printableWidthIn) || rollWidth - 2 * config.print.edgeMarginIn,
    Number(b.maxLengthIn) || config.print.maxLengthIn,
    b.driverPreset || null, Number(b.targetDpi) || config.print.targetDpi,
    Number(b.costPerSqFtCents) || 0, Number(b.sortOrder) || 100);
  res.json({ ok: true, printer: q.one('SELECT * FROM printers WHERE code = ?', b.code) });
});

router.post('/hosts', requireRole('admin'), (req, res) => {
  const b = req.body;
  const apiKey = security.randomToken(24);
  const hmac = security.randomToken(32);
  q.run(
    `INSERT INTO print_hosts (code, display_name, base_url, api_key_hash, hmac_secret)
     VALUES (?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,
       base_url=excluded.base_url`,
    b.code, b.displayName || b.code, b.baseUrl,
    security.sha256hex(apiKey), hmac);
  const host = q.one('SELECT * FROM print_hosts WHERE code = ?', b.code);
  // The HMAC secret is shown once here so it can go into the agent's .env.
  res.json({
    ok: true, host: { code: host.code, base_url: host.base_url },
    secrets: { hmacSecret: host.hmac_secret, note: 'Copy into the agent .env as PP_HMAC_SECRET' },
  });
});

router.post('/locations', requireRole('admin'), (req, res) => {
  const b = req.body;
  q.run(
    `INSERT INTO locations (code, display_name, building, room, pickup_hours, map_url, contact_email)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,
       building=excluded.building, room=excluded.room, pickup_hours=excluded.pickup_hours,
       map_url=excluded.map_url, contact_email=excluded.contact_email`,
    b.code, b.displayName, b.building || null, b.room || null,
    b.pickupHours || null, b.mapUrl || null, b.contactEmail || null);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Supplies
// ---------------------------------------------------------------------------
router.get('/supplies', requireRole('operator'), (_req, res) => {
  res.json({
    supplies: q.all('SELECT * FROM supplies ORDER BY kind, sku'),
    low: q.all('SELECT * FROM supplies WHERE on_hand <= reorder_at ORDER BY kind, sku'),
    recent: q.all(
      `SELECT t.*, s.sku FROM supply_txns t JOIN supplies s ON s.id = t.supply_id
        ORDER BY t.id DESC LIMIT 50`),
  });
});

router.post('/supplies/:sku/adjust', requireRole('operator'), (req, res) => {
  const supply = q.one('SELECT * FROM supplies WHERE sku = ?', req.params.sku);
  if (!supply) return res.status(404).json({ error: 'not_found' });
  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'bad_delta' });
  const tx = q.tx(() => {
    q.run("UPDATE supplies SET on_hand = on_hand + ?, updated_at = datetime('now') WHERE id = ?",
      delta, supply.id);
    q.run('INSERT INTO supply_txns (supply_id, delta, reason, actor, note) VALUES (?,?,?,?,?)',
      supply.id, delta, String(req.body.reason || 'restock'), req.user.email,
      String(req.body.note || '').slice(0, 300) || null);
  });
  tx();
  res.json({ ok: true, supply: q.one('SELECT * FROM supplies WHERE id = ?', supply.id) });
});

// ---------------------------------------------------------------------------
// Cost import from Canon Accounting Manager
// ---------------------------------------------------------------------------
router.post('/costs/import', requireRole('operator'), (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  let matched = 0;
  const tx = q.tx(() => {
    for (const r of rows) {
      // Canon AM records the spooler document name, which is our doc_token.
      const d = q.one('SELECT * FROM print_dispatches WHERE doc_token = ?', r.documentName);
      if (!d) continue;
      const printer = q.one('SELECT * FROM printers WHERE id = ?', d.printer_id);
      const job = q.one('SELECT * FROM jobs WHERE id = ?', d.job_id);
      const areaSqFt = (job.finished_width_in * job.finished_height_in) / 144;
      const inkTotal = r.inkMl
        ? Object.values(r.inkMl).reduce((a, b) => a + Number(b || 0), 0) : null;
      q.run(
        `INSERT INTO job_costs (job_id, source, ink_ml_json, ink_total_ml, paper_length_in,
            paper_area_sqft, ink_cost_cents, paper_cost_cents, total_cost_cents)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(job_id) DO UPDATE SET
           ink_ml_json=excluded.ink_ml_json, ink_total_ml=excluded.ink_total_ml,
           paper_length_in=excluded.paper_length_in, paper_area_sqft=excluded.paper_area_sqft,
           ink_cost_cents=excluded.ink_cost_cents, paper_cost_cents=excluded.paper_cost_cents,
           total_cost_cents=excluded.total_cost_cents, imported_at=datetime('now')`,
        d.job_id, 'canon_am', r.inkMl ? JSON.stringify(r.inkMl) : null, inkTotal,
        r.paperLengthIn ?? job.print_length_in, areaSqFt,
        r.inkCostCents ?? null,
        r.paperCostCents ?? Math.round(areaSqFt * printer.cost_per_sq_ft_cents),
        (r.inkCostCents ?? 0) + (r.paperCostCents ?? Math.round(areaSqFt * printer.cost_per_sq_ft_cents)));
      matched += 1;
    }
  });
  tx();
  res.json({ ok: true, rows: rows.length, matched });
});

// ---------------------------------------------------------------------------
// Health / maintenance
// ---------------------------------------------------------------------------
router.get('/health', requireRole('operator'), async (_req, res) => {
  const dbFileMb = (() => {
    try { return +(require('fs').statSync(config.paths.db).size / 1048576).toFixed(1); }
    catch { return null; }
  })();
  res.json({
    db: { path: config.paths.db, sizeMb: dbFileMb },
    counts: Object.fromEntries(
      q.all('SELECT status, COUNT(*) n FROM jobs GROUP BY status').map((r) => [r.status, r.n])),
    renderQueue: q.all('SELECT status, kind, COUNT(*) n FROM render_tasks GROUP BY status, kind'),
    outbox: {
      pending: q.one('SELECT COUNT(*) n FROM webhook_outbox WHERE delivered_at IS NULL').n,
      deadLettered: q.one(
        'SELECT COUNT(*) n FROM webhook_outbox WHERE delivered_at IS NULL AND attempts >= ?',
        config.flow.outboxMaxAttempts).n,
    },
    hosts: q.all('SELECT code, status, last_seen_at, agent_version FROM print_hosts'),
    storage: q.one(
      `SELECT COUNT(*) blobs, COALESCE(SUM(byte_size),0) bytes,
              SUM(CASE WHEN refcount = 0 THEN 1 ELSE 0 END) orphans FROM blobs`),
    toolchain: await render.checkToolchain(),
  });
});

router.post('/maintenance/purge', requireRole('admin'), async (req, res) => {
  const result = await storage.purgeExpired({ dryRun: !!req.body.dryRun });
  logEvent({ jobId: null, actor: req.user.email, kind: 'maintenance',
    message: `purge: ${JSON.stringify(result)}` });
  res.json(result);
});

router.post('/maintenance/fsck', requireRole('admin'), async (req, res) => {
  res.json(await storage.fsck({ limit: Math.min(5000, Number(req.body.limit) || 500) }));
});

// Run the deadline sweep on demand. It runs on a timer anyway, but when
// somebody is standing at the console asking why a job is still pending,
// waiting out the interval is not an answer.
router.post('/maintenance/sweep', requireRole('operator'), (req, res) => {
  const expired = outbox.sweepDeadlines();
  logEvent({ jobId: null, actor: req.user.email, kind: 'maintenance',
    message: `manual deadline sweep — ${expired} job(s) expired` });
  res.json({ expired });
});

router.post('/maintenance/outbox/retry', requireRole('admin'), (req, res) => {
  const n = q.run(
    `UPDATE webhook_outbox SET attempts = 0, next_attempt_at = datetime('now')
      WHERE delivered_at IS NULL`).changes;
  outbox.sweep();
  res.json({ ok: true, requeued: n });
});

router.get('/settings', requireRole('admin'), (_req, res) => {
  res.json({ settings: q.all('SELECT * FROM settings ORDER BY key') });
});
router.post('/settings', requireRole('admin'), (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) {
    q.run(`INSERT INTO settings (key, value) VALUES (?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
      k, String(v));
  }
  res.json({ ok: true, settings: q.all('SELECT * FROM settings ORDER BY key') });
});

router.get('/users', requireRole('admin'), (_req, res) => {
  res.json({ users: q.all(
    'SELECT id, email, display_name, role, is_active, last_login_at FROM users ORDER BY email') });
});
router.post('/users/:email/role', requireRole('admin'), (req, res) => {
  const role = String(req.body.role);
  if (!['requester', 'approver', 'operator', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'bad_role' });
  }
  q.run('UPDATE users SET role = ? WHERE email = ?', role, String(req.params.email).toLowerCase());
  res.json({ ok: true });
});

module.exports = router;
