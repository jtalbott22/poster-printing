'use strict';
const path = require('path');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { q, logEvent, setStatus } = require('../db');
const storage = require('../storage');
const preflightLib = require('../preflight');
const pipeline = require('../pipeline');
const outbox = require('../outbox');
const security = require('../security');
const events = require('../events');
const { requireUser } = require('../auth');

const router = express.Router();

// --- upload handling ---------------------------------------------------
// Land on disk in the same filesystem as the blob store so the move is a
// rename, not a copy. Never buffer a 250 MB poster in memory.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.paths.incoming),
    filename: (_req, file, cb) =>
      cb(null, `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` +
        path.extname(file.originalname).toLowerCase().slice(0, 8)),
  }),
  limits: { fileSize: config.print.maxUploadBytes, files: 1, fields: 20 },
  fileFilter: (_req, file, cb) => {
    const { kind } = preflightLib.classify(file.mimetype, file.originalname);
    if (!kind) return cb(Object.assign(new Error('unsupported_type'), { code: 'UNSUPPORTED' }));
    if (kind === 'html' && !config.features.htmlUploads) {
      return cb(Object.assign(new Error('html_disabled'), { code: 'UNSUPPORTED' }));
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
function nextPublicId() {
  const year = new Date().getFullYear();
  for (let i = 0; i < 5; i++) {
    const last = q.one(
      `SELECT public_id FROM jobs WHERE public_id LIKE ? ORDER BY id DESC LIMIT 1`,
      `PP-${year}-%`);
    const n = last ? parseInt(last.public_id.split('-')[2], 10) + 1 : 1;
    const candidate = `PP-${year}-${String(n).padStart(4, '0')}`;
    if (!q.one('SELECT 1 FROM jobs WHERE public_id = ?', candidate)) return candidate;
  }
  return `PP-${year}-${Date.now().toString(36).toUpperCase()}`;
}

function ownedJob(req, res) {
  const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
  if (!job) { res.status(404).json({ error: 'not_found' }); return null; }
  const staff = ['approver', 'operator', 'admin'].includes(req.user.role);
  if (job.user_id !== req.user.id && !staff) {
    res.status(404).json({ error: 'not_found' });               // don't confirm existence
    return null;
  }
  return job;
}

function shapeJob(job, { includeReport = true } = {}) {
  const report = job.preflight_json ? JSON.parse(job.preflight_json) : null;
  const files = q.all(
    'SELECT role, width_px, height_px, byte_size, mime, original_name, is_purged FROM job_files WHERE job_id = ?',
    job.id);
  const approval = q.one(
    'SELECT decision, decided_by, decided_at, comments FROM approvals WHERE job_id = ? AND is_current = 1',
    job.id);
  const dispatch = q.one(
    'SELECT status, host_job_id, position_in_queue, submitted_at, error FROM print_dispatches WHERE job_id = ? ORDER BY id DESC LIMIT 1',
    job.id);
  return {
    id: job.public_id,
    title: job.title,
    status: job.status,
    createdAt: job.created_at,
    submittedAt: job.submitted_at,
    printedAt: job.printed_at,
    copies: job.copies,
    department: job.department,
    advisor: job.advisor,
    billingIndex: job.billing_index,
    notes: job.notes,
    neededBy: job.needed_by,
    rollWidthIn: job.roll_width_in,
    fitMode: job.fit_mode,
    orientation: job.orientation,
    finishedWidthIn: job.finished_width_in,
    finishedHeightIn: job.finished_height_in,
    printLengthIn: job.print_length_in,
    effectiveDpi: job.effective_dpi,
    preflightSeverity: job.preflight_severity,
    printer: job.printer_id
      ? q.one('SELECT code, display_name FROM printers WHERE id = ?', job.printer_id) : null,
    location: job.location_id
      ? q.one('SELECT code, display_name, building, room, pickup_hours, map_url FROM locations WHERE id = ?', job.location_id) : null,
    files: Object.fromEntries(files.map((f) => [f.role, {
      width: f.width_px, height: f.height_px, bytes: f.byte_size,
      name: f.original_name, purged: !!f.is_purged,
      url: `${config.basePath}/api/jobs/${job.public_id}/file/${f.role}`,
    }])),
    approval: approval || null,
    spooler: dispatch || null,
    preflight: includeReport ? report : undefined,
  };
}

// ---------------------------------------------------------------------------
// Options for the form
// ---------------------------------------------------------------------------
router.get('/options', requireUser, (req, res) => {
  const printers = q.all(
    `SELECT p.code, p.display_name, p.roll_width_in, p.printable_width_in,
            p.max_length_in, p.target_dpi, l.code AS location_code,
            l.display_name AS location_name, l.building, l.room, l.pickup_hours,
            COALESCE(ps.device_state,'unknown') AS device_state,
            COALESCE(ps.queued_jobs,0) AS queued_jobs
       FROM printers p
       JOIN locations l ON l.id = p.location_id
       LEFT JOIN printer_status ps ON ps.printer_id = p.id
      WHERE p.is_active = 1 AND l.is_active = 1
      ORDER BY p.sort_order, p.display_name`);
  res.json({
    user: {
      email: req.user.email, name: req.user.display_name,
      role: req.user.role, picture: req.user.picture_url,
    },
    printers,
    rollWidths: [...new Set(printers.map((p) => p.roll_width_in))].sort((a, b) => a - b),
    limits: {
      minDpi: config.print.minDpi, warnDpi: config.print.warnDpi,
      targetDpi: config.print.targetDpi,
      maxUploadMb: Math.round(config.print.maxUploadBytes / 1048576),
      maxLengthIn: config.print.maxLengthIn,
      accepts: Object.keys(preflightLib.EXT_MIME),
    },
    acceptingJobs: q.one("SELECT value FROM settings WHERE key='portal.accepting_jobs'")?.value !== 'false',
    banner: q.one("SELECT value FROM settings WHERE key='portal.banner'")?.value || '',
  });
});

// ---------------------------------------------------------------------------
// Create a draft as soon as the user picks a roll width
// ---------------------------------------------------------------------------
router.post('/', requireUser, (req, res) => {
  if (q.one("SELECT value FROM settings WHERE key='portal.accepting_jobs'")?.value === 'false') {
    return res.status(503).json({ error: 'submissions_paused' });
  }
  const rollWidthIn = Number(req.body.rollWidthIn) || config.print.rollWidths[0];
  if (!config.print.rollWidths.includes(rollWidthIn)) {
    return res.status(400).json({ error: 'bad_roll_width', allowed: config.print.rollWidths });
  }
  const publicId = nextPublicId();
  const info = q.run(
    `INSERT INTO jobs (public_id, user_id, title, roll_width_in, status)
     VALUES (?,?,?,?, 'draft')`,
    publicId, req.user.id, String(req.body.title || 'Untitled poster').slice(0, 200), rollWidthIn);
  logEvent({ jobId: info.lastInsertRowid, actor: req.user.email, kind: 'created' });
  res.status(201).json({ id: publicId });
});

// ---------------------------------------------------------------------------
// Upload the artwork -> preflight -> kick off the preview render
// ---------------------------------------------------------------------------
router.post('/:publicId/file', requireUser, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `That file is over the ${Math.round(config.print.maxUploadBytes / 1048576)} MB limit.`
        : err.code === 'UNSUPPORTED'
          ? 'That file type can\'t be printed. Upload a PDF, PowerPoint, PNG, JPEG or HTML file.'
          : 'The upload didn\'t finish. Try again.';
      return res.status(400).json({ error: err.code || 'upload_failed', message: msg });
    }
    const job = ownedJob(req, res);
    if (!job) { if (req.file) await fsp.unlink(req.file.path).catch(() => {}); return; }
    if (!['draft', 'uploaded', 'preflight_failed', 'ready', 'rejected'].includes(job.status)) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(409).json({ error: 'job_locked', status: job.status });
    }
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    try {
      const printer = job.printer_id
        ? q.one('SELECT * FROM printers WHERE id = ?', job.printer_id) : null;

      const report = await preflightLib.preflight(req.file.path, {
        mime: req.file.mimetype,
        filename: req.file.originalname,
        rollWidthIn: job.roll_width_in,
        fitMode: job.fit_mode,
        printer,
        byteSize: req.file.size,
      });

      const blob = await storage.ingestFile(req.file.path, {
        mime: preflightLib.classify(req.file.mimetype, req.file.originalname).mime,
        byteSize: req.file.size,
      });
      storage.recordJobFile(job.id, {
        role: 'original', sha256: blob.sha256, relPath: blob.rel_path,
        originalName: req.file.originalname.slice(0, 255), mime: blob.mime,
        byteSize: blob.byte_size,
        widthPx: report.source?.widthPx ?? null,
        heightPx: report.source?.heightPx ?? null,
        densityDpi: report.source?.declaredDpi ?? null,
        pageCount: report.source?.pages ?? null,
      });

      applyReport(job, report, req.user.email);
      const fresh = q.one('SELECT * FROM jobs WHERE id = ?', job.id);

      // Previews of PPTX/PDF need the server. Start now so it's usually
      // waiting by the time they finish typing the form.
      pipeline.enqueue(job.id, 'preview');

      res.json({
        job: shapeJob(fresh),
        preflight: report,
        previewPending: true,
        deduped: blob.deduped,
      });
    } catch (e) {
      await fsp.unlink(req.file.path).catch(() => {});
      console.error('[jobs] upload', e);
      res.status(500).json({ error: 'preflight_failed', message: e.message });
    }
  });
});

