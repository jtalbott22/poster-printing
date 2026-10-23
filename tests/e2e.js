#!/usr/bin/env node
/* End-to-end against the real HTTP API, with a mock Power Automate. */
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');
const cfg = require('../webapp/src/config');

const BASE = 'http://127.0.0.1:3111';
const db = new Database(cfg.paths.db);
let fails = 0;
const check = (cond, msg) => { console.log(`   ${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) fails++; };
const step = (n, s) => console.log(`\n${n}. ${s}\n${'─'.repeat(68)}`);

function session(email, name, role) {
  db.prepare(`INSERT OR IGNORE INTO users (email,domain,display_name,role,is_active)
              VALUES (?,'kent.edu',?,?,1)`).run(email, name, role);
  db.prepare(`UPDATE users SET role=? WHERE email=?`).run(role, email);
  const uid = db.prepare(`SELECT id FROM users WHERE email=?`).get(email).id;
  const sid = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))`)
    .run(sid, uid);
  const sig = crypto.createHmac('sha256', process.env.COOKIE_SECRET)
    .update(sid).digest('base64').replace(/=+$/, '');
  return `${cfg.auth.sessionCookie}=s%3A${sid}.${encodeURIComponent(sig)}`;
}

const ADMIN = session('josh@kent.edu', 'Josh Talbott', 'admin');
const STUDENT = session('student@kent.edu', 'A Student', 'requester');

async function api(path, opts = {}, cookie = ADMIN) {
  const r = await fetch(BASE + path, {
    ...opts, headers: { Cookie: cookie, Accept: 'application/json', ...(opts.headers || {}) },
  });
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = t.slice(0, 300); }
  return { status: r.status, body };
}
const json = (o) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const pptx = fs.readFileSync('/home/claude/fixtures/poster-48x36.pptx');
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function upload(pid, buf, name, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), name);
  return api(`/api/jobs/${pid}/file`, { method: 'POST', body: fd });
}

