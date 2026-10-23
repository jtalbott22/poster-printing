'use strict';
/**
 * ============================================================================
 *  OUTBOX — portal -> Power Automate
 * ============================================================================
 *  The transcript worried about "maintaining these potentially really long,
 *  open REST calls ... so we make sure those don't time out."
 *
 *  Don't hold them open. An approval can sit for two days; no HTTP connection
 *  survives that, and both ends restart for patching anyway. Instead:
 *
 *    portal --POST(job + callbackUrl + one-time token)--> Flow   [<2 s, closed]
 *    Flow: Teams approval, waits as long as it likes (Flow's own state)
 *    Flow --POST decision + token--> portal /hooks/approval/:publicId
 *
 *  Neither side holds a socket. Either side can restart. Every POST is
 *  retried with backoff and carries an idempotency key, so a duplicate
 *  delivery is a no-op rather than a second poster.
 *
 *  The safety net is a deadline, not a timeout: if no decision arrives by
 *  approvals.deadline_at, the job moves to 'expired' and lands in the admin
 *  console, where a human approves it in one click. Nothing is ever stuck
 *  waiting on a promise that will never settle.
 * ============================================================================
 */
const crypto = require('crypto');
const config = require('./config');
const { q, logEvent } = require('./db');
const security = require('./security');
const events = require('./events');

let timer = null;

/** Queue an event for delivery. Returns immediately; the sweeper does the work. */
function enqueue({ jobId = null, event, url, payload, idempotencyKey = null }) {
  if (!url) return null;                       // feature disabled — skip silently
  const key = idempotencyKey ||
    `${event}:${jobId ?? 'none'}:${crypto.randomBytes(8).toString('hex')}`;
  // `event` and the idempotency key travel INSIDE the body as well as in the
  // headers. Power Automate switches on the body property, and a flow author
  // reading the run history should be able to tell what an envelope was
  // without cross-referencing headers.
  const body = { event, idempotencyKey: key, sentAt: new Date().toISOString(), ...payload };
  try {
    const res = q.run(
      `INSERT INTO webhook_outbox (job_id, event, url, payload_json, idempotency_key)
       VALUES (?,?,?,?,?)`,
      jobId, event, url, JSON.stringify(body), key
    );
    setImmediate(sweep);
    return res.lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null;  // already queued
    throw e;
  }
}

async function deliver(row) {
  const body = row.payload_json;
  const { timestamp, signature } = security.signBody(config.secrets.flowSharedSecret, body);
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PP-Event': row.event,
        'X-PP-Timestamp': timestamp,
        'X-PP-Signature': signature,
        'X-PP-Idempotency-Key': row.idempotency_key,
      },
      body,
      signal: controller.signal,
    });

    if (res.ok || res.status === 202) {
      q.run(
        `UPDATE webhook_outbox SET delivered_at = datetime('now'), last_status = ?,
            attempts = attempts + 1, last_error = NULL WHERE id = ?`,
        res.status, row.id);
      if (row.job_id) {
        logEvent({ jobId: row.job_id, kind: 'webhook',
          message: `delivered ${row.event} to Power Automate (${res.status})` });
      }
      return true;
    }
    // 4xx other than 429 means the flow is misconfigured; retrying won't fix it,
    // but we keep trying a few times because Flow returns 400 while warming up.
    throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  } finally {
    clearTimeout(abort);
  }
}

function backoffSeconds(attempt) {
  const base = config.flow.outboxRetryBaseMs / 1000;
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.min(3600, Math.round(base * Math.pow(2, attempt - 1) * jitter));
}

async function sweep() {
  const due = q.all(
    `SELECT * FROM webhook_outbox
      WHERE delivered_at IS NULL
        AND attempts < ?
        AND next_attempt_at <= datetime('now')
      ORDER BY id LIMIT 10`,
    config.flow.outboxMaxAttempts
  );
  for (const row of due) {
    try {
      await deliver(row);
    } catch (err) {
      const attempts = row.attempts + 1;
      const wait = backoffSeconds(attempts);
      q.run(
        `UPDATE webhook_outbox SET attempts = ?, last_error = ?,
            next_attempt_at = datetime('now', ?) WHERE id = ?`,
        attempts, String(err.message).slice(0, 500), `+${wait} seconds`, row.id);

      if (attempts >= config.flow.outboxMaxAttempts) {
        console.error(`[outbox] giving up on ${row.event} #${row.id}: ${err.message}`);
        if (row.job_id) {
          logEvent({ jobId: row.job_id, kind: 'error',
            message: `Power Automate unreachable after ${attempts} attempts — ` +
                     `this job needs a manual decision in the console` });
        }
        events.toAdmin('outbox:dead_letter', {
          id: row.id, event: row.event, jobId: row.job_id, error: String(err.message),
        });
      }
    }
  }
}

/**
 * Deadline sweeper. Jobs whose approval window closed move to 'expired' so a
 * human sees them, rather than sitting in pending_approval forever.
 */
function sweepDeadlines() {
  const { setStatus } = require('./db');
  const overdue = q.all(
    `SELECT a.id AS approval_id, j.id AS job_id, j.public_id, j.title, j.user_id
       FROM approvals a JOIN jobs j ON j.id = a.job_id
      WHERE a.decided_at IS NULL AND a.is_current = 1
        AND a.deadline_at < datetime('now')
        AND j.status = 'pending_approval'`
  );
  for (const row of overdue) {
    try {
      setStatus(row.job_id, 'expired', {
        message: 'No approval decision inside the window — moved to the manual queue',
      });
      events.toAdmin('job:expired', { jobId: row.public_id, title: row.title });
      events.toUser(row.user_id, 'job:status', {
        jobId: row.public_id, status: 'expired',
        message: 'Still waiting on review. Our team has been notified.',
      });
    } catch (e) { console.error('[outbox] deadline sweep', e.message); }
  }
  return overdue.length;
}

function start() {
  timer = setInterval(() => {
    sweep().catch((e) => console.error('[outbox] sweep', e));
    sweepDeadlines();
  }, 10000);
  timer.unref?.();
  setImmediate(sweep);
  console.log('[outbox] sweeper up');
}
function stop() { if (timer) clearInterval(timer); }

/** Convenience wrappers used by the routes. */
function jobSubmitted(job, extra) {
  return enqueue({
    jobId: job.id, event: 'job.submitted', url: config.flow.submitUrl,
    idempotencyKey: `job.submitted:${job.public_id}`,
    payload: extra,
  });
}
function notify(job, event, payload) {
  return enqueue({
    jobId: job.id, event, url: config.flow.notifyUrl,
    idempotencyKey: `${event}:${job.public_id}`,
    payload,
  });
}

module.exports = { start, stop, enqueue, sweep, sweepDeadlines, jobSubmitted, notify };
