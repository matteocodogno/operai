# 0043 — The per-request archive export gives refund-api permission to READ attachment bytes: a bounded, single-caller departure from ADR-0016's never-proxy rule

**Date:** 2026-09-08
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

Accounting must be able to archive an approved expense request: one self-contained PDF holding
every expense line *and* every receipt, filed and readable years later without Operai, its
bucket, or a live presigned URL.

That requirement collides head-on with ADR-0016. Receipt attachments live in EU-region
S3-compatible storage and are reached **only** via presigned URLs — decision 2 of that ADR says
uploads go direct-to-bucket, "never proxied", and its consequences record the payoff explicitly:
"`refund-api` never becomes a bandwidth/memory bottleneck for file transfer." `src/lib/storage.ts`
was written to match. It exposes `mintPresignedPost`, `mintPresignedGet`, `headObject`,
`putObject` and `deleteObject`, and conspicuously **no** read. The one time refund-api writes
bytes it did not receive from a browser — the compiled-batch PDF (ADR-0019) — the module doc calls
out as "the one exception: refund-api generates those bytes itself (it authored them, unlike a
receipt)."

A PDF that embeds receipts cannot be produced without reading receipts. There is no version of
this feature that respects ADR-0016 as written.

Three options were considered.

**A. Compose in the browser.** refund-ui already fetches receipts through presigned GETs; it could
assemble the PDF locally with a client-side library, exactly as `estimai-ui` does for its own
exports. ADR-0016 would be untouched and the server would carry no memory risk at all.

**B. Compose server-side, receipts by reference.** Render the lines and list the receipts as an
index — filenames, sizes, and per-file links — without embedding them. No ADR conflict.

**C. Compose server-side, receipts embedded.** refund-api reads each stored object and embeds it:
a PDF receipt copied page-for-page, a JPEG/PNG embedded as an image.

**B was rejected outright**: an archive whose receipts are links is not an archive. The links
expire in ~60 seconds and the whole point is a document that survives the system that produced it.

**A is genuinely attractive** and was the closest call. It was rejected because the archive is a
*financial record of what was approved*, and the numbers in it must be the numbers refund-api
computed. Moving composition into the browser puts money formatting, mileage-rate provenance and
the approved/requested split in a second place, where they can drift from ADR-0025's
round-exactly-once rule without anything failing. It also makes the artifact client-dependent —
two employees on two browsers could file two different documents for the same request — and leaves
no server-side path for a future scheduled or bulk export. ADR-0019 already chose server-side
`pdf-lib` for the batch PDF for the same family of reasons; splitting the two PDF surfaces across
two runtimes would be worse than the constraint being relaxed.

## Decision

**1. `refund-api` may READ attachment bytes, for exactly one caller: the archive export.**
`storage.ts` gains `getObject`. This is a real reversal of ADR-0016's posture and is documented as
such at the function itself, not only here.

The reversal is narrower than it first appears. ADR-0016 forbids **proxying** — refund-api sitting
in the data path between a client and the bucket for a file the client asked for. That is still
forbidden, and `mintPresignedGet` still exists to serve exactly that need. What is now permitted is
refund-api reading an object in order to compose a **derived document it authors itself** — the
same category as ADR-0019's batch PDF, which the storage module already recognised as legitimate
for writes. `getObject`'s doc comment states the rule directly: do not reach for it from a
read/list/detail route; if a client wants a receipt, mint a presigned GET.

**2. The memory exposure is bounded explicitly, because nothing else bounds it.**
`MAX_ATTACHMENT_BYTES` caps ONE attachment at 10 MiB, and there is no cap at all on attachments per
request — so an unbounded export could pull hundreds of MiB into a small container. A new
`MAX_EXPORT_RECEIPT_BYTES` (64 MiB) is enforced from the database's `sizeBytes` column **before a
single object is fetched**, so an oversized request costs one query and a 413, never a
partially-downloaded heap. 64 MiB is ~6 max-size receipts — far above any real expense request, low
enough that concurrent exports still fit.