(async () => {
  step(1, 'Session and role');
  const me = await api('/auth/me');
  console.log(`   ${me.body.email} / ${me.body.role}`);
  check(me.status === 200 && me.body.role === 'admin', 'admin session established');

  step(2, 'Options are read from the database');
  const o = (await api('/api/jobs/options')).body;
  o.printers.forEach(p => console.log(`   ${p.code}  ${p.roll_width_in}" roll, ` +
    `${p.printable_width_in}" printable, pickup ${p.building} ${p.room}`));
  check(o.printers.length === 2 && o.rollWidths.join() === '36,42', 'printers and rolls seeded');

  step(3, 'Create a draft');
  const c = await api('/api/jobs', { method: 'POST', ...json({
    title: 'Undergraduate Research Symposium 2026', rollWidthIn: 36 }) });
  const pid = c.body.id;
  console.log(`   ${c.status} ${pid}`);
  check(c.status === 201 && /^PP-\d{4}-\d{4}$/.test(pid), `public id format ${pid}`);
  // A destination is required before submit. Setting the printer also sets
  // the location and roll width from that printer's row.
  await api(`/api/jobs/${pid}`, { method: 'PATCH', ...json({
    printerCode: o.printers[0].code, department: 'Biological Sciences',
    billingIndex: 'CSH-12345', copies: 1 }) });

  step(4, 'Reject a bad roll width');
  const badRoll = await api('/api/jobs', { method: 'POST', ...json({ title: 'x', rollWidthIn: 24 }) });
  console.log(`   24" roll -> ${badRoll.status} ${JSON.stringify(badRoll.body)}`);
  check(badRoll.status === 400, 'only configured roll widths accepted');

  step(5, 'Upload a 48x36 PPTX — preflight must be fast');
  const t0 = Date.now();
  const up = await upload(pid, pptx, 'poster-48x36.pptx', PPTX_MIME);
  const ms = Date.now() - t0;
  const r = up.body.preflight;
  console.log(`   ${up.status} in ${ms}ms — verdict ${r.severity}`);
  console.log(`   finished ${r.layout.finishedWidthIn}" x ${r.layout.finishedHeightIn}" ${r.layout.orientation}`);
  console.log(`   paper    ${r.layout.printLengthIn}" of the ${r.layout.rollWidthIn}" roll (${r.layout.areaSqFt} sq ft)`);
  console.log(`   raster   ${r.raster.widthPx}x${r.raster.heightPx} = ${r.raster.megapixels}MP @ ${r.raster.effectiveDpi} DPI`);
  check(up.status === 200 && r.severity === 'pass', 'a correctly sized deck passes');
  check(Math.abs(r.layout.finishedHeightIn - 35.5) < 0.1, 'the 36" side runs ACROSS the roll');
  check(ms < 3000, `preflight returned in ${ms}ms without rendering`);

  step(6, 'Reject an executable disguised as a poster');
  const evil = await upload(pid, Buffer.from('MZ\x90\x00' + 'x'.repeat(500)), 'poster.exe',
    'application/x-msdownload');
  console.log(`   .exe -> ${evil.status} ${JSON.stringify(evil.body).slice(0, 120)}`);
  check(evil.status >= 400, 'unsupported type refused');

  step(7, 'Content addressing deduplicates a resubmitted file');
  const c2 = await api('/api/jobs', { method: 'POST', ...json({ title: 'Same deck again', rollWidthIn: 36 }) });
  await upload(c2.body.id, pptx, 'poster-48x36.pptx', PPTX_MIME);
  const blobs = db.prepare('SELECT sha256, refcount, byte_size FROM blobs').all();
  blobs.forEach(b => console.log(`   ${b.sha256.slice(0, 20)}… refcount=${b.refcount} ${b.byte_size}B`));
  check(blobs.length === 1 && blobs[0].refcount === 2, 'one blob, two references');

  step(8, 'Move to the 42" roll — geometry recomputes');
  const p2 = (await api(`/api/jobs/${pid}`, { method: 'PATCH',
    ...json({ printerCode: o.printers[1].code }) })).body.preflight;
  console.log(`   ${p2.layout.finishedWidthIn}" x ${p2.layout.finishedHeightIn}" on the ${p2.layout.rollWidthIn}" roll`);
  console.log(`   ${p2.layout.printLengthIn}" paper, ${p2.raster.effectiveDpi} DPI, verdict ${p2.severity}`);
  check(Math.abs(p2.layout.finishedHeightIn - 41.5) < 0.1, 'refits to the wider roll');
  await api(`/api/jobs/${pid}`, { method: 'PATCH', ...json({ printerCode: o.printers[0].code }) });

  step(9, 'Submit returns immediately — no waiting on a human');
  const t1 = Date.now();
  const sub = await api(`/api/jobs/${pid}/submit`, { method: 'POST', ...json({}) });
  const subMs = Date.now() - t1;
  console.log(`   ${sub.status} in ${subMs}ms -> ${sub.body.job?.status || JSON.stringify(sub.body)}`);
  check(sub.status < 300, 'submit accepted');
  check(subMs < 2000, `returned in ${subMs}ms rather than holding the connection`);
  const ap = db.prepare(`SELECT deadline_at, callback_token_hash FROM approvals
    WHERE job_id=(SELECT id FROM jobs WHERE public_id=?)`).get(pid);
  console.log(`   deadline ${ap.deadline_at}`);
  check(!!ap.deadline_at, 'an approval deadline exists — it cannot hang forever');
  check(/^[0-9a-f]{64}$/.test(ap.callback_token_hash), 'callback token stored hashed, not plaintext');

  step(10, 'Power Automate received the envelope');
  await new Promise(r => setTimeout(r, 6000));
  const caps = fs.existsSync('/tmp/flow-captured.jsonl')
    ? fs.readFileSync('/tmp/flow-captured.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  const env = caps.filter(x => x.body.jobId === pid).find(x => x.body.callbackToken);
  console.log(`   envelopes: ${caps.map(x => x.body.event).join(', ') || 'none'}`);
  check(!!env, 'submit envelope delivered to the flow');
  if (env) {
    console.log(`   callbackUrl  ${env.body.callbackUrl}`);
    console.log(`   deadline     ${env.body.deadline}`);
    console.log(`   finishedSize ${env.body.finishedSize}, dpi ${env.body.effectiveDpi}`);
    check(!!(env.headers['x-pp-signature'] || env.headers['x-pp-secret']), 'envelope is signed');
    check(!env.body.imageData && !env.body.file, 'no image bytes crossed into Flow');
  }
  const ob = db.prepare(`SELECT event, url, attempts, delivered_at, last_status, last_error
                         FROM webhook_outbox`).all();
  ob.forEach(x => console.log(`   outbox ${x.event} -> ${x.url}  attempt=${x.attempt} ` +
    `${x.delivered_at ? 'delivered ' + x.last_status : 'pending ' + (x.last_error || '')}`));
  check(ob.length > 0, 'an envelope was queued for delivery');

  step(11, 'The print raster renders during approval, not after');
  for (let i = 0; i < 60; i++) {
    const t = db.prepare(`SELECT kind,status FROM render_tasks
      WHERE job_id=(SELECT id FROM jobs WHERE public_id=?)`).all(pid);
    if (t.length && t.every(x => ['done', 'failed'].includes(x.status))) {
      console.log(`   tasks: ${t.map(x => `${x.kind}=${x.status}`).join(', ')}`); break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  const files = db.prepare(`SELECT role,byte_size,width_px,height_px,mime FROM job_files
    WHERE job_id=(SELECT id FROM jobs WHERE public_id=?)`).all(pid);
  files.forEach(f => console.log(`   ${f.role.padEnd(9)}${String(f.width_px || '-').padStart(6)}x${
    String(f.height_px || '-').padEnd(7)}${(f.byte_size / 1048576).toFixed(2)} MB  ${f.mime}`));
  const rt = db.prepare(`SELECT kind,status,attempts,error FROM render_tasks
    WHERE job_id=(SELECT id FROM jobs WHERE public_id=?)`).all(pid);
  rt.forEach(t => console.log(`   task ${t.kind}=${t.status} attempts=${t.attempts} ${
    String(t.error || '').split('\n')[0].slice(0, 90)}`));
  check(files.some(f => f.role === 'print'), 'print raster ready before anyone approved');
  check(files.some(f => f.role === 'preview'), 'preview generated');

  step(12, 'A forged callback token is refused');
  const bad = await fetch(`${BASE}/hooks/approval/${pid}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PP-Callback-Token': 'wrong-token' },
    body: JSON.stringify({ decision: 'Approve' }) });
  console.log(`   -> ${bad.status}`);
  check(bad.status === 401 || bad.status === 403, 'bad token rejected');

  step(13, 'The real callback approves, and a replay does not double-approve');
  if (!env) { console.log('   skipped — no envelope captured'); fails++; }
  const send = () => fetch(`${BASE}/hooks/approval/${pid}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PP-Callback-Token': env?.body?.callbackToken || 'none',
      'X-PP-Idempotency-Key': 'flow-run-0001' },
    body: JSON.stringify({ decision: 'Approve', approver: 'dean@kent.edu',
      comments: 'Approved', decidedAt: new Date().toISOString() }) });
  const a1 = await send(); const a2 = await send();
  console.log(`   first ${a1.status}, replay ${a2.status}`);
  const n = db.prepare(`SELECT COUNT(*) n FROM job_events
    WHERE job_id=(SELECT id FROM jobs WHERE public_id=?) AND to_status='approved'`).get(pid).n;
  console.log(`   approval transitions recorded: ${n}`);
  check(a1.status < 300, 'valid callback accepted');
  check(n === 1, 'exactly one approval despite two identical callbacks');

  step(14, 'Dispatch degrades cleanly with the agent offline');
  await new Promise(r => setTimeout(r, 3000));
  const d = db.prepare(`SELECT status,attempt,error,doc_token FROM print_dispatches
    WHERE job_id=(SELECT id FROM jobs WHERE public_id=?)`).all(pid);
  d.forEach(x => console.log(`   ${x.doc_token} ${x.status} attempt=${x.attempt} ${String(x.error || '').slice(0, 60)}`));
  const st = db.prepare('SELECT status FROM jobs WHERE public_id=?').get(pid).status;
  console.log(`   job status: ${st}`);
  check(['approved', 'queued', 'failed'].includes(st), 'job held, server still healthy');
  check((await api('/healthz')).status === 200, 'portal survived an unreachable print host');

  step(15, 'Illegal state transitions are refused by the table, not by convention');
  const ill = await api(`/api/admin/jobs/${pid}/status`, { method: 'POST', ...json({ status: 'draft' }) });
  console.log(`   ${st} -> draft : ${ill.status} ${JSON.stringify(ill.body).slice(0, 100)}`);
  check(ill.status >= 400, 'cannot rewind an approved job to draft');

  step(16, 'Authorisation boundaries');
  const s1 = await api('/api/admin/jobs', {}, STUDENT);
  console.log(`   requester -> /api/admin/jobs        ${s1.status}`);
  check(s1.status === 403, 'admin API closed to requesters');
  const s2 = await api(`/api/jobs/${pid}/file/print`, {}, STUDENT);
  console.log(`   requester -> another user's raster  ${s2.status}`);
  check(s2.status >= 400, "cannot read someone else's print file");
  const s3 = await api(`/api/jobs/${pid}`, {}, STUDENT);
  console.log(`   requester -> another user's job     ${s3.status}`);
  check(s3.status >= 400, "cannot read someone else's job");

  step(17, 'Admin console endpoints');
  const q = await api('/api/admin/jobs?limit=50');
  console.log(`   ${q.body.jobs.length} jobs — ${JSON.stringify(q.body.counts)}`);
  const h = await api('/api/admin/health');
  console.log(`   db ${h.body.db.sizeMb}MB · blobs ${h.body.storage.blobs} · outbox pending ${h.body.outbox.pending}`);
  const pr = await api('/api/admin/printers');
  console.log(`   printers ${pr.body.printers.length}, hosts ${pr.body.hosts.length}`);
  check(q.status === 200 && h.status === 200 && pr.status === 200, 'console data loads');

  step(18, 'Expired approvals escalate instead of hanging');
  const c3 = await api('/api/jobs', { method: 'POST', ...json({ title: 'Nobody will approve this', rollWidthIn: 36 }) });
  await api(`/api/jobs/${c3.body.id}`, { method: 'PATCH', ...json({ printerCode: o.printers[0].code }) });
  await upload(c3.body.id, pptx, 'p.pptx', PPTX_MIME);
  await api(`/api/jobs/${c3.body.id}/submit`, { method: 'POST', ...json({}) });
  db.prepare(`UPDATE approvals SET deadline_at = datetime('now','-1 hour')
              WHERE job_id=(SELECT id FROM jobs WHERE public_id=?)`).run(c3.body.id);
  const swept = await api('/api/admin/maintenance/sweep', { method: 'POST', ...json({}) });
  console.log(`   sweep -> ${swept.status} ${JSON.stringify(swept.body).slice(0, 120)}`);
  const s = db.prepare('SELECT status FROM jobs WHERE public_id=?').get(c3.body.id).status;
  console.log(`   job is now: ${s}`);
  check(s === 'expired' && swept.status === 200, 'past-deadline job escalated for a human');

  console.log(`\n${'═'.repeat(68)}`);
  console.log(fails ? `${fails} check(s) failed.` : 'All checks passed.');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('\nTEST ERROR:', e.stack); process.exit(1); });
