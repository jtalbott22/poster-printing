# Power Automate setup

Two flows. Neither one holds an HTTP connection open, which is the whole
point — see [Why it works this way](#why-it-works-this-way) if you want the
reasoning before the clicking.

- **Flow A — Poster Approval** — receives a submitted job, runs the Teams
  approval, posts the decision back.
- **Flow B — Poster Notify** — sends "your poster is ready" mail and Teams
  messages. Fire-and-forget.

Both are **premium** flows: the HTTP action in Flow A and the HTTP trigger in
both are premium connectors. Confirm the licence before you build, or you will
get to the end and find the flow will not save.

---

## Before you start

From the portal, get the shared secret and callback details:

```bash
cd /opt/poster-portal/webapp
grep FLOW_SHARED_SECRET .env
```

Keep that value handy. It is the only thing standing between the internet and
your approval endpoint.

---

## Flow A — Poster Approval

### A1. Trigger: **When an HTTP request is received**

Method `POST`. Paste this as the request body JSON schema:

```json
{
  "type": "object",
  "properties": {
    "event":        { "type": "string" },
    "jobId":        { "type": "string" },
    "title":        { "type": "string" },
    "requester":    { "type": "string" },
    "requesterName":{ "type": "string" },
    "department":   { "type": "string" },
    "billingIndex": { "type": "string" },
    "finishedSize": { "type": "string" },
    "paperUsedIn":  { "type": "number" },
    "copies":       { "type": "integer" },
    "printer":      { "type": "string" },
    "pickupLocation": { "type": "string" },
    "effectiveDpi": { "type": "integer" },
    "preflight":    { "type": "string" },
    "estimatedCost":{ "type": "string" },
    "thumbnailUrl": { "type": "string" },
    "reviewUrl":    { "type": "string" },
    "callbackUrl":  { "type": "string" },
    "callbackToken":{ "type": "string" },
    "deadline":     { "type": "string" }
  }
}
```

Save the flow now — the trigger URL only appears after the first save. Copy it
into the portal's `.env` as `FLOW_SUBMIT_URL`, then `systemctl restart
poster-portal`.

### A2. First action: **Condition — verify the caller**

Do not skip this. The trigger URL includes a SAS signature, but anyone who
ever sees that URL in a log can replay it. Compare:

- Left: `triggerOutputs()['headers']['X-PP-Signature']`
- Right: an expression computing the HMAC of the body with `FLOW_SHARED_SECRET`

If your tenant makes HMAC awkward in an expression, the workable substitute is
a second shared header the portal also sends:

- Left: `triggerOutputs()['headers']['X-PP-Secret']`
- Right: the `FLOW_SHARED_SECRET` value

In the **If no** branch: **Terminate** with status `Failed`. Nothing else.

### A3. Get the approver

**Send an HTTP request** is not needed — the portal already tells you where to
route. Use a **Switch** on `pickupLocation` and set a variable `Approvers` to
the right people, or read a SharePoint list if the routing changes often.

### A4. **Start and wait for an approval**

- Approval type: **Approve/Reject — First to respond**
- Title: `Poster print: @{triggerBody()?['title']}`
- Assigned to: your `Approvers` variable
- Details (Markdown renders in the Teams card):

```
**@{triggerBody()?['jobId']}** from @{triggerBody()?['requesterName']}
(@{triggerBody()?['requester']})

| | |
|---|---|
| Finished size | @{triggerBody()?['finishedSize']} |
| Paper used | @{triggerBody()?['paperUsedIn']}" of roll |
| Copies | @{triggerBody()?['copies']} |
| Resolution | @{triggerBody()?['effectiveDpi']} DPI |
| Printer | @{triggerBody()?['printer']} |
| Pickup | @{triggerBody()?['pickupLocation']} |
| Billing | @{triggerBody()?['billingIndex']} |
| Estimated cost | @{triggerBody()?['estimatedCost']} |

**Preflight:** @{triggerBody()?['preflight']}

[Open the full-size proof](@{triggerBody()?['reviewUrl']})
```

- Item link: `reviewUrl`
- Item link description: `Review in the poster console`

**This action can sit here for two days.** That is fine and expected. It is a
durable workflow state on Microsoft's side, not an open socket. The portal is
not waiting on it.

### A5. **HTTP — post the decision back**

- Method: `POST`
- URI: `@{triggerBody()?['callbackUrl']}`
- Headers:

```json
{
  "Content-Type": "application/json",
  "X-PP-Callback-Token": "@{triggerBody()?['callbackToken']}"
}
```

- Body:

```json
{
  "decision": "@{body('Start_and_wait_for_an_approval')?['outcome']}",
  "comments": "@{body('Start_and_wait_for_an_approval')?['responses'][0]?['comments']}",
  "approver": "@{body('Start_and_wait_for_an_approval')?['responses'][0]?['responder']?['email']}",
  "decidedAt": "@{utcNow()}"
}
```

The token is single-use and scoped to this one job. The portal accepts
`Approve` / `Reject` in any casing.

### A6. Configure retry on that HTTP action

Settings on the HTTP action → **Retry Policy** → Exponential interval, count
`4`, interval `PT10S`. If the portal is briefly down, the decision still
lands. If all retries fail, the job stays pending and an operator approves it
in the console — no decision is ever lost, it just changes hands.

### A7. Mirror to SharePoint

Add **Create item** (or **Update item**) against the list in
[`sharepoint-list.md`](./sharepoint-list.md), either in parallel with the
approval or right after it. Links and thumbnails only — no image bytes.

---

## Flow B — Poster Notify

Trigger: **When an HTTP request is received**, schema:

```json
{
  "type": "object",
  "properties": {
    "event":     { "type": "string" },
    "jobId":     { "type": "string" },
    "title":     { "type": "string" },
    "requester": { "type": "string" },
    "status":    { "type": "string" },
    "message":   { "type": "string" },
    "pickupLocation":  { "type": "string" },
    "pickupInstructions": { "type": "string" },
    "pickupMapUrl":    { "type": "string" },
    "pickupPhotoUrl":  { "type": "string" },
    "thumbnailUrl":    { "type": "string" },
    "jobUrl":    { "type": "string" }
  }
}
```

Same signature check as A2. Then **Switch** on `event`:

| `event` | Do |
|---|---|
| `job.printed` | Email + Teams chat with pickup details, door photo, map link |
| `job.rejected` | Email with the approver's comments |
| `job.failed` | Teams message to the operators channel |
| `job.expired` | Teams message to the approvers — nobody answered in time |

Put `FLOW_NOTIFY_URL` in the portal `.env`.

The pickup mail is the one people actually read, so give it the door photo
inline and the map link right under it:

```
Your poster PP-2026-0413 is printed and waiting.

Pick it up: @{triggerBody()?['pickupLocation']}
@{triggerBody()?['pickupInstructions']}

<img src="@{triggerBody()?['pickupPhotoUrl']}" width="420">

[Directions](@{triggerBody()?['pickupMapUrl']})
```

---

## Testing without printing anything

```bash
# Pretend to be the portal submitting a job
curl -X POST "<FLOW_SUBMIT_URL>" \
  -H "Content-Type: application/json" \
  -H "X-PP-Secret: <FLOW_SHARED_SECRET>" \
  -d '{"event":"job.submitted","jobId":"PP-TEST-0001","title":"Test",
       "requester":"you@kent.edu","requesterName":"You",
       "finishedSize":"48\" x 36\"","copies":1,"effectiveDpi":300,
       "printer":"Bowman 36\"","pickupLocation":"Bowman 108",
       "preflight":"pass","reviewUrl":"https://posters.kent.edu/admin",
       "callbackUrl":"https://posters.kent.edu/hooks/approval/PP-TEST-0001",
       "callbackToken":"test","deadline":"2026-01-01T00:00:00Z"}'
