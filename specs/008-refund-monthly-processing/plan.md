---
spec: 008
status: approved
---

# Plan: Refund monthly processing — PDF compilation, email delivery & "mark as paid"

## Context this plan fits (read before the design)

This feature **extends the already-shipped `refund-api` + `refund-ui`** from
`specs/007-refund-service` (status `done`). It does not bootstrap a new service. Everything
it needs already exists as a reusable seam:

- **Server-side authz** — `refund-api/src/auth/authz.middleware.ts` resolves the caller's
  refund permissions live from `auth GET /authz/resolve` (ADR-0014), caches on
  `(sub, perm_epoch)`, and fails **closed** (503) on an auth outage. `src/authz/conditions.ts`
  (`hasCapability`, `findPermission`, `entityScopeForPermission`, `requestInScope`,
  `GLOBAL_ENTITY_SCOPE`) and `src/review/review.service.ts` (`scopeForReviewAction`) are the
  entity-scope machinery (ADR-0015). This plan reuses all of it verbatim — **no new catalog
  action, no new permission, no new role** (spec Constraints; AC-4.4).
- **Object storage** — `src/lib/storage.ts` mints presigned URLs against a private EU-region
  S3-compatible bucket (Railway EU-Amsterdam, ADR-0016). Its process already never touches
  *receipt* bytes. The batch PDF is a **new** kind of object: refund-api generates the bytes
  in-process, so it does `PutObject` directly (it authored them), then serves them via the
  same short-lived, authz-gated presigned GET pattern.
- **Cross-user in-app push** — `src/lib/notify.ts` → notify-api `POST /system/notifications`
  (internal-token, ADR-0017), already used to notify the employee on approve/reject (AC-3.6).
  US-5's `paid` push reuses it unchanged (only new copy).
- **Email** — notify-api `POST /system/emails` (internal-token, ADR-0011) is the suite's only
  email path. It renders a **fixed** template set (`invitation`/`invitation_resend`) with a
  **fixed** invitation-shaped `data` payload, 16 KiB cap, **no attachment concept**. This plan
  adds one new template + one new per-template `data` shape (the signed link), and refund-api
  becomes a second caller of `/system/emails` (it already calls `/system/notifications`).
- **Audit** — `RefundAuditEntry` is append-only, DB-immutable via a raising `BEFORE
  UPDATE/DELETE` trigger (ADR-0018). Spec Constraints require this feature reuse that exact
  mechanism, not a new one. `src/requests/audit.ts::writeAuditEntry` writes inside the same
  transaction as the event.

Two facts the spec forces the plan to decide, decided here:

