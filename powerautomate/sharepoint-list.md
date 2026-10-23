# SharePoint list — Poster Print Requests

The portal's SQLite database is the system of record. This list is a mirror,
so that people who live in SharePoint can see and report on jobs without an
account on the portal, and so there is a record that outlives the app.

**Nothing here should ever be edited by hand.** Flow writes it; the portal
owns the truth. If the two disagree, the portal is right.

## Create the list

Site contents → New → List → Blank list, named `Poster Print Requests`.

Then add these columns. `Title` already exists — rename it to `Job ID`.

| Column | Type | Settings |
|---|---|---|
| Job ID | Single line of text | Required, enforce unique values |
| Poster title | Single line of text | Required |
| Requester | Person or Group | Show: Name with picture |
| Requester email | Single line of text | |
| Department | Single line of text | |
| Status | Choice | `Submitted, Pending approval, Approved, Rejected, Queued, Printing, Printed, Picked up, Failed, Cancelled, Expired` — default `Submitted` |
| Finished size | Single line of text | e.g. `48" x 36"` |
| Paper used (in) | Number | 2 decimals |
| Copies | Number | Integer, default 1 |
| Resolution (DPI) | Number | Integer |
| Preflight | Choice | `pass, warn, fail` |
| Printer | Single line of text | |
| Pickup location | Single line of text | |
| Billing index | Single line of text | |
| Estimated cost | Currency | USD |
| Actual cost | Currency | USD — filled from the Canon Accounting Manager import |
| Ink used (ml) | Number | 2 decimals, from the same import |
| Approver | Person or Group | |
| Approver comments | Multiple lines of text | Plain text |
| Submitted | Date and Time | Include time |
| Decided | Date and Time | Include time |
| Printed | Date and Time | Include time |
| Thumbnail | Hyperlink or Picture → **Picture** | |
| Open in portal | Hyperlink or Picture → **Hyperlink** | |

## Enforce unique on Job ID

List settings → Job ID → **Enforce unique values: Yes**.

This is what makes the mirror idempotent. Flow retries, and Power Automate
will happily retry an action it is not sure completed. With uniqueness on,
the second create fails harmlessly instead of producing a duplicate row. In
Flow, use **Get items** filtered by `Title eq '<jobId>'` and branch to
**Update item** when it already exists.

## Views worth making

**Awaiting decision** — filter `Status` is `Pending approval` or `Expired`,
sorted by `Submitted` ascending. This is the list to put in a Teams tab for
the approvers.

**This fiscal year** — filter `Submitted` is greater than or equal to
`[Today]-365`, grouped by `Department`, with totals on `Actual cost` and
`Paper used (in)`. This is the one that answers "what has this cost us",
which is the question that always arrives in June.

**Ready for pickup** — filter `Status` is `Printed`, sorted by `Printed`
ascending. Anything sitting at the top for more than a week is a poster
somebody forgot about.

## What deliberately is not here

**No image bytes.** Not the original, not the print raster, not even the
full-size preview. A 42×36 poster is 151 megapixels and the print file can
reach 400 MB; a few hundred of those would put the site library into a state
nobody wants to inherit. The list stores a thumbnail URL and a link back to
the portal, and the portal streams the real file to people who are allowed to
see it.

**No approval logic.** The list records what was decided. It does not decide.
Putting an approval condition on a SharePoint column means two systems both
believe they own the workflow, and they will eventually disagree in front of
someone whose poster is due tomorrow.

**No retention rules that fight the portal.** The portal purges heavy files
on `RETENTION_HEAVY_DAYS` (30 by default) and keeps the metadata for
`RETENTION_LIGHT_DAYS` (400). Let the list keep rows indefinitely — they are
tiny — and expect that a thumbnail link older than the heavy retention window
will 404. That is correct behaviour, not a bug to chase.
