'use strict';
const crypto = require('crypto');
const config = require('./config');
const { q } = require('./db');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// HMAC over the raw request body — portal <-> print agent, both ends Node.
// ---------------------------------------------------------------------------
function signBody(secret, rawBody, timestamp = Date.now().toString()) {
  const mac = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`).update(rawBody).digest('hex');
  return { timestamp, signature: `v1=${mac}` };
}

function verifyBody(secret, rawBody, timestamp, signature, toleranceMs = 300000) {
  if (!timestamp || !signature) return false;
  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceMs) return false;   // replay window
  const expected = signBody(secret, rawBody, timestamp).signature;
  return timingSafeEqual(expected, signature);
}

/** Express middleware factory. Requires express.raw or the rawBody verifier. */
function requireHmac(getSecret) {
  return (req, res, next) => {
    const secret = getSecret(req);
    if (!secret) return res.status(401).json({ error: 'unknown_peer' });
    const ok = verifyBody(
      secret, req.rawBody || Buffer.alloc(0),
      req.get('x-pp-timestamp'), req.get('x-pp-signature')
    );
    if (!ok) return res.status(401).json({ error: 'bad_signature' });
    next();
  };
}

// ---------------------------------------------------------------------------
// API keys (print agents, Power Automate)
// ---------------------------------------------------------------------------
function mintApiKey(label, scope) {
  const key = `pp_${scope}_${randomToken(24)}`;
  q.run(
    'INSERT INTO api_keys (label, scope, key_hash, key_prefix) VALUES (?,?,?,?)',
    label, scope, sha256hex(key), key.slice(0, 12)
  );
  return key;                                  // shown once, never stored plain
}

function lookupApiKey(presented) {
  if (!presented) return null;
  const row = q.one(
    'SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
    sha256hex(presented));
  if (row) q.run("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?", row.id);
  return row;
}

function requireApiKey(scope) {
  return (req, res, next) => {
    const presented =
      (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-api-key');
    const row = lookupApiKey(presented);
    if (!row || row.scope !== scope) return res.status(401).json({ error: 'bad_api_key' });
    req.apiKey = row;
    next();
  };
}

// ---------------------------------------------------------------------------
// Per-job single-use callback tokens (Power Automate -> portal)
// ---------------------------------------------------------------------------
// Power Automate can't compute an HMAC without a premium connector, so the
// approval callback is authenticated by a 32-byte token that is generated per
// job, stored only as a hash, and burned on first use. Combined with the
// job's public_id in the path, replay gets you nothing.
function issueCallbackToken() {
  const token = randomToken(32);
  return { token, hash: sha256hex(token) };
}

function consumeCallbackToken(jobId, presented) {
  if (!presented) return null;
  const row = q.one(
    `SELECT * FROM approvals
      WHERE job_id = ? AND is_current = 1 AND decided_at IS NULL`, jobId);
  if (!row) return null;
  if (!timingSafeEqual(row.callback_token_hash, sha256hex(presented))) return null;
  return row;
}

// ---------------------------------------------------------------------------
// Idempotency for inbound webhooks
// ---------------------------------------------------------------------------
function rememberResponse(key, statusCode, payload) {
  if (!key) return;
  q.run(
    `INSERT OR REPLACE INTO inbound_idempotency (key, response_json, status_code)
     VALUES (?,?,?)`, key, JSON.stringify(payload), statusCode);
  q.run("DELETE FROM inbound_idempotency WHERE created_at < datetime('now','-7 days')");
}
function replayResponse(key) {
  if (!key) return null;
  const row = q.one('SELECT * FROM inbound_idempotency WHERE key = ?', key);
  return row ? { statusCode: row.status_code, payload: JSON.parse(row.response_json) } : null;
}

module.exports = {
  sha256hex, randomToken, timingSafeEqual, signBody, verifyBody, requireHmac,
  mintApiKey, lookupApiKey, requireApiKey, issueCallbackToken, consumeCallbackToken,
  rememberResponse, replayResponse,
  flowSecret: () => config.secrets.flowSharedSecret,
};
