# 0019 — Server-side compiled-batch PDF generation with `pdf-lib`: pure-TypeScript rendering, EU object storage, regenerable cache not source of truth

**Date:** 2026-07-19
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

Spec `specs/008-refund-monthly-processing` (US-1) requires that compiling a month's approved
refund requests produce a single artifact — one PDF, organized per requesting employee with
per-currency subtotals and a document header (cutoff, generation timestamp, generating user,
batch reference) — that accounting actually uses to run payroll (AC-1.6). It must never embed
the underlying receipt attachment files (AC-1.7, those stay reachable through 007's existing
per-line attachment view) and must be retained indefinitely regardless of the batch's eventual
status (AC-1.10). `refund-api` (Bun + Hono) has never generated a document before; `auth`,
`estimai-api`, and `notify-api` are all pure relational/JSON services, and `refund-api`'s own
prior object-storage interaction (ADR-0016) is receipt bytes it never touches — the browser
uploads directly to the EU bucket. This is the suite's first server-authored binary artifact,
and it must be produced inside a Bun process without adding a heavyweight runtime dependency to
a service whose primary job is authorization-gated JSON API traffic (ADR-0014/0015).

The plan also had to resolve where PDF generation sits relative to the compile transaction.
Compile (US-1) runs as one atomic `db.$transaction` (candidate row-lock, `RefundBatch` +
`RefundBatchItem` creation, per-request claim, audit rows — see ADR-0020) and the spec fixes
`BatchStatus` at exactly three values (`compiled`/`paid`/`discarded`); no interim "compiling"
state exists for a PDF-generation-in-progress window. Object storage writes (`PutObject`) cannot
participate in a Postgres transaction, so the plan needed a posture for what happens to a
`compiled` batch whose PDF write fails after the DB transaction has already committed.

## Decision

We will generate the compiled batch's PDF **in-process inside the `refund-api` Bun runtime**
using **`pdf-lib`**, from primitives (text lines, rules, a standard embedded font) — no HTML/CSS
layout engine and no headless browser — immediately after the compile transaction commits, then
`PutObject` the resulting bytes to the same EU-region bucket receipt attachments already use
(ADR-0016), under a batch-scoped key namespace, served back only through a short-lived
authz-gated presigned GET. The PDF is treated as a **regenerable cache derived from the batch's
frozen membership, not the source of truth** — so a post-commit storage failure never corrupts
or blocks the batch's lawful `compiled` state.

1. **`pdf-lib`, not a headless browser, not `pdfkit`.** `refund-api/src/batches/pdf.ts` builds
   the document directly from `RefundBatchItem`-derived data: one section per employee, each
   employee's approved lines subtotaled per currency (reusing `computeSubtotals`, never blended
   — 007's rule carried forward verbatim), and the AC-1.6 header fields. `pdf-lib` is pure
   TypeScript with zero native modules, runs cleanly under Bun's Node-compat layer, and needs no
   system library or subprocess.
2. **Currency amounts render as ISO codes, not symbols** (`EUR 45.50`, `CHF 90.00`), because the
   standard embedded PDF fonts' WinAnsi encoding does not reliably cover every currency glyph.
   This is a rendering-only choice; stored data stays integer cents + the `Currency` enum,
   unchanged.
3. **Storage reuses ADR-0016's pattern, extended for refund-api-authored bytes.** Unlike receipt
   attachments — where `refund-api` never touches file bytes, only mints presigned POST/GET URLs
   for the browser — the batch PDF is one place `refund-api` legitimately calls the storage
   client's `PutObject` directly, because it authored the bytes itself. Key namespace:
   `refund/batches/{batchId}/compiled.pdf` — deliberately a sibling of, not nested under,
   `refund/{requestId}/…` (the receipt namespace), so no bucket lifecycle rule scoped to
   unconfirmed receipt uploads can ever catch a batch PDF (ADR-0016 R2 concern, mirrored here as
   plan Risk R8). Retention is indefinite — no expiry rule targets this namespace, mirroring
   ADR-0016/0018's never-delete posture for financial records.
