-- =====================================================================
--  KSU Poster Print Portal — SQLite schema
--  Target: SQLite 3.35+ (better-sqlite3). Run with foreign_keys=ON, WAL.
--
--  DESIGN RULE: no image bytes live in this database. Every pixel is on
--  disk in the content-addressed blob store; SQLite holds only the
--  metadata, the state machine, and the audit trail. See storage.js.
-- =====================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- ---------------------------------------------------------------------
-- schema_version: bump in lockstep with db.js MIGRATIONS
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  google_sub    TEXT    UNIQUE,             -- stable Google account id
  email         TEXT    NOT NULL UNIQUE,    -- lowercased
  domain        TEXT    NOT NULL,           -- 'kent.edu' — enforced at login
  display_name  TEXT    NOT NULL DEFAULT '',
  picture_url   TEXT,
  role          TEXT    NOT NULL DEFAULT 'requester'
                CHECK (role IN ('requester','approver','operator','admin')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);

-- Server-side sessions. Cookie carries only the id; nothing else is trusted.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    PRIMARY KEY,          -- 32 random bytes, base64url
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON sessions(expires_at);

-- Short-lived OAuth state/PKCE holder (survives a portal restart mid-login).
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  return_to     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Physical plant: hosts, printers, pickup locations
-- ---------------------------------------------------------------------

