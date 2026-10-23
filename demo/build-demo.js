#!/usr/bin/env node
/**
 * Builds the offline demo from the REAL pages.
 *
 *   node demo/build-demo.js
 *
 * It copies webapp/public/{index,admin}.html, drops in the harness ahead of
 * each page's own script, and adds a small driver that walks the submitter
 * page to the interesting moment. Because the pages are copied rather than
 * rewritten, the demo cannot drift away from what the app actually looks
 * like — rebuild it and it tracks the source.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'webapp', 'public');
const OUT = __dirname;

const BANNER = (which) => `
<div id="demo-banner" style="position:fixed;left:0;right:0;bottom:0;z-index:9999;
  background:#111827;color:#fff;font:500 12.5px Inter,system-ui,sans-serif;
  padding:9px 16px;display:flex;gap:14px;align-items:center;justify-content:center">
  <span style="background:#EEB111;color:#111827;padding:2px 7px;border-radius:4px;
    font-weight:700;font-size:11px">DEMO</span>
  <span>Sample data. No server, no printer. ${which}</span>
  <a href="${which.includes('Submitter') ? 'admin.html' : 'submitter.html'}"
     style="color:#EEB111;text-decoration:none;font-weight:600">
     Switch to the ${which.includes('Submitter') ? 'operations console' : 'submitter view'} →</a>
</div>
<style>body{padding-bottom:44px}</style>
`;

function build(srcName, outName, label, driver) {
  let html = fs.readFileSync(path.join(SRC, srcName), 'utf8');

  // Everything is inlined into a single file. Sibling <script src> would
  // work from a plain file:// open, but not when the page is viewed in a
  // preview pane, mailed as one attachment, or dropped on a share — which
  // is most of how a demo actually travels. One file always works.
  // The demo is never proxied under a path, so BASE_PATH is always empty —
  // the same substitution server.js does at boot for a real deployment.
  html = html.replace(/%%BASE_PATH%%/g, '');

  const inlined =
    `<script>\n${fs.readFileSync(path.join(OUT, 'demo-assets.js'), 'utf8')}\n</script>\n` +
    `<script>\n${fs.readFileSync(path.join(OUT, 'demo-harness.js'), 'utf8')}\n</script>`;

  // Replace the socket.io client, which the app serves and we do not have.
  // Match on the filename only — not the exact prefix in front of it — so
  // this keeps working if the source page's base-path scheme ever changes.
  const before = html;
  html = html.replace(/<script src="[^"]*\/socket\.io\/socket\.io\.js"><\/script>/, inlined);
  if (html === before) html = html.replace(/<script>/, inlined + '\n<script>');

  html = html.replace('</body>', `${BANNER(label)}\n<script>\n${driver}\n</script>\n</body>`);
  fs.writeFileSync(path.join(OUT, outName), html);
  console.log(`  ${outName.padEnd(16)} <- ${srcName}  (${(html.length / 1024).toFixed(0)} KB)`);
}

// ---------------------------------------------------------------------
//  Submitter driver: upload a deck, land on the verdict screen.
// ---------------------------------------------------------------------
const SUBMITTER_DRIVER = `
// Walk the page to the moment worth showing: a deck uploaded, preflight
// green, and the printer emulator holding a 47" x 35.5" landscape sheet.
(async function driveDemo() {
  const until = (fn, ms = 4000) => new Promise((ok, no) => {
    const t0 = Date.now();
    (function poll() {
      if (fn()) return ok();
      if (Date.now() - t0 > ms) return no(new Error('timeout'));
      setTimeout(poll, 40);
    })();
  });

  try {
    await until(() => typeof S !== 'undefined' && S.options &&
      document.getElementById('f-printer').options.length);

    document.getElementById('f-title').value = 'Thermal Tolerance in Lake Erie Fish Populations';
    document.getElementById('f-dept').value = 'Biological Sciences';
    document.getElementById('f-advisor').value = 'Dr. A. Whitmore';
    document.getElementById('f-billing').value = 'CSH-40218';

    // A real File object, so handleFile takes exactly the path it does in
    // production — including the local-preview branch.
    const blob = await (await fetch(window.__DEMO_ASSETS.preview)).blob();
    const file = new File([blob], 'Rivera_Symposium_Poster_48x36.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    Object.defineProperty(file, 'size', { value: 24117248 });

    if (typeof handleFile === 'function') await handleFile(file);

    // The server-rendered preview arriving over the socket, as it would
    // a couple of seconds after upload.
    // Emit a server-style path, not the data URI. The page appends a
    // cache-buster (?t=...) to whatever it receives, which would corrupt a
    // data URI's base64 payload. The harness rewrites the path to the inlined
    // image as the <img> is inserted, so the real code path is unchanged.
    setTimeout(() => window.__demoEmit('preview:ready', {
      jobId: S.jobId, url: '/api/jobs/PP-2026-0416/file/preview',
    }), 900);

    setTimeout(() => window.__demoEmit('printer:status', {
      printer: 'bowman-pro4100-36', state: 'Ready', rollWidthIn: 36,
    }), 1400);
  } catch (e) {
    console.warn('[demo] driver stopped:', e.message);
  }
})();
`;

// ---------------------------------------------------------------------
//  Admin driver: let the console load, then show a live spooler update.
// ---------------------------------------------------------------------
const ADMIN_DRIVER = `
// After the console settles, fire the kind of live event the operator
// would actually see: a job moving through the spooler.
setTimeout(() => {
  window.__demoEmit('job:spooler', { jobId: 'PP-2026-0411', status: 'Printing', position: 1 });
}, 2200);
`;

// Inline the sample images. A demo that only works behind a web server is
// a demo that does not get shown.
const assets = {
  preview: dataUri('assets/poster-preview.jpg', 'image/jpeg'),
  thumb: dataUri('assets/poster-thumb.jpg', 'image/jpeg'),
};
fs.writeFileSync(path.join(OUT, 'demo-assets.js'),
  `window.__DEMO_ASSETS = ${JSON.stringify(assets)};\n`);
console.log(`  demo-assets.js   inlined ${(
  Object.values(assets).join('').length / 1024).toFixed(0)} KB of sample imagery`);

function dataUri(rel, mime) {
  return `data:${mime};base64,` +
    fs.readFileSync(path.join(OUT, rel)).toString('base64');
}

console.log('Building demo pages from the real source:');
build('index.html', 'submitter.html', 'Submitter view', SUBMITTER_DRIVER);
build('admin.html', 'admin.html', 'Operations console', ADMIN_DRIVER);
console.log('\nOpen demo/submitter.html in a browser. No server needed.');
