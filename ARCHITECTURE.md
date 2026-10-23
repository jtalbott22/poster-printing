# Architecture

This is the reasoning behind the shape of the system. The README tells you how
to install it; this tells you why it resists the obvious simplifications.

---

## The picture

```
   browser                portal (Linux)              print host (Windows)
  ─────────              ──────────────              ────────────────────
  upload  ──────────────> preflight  ~15 ms
          <────────────── verdict
                          ingest -> blobs/
                          enqueue preview ──> LibreOffice/Chromium/poppler
          <────────────── preview  (Socket.IO)
  submit  ──────────────> enqueue PRINT raster ─┐
                          POST envelope ────────┼──> Power Automate
                          (returns in <2s)      │         │
                                                │      Teams card
                          raster renders  <─────┘      (hours)
                                                          │
                          /hooks/approval  <───────────────┘
                          dispatch ────────────────────> agent
                                                          pulls raster (ranged)
                                                          PowerShell -> driver
                          spooler deltas <──────────────  polls Get-PrintJob
          <────────────── live queue (Socket.IO)
                          POST notify ──────────> mail + Teams
```

Four decisions carry most of the weight. Each one exists because the obvious
alternative fails in a specific, reproducible way.

---

## 1. The portal never waits on a human

**The obvious design.** Portal calls Power Automate. Flow runs the Teams
approval. Flow returns the decision as its HTTP response. One request, one
answer, easy to draw.

**Why it fails.** The response is gated on a person. People go to lunch, go
home, go on leave. No HTTP timeout in the chain covers that — not Node's, not
nginx's, and not Azure's front end, which caps a synchronous flow response at
roughly two minutes no matter what you configure. The socket dies. The portal
records a failure. Then somebody clicks Approve an hour later and the decision
has nowhere to land.

**What happens instead.** The portal POSTs a job envelope carrying a
`callbackUrl` and a single-use token, receives its `202`, and closes in under
two seconds. Flow holds the human part in its own durable state. When a
decision is made, Flow POSTs back as a fresh short request to
`/hooks/approval/:publicId`.

Three properties fall out, and they are the return on the extra hop:

- **Either side can restart.** Reboot the portal mid-approval and nothing is
  lost. The pending decision lives in Flow; the job lives in SQLite. Neither
  holds a connection a restart would break.
- **Delivery is not hope.** Outbound envelopes sit in `webhook_outbox` with
  exponential backoff and an idempotency key, so a Flow outage delays
  notifications rather than dropping them. Inbound callbacks deduplicate on
  that same key, so Flow's own retry policy cannot approve a job twice.
- **Nothing waits forever.** Every approval carries a deadline, 48 hours by
  default. On expiry the job moves to `expired` and surfaces at the top of the
  admin console for a one-click human decision.

That last point is the direct answer to "what if it times out." It does not
fail silently and it does not hang. It changes hands.

**The generalisation:** never create a promise the system cannot settle on its
own. Every await has a deadline, and every deadline has a human fallback.

---

## 2. Bytes on disk, pointers in SQLite

The question was where photos should live given Node and SQLite. SQLite can
store blobs, and for small images that is genuinely the right answer — one
file, transactional, no orphans.

It is the wrong answer here, for reasons of scale rather than taste:

- A 42×36 poster at 300 DPI is 12,600 × 10,650 pixels — **151 megapixels**.
  Measured on photographic content, the print raster runs 89 MB as JPEG and
  **407 MB as PNG**.
- SQLite's hard blob ceiling is 1 GB, and `better-sqlite3` materialises a blob
  as a single `Buffer`. Three concurrent jobs would put well over a gigabyte on
  the heap and take the process out.
- Blobs cannot be streamed or range-requested. The print agent needs a
  resumable ranged download over a campus network, and nginx needs to serve
  previews without the bytes passing through Node at all.
- Backups get unpleasant. A database that is mostly image bytes has to be
  copied whole, every night, forever.

