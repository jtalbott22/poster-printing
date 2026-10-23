#!/usr/bin/env bash
# =====================================================================
#  Poster Portal backup
#
#  Install:
#    cp backup.sh /usr/local/bin/poster-portal-backup
#    chmod 700 /usr/local/bin/poster-portal-backup
#    systemd timer or cron:  15 2 * * *  /usr/local/bin/poster-portal-backup
#
#  Two very different things are being backed up:
#
#    the database   small, changes constantly, must be internally consistent
#    the blob tree  large, append-only, content-addressed
#
#  So they get two different treatments. Never `cp` a live SQLite file that
#  is in WAL mode — you get the main file without its WAL and a database
#  that is silently missing recent work. `.backup` takes a proper snapshot
#  while the app keeps running.
# =====================================================================
set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/var/lib/poster-portal}"
DB="${DB_PATH:-$DATA_ROOT/poster-portal.db}"
DEST="${BACKUP_DEST:-/backup/poster-portal}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { echo "[$(date -Is)] $*"; }
fail() { log "FAILED: $*" >&2; exit 1; }

command -v sqlite3 >/dev/null || fail "sqlite3 not installed (apt install sqlite3)"
[ -f "$DB" ] || fail "no database at $DB"
mkdir -p "$DEST/db" "$DEST/files"

# --- 1. database -----------------------------------------------------
log "snapshotting database"
SNAP="$DEST/db/poster-portal-$STAMP.db"
sqlite3 "$DB" ".backup '$SNAP'" || fail "sqlite backup failed"

# Verify before trusting it. A backup you have never opened is a rumour.
INTEG="$(sqlite3 "$SNAP" 'PRAGMA integrity_check;')"
[ "$INTEG" = "ok" ] || fail "integrity check on the snapshot returned: $INTEG"

JOBS="$(sqlite3 "$SNAP" 'SELECT COUNT(*) FROM jobs;')"
gzip -9 "$SNAP"
log "database ok — $JOBS jobs, $(du -h "$SNAP.gz" | cut -f1) compressed"

# --- 2. blob tree ----------------------------------------------------
# Content-addressed and refcounted, so files are only ever added or pruned,
# never rewritten in place. That makes a plain incremental rsync safe and
# cheap — no --delete on the originals, because a file the purge job removed
# locally may still be the only copy of something worth keeping.
log "syncing originals"
rsync -a --info=stats2 "$DATA_ROOT/blobs/" "$DEST/files/blobs/" 2>&1 | tail -3

# Renditions are reproducible from the originals, so they are not worth the
# space. If a restore needs them, the admin console can re-render in bulk.
log "skipping renditions (regenerable from originals)"

# --- 3. prune --------------------------------------------------------
log "pruning database snapshots older than $KEEP_DAYS days"
find "$DEST/db" -name 'poster-portal-*.db.gz' -mtime "+$KEEP_DAYS" -delete

# --- 4. report -------------------------------------------------------
log "done — db copies: $(find "$DEST/db" -name '*.db.gz' | wc -l), \
blob store: $(du -sh "$DEST/files/blobs" 2>/dev/null | cut -f1)"

# =====================================================================
#  RESTORE
#
#    systemctl stop poster-portal
#    gunzip -c /backup/poster-portal/db/poster-portal-YYYY....db.gz \
#      > /var/lib/poster-portal/poster-portal.db
#    rm -f /var/lib/poster-portal/poster-portal.db-wal \
#          /var/lib/poster-portal/poster-portal.db-shm
#    rsync -a /backup/poster-portal/files/blobs/ /var/lib/poster-portal/blobs/
#    chown -R posterportal:posterportal /var/lib/poster-portal
#    systemctl start poster-portal
#
#  Then in the admin console run Maintenance > fsck. It walks job_files
#  against the filesystem and reports rows whose bytes are missing, which
#  after a restore means anything uploaded between the snapshot and the
#  failure. Those jobs get flagged so you can ask people to resubmit
#  rather than discovering it at the printer.
# =====================================================================
