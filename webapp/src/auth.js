'use strict';
/**
 * Google sign-in, done directly against Google's OIDC endpoints — no passport,
 * no strategy plugins, ~150 lines you can actually audit.
 *
 * Domain enforcement happens twice on purpose:
 *   1. `hd=kent.edu` on the authorize URL, so Google's own picker filters.
 *      That parameter is a hint. It is trivially removed by the user.
 *   2. The `hd` claim inside the verified ID token, server-side. This is the
 *      one that counts. A personal gmail account has no `hd` claim at all, so
 *      it fails closed, and we bounce them back to the picker with a message
 *      rather than a dead end.
 */
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const config = require('./config');
const { q } = require('./db');

const GOOGLE = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};
const JWKS = createRemoteJWKSet(new URL(GOOGLE.jwks));

const b64url = (buf) => buf.toString('base64url');
const rand = (n = 32) => b64url(crypto.randomBytes(n));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function redirectUri() { return config.publicUrl + config.auth.redirectPath; }

// Every redirect target and cookie path in this file needs the same prefix
// PUBLIC_URL carries, or a portal sharing a host under e.g. /static/posters
// would keep bouncing people to the site root instead of back to itself.
// config.basePath is '' for a normal root deployment, so withBase(p) === p
// there — this changes nothing for the common case.
const withBase = (p) => config.basePath + p;

// ---------------------------------------------------------------------------
// Step 1 — send the browser to Google
// ---------------------------------------------------------------------------
function beginLogin(req, res) {
  const state = rand(24);
  const codeVerifier = rand(48);
  const nonce = rand(16);
  // req.query.next, when set, already arrives as a full path including the
  // base — see requireUser below, which builds it from req.originalUrl.
  const returnTo = typeof req.query.next === 'string' && req.query.next.startsWith('/')
    ? req.query.next : withBase('/');

  q.run(
    'INSERT INTO oauth_states (state, code_verifier, nonce, return_to) VALUES (?,?,?,?)',
    state, codeVerifier, nonce, returnTo
  );
  q.run("DELETE FROM oauth_states WHERE created_at < datetime('now','-15 minutes')");

  const params = new URLSearchParams({
    client_id: config.auth.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state, nonce,
    code_challenge: b64url(sha256(codeVerifier)),
    code_challenge_method: 'S256',
    prompt: 'select_account',
    hd: config.auth.allowedDomains[0],
  });
  res.redirect(`${GOOGLE.auth}?${params}`);
}