4. **The compile transaction commits before the PDF is written; the PDF is a pure function of
   already-durable state.** `RefundBatch`/`RefundBatchItem` rows are the actual source of truth
   for a batch's membership (see ADR-0020); because every included request is `approved`/`paid`
   and therefore immutable (007 AC-2.3, carried to `paid`), the PDF is a deterministic function
   of that frozen input, safe to regenerate at any later point. If the post-commit `PutObject`
   fails (network blip), the batch still lawfully exists in `compiled` with no object yet
   written; `GET /batches/:id/pdf-url` (and the compilation email, ADR-0021) lazily
   (re)render-and-store on a cache miss. This is what lets the spec's exactly-three-value
   `BatchStatus` (ADR-0020) avoid a fourth "compiling" interim state.
5. **Determinism input, not wall-clock, drives the rendered header.** The header's "generation
   timestamp" is rendered from the batch's stored `createdAt`, not from `Date.now()` at render
   time — a regenerated PDF (on cache-miss or resend) must be byte-content-equivalent to the
   original, not merely similar, or a discarded/re-opened batch's artifact would silently drift
   from what was originally compiled and possibly already emailed.

## Options considered

### Option A — `pdf-lib`, in-process, eager render-then-store as a regenerable cache (chosen)

Described above.

**Pros:**
- Pure TypeScript, zero native modules — no system library, no subprocess, nothing beyond what
  Bun already runs; smallest possible addition to `refund-api`'s container image
- Deterministic output makes the PDF safe to treat as a cache rather than a second source of
  truth, which is what lets the compile transaction commit without a new interim batch status
- Fits the artifact's actual shape — a numeric/textual, form-like summary equivalent to the
  paper reference form (AC-1.6) — with no need for a page-layout/CSS engine

**Cons:**
- Manual, primitive-level layout code (text runs, x/y coordinates, rules) is more verbose to
  write and to keep visually consistent than an HTML/CSS-driven renderer would be
- The standard embedded fonts' glyph coverage gap (mitigated by rendering ISO currency codes,
  decision point 2) is a constraint the team must remember any time new document content is
  added to this or a future generated PDF

### Option B — `pdfkit` (rejected, named fallback)

Also a pure-JS, Bun-workable PDF library.

**Pros:**
- Comparable dependency-weight profile to `pdf-lib` — would satisfy the same "no native module,
  no headless browser" constraint

**Cons:**
- Stream/callback-oriented API is a worse fit for `refund-api`'s otherwise request/response,
  promise-based Hono handlers, and needs external font files bundled into the deployment rather
  than `pdf-lib`'s ability to use the built-in standard fonts directly
- Rejected as the primary choice, kept as the named acceptable fallback if `pdf-lib` were later
  found unsuitable

### Option C — Headless browser (Puppeteer/Playwright), render HTML/CSS to PDF (rejected)

Build the compiled batch as an HTML template and rasterize it to PDF via a headless Chromium
instance.

**Pros:**
- Familiar HTML/CSS authoring model, easier to iterate on visual layout than primitive-level
  drawing calls

