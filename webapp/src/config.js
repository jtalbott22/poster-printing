'use strict';
require('dotenv').config();
const path = require('path');

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}
const num = (name, dflt) => (process.env[name] ? Number(process.env[name]) : dflt);
const bool = (name, dflt) =>
  process.env[name] === undefined ? dflt : /^(1|true|yes|on)$/i.test(process.env[name]);

const DATA_ROOT = process.env.DATA_ROOT || '/var/lib/poster-portal';

const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://posters.kent.edu').replace(/\/$/, '');

// If PUBLIC_URL carries a path — https://adstare.kent.edu/static/posters,
// because the portal is sharing a host and vhost with something else rather
// than owning its own subdomain — every route, static asset, and Socket.IO
// connection has to live under that same path, or the browser's absolute
// fetch('/api/...') calls resolve against the site root instead of here.
// One derived value drives all of it: server.js mounts a single sub-router
// at BASE_PATH instead of at '/', and the two HTML pages get BASE_PATH
// injected as a JS constant they prefix onto every request they make. A
// plain root deployment (PUBLIC_URL with no path) makes this '', which is a
// no-op everywhere it's used — nothing changes for the common case.
const BASE_PATH = (() => {
  try { return new URL(PUBLIC_URL).pathname.replace(/\/$/, ''); }
  catch { return ''; }
})();

module.exports = {
  env: process.env.NODE_ENV || 'production',
  port: num('PORT', 3000),
  bindHost: process.env.BIND_HOST || '127.0.0.1',
  publicUrl: PUBLIC_URL,
  basePath: BASE_PATH,

  paths: {
    dataRoot: DATA_ROOT,
    db: process.env.DB_PATH || path.join(DATA_ROOT, 'poster-portal.db'),
    blobs: path.join(DATA_ROOT, 'blobs'),        // content-addressed originals
    renditions: path.join(DATA_ROOT, 'renditions'), // per-job derived images
    incoming: path.join(DATA_ROOT, 'incoming'),  // multer scratch, same filesystem
    hls: process.env.HLS_ROOT || path.join(DATA_ROOT, 'hls'),
    staticAssets: path.join(DATA_ROOT, 'assets'),
  },

  auth: {
    googleClientId: req('GOOGLE_CLIENT_ID'),
    googleClientSecret: req('GOOGLE_CLIENT_SECRET'),
    // Google's hd claim. Personal accounts have no hd and are rejected.
    allowedDomains: (process.env.ALLOWED_DOMAINS || 'kent.edu')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    redirectPath: '/auth/google/callback',
    sessionCookie: 'pp_sid',
    sessionDays: num('SESSION_DAYS', 7),
    // Emails auto-granted admin on first login. Everyone else is a requester.
    bootstrapAdmins: (process.env.BOOTSTRAP_ADMINS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  },

  secrets: {
    cookieSecret: req('COOKIE_SECRET'),        // 32+ random bytes, hex
    flowSharedSecret: req('FLOW_SHARED_SECRET'), // portal <-> Power Automate
  },

  print: {
    targetDpi: num('TARGET_DPI', 300),
    minDpi: num('MIN_DPI', 150),
    warnDpi: num('WARN_DPI', 200),
    rollWidths: (process.env.ROLL_WIDTHS || '36,42').split(',').map(Number),
    // usable width after the driver's unprintable edge
    edgeMarginIn: num('EDGE_MARGIN_IN', 0.25),
    minLengthIn: num('MIN_LENGTH_IN', 8),
    maxLengthIn: num('MAX_LENGTH_IN', 120),
    maxAspect: num('MAX_ASPECT', 6),           // reject skinnier than 1:6
    maxUploadBytes: num('MAX_UPLOAD_MB', 250) * 1024 * 1024,
    // Rendition sizes
    previewMaxPx: num('PREVIEW_MAX_PX', 1600),
    thumbMaxPx: num('THUMB_MAX_PX', 480),
    // Cap the print raster so one absurd job can't eat the box.
    maxPrintMegapixels: num('MAX_PRINT_MP', 400),
    // 'png' (lossless, large) or 'jpeg' (about 4.5x smaller on photo-heavy
    // posters). See the note in render.js before changing this.
    printFormat: (process.env.PRINT_FORMAT || 'png').toLowerCase(),
    jpegQuality: num('PRINT_JPEG_QUALITY', 95),
  },

  pipeline: {
    concurrency: num('RENDER_CONCURRENCY', 2),
    sofficeBin: process.env.SOFFICE_BIN || '/usr/bin/soffice',
    pdftoppmBin: process.env.PDFTOPPM_BIN || '/usr/bin/pdftoppm',
    pdfinfoBin: process.env.PDFINFO_BIN || '/usr/bin/pdfinfo',
    chromiumBin: process.env.CHROMIUM_BIN || '/usr/bin/chromium',
    convertTimeoutMs: num('CONVERT_TIMEOUT_MS', 180000),
  },

  flow: {
    // HTTP-triggered Power Automate flows. Blank = feature off (portal-only approvals).
    submitUrl: process.env.FLOW_SUBMIT_URL || '',
    notifyUrl: process.env.FLOW_NOTIFY_URL || '',
    approvalDeadlineHours: num('APPROVAL_DEADLINE_HOURS', 48),
    outboxRetryBaseMs: num('OUTBOX_RETRY_BASE_MS', 15000),
    outboxMaxAttempts: num('OUTBOX_MAX_ATTEMPTS', 12),
  },

  retention: {
    // Days after a job closes before originals + print rasters are deleted.
    heavyDays: num('RETENTION_HEAVY_DAYS', 30),
    // Thumbs/previews and all metadata are kept this long for the record.
    lightDays: num('RETENTION_LIGHT_DAYS', 400),
    spoolerRecordDays: num('SPOOLER_RECORD_DAYS', 2),
  },

  features: {
    cameras: bool('FEATURE_CAMERAS', false),
    supplies: bool('FEATURE_SUPPLIES', true),
    htmlUploads: bool('FEATURE_HTML_UPLOADS', true),
  },
};
