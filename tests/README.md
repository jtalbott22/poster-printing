# Tests

Two suites. Both need the portal's dependencies installed (`cd webapp && npm ci`).

## tests/e2e.js — the full lifecycle

Boots nothing itself; point it at a running portal. It forges a session
directly in the database rather than going through Google, so it can run
without OAuth credentials.

```bash
cd webapp
export DATA_ROOT=/tmp/pp-test PORT=3111 PUBLIC_URL=http://127.0.0.1:3111
export COOKIE_SECRET=$(node scripts/mkkey.js) FLOW_SHARED_SECRET=$(node scripts/mkkey.js)
export GOOGLE_CLIENT_ID=test GOOGLE_CLIENT_SECRET=test BOOTSTRAP_ADMINS=you@kent.edu
export FLOW_SUBMIT_URL=http://127.0.0.1:3222/submit
export FLOW_NOTIFY_URL=http://127.0.0.1:3222/notify

node src/db.js --migrate && node scripts/seed.js
node ../tests/mockflow.js &          # stands in for Power Automate
node src/server.js &
node ../tests/e2e.js
```

**Start from an empty database.** The suite asserts on exact counts
(`refcount=2`, one approval transition), so a second run against the same
database will fail on state left by the first. That is the test being strict,
not the system misbehaving.

31 checks across 18 steps, covering: preflight speed and geometry, roll
fitting, type rejection, blob deduplication, the submit-without-waiting
contract, envelope delivery and signing, parallel print rendering, callback
token forgery, idempotent double-approval, offline-print-host degradation,
illegal state transitions, role boundaries, and deadline escalation.

## tests/abandon.js — the abandoned-upload path

Covers what happens when someone drags a file in and never submits: the job
parks in `ready`, shows under **In progress**, and must stay both reachable
(click the row to pick it back up) and removable (Discard). Also checks that
discarding twice returns a clean 409 rather than a 500, that a printed job
cannot be discarded, and that ownership is enforced.

Run it the same way as `e2e.js`, against a server started with the same
environment. It waits for the background preview render before asserting on
thumbnail and preview URLs, because those genuinely do not exist for the
first few seconds after upload — which is also why the resume path has a
"preview still building" fallback.

## tests/preflight-geometry.js — the maths

No server needed. Prints the finished size, paper usage, effective DPI and
verdict for a set of fixtures, and regression-tests the case the original
script got wrong: a 48x36 landscape poster on a 36" roll must print 36"
across the roll with 47" feeding out, not shrink to 36x27.

Build fixtures first, or point it at your own files.