**So:** originals are content-addressed by SHA-256 at `blobs/ab/cd/abcdef…`,
which gives free deduplication — people resubmit the same file constantly after
a rejection — with a refcount so a shared blob is not deleted while another job
still points at it. Per-job derived files live at
`renditions/<public_id>/{print.png,preview.jpg,thumb.jpg}`. SQLite holds paths,
sizes, dimensions, and hashes.

Writes are atomic: stream to `.tmp-<rand>` on the same filesystem, fsync,
rename, fsync the directory. A crash mid-upload leaves a temp file the sweeper
removes, never a half-written blob that hashes to something plausible.

The cost is that the database and the tree can drift. That is what
**Maintenance → fsck** is for: it walks `job_files` against the filesystem and
reports rows whose bytes are gone. Run it after any restore.

---

## 3. Everything becomes a PDF before it becomes pixels

```
PPTX / PPT / ODP  ──soffice──>  PDF  ──pdftoppm──>  PNG
HTML              ──chromium──>  PDF  ──pdftoppm──>  PNG
PDF               ─────────────────────pdftoppm──>  PNG
JPEG / PNG / TIFF ─────────────────────sharp─────>  PNG
```

Roughly nine in ten submissions are PowerPoints, so the fidelity of this path
is the fidelity of the product.

Keeping text and vector shapes resolution-independent until the final
rasterisation means a slide rasterised at 300 DPI has genuinely sharp type. The
tempting shortcut — render the slide in a headless browser and screenshot it —
breaks twice over: 12,600 pixels wide is past the texture limits of most
GPU-backed rendering paths, and it rasterises text at screen resolution *before*
the enlargement rather than after, which is precisely backwards.

Each LibreOffice conversion gets a throwaway `-env:UserInstallation` profile so
concurrent jobs do not deadlock on a shared profile lock.

**Preflight is deliberately separate from rendering.** It reads only metadata —
`pdfinfo`, `sharp().metadata()`, and `unzip -p ppt/presentation.xml` for the EMU
slide size at 914,400 EMU per inch — and returns in about 15 milliseconds.
That is what makes the verdict feel instant in the browser. Rasterisation is a
background queue.

The full-resolution print raster starts **at submission, in parallel with the
human approval**, not after it. Approval takes hours; rendering takes tens of
seconds. Doing them in sequence wastes the entire approval window, and
"Approve" should mean the paper starts moving.

---

## 4. Geometry: the roll constrains the short side

Three corrections to the original `poster_resize.js`, all load-bearing.

**The roll width constrains the short side, not the width.** A 48×36 landscape
poster on a 36-inch roll prints 36 inches across the roll with 48 inches feeding
out. The old logic treated the roll as a width limit and produced a 36×27 — a
poster silently shrunk by a quarter. Now the short side is fitted to the
printable width and the long side runs down the roll, whichever way the artwork
is oriented. There is a regression test for exactly this case.

**`metadata.density || DEFAULT_DPI` never fires.** sharp returns `72` for a JPEG
with no JFIF density unit, and `72` is truthy, so the fallback is dead code and
embedded density is effectively ignored. Effective DPI is now computed purely as
pixels ÷ finished inches, which is the only definition that means anything for a
poster.

**A PDF has no pixels.** Rasterising a vector page at the target DPI yields the
target DPI by definition, so reporting "300 DPI" for every PDF is true and
useless. What actually predicts a disappointing print is the **enlargement
factor**: a 13.3×7.5 slide blown up to 63×35.5 is a 4.73× enlargement, and any
photograph placed in that deck gets 4.73× softer even though the text stays
crisp. That is what gets reported.

**And the failure that actually walks in the door.** The most common fault is
not low DPI — it is a deck left at its default screen size. The content is
fine; it just scales to a 63-inch strip instead of the 48×36 the author
pictured. Preflight recognises the standard presets (13.333×7.5, 10×7.5, A4,
Letter) and names the cause with the fix:

> This looks like a PowerPoint 16:9 widescreen slide that was never resized for
> print. Filling the 36" roll makes it 63.11" × 35.5" — 63.11" of paper.
> *In PowerPoint: Design → Slide Size → Custom, set it to your finished poster
> size (48 × 36 is standard), then re-export.*

A DPI number tells someone their file is wrong. This tells them what to do.

---

## Smaller decisions worth knowing

**The `hd` parameter is not a security control.** `hd=kent.edu` on the
authorisation URL only hints to Google's account chooser. The portal verifies
the `hd` **claim** in the ID token server-side after JWKS signature
verification, alongside the email domain. Personal accounts carry no `hd` claim
and fail closed.

**The agent pulls; the portal does not push.** A 400 MB push that dies at 380 MB
has to start over. The agent fetches its own raster from a short-lived
HMAC-signed URL with Range support, so a dropped connection resumes.

**`DocumentName` is the join key.** The spooler job is named with the portal's
`doc_token` (`PP-2026-0413#1`). That is how the Windows JobId is recovered after
submission, how live queue positions map back to jobs, and how Canon Accounting
Manager rows are matched to jobs for per-job ink and paper cost.

**`KeepPrintedJobs` is on, so the reaper is mandatory.** Final job state is only
readable if completed records survive, but records that survive forever fill the
spooler and take the print service down. The agent reaps past
`PP_REAP_AFTER_HOURS`. These two settings are a pair; changing one without the
other is how the print service falls over.

**Status transitions are a table, not a convention.** `setStatus` checks an
explicit `ALLOWED` map and writes with an optimistic-concurrency `UPDATE`. A
late callback cannot move a cancelled job back to printing, and two operators
clicking Approve at once produce one transition and one no-op.

**Print format is configurable and defaults to lossless.** PNG at 407 MB versus
JPEG q95 at 89 MB for the same 151 MP poster. PNG is the honest default —
large-format line art and small type are exactly where JPEG ringing shows.
`PRINT_FORMAT=jpeg` is there for sites printing mostly photographs. Chroma
subsampling stays at 4:4:4 either way, because 4:2:0 smears coloured text edges,
which is the one artefact people genuinely notice on a poster.

---

## What was measured, not assumed

On a 1-CPU, 4 GB test box:

| Operation | Time |
|---|---|
| Preflight (any format) | 1–15 ms |
| Preview render, PPTX | 2.5–4.2 s |
| Preview render, PDF | 0.4 s |
| Full 151 MP print raster, PDF source | 15.7 s |
| Full 151 MP print raster, photographic | 26 s |

Node's RSS stayed under 110 MB throughout, because libvips does its work
outside the V8 heap. The portal is not the memory-constrained component — the
**print host is**, since GDI+ decodes to roughly 4 bytes per pixel regardless of
file format. 151 MP × 4 ≈ 600 MB of live bitmap. Hence 8 GB minimum, 16 GB
recommended, and a hard 64-bit check in `Print-Poster.ps1` that fails with an
explanation rather than a bare `OutOfMemoryException` from inside
`System.Drawing`.

---

## Deliberately not built

**No job priority queue.** Two printers and a college's worth of posters do not
need scheduling. Approve order is print order, and an operator can re-send.
Priority queues generate more arguments than throughput.

**No in-browser editing.** Cropping, colour correction, and text fixes belong in
the tool the poster was authored in. The portal's job is to tell people
precisely what is wrong and how to fix it at the source.

**No approval logic in SharePoint.** The list mirrors decisions; it does not
make them. Two systems that both believe they own the workflow will eventually
disagree in front of someone whose poster is due tomorrow.

**No camera streaming in v1.** The scaffolding is there behind
`FEATURE_CAMERAS`, and the HLS location is in the nginx config. Getting printing
correct first is worth more than watching it happen.
