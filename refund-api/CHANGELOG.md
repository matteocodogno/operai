# @operai/refund-api

## 0.2.0

### Minor Changes

- 6338f88: Filing the same trip twice no longer means typing it twice: while composing a
  "Travel by car" line, the Motivo field now suggests trips the employee has
  already claimed in the last 24 months, and picking one (by mouse or keyboard)
  fills in the motivo, the distance and the entity in a single step, with the
  amount recomputed from the current rate. Suggestions are drawn only from the
  employee's own past lines, served by a new self-scoped `GET /line-suggestions`
  on refund-api; if that call fails, Motivo quietly stays an ordinary text field.
- ceb22d1: An approve/reject decision on an expense request now also reaches the employee
  by email, alongside the in-app notification they already received.

  Two new notify-api templates — `refund_decision_approved` and
  `refund_decision_rejected` — rather than one with an outcome flag: only the
  approved variant carries money, so a split keeps each template's `data` shape
  closed and fixed, and a rejection can never carry a figure. The approved mail
  states the approved total per currency inline; the rejected mail carries no
  amount and, deliberately, not the rejection motivation — that stays behind
  sign-in in the app. Both link into the request rather than restating it, the
  same posture the compiled-batch email already takes.

  refund-api sends it from the decision path as a second, independent
  best-effort channel: an email outage cannot suppress the in-app notification,
  an in-app outage cannot suppress the email, and neither can fail or roll back
  the decision itself. No new environment variable and no new secret — the
  existing notify-api internal token and app base URL cover it.

- 81f700e: The archive PDF is now laid out as a document rather than a list of sentences.

  A letterhead with the issuing entity and a brand rule; a title block with the
  status as a chip instead of a "Status:" row; the nine stacked label-value lines
  replaced by two grouped columns (Request / Processing); and the expense lines
  set as a real table — numbered, dated, with the rate breakdown demoted to a
  grey Detail column and both money columns right-aligned so a reader can run
  their eye down them and check the sum.

  The total is now the most prominent figure on the page rather than the least:
  bold, under a brand rule, aligned in the same columns as the lines it totals,
  with the kilometre total beside it as a cross-check. It is summed from the
  lines actually printed, so it can never disagree with them. Multi-currency
  requests repeat that whole block per currency with its own subtotal and no
  grand total across them.

  Receipts are listed in a framed note under the table by filename and the page
  they appear on. The table header repeats on continuation pages, the footer is
  ruled, and margins are ~20mm.

  Colour is an accent only — the status chip carries its own word, the total is
  distinguished by weight and a rule — so nothing is lost when these are printed
  or photocopied in monochrome, which is how they will be archived.

- a1f78cd: The archive PDF now names its people, carries a letterhead, and handles
  requests that are not uniform.

  Employee, decider and exporter render as "Luigi Gambardella
  (luigi.gambardella@welld.ch)" rather than a bare address — a document a human
  files should lead with the human. The decider's name is captured at decision
  time, so an archived PDF never changes because that person's record later did.

  The page identifies its issuer: legal name, registered seat and tax identifier
  for the entity the request belongs to.

  A request whose lines straddle entities, currencies or months no longer gets a
  header that quietly implies uniformity. The period widens to "August to
  September 2026", the entity says "Multiple — see each line", and the totals are
  one row per currency under a "Totals per currency" heading, never summed across
  them.

  Rejected requests are exportable, and their document carries the rejection
  motivation above the figures — it is the whole content of that document and the
  one a disputing employee needs. It also shows no approved figure anywhere: a
  reviewer can set per-line approved totals before rejecting, and those leftovers
  were rendering as approved amounts on a refused claim.

  The settlement line no longer repeats the status word directly above it.

- 7f29ff7: The request archive PDF now reads like a document rather than a data dump.

  Raw database values no longer reach the page: expense types, entities and the
  status render as the same words the UI shows ("Travel — mileage (km)",
  "WellD CH", "Approved"), sourced from a canonical label table both packages
  assert against so the PDF and the screen can never disagree.

  One locale throughout. Amounts, the mileage rate and every date now share a
  single convention (206,50 CHF · 0,70 CHF/km · 31.01.2021) instead of mixing
  comma decimals, dot decimals and ISO dates on one page, and the currency now
  follows the amount as it does on screen. Timestamps are civil time in the
  document's timezone with the zone named — 08.09.2026 08:45 (CEST) — rather
  than raw ISO with milliseconds in UTC, which could file an evening export
  under the wrong day.

  The document also answers the first question a recipient asks: whether it
  represents a liability or a settled one. A settlement line states "not yet
  included in a monthly batch", "included in batch 2026-09 — compiled, not yet
  paid", or "Paid on … — batch 2026-09". The header names the period and legal
  entity, every page carries the reference and a page number, and receipts are
  stated once rather than per line and again at the end.

  Downloads are named refund*2026-08_camerini_CHF-206.50*<id>.pdf instead of
  refund-request-<cuid>.pdf — sortable in a folder and quotable over the phone.

- fb42218: An approved expense request can now be exported as a single archive PDF —
  every expense line with its mileage-rate provenance, plus every receipt
  embedded in full. A PDF receipt is copied page-for-page; a JPEG or PNG is
  embedded as an image. An "Export PDF" button appears on an approved request
  for its owner and for accounting reviewers.

  This is the first time refund-api reads attachment bytes at all (ADR-0043).
  Receipts were previously reachable only through presigned URLs the browser
  followed itself, which is still how receipt downloads work — but an archive
  cannot embed a file it may not read. The exposure is bounded: a request whose
  receipts exceed the export budget is refused with a clear message rather than
  archived incompletely, and a receipt that cannot be embedded fails the whole
  export instead of producing a PDF with a silent gap in it. An archive that
  looks complete but isn't is worse than one that refuses to build.

  Drafts, submitted and rejected requests are not exportable — their figures are
  not yet final. Paid requests are, since paying one does not make it less
  worth archiving.

### Patch Changes

- 34cce3b: The refund review queue now lists requests newest-submitted-first.

  It was ordered oldest-first (FIFO), which pushed the most recent submissions
  to the bottom, under every already-approved request still waiting to be
  batched. Accounting works the queue from the newest end, so that ordering is
  now reversed. Submitted and approved-not-yet-batched rows remain interleaved
  by submission date rather than grouped, as before — the per-row status badge
  distinguishes them.

## 0.1.1

### Patch Changes

- bdf998c: Bind backends to IPv6 (::) on Railway (when RAILWAY_PRIVATE_DOMAIN is set) so private networking (\*.railway.internal) can reach them. Enables moving cross-service call URLs (AUTH_JWKS_URL / AUTH_BASE_URL / NOTIFY_INTERNAL_URL) to internal DNS and shared/reference variables (Layer 2), reducing the env-var sprawl. Local dev unchanged (keeps Bun default IPv4).
