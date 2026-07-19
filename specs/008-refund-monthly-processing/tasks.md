---
spec: 008
generated: 2026-07-19
---

# Tasks: Monthly refund processing

Derived from the approved `plan.md` + `design.md`. Extends the shipped refund-api / refund-ui /
notify-api (specs/007) — reuse its patterns. Tracks: **R** refund-api, **N** notify-api,
**U** refund-ui, **D** devops, **V** verification. Conventions: TypeScript only; money = integer
cents, per-currency (EUR/CHF/USD/GBP), never blended; RFC-7807 errors; audit every batch
transition (append-only `RefundAuditEntry`, ADR-0018/0022); reuse accounting/`refund-admin`
authz (`request:review` for compile/reads/email/discard, `request:approve` for mark-paid);
English-only UI copy via `strings.ts`.

---

## refund-api (backend)

- [x] T1: Migration + schema — `paid` status, batch tables, audit extension — refs: AC-1.x (model), AC-4.1, AC-7.1 — deps: none
  - touch: `refund-api/prisma/schema.prisma`, new migration `refund-api/prisma/migrations/*_add_batches/`
  - Add `RefundStatus` value `paid` (in its **own** statement before table DDL — `ALTER TYPE … ADD VALUE` can't share a tx with dependent DDL, ADR-0020); `enum BatchStatus { compiled paid discarded }`; `AuditAction` += `batch_compiled|batch_paid|batch_discarded`. New `RefundBatch` (cutoff, status, `pdfObjectKey @unique`, email status fields, paid/discarded stamps) + append-only `RefundBatchItem` (`@@unique([batchId,requestId])`, `onDelete: Restrict`). `RefundRequest.batchId?` (live claim pointer) + `RefundAuditEntry.batchId?`. Indexes per plan (candidate query `@@index([status,batchId,decidedAt])`). Never edit 007's migrations.
  - done when: `bun run db:migrate` applies cleanly (enum-value-then-DDL ordering works); `bun run db:generate` + `bun run typecheck` green; a test asserts the enum/table shape.

- [x] T2: Batch PDF generation (`pdf-lib`) + storage — refs: AC-1.9, AC-1.10, AC-2.4 — deps: T1
  - touch: `refund-api/src/batches/pdf.ts` (+ test), `refund-api/src/lib/storage.ts` (put helper), `package.json` (add `pdf-lib`)
  - Pure, deterministic renderer: input = a batch's `RefundBatchItem` set (per-employee → per-currency approved totals, cutoff, batch id/ref), output = a PDF buffer (numeric summary mirroring the source form; per-currency, never blended). Store at `refund/batches/{id}/compiled.pdf` (no PII in key) in the private EU bucket (ADR-0016). Regenerable cache (ADR-0019) — a discarded batch's PDF still resolves from its immutable items.
  - done when: unit tests render a deterministic PDF for a fixed multi-employee/multi-currency batch (byte-stable enough to assert key content via a text-extract or fixture), storage put mocked; no headless browser dependency.

- [x] T3: Candidate preview + compile (atomic claim) — refs: AC-1.1–1.8, AC-7.1 — deps: T2
  - touch: `refund-api/src/batches/` (schemas, repo, service, routes), `src/index.ts`, OpenAPI
  - `GET /batches/candidates?cutoff=` → eligible `approved ∧ batchId IS NULL ∧ decidedAt<=cutoff`, entity-scoped via `scopeForReviewAction` (AC-1.2); grouped per-employee/per-currency. `POST /batches` (compile) → in one `$transaction`: `SELECT … FOR UPDATE` + `batchId IS NULL` CAS claim, create `RefundBatch` + `RefundBatchItem`s, set `RefundRequest.batchId`, write `batch_compiled` audit rows; then generate+store the PDF (T2) post-commit (regenerable). Empty candidate set → refuse (422/409 per spec AC-1.5). `hasCapability(request,review)` else 403.
  - done when: integration tests prove entity-scoped candidate filtering, the atomic claim (two concurrent compiles never double-claim — AC-1.2/1.5), empty-set refusal, audit rows written, and the batch is created with items + PDF key.

- [x] T4: Batch reads — get batch, list history, signed PDF URL — refs: AC-2.1–2.3, AC-8.1–8.3 — deps: T3
  - touch: `refund-api/src/batches/*` (read routes)
  - `GET /batches` (history, capability-gated, NOT entity-scoped — D1), `GET /batches/:id` (detail incl. per-employee/per-currency + email/paid/discarded status; 404 if missing), `GET /batches/:id/pdf-url` (mint short-lived authz-gated presigned GET — accounting-only, never employee-reachable, AC-3.4). Opening an individual request stays the existing 007 `GET /requests/:id` (entity-scoped, unchanged).
  - done when: integration tests cover capability-gated list/get (403 for non-accounting), the signed-URL mint only after authz, and 404 on missing batch.

- [x] T5: Compilation email — send/resend (app deep link) — refs: AC-3.1–3.5 — deps: T4, T7
  - touch: `refund-api/src/batches/email.*`, `refund-api/src/lib/notify.ts` (or a new email caller), env `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` + deep-link base URL
  - On compile, auto-send (and a manual **resend** action) a compilation email to the configured accounting distribution address via notify-api `POST /system/emails` (new template T7) carrying an **app deep link** `/refund/batches/:id` (NOT a presigned URL, NOT an attachment — ADR-0021). Best-effort (soft-fail, AC-3.3): record `emailStatus`/`emailLastAttemptAt`/`emailDeliveryId` on the batch; never roll back the compile. `hasCapability(request,review)`.
  - done when: integration tests (notify-api mocked) prove send-on-compile + resend fire `/system/emails` with the deep link + configured recipient, emailStatus is tracked, and a mocked email failure doesn't fail the compile.

- [x] T6: Mark-paid (terminal CAS + employee notify) — refs: AC-4.1–4.4, AC-5.x, AC-7.2 — deps: T3
  - touch: `refund-api/src/batches/decide.*`, reuse `src/lib/notify.ts` (ADR-0017)
  - `POST /batches/:id/mark-paid` → one `$transaction`: terminal CAS `UPDATE refund_batch SET status='paid' WHERE id=:B AND status='compiled'` (rowCount 0 → 409, AC-4.3), flip `UPDATE refund_request SET status='paid' WHERE batchId=:B AND status='approved'` (all-or-nothing), write `batch_paid` audit rows, stamp `paidAt`/`paidByEmail`. **`hasCapability(request,approve)`** else 403 (AC-4.4). Post-commit: fan out a per-owner in-app `paid` notification (reuse ADR-0017 `/system/notifications`), best-effort. Terminal — no undo.
  - done when: integration tests cover the CAS (double mark-paid → 409; concurrent mark-paid vs discard → exactly one wins), the all-or-nothing request flip, audit rows, the approve-capability gate, and the per-owner notify fan-out (mocked).

- [x] T7: notify-api — batch-compilation email template — refs: AC-3.1, AC-3.4 — deps: none
  - touch: `notify-api/src/system/emailTemplates.ts`, `emails.schemas.ts` (new template enum + its `data` shape), tests
  - Add ONE new English-only template for the batch-compilation email: subject + body carrying the app deep link (`/refund/batches/:id`) and a batch reference — escaped, fixed shape (ADR-0011). Do NOT add attachment support. Extend the `/system/emails` template enum + per-template data validation only.
  - done when: `bun test` + `bun run typecheck` green in notify-api; a test renders the new template with a deep link and asserts escaping + the fixed shape; the internal-token gate is unchanged.

- [x] T8: Discard a compiled batch — refs: AC-6.1–6.3, AC-7.3 — deps: T3
  - touch: `refund-api/src/batches/decide.*`
  - `POST /batches/:id/discard` → terminal CAS (`status='compiled'` → `discarded`; else 409, AC-6.2), null `RefundRequest.batchId` for the batch's requests (release back to the candidate pool — they become eligible again), KEEP `RefundBatchItem` rows forever (AC-6.3/7.3, the PDF still resolves), write `batch_discarded` audit rows, stamp `discardedAt`/`discardedByEmail`. `hasCapability(request,review)`.
  - done when: integration tests prove release-to-pool (a discarded batch's requests reappear as candidates), item-rows retained, the discarded PDF still resolves, terminal CAS 409s, and audit rows written.

## refund-ui (frontend)

- [x] T9: Batch foundation — routes, api client, nav, paid badge — refs: AC-5.3 (paid display), routing — deps: none
  - touch: `refund-ui/src/router.tsx` (+`/refund/batches`, `/batches/new`, `/batches/$id`), `src/lib/batchesApi.ts`, `src/components/RefundShell.tsx` (+nav item, accounting-gated), `src/components/RequestStatusBadge.tsx` (+`paid` variant, glyph+text+color), `strings.ts`
  - done when: `pnpm build`+`lint` green; router mounts the 3 batch routes (placeholder screens); `RequestStatusBadge` renders the `paid` variant (test); no hardcoded strings.

- [x] T10: Batch components — refs: AC-1.x/2.x display, AC-2.4 (PDF) — deps: T9
  - touch: `refund-ui/src/components/` — `BatchStatusBadge` (compiled/paid/discarded), `BatchSubtotalsPanel`, `BatchEmployeeGroupList` (modes `preview`|`detail`), `BatchPdfLink` (mint-on-click signed GET, mirrors `AttachmentDownloadLink`), `formatBatchSubtotalsPreview` (lib)
  - done when: component tests cover the badges (glyph+color, non-color signal), the per-employee/per-currency group rendering, and `BatchPdfLink` mints on click (mocked); `pnpm test` green.

- [x] T11: Screen B2 — Compile & preview — refs: AC-1.1–1.8 — deps: T10
  - touch: `refund-ui/src/pages/CompileBatchPage.tsx` (+test)
  - Cutoff picker → Preview (candidate set via `GET /batches/candidates`, per-employee/per-currency, `BatchSubtotalsPanel`) → Compile (frozen-cutoff WYSIWYG; `ConfirmDeleteModal` `tone="positive"`), empty-set refusal, loading/empty/error/PD states. On success → land on the batch detail (B3). Integrates T3.
  - done when: tests cover preview rendering, empty-set refusal messaging, compile→navigate-to-detail, and the PD (non-accounting) state.

- [x] T12: Screen B3 — Batch detail (+ mark-paid, discard, email, PDF) — refs: AC-2.1–2.4, AC-3.2, AC-4.1–4.4, AC-6.1–6.3 — deps: T10
  - touch: `refund-ui/src/pages/BatchDetailPage.tsx` (+test), `src/components/MarkPaidDialog.tsx` (NEW — checkbox-gated confirm) (+test)
  - Header (`BatchStatusBadge`, cutoff, generated-at/by, ref), overall + per-employee groups (rows link to `/refund/review/$id`), **Download PDF** (`BatchPdfLink`), email status + **Resend** (`ToastBanner` feedback), **Mark-as-paid** (`MarkPaidDialog` — high-stakes checkbox-gated, focus-trapped, irreversible wording), **Discard** (`ConfirmDeleteModal` destructive). 409 races → `GuardrailDialog`. Status-driven variants (compiled/paid/discarded). This is also the email deep-link landing page. Integrates T4/T5/T6/T8.
  - done when: tests cover the status variants, MarkPaidDialog's disabled-until-checkbox + focus trap, mark-paid/discard success + 409 guardrail, resend toast, and PDF mint; a11y (focus-on-transition, `aria-live`).

- [x] T13: Screen B1 — Batch history + employee `paid` display — refs: AC-8.1–8.3, AC-5.1–5.3 — deps: T10
  - touch: `refund-ui/src/pages/BatchHistoryPage.tsx` (+test), `src/pages/RequestDetailPage.tsx` + `ReviewDetailPage.tsx` (+`paid` render branch)
  - B1: batch list (cutoff, `BatchStatusBadge`, count, per-currency totals) → open B3; loading/empty/error/PD. Employee/accounting request detail gains a `paid` branch (the `RequestStatusBadge` `paid` variant; 007's US-4 "on your paycheck" messaging now real). Confirm the employee wire contract for `batchId` (design note #4 — coordinate with T4).
  - done when: tests cover the history list + PD, and the `paid` request-detail branch; no hardcoded strings.

## DevOps

- [x] T14: Config/deploy wiring — refs: AC-3.1 (recipient), AC-2.4 (deep-link base) — deps: T1
  - touch: `refund-api/.env.example`/`.envrc`, root `mise.toml`/`compose.yaml` if needed, deploy config, `notify-api` env if the template needs config
  - Add `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` + the app base URL used to build batch deep links (`/refund/batches/:id`) to refund-api env (validated at startup). Document prod values (1Password). No new bucket (reuse 007's).
  - done when: refund-api starts with the new required env; `.env.example` documents them; local dev works.

## Verification & close

- [ ] T15: E2E headline journey (Playwright) — refs: AC-1.x, AC-3.x, AC-4.x, AC-5.x — deps: T11, T12, T13, T5, T6
  - touch: `shell/e2e/` (per specs/007 convention)
  - Journey: accounting sets a cutoff → previews → compiles a mixed-employee/mixed-currency batch → downloads the PDF + sees the email status → marks paid → the employee sees their request as `paid`; plus a discard→re-eligible path.
  - done when: the e2e journeys pass against the running stack (attachments/email mocked where a live bucket/Resend isn't available — report honestly).

- [ ] T16: Close — all gates green, spec status → done — refs: (all) — deps: T1–T15
  - done when: every task checked; QE PASS + owasp resolved; a fresh passing `eval-report.md`; then `/wellforge:done 008-refund-monthly-processing`.

---

## AC coverage (both directions)
| AC group | Covered by |
|---|---|
| US-1 (compile/candidates/claim) | T1, T2, T3, UI T11 |
| US-2 (inspect/PDF) | T4, UI T12 |
| US-3 (email link) | T5, T7, UI T12 |
| US-4 (mark-paid) | T6, UI T12 |
| US-5 (employee sees paid) | T6, T9, UI T13 |
| US-6 (discard) | T8, UI T12 |
| US-7 (audit) | T1 (schema), T3/T6/T8 (writes) |
| US-8 (batch history) | T4, UI T13 |
| Enablers | T9 (ui foundation), T10 (components), T14 (devops config) |

## Parallelization
- **Wave 1 (no deps):** T1 (refund-api schema), T7 (notify template), T9 (ui foundation) — parallel, disjoint services.
- **Wave 2:** T2 (after T1) · T10 (after T9) · T14 (after T1).
- **Wave 3:** T3 (after T2) · T11 (after T10).
- **Wave 4:** T4→{T5,T6,T8} (backend batch ops) · T12,T13 (after T10).
- **Wave 5:** T15 (e2e) → T16 (close).
BE (refund-api/notify-api) and FE (refund-ui) tracks are dependency-independent until integration
(the UI screens exercise the batch endpoints) — run as parallel worktree-isolated batches.