```

You should get the Teams card within a few seconds. The callback will be
rejected because `PP-TEST-0001` is not a real job — that is the correct
result, and it proves the token check is live.

To test the return path, submit a genuine job, then from the admin console
watch **System → Power Automate**. `pending 0` means every envelope was
delivered and acknowledged.

---

## Why it works this way

The obvious design is: portal calls the flow, flow runs the approval, flow
returns the decision as its HTTP response. It is simpler to draw and it does
not work.

An approval waits on a person. People go to lunch, go home, go on leave. The
response you are waiting for is hours or days away, and there is no HTTP
timeout anywhere in that chain long enough to cover it — not in Node, not in
nginx, not in the Azure front end, which caps a synchronous flow response at
around two minutes regardless of what you configure. So the socket dies, the
portal sees a failed request, and the decision the approver eventually makes
has nowhere to land.

So the portal never waits. It POSTs the job envelope with a `callbackUrl` and
a single-use token, gets its `202`, and closes the connection in under two
seconds. Flow holds the human part in its own durable state for as long as it
takes. When someone finally clicks Approve, Flow POSTs back to the portal as a
fresh, short request.

Three things fall out of that, and they are the reason it is worth the extra
step:

**Either side can restart.** Reboot the portal mid-approval and nothing is
lost — the pending decision lives in Flow, and the job row lives in SQLite.
Neither is holding a connection that a restart would break.

**Nothing is delivered only once and hoped for.** Outbound envelopes sit in a
`webhook_outbox` table with exponential backoff and an idempotency key, so a
Flow outage delays notifications rather than dropping them. Inbound callbacks
are deduplicated on that same key, so Flow's own retries cannot approve a job
twice.

**Nothing waits forever.** Every approval carries a deadline, 48 hours by
default. When it passes, the job moves to `expired` and appears at the top of
the admin console for a human to decide in one click. That is the answer to
"what if the approval times out" — it does not fail silently and it does not
hang. It changes hands.

The cost of all this is one extra HTTP action in a flow. The benefit is that
the failure mode of your approval system is a queue that needs attention
rather than a poster nobody can explain.