**Cons:**
- Ships roughly 300 MB of Chromium into the container image, with real cold-start and memory
  cost on Railway for a service that otherwise stays a thin, low-resource API process
  (ADR-0016's stated posture for `refund-api`)
- A large, general-purpose browser engine is a disproportionate remote-code-execution surface
  for a document that is fundamentally a tabular financial summary with no need of a layout
  engine — the artifact's own shape (AC-1.6) does not justify the attack surface
- Rejected: cost/risk profile is entirely out of proportion to the document being produced

### Option D — Write the PDF inside the same database transaction as compile (synchronous 2PC-style write) (rejected)

Attempt to make the `PutObject` call part of the same atomic unit as the compile transaction, so
a `compiled` batch is only ever created with its PDF already durably stored.

**Pros:**
- Would eliminate the possibility of a `compiled` batch existing with no PDF object yet written

**Cons:**
- Postgres and an S3-compatible bucket cannot participate in a real two-phase commit; any
  attempt to fake it (hold the DB transaction open across the network call, then roll back on
  `PutObject` failure) would hold row locks on the just-claimed candidate requests for the
  duration of an external network call — directly working against the atomic-claim design
  (ADR-0020) it depends on
- Rejected: the regenerable-cache posture (decision point 4) gets the same practical guarantee
  (a batch is never stuck lacking a usable PDF) without coupling two systems that cannot commit
  together

### Option E — Client-side (browser) PDF generation from `BatchDetail` JSON (rejected)

Have `refund-ui` render the PDF in the browser from the data `GET /batches/:id` already returns,
rather than `refund-api` generating and storing bytes server-side.

**Pros:**
- No server-side rendering dependency at all

**Cons:**
- Contradicts AC-3.1/US-3's own requirement: the compilation email must link to an
  already-generated, durably stored artifact reachable by a short-lived signed link — a
  client-only render has nothing to store or link to, and would need to be regenerated by every
  future viewer's browser from scratch, with no single canonical stored artifact for the "history
  never changes" retention guarantee (AC-1.10)
- Rejected: does not satisfy the spec's storage/retention/email-link requirements at all

## Consequences

**Positive:**
- `refund-api`'s container stays lightweight — no headless browser, no native PDF-rendering
  dependency — consistent with ADR-0016's "thin, low-resource API service" posture
- The PDF's regenerable-cache status means a `PutObject` failure never leaves a batch in a
  broken or ambiguous state, and never forces a fourth `BatchStatus` value (ADR-0020)
- Establishes the suite's first document-generation pattern (deterministic, pure-TS, cache-not-
  source-of-truth) for any future Operai feature that needs to produce a generated artifact

**Negative / trade-offs:**
- Layout code is written at the primitive level (text runs, coordinates, rules) rather than
  through a markup/CSS abstraction — more code to write and maintain for visual changes
- Currency amounts render as ISO codes rather than native symbols, a permanent cosmetic
  constraint of the chosen font strategy, not just a launch-time workaround
- Regeneration correctness depends on rendering from stored, immutable inputs (`createdAt`,
  frozen `RefundBatchItem` membership) rather than any live/mutable state — a future change that
  accidentally introduces a wall-clock or non-deterministic input into the renderer would
  silently break the "regenerated PDF equals the original" invariant with no test currently
  distinguishing "renders correctly" from "renders identically to the first render"

**Risks:**
- **Post-commit `PutObject` failure (plan Risk R1).** A `compiled` batch can transiently exist
  with no object yet stored. Mitigation: lazy regenerate-and-store on the next `pdf-url`/email
  request; integration coverage of the missing-object mint path.
- **Currency glyph gaps (plan Risk R7).** The standard embedded fonts don't reliably cover every
  currency symbol. Mitigation: render ISO currency codes, not symbols; unit-assert the rendered
  text runs.
- **Namespace collision with the receipt lifecycle-expiry rule (plan Risk R8).** A batch PDF
  accidentally caught by a rule meant to expire unconfirmed receipt uploads would violate
  AC-1.10. Mitigation: a separate `refund/batches/…` key namespace, sibling to (not nested
  under) `refund/{requestId}/…`; a deploy checklist item to verify no expiry rule targets it.

## Compliance notes

- GDPR/nLPD impact: medium — a compiled PDF aggregates multiple employees' financial data and
  PII into a single document, a materially higher concentration than any single receipt
  attachment. Mitigated by the same private-bucket, authz-gated, short-lived presigned-GET
  pattern ADR-0016 already established, plus the batch-read authorization covered in ADR-0020.
- Data residency: unaffected — the PDF is stored in the same EU-region bucket (ADR-0016) as
  receipt attachments, under the same startup-validated region allowlist.
- Audit trail: PDF generation itself is not separately audited; the `batch_compiled` audit rows
  (ADR-0022, extending ADR-0018) record the compile event that triggers generation, per affected
  request.

This decision builds on ADR-0016 (the EU object-storage pattern and presigned-GET-after-authz
convention this decision reuses for a second, refund-api-authored kind of object), ADR-0018 (the
suite's financial-record retention posture, extended here to a generated artifact rather than an
uploaded one), and ADR-0013 (the schedulerless, reconcile-on-read discipline — no cron ever
regenerates or expires this object; a read-time cache-miss does).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
