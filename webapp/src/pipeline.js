'use strict';
/**
 * Render worker. Polls render_tasks, claims rows atomically, converts, and
 * pushes progress to the browser over Socket.IO.
 *
 * Deliberately in-process rather than Redis/BullMQ: the queue is a table in
 * the same SQLite file as everything else, so a task can never outlive its
 * job or survive a restore. Claiming is a conditional UPDATE, so adding a
 * second worker process later is a config change, not a rewrite.
 */
const os = require('os');
const config = require('./config');
const { q, now, logEvent, setStatus } = require('./db');
const storage = require('./storage');
const render = require('./render');
const preflight = require('./preflight');
const events = require('./events');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
let running = 0;
let timer = null;
let stopped = false;

function enqueue(jobId, kind) {
  q.run(
    `INSERT INTO render_tasks (job_id, kind, status) VALUES (?, ?, 'pending')
     ON CONFLICT(job_id, kind) DO UPDATE SET
       status = CASE WHEN render_tasks.status = 'running' THEN 'running' ELSE 'pending' END,
       error = NULL, claimed_by = NULL`,
    jobId, kind
  );
  kick();
}

function claimNext() {
  const row = q.one(
    `SELECT * FROM render_tasks
      WHERE status = 'pending' AND attempts < 3
      ORDER BY CASE kind WHEN 'preview' THEN 0 ELSE 1 END, id
      LIMIT 1`
  );
  if (!row) return null;
  const res = q.run(
    `UPDATE render_tasks
        SET status='running', claimed_by=?, claimed_at=datetime('now'),
            started_at=datetime('now'), attempts = attempts + 1
      WHERE id = ? AND status = 'pending'`,
    WORKER_ID, row.id
  );
  return res.changes === 1 ? q.one('SELECT * FROM render_tasks WHERE id = ?', row.id) : null;
}

async function runTask(task) {
  const started = Date.now();
  const job = q.one('SELECT * FROM jobs WHERE id = ?', task.job_id);
  if (!job) { finish(task, 'error', 'job disappeared', started); return; }

  const original = storage.getJobFile(job.id, 'original');
  if (!original) { finish(task, 'error', 'no original file on job', started); return; }

  const originalAbs = storage.absFor(original);
  const report = job.preflight_json ? JSON.parse(job.preflight_json) : null;
  if (!report || !report.layout) { finish(task, 'error', 'job has no preflight result', started); return; }

  const srcKind = report.source.kind;
  events.toJob(job, 'render:start', { kind: task.kind });

  try {
    if (task.kind === 'preview') {
      const out = await render.buildPreview(job, originalAbs, srcKind, report.layout);
      storage.recordJobFile(job.id, {
        role: 'preview', relPath: out.preview.relPath, mime: 'image/jpeg',
        byteSize: out.preview.byteSize, widthPx: out.preview.widthPx,
        heightPx: out.preview.heightPx,
      });
      storage.recordJobFile(job.id, {
        role: 'thumb', relPath: out.thumb.relPath, mime: 'image/jpeg',
        byteSize: out.thumb.byteSize, widthPx: out.thumb.widthPx,
        heightPx: out.thumb.heightPx,
      });
      events.toJob(job, 'preview:ready', {
        jobId: job.public_id,
        url: `/api/jobs/${job.public_id}/file/preview`,
        width: out.preview.widthPx, height: out.preview.heightPx,
      });
    } else {
      const out = await render.buildPrintRaster(
        job, originalAbs, srcKind, report.layout, report.raster);
      storage.recordJobFile(job.id, {
        role: 'print', relPath: out.relPath, mime: out.mime,
        byteSize: out.byteSize, widthPx: out.widthPx, heightPx: out.heightPx,
        densityDpi: out.densityDpi,
      });
      logEvent({
        jobId: job.id, kind: 'render', message:
          `print raster ready — ${out.widthPx}x${out.heightPx} px @ ${out.densityDpi} DPI, ` +
          `${(out.byteSize / 1048576).toFixed(1)} MB`,
      });
      events.toJob(job, 'print:ready', { jobId: job.public_id, bytes: out.byteSize });
    }
    finish(task, 'done', null, started);
  } catch (err) {
    const msg = String(err.message || err).slice(0, 1000);
    logEvent({ jobId: job.id, kind: 'error', message: `render ${task.kind} failed: ${msg}` });
    events.toJob(job, 'render:error', { kind: task.kind, message: msg });
    finish(task, task.attempts >= 3 ? 'error' : 'pending', msg, started);
    if (task.kind === 'print' && task.attempts >= 3) {
      try { setStatus(job.id, 'failed', { message: `Print rendering failed: ${msg}` }); }
      catch { /* status may already be terminal */ }
    }
  }
}

function finish(task, status, error, started) {
  q.run(
    `UPDATE render_tasks SET status=?, error=?, finished_at=datetime('now'),
        duration_ms=?, claimed_by=NULL WHERE id=?`,
    status, error, Date.now() - started, task.id
  );
}

function kick() {
  if (stopped) return;
  setImmediate(loop);
}

async function loop() {
  if (stopped || running >= config.pipeline.concurrency) return;
  const task = claimNext();
  if (!task) return;
  running += 1;
  try { await runTask(task); }
  catch (e) { console.error('[pipeline] unhandled', e); }
  finally { running -= 1; kick(); }
}

function start() {
  stopped = false;
  // Anything left 'running' by a crashed worker goes back in the pool.
  q.run(
    `UPDATE render_tasks SET status='pending', claimed_by=NULL
      WHERE status='running' AND claimed_at < datetime('now','-15 minutes')`
  );
  timer = setInterval(() => { for (let i = running; i < config.pipeline.concurrency; i++) kick(); }, 2000);
  timer.unref?.();
  kick();
  console.log(`[pipeline] worker ${WORKER_ID} up, concurrency ${config.pipeline.concurrency}`);
}
function stop() { stopped = true; if (timer) clearInterval(timer); }

module.exports = { start, stop, enqueue, WORKER_ID };