function applyReport(job, report, actor) {
  const L = report.layout || {};
  const R = report.raster || {};
  q.run(
    `UPDATE jobs SET preflight_json = ?, preflight_severity = ?, orientation = ?,
        finished_width_in = ?, finished_height_in = ?, print_length_in = ?,
        effective_dpi = ? WHERE id = ?`,
    JSON.stringify(report), report.severity, L.orientation || null,
    L.finishedWidthIn ?? null, L.finishedHeightIn ?? null, L.printLengthIn ?? null,
    R.effectiveDpi ?? null, job.id);

  const target = report.severity === 'fail' ? 'preflight_failed' : 'ready';
  try {
    if (job.status === 'draft') setStatus(job.id, 'uploaded', { actor });
    setStatus(job.id, target, {
      actor,
      message: report.issues.length
        ? report.issues.map((i) => `${i.severity}: ${i.code}`).join(', ') : 'clean',
      data: { severity: report.severity },
    });
  } catch (e) { console.warn('[jobs] status', e.message); }
}

// ---------------------------------------------------------------------------
// Edit the form. Geometry changes re-run preflight against the stored original.
// ---------------------------------------------------------------------------
router.patch('/:publicId', requireUser, async (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  if (!['draft', 'uploaded', 'preflight_failed', 'ready', 'rejected'].includes(job.status)) {
    return res.status(409).json({ error: 'job_locked', status: job.status });
  }

  const b = req.body || {};
  const sets = [];
  const vals = [];
  const text = (k, col, max = 500) => {
    if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(String(b[k]).slice(0, max) || null); }
  };
  text('title', 'title', 200);
  text('department', 'department', 120);
  text('advisor', 'advisor', 120);
  text('billingIndex', 'billing_index', 40);
  text('notes', 'notes', 2000);
  text('neededBy', 'needed_by', 40);
  text('overrideReason', 'override_reason', 500);

  if (b.copies !== undefined) {
    const c = Math.max(1, Math.min(20, parseInt(b.copies, 10) || 1));
    sets.push('copies = ?'); vals.push(c);
  }

  let geometryChanged = false;
  if (b.rollWidthIn !== undefined) {
    const w = Number(b.rollWidthIn);
    if (!config.print.rollWidths.includes(w)) {
      return res.status(400).json({ error: 'bad_roll_width' });
    }
    sets.push('roll_width_in = ?'); vals.push(w); geometryChanged = true;
  }
  if (b.fitMode !== undefined) {
    if (!['fit_roll', 'actual_size'].includes(b.fitMode)) {
      return res.status(400).json({ error: 'bad_fit_mode' });
    }
    sets.push('fit_mode = ?'); vals.push(b.fitMode); geometryChanged = true;
  }
  if (b.printerCode !== undefined) {
    const p = q.one('SELECT * FROM printers WHERE code = ? AND is_active = 1', b.printerCode);
    if (!p) return res.status(400).json({ error: 'unknown_printer' });
    sets.push('printer_id = ?', 'location_id = ?', 'roll_width_in = ?');
    vals.push(p.id, p.location_id, p.roll_width_in);
    geometryChanged = true;
  }

  if (sets.length) {
    vals.push(job.id);
    q.run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  }

  let report = job.preflight_json ? JSON.parse(job.preflight_json) : null;
  const original = storage.getJobFile(job.id, 'original');
  if (geometryChanged && original) {
    const fresh = q.one('SELECT * FROM jobs WHERE id = ?', job.id);
    const printer = fresh.printer_id
      ? q.one('SELECT * FROM printers WHERE id = ?', fresh.printer_id) : null;
    report = await preflightLib.preflight(storage.absFor(original), {
      mime: original.mime, filename: original.original_name,
      rollWidthIn: fresh.roll_width_in, fitMode: fresh.fit_mode,
      printer, byteSize: original.byte_size,
    });
    applyReport(fresh, report, req.user.email);
    pipeline.enqueue(job.id, 'preview');       // aspect may have changed
  }

  res.json({ job: shapeJob(q.one('SELECT * FROM jobs WHERE id = ?', job.id)), preflight: report });
});

