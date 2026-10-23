/* =====================================================================
 *  Demo harness — makes the REAL index.html and admin.html run with no
 *  server, no database, and no Google account.
 *
 *  It replaces window.fetch and window.io before the page's own script
 *  runs, so what you are looking at is the actual production markup,
 *  CSS and JavaScript. Nothing here is a mock-up of the interface; it is
 *  the interface, fed canned data.
 *
 *  Everything below this line is fixture data. If a screen looks wrong
 *  in the demo, it will look wrong in production too.
 * ===================================================================== */
(function () {
  'use strict';

  // Images are inlined as data URIs by build-demo.js so the demo works from
  // a file:// URL by double-clicking. Browsers block fetch() and some img
  // loads on file://, which would otherwise leave the poster blank in
  // exactly the situation the demo is most likely to be used: someone
  // opening it on a laptop in a meeting room with no server running.
  const A = window.__DEMO_ASSETS || {};
  const PREVIEW = A.preview || 'assets/poster-preview.jpg';
  const THUMB = A.thumb || 'assets/poster-thumb.jpg';

  // ------------------------------------------------------------------
  //  Fixtures
  // ------------------------------------------------------------------
  const USER = {
    email: 'jtalbott@kent.edu', name: 'Josh Talbott', role: 'admin', picture: null,
  };

  const PRINTERS = [
    {
      code: 'bowman-pro4100-36', display_name: 'Bowman — Canon PRO-4100 (36" roll)',
      roll_width_in: 36, printable_width_in: 35.5, max_length_in: 120, target_dpi: 300,
      location_code: 'bowman', location_name: 'Bowman Hall', building: 'Bowman Hall',
      room: '108', pickup_hours: 'Mon–Fri 8:00a–5:00p',
      device_state: 'Normal', queued_jobs: 1,
    },
    {
      code: 'bowman-pro4100-42', display_name: 'Bowman — Canon PRO-4100 (42" roll)',
      roll_width_in: 42, printable_width_in: 41.5, max_length_in: 120, target_dpi: 300,
      location_code: 'bowman', location_name: 'Bowman Hall', building: 'Bowman Hall',
      room: '108', pickup_hours: 'Mon–Fri 8:00a–5:00p',
      device_state: 'Normal', queued_jobs: 0,
    },
  ];

  const OPTIONS = {
    user: USER,
    printers: PRINTERS,
    rollWidths: [36, 42],
    acceptingJobs: true,
    banner: '',
    limits: {
      minDpi: 150, warnDpi: 200, targetDpi: 300, maxUploadMb: 250, maxLengthIn: 120,
      accepts: ['.pdf', '.pptx', '.ppt', '.odp', '.png', '.jpg', '.jpeg',
        '.tif', '.tiff', '.webp', '.html', '.htm'],
    },
  };

  // The preflight report for the demo upload: a 48x36 deck on the 36" roll.
  const PREFLIGHT = {
    severity: 'pass',
    source: { kind: 'office', pages: 1, nativeWidthIn: 48, nativeHeightIn: 36 },
    layout: {
      finishedWidthIn: 47.33, finishedHeightIn: 35.5, rollWidthIn: 36,
      printableWidthIn: 35.5, acrossRollIn: 35.5, printLengthIn: 47.33,
      areaSqFt: 11.67, orientation: 'landscape', fitMode: 'fit_roll',
    },
    raster: {
      widthPx: 14199, heightPx: 10650, megapixels: 151.22, targetDpi: 300,
      effectiveDpi: 300, enlargement: 0.99, estimatedPrintBytes: 136314880,
    },
    issues: [],
  };

  const JOBS = [
    {
      id: 'PP-2026-0413', title: 'Thermal Tolerance in Lake Erie Fish Populations',
      status: 'pending_approval', finishedWidthIn: 47.33, finishedHeightIn: 35.5,
      location: { display_name: 'Bowman Hall 108', pickup_hours: 'Mon–Fri 8:00a–5:00p' },
      files: { thumb: { url: THUMB } },
    },
    {
      // An abandoned upload: dragged in, never submitted. Before the fix this
      // row was inert — no way to reopen it, no way to get rid of it.
      id: 'PP-2026-0417', title: 'Wetland Sediment Cores (draft)',
      status: 'ready', finishedWidthIn: 47.33, finishedHeightIn: 35.5,
      location: { display_name: 'Bowman Hall 108' },
      files: { thumb: { url: THUMB }, original: { name: 'sediment_draft.pptx', bytes: 18244096 } },
    },
    {
      id: 'PP-2026-0411', title: 'Polymer Blends for Additive Manufacturing',
      status: 'printing', finishedWidthIn: 47.33, finishedHeightIn: 35.5,
      location: { display_name: 'Bowman Hall 108', pickup_hours: 'Mon–Fri 8:00a–5:00p' },
      files: { thumb: { url: THUMB } },
    },
    {
      id: 'PP-2026-0402', title: 'Ceramic Microstructure Under Cyclic Load',
      status: 'printed', finishedWidthIn: 41.5, finishedHeightIn: 31.1,
      location: { display_name: 'Bowman Hall 108', pickup_hours: 'Mon–Fri 8:00a–5:00p' },
      files: { thumb: { url: THUMB } },
    },
    {
      id: 'PP-2026-0388', title: 'First-Year Retention in Gateway Mathematics',
      status: 'rejected', finishedWidthIn: 63.11, finishedHeightIn: 35.5,
      approval: { comments: 'This is a 16:9 slide stretched to 63 inches. Set the slide size to 48x36 and resend.' },
      location: { display_name: 'Bowman Hall 108' },
      files: { thumb: { url: THUMB } },
    },
  ];

  // Admin queue. Deliberately includes an expired job and a failed one,
  // because a console that only ever shows the happy path teaches nobody
  // what the failure states look like.
  const ADMIN_JOBS = [
    {
      public_id: 'PP-2026-0413', title: 'Thermal Tolerance in Lake Erie Fish Populations',
      requester_email: 'mrivera@kent.edu', status: 'pending_approval',
      finished_width_in: 47.33, finished_height_in: 35.5, effective_dpi: 300, copies: 1,
      printer_name: 'Bowman — Canon PRO-4100 (36" roll)', pickup_location: 'Bowman Hall 108',
      thumbUrl: THUMB, spooler_status: null, host_job_id: null,
    },
    {
      public_id: 'PP-2026-0415', title: 'Riparian Buffer Widths and Nitrate Load',
      requester_email: 'dchen@kent.edu', status: 'expired',
      finished_width_in: 41.5, finished_height_in: 31.1, effective_dpi: 268, copies: 1,
      printer_name: 'Bowman — Canon PRO-4100 (42" roll)', pickup_location: 'Bowman Hall 108',
      thumbUrl: THUMB,
    },
    {
      public_id: 'PP-2026-0411', title: 'Polymer Blends for Additive Manufacturing',
      requester_email: 'jokafor@kent.edu', status: 'printing',
      finished_width_in: 47.33, finished_height_in: 35.5, effective_dpi: 300, copies: 1,
      printer_name: 'Bowman — Canon PRO-4100 (36" roll)', pickup_location: 'Bowman Hall 108',
      thumbUrl: THUMB, spooler_status: 'Printing', host_job_id: 47,
    },
    {
      public_id: 'PP-2026-0412', title: 'Latinx Student Belonging: A Mixed-Methods Study',
      requester_email: 'agarcia@kent.edu', status: 'queued',
      finished_width_in: 35.5, finished_height_in: 47.33, effective_dpi: 300, copies: 2,
      printer_name: 'Bowman — Canon PRO-4100 (36" roll)', pickup_location: 'Bowman Hall 108',
      thumbUrl: THUMB, spooler_status: 'Spooling', host_job_id: 48,
    },
    {
      public_id: 'PP-2026-0402', title: 'Ceramic Microstructure Under Cyclic Load',
      requester_email: 'kpatel@kent.edu', status: 'printed',
      finished_width_in: 41.5, finished_height_in: 31.1, effective_dpi: 300, copies: 1,
      printer_name: 'Bowman — Canon PRO-4100 (42" roll)', pickup_location: 'Bowman Hall 108',
      thumbUrl: THUMB,
    },
    {
      public_id: 'PP-2026-0399', title: 'Acoustic Monitoring of Bat Roosts',
      requester_email: 'twhite@kent.edu', status: 'failed',
      finished_width_in: 47.33, finished_height_in: 35.5, effective_dpi: 300, copies: 1,
      printer_name: 'Bowman — Canon PRO-4100 (36" roll)', pickup_location: 'Bowman Hall 108',
      thumbUrl: THUMB, spooler_status: 'Error — out of paper',
    },
    {
      public_id: 'PP-2026-0388', title: 'First-Year Retention in Gateway Mathematics',
      requester_email: 'lnguyen@kent.edu', status: 'rejected',
      finished_width_in: 63.11, finished_height_in: 35.5, effective_dpi: 300, copies: 1,
      printer_name: 'Bowman — Canon PRO-4100 (36" roll)', pickup_location: 'Bowman Hall 108',
      thumbUrl: THUMB,
    },
    {
      public_id: 'PP-2026-0381', title: 'Groundwater Recharge in Glaciated Terrain',
      requester_email: 'rsalim@kent.edu', status: 'picked_up',
      finished_width_in: 47.33, finished_height_in: 35.5, effective_dpi: 291, copies: 1,
      printer_name: 'Bowman — Canon PRO-4100 (36" roll)', pickup_location: 'Bowman Hall 108',
      thumbUrl: THUMB,
    },
  ];

  const COUNTS = ADMIN_JOBS.reduce((a, j) => (a[j.status] = (a[j.status] || 0) + 1, a), {});

  const ADMIN_PRINTERS = {
    printers: [
      {
        id: 1, code: 'bowman-pro4100-36', display_name: 'Bowman — Canon PRO-4100 (36" roll)',
        windows_printer_name: 'Canon PRO-4100-36', roll_width_in: 36,
        host_status: 'online', device_state: 'Printing',
        reported_at: iso(-25), ink_levels_json: JSON.stringify({
          MBK: 62, PBK: 58, C: 41, M: 12, Y: 47, PC: 55, PM: 60, GY: 71, PGY: 66, R: 38, B: 44, CO: 52,
        }),
      },
      {
        id: 2, code: 'bowman-pro4100-42', display_name: 'Bowman — Canon PRO-4100 (42" roll)',
        windows_printer_name: 'Canon PRO-4100-42', roll_width_in: 42,
        host_status: 'online', device_state: 'Normal',
        reported_at: iso(-31), ink_levels_json: JSON.stringify({
          MBK: 88, PBK: 79, C: 66, M: 70, Y: 64, PC: 72, PM: 68, GY: 83, PGY: 77, R: 59, B: 62, CO: 74,
        }),
      },
    ],
    hosts: [
      { code: 'bowman-01', status: 'online', is_active: 1, last_seen_at: iso(-8), agent_version: '1.0.0' },
    ],
    queue: [
      { printer_id: 1, place_in_line: 1, public_id: 'PP-2026-0411', status: 'printing' },
      { printer_id: 1, place_in_line: 2, public_id: 'PP-2026-0412', status: 'queued' },
    ],
  };

  const SUPPLIES = {
    supplies: [
      { sku: 'PFI-3100MBK', description: 'Canon PFI-3100 Matte Black 160ml', on_hand: 4, reorder_at: 2 },
      { sku: 'PFI-3100M', description: 'Canon PFI-3100 Magenta 160ml', on_hand: 1, reorder_at: 2 },
      { sku: 'PFI-3100C', description: 'Canon PFI-3100 Cyan 160ml', on_hand: 3, reorder_at: 2 },
      { sku: 'ROLL-36-SATIN', description: 'Satin photo roll, 36" x 100ft', on_hand: 5, reorder_at: 2 },
      { sku: 'ROLL-42-SATIN', description: 'Satin photo roll, 42" x 100ft', on_hand: 2, reorder_at: 2 },
    ],
  };

  const HEALTH = {
    db: { sizeMb: 18.4, path: '/var/lib/poster-portal/poster-portal.db' },
    storage: { blobs: 214, bytes: 9_182_547_968, orphans: 3 },
    renderQueue: [{ n: 1, kind: 'print', status: 'running' }],
    outbox: { pending: 0, deadLettered: 0 },
    hosts: [{ code: 'bowman-01', status: 'online', last_seen_at: iso(-8), agent_version: '1.0.0' }],
    toolchain: {
      LibreOffice: { ok: true, version: 'LibreOffice 24.2.7.2' },
      pdftoppm: { ok: true, version: 'pdftoppm version 24.02.0' },
      pdfinfo: { ok: true, version: 'pdfinfo version 24.02.0' },
      Chromium: { ok: true, version: 'Chromium 126.0.6478.126' },
      unzip: { ok: true, version: 'UnZip 6.00' },
    },
  };

  const JOB_DETAIL = {
    job: {
      public_id: 'PP-2026-0413', title: 'Thermal Tolerance in Lake Erie Fish Populations',
      requester_name: 'Maria Rivera', requester_email: 'mrivera@kent.edu',
      status: 'pending_approval', finished_width_in: 47.33, finished_height_in: 35.5,
      print_length_in: 47.33, roll_width_in: 36, orientation: 'landscape',
      effective_dpi: 300, printer_name: 'Bowman — Canon PRO-4100 (36" roll)',
      pickup_location: 'Bowman Hall 108', billing_index: 'CSH-40218',
    },
    preflight: PREFLIGHT,
    cost: { total_cost_cents: 1284, ink_total_ml: 6.42 },
    files: [
      { role: 'original', byte_size: 24_117_248, is_purged: 0 },
      { role: 'print', byte_size: 118_489_088, is_purged: 0 },
      { role: 'preview', byte_size: 214_016, is_purged: 0 },
      { role: 'thumb', byte_size: 24_576, is_purged: 0 },
    ],
    events: [
      { kind: 'status_change', to_status: 'pending_approval', actor: 'system', at: iso(-1800), message: 'Waiting on approval — deadline in 47 hours' },
      { kind: 'status_change', to_status: 'submitted', actor: 'mrivera@kent.edu', at: iso(-1802) },
      { kind: 'render', to_status: null, actor: 'system', at: iso(-1795), message: 'Print raster ready: 14199x10650 (151.2 MP) in 24.8s' },
      { kind: 'status_change', to_status: 'ready', actor: 'system', at: iso(-1860), message: 'Preflight passed at 300 DPI' },
      { kind: 'created', to_status: null, actor: 'mrivera@kent.edu', at: iso(-1900) },
    ],
  };

  function iso(secondsAgo) {
    return new Date(Date.now() + secondsAgo * 1000).toISOString().slice(0, 19).replace('T', ' ');
  }

  // ------------------------------------------------------------------
  //  Fake API
  // ------------------------------------------------------------------
  const ROUTES = [
    [/^\/auth\/me$/, () => USER],
    [/^\/api\/jobs\/options$/, () => OPTIONS],
    [/^\/api\/jobs$/, (m, opts) => opts.method === 'POST'
      ? { id: 'PP-2026-0416' } : { jobs: JOBS }],
    [/^\/api\/jobs\/[^/]+\/file$/, () => ({
      job: { public_id: 'PP-2026-0416', status: 'ready' },
      preflight: PREFLIGHT, deduped: false,
    })],
    [/^\/api\/jobs\/[^/]+\/submit$/, () => ({
      job: { public_id: 'PP-2026-0416', status: 'pending_approval' },
    })],
    [/^\/api\/jobs\/[^/]+$/, () => ({
      job: { public_id: 'PP-2026-0416', status: 'ready' }, preflight: PREFLIGHT,
    })],
    [/^\/api\/admin\/jobs\/[^/]+$/, () => JOB_DETAIL],
    [/^\/api\/admin\/jobs/, () => ({ jobs: ADMIN_JOBS, counts: COUNTS })],
    [/^\/api\/admin\/printers$/, () => ADMIN_PRINTERS],
    [/^\/api\/admin\/supplies$/, () => SUPPLIES],
    [/^\/api\/admin\/health$/, () => HEALTH],
    [/^\/api\/admin\/.*\/decide$/, () => ({ ok: true, detail: 'Approved — sending to Bowman 36"' })],
    [/^\/api\/admin\/.*\/print$/, () => ({ ok: true, detail: 'Sent to Bowman 36"' })],
    [/^\/api\/admin\//, () => ({ ok: true, expired: 0, requeued: 0, bytesFreed: 0, files: 0 })],
  ];

  // Guard: some embedded/older runtimes have no fetch at all, and the demo
  // should still render its canned data rather than dying on line one.
  const realFetch = typeof window.fetch === 'function'
    ? window.fetch.bind(window)
    : () => Promise.reject(new Error('no network'));
  const Res = typeof Response === 'function' ? Response : null;
  const reply = (body, status = 200) => Res
    ? Promise.resolve(new Res(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' } }))
    : Promise.resolve({ ok: status < 300, status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)) });
  window.fetch = function (input, opts = {}) {
    const url = typeof input === 'string' ? input : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];

    // Local assets (the preview image, fonts) still load for real.
    if (!path.startsWith('/api') && !path.startsWith('/auth') && !path.startsWith('/hooks')) {
      return realFetch(input, opts);
    }
    for (const [re, handler] of ROUTES) {
      if (re.test(path)) {
        return reply(handler(path.match(re), opts));
      }
    }
    return reply({ error: 'not_found' }, 404);
  };

  // ------------------------------------------------------------------
  //  Fake Socket.IO — quiet by default. The demo driver fires events.
  // ------------------------------------------------------------------
  const handlers = {};
  window.io = function () {
    const sock = {
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
      emit() { return sock; },
      off() { return sock; },
      disconnect() { return sock; },
    };
    setTimeout(() => (handlers.connect || []).forEach(f => f()), 60);
    return sock;
  };
  window.__demoEmit = (ev, data) => (handlers[ev] || []).forEach(f => f(data));

  // Image endpoints resolve to the sample poster so <img src> works.
  window.__demoPreview = PREVIEW;
  window.__demoThumb = THUMB;

  // Rewrite any server image URL to the local sample as the DOM is built.
  function rewrite(img) {
    const s = img.getAttribute('src') || '';
    if (/\/file\/thumb/.test(s)) { if (img.src !== THUMB) img.src = THUMB; }
    else if (/\/file\/(preview|print|original)/.test(s)) { if (img.src !== PREVIEW) img.src = PREVIEW; }
  }
  new MutationObserver((muts) => {
    for (const mut of muts) {
      // An <img> already on the page having its src swapped — this is how the
      // preview arrives after rendering — needs catching as well as new nodes.
      if (mut.type === 'attributes' && mut.target.tagName === 'IMG') rewrite(mut.target);
      for (const node of mut.addedNodes || []) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') rewrite(node);
        node.querySelectorAll?.('img').forEach(rewrite);
      }
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
  });

  // The demo is always signed in, so the gate should never appear — not even
  // for the instant between first paint and boot() resolving. Injected as CSS
  // rather than set after load, because a flash of a login screen is exactly
  // the thing someone notices when you put this on a projector.
  const hideGate = document.createElement('style');
  hideGate.textContent = '#gate{display:none !important}';
  (document.head || document.documentElement).appendChild(hideGate);

  console.log('[demo] API and socket stubbed — the page code is otherwise untouched');
})();
