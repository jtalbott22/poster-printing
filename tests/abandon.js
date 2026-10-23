#!/usr/bin/env node
/* The reported bug: drag a file in, walk away, and the job is stuck in
 * "In progress" with no way to reach or remove it. */
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');
const cfg = require('../webapp/src/config');

const BASE = 'http://127.0.0.1:3113/static/posters';
const db = new Database(cfg.paths.db);
let fails = 0;
const check = (c, m) => { console.log(`   ${c ? 'PASS' : 'FAIL'} — ${m}`); if (!c) fails++; };
const step = (n, s) => console.log(`\n${n}. ${s}\n${'─'.repeat(66)}`);

db.prepare(`INSERT OR IGNORE INTO users (email,domain,display_name,role,is_active)
            VALUES ('josh@kent.edu','kent.edu','Josh','admin',1)`).run();
const uid = db.prepare(`SELECT id FROM users WHERE email='josh@kent.edu'`).get().id;
const sid = crypto.randomBytes(32).toString('base64url');
db.prepare(`INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))`)
  .run(sid, uid);
const sig = crypto.createHmac('sha256', process.env.COOKIE_SECRET)
  .update(sid).digest('base64').replace(/=+$/, '');
const COOKIE = `${cfg.auth.sessionCookie}=s%3A${sid}.${encodeURIComponent(sig)}`;

async function api(p, o = {}) {
  const r = await fetch(BASE + p, {
    ...o, headers: { Cookie: COOKIE, Accept: 'application/json', ...(o.headers || {}) },
  });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t.slice(0, 200); }
  return { status: r.status, body: b };
}
const json = (o) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const pptx = fs.readFileSync('/home/claude/fixtures/poster-48x36.pptx');
const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