// ---------------------------------------------------------------------------
// Step 2 — Google comes back
// ---------------------------------------------------------------------------
async function completeLogin(req, res) {
  const { code, state, error } = req.query;
  if (error) return res.redirect(withBase('/?signin=cancelled'));
  if (!code || !state) return res.redirect(withBase('/?signin=bad_request'));

  const st = q.one('SELECT * FROM oauth_states WHERE state = ?', state);
  if (!st) return res.redirect(withBase('/?signin=expired'));
  q.run('DELETE FROM oauth_states WHERE state = ?', state);

  const body = new URLSearchParams({
    code,
    client_id: config.auth.googleClientId,
    client_secret: config.auth.googleClientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
    code_verifier: st.code_verifier,
  });
  const tokenRes = await fetch(GOOGLE.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokenRes.ok) {
    console.error('[auth] token exchange failed', await tokenRes.text());
    return res.redirect(withBase('/?signin=token_failed'));
  }
  const tokens = await tokenRes.json();

  let claims;
  try {
    const verified = await jwtVerify(tokens.id_token, JWKS, {
      issuer: GOOGLE.issuers,
      audience: config.auth.googleClientId,
      clockTolerance: 30,
    });
    claims = verified.payload;
  } catch (e) {
    console.error('[auth] id_token verification failed', e.message);
    return res.redirect(withBase('/?signin=invalid_token'));
  }
  if (claims.nonce !== st.nonce) return res.redirect(withBase('/?signin=nonce_mismatch'));
  if (!claims.email_verified) return res.redirect(withBase('/?signin=unverified_email'));

  // --- the check that matters -------------------------------------------
  const hd = String(claims.hd || '').toLowerCase();
  const emailDomain = String(claims.email || '').split('@')[1]?.toLowerCase();
  const domainOk =
    config.auth.allowedDomains.includes(hd) &&
    config.auth.allowedDomains.includes(emailDomain);
  if (!domainOk) {
    return res.redirect(withBase('/?signin=wrong_domain&tried=') +
      encodeURIComponent(claims.email || 'unknown'));
  }

  const email = String(claims.email).toLowerCase();
  const isBootstrapAdmin = config.auth.bootstrapAdmins.includes(email);

  q.run(
    `INSERT INTO users (google_sub, email, domain, display_name, picture_url, role, last_login_at)
     VALUES (?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET
       google_sub  = excluded.google_sub,
       display_name= excluded.display_name,
       picture_url = excluded.picture_url,
       role        = CASE WHEN ? = 1 AND users.role = 'requester'
                          THEN 'admin' ELSE users.role END,
       last_login_at = datetime('now')`,
    claims.sub, email, hd, claims.name || email.split('@')[0], claims.picture || null,
    isBootstrapAdmin ? 'admin' : 'requester', isBootstrapAdmin ? 1 : 0
  );

  const user = q.one('SELECT * FROM users WHERE email = ?', email);
  if (!user.is_active) return res.redirect(withBase('/?signin=account_disabled'));

  const sid = rand(32);
  q.run(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
     VALUES (?, ?, datetime('now', ?), ?, ?)`,
    sid, user.id, `+${config.auth.sessionDays} days`,
    req.ip, String(req.get('user-agent') || '').slice(0, 300)
  );

  res.cookie(config.auth.sessionCookie, sid, {
    httpOnly: true,
    secure: config.publicUrl.startsWith('https'),
    sameSite: 'lax',
    maxAge: config.auth.sessionDays * 86400 * 1000,
    path: config.basePath || '/',
    signed: true,
  });
  res.redirect(st.return_to || withBase('/'));
}

function logout(req, res) {
  const sid = req.signedCookies?.[config.auth.sessionCookie];
  if (sid) q.run('DELETE FROM sessions WHERE id = ?', sid);
  res.clearCookie(config.auth.sessionCookie, { path: config.basePath || '/' });
  res.redirect(withBase('/?signin=signed_out'));
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
function loadUser(req, _res, next) {
  req.user = null;
  const sid = req.signedCookies?.[config.auth.sessionCookie];
  if (!sid) return next();
  const row = q.one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > datetime('now') AND u.is_active = 1`, sid);
  if (row) { req.user = row; req.sessionId = sid; }
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.accepts('json') && !req.accepts('html')) {
    return res.status(401).json({ error: 'sign_in_required', signInUrl: withBase('/auth/google') });
  }
  // req.originalUrl (unlike req.path) is NOT stripped of the router's mount
  // prefix, so this already includes the base — no withBase() needed here.
  return res.redirect(withBase('/auth/google?next=') + encodeURIComponent(req.originalUrl));
}

const RANK = { requester: 0, approver: 1, operator: 2, admin: 3 };
function requireRole(minimum) {
  return (req, res, next) => {
    if (!req.user) return requireUser(req, res, next);
    if (RANK[req.user.role] >= RANK[minimum]) return next();
    res.status(403).json({ error: 'forbidden', need: minimum });
  };
}

/** Socket.IO handshake auth — reuses the same cookie session. */
function authenticateSocket(cookieHeader, unsignCookie) {
  const raw = /(?:^|;\s*)pp_sid=([^;]+)/.exec(cookieHeader || '');
  if (!raw) return null;
  const sid = unsignCookie(decodeURIComponent(raw[1]));
  if (!sid) return null;
  return q.one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > datetime('now') AND u.is_active = 1`, sid);
}

function sweepSessions() {
  q.run("DELETE FROM sessions WHERE expires_at < datetime('now')");
  q.run("DELETE FROM oauth_states WHERE created_at < datetime('now','-1 hour')");
}

module.exports = {
  beginLogin, completeLogin, logout, loadUser, requireUser, requireRole,
  authenticateSocket, sweepSessions, RANK,
};