1. **The `RefundStatus` freeze.** `refund-api/prisma/schema.prisma` carries an explicit
   comment: *"draft|submitted|approved|rejected only … Do not add a fifth value here."* This
   plan **supersedes that freeze**: `paid` is added as the fifth, terminal value (spec
   Domain language; ADR candidate #2). The comment is updated to cite spec 008.
2. **Where the PDF is generated.** In-process in refund-api with **`pdf-lib`** (see
   Architecture; ADR candidate #1).

---

## Architecture

### The compile → preview → email → mark-paid → notify flow

```
ACCOUNTING (role: accounting entity-scoped, OR refund-admin global)        refund-api          object storage (EU)     notify-api
──────────────────────────────────────────────────────────────────       ──────────           ───────────────────     ─────────
GET  /batches/candidates?cutoff=…   ── dry-run preview (no writes) ──►  eligible set (scoped)
POST /batches {cutoff?}             ── compile ──────────────────────►  TX: FOR UPDATE candidates
                                                                          → create RefundBatch(compiled)
                                                                          → claim requests (batchId=B)
                                                                          → RefundBatchItem rows (frozen membership)
                                                                          → audit: batch_compiled ×N
                                                                        COMMIT
                                                                          → pdf-lib render bytes ──── PutObject ──► refund/batches/B/compiled.pdf
                                                                          → best-effort email ─────────────────────────────────► POST /system/emails
                                                                                                                                   (to = configured dist addr,
                                                                                                                                    body = app deep link, NOT the PDF)
GET  /batches/:id                   ── inspect (US-2) ──────────────►  detail + mint presigned GET (authz-gated)
GET  /batches/:id/pdf-url           ── download/preview ────────────►  presigned GET (~60s), accounting-only
POST /batches/:id/email             ── resend (US-3) ────────────────────────────────────────────────────────────────────────► POST /system/emails
POST /batches/:id/mark-paid         ── commit payment (US-4) ───────►  TX(CAS): batch compiled→paid
                                                                          → requests approved→paid
                                                                          → audit: batch_paid ×N
                                                                        COMMIT → per-owner push ──────────────────────────────► POST /system/notifications ×N
POST /batches/:id/discard           ── void (US-6) ─────────────────►  TX(CAS): batch compiled→discarded
                                                                          → release requests (batchId=NULL, still approved)
                                                                          → RefundBatchItem KEPT (history)
                                                                          → audit: batch_discarded ×N

EMPLOYEE (owner)  GET /requests/:id  ── sees `paid` + paidAt, no monthly note (US-5); in-app push arrives via notification center
```

### PDF generation — decision: `pdf-lib`, in-process in refund-api

**Chosen:** generate the compiled PDF with **`pdf-lib`** inside the refund-api Bun process,
from primitives (text lines, rules, a standard embedded font). Bytes are then `PutObject`'d to
the EU bucket (ADR-0016) and served via a presigned GET.

**Why over the alternatives:**

| Option | Verdict |
|---|---|
| **`pdf-lib`** (chosen) | Pure TypeScript, **zero native modules / no system libraries**, runs cleanly under Bun's Node compat. Draws exactly the numeric/textual, form-like layout this artifact is (a summary equivalent to the paper form, AC-1.6) — no HTML/CSS engine needed. Deterministic output → the PDF is a **pure function of the batch's frozen request set**, which makes regeneration safe (see below). Small, well-maintained. |
| `pdfkit` | Also pure-JS and Bun-workable, but stream/callback-oriented and needs external font files bundled; `pdf-lib`'s document model is a better fit and lighter to wire. Acceptable fallback, not preferred. |
| Headless browser (Puppeteer/Playwright → HTML→PDF) | **Rejected.** Ships a ~300 MB Chromium into the container, cold-start + memory cost on Railway, a large remote-code surface for a document that has no need of a layout engine. Disproportionate for a tabular financial summary. |

**Encoding note (glyph safety):** the standard PDF fonts' WinAnsi encoding does not reliably
cover every currency glyph across providers. The compiled PDF renders amounts with **ISO
currency codes** (`EUR 45,50`, `CHF 90,00`, `GBP …`, `USD …`), not symbols — sidestepping any
`€`/`£` glyph gap and matching the "never blended, per-currency subtotal" rule (AC-1.6). This
is a rendering choice only; stored data stays integer cents + `Currency` enum.

**Regeneration posture (resilience):** the PDF object is treated as a **regenerable cache, not
the source of truth.** Because (a) a batch's membership is frozen in `RefundBatchItem` at
compile time and (b) every request in a batch is `approved`/`paid` and therefore immutable
(007 AC-2.3, carried to `paid`), rendering is a deterministic pure function of DB state. So if
the post-commit `PutObject` ever fails (network blip), the batch still lawfully exists in
`compiled`; the object is lazily (re)rendered-and-stored on the next `pdf-url`/email request.
This is what lets the compile transaction commit **before** the S3 write without introducing a
4th "compiling" batch state (spec fixes exactly three).

### Where each concern lives

| Component | Change |
|---|---|
| `refund-api` `src/batches/` (NEW) | `batches.routes.ts` (7 endpoints), `batches.repo.ts` (claim/mark-paid/discard TXs), `batches.service.ts` (candidate query, mapping, scope), `pdf.ts` (pdf-lib render), `batches.schemas.ts`. Registered in `src/index.ts`. |
| `refund-api` `src/lib/storage.ts` | +`putObject(key, bytes, contentType)` (server-side upload — refund-api authored these bytes, unlike receipts). Reuse `mintPresignedGet`. |
| `refund-api` `src/lib/notifyEmail.ts` (NEW) | Mirrors `notify.ts`; calls notify-api `POST /system/emails` (X-Internal-Token) for the compilation email; best-effort; returns delivery status. |
| `refund-api` `src/lib/notify.ts` | +`notifyPaid` copy (reuses the same `POST /system/notifications` client). |
| `refund-api` `prisma/schema.prisma` | +`RefundStatus.paid`, +`BatchStatus` enum, +`RefundBatch`, +`RefundBatchItem`, +`RefundRequest.batchId`, +3 `AuditAction` values, +`RefundAuditEntry.batchId`. New migration only. |
| `refund-api` `src/lib/env.ts` | +`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`, +`REFUND_APP_BASE_URL`. (Reuses existing `NOTIFY_INTERNAL_URL`/`NOTIFY_INTERNAL_TOKEN` for `/system/emails`.) |
| `notify-api` `src/channels/email.channel.ts` + `system/emails.schemas.ts` + `system/emailTemplates.ts` | +`refund_batch_compiled` template; `data` becomes per-template (union); new English-only render branch with the deep link. **No attachment support** (Non-goal). |
| `refund-ui` | Accounting: `/refund/batches` (history), compile+preview flow, `/refund/batches/:id` (detail, PDF preview, resend, mark-paid, discard). Employee: `paid` badge + `paidAt` + suppress monthly note. |

Reuses: ADR-0005 (JWKS identity, ownership-404), ADR-0006 (federated remote), ADR-0007 (live
perms, none in JWT), ADR-0010 (`aud`), ADR-0011 (`/system/emails` internal-token),
ADR-0014 (`/authz/resolve` + local condition eval), ADR-0015 (entity-scoped ABAC),
ADR-0016 (EU object storage + presigned URLs), ADR-0017 (cross-user in-app push),
ADR-0018 (immutable audit trigger).

### refund-ui screen architecture (inner TanStack Router at `basepath:'/refund'`)

- `/refund/batches` — batch history (US-8). Columns: cutoff, status badge, request count,
  per-currency totals, email delivery status. Nav item + route gated on the `request:review`
  capability (same gating as `/refund/review`).
- Compile action (from `/refund/batches`) — cutoff picker (defaults to now), then a
  **candidate preview** (US-2) grouped by employee with per-currency subtotals; "Compile"
  confirms. Empty candidate set disables compile with the AC-1.4 message.
- `/refund/batches/:id` — batch detail (US-2/US-8) **and the landing page of the email deep
  link**. Shows metadata (cutoff/generated-at/generating user/reference), requests grouped by
  employee, a PDF preview/download button (calls the authz-gated `pdf-url`), email delivery
  status + Resend, and — only while `compiled` — Mark-as-paid (needs `request:approve`) and
  Discard, each behind a confirm dialog stating irreversibility.
- Employee `RequestDetailPage` / `MyRequestsPage` — `RequestStatusBadge` gains a `paid`
  variant (distinct from approved/rejected/submitted, AC-5.2); detail shows `paidAt`;
  `MonthlyProcessingNote` is suppressed for `paid` (AC-5.3, it already keys off `approved`);
  per-line requested-vs-approved unchanged (AC-5.4).

All data via `shell/session`'s `apiFetch` (Bearer to the refund-api origin, 401 refresh-retry,
ADR-0001). English-only copy (Non-goal: no IT this feature), new strings in `strings.ts`.

---

## Data model

New migration in `refund-api/prisma/migrations/` (e.g. `20260719_add_batches`). **Never edit
007's `20260716133804_init` or `20260717120000_add_line_currency`.**

### Enum changes

```prisma
enum RefundStatus { draft submitted approved rejected paid }   // +paid (spec 008 supersedes the 007 "no fifth value" freeze)
enum BatchStatus  { compiled paid discarded }                   // NEW — exactly three (spec Domain language)
enum AuditAction  { submitted withdrawn approved rejected approved_total_set
                    batch_compiled batch_paid batch_discarded } // +3 (US-7)
```

- Postgres `ALTER TYPE "RefundStatus" ADD VALUE 'paid'` cannot run inside a transaction on
  older PG and Prisma emits it accordingly; the migration must add the enum value in its own
  statement before any table DDL that references it. Flagged in the migration file.
- `paid` inherits immutability **for free**: 007's guards already gate mutation on
  `status == 'draft'` (edit/delete) or `status == 'submitted'` (decide) — `paid` is neither,
  so no guard change is needed for AC-2.3-parity. Verified against `lines`/`lifecycle` repos
  and `decide.repo.ensureInScopeSubmittedRequest`.

### New tables

```prisma
// A compiled run — frozen at compile time, never mutated in place (spec Domain language).
model RefundBatch {
  id                     String      @id @default(cuid())
  cutoff                 DateTime                                   // AC-1.1 (defaults to now if not overridden — applied in the handler)
  status                 BatchStatus @default(compiled)
  createdByUserId        String                                    // generating accounting user (AC-1.6 header)
  createdByEmail         String
  pdfObjectKey           String      @unique                       // refund/batches/{id}/compiled.pdf (no PII in key)
  recipientEmailSnapshot String                                    // the configured distribution address captured at compile time
  // Compilation-email delivery status surfaced in-app (AC-3.2), updated on send/resend.
  emailStatus            String?                                   // "sent" | "failed" | null (never attempted)
  emailLastAttemptAt     DateTime?
  emailDeliveryId        String?                                   // notify-api EmailDelivery id, for support tracing
  // Terminal-transition provenance (audit has the authoritative record; these back US-2/US-6 display).
  paidAt                 DateTime?
  paidByEmail            String?
  discardedAt            DateTime?
  discardedByEmail       String?

  items        RefundBatchItem[]
  requests     RefundRequest[]                                     // live "currently claimed by" pointer (nulled on discard)
  auditEntries RefundAuditEntry[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([status, createdAt])                                     // history list (AC-8.1/8.2)
  @@map("refund_batch")
}

// Immutable membership snapshot — records that a request was ONCE in a batch, kept even after
// discard and even if the request is later re-included in a different batch (AC-6.3, AC-7.3).
// This, not RefundRequest.batchId, is the durable membership of record and the input the PDF
// renders from (so a discarded batch's PDF still resolves — AC-1.10/6.3).
model RefundBatchItem {
  id        String        @id @default(cuid())
  batchId   String
  batch     RefundBatch   @relation(fields: [batchId], references: [id], onDelete: Restrict)
  requestId String
  request   RefundRequest @relation("BatchItemRequest", fields: [requestId], references: [id], onDelete: Restrict)
  createdAt DateTime      @default(now())

  @@unique([batchId, requestId])                                   // a request appears once per batch
  @@index([requestId])                                             // AC-7.3 "which batches has this request ever been in"
  @@map("refund_batch_item")
}
```

### Changes to existing tables

```prisma
model RefundRequest {
  // … existing fields …
  status   RefundStatus @default(draft)                             // now may be `paid`
  batchId  String?                                                  // LIVE claim pointer — NULL = eligible; set = in a compiled|paid batch
  batch    RefundBatch? @relation(fields: [batchId], references: [id], onDelete: Restrict)
  batchItems RefundBatchItem[] @relation("BatchItemRequest")
  // … relations …
  @@index([status, batchId, decidedAt])                             // candidate query: approved ∧ batchId NULL ∧ decidedAt<=cutoff
}

model RefundAuditEntry {
  // … existing fields …
  batchId String?                                                   // set on batch_compiled|batch_paid|batch_discarded rows (AC-7.1/7.3)
  batch   RefundBatch? @relation(fields: [batchId], references: [id], onDelete: Restrict)
  // action now includes the three batch actions
  @@index([batchId])
}
```

### Why two membership representations (`batchId` vs `RefundBatchItem`)

- `RefundRequest.batchId` is the **live** "currently claimed by" pointer. It is the dedup key
  for candidate selection (`batchId IS NULL`) and is **nulled on discard** so a released
  request becomes eligible again (AC-6.1). It is overwritten when a released request is claimed
  by a later batch — so it **cannot** preserve history.
- `RefundBatchItem` is the **append-only** record that a request was once in a batch. It is
  **never deleted** (kept through discard), giving AC-6.3 ("which requests it once held"),
  AC-7.3 ("permanently attached even if later discarded and re-included in a different batch"),
  and a stable input set to regenerate a discarded batch's PDF (AC-1.10). `onDelete: Restrict`
  on `request` also makes a batched request physically undeletable, extending 007's AC-8.3.

### Atomic claim / no-double-pay (the concurrency core)

Compile, mark-paid, and discard each run in one `db.$transaction`:

- **Compile claim.** `SELECT id FROM refund_request … WHERE status='approved' AND "batchId" IS
  NULL AND "decidedAt" <= :cutoff [ AND entity-scope ] FOR UPDATE` locks the exact candidate
  rows. Two concurrent compiles serialize on these row locks: the second sees the rows already
  carrying `batchId` (or waits then finds none) and claims **only** what remains — no request
  is ever in two `compiled`/`paid` batches (AC-1.2/1.5). The `UPDATE … SET "batchId"=:B WHERE
  id IN (…) AND "batchId" IS NULL` is an additional compare-and-swap belt. If the locked set is
  empty → **roll back, create nothing**, return 422 (AC-1.4 — no empty batch).
- **mark-paid / discard terminal CAS.** `UPDATE refund_batch SET status=… WHERE id=:B AND
  status='compiled'` — the `status='compiled'` predicate makes the transition happen **exactly
  once**; a `rowCount` of 0 means the batch was already `paid`/`discarded` → 409 (AC-4.3/6.2).
  A concurrent mark-paid vs discard on the same batch: exactly one CAS wins, the loser 409s.
- **mark-paid request flip.** In the same TX: `UPDATE refund_request SET status='paid' WHERE
  "batchId"=:B AND status='approved'` — all-or-nothing (AC-4.1). Requests are already immutable
  (`approved`), so nothing else contends.

### Audit (US-7) — reuse ADR-0018, no new mechanism

Each batch action writes **one `RefundAuditEntry` row per affected request** inside the same
transaction (`writeAuditEntry`, extended to accept `batchId`): `batch_compiled` on compile,
`batch_paid` on mark-paid (this is the per-request `approved → paid` transition record, the
AC-7.1 granularity mirroring 007's per-line rows), `batch_discarded` on discard. All rows carry
`requestId + batchId + actor + createdAt`; the "full set of request IDs affected" (AC-7.1) is
the set of rows sharing that `(batchId, action)`. The existing raising `BEFORE UPDATE/DELETE`
trigger on `refund_audit_entry` covers these new rows unchanged (AC-7.2), and `onDelete:
Restrict` on both new `batchId` FKs preserves the record (AC-7.3). No new trigger.

### Money

Unchanged: integer cents + `Currency` enum, **never blended, never converted** (007 §Money).
Batch/PDF/history totals reuse `computeSubtotals` (`requests.service.ts`) over `approvedTotalCents`,
grouped purely by currency (a batch spanning employees and currencies yields one subtotal per
distinct currency, never one blended figure) — AC-1.6, AC-8.1, spec Non-goals.

---

## API contracts

Base `http://localhost:8082` (local) / prod EU region. All errors RFC-7807 Problem JSON; all
timestamps ISO 8601; amounts integer cents with sibling `currency`. Every route:
`jwtMiddleware` → `authzMiddleware`, plus a small `bodyLimit` (mirrors existing routers).

**Authz per action** (no new catalog action — spec Constraints; the existing `accounting`
and `refund-admin` roles' grants cover all of this):

| Action | Capability gate | Entity scope |
|---|---|---|
| candidates / compile | `hasCapability(request, review)` → else **403** (AC-1.8) | candidate set filtered by `scopeForReviewAction(authz,'review')` (AC-1.2) — entity-scoped user claims only in-scope requests; global/refund-admin claims all |
| get batch / list history / pdf-url / email | `hasCapability(request, review)` → else **403** (AC-2.3/8.3) | **not** entity-scoped — batch-level surfaces are accounting-wide (decided; § Resolved decisions D1) |
| mark-paid | `hasCapability(request, approve)` → else **403** (AC-4.4) | none (whole-batch) |
| discard | `hasCapability(request, review)` → else **403** | none (whole-batch) |

Missing batch id → **404**. Opening an individual request inside a batch is the **existing**
`GET /requests/:id` (007, entity-scoped, ownership/scope → 404) — unchanged (AC-2.2).

### Endpoints

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `GET /batches/candidates?cutoff=<ISO?>` | – | 200 `CandidatePreview` | 403 (no `request:review`) |
| `POST /batches` | `{cutoff?: ISO}` | 201 `BatchDetail` | 403; **422** empty candidate set (AC-1.4) |
| `GET /batches` | – | 200 `BatchSummary[]` (all statuses, AC-8.2) | 403 |
| `GET /batches/:id` | – | 200 `BatchDetail` (+ fresh `pdf`) | 403; 404 |
| `GET /batches/:id/pdf-url` | – | 200 `{url, expiresAt}` (presigned GET ~60s) | 403; 404 |
| `POST /batches/:id/email` | – | 200 `{emailStatus, emailDeliveryId?}` (any status, AC-3.3) | 403; 404 |
| `POST /batches/:id/mark-paid` | – | 200 `BatchDetail` | 403; 404; **409** if not `compiled` (AC-4.3) |
| `POST /batches/:id/discard` | – | 200 `BatchDetail` | 403; 404; **409** if not `compiled` (AC-6.2) |

### Shapes

```jsonc
// CandidatePreview — dry run, writes nothing (US-2)
{ "cutoff":"2026-07-19T00:00:00Z", "requestCount":7,
  "subtotals":[{"currency":"CHF","approvedCents":120000},{"currency":"EUR","approvedCents":98050}],
  "employees":[ {"owner":{"userId":"…","email":"a@welld.ch","name":"…"},
                 "requestIds":["…"],
                 "subtotals":[{"currency":"EUR","approvedCents":4550}]} ] }

// BatchSummary (history row, AC-8.1)
{ "id":"…","cutoff":"…","status":"compiled|paid|discarded","requestCount":7,
  "subtotals":[{"currency":"EUR","approvedCents":98050}],
  "emailStatus":"sent|failed|null","createdAt":"…" }

// BatchDetail (AC-2.1)
{ "id":"…","cutoff":"…","status":"compiled","requestCount":7,
  "createdBy":{"userId":"…","email":"acct@welld.ch"},"createdAt":"…",
  "subtotals":[…],
  "employees":[ {"owner":{…},"requests":[{"id":"…","status":"approved","subtotals":[…]}]} ],
  "email":{"status":"sent","lastAttemptAt":"…"},
  "paidAt":null,"paidBy":null,"discardedAt":null,"discardedBy":null,
  "pdf":{"url":"https://<eu-bucket>/…?X-Amz-Signature=…","expiresAt":"…"} }   // minted post-authz, ~60s
```

`subtotals` reuse `computeSubtotals` (per-currency, `approvedCents`). The `pdf` link is minted
only after the capability check passes and is **accounting-only** — never returned to, or
reachable by, the employee `GET /requests/:id` (AC-3.4).

---

## Email

**On compile (AC-3.1) and on resend (AC-3.3):** refund-api's new `notifyEmail.ts` calls
notify-api `POST /system/emails` (`X-Internal-Token`, reusing `NOTIFY_INTERNAL_URL`/
`NOTIFY_INTERNAL_TOKEN`) with:

```jsonc
{ "to": "<REFUND_ACCOUNTING_DISTRIBUTION_EMAIL>",          // single configured address (AC-3.1/3.4); never a per-employee address
  "template": "refund_batch_compiled",
  "data": { "batchUrl": "<REFUND_APP_BASE_URL>/refund/batches/<id>",   // APP DEEP LINK — see below
            "batchReference": "<id>", "cutoff":"…", "generatedAt":"…", "requestCount": 7 } }
```

**The email carries an in-app deep link, NOT a presigned S3 URL and NOT the PDF** (Non-goal;
AC-3.5). This is dictated by AC-3.5's "**no standalone, unauthenticated, or permanent access**"
clause: a raw presigned URL is by definition standalone + unauthenticated, so it is disallowed.
Clicking the link lands on `/refund/batches/:id` in refund-ui; the shell's auth guard forces
sign-in if needed, then the page fetches the PDF through the **authz-gated** `GET
/batches/:id/pdf-url`, which mints the short-lived presigned GET (~60s, ADR-0016) **after** the
same `request:review` check that gates opening the batch in-app. The "short bounded window"
of AC-3.5 is realized by that post-authz presigned GET, not by the email link — resolving
AC-3.5's "signed download link … expires" wording (decided; § Resolved decisions D2).

**Soft-failure (AC-3.1/4.2, ADR-0011 posture):** `notifyEmail.ts` never throws; a Resend/
network/non-2xx outcome is caught, logged (no financial/PII detail — only batch id + status),
and the returned `status` (`sent`/`failed`) + `deliveryId` are persisted on the batch
(`emailStatus`/`emailLastAttemptAt`/`emailDeliveryId`) for AC-3.2 display. Compilation itself
never blocks or fails on an email failure; mark-paid never requires a successful send (AC-4.2).

**notify-api changes (additive, no attachment support):**
- `EMAIL_TEMPLATES` += `"refund_batch_compiled"`.
- `emails.schemas.ts`: `data` becomes **per-template** (a `superRefine`/discriminated shape on
  the sibling `template`): the `invitation*` templates keep their existing
  `{inviteUrl,inviterName,expiresAt}`; `refund_batch_compiled` requires
  `{batchUrl, batchReference, cutoff, generatedAt, requestCount}`. Existing invitation callers
  are unaffected.
- `emailTemplates.ts`: new render branch, **English-only** (Non-goal: no IT for refund v1),
  every field HTML-escaped exactly as today (fixed template, no injection surface), well within
  the 16 KiB cap.

**Employee `paid` push (US-5, AC-5.1):** on mark-paid, after commit, refund-api calls
`POST /system/notifications` (ADR-0017) **once per included request's owner** (best-effort,
never rolls back the transition). Copy is generic ("Refund paid", link
`/refund/requests/:id`) — no amount/other-employee detail in the push (ADR-0017 posture), the
concrete `paid` state and `paidAt` live behind the already access-controlled
`GET /requests/:id`. Each owner receives only their own request's push (recipient =
that request's `ownerUserId`).

---

## Object storage

- **Key namespace:** `refund/batches/{batchId}/compiled.pdf` — batch-scoped, non-guessable id,
  no employee/PII in the key. Deliberately under `refund/batches/…`, **separate** from the
  `refund/{requestId}/…` receipt namespace, so any bucket lifecycle rule that expires
  unconfirmed *receipt* uploads (007 R4) can never catch a batch PDF.
- **Write:** refund-api `PutObject`s the bytes it generated (new `storage.putObject`). This is
  the one place refund-api touches object bytes — legitimate because it **authored** them
  (unlike receipts, which it never handles). `Content-Type: application/pdf`.
- **Retention: indefinite** (AC-1.10) — **no** lifecycle-expiry rule on `refund/batches/…`,
  regardless of the batch's eventual status. Mirrors 007's never-delete posture for financial
  records (ADR-0018).
- **Download:** short-lived (~60s) presigned GET via the existing `mintPresignedGet`, minted
  **only after** the `request:review` capability check passes (in `GET /batches/:id` and
  `GET /batches/:id/pdf-url`). Bucket stays private (no public read). Accounting/refund-admin
  only; **never** minted on any employee-reachable route (AC-3.4).
- If the object is missing at mint time (rare first-render-failure), refund-api regenerates it
  from the frozen `RefundBatchItem` set and `PutObject`s before minting (regenerable-cache
  posture, above).

### env additions (`refund-api/src/lib/env.ts`, validated at startup, `process.exit(1)` on missing)

- `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — the single configured recipient (spec Constraints:
  the exact value is a deploy concern; a per-user/role-resolved list is a Non-goal).
- `REFUND_APP_BASE_URL` — absolute base for the email deep link (the shell/refund public URL).
- Reuses existing `NOTIFY_INTERNAL_URL` / `NOTIFY_INTERNAL_TOKEN` (now used for `/system/emails`
  as well as `/system/notifications`).

---

## Test strategy

Levels: **unit** (candidate predicate, cutoff defaulting, subtotal/PDF-content grouping,
scope resolution, status/CAS guards, per-template email data validation, pure PDF layout
assertions on rendered text runs), **integration** (refund-api routes vs a real test
PostgreSQL, with `/authz/resolve`, S3, `/system/emails`, `/system/notifications` mocked —
adversarial on every authz/concurrency/terminal path), **e2e** (refund-ui in the shell via
Playwright, seeded session). Provision grants in setup: accounting-path tests seed the
`accounting` role (entity-conditioned, or an unconditioned `review` grant for the global case);
mark-paid tests additionally need `request:approve`; employee-path tests seed the employee
refund grants. The AC→test map is **total** (all 36 ACs across US-1..US-8; the brief's "35" is
36 by count):

| AC | Level | What proves it |
|---|---|---|
| 1.1 cutoff specifiable, defaults to now | unit + integration | compile with/without `cutoff`; default resolves to ~now |
| 1.2 candidate set = approved ∧ decidedAt≤cutoff ∧ unbatched ∧ in scope | integration | seed approved/other-status/future-decided/already-batched/out-of-scope → only the eligible in-scope ones claimed |
| 1.3 mixed-entity request enters whole, never split | integration | welld_it-scoped compile claims a welld_it+welld_ch request wholly; both its lines in the PDF |
| 1.4 empty candidate set refused, nothing created | integration | compile with no eligibles → 422; no `RefundBatch`/item/audit/PDF/email produced |
| 1.5 non-empty compile → batch `compiled`, requests become ineligible | integration | after compile, a second compile of same cutoff yields 0 candidates |
| 1.6 PDF: per-employee sections, per-currency subtotals, header (cutoff/ts/user/ref) | unit | render → assert text runs: employee sections, `EUR …`/`CHF …` subtotals never blended, header fields present |
| 1.7 PDF never embeds receipt files | unit | render carries no attachment bytes/refs; only textual summary |
| 1.8 non-accounting/non-refund-admin cannot compile | integration | no `request:review` → `POST /batches` 403 |
| 1.9 $0-approved requests eligible on same terms | integration | all-zero-approved approved request appears in candidate set + batch |
| 1.10 PDF retained indefinitely across statuses | integration | no expiry/delete path; discarded/paid batch PDF still mintable |
| 2.1 open compiled batch: metadata + requests-by-employee + PDF | integration | `GET /batches/:id` fields present; `pdf.url` minted |
| 2.2 opening a request in a batch uses 007 entity-scope rules | integration | `GET /requests/:id` for an out-of-scope accounting user still 404 regardless of batch membership |
| 2.3 non-accounting/non-refund-admin cannot open batch/PDF | integration | no `request:review` → `GET /batches/:id` + `/pdf-url` 403 |
| 3.1 compile auto-attempts email w/ signed link, best-effort, non-blocking | integration | compile calls `/system/emails` with `refund_batch_compiled` + `batchUrl`; a mocked email failure still returns 201 |
| 3.2 email delivery status visible on the batch | integration | `emailStatus` reflects mocked sent/failed on `GET /batches/:id` |
| 3.3 resend mints fresh link, same address, any status, no recompile | integration | `POST /batches/:id/email` on compiled/paid/discarded → new `/system/emails` call, batch set/PDF unchanged |
| 3.4 link never emailed to individual employees; only distribution address | integration | `to` == configured address only; assert no employee address is a recipient |
| 3.5 link resolves to PDF only after authz + short-lived, no standalone access | integration + unit | email body is an app deep link (no presigned URL); `pdf-url` 403 without `request:review`; minted URL carries a short expiry |
| 4.1 mark-paid: batch→paid + all requests approved→paid atomically | integration | `POST mark-paid` → batch `paid`, every request `paid`; forced mid-TX failure leaves all `approved` (all-or-nothing) |
| 4.2 mark-paid not gated on email delivery success | integration | mark-paid succeeds with `emailStatus:"failed"` |
| 4.3 paid/discarded batch cannot be marked paid (terminal, once) | integration | second mark-paid → 409; concurrent double mark-paid → exactly one 200, one 409 |
| 4.4 mark-paid gated by the same accounting/refund-admin decision capability | integration | no `request:approve` → `POST mark-paid` 403; accounting & refund-admin succeed |
| 5.1 owner notified on approved→paid via notification center | integration | mark-paid → `POST /system/notifications` per owner with that owner's `recipientId`, originApp `refund` |
| 5.2 paid request reads as `paid`, distinct, with paid date | integration + e2e | detail `status:"paid"` + `paidAt`; badge distinct |
| 5.3 monthly-processing note gone for paid | e2e | paid detail hides the 007 note; no batch composition shown |
| 5.4 paid keeps per-line requested-vs-approved | integration | paid detail still exposes both amounts per line |
| 5.5 non-owner non-accounting still denied viewing (incl. paid) | integration | foreign user `GET /requests/:id` on a paid request → 404 |
| 6.1 discard compiled batch → discarded, requests released to pool | integration | `POST discard` → batch `discarded`, requests `batchId` NULL + still `approved`; next compile re-includes them |
| 6.2 paid batch cannot be discarded | integration | discard on a paid batch → 409 |
| 6.3 discarded batch remains inspectable (which requests, who, when) | integration | `GET /batches/:id` on discarded shows membership (from `RefundBatchItem`) + discardedBy/At |
| 7.1 audit on compile/discard/mark-paid incl. per-request paid transition | integration | `batch_compiled`/`batch_discarded`/`batch_paid` rows per affected request, with actor/ts/batchId |
| 7.2 batch audit immutable to any user incl. admin | integration | direct UPDATE/DELETE on a batch audit row blocked by the trigger; no route exists |
| 7.3 batch membership permanently attached even after discard + re-inclusion | integration | discard batch A, compile B with same request → `RefundBatchItem` + audit rows for BOTH A and B persist |
| 8.1 history lists every batch w/ cutoff, status, count, per-currency totals | integration | `GET /batches` fields present |
| 8.2 history includes every status (not only compiled) | integration | compiled+paid+discarded all present in list |
| 8.3 non-accounting/non-refund-admin cannot open history | integration | no `request:review` → `GET /batches` 403 |

**Headline e2e (Playwright, shell + refund-ui):** accounting picks a cutoff → previews
candidates → compiles → sees the batch + PDF + "email sent" → marks paid; employee then sees
their request flip to `paid` with `paidAt`, the notification, and the monthly note gone. Plus a
discard-then-recompile journey.

**Adversarial coverage (feeds the owasp pass):** compile/mark-paid/discard capability-403;
`pdf-url` accounting-only (never employee-reachable) and IDOR on `pdfObjectKey`; concurrent
compile never double-claims (row-lock + `batchId IS NULL` CAS); concurrent mark-paid/discard
terminal-once (batch-row CAS); empty-batch refusal; audit-immutability trigger under direct
SQL for batch rows; email `to` is only the configured address; `/system/emails` per-template
`data` validation rejects a malformed refund payload; the cross-entity-PII exposure of a global
batch PDF to an entity-scoped accounting user (§ Resolved decisions D1).

---

## Risks

| # | Risk | Mitigation / early check |
|---|---|---|
| R1 | **PDF `PutObject` fails after the compile TX commits** → batch `compiled` with no object. | The PDF is a **regenerable pure function** of the frozen `RefundBatchItem` set; `pdf-url`/email lazily (re)render+store on miss. Avoids a 4th "compiling" state. Test the missing-object mint path. |
| R2 | **Concurrent compiles double-claim** a request. | `SELECT … FOR UPDATE` on candidates + `UPDATE … WHERE batchId IS NULL` CAS in one TX; integration test with two overlapping compiles asserts disjoint claims. |
| R3 | **Concurrent mark-paid vs discard** on one batch. | Batch-row `WHERE status='compiled'` CAS → exactly one wins; the other 409s. Terminal-once test. |
| R4 | **Cross-entity PII in a global batch's PDF** viewable by an entity-scoped accounting user — an accepted v1 trade-off (batch reads are capability-gated, not entity-scoped; § Resolved decisions D1). | Named for the owasp pass; the exposure is confined to the single configured distribution mailbox for email, and to `request:review` holders in-app. |
| R5 | **notify fan-out on mark-paid** (N owners) — a partial failure loses some `paid` pushes. | Per-owner best-effort after commit; failures logged; employees always see `paid` on `GET /requests/:id` (the DB is source of truth, ADR-0017). |
| R6 | **`RefundStatus` enum add-value migration** ordering (PG can't `ADD VALUE` in a txn on older engines). | Emit the `ADD VALUE` as its own statement before dependent DDL; verify on the target PG 17. |
| R7 | **PDF currency-glyph gaps** with a standard font. | Render ISO currency codes (`EUR`/`CHF`/`GBP`/`USD`), not symbols; unit-assert rendered text. |
| R8 | **Batch PDF caught by a receipt lifecycle-expiry rule** → violates AC-1.10. | Separate key namespace `refund/batches/…`; assert no expiry rule targets it; deploy checklist item. |
| R9 | **refund-api now hard-depends on notify-api `/system/emails`** in addition to `/system/notifications`. | Both are best-effort and never block compile/mark-paid; only in-app status display degrades on a notify-api outage. |

---

## Security

**Security-sensitive? YES.** This feature adds a **money-moving terminal action**
(`mark-paid`), aggregates **multiple employees' financial data + PII into one batch PDF**,
stores that PDF in **object storage behind signed links**, and drives **cross-user email and
in-app notification fan-out**. Every trigger in the rubric fires (payments, PII, file/object
storage, outbound email, cross-user authorization), and the data is regulated-sector-adjacent
(wellD serves finance/healthcare/energy; this stage reaches payroll). The orchestrator should
schedule an **`owasp-reviewer` pass in parallel with QE, at the frontier tier**, consistent
with 007's rating.

**Surfaces to review (named):**
- `POST /batches` (compile), `POST /batches/:id/mark-paid`, `POST /batches/:id/discard` —
  capability-403 gating (review vs approve, AC-1.8/2.3/4.4/8.3); the **atomic claim** (FOR
  UPDATE + `batchId IS NULL` CAS, no double-claim) and **terminal CAS** (paid/discard once,
  no reopen — AC-4.3/6.2).
- `GET /batches/:id` + `GET /batches/:id/pdf-url` — the presigned PDF link is minted **only**
  after authz, is **accounting-only**, and is **never** reachable from any employee route
  (AC-3.4); IDOR on `pdfObjectKey`; private-bucket assumption.
- **Cross-entity PII exposure** — batch-level reads are capability-gated, not entity-scoped
  (a decided v1 trade-off, § Resolved decisions D1): an entity-scoped accounting user can see a
  global batch's cross-entity PDF. Confirm the exposure is adequately bounded (private bucket,
  post-authz short-lived mint, single configured email recipient).
- The compilation **email**: `to` is only the configured distribution address (never an
  employee, AC-3.4); the body is an **app deep link, not a presigned/standalone URL**
  (AC-3.5 "no standalone, unauthenticated, or permanent access"); notify-api's new template is
  fixed + fully escaped (no injection), per-template `data` validation, 16 KiB cap.
- **notify fan-out** on mark-paid — each `recipientId` is the request's own owner (no
  cross-user leak; the generic push carries no other-employee/financial detail, ADR-0017).
- **Audit immutability** for the three new batch actions (reused ADR-0018 trigger) and
  `onDelete: Restrict` retention of batch/membership records.

---

## ADR candidates

1. **Server-side PDF generation with `pdf-lib` in refund-api** — pure-TS, Bun-compatible, no
   headless browser in the container; the compiled PDF is a **deterministic, regenerable pure
   function** of the batch's frozen membership (stored as a private EU object, ADR-0016);
   ISO-code currency rendering. Establishes the suite's document-generation pattern.
2. **Batch/`paid` lifecycle extension** — **supersedes 007's "no fifth `RefundStatus` value"
   freeze** by adding terminal `paid`; introduces `RefundBatch` + the **live-claim pointer
   (`RefundRequest.batchId`) vs immutable membership (`RefundBatchItem`)** split, the atomic
   compile-claim, and the terminal mark-paid/discard CAS. Extends ADR-0015/0018.
3. **Accounting-only signed-link email delivery** — the compilation email carries an
   **app-authz-gated deep link, not a raw presigned URL and not a binary attachment**
   (resolving AC-3.5's "no standalone/unauthenticated access"); refund-api becomes a second
   `/system/emails` caller; notify-api gains a per-template `data` shape + one English-only
   template, **without** attachment support (Non-goal). Extends ADR-0011.
4. **Batch audit as an extension of ADR-0018** (combinable with #2) — `batchId` on
   `RefundAuditEntry`, per-request `batch_compiled|batch_paid|batch_discarded` rows, reusing
   the existing immutability trigger and `onDelete: Restrict` retention.

---

## Resolved decisions (2026-07-19)

The three interpretations the plan flagged were confirmed by the user on 2026-07-19 and are now
settled facts — no content change follows from them, they are recorded here so the plan reads
clean for Gate 2.

- **D1 — batch reads are capability-gated, NOT entity-scoped (global).** Any user holding the
  accounting/`refund-admin` refund capability (`request:review`) can list every batch and open
  every batch's PDF regardless of their own entity scope (AC-2.1/8.1/8.2 read literally —
  "every batch is listed"). Entity scope applies ONLY to *candidate selection at compile*
  (AC-1.2) and to *opening an individual request* (AC-2.2, the existing 007 rule). The accepted
  v1 trade-off: an entity-scoped accountant can see cross-entity employee financial data in a
  global batch's compiled PDF; this is bounded by the private bucket, the post-authz short-lived
  presigned mint, and the single configured email recipient (named for the owasp pass, R4).
- **D2 — the compilation email carries an in-app deep link.** It links into refund-ui
  (`/refund/batches/:id`); the recipient must be signed in, the app runs the `request:review`
  authorization check, and only then mints a short-lived signed GET — there is no standalone,
  unauthenticated, or permanent PDF access (AC-3.5). The email never carries a presigned URL or
  a binary attachment (Non-goal).
- **D3 — `mark-paid` is gated on `request:approve`.** It reuses the existing accounting/
  `refund-admin` refund-decision capability (spec's "reuse existing capability", AC-4.4); no new
  permission or role. The `accounting` and `refund-admin` roles always grant approve+reject+
  review together, so this introduces no divergence for any real user.

## Note

`status: draft` — only the human user approves. No ADRs are written here (candidates above are
for the `adr-writer` agent after approval). No source outside this file is modified.