// ---------------------------------------------------------------------------
// Submit for approval
// ---------------------------------------------------------------------------
router.post('/:publicId/submit', requireUser, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  if (!['ready', 'rejected'].includes(job.status)) {
    return res.status(409).json({
      error: 'not_ready', status: job.status,
      message: job.status === 'preflight_failed'
        ? 'Fix the problems listed above, then upload the file again.'
        : 'This job has already been submitted.',
    });
  }
  const missing = ['title', 'printer_id'].filter((f) => !job[f]);
  if (missing.length) {
    return res.status(400).json({ error: 'missing_fields', fields: missing });
  }
  if (job.preflight_severity === 'warn' && !job.override_reason && !req.body.acknowledge) {
    return res.status(400).json({
      error: 'acknowledge_required',
      message: 'Confirm you\'ve read the quality warning before submitting.',
    });
  }

  const printer = q.one('SELECT * FROM printers WHERE id = ?', job.printer_id);
  const { token, hash } = security.issueCallbackToken();

  const tx = q.tx(() => {
    q.run('UPDATE approvals SET is_current = 0 WHERE job_id = ?', job.id);
    q.run(
      `INSERT INTO approvals (job_id, callback_token_hash, deadline_at, is_current)
       VALUES (?, ?, datetime('now', ?), 1)`,
      job.id, hash, `+${config.flow.approvalDeadlineHours} hours`);
    setStatus(job.id, 'submitted', { actor: req.user.email });
    setStatus(job.id, 'pending_approval', { actor: 'system' });
  });
  tx();

  // Start the full-resolution raster now, in parallel with the human approval.
  // By the time somebody clicks Approve in Teams the file is usually ready,
  // so printing starts instantly rather than after a two-minute render.
  pipeline.enqueue(job.id, 'print');

  const fresh = q.one('SELECT * FROM jobs WHERE id = ?', job.id);
  const report = JSON.parse(fresh.preflight_json);
  const pickup = q.one(
    'SELECT display_name, building, room, pickup_hours FROM locations WHERE id = ?',
    fresh.location_id) || {};
  const deadline = q.one(
    'SELECT deadline_at FROM approvals WHERE job_id = ? AND is_current = 1', fresh.id).deadline_at;

  // Deliberately FLAT. Power Automate surfaces top-level properties in the
  // dynamic-content picker; nested objects have to be dug out by hand with
  // triggerBody()?['a']?['b'] expressions, which is where flows acquire their
  // typos. Keep this in step with powerautomate/FLOW-SETUP.md — that schema
  // is the contract, and the flow breaks silently if these names drift.
  outbox.jobSubmitted(fresh, {
    jobId: fresh.public_id,
    title: fresh.title,
    requester: req.user.email,
    requesterName: req.user.display_name,
    department: fresh.department,
    billingIndex: fresh.billing_index,
    notes: fresh.notes,
    neededBy: fresh.needed_by,
    copies: fresh.copies,

    finishedSize: `${fresh.finished_width_in}" x ${fresh.finished_height_in}"`,
    finishedWidthIn: fresh.finished_width_in,
    finishedHeightIn: fresh.finished_height_in,
    rollWidthIn: fresh.roll_width_in,
    paperUsedIn: fresh.print_length_in,
    areaSqFt: report.layout.areaSqFt,
    orientation: fresh.orientation,

    effectiveDpi: fresh.effective_dpi,
    preflight: fresh.preflight_severity,
    preflightNotes: report.issues.map((i) => i.message).join(' '),
    estimatedCost: fresh.estimated_cost_cents != null
      ? `$${(fresh.estimated_cost_cents / 100).toFixed(2)}` : '',

    printer: printer.display_name,
    printerCode: printer.code,
    pickupLocation: [pickup.building, pickup.room].filter(Boolean).join(' '),
    pickupHours: pickup.pickup_hours || '',

    // Links only. No image bytes go into a Teams card or a SharePoint list.
    reviewUrl: `${config.publicUrl}/admin/job/${fresh.public_id}`,
    previewUrl: `${config.publicUrl}/api/jobs/${fresh.public_id}/file/preview`,
    thumbnailUrl: `${config.publicUrl}/api/jobs/${fresh.public_id}/file/thumb`,

    callbackUrl: `${config.publicUrl}/hooks/approval/${fresh.public_id}`,
    callbackToken: token,          // single use, dies with the deadline
    deadline,
  });

  events.toJob(fresh, 'job:status', { status: 'pending_approval' });
  res.json({ job: shapeJob(fresh) });
});

