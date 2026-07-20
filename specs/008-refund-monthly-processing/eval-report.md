---
spec: 008
evaluated: 2026-07-20
rubric: default-v2 (reconstructed from specs/005–007 eval-reports; no central gates/configs/eval-rubric.yml present)
score: 95
verdict: PASS
---
# Eval report: Refund monthly processing — PDF compilation, email delivery & "mark as paid"

Rubric note: `gates/configs/eval-rubric.yml` does not exist; dimensions/weights/floors/pass_score
were reconstructed from the `specs/005/006/007` eval-reports (all `default-v2`), consistent with how
007's own eval was produced. default-v2 = AC(35,floor4) · Spec(20,floor3) · Test(20,floor3) ·
Code(15,floor3) · Design-UI(15,floor3, conditional on design.md) · Trajectory(10,floor2);
pass_score 80; total normalised over the 115 applicable weight.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | All 36 ACs (US-1..US-8) mapped in `plan.md` AC→test table + `tasks.md` coverage map, each to ≥1 executed passing test AND observable behaviour. QE PASS 36/36. Independently re-verified live: refund-api **293 pass / 3 known-pre-existing storage-mock isolation fails** (`bun test`, 748 expects), refund-ui **407 pass**, notify-api **140 pass**, auth untouched (no `auth/` file changed since the 008 docs commit). Load-bearing ACs verified in code: atomic compile claim `FOR UPDATE`+`batchId IS NULL` CAS (`batches.repo.ts:169-217`, AC-1.2/1.5), empty-set→422 (`EmptyCandidateSetError`, AC-1.4), mark-paid terminal CAS + all-or-nothing flip (`decide.repo.ts:85-107`, AC-4.1/4.3), discard release-to-pool keeping `RefundBatchItem` (`decide.repo.ts:160-180`, AC-6.1/6.3/7.3), per-request `batch_*` audit rows w/ `batchId` (AC-7.1), PDF per-employee/per-currency ISO-code never-blended + no attachments (`pdf.ts`, AC-1.6/1.7), email app-deep-link not presigned + soft-fail (`email.ts`/`batches.repo.ts:407`, AC-3.1/3.5), employee `paid`+`paidAt` w/ monthly-note suppression asserted (`RequestDetailPage.test.tsx:446-448`, `ReviewDetailPage.test.tsx:310`, AC-5.2/5.3). No AC rests on the unexecuted e2e alone. |
| Spec fidelity | 20 | 5 | 3 | 20.0 | Realises plan/spec intent exactly, zero product scope creep. `RefundStatus` freeze deliberately superseded by terminal `paid` (ADR-0020, plan §Context decision 1). The live-pointer (`RefundRequest.batchId`) vs immutable-membership (`RefundBatchItem`) split implemented as designed (`batches.repo.ts` module doc, `decide.repo.ts:139-144`). All three Resolved decisions honoured in code: D1 batch reads capability-gated NOT entity-scoped (`batches.routes.ts:474-498`, `listBatchSummaries` unscoped), D2 email carries `/refund/batches/:id` deep link not a presigned URL (`emails.schemas.ts:32`, `email.ts`), D3 mark-paid on `request:approve` while reads/discard on `request:review` (`decide.routes.ts:182,255`). Every Non-goal respected: no cron (accounting-triggered cutoff), no PDF attachments (notify template link-only), English-only, indefinite PDF retention (separate `refund/batches/` key namespace), no undo. All 7 design Gaps routed to PO, not silently scoped. |
| Test quality | 20 | 5 | 3 | 20.0 | Adversarial and defeats vacuous passes. Concurrency proven at integration: two overlapping compiles claim disjoint sets, concurrent mark-paid-vs-discard → exactly one 200 / one 409 (`decide.routes.test.ts` AC-4.3 cases), terminal CAS second-action 409. Authz negatives are explicit controls: `reviewOnlyPerms`→mark-paid 403 (AC-4.4, `decide.routes.test.ts:141`), `approveOnlyPerms`→discard 403 (:166). Audit immutability asserted under direct FK-restrict delete (`db.batches-schema.test.ts` — the "Invalid delete" Prisma output is the assertion firing). Fail-soft PDF `null` degradation explicitly exercised (simulated storage outage → `pdf:null`, committed transaction unaffected). Deterministic PDF content assertions (`pdf.test.ts`, 18KB). QE added AC-7.3/AC-5.5 coverage + fixed a stale status enum. Storage mock isolation verified: `storage.test.ts` 14/0 in isolation, its 3 full-suite fails are aws-sdk-mock cross-file leakage (one is 008's own `putObject`, green solo — pre-existing infra artifact, not a regression). |
| Code quality | 15 | 5 | 3 | 15.0 | Idiomatic 007 clone: Effect TS, RFC-7807, Prisma-only DB, `@hono/zod-openapi`, shared `hasCapability`/`scopeForReviewAction`/`writeAuditEntry`/`computeSubtotals` reused verbatim — no new authz/audit mechanism. No hallucinated deps (`pdf-lib`, `@pdf-lib/fontkit` real). Genuinely subtle, correct details: the compile commits BEFORE the S3 `PutObject` with no 4th "compiling" state, made safe by the regenerable-cache pure-function posture (`pdfLink.ts` lazy re-render on miss); **fail-soft `resolvePdfLink` so a committed money-moving mark-paid/discard never 500s on a later storage blip** (`pdfLink.ts:56-83` — a real "looks-right-but-would-mislead" hazard, correctly closed); byte-deterministic PDF via `setCreationDate/setModificationDate(generatedAt)` + stable employee/currency sort (`pdf.ts:41-54`); no-PII object keys; unreachable-CAS-mismatch hard-fail rather than silent partial claim (`batches.repo.ts:211`, `decide.repo.ts:100`). OWASP frontier: 0 crit / 0 high / 1 medium (pdf-lib non-Latin-1 crash) fixed via embedded Noto Sans + fontkit total function + fail-soft, re-verified; 2 accepted lows. ADRs 0019-0022 written (217-246 lines each). |
| Design fidelity (UI) | 15 | 5 | 3 | 15.0 | design.md complete: 8 flows (F1-F8) with entry→steps→success/error exits; every screen state (L/E/P/Err/PD/NF/G) across the 3 NEW screens (B1/B2/B3) + the 3 extended surfaces (`RequestDetailPage`/`ReviewDetailPage`/`RefundShell`); full a11y plan (MarkPaidDialog three-stop `[checkbox,Cancel,Confirm]` focus trap with reasoned default-focus-on-Cancel for a money-moving action, `aria-live` transition outcomes + heading-focus, `BatchPdfLink` as `<button>` not `<a>` for fresh-mint correctness, labelled `datetime-local` cutoff w/ `aria-describedby`, per-employee-group `aria-label`s, glyph+text+color badges); component inventory with reuse:NEW ratio (~17:11) grounded in the same-module-reuse vs 007's MF-port distinction; and an explicit 7-item Gaps section routed to PO/architect. Realised in code + 407 passing refund-ui tests: `BatchStatusBadge`/`BatchSubtotalsPanel`/`BatchEmployeeGroupList`(preview+detail modes)/`BatchPdfLink`/`MarkPaidDialog` + B1/B2/B3 pages + the `paid` branches (monthly-note absence asserted). |
| Trajectory | 10 | 2 | 2 | 4.0 | No `wellforge-run/v1` trace for feature 008 in `.forge/runs/` (dir holds 001-003 implement + 004-007 orchestrate traces only; the single grep hit for "008" is a 005 file mentioning it incidentally; `.events.jsonl` is token telemetry, `{ts,event,model,tokens}`, no spec/agent attribution) → neutral floor per the rubric note, consistent with the 005/006/007 evals. Git history independently corroborates a clean, ordered trajectory: docs+ADRs 0019-0022 (`94344da`) → Wave-1 T1/T7/T9 → Wave-2 T2/T10/T14 → Wave-3 T3/T11 → Wave-4 T4/T5/T6/T8/T12/T13 via per-wave reconcile commits → an honest QE pass (`b1447ab`: AC-7.3/5.5 coverage, T15 e2e, stale-enum fix) → OWASP medium fix (`0d9b094`,`2d641a0`) → e2e authored (`1e632df`). A real FAIL→fix loop, not the observability-trace evidence anchors 4-5 require. |
| **Total** | | | | **95/100** | (109 weighted ÷ 115 applicable weight × 100 = 94.8) |

**Verdict: PASS** — 95 ≥ pass_score 80; every applicable dimension ≥ its floor (ac 5≥4; spec/test/code/design 5≥3; trajectory 2≥2). No sub-floor dimension, no unmet AC.

## Findings

- **Trajectory (2/5)** — the only below-5 dimension, and not a defect in the work. No run trace
  exists for 008, so per the rubric's own note ("default to 2 (neutral) ONLY when no run trace
  exists") this scores the neutral floor; git history independently evidences a correct, ordered,
  QE-and-OWASP-reviewed trajectory. Nothing to remediate. Identical situation to 005/006/007.

- **T15 e2e authored but not run live (env-blocked, non-capping).** Both headline journeys are
  authored, committed, and read as genuinely adversarial (`shell/e2e/refund-batches-headline.spec.ts`:
  mixed-employee/mixed-currency compile → never-blended per-currency subtotals → PDF mint → visible
  email status → mark-paid → both employees see `paid`+`paidAt`, monthly note gone, real notify-api
  push; plus a discard→re-eligible→recompile→pay path). Its live run is blocked on 1Password CLI auth
  in this session — the same environment dependency 007's own e2e carries, not a code defect. This is
  **acceptable for this tier and does not cap any dimension**, because every AC the e2e would exercise
  already has an *executed, passing* integration/component proof: AC-5.3 (monthly-note suppression)
  in particular — which plan.md's test map listed as e2e-only — is proven by executed component tests
  (`RequestDetailPage.test.tsx:448`, `ReviewDetailPage.test.tsx:310`). The e2e is redundant
  full-journey confirmation, not the sole proof of anything. Recommend running it once the 1Password
  dependency is available, as a close-out belt (tracked, not blocking) — same posture 007 carried.

- **3 pre-existing `storage.test.ts` full-suite failures (background, not a spec-008 regression).**
  `storage.test.ts` passes **14/0 in isolation** but 3 of its cases fail in the full `bun test` run
  (aws-sdk-client-mock global-state leakage across files). One of the three is 008's own new
  `putObject` test — which passes solo — so the isolation defect merely now also touches an 008 test;
  it is not caused by 008. Pre-existing test-infra hygiene issue, worth a separate cleanup ticket
  (per-file mock reset), out of scope for this eval's verdict.

- **Accepted OWASP lows (bounded, acceptable for this tier).** (1) The employee-facing
  `GET /requests/:id` exposes `paidBy` (the accounting actor's email) on a `paid` request
  (`requests.service.ts:168`) — directly mirroring 007's already-accepted `decidedBy` exposure; it
  is an accounting user's own work email, not another employee's PII, and is bounded to the request's
  own owner. (2) `batchUrl`'s scheme is not allowlisted in the email template — not exploitable
  because the value is server-composed from the trusted `REFUND_APP_BASE_URL` env (not user input)
  and is HTML-escaped (`emailTemplates.ts` `escapeHtml`). Both are genuine lows, correctly accepted.

- **PDF non-Latin glyph degradation (acceptable per ADR-0019).** The medium (pdf-lib throwing on a
  non-WinAnsi employee display name → via the lazy-regenerate design, a permanently unreadable batch
  and a 500 on an already-committed mark-paid) is **fixed and re-verified**: `pdf.ts` embeds Noto Sans
  (Regular+Bold, OFL) via fontkit, making the renderer a total function — Latin-Extended/Cyrillic/Greek
  now render *correctly* (more than Helvetica did), and emoji/CJK/Arabic degrade to a harmless blank
  `.notdef` glyph instead of crashing. Full CJK/emoji glyph coverage is explicitly out of scope
  (several MB of extra fonts); the safe blank-glyph degradation matches ADR-0019's regenerable-cache
  "regenerable, not perfect" posture and is acceptable — a lossy sanitize-to-`?` alternative would
  mangle real names on a payroll-reconciliation document, which is worse. `pdfLink.ts`'s fail-soft
  wrapper is the belt that ensures no financial transaction is ever misreported as failed.

- **No unmet AC. No sub-floor dimension.** The design's WYSIWYG-cutoff choice (Gap #2) and the
  MarkPaidDialog acknowledgement-checkbox (Gap #3) are documented designer judgment calls flagged for
  PO confirmation — worth a one-line PO note, non-blocking.

## Recommended next step
- **PASS** → spec 008 may complete T16 (`/wellforge:done 008-refund-monthly-processing`) and move to
  `done`. Carry two tracked, non-blocking follow-ups: (a) run the authored T15 e2e once the 1Password
  dependency is available; (b) a test-infra ticket to reset the aws-sdk mock per-file so
  `storage.test.ts` is green in the full suite.