(async () => {
  const o = (await api('/api/jobs/options')).body;

  step(1, 'Drag a file in, then walk away (never submit)');
  const c = await api('/api/jobs', { method: 'POST', ...json({ title: 'Abandoned poster', rollWidthIn: 36 }) });
  const pid = c.body.id;
  await api(`/api/jobs/${pid}`, { method: 'PATCH', ...json({ printerCode: o.printers[0].code }) });
  const fd = new FormData();
  fd.append('file', new Blob([pptx], { type: MIME }), 'abandoned.pptx');
  await api(`/api/jobs/${pid}/file`, { method: 'POST', body: fd });
  const st = db.prepare('SELECT status FROM jobs WHERE public_id=?').get(pid).status;
  console.log(`   ${pid} sitting at status: ${st}`);
  check(st === 'ready', 'job is parked in an active state, exactly as reported');

  // The preview renders in the background. Wait for it, the way a real user
  // does simply by taking a few seconds to read the verdict.
  for (let i = 0; i < 40; i++) {
    const t = db.prepare(`SELECT status FROM render_tasks
      WHERE job_id=(SELECT id FROM jobs WHERE public_id=?) AND kind='preview'`).get(pid);
    if (t && ['done', 'failed'].includes(t.status)) { console.log(`   preview task: ${t.status}`); break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  step(2, 'It appears in the job list with everything the UI needs');
  const list = (await api('/api/jobs')).body.jobs;
  const j = list.find(x => x.id === pid);
  console.log(`   title=${j.title} status=${j.status}`);
  console.log(`   thumb=${j.files?.thumb?.url || 'none'}`);
  console.log(`   original=${j.files?.original?.name} (${j.files?.original?.bytes} bytes)`);
  check(!!j, 'job is returned by the list endpoint');
  check(!!j.files?.thumb?.url, 'thumbnail URL present (the row renders an image)');
  check(!!j.files?.original?.name, 'original filename present (resume can rebuild the file chip)');

  step(3, 'Resume: the detail endpoint returns everything needed to refill the form');
  const d = (await api(`/api/jobs/${pid}`)).body;
  const job = d.job;
  console.log(`   printer=${job.printer?.code} roll=${job.rollWidthIn}"`);
  console.log(`   preflight severity=${job.preflight?.severity} ` +
    `finished=${job.preflight?.layout?.finishedWidthIn}x${job.preflight?.layout?.finishedHeightIn}`);
  console.log(`   preview=${job.files?.preview?.url || 'none'}`);
  check(!!job.preflight, 'preflight report included — verdict and meta can be restored');
  check(!!job.printer?.code, 'printer code included — the dropdown can be reselected');
  check(!!job.files?.preview, 'preview URL included — the printer stage can be repainted');
  check(!!job.files?.preview?.url?.startsWith('/static/posters'),
    'file URLs carry the base path, so they resolve under the sub-path mount');

  step(4, 'Discard it — the fix for the actual complaint');
  const cancel = await api(`/api/jobs/${pid}/cancel`,
    { method: 'POST', ...json({ reason: 'discarded by requester' }) });
  console.log(`   cancel -> ${cancel.status}`);
  const after = db.prepare('SELECT status FROM jobs WHERE public_id=?').get(pid).status;
  console.log(`   status now: ${after}`);
  check(cancel.status === 200, 'cancel accepted from a ready job');
  check(after === 'cancelled', 'job left the active queue');

  step(5, 'It moves to Finished, it does not vanish');
  const list2 = (await api('/api/jobs')).body.jobs;
  const j2 = list2.find(x => x.id === pid);
  const ACTIVE = ['draft','uploaded','ready','submitted','pending_approval','approved',
    'queued','printing','expired','preflight_failed'];
  console.log(`   still listed: ${!!j2}, in ACTIVE tab: ${ACTIVE.includes(j2.status)}`);
  check(!!j2 && !ACTIVE.includes(j2.status), 'gone from In progress, still visible under Finished');

  step(6, 'Discarding twice is refused, not a 500');
  const again = await api(`/api/jobs/${pid}/cancel`, { method: 'POST', ...json({}) });
  console.log(`   second cancel -> ${again.status} ${JSON.stringify(again.body).slice(0, 80)}`);
  check(again.status === 409, 'already-cancelled job returns a clean 409');

  step(7, 'A printed job cannot be discarded away');
  const c2 = await api('/api/jobs', { method: 'POST', ...json({ title: 'Printed one', rollWidthIn: 36 }) });
  const pid2 = c2.body.id;
  db.prepare(`UPDATE jobs SET status='printed' WHERE public_id=?`).run(pid2);
  const no = await api(`/api/jobs/${pid2}/cancel`, { method: 'POST', ...json({}) });
  console.log(`   cancel a printed job -> ${no.status}`);
  check(no.status === 409, 'refused — matches the UI hiding the button for printed jobs');

  step(8, "Cannot discard someone else's job");
  db.prepare(`INSERT OR IGNORE INTO users (email,domain,display_name,role,is_active)
              VALUES ('other@kent.edu','kent.edu','Other','requester',1)`).run();
  const uid2 = db.prepare(`SELECT id FROM users WHERE email='other@kent.edu'`).get().id;
  const sid2 = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))`)
    .run(sid2, uid2);
  const sig2 = crypto.createHmac('sha256', process.env.COOKIE_SECRET)
    .update(sid2).digest('base64').replace(/=+$/, '');
  const c3 = await api('/api/jobs', { method: 'POST', ...json({ title: 'Mine', rollWidthIn: 36 }) });
  const r = await fetch(`${BASE}/api/jobs/${c3.body.id}/cancel`, {
    method: 'POST',
    headers: { Cookie: `${cfg.auth.sessionCookie}=s%3A${sid2}.${encodeURIComponent(sig2)}`,
      Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log(`   other user cancelling -> ${r.status}`);
  check(r.status >= 400, 'ownership still enforced on the new path');

  console.log(`\n${'═'.repeat(66)}`);
  console.log(fails ? `${fails} check(s) failed.` : 'All checks passed.');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e.stack); process.exit(1); });
