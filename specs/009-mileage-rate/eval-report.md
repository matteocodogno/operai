---
spec: 009
evaluated: 2026-07-20
rubric: default-v2 (reconstructed from specs/005–008 eval-reports; no central gates/configs/eval-rubric.yml present)
score: 95
verdict: PASS
---
# Eval report: Mileage rate — computed amounts for travel-km expense lines

Rubric note: `gates/configs/eval-rubric.yml` does not exist in the repo (nor a `gates/`
directory); dimensions/weights/floors/pass_score were reconstructed from the `specs/005–008`
eval-reports (all `default-v2`), consistent with how 007's and 008's own evals were produced.
default-v2 = AC(35, floor 4) · Spec(20, floor 3) · Test(20, floor 3) · Code(15, floor 3) ·
Design-UI(15, floor 3, conditional on `design.md`) · Trajectory(10, floor 2); pass_score 80;
total normalised over the 115 applicable weight. `design.md` exists → design fidelity applies
(all six dimensions in the weight pool).

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | Every AC AC-1.1…AC-6.4 mapped in `plan.md` AC→test table + `tasks.md` coverage map, each to ≥1 executed passing test AND observable behaviour; QE PASS. **Independently re-run this session (Postgres up):** refund-api rates pure units 16/0 (`resolve.test.ts`+`computeMileageAmountCents.test.ts`); rates integration 22/0 (`routes.test.ts`/`effective.routes.test.ts`/`db.mileage-rate-immutability.test.ts` — the `prisma:error … append-only` lines ARE the AC-4.7/5.2 trigger-fires-as-asserted); requests integration 97/0 (`requests.routes.test.ts` et al. — the `refund_audit_entry_requestId_fkey` `prisma:error` is the retain-once-submitted assertion); refund-ui 88/0 (5 mileage files incl. `MileageAmountField` 10, `ExpenseLineRow` 52); admin-ui 24/0 (`MileageRatesPage` 12, `ratesApi` 11, `RateInEffectBadge` 1); auth refund catalog 9/0. Load-bearing ACs verified in code: latest-`validFrom`≤date resolution + future-ignored + per-entity independence (`resolve.ts:45-59`, AC-2.1/2.3/2.4/4.4); server-derived currency + JWT `createdBy*` never body (`routes.ts:183-206`, AC-1.6/5.1); 403 without `rate:read`/`rate:manage` (`routes.ts:127,188`, AC-4.6); 422 non-positive/overflow/bad-date (`schemas.ts:56-77`, AC-4.5); snapshot-at-submit + backdated-leaves-frozen + withdraw-clears (`lifecycle.repo.ts`, `mileageHydration.ts`, AC-3.1/3.2/3.3); km≤0/no-rate → 422 offendingLineIds (AC-1.4/2.2). Client/server rounding parity byte-identical (`Math.floor((km*micros)/10_000+0.5)`, 16800/7000/2 verified both sides). No AC rests on the unexecuted e2e alone. |
| Spec fidelity | 20 | 5 | 3 | 20.0 | Realises plan/spec intent exactly, zero product scope creep. All three Open Questions resolved in plan and honoured in code: **D1** snapshot pinned at submit, never draft — draft is always derived-on-read (`mileageHydration.ts:35-68` overwrites `requestedAmountCents` live), withdraw nulls `appliedRate*` in the same txn, resubmit re-snapshots (`lifecycle.repo.ts`); **D2** new unconditioned `rate:read`/`rate:manage`, global admin-only, deliberately NOT entity-scoped (contrast ADR-0015 stated explicitly, `catalogs/refund.ts:41-48`); **D3** integer `ratePerKmMicros` + single round-half-up at compute (`computeMileageAmountCents.ts`, ADR-0025). Every Non-goal respected: no cron (derived-on-read, ADR-0013), no backfill (migration additive, `20260720170000_mileage_rate` has no data step), append-only enforced at DB not just route, entity-designated currency for `travel_km` ONLY (server-forced, non-`travel_km` untouched), no FX. `GET /rates/effective` correctly laxer-gated on `refund:access` (leaks nothing beyond the effective rate). Supersedes 007's "no mileage rate" non-goal as specified. The 10× plan-draft example error was caught by BOTH devs and corrected doc-first (`eeeea25`) — correct drift discipline. |
| Test quality | 20 | 5 | 3 | 20.0 | Adversarial, defeats vacuous passes. DB immutability asserted under direct raw `UPDATE`/`DELETE` (trigger raises — the assertion, not a log artifact). Authz negatives are explicit controls: 403 without capability; `getMe()` failure → add-affordance HIDDEN (fails closed, `MileageRatesPage.test.tsx:254`). 422-nothing-persisted for non-positive/overflow/bad-calendar-date (`schemas.ts` rejects `2026-02-30`). Overflow hardening tested (ratePerKmMicros bounded → 422 not 500, `0ff8301`, OWASP A08). Rounding suite includes a half-up tie AND a "banker's-rounding would give 4 not 5" vector (`refund-ui/.../computeMileageAmountCents.test.ts:33`). Freeze proven end-to-end: submit → backdated rate → re-read unchanged (AC-3.1); withdraw → recompute live (AC-3.2). Downstream subtotals/batch proven no-special-case. Modal add-flow, 422-field-routing, in-effect badge, forbidden all driven through `MileageRatesPage.test.tsx`. **Minor nit (called out, non-capping):** plan R1 promised "a single shared test-vector set exercised by BOTH" — the server side imports `mileage-vectors.json`, but the refund-ui unit test **hand-inlines** an overlapping-but-not-identical vector subset rather than importing the shared fixture; parity is still effectively proven because the two implementations are byte-identical and both execute the overlapping vectors, but the literal shared-fixture-import half of the mitigation is unrealised on the client. `AddRateEntryModal` has no standalone test file (exercised via the page). Neither undermines any proof. |
| Code quality | 15 | 5 | 3 | 15.0 | Idiomatic refund-api clone: Effect TS, RFC-7807 Problem JSON, Prisma-only, `@hono/zod-openapi`, reused `authzMiddleware`/`hasCapability` (no new authz mechanism), `bodyLimit` before auth, immutability trigger copied verbatim from `refund_audit_entry` (ADR-0018). Genuinely subtle, correct details: `validFrom` compared as fixed-width ISO **strings** to sidestep `@db.Date` UTC-midnight/TZ ambiguity (`resolve.ts:10-16`); single-division no-intermediate-rounding integer math; exact-integer `decimalToMicros` parse mirrored between the zod `superRefine` and `service.ts` (no float multiply, so "0.0000001"→0 micros is caught as 422); `inEffectToday` recomputed against the FULL history after a backdated add rather than assumed-true (`routes.ts:216-223`); batched effective-rate fetch (one query per distinct entity, not per line, `mileageHydration.ts`); server-authoritative currency+amount (client `requestedAmountCents`/`currency` on a `travel_km` line ignored). OWASP PASS, 0 findings. No hallucinated deps. ADRs 0023/0024/0025 written (268/222/210 lines). |
| Design fidelity (UI) | 15 | 5 | 3 | 15.0 | `design.md` complete: 7 flows F1-F7 (entry→steps→success/error exits); full state inventories for the new `MileageAmountField` (Idle/Calculating/Computed/Blocked/Fetch-error), review A2, admin ADM-1 (L/Forbidden/Err/Empty/Populated) + modal ADM-M1; rigorous a11y plan (reasoned `role="status"` for the config-gap Blocked state vs `role="alert"` for a real fetch error, announce-outcome-not-keystroke `aria-live`, NEW focus-return-to-trigger behaviour, per-entity `aria-labelledby` tables, glyph+text badges, dialog focus-trap); component inventory with reuse:NEW ratios grounded in the confirmed no-shared-component-library reality; an explicit Gaps section routed to PO/architect (`PermissionDenied` `message` prop, proactive nav-hide as new territory, admin-ui's pre-existing no-`strings.ts` gap, the `POST /rates` 422 field-name contract, history-ordering ambiguity). Realised in code + 88 refund-ui + 24 admin-ui passing tests: `MileageAmountField` 5 states, `MileageRatesPage`/`AddRateEntryModal`/`RateInEffectBadge`, review applied-rate `<dt>/<dd>` incl. legacy-null graceful omit, focus-return asserted. |
| Trajectory | 10 | 2 | 2 | 4.0 | No `wellforge-run/v1` trace for feature 009 in `.forge/runs/` (latest is the 008 orchestrate JSON; the lone `.events.jsonl` "009" grep hit is a `2026-07-12` `subagent_stop` token-telemetry line with no spec attribution) → neutral floor 2 per the rubric convention ("default to 2 ONLY when no run trace exists"), consistent with the 005/006/007/008 evals. Git history independently corroborates BOTH the known process nick and its recovery: the spec artifacts (spec/plan/design/tasks + ADRs 0023-0025) were committed as `63b918e` and merged `f2b7623` AFTER dev commits had begun — the orchestrator dispatched worktree agents off a tip lacking `plan.md`; the duplicate commit pairs (two "T5 decide.routes mapLine", two "CORS allowlist gains admin-ui origin") evidence the branched-off-tip rebase recovery. Agents proceeded on self-contained inline instructions and the integrated result is fully consistent + green (re-verified above), with a genuine QE→fix loop (T15 e2e `e6e9f70`, overflow-422 fix `0ff8301`). Net neutral: process slip and clean recovery roughly balance; no output corruption. |
| **Total** | | | | **95/100** | (109 weighted ÷ 115 applicable weight × 100 = 94.8) |

**Verdict: PASS** — 95 ≥ pass_score 80; every applicable dimension ≥ its floor (ac 5≥4;
spec/test/code/design 5≥3; trajectory 2≥2). No sub-floor dimension, no unmet AC.

## Findings

- **Trajectory (2/5)** — the only below-5 dimension, and not a defect in the delivered work.
  No `wellforge-run/v1` run trace exists for 009, so per the rubric convention this scores the
  neutral floor; git history independently evidences a correct, fully-tested, QE-and-OWASP-reviewed
  outcome. The known nick (spec artifacts not committed before dev dispatch → first worktree agents
  branched off a tip without `plan.md`, recovered mid-run, committed as `63b918e`/merged `f2b7623`)
  is a real process slip, but it left no trace in the output: agents worked from self-contained inline
  instructions and the integrated result is consistent across all layers. Nothing to remediate.

- **R1 shared-vector mitigation only half-realised on the client (minor test-quality nit,
  non-capping).** `plan.md` Risk R1 promised "a single shared test-vector set exercised by BOTH
  refund-api and refund-ui unit tests." The server imports `refund-api/src/rates/mileage-vectors.json`;
  the refund-ui unit test (`refund-ui/src/lib/computeMileageAmountCents.test.ts`) instead **hand-inlines**
  an overlapping-but-not-identical vector subset (it even carries a DRIFT NOTE explaining the choice).
  Client/server parity is nonetheless effectively proven — the two `computeMileageAmountCents`
  implementations are logically byte-identical (`Math.floor((km*micros)/10_000 + 0.5)`) and both execute
  the overlapping tie/large-value vectors — so actual rounding drift is not credible. Worth a one-line
  follow-up to have the client import the shared JSON fixture so the promised single-source-of-truth is
  literal, not merely equivalent. Does not affect the verdict.

- **`AddRateEntryModal.tsx` has no standalone test file** — it is exercised through
  `MileageRatesPage.test.tsx` (open modal → fill → submit via `ratesApi.addRate` → 422 field-routing →
  Escape-cancels-without-calling-addRate → focus-return). Integration-through-the-page coverage is
  adequate and matches admin-ui's own house testing style; noted for completeness, not a gap requiring
  action.

- **Two auth `seed.test.ts` failures are shared-dev-DB pollution, NOT a 009 regression.** In the full
  `auth` run, `seedAccountingRoleGrants` / `seedAdminRoleGrants` assert the EMPLOYEE role has zero
  permission rules but find 3 leftover rules written by another test against the shared dev DB with no
  isolation/cleanup. 009 only grants `rate:read`/`rate:manage` to the `admin`/`refund-admin` roles and
  never touches the employee role, so this is unrelated pre-existing test-isolation debt (exactly the
  "pre-existing test-order/dev-DB flakes" the QE verdict flagged). The 009 catalog/seed content itself
  passes (`refund.test.ts` 9/0). Worth a separate test-infra cleanup ticket (per-test DB reset), out of
  scope for this verdict.

- **T15 e2e authored but not run live (env-blocked, non-capping).** `shell/e2e/mileage-rate.spec.ts`
  (admin-adds-rate → employee-drafts+submits → accounting-reviews-applied-rate + freeze assertion) is
  authored and committed; its live run is blocked on 1Password CLI auth + a stale shared refund-api dev
  process — the identical environment posture 007/008 carried, not a code defect. Every AC it would
  exercise already has an executed, passing integration/component proof (verified above). Recommend
  running it once the 1Password dependency is available, as a tracked close-out belt, not a blocker.

- **No unmet AC. No sub-floor dimension.** OWASP PASS (0 findings): `POST /rates` server-side
  `rate:manage`, JWT-derived `createdBy*`, server-authoritative `travel_km` amount/currency, DB-level
  `MileageRate` immutability, scoped CORS (admin-ui origin, not a wildcard, not widening better-auth
  `trustedOrigins`), and the least-privilege `GET /rates/effective` all verified with tests.

## Recommended next step

- **PASS** → spec 009 may complete T16 (`/wellforge:done 009-mileage-rate`) and move to `done`.
  Carry three tracked, non-blocking follow-ups: (a) run the authored T15 e2e once the 1Password
  dependency is available; (b) have the refund-ui rounding test import the shared `mileage-vectors.json`
  fixture so R1's single-source-of-truth is literal; (c) a test-infra ticket to reset the auth dev DB
  per-test so `seed.test.ts` is green in the full suite.
