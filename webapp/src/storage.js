'use strict';
/**
 * ============================================================================
 *  BLOB STORE
 * ============================================================================
 *  Bytes live on disk. SQLite holds pointers. This is not laziness — it is the
 *  only shape that works here:
 *
 *   • A 42" x 60" poster at 300 DPI is 12,600 x 18,000 px = 227 megapixels.
 *     As a PNG that is commonly 150-400 MB. SQLite's default max blob is
 *     1 GB *and* better-sqlite3 materialises a blob as a single Buffer, so a
 *     handful of concurrent reads would OOM the box. Files stream.
 *   • Streaming lets nginx serve the bytes (X-Accel-Redirect) and lets the
 *     print agent do a ranged, resumable download.
 *   • Backups stay sane: a 40 MB .db file you can copy every hour, plus an
 *     rsync/snapshot of a directory tree that is append-only.
 *
 *  Originals are content-addressed by SHA-256:
 *      blobs/ab/cd/abcdef0123…            (immutable, deduped, refcounted)
 *  Derived images are per-job, because they depend on the job's geometry:
 *      renditions/<public_id>/print.png
 *      renditions/<public_id>/preview.jpg
 *      renditions/<public_id>/thumb.jpg
 *
 *  Writes are atomic: stream to <target>.tmp-<rand> on the SAME filesystem,
 *  fsync, then rename(). A crash mid-upload can never leave a half file that
 *  a later hash lookup would treat as valid.
 * ============================================================================
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const config = require('./config');
const { q, now } = require('./db');

const ROOTS = [
  config.paths.blobs,
  config.paths.renditions,
  config.paths.incoming,
  config.paths.staticAssets,
];

function ensureDirs() {
  for (const d of ROOTS) fs.mkdirSync(d, { recursive: true, mode: 0o750 });
}
ensureDirs();

const relPathForHash = (sha) => path.join(sha.slice(0, 2), sha.slice(2, 4), sha);
const absBlob = (rel) => path.join(config.paths.blobs, rel);
const absRendition = (rel) => path.join(config.paths.renditions, rel);

/** Resolve a stored rel_path to an absolute path, refusing traversal. */
function resolveStored(relPath, kind = 'blob') {
  const root = kind === 'rendition' ? config.paths.renditions : config.paths.blobs;
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep)) throw new Error('path escapes storage root');
  return abs;
}

async function fsyncDir(dir) {
  // rename() is atomic but the *directory entry* isn't durable until fsync.
  let fh;
  try { fh = await fsp.open(dir, 'r'); await fh.sync(); }
  catch { /* not fatal on all filesystems */ }
  finally { if (fh) await fh.close(); }
}

/**
 * Ingest a file that multer already wrote to the incoming dir.
 * Hashes it, moves it into the content-addressed tree (or discards it if we
 * already have those exact bytes), and returns the blob row.
 */
async function ingestFile(tmpPath, { mime, byteSize }) {
  const sha = await hashFile(tmpPath);
  const rel = relPathForHash(sha);
  const dest = absBlob(rel);

  const existing = q.one('SELECT * FROM blobs WHERE sha256 = ?', sha);
  if (existing && fs.existsSync(dest)) {
    // Exact duplicate — extremely common, people resubmit the same poster.
    await fsp.unlink(tmpPath).catch(() => {});
    q.run('UPDATE blobs SET last_used_at = datetime(\'now\') WHERE sha256 = ?', sha);
    return { ...existing, deduped: true };
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o750 });
  const staging = `${dest}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  await fsp.rename(tmpPath, staging);        // same filesystem: instant
  await fsp.chmod(staging, 0o440);
  await fsp.rename(staging, dest);
  await fsyncDir(path.dirname(dest));

  q.run(
    `INSERT INTO blobs (sha256, byte_size, mime, rel_path, refcount)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(sha256) DO UPDATE SET last_used_at = datetime('now')`,
    sha, byteSize, mime, rel
  );
  return { sha256: sha, byte_size: byteSize, mime, rel_path: rel, deduped: false };
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p, { highWaterMark: 1 << 20 });
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Write a buffer/stream as a per-job rendition, atomically. */
async function writeRendition(publicId, name, source) {
  const dir = path.join(config.paths.renditions, publicId);
  await fsp.mkdir(dir, { recursive: true, mode: 0o750 });
  const dest = path.join(dir, name);
  const staging = `${dest}.tmp-${crypto.randomBytes(6).toString('hex')}`;

  if (Buffer.isBuffer(source)) {
    const fh = await fsp.open(staging, 'w', 0o640);
    try { await fh.writeFile(source); await fh.sync(); } finally { await fh.close(); }
  } else if (typeof source === 'string') {
    await fsp.rename(source, staging);       // adopt a file the renderer produced
  } else {
    await pipeline(source, fs.createWriteStream(staging, { mode: 0o640 }));
  }
  await fsp.rename(staging, dest);
  await fsyncDir(dir);

  const st = await fsp.stat(dest);
  return { relPath: path.join(publicId, name), absPath: dest, byteSize: st.size };
}

/** Record a file against a job (upsert on job+role+page). */
function recordJobFile(jobId, {
  role, relPath, sha256 = null, originalName = null, mime, byteSize,
  widthPx = null, heightPx = null, densityDpi = null, pageCount = null, pageIndex = 1,
}) {
  const tx = q.tx(() => {
    q.run(
      `INSERT INTO job_files
         (job_id, role, sha256, rel_path, original_name, mime, byte_size,
          width_px, height_px, density_dpi, page_count, page_index, is_purged)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)
       ON CONFLICT(job_id, role, page_index) DO UPDATE SET
         sha256=excluded.sha256, rel_path=excluded.rel_path, mime=excluded.mime,
         byte_size=excluded.byte_size, width_px=excluded.width_px,
         height_px=excluded.height_px, density_dpi=excluded.density_dpi,
         page_count=excluded.page_count, is_purged=0,
         created_at=datetime('now')`,
      jobId, role, sha256, relPath, originalName, mime, byteSize,
      widthPx, heightPx, densityDpi, pageCount, pageIndex
    );
    if (sha256) {
      q.run(
        `UPDATE blobs SET refcount = (
           SELECT COUNT(*) FROM job_files WHERE sha256 = ? AND is_purged = 0
         ), last_used_at = datetime('now') WHERE sha256 = ?`,
        sha256, sha256
      );
    }
  });
  tx();
  return q.one(
    'SELECT * FROM job_files WHERE job_id = ? AND role = ? AND page_index = ?',
    jobId, role, pageIndex
  );
}

function getJobFile(jobId, role, pageIndex = 1) {
  return q.one(
    `SELECT * FROM job_files
      WHERE job_id = ? AND role = ? AND page_index = ? AND is_purged = 0`,
    jobId, role, pageIndex
  );
}

/** Absolute path for a job_files row. Originals live in blobs/, the rest in renditions/. */
function absFor(fileRow) {
  return fileRow.role === 'original'
    ? resolveStored(fileRow.rel_path, 'blob')
    : resolveStored(fileRow.rel_path, 'rendition');
}

/**
 * Stream a job file to an HTTP response with Range support so the print agent
 * can resume a 300 MB download over a flaky link.
 */
function sendFile(res, fileRow, { download = null, inline = true, maxAgeSec = 0 } = {}) {
  const abs = absFor(fileRow);
  let st;
  try { st = fs.statSync(abs); }
  catch { res.status(410).json({ error: 'file_purged' }); return; }

  res.setHeader('Content-Type', fileRow.mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('ETag', `"${fileRow.sha256 || fileRow.id}-${st.size}"`);
  res.setHeader('Cache-Control',
    maxAgeSec ? `private, max-age=${maxAgeSec}` : 'private, no-store');
  if (download) {
    res.setHeader('Content-Disposition',
      `attachment; filename="${download.replace(/["\\]/g, '')}"`);
  } else if (!inline) {
    res.setHeader('Content-Disposition', 'attachment');
  }

  const range = res.req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (Number.isNaN(start) || start >= st.size) {
        res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end();
        return;
      }
      end = Math.min(end, st.size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(abs, { start, end }).pipe(res);
      return;
    }
  }
  res.setHeader('Content-Length', st.size);
  fs.createReadStream(abs).pipe(res);
}

