'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });

const db = new Database(config.paths.db);

// --- Pragmas that matter for a small multi-writer app -------------------
// WAL: readers never block the writer. Essential — the agent poller, the
// render worker and web requests all write.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');   // WAL + NORMAL is durable across app crash
db.pragma('busy_timeout = 5000');    // wait rather than throw SQLITE_BUSY
db.pragma('wal_autocheckpoint = 1000');

// ---------------------------------------------------------------------
// Migrations. Version N is applied only if schema_version < N.
// Add new entries; never edit an applied one.
// ---------------------------------------------------------------------
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    up(d) {
      const sql = fs.readFileSync(
        path.join(__dirname, '..', '..', 'db', 'schema.sql'),
        'utf8'
      );
      // strip PRAGMAs — already set on the live connection
      d.exec(sql.replace(/^\s*PRAGMA[^;]+;\s*$/gim, ''));
    },
  },
  {
    version: 2,
    name: 'default settings',
    up(d) {
      const ins = d.prepare(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
      );
      ins.run('portal.accepting_jobs', 'true');
      ins.run('portal.banner', '');
      ins.run('approval.auto_approve_under_sqft', '0');
    },
  },
  {
    version: 3,
    name: 'admin audit log',
    up(d) {
      // job_events.job_id is NOT NULL by design — it is a per-job timeline.
      // Maintenance actions (purge, sweep, outbox retry) belong to nobody's
      // job, so they need their own table rather than a nullable column that
      // would weaken the foreign key for every real event.
      d.exec(`
        CREATE TABLE IF NOT EXISTS admin_log (
          id      INTEGER PRIMARY KEY,
          at      TEXT NOT NULL DEFAULT (datetime('now')),
          actor   TEXT NOT NULL,
          kind    TEXT NOT NULL,
          message TEXT,
          data_json TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_admin_log_at ON admin_log(at DESC);
      `);
    },
  },
];

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  const current =
    db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    });
    run();
    console.log(`[db] migrated to v${m.version} — ${m.name}`);
  }
}

// ---------------------------------------------------------------------
// Tiny helpers used everywhere
// ---------------------------------------------------------------------
const q = {
  one: (sql, ...args) => db.prepare(sql).get(...args),
  all: (sql, ...args) => db.prepare(sql).all(...args),
  run: (sql, ...args) => db.prepare(sql).run(...args),
  tx: (fn) => db.transaction(fn),
};

/** ISO-8601 UTC string that matches SQLite's datetime('now') format. */
function now(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

/** Append to the audit trail. Every status change goes through here. */
function logEvent({ jobId, actor = 'system', kind, from = null, to = null, message = null, data = null }) {
  // An event with no job is a system action — purge, sweep, outbox retry.
  // Those go to admin_log; job_events keeps its NOT NULL foreign key so a
  // deleted job takes its own timeline with it.
  if (jobId == null) {
    q.run(
      `INSERT INTO admin_log (actor, kind, message, data_json) VALUES (?, ?, ?, ?)`,
      actor, kind, message, data ? JSON.stringify(data) : null
    );
    return;
  }
  q.run(
    `INSERT INTO job_events (job_id, actor, kind, from_status, to_status, message, data_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    jobId, actor, kind, from, to, message, data ? JSON.stringify(data) : null
  );
}

/**
 * Move a job to a new status, guarding against illegal transitions and
 * against two workers racing on the same row.
 */
const ALLOWED = {
  draft:            ['uploaded', 'cancelled'],
  uploaded:         ['ready', 'preflight_failed', 'cancelled'],
  preflight_failed: ['uploaded', 'ready', 'cancelled'],
  ready:            ['submitted', 'uploaded', 'cancelled'],
  submitted:        ['pending_approval', 'approved', 'failed', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'expired', 'cancelled'],
  approved:         ['queued', 'failed', 'cancelled'],
  rejected:         ['cancelled', 'ready'],
  expired:          ['approved', 'rejected', 'cancelled'],
  queued:           ['printing', 'failed', 'cancelled', 'printed'],
  printing:         ['printed', 'failed', 'cancelled'],
  printed:          ['picked_up', 'failed'],
  picked_up:        [],
  failed:           ['queued', 'cancelled'],
  cancelled:        [],
};

function setStatus(jobId, to, { actor = 'system', message = null, data = null, extra = {} } = {}) {
  const job = q.one('SELECT id, status FROM jobs WHERE id = ?', jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (job.status === to) return job.status;
  const legal = ALLOWED[job.status] || [];
  if (!legal.includes(to)) {
    throw Object.assign(
      new Error(`illegal transition ${job.status} -> ${to} for job ${jobId}`),
      { code: 'ILLEGAL_TRANSITION', from: job.status, to }
    );
  }

  const sets = ['status = ?'];
  const vals = [to];
  const stamp = {
    submitted: 'submitted_at',
    approved: 'decided_at',
    rejected: 'decided_at',
    queued: 'queued_at',
    printed: 'printed_at',
    picked_up: 'picked_up_at',
  }[to];
  if (stamp) { sets.push(`${stamp} = datetime('now')`); }
  if (['printed', 'picked_up', 'cancelled', 'rejected', 'failed'].includes(to)) {
    sets.push(`closed_at = COALESCE(closed_at, datetime('now'))`);
    sets.push(`purge_after = datetime('now', '+${config.retention.heavyDays} days')`);
  }
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); vals.push(v); }
  vals.push(jobId, job.status);

  const res = q.run(
    `UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
    ...vals
  );
  if (res.changes === 0) {
    // Someone else moved it first. Re-read and let the caller decide.
    return q.one('SELECT status FROM jobs WHERE id = ?', jobId).status;
  }
  logEvent({ jobId, actor, kind: 'status_change', from: job.status, to, message, data });
  return to;
}

module.exports = { db, q, migrate, now, logEvent, setStatus, ALLOWED };

if (require.main === module && process.argv.includes('--migrate')) {
  migrate();
  console.log('[db] up to date at', config.paths.db);
}
