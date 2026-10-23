'use strict';
/**
 * Power Automate -> portal.
 *
 * Authenticated by a per-job single-use token, because Flow can't HMAC without
 * a premium connector. The token is 32 random bytes, scoped to one job, stored
 * only as a hash, and consumed on first use. Rate-limited on top of that.
 *
 * Every handler is idempotent: Flow retries any call it thinks timed out, and
 * a retry must never produce a second poster.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { q, logEvent, setStatus } = require('../db');
const security = require('../security');
const dispatch = require('../dispatch');
const outbox = require('../outbox');
const events = require('../events');

const router = express.Router();

router.use(rateLimit({
  windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited' },
}));

function idempotent(req, res, handler) {
  const key = req.get('x-pp-idempotency-key') || req.body?.idempotencyKey;
  const prior = security.replayResponse(key);
  if (prior) return res.status(prior.statusCode).json({ ...prior.payload, replayed: true });
  const send = (code, payload) => {
    security.rememberResponse(key, code, payload);
    res.status(code).json(payload);
  };
  return handler(send);
}

// ---------------------------------------------------------------------------
// POST /hooks/approval/:publicId
//   { decision: 'approved'|'rejected', decidedBy, comments, flowRunId }
//   header: X-PP-Callback-Token
// ---------------------------------------------------------------------------
router.post('/approval/:publicId', express.json({ limit: '256kb' }), (req, res) => {
  idempotent(req, res, async (send) => {
    const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
    if (!job) return send(404, { error: 'not_found' });

    const token = req.get('x-pp-callback-token') || req.body.token;
    const approval = security.consumeCallbackToken(job.id, token);
    if (!approval) return send(401, { error: 'bad_or_used_token' });

    // Power Automate's approval connector returns its outcome as literally
    // "Approve" or "Reject" — not the past tense our state machine uses. A
    // human wiring the flow will also reasonably send "approved" or "yes".
    // Normalise here rather than making every flow author get it exactly
    // right, because the failure mode is a decision that silently 400s and
    // a poster that never prints.
    const raw = String(req.body.decision ?? req.body.outcome ?? '').trim().toLowerCase();
    const DECISIONS = {
      approve: 'approved', approved: 'approved', yes: 'approved', accept: 'approved',
      reject: 'rejected', rejected: 'rejected', no: 'rejected', deny: 'rejected',
    };
    const decision = DECISIONS[raw];
    if (!decision) {
      return send(400, {
        error: 'bad_decision', received: raw || null,
        expected: ['Approve', 'Reject'],
        message: 'Send the approval outcome as Approve or Reject.',
      });
    }
    if (!['pending_approval', 'expired'].includes(job.status)) {
      // Already decided, cancelled, or printed — accept and do nothing.
      return send(200, { ok: true, ignored: true, status: job.status });
    }

    const decidedBy = String(req.body.decidedBy || 'unknown').slice(0, 200);
    const comments = String(req.body.comments || '').slice(0, 2000) || null;

    q.run(
      `UPDATE approvals SET decided_at = datetime('now'), decision = ?, decided_by = ?,
          decided_via = 'teams', comments = ?, flow_run_id = ?
        WHERE id = ?`,
      decision, decidedBy, comments, String(req.body.flowRunId || '').slice(0, 120) || null,
      approval.id);

    setStatus(job.id, decision, {
      actor: decidedBy, message: comments,
      data: { via: 'power_automate' },
    });

    const fresh = q.one('SELECT * FROM jobs WHERE id = ?', job.id);
    events.toJob(fresh, 'job:status', { status: decision, decidedBy, comments });

    if (decision === 'rejected') {
      outbox.notify(fresh, 'job.rejected', {
        jobId: fresh.public_id, title: fresh.title,
        requester: q.one('SELECT email, display_name FROM users WHERE id = ?', fresh.user_id),
        decidedBy, comments,
        links: { resubmit: `${config.publicUrl}/?job=${fresh.public_id}` },
      });
      return send(200, { ok: true, status: 'rejected' });
    }

    // Approved. Print if the raster is ready; otherwise the pipeline's
    // completion hook picks it up. Either way this call returns immediately.
    try {
      const result = await dispatch.dispatchJob(fresh.id, { actor: decidedBy });
      return send(200, { ok: true, status: 'queued', docToken: result.docToken });
    } catch (err) {
      if (err.code === 'RASTER_NOT_READY') {
        logEvent({ jobId: fresh.id, kind: 'note',
          message: 'Approved before the print file finished rendering — will send when ready' });
        return send(202, { ok: true, status: 'approved', detail: 'awaiting_render' });
      }
      logEvent({ jobId: fresh.id, kind: 'error', message: `dispatch failed: ${err.message}` });
      return send(200, { ok: true, status: 'approved', detail: 'dispatch_failed', error: err.message });
    }
  });
});

// ---------------------------------------------------------------------------
// POST /hooks/pickup/:publicId — a Teams "I collected it" button, or a badge tap
// ---------------------------------------------------------------------------
router.post('/pickup/:publicId', express.json({ limit: '64kb' }),
  security.requireApiKey('flow'), (req, res) => {
    idempotent(req, res, (send) => {
      const job = q.one('SELECT * FROM jobs WHERE public_id = ?', req.params.publicId);
      if (!job) return send(404, { error: 'not_found' });
      if (job.status !== 'printed') return send(200, { ok: true, ignored: true, status: job.status });
      setStatus(job.id, 'picked_up', {
        actor: String(req.body.by || 'flow').slice(0, 200),
      });
      events.toJob(job, 'job:status', { status: 'picked_up' });
      send(200, { ok: true, status: 'picked_up' });
    });
  });

// ---------------------------------------------------------------------------
// POST /hooks/supplies — restock counts pushed from the Power App inventory
// ---------------------------------------------------------------------------
router.post('/supplies', express.json({ limit: '256kb' }),
  security.requireApiKey('flow'), (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    let applied = 0;
    const tx = q.tx(() => {
      for (const it of items) {
        if (!it.sku) continue;
        q.run(
          `INSERT INTO supplies (sku, kind, description, ink_code, roll_width_in,
                                 on_hand, reorder_at, powerapps_asset_id, updated_at)
           VALUES (?,?,?,?,?,?,?,?, datetime('now'))
           ON CONFLICT(sku) DO UPDATE SET
             on_hand = excluded.on_hand,
             reorder_at = COALESCE(excluded.reorder_at, supplies.reorder_at),
             powerapps_asset_id = COALESCE(excluded.powerapps_asset_id, supplies.powerapps_asset_id),
             updated_at = datetime('now')`,
          it.sku, it.kind || 'misc', it.description || it.sku, it.inkCode || null,
          it.rollWidthIn || null, Number(it.onHand) || 0, it.reorderAt ?? null,
          it.assetId || null);
        const supply = q.one('SELECT id, on_hand FROM supplies WHERE sku = ?', it.sku);
        q.run(
          `INSERT INTO supply_txns (supply_id, delta, reason, actor, note)
           VALUES (?,?,?,?,?)`,
          supply.id, 0, 'count', 'powerapps', `set to ${it.onHand}`);
        applied += 1;
      }
    });
    tx();
    events.toAdmin('supplies:updated', { applied });
    res.json({ ok: true, applied });
  });

// ---------------------------------------------------------------------------
// GET /hooks/health — for a Flow "is the portal up" check
// ---------------------------------------------------------------------------
router.get('/health', (_req, res) => {
  const pending = q.one(
    "SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending_approval'").n;
  const stuck = q.one(
    `SELECT COUNT(*) AS n FROM webhook_outbox
      WHERE delivered_at IS NULL AND attempts >= ?`, config.flow.outboxMaxAttempts).n;
  res.json({ ok: true, pendingApproval: pending, deadLetters: stuck, at: new Date().toISOString() });
});

module.exports = router;
