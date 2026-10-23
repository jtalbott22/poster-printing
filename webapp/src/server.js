'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { migrate, q } = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const events = require('./events');
const pipeline = require('./pipeline');
const outbox = require('./outbox');
const dispatch = require('./dispatch');
const render = require('./render');

migrate();
storage.ensureDirs();

const app = express();
app.set('trust proxy', 1);                       // behind nginx
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],  // the portal ships inline handlers
      // Helmet sets script-src-attr to 'none' by default, and browsers treat
      // it as a SEPARATE directive from script-src — inline `onclick=` is
      // blocked even though inline <script> blocks are allowed above. Both
      // pages use inline handlers, so without this the sign-in button and
      // every console action silently do nothing.
      //
      // This is not a meaningful widening of what's already permitted:
      // scriptSrc already allows 'unsafe-inline'. It IS worth closing
      // properly some day by moving the ~32 inline handlers onto
      // addEventListener with event delegation, at which point both this
      // line and the 'unsafe-inline' above can go.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://lh3.googleusercontent.com'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", 'blob:'],             // local PDF preview in an <embed>
      objectSrc: ["'self'", 'blob:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use(cookieParser(config.secrets.cookieSecret));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));

// JSON parsing is applied per-router: the agent and hook routes need the raw
// body for signature checks, so a global express.json() would break them.

app.use(auth.loadUser);

// Everything below is mounted on `root` rather than directly on `app`, and
// `root` is attached to `app` at config.basePath (see the bottom of this
// block). That single mount point is what lets the portal share a host —
// https://adstare.kent.edu/static/posters — instead of owning its own
// subdomain: every relative path inside these handlers stays exactly as
// written (Express strips the mount prefix from req.path on the way in),
// and the two HTML pages get the same prefix injected as a JS constant so
// their own fetch() and Socket.IO calls land back on this router instead of
// the site root. A plain root deployment makes config.basePath '', which
// mounts `root` at '/' — unchanged from before this existed.
const root = express.Router();

// --- auth --------------------------------------------------------------
root.get('/auth/google', rateLimit({ windowMs: 60000, limit: 30 }), auth.beginLogin);
root.get(config.auth.redirectPath, rateLimit({ windowMs: 60000, limit: 30 }),
  (req, res) => auth.completeLogin(req, res).catch((e) => {
    console.error('[auth]', e); res.redirect(`${config.basePath}/?signin=error`);
  }));
root.post('/auth/logout', auth.logout);
root.get('/auth/logout', auth.logout);
root.get('/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'anonymous' });
  res.json({
    email: req.user.email, name: req.user.display_name,
    role: req.user.role, picture: req.user.picture_url,
  });
});

// --- api ---------------------------------------------------------------
const apiLimiter = rateLimit({ windowMs: 60000, limit: 300, standardHeaders: true });
root.use('/api/jobs', apiLimiter, express.json({ limit: '256kb' }), require('./routes/jobs'));
root.use('/api/admin', apiLimiter, require('./routes/admin'));
root.use('/api/agent', require('./routes/agent'));
root.use('/hooks', require('./routes/hooks'));

// --- HLS camera streams (ffmpeg writes here; nginx serves in production) ---
if (config.features.cameras) {
  root.use('/hls', auth.requireUser,
    express.static(config.paths.hls, {
      setHeaders: (res, p) => {
        res.setHeader('Cache-Control', 'no-cache');
        if (p.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      },
    }));
  root.get('/api/cameras', auth.requireUser, (_req, res) => {
    res.json({ cameras: q.all(
      `SELECT c.display_name, c.hls_path, l.display_name AS location, p.code AS printer_code
         FROM cameras c JOIN locations l ON l.id = c.location_id
         LEFT JOIN printers p ON p.id = c.printer_id
        WHERE c.is_active = 1`) });
  });
}

// --- pages ---------------------------------------------------------------
// index.html and admin.html are read once and cached with %%BASE_PATH%%
// substituted for the real value — see loadPage() below — rather than
// served with res.sendFile(), because the pages carry a handful of literal
// href/src attributes (Google sign-in, Socket.IO's client script, the
// admin console link) that a browser resolves from the page's own address,
// not from wherever nginx happens to have mounted us.
const PUBLIC = path.join(__dirname, '..', 'public');
function loadPage(file) {
  const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8')
    .replace(/%%BASE_PATH%%/g, config.basePath);
  return (_req, res) => res.type('html').send(html);
}
const sendIndex = loadPage('index.html');
const sendAdmin = loadPage('admin.html');

// No express.static for public/ — index.html and admin.html are the only
// files in it, both already served above with %%BASE_PATH%% substituted.
// Serving them again statically would hand back the raw, un-substituted
// file if either were requested by its literal name.
root.get('/admin', auth.requireRole('approver'), sendAdmin);
root.get('/admin/job/:publicId', auth.requireRole('approver'), sendAdmin);
root.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
root.get('/', sendIndex);
root.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/hooks')) {
    return res.status(404).json({ error: 'not_found' });
  }
  sendIndex(req, res);
});

app.use(config.basePath || '/', root);

// --- errors ------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    error: err.code || 'server_error',
    message: config.env === 'production' ? 'Something went wrong on our end.' : err.message,
  });
});

// --- boot --------------------------------------------------------------
const server = http.createServer(app);
server.requestTimeout = 0;                        // long uploads set their own pace
server.headersTimeout = 65000;
server.keepAliveTimeout = 61000;

const cookie = require('cookie-parser');
events.attach(server, {
  authenticateSocket: (cookieHeader) =>
    auth.authenticateSocket(cookieHeader,
      (val) => cookie.signedCookie(val, config.secrets.cookieSecret)),
});

pipeline.start();
outbox.start();
dispatch.start();

// Housekeeping: sessions hourly, storage purge nightly.
const hourly = setInterval(() => auth.sweepSessions(), 3600_000); hourly.unref();
const nightly = setInterval(() => {
  storage.purgeExpired()
    .then((r) => console.log('[purge]', r))
    .catch((e) => console.error('[purge]', e));
}, 86_400_000); nightly.unref();

server.listen(config.port, config.bindHost, async () => {
  console.log(`[portal] listening on ${config.bindHost}:${config.port} as ${config.publicUrl}`);
  const tools = await render.checkToolchain();
  for (const [name, r] of Object.entries(tools)) {
    console.log(`[toolchain] ${r.ok ? 'OK  ' : 'MISS'} ${name} ${r.version || r.error}`);
  }
  if (Object.values(tools).some((t) => !t.ok)) {
    console.warn('[toolchain] some converters are missing — see README §3.2');
  }
});

// --- graceful shutdown -------------------------------------------------
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[portal] ${signal} — draining`);
  pipeline.stop(); outbox.stop(); dispatch.stop();
  server.close(() => {
    try { require('./db').db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    console.log('[portal] closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 20000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