/** Scratch path inside the data root for the render pipeline. */
async function tempDir(prefix = 'render') {
  const d = path.join(config.paths.incoming,
    `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(d, { recursive: true, mode: 0o750 });
  return d;
}
async function rmrf(p) { await fsp.rm(p, { recursive: true, force: true }).catch(() => {}); }

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------
/**
 * Delete the heavy artefacts (original + print raster) for closed jobs past
 * their purge date. Thumbs, previews and every row of metadata stay, so the
 * record of "who printed what" survives indefinitely at a few KB per job.
 */
async function purgeExpired({ dryRun = false } = {}) {
  const rows = q.all(
    `SELECT jf.id, jf.job_id, jf.role, jf.rel_path, jf.sha256, j.public_id
       FROM job_files jf JOIN jobs j ON j.id = jf.job_id
      WHERE jf.is_purged = 0
        AND jf.role IN ('original','print','proof_pdf')
        AND j.purge_after IS NOT NULL
        AND j.purge_after < datetime('now')`
  );
  let freed = 0;
  for (const r of rows) {
    const abs = absFor(r);
    try {
      const st = await fsp.stat(abs);
      if (!dryRun) await fsp.unlink(abs);
      freed += st.size;
    } catch { /* already gone */ }
    if (!dryRun) {
      q.run('UPDATE job_files SET is_purged = 1 WHERE id = ?', r.id);
      if (r.sha256) {
        q.run(
          `UPDATE blobs SET refcount = (
             SELECT COUNT(*) FROM job_files WHERE sha256 = ? AND is_purged = 0
           ) WHERE sha256 = ?`, r.sha256, r.sha256);
      }
    }
  }
  // Sweep content-addressed blobs nobody references any more.
  const orphans = q.all(
    `SELECT sha256, rel_path FROM blobs
      WHERE refcount = 0 AND last_used_at < datetime('now', '-1 day')`);
  for (const b of orphans) {
    const abs = absBlob(b.rel_path);
    try {
      const st = await fsp.stat(abs);
      if (!dryRun) { await fsp.unlink(abs); freed += st.size; }
    } catch { /* fine */ }
    if (!dryRun) q.run('DELETE FROM blobs WHERE sha256 = ?', b.sha256);
  }
  return { files: rows.length, orphanBlobs: orphans.length, bytesFreed: freed };
}

/** Verify on-disk bytes still match their address. Run weekly from cron. */
async function fsck({ limit = 500 } = {}) {
  const rows = q.all('SELECT sha256, rel_path FROM blobs ORDER BY last_used_at LIMIT ?', limit);
  const bad = [];
  for (const r of rows) {
    const abs = absBlob(r.rel_path);
    try {
      const actual = await hashFile(abs);
      if (actual !== r.sha256) bad.push({ ...r, actual, reason: 'hash_mismatch' });
    } catch (e) { bad.push({ ...r, reason: 'missing', error: e.code }); }
  }
  return { checked: rows.length, bad };
}

module.exports = {
  ensureDirs, ingestFile, hashFile, writeRendition, recordJobFile, getJobFile,
  absFor, sendFile, tempDir, rmrf, purgeExpired, fsck, resolveStored,
  relPathForHash, absBlob, absRendition,
};