-- A Windows box running the print agent. One per building, or one for all.
CREATE TABLE IF NOT EXISTS print_hosts (
  id             INTEGER PRIMARY KEY,
  code           TEXT    NOT NULL UNIQUE,   -- 'bowman-01'
  display_name   TEXT    NOT NULL,
  base_url       TEXT    NOT NULL,          -- https://print-bowman.kent.edu:8443
  api_key_hash   TEXT    NOT NULL,          -- sha256 of the shared key
  hmac_secret    TEXT    NOT NULL,          -- for request/response signing
  agent_version  TEXT,
  last_seen_at   TEXT,
  status         TEXT    NOT NULL DEFAULT 'unknown'
                 CHECK (status IN ('unknown','online','degraded','offline')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL UNIQUE,    -- 'bowman'
  display_name  TEXT    NOT NULL,           -- 'Bowman Hall'
  building      TEXT,
  room          TEXT,
  pickup_hours  TEXT,                       -- 'Mon–Fri 8:00a–5:00p'
  map_url       TEXT,
  door_photo    TEXT,                       -- rel path under /static-assets
  contact_email TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS printers (
  id                    INTEGER PRIMARY KEY,
  code                  TEXT    NOT NULL UNIQUE,   -- 'bowman-pro4100-36'
  display_name          TEXT    NOT NULL,          -- 'Bowman — Canon PRO-4100 (36")'
  print_host_id         INTEGER NOT NULL REFERENCES print_hosts(id),
  location_id           INTEGER NOT NULL REFERENCES locations(id),
  windows_printer_name  TEXT    NOT NULL,          -- exact name in Windows
  roll_width_in         REAL    NOT NULL,          -- 36 or 42
  printable_width_in    REAL    NOT NULL,          -- roll minus margins, e.g. 35.5
  max_length_in         REAL    NOT NULL DEFAULT 120,
  driver_preset         TEXT,                      -- optional saved Canon preset name
  target_dpi            INTEGER NOT NULL DEFAULT 300,
  cost_per_sq_ft_cents  INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  sort_order            INTEGER NOT NULL DEFAULT 100
);
CREATE INDEX IF NOT EXISTS ix_printers_location ON printers(location_id);

-- Live-ish state scraped from the agent / Canon Accounting Manager.
CREATE TABLE IF NOT EXISTS printer_status (
  printer_id       INTEGER PRIMARY KEY REFERENCES printers(id) ON DELETE CASCADE,
  reported_at      TEXT,
  device_state     TEXT,                    -- 'Ready','Paused','Error','Offline'
  loaded_roll_in   REAL,
  paper_remaining_ft REAL,
  ink_levels_json  TEXT,                    -- {"MBK":87,"PBK":64,...}
  queued_jobs      INTEGER NOT NULL DEFAULT 0,
  active_job_label TEXT,
  message          TEXT
);

-- Camera watching the output tray (HLS via ffmpeg).
CREATE TABLE IF NOT EXISTS cameras (
  id           INTEGER PRIMARY KEY,
  location_id  INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  printer_id   INTEGER REFERENCES printers(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  source_url   TEXT NOT NULL,               -- rtsp://... (never sent to the browser)
  hls_path     TEXT NOT NULL,               -- /hls/bowman-tray/index.m3u8
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------
-- Jobs — the core state machine
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id                 INTEGER PRIMARY KEY,
  public_id          TEXT    NOT NULL UNIQUE,   -- 'PP-2026-0413' shown to humans
  user_id            INTEGER NOT NULL REFERENCES users(id),

  -- form fields
  title              TEXT    NOT NULL,
  department         TEXT,
  advisor            TEXT,
  billing_index      TEXT,
  notes              TEXT,
  copies             INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 20),
  needed_by          TEXT,

  -- routing
  printer_id         INTEGER REFERENCES printers(id),
  location_id        INTEGER REFERENCES locations(id),
  roll_width_in      REAL    NOT NULL,

  -- geometry, resolved by preflight
  fit_mode           TEXT    NOT NULL DEFAULT 'fit_roll'
                     CHECK (fit_mode IN ('fit_roll','actual_size')),
  orientation        TEXT    CHECK (orientation IN ('portrait','landscape')),
  finished_width_in  REAL,
  finished_height_in REAL,
  print_length_in    REAL,                      -- paper consumed along the roll
  effective_dpi      INTEGER,

  -- lifecycle
  status             TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN (
                       'draft','uploaded','preflight_failed','ready','submitted',
                       'pending_approval','approved','rejected','queued','printing',
                       'printed','picked_up','failed','cancelled','expired')),
  preflight_json     TEXT,                      -- full preflight report
  preflight_severity TEXT CHECK (preflight_severity IN ('pass','warn','fail')),
  override_reason    TEXT,                      -- set when a user ships a 'warn'

  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  submitted_at       TEXT,
  decided_at         TEXT,
  queued_at          TEXT,
  printed_at         TEXT,
  picked_up_at       TEXT,
  closed_at          TEXT,

  sharepoint_item_id TEXT,                      -- mirror row in the SharePoint list
  purge_after        TEXT                       -- when heavy renditions get reaped
);
CREATE INDEX IF NOT EXISTS ix_jobs_user    ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_jobs_status  ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_jobs_printer ON jobs(printer_id, status);
CREATE INDEX IF NOT EXISTS ix_jobs_purge   ON jobs(purge_after) WHERE purge_after IS NOT NULL;

-- ---------------------------------------------------------------------
-- Files — pointers into the blob store, never bytes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blobs (
  sha256        TEXT PRIMARY KEY,             -- also the on-disk address
  byte_size     INTEGER NOT NULL,
  mime          TEXT    NOT NULL,
  rel_path      TEXT    NOT NULL,             -- 'ab/cd/abcd…'
  refcount      INTEGER NOT NULL DEFAULT 0,   -- how many job_files point here
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_blobs_refcount ON blobs(refcount) WHERE refcount = 0;

CREATE TABLE IF NOT EXISTS job_files (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  role         TEXT    NOT NULL CHECK (role IN
                 ('original','print','preview','thumb','proof_pdf')),
  sha256       TEXT    REFERENCES blobs(sha256),   -- null for per-job renditions
  rel_path     TEXT    NOT NULL,               -- relative to BLOB_ROOT
  original_name TEXT,
  mime         TEXT    NOT NULL,
  byte_size    INTEGER NOT NULL,
  width_px     INTEGER,
  height_px    INTEGER,
  density_dpi  INTEGER,
  page_count   INTEGER,
  page_index   INTEGER NOT NULL DEFAULT 1,
  is_purged    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, role, page_index)
);
CREATE INDEX IF NOT EXISTS ix_job_files_job ON job_files(job_id, role);

-- ---------------------------------------------------------------------
-- Background render pipeline (preview + print rasterization)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS render_tasks (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK (kind IN ('preview','print')),
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','done','error')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  claimed_by    TEXT,
  claimed_at    TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  error         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, kind)
);
CREATE INDEX IF NOT EXISTS ix_render_pending ON render_tasks(status, id);