// ---------------------------------------------------------------------------
router.post('/:publicId/cancel', requireUser, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  if (['printed', 'picked_up', 'cancelled'].includes(job.status)) {
    return res.status(409).json({ error: 'too_late', status: job.status });
  }
  setStatus(job.id, 'cancelled', {
    actor: req.user.email, message: String(req.body?.reason || '').slice(0, 300) || null,
  });
  q.run("UPDATE print_dispatches SET status='deleted' WHERE job_id = ? AND status IN ('sending','spooling','queued')", job.id);
  const fresh = q.one('SELECT * FROM jobs WHERE id = ?', job.id);
  events.toJob(fresh, 'job:status', { status: 'cancelled' });
  res.json({ job: shapeJob(fresh) });
});

// ---------------------------------------------------------------------------
router.get('/', requireUser, (req, res) => {
  const rows = q.all(
    `SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC LIMIT 100`, req.user.id);
  res.json({ jobs: rows.map((j) => shapeJob(j, { includeReport: false })) });
});

router.get('/:publicId', requireUser, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  res.json({
    job: shapeJob(job),
    events: q.all(
      `SELECT at, actor, kind, from_status, to_status, message
         FROM job_events WHERE job_id = ? ORDER BY id`, job.id),
  });
});

// ---------------------------------------------------------------------------
// File streaming. Preview/thumb are cacheable; originals and print rasters are not.
// ---------------------------------------------------------------------------
router.get('/:publicId/file/:role', requireUser, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  const role = req.params.role;
  if (!['original', 'preview', 'thumb', 'print', 'proof_pdf'].includes(role)) {
    return res.status(404).json({ error: 'unknown_role' });
  }
  if (role === 'print' && !['operator', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const file = storage.getJobFile(job.id, role);
  if (!file) {
    return res.status(role === 'preview' ? 202 : 404)
      .json({ error: role === 'preview' ? 'render_pending' : 'not_found' });
  }
  storage.sendFile(res, file, {
    maxAgeSec: ['preview', 'thumb'].includes(role) ? 3600 : 0,
    download: role === 'original' ? file.original_name : null,
    inline: role !== 'original',
  });
});

module.exports = router;
