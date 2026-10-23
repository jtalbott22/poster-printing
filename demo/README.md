# Demo

Two pages you can open by double-clicking. No server, no database, no Google
account, no printer.

- **`submitter.html`** — what a faculty member or student sees
- **`admin.html`** — what you and your operators see

There is a bar at the bottom of each for switching between them, which is the
easiest way to show both halves in a meeting.

## What these actually are

They are the real `webapp/public/index.html` and `admin.html`, copied verbatim,
with one script injected ahead of the page's own code that replaces `fetch` and
`io()` with canned responses. Every pixel is produced by the production markup,
CSS and JavaScript running normally.

That distinction matters: this is not a mock-up that will drift out of date. If
the demo looks wrong, the app looks wrong. Rebuild it after changing the UI and
it tracks the change:

```bash
node demo/build-demo.js
```

## What the submitter page is showing

The page is driven to the moment worth looking at — a deck uploaded and
checked:

- The **printer emulator** holds a sheet sized to the real finished aspect
  ratio, anchored at the feed slot, with the orientation badge. This is the
  part meant to answer "will it come out sideways", which people can't picture
  from numbers.
- **Verdict:** *Looks good — ready to send*, with the finished size, resolution,
  orientation and paper usage underneath.
- **47.33″ × 35.5″ at 300 DPI on the 36″ roll** — note that a 48×36 poster does
  not print 48 inches wide. The 36″ side runs *across* the roll and the long
  side feeds out. That is the geometry correction described in
  `ARCHITECTURE.md`.
- The LCD reads `36" ROLL LOADED`, fed by the same `printer:status` event the
  live app uses.
- Their own job list below, with a rejected job showing the approver's comment.

To see the failure path instead, edit `PREFLIGHT` in `demo-harness.js` — set
`severity` to `warn` and add an issue. The acknowledgement checkbox appears and
blocks submission until it is ticked.

## What the operations console is showing

A deliberately mixed queue, because a console that only ever shows the happy
path teaches nobody what trouble looks like:

- **Awaiting decision** — one pending job and one **expired** one. The expired
  row is the answer to "what if the Teams approval times out": it does not hang
  and it does not vanish, it lands here for a one-click human decision.
- **Printing and queued** — with live spooler status and the Windows job ID.
- **Recent** — printed, picked up, rejected, and one **failed** job.
- **Printers** — both PRO-4100s with all twelve ink channels. Magenta is at 12%
  and flagged red, which is what you would want to notice before somebody's
  poster comes out wrong.
- **Supplies** — one roll and one cartridge below reorder threshold, highlighted.
- **System** — database size, blob store, render queue, Power Automate outbox
  depth, and print-host heartbeat.

Clicking a thumbnail opens the job detail: full preview, preflight report,
cost, file inventory, approve/reject with comments, and the event timeline.

## Why HTML and not screenshots

Screenshots go stale silently and can't show the printer emulator reshaping
when someone switches rolls, or the queue updating live. These pages do both,
and they cost nothing to regenerate. If you need static images for a slide,
open a page and use your browser's screenshot tool — you will be capturing the
real interface rather than an artist's impression of it.

## Notes

- **Each page is a single self-contained file.** The harness, the sample
  poster, and the thumbnails are all inlined, so there is nothing to unzip and
  no folder to keep together. Open one from a download, a preview pane, an
  email attachment, or a share link and it renders the same.
- The one thing that needs both files present is the **switch-view link** in
  the bottom bar. If you have opened a single page on its own, that link has
  nothing to point at — open the other file directly instead.
- You will never see the sign-in screen. The demo is always authenticated, and
  the gate is suppressed outright rather than hidden after load, so there is no
  flash of a login box when the page is on a projector.
- Web fonts load from Google Fonts. Without internet the pages fall back to
  system fonts and look slightly different in the typography only.
- Buttons that would change state (Approve, Send to printer, Run purge) return
  success and show the toast, but nothing is stored. Reload to reset.
- Sample names, emails and poster titles are invented.