-- ---------------------------------------------------------------------
-- Approvals — Teams/Power Automate round trip
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
  id                  INTEGER PRIMARY KEY,
  job_id              INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  callback_token_hash TEXT    NOT NULL,      -- sha256; single use, per job
  requested_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  deadline_at         TEXT    NOT NULL,      -- after this we escalate, we do not hang
  decided_at          TEXT,
  decision            TEXT    CHECK (decision IN ('approved','rejected')),
  decided_by          TEXT,                  -- email from Power Automate, or admin
  decided_via         TEXT    CHECK (decided_via IN ('teams','portal','auto')),
  comments            TEXT,
  flow_run_id         TEXT,
  is_current          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_approvals_job ON approvals(job_id, is_current);
CREATE INDEX IF NOT EXISTS ix_approvals_open
  ON approvals(deadline_at) WHERE decided_at IS NULL;

-- ---------------------------------------------------------------------
-- Dispatch to the Windows print host
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_dispatches (
  id               INTEGER PRIMARY KEY,
  job_id           INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  printer_id       INTEGER NOT NULL REFERENCES printers(id),
  print_host_id    INTEGER NOT NULL REFERENCES print_hosts(id),
  attempt          INTEGER NOT NULL DEFAULT 1,
  doc_token        TEXT    NOT NULL UNIQUE,  -- DocumentName in Windows: 'PP-2026-0413#1'
  host_job_id      INTEGER,                  -- Windows spooler JobId
  status           TEXT    NOT NULL DEFAULT 'sending' CHECK (status IN
                     ('sending','spooling','queued','printing','completed',
                      'paused','error','deleted','abandoned')),
  status_detail    TEXT,
  position_in_queue INTEGER,
  bytes_sent       INTEGER,
  submitted_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  first_seen_at    TEXT,
  completed_at     TEXT,
  last_polled_at   TEXT,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS ix_dispatch_job    ON print_dispatches(job_id);
CREATE INDEX IF NOT EXISTS ix_dispatch_open   ON print_dispatches(status)
  WHERE status NOT IN ('completed','deleted','abandoned');

-- ---------------------------------------------------------------------
-- Reliable outbound webhooks (portal -> Power Automate). Survives restarts.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_outbox (
  id              INTEGER PRIMARY KEY,
  job_id          INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  event           TEXT    NOT NULL,          -- 'job.submitted','job.printed',…
  url             TEXT    NOT NULL,
  payload_json    TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL UNIQUE,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT    NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_outbox_due
  ON webhook_outbox(next_attempt_at) WHERE delivered_at IS NULL;

-- Inbound replay guard (Power Automate retries on any timeout).
CREATE TABLE IF NOT EXISTS inbound_idempotency (
  key           TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Audit trail — every state change, forever
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- System-wide audit trail. job_events is per-job and its job_id is NOT
-- NULL on purpose; maintenance actions belong to no job and live here.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  actor     TEXT NOT NULL,
  kind      TEXT NOT NULL,
  message   TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_admin_log_at ON admin_log(at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  actor      TEXT    NOT NULL,               -- email, 'system', 'agent:bowman-01'
  kind       TEXT    NOT NULL,               -- 'status_change','note','error',…
  from_status TEXT,
  to_status  TEXT,
  message    TEXT,
  data_json  TEXT
);
CREATE INDEX IF NOT EXISTS ix_job_events_job ON job_events(job_id, id);

-- ---------------------------------------------------------------------
-- Consumables + cost
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplies (
  id            INTEGER PRIMARY KEY,
  sku           TEXT    NOT NULL UNIQUE,     -- 'PFI-3100MBK'
  kind          TEXT    NOT NULL CHECK (kind IN ('ink','paper','misc')),
  description   TEXT    NOT NULL,
  ink_code      TEXT,                        -- 'MBK','PBK','C','M','Y',…
  roll_width_in REAL,
  unit          TEXT    NOT NULL DEFAULT 'each',
  on_hand       REAL    NOT NULL DEFAULT 0,
  reorder_at    REAL    NOT NULL DEFAULT 1,
  unit_cost_cents INTEGER,
  powerapps_asset_id TEXT,                   -- link to the existing inventory app
  location_id   INTEGER REFERENCES locations(id),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supply_txns (
  id          INTEGER PRIMARY KEY,
  supply_id   INTEGER NOT NULL REFERENCES supplies(id) ON DELETE CASCADE,
  delta       REAL    NOT NULL,              -- -1 consumed, +3 restocked
  reason      TEXT    NOT NULL,              -- 'job','restock','count','shrink'
  job_id      INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  actor       TEXT,
  at          TEXT    NOT NULL DEFAULT (datetime('now')),
  note        TEXT
);
CREATE INDEX IF NOT EXISTS ix_supply_txns ON supply_txns(supply_id, at DESC);

-- Filled from Canon Accounting Manager export, keyed by the spooler doc token.
CREATE TABLE IF NOT EXISTS job_costs (
  job_id            INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  source            TEXT NOT NULL DEFAULT 'canon_am',
  ink_ml_json       TEXT,                    -- {"MBK":1.84,"C":0.42,…}
  ink_total_ml      REAL,
  paper_length_in   REAL,
  paper_area_sqft   REAL,
  ink_cost_cents    INTEGER,
  paper_cost_cents  INTEGER,
  total_cost_cents  INTEGER,
  imported_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Machine credentials + settings
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('agent','flow','readonly')),
  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,                 -- first 8 chars, for identification
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Convenience views
-- ---------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_job_overview AS
SELECT
  j.id, j.public_id, j.title, j.status, j.created_at, j.submitted_at,
  j.roll_width_in, j.finished_width_in, j.finished_height_in,
  j.print_length_in, j.effective_dpi, j.copies,
  u.email        AS requester_email,
  u.display_name AS requester_name,
  p.display_name AS printer_name,
  l.display_name AS pickup_location,
  a.decision, a.decided_by, a.comments AS decision_comments,
  d.status       AS spooler_status,
  d.host_job_id
FROM jobs j
JOIN users u              ON u.id = j.user_id
LEFT JOIN printers p      ON p.id = j.printer_id
LEFT JOIN locations l     ON l.id = j.location_id
LEFT JOIN approvals a     ON a.job_id = j.id AND a.is_current = 1
LEFT JOIN print_dispatches d ON d.id = (
  SELECT id FROM print_dispatches WHERE job_id = j.id ORDER BY id DESC LIMIT 1
);

CREATE VIEW IF NOT EXISTS v_printer_queue AS
SELECT
  p.id AS printer_id, p.display_name AS printer_name, p.code,
  d.id AS dispatch_id, d.status, d.host_job_id, d.submitted_at,
  j.public_id, j.title, j.print_length_in, u.email AS requester_email,
  ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY d.submitted_at) AS place_in_line
FROM print_dispatches d
JOIN printers p ON p.id = d.printer_id
JOIN jobs j     ON j.id = d.job_id
JOIN users u    ON u.id = j.user_id
WHERE d.status IN ('sending','spooling','queued','printing','paused');