**3. A receipt that cannot be embedded fails the whole export. There is no placeholder page.**
Corrupt bytes, a mislabelled content type, or an unreadable object produce a 502 naming the file,
and no PDF at all. The reasoning is the inverse of the usual fail-soft preference (ADR-0032, and
the batch PDF's own fail-soft `pdf: null` in `pdfLink.ts`): those degrade a *view*, which the user
is looking at and can re-check. This produces an *archive*, which by definition nobody re-checks.
A document that looks complete and silently isn't is worse than a refusal, because the refusal gets
fixed and the silent gap does not.

**4. Approved, REJECTED and paid requests only (409 otherwise).**

*Amended 2026-09-09:* `rejected` was originally excluded, grouped with
`draft`/`submitted`. That was wrong. Those two are excluded because they are
still MOVING — a draft's mileage is recomputed on every read, a submitted
request has no decision at all — whereas a rejected request is **terminal**.
It is also the document an employee disputing a refusal most needs to keep,
and the one they could not obtain. Its export carries the rejection motivation
above the figures, and shows **no approved amount anywhere**: a reviewer can
set per-line approved totals while a request is still `submitted` and then
reject it, and those leftovers rendered as "Approved 206,50 CHF" on every line
while the totals said "Approved —". On a refusal that is the most damaging
claim the page could make.

*Original reasoning, unchanged for draft/submitted:* A draft's mileage is recomputed against the
currently-effective rate on every read (specs/009 Decision 1, ADR-0013) and a submitted request has
no approved figures at all, so archiving either would freeze a moving target. `paid` is allowed
because it is `approved` that has since been paid out — refusing to archive a request *because* it
completed would be absurd.

**5. No new catalog permission — the existing `request:read`/`request:review` gate is reused
verbatim** via `canReadRequest`, and every denial is 404, never 403. This is ADR-0042's
reconstructibility test applied unchanged: a holder of the existing grant can already see every
line and open every receipt through presigned GETs, so a new permission would withhold nothing and
would advertise a control that does not exist. The 404-for-everything posture matches the sibling
`GET /requests/:id` (ADR-0005) — an export route must not become the one place existence leaks.

**6. The export is generated per call and never stored.** Unlike the batch PDF (ADR-0019), which is
a stored, regenerable cache because it is referenced by an emailed deep link over time, an archive
export is a user-initiated download with no second reader. Storing it would add bucket growth,
staleness, and a lifecycle question for zero benefit. The response carries `Cache-Control:
no-store` — personal financial data, ADR-0041's posture extended from the JWT to derived documents.

**7. Not PDF/A — deliberately, and with the reason recorded (2026-09-09).**

CH bookkeeping retention is ten years, so PDF/A-2b or -3b is the obvious
archival target and was considered. It is not adoptable while receipts are
embedded as COPIED PAGES: a receipt is an arbitrary user-uploaded PDF, those
routinely lack embedded fonts, and a non-conformant copied page breaks
conformance for the whole file — unfixable from our side, since we do not have
the fonts. `pdf-lib` additionally has no XMP or OutputIntent API (it does have
file attachments), so conformance would be hand-built and would need veraPDF
validation in CI to be worth asserting at all. A document that CLAIMS PDF/A and
fails validation is worse than one that claims nothing, because an auditor
relies on the claim.

The realistic path, if this is taken up: **PDF/A-3b with receipts as embedded
FILES rather than copied pages** — which is precisely what A-3 exists for. Our
own pages then conform, and each receipt rides along as an attachment. The cost
is that receipts stop being visible pages, which is a real loss of readability;
rasterising them to keep them visible needs a renderer `pdf-lib` does not have
and destroys the receipt's own text layer.

**Escalation trigger:** adopt A-3b the first time a retention/audit requirement
is stated as a *requirement* rather than a preference, or the first time a
receipt is needed as evidence and its provenance is questioned.

**8. The document carries the issuing company's letterhead** — legal name,
registered seat and tax identifier, selected from the request's own entity
(`letterhead.ts`). A mixed-entity request takes the Swiss headquarters, since
the Italian establishment is a branch of it and the header says "Multiple"
rather than implying one entity owns the whole request.

## Consequences

- `refund-api` is now, for one route, in the file-transfer path it was designed to stay out of. Peak
  memory for an export is bounded by `MAX_EXPORT_RECEIPT_BYTES`, not by request size — but that
  bound is per-request, not global: N concurrent exports cost N × the bound. If exports ever become
  frequent or scripted, the next step is a concurrency limit on this route, not a larger budget.
- The 413 is a real user-visible outcome, not a theoretical guard. A request with many large
  receipts cannot be archived through this route at all, and the UI says so in its own words rather
  than offering a retry that would never succeed.
- `renderRequestExportPdf` is pure — it takes already-fetched bytes and performs no I/O — which is
  what confines the ADR-0016 departure to a single call site in the route, and what lets the
  embedding logic be tested with real PNG/JPEG/PDF bytes and no storage mock.
- The batch PDF's "never embeds receipts" rule (ADR-0019, AC-1.7) is **unchanged and still correct**.
  A batch is a payout summary across many employees; this is one request's complete record. The two
  renderers must not be merged, and `batches/pdf.ts` keeps its explicit no-attachments contract.
- **Escalation trigger.** If a second caller ever needs `getObject`, the "one permitted caller" framing
  here stops holding and this ADR must be revisited rather than quietly extended — the same discipline
  ADR-0040 committed to for `NOTIFY_INTERNAL_TOKEN`'s holders.
