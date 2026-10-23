# Poster Portal

Self-service large-format poster printing. Someone drops a PowerPoint on a web
page, sees immediately how it will come off the roll, submits it; an approver
gets a Teams card; the poster prints on a Canon PRO-4100 and the requester gets
a mail telling them which door to knock on.

Three pieces, installed separately:

| Piece | Runs on | What it does |
|---|---|---|
| **Portal** | Linux, Node 20 | Web app, database, file store, preflight, rendering |
| **Print agent** | Windows Server | Talks to the printer driver, watches the spooler |
| **Power Automate** | Microsoft 365 | Teams approvals, mail, SharePoint mirror |

The portal works on its own. Power Automate is optional — without it, approvals
happen in the admin console. The print agent is required if you want anything
to actually print.

---

**Want to see it before installing anything?** Open `demo/submitter.html` and
`demo/admin.html` in a browser. Each is a single self-contained file — the real
pages running on sample data, with no server, printer, account, or sign-in
step. See `demo/README.md`.

## Table of contents

1. [What you need first](#1-what-you-need-first)
2. [Portal install](#2-portal-install)
3. [The conversion toolchain](#3-the-conversion-toolchain)
4. [Google sign-in](#4-google-sign-in)
5. [Print host install](#5-print-host-install)
6. [Power Automate](#6-power-automate)
7. [First run](#7-first-run)
8. [Operations](#8-operations)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. What you need first

**Portal server** — Ubuntu 22.04 or 24.04, 4 CPU, 8 GB RAM, and storage sized
for your volume. Budget roughly 500 MB per job while it is live: the original,
plus a print raster that runs 90–400 MB depending on content and format. A
hundred active jobs is a comfortable 50 GB, and the retention job reclaims the
heavy files after thirty days.

**Print host** — Windows Server 2019 or newer, **8 GB RAM minimum, 16 GB
recommended**. This is not a soft recommendation. GDI+ decodes the raster to
roughly 4 bytes per pixel regardless of the file format, so a 151-megapixel
poster becomes about 600 MB of live bitmap before anything is sent to the
driver. It must be 64-bit — see [§5.3](#53-the-bitness-trap).

**DNS and TLS** — a hostname like `posters.kent.edu` with a certificate. Google
will not accept a plain `http://` redirect URI, so TLS is mandatory, not
hardening.

**A Canon PRO-4100** with the driver installed and a roll loaded, shared or
local on the print host.

---

## 2. Portal install

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 sqlite3

# service account and locations
sudo useradd --system --home /opt/poster-portal --shell /usr/sbin/nologin posterportal
sudo mkdir -p /opt/poster-portal /var/lib/poster-portal
sudo cp -r webapp db ops /opt/poster-portal/
sudo chown -R posterportal:posterportal /opt/poster-portal /var/lib/poster-portal

cd /opt/poster-portal/webapp
sudo -u posterportal npm ci --omit=dev
```

`better-sqlite3` and `sharp` compile native code — that is what
`build-essential` and `python3` are for. If `npm ci` fails here it is almost
always a missing compiler, not a bad package.

### 2.1 Configuration

```bash
sudo -u posterportal cp .env.example .env
sudo -u posterportal npm run mkkey -- --env     # generates the two secrets
sudo -u posterportal nano .env
sudo chmod 600 .env
```

At minimum set `PUBLIC_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`BOOTSTRAP_ADMINS`, `COOKIE_SECRET`, `FLOW_SHARED_SECRET`.

`DATA_ROOT` must be **one filesystem**. Uploads are moved into the blob store
with `rename()`, which is atomic within a filesystem and fails across a mount
boundary. If you want the blobs on a separate volume, mount the whole
`DATA_ROOT` there rather than symlinking a subdirectory into it.

### 2.2 Database

```bash
sudo -u posterportal npm run migrate
sudo -u posterportal npm run seed
```

The seed creates a print host, two locations, two printers, and the Canon ink
and roll SKUs. **It prints the print-host HMAC secret and the Flow API key
once, and never again.** Copy them somewhere before you close the terminal.

Edit `scripts/seed.js` first if your printer names or buildings differ — it is
meant to be read and adjusted, not run blind.

### 2.3 Service and proxy

```bash
sudo cp ops/poster-portal.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now poster-portal
sudo journalctl -u poster-portal -f

sudo cp ops/nginx-posters.conf /etc/nginx/sites-available/posters.kent.edu
sudo ln -s ../sites-available/posters.kent.edu /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 3. The conversion toolchain

Roughly nine in ten submissions are PowerPoints, so this section is the one
that determines whether the system is useful.

### 3.1 Install

```bash
sudo apt-get install -y \
  libreoffice-impress libreoffice-writer \
  poppler-utils \
  chromium-browser \
  fonts-liberation fonts-dejavu fonts-noto fonts-noto-cjk \
  unzip
```

Verify the paths in `.env` match reality:

```bash
which soffice pdftoppm pdfinfo chromium chromium-browser
```

### Chromium on Ubuntu 24.04

There is no `chromium` deb in 24.04's archive — `apt install chromium-browser`
installs a *transitional wrapper* at `/usr/bin/chromium-browser` that shells
out to the snap at `/snap/bin/chromium`. Both paths exist, both look right to
`which`, and both fail here, because snap confinement stops the browser
reading `/var/lib/poster-portal`. The failure surfaces as a bare
`Command failed` from `--print-to-pdf`.

This affects **HTML uploads only.** Slides, PDFs and images never touch
Chromium. Pick one:

**Option A — turn it off** (recommended unless you know you need it). HTML is
a rounding error next to PowerPoint:

```bash
echo 'FEATURE_HTML_UPLOADS=false' | sudo tee -a /opt/poster-portal/webapp/.env
sudo systemctl restart poster-portal
```

The upload form stops advertising `.html`, and the self-test stops reporting
it as a problem.

**Option B — install Google Chrome**, which ships a real deb with no
confinement:

```bash
wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
  | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
http://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update && sudo apt-get install -y google-chrome-stable
```

Then point the portal at it and restart:

```
CHROMIUM_BIN=/usr/bin/google-chrome-stable
```

Chrome is API-compatible with Chromium for the flags used here. Verify with
`sudo -u posterportal node -e "require('./src/render').selfTest()"` from
`/opt/poster-portal/webapp` — the round-trip line should turn `ok`.

**Fonts matter more than you would think.** LibreOffice substitutes silently
for anything missing, so a deck in Calibri renders in something else and the
author's careful two-column layout reflows into overlap — at 48 inches wide.
Install the font packages above, and if your college has a house typeface, drop
it in `/usr/local/share/fonts` and run `fc-cache -f`.

### 3.2 Why everything goes through PDF

```
PPTX / PPT / ODP  ──soffice──>  PDF  ──pdftoppm──>  PNG
HTML              ──chromium──>  PDF  ──pdftoppm──>  PNG
PDF               ─────────────────────pdftoppm──>  PNG
JPEG / PNG / TIFF ─────────────────────sharp─────>  PNG
```

Text and vector shapes stay resolution-independent right up to the final
rasterisation, so a slide deck rasterised at 300 DPI has genuinely sharp type
rather than upscaled screen pixels.

The tempting shortcut — screenshot the rendered slide in a headless browser —
fails at this size. A 42×36 poster is 12,600 × 10,650 pixels, past the texture
limits of most GPU-backed rendering paths, and it rasterises text at screen
resolution before the enlargement rather than after. Going through PDF avoids
both problems.

LibreOffice gets a throwaway `-env:UserInstallation` profile per conversion, so
two jobs can convert at once without fighting over a shared profile lock.

### 3.3 Check it works

```bash
cd /opt/poster-portal/webapp
sudo -u posterportal node -e "require('./src/render').selfTest()"
```

The admin console shows the same check under **System**, which is the faster
place to look later.

---

## 4. Google sign-in

Cloud Console → **APIs & Services → Credentials → Create OAuth client ID → Web
application**.

- Authorised redirect URI: `https://posters.kent.edu/auth/google/callback`
- Authorised JavaScript origin: `https://posters.kent.edu`

Put the client ID and secret in `.env`, along with `ALLOWED_DOMAINS=kent.edu`.

### The part people get wrong

The `hd=kent.edu` parameter on the authorisation URL is **a hint to Google's
account chooser, nothing more**. It changes which account is offered by
default. It does not restrict who can sign in, and a personal Gmail account
will sail straight through if that is all you check.

The portal verifies the `hd` **claim** in the returned ID token, server-side,
after JWKS signature verification, and checks the email domain alongside it.
Personal accounts have no `hd` claim at all, so they fail closed and get
bounced back with a message telling them to use their Kent account. That is the
behaviour you described wanting, and it is enforced in `src/auth.js` rather
than in the URL.

Accounts listed in `BOOTSTRAP_ADMINS` become admins on first sign-in. Everyone
else starts as a requester; promote them from the admin console.

---

## 5. Print host install

### 5.1 Prerequisites

Install **Node 20 LTS x64** from nodejs.org. Confirm:

```powershell
node -p "process.arch"          # must print x64
$PSVersionTable.PSVersion       # must be 5.1
```

### 5.2 Install

```powershell
mkdir C:\PosterPrint
# copy the printhost\ folder here
cd C:\PosterPrint
npm ci --omit=dev

copy .env.example .env
notepad .env        # PP_HOST_CODE, PP_PORTAL_URL, PP_HMAC_SECRET from the seed

.\install-service.ps1 -PrinterName "Canon PRO-4100-36"
```

The installer creates the directories, locks the `.env` ACL to the service
account, verifies the printer exists, sets `KeepPrintedJobs`, opens TCP 8443,
and registers the service with restart-on-failure.

Restrict 8443 to the portal's IP. The agent authenticates every request with
HMAC, but there is no reason for it to be reachable from anywhere else.

### 5.3 The bitness trap

`Print-Poster.ps1` refuses to run under 32-bit PowerShell, deliberately.

A 42×36 poster at 300 DPI decodes to roughly 600 MB of live bitmap. A 32-bit
process cannot address that, and the failure is a bare `OutOfMemoryException`
from deep inside `System.Drawing` with no indication that architecture is the
cause. The script checks `[Environment]::Is64BitProcess` and says so plainly
instead.

Use **Windows PowerShell 5.1**, not PowerShell 7. `System.Drawing.Printing`
needs the Windows compatibility shim under 7, and it behaves inconsistently
across builds. `PP_POWERSHELL` should point at
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` — note that
`System32` is the 64-bit path, despite the name.

### 5.4 Driver presets

The script sets a custom `PaperSize` in hundredths of an inch with `RawKind 0`,
so the page *is* the poster — no letterboxing, no wasted roll. It also sets
zero margins and draws 1:1 at the highest resolution the driver advertises.

Media type, colour mode, and cutting behaviour cannot be set through
`System.Drawing.Printing`. Configure them once as the printer's **printing
defaults** (Printer properties → Advanced → Printing Defaults — *not* the
per-user Preferences, which the service account will not see), then record the
name in the printer's `driver_preset` column for documentation.

Set the roll to **automatic cut** and match the media type to what is loaded. A
glossy preset on matte stock is the most common cause of a poster that comes
off looking washed out and gets blamed on the file.

---

## 6. Power Automate

See [`powerautomate/FLOW-SETUP.md`](powerautomate/FLOW-SETUP.md) for the two
flows and [`powerautomate/sharepoint-list.md`](powerautomate/sharepoint-list.md)
for the list schema.

Leave `FLOW_SUBMIT_URL` and `FLOW_NOTIFY_URL` empty until the flows exist. The
portal runs perfectly well without them — jobs land in the admin console and
approvers work there. Turn the flows on when you are ready.

---

## 7. First run

1. Sign in at `https://posters.kent.edu` with a `BOOTSTRAP_ADMINS` account.
2. Open `/admin` → **System**. Everything should be green; the toolchain check
   is the one that catches a bad install.
3. Submit a real 48×36 PowerPoint as a test.
4. Watch the preview appear and the printer emulator show the sheet coming off
   the roll in the right orientation.
5. Approve it from the console.
6. Watch **Printing and queued** pick up the spooler job ID within a few
   seconds. If it does not, the agent is not reachable — check
   [§9](#9-troubleshooting).

If you would rather prove the whole path before pointing it at real people,
`tests/README.md` runs 31 checks end to end against a throwaway database,
including approval callbacks and deadline escalation, without needing Google
credentials or a printer.

---

## 8. Operations

### Daily

Nothing. The console is the dashboard; the counters at the top are the whole
health picture.

### Weekly

Glance at **System → Power Automate**. A nonzero dead-letter count means Flow
has been unreachable long enough to exhaust retries, and those notifications
need a manual nudge.

### Backups

```bash
sudo cp ops/backup.sh /usr/local/bin/poster-portal-backup
sudo chmod 700 /usr/local/bin/poster-portal-backup
```

Cron it nightly. The script uses SQLite's online `.backup` rather than copying
the file, verifies the snapshot with an integrity check before keeping it, and
rsyncs the blob tree. Restore instructions are in the footer of the script.

Do not `cp` a live database in WAL mode. You get the main file without its WAL
and a database that is quietly missing recent work.

### Retention

The purge job deletes originals and print rasters after
`RETENTION_HEAVY_DAYS`, keeping metadata and thumbnails for
`RETENTION_LIGHT_DAYS`. Run it from **System → Run purge**, or on a timer.

### Spooler hygiene

`KeepPrintedJobs` is on so the agent can read final job state, and the agent
reaps records older than `PP_REAP_AFTER_HOURS`. If that reaping stops, the
spooler fills and the print service falls over — which is the failure you
described, and it is why the reaper exists rather than being left to a manual
cleanup nobody remembers.

---

## 9. Troubleshooting

**"Sign in with your Kent State account" on a Kent account.** The `hd` claim is
missing, which happens with consumer accounts on a `kent.edu` alias domain.
Check `ALLOWED_DOMAINS` and look at the `auth.rejected` event in the job log.

**`Command failed` from Chromium, but `which chromium` finds it.** It is the
snap. See [§3.1](#31-install) — `/usr/bin/chromium-browser` on Ubuntu 24.04 is
a wrapper around a confined snap that cannot read `DATA_ROOT`. Affects HTML
uploads only.

**Previews never appear on slide uploads.** LibreOffice is missing or timing
out. `journalctl -u poster-portal | grep soffice`. A first run is slow because
it builds a profile; if every run takes minutes, it is fighting for a profile
lock — confirm `RENDER_CONCURRENCY` is not higher than your CPU count.

**A poster prints smaller than requested.** Check the printer's printing
defaults for "fit to page" or a fixed paper size. The script sets an exact
custom size; a driver default that overrides it wins.

**Print job vanishes with no error.** Almost always the bitness trap in
[§5.3](#53-the-bitness-trap). Run `Print-Poster.ps1` by hand and read what it
says.

**Approvals never come back.** Check **System → Power Automate** for pending or
dead-lettered envelopes, then the flow's run history. Meanwhile approve from
the console — expired jobs surface at the top of the queue for exactly this.

**Uploads fail at around 100 MB.** `client_max_body_size` in nginx. It ships at
300m to sit above `MAX_UPLOAD_MB`, so the app returns a readable error instead
of nginx returning a bare 413.

---

## Layout

```
db/schema.sql              23 tables, 2 views, migration-versioned
webapp/
  src/
    config.js              env parsing, one place
    db.js                  pragmas, migrations, state machine, event log
    auth.js                Google OIDC, PKCE, hd-claim enforcement
    security.js            HMAC, API keys, single-use tokens, idempotency
    storage.js             content-addressed blobs, atomic writes, refcounts
    preflight.js           geometry and DPI, ~15 ms
    render.js              the conversion toolchain
    pipeline.js            background render queue
    outbox.js              durable outbound webhooks with backoff
    dispatch.js            talks to the print agent
    events.js              Socket.IO rooms
    routes/                jobs, admin, hooks, agent
  public/
    index.html             submission page and printer emulator
    admin.html             operations console
  scripts/seed.js, mkkey.js
printhost/
  agent.js                 signed endpoint, raster pull, spooler poller
  scripts/Print-Poster.ps1, Get-PosterQueue.ps1
  install-service.ps1
ops/                       nginx, systemd, backup
powerautomate/             flow setup, SharePoint list
demo/
  submitter.html           self-contained clickable demo, no server
  admin.html               same, operations console
  build-demo.js            regenerates both from the real pages
tests/
  e2e.js                   31 checks over the full lifecycle
  preflight-geometry.js    the roll-fitting and DPI maths
  mockflow.js              stands in for Power Automate
ARCHITECTURE.md            why it is shaped this way
```
