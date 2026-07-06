---
spec: 001
evaluated: 2026-07-06
rubric: default-v2
score: 95
verdict: PASS
---
# Eval report: Estimate persistence API

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | All 16 ACs met with a passing test AND observable behaviour. AC-1.1 round-trip `estimates.routes.test.ts:268` (deep-equal on content); AC-1.2 update-in-place/no-dup `:308`; AC-1.3 save-failure preserves in-memory state `EstimatorContext.test.tsx:432`; AC-1.4 413 + nothing persisted `routes.test.ts:876,932` + no-count-cap `:1061`; AC-2.1 list metadata `:381`; AC-2.2 content+model-derived values (unit: `useEstimator`; e2e proxy `persistence.spec.ts:276`); AC-2.3 empty `:428`; AC-3.1 delete→404 `:445`; AC-3.2 decline `persistence.spec.ts:338`; AC-4.1 IDOR 404-not-403 `:489` + atomic no-mutate `:648`; AC-4.2 unauth 401 all endpoints + DB-unchanged `:1100,1145`; AC-5.1/5.3 offer + session-remembered decline, no local removal `ImportOfferModal.test.tsx:155,211`; AC-5.2/5.4 import round-trip + partial-failure `routes.test.ts:1233,1313`. Live-stack e2e 29/29. |
| Spec fidelity / no drift | 20 | 5 | 3 | 20.0 | Implementation matches plan contracts exactly: 6 endpoints as specified, 404-on-not-owned, semantic deep-equal fidelity, 1 MiB guard, last-write-wins, no count quota. One drift (JWKS endpoint `/auth/jwks` vs `/.well-known/jwks.json`) was caught by T14 e2e, fixed in code (560b097) AND reconciled in plan.md §Auth model + ADR-0005 (957476a) — recorded and resolved, not silent. No unrequested scope (design G-5 scope-creep check honoured). |
| Test quality | 20 | 5 | 3 | 20.0 | Adversarial and non-vacuous: IDOR tests structured so removing the `userId` predicate flips 404→200 and FAILS (`routes.test.ts:25,495`); size-guard fixtures self-check they are deterministically over/under limit (`:864,870`); 413 branch test FAILS if it falls through to the generic message (`EstimatorContext.test.tsx:571`); import partial-failure would fail under a single spanning transaction (`:1182`). estimai-api 59/0 (303 expects), vitest 83/0, e2e 29/29 — e2e caught 5 real bugs mocks missed (empty-name 400, TanStack stale-while-revalidate, wrong-JWKS 401, jwks 500, root Docker user). |
| Code quality & conventions | 15 | 5 | 3 | 15.0 | Idiomatic to the `auth`-service stack: Effect-wrapped repo with tagged errors, RFC 7807 Problem JSON, zod-openapi routes, `jose createRemoteJWKSet` module-scoped + RS256/issuer-pinned (`jwt.middleware.ts:25,81`), no hallucinated APIs. Ownership enforced structurally via atomic `updateMany/deleteMany where{id,userId}` (`estimates.repo.ts:162,201`) with no TOCTOU window. Realistic error handling (413/404/401/generic-500 all distinct, DB internals sanitized at import wire boundary `routes.ts:584`). Minor nit only: `Activity.num` `z.union([string,number])` (`estimates.schemas.ts:53`) widens the UI's string-typed field. |
| Design fidelity (UI) | 15 | 5 | 3 | 15.0 | design.md is complete — 5 flows, every loading/empty/error state per screen, full a11y plan, component inventory mapped to the bespoke-Tailwind library (9 reuse / 4 justified NEW). Implementation realises it faithfully: ConfirmDeleteModal focus-trap + Cancel-default + Escape=Cancel + role=dialog (`ConfirmDeleteModal.tsx:54,60,105`); ToastBanner role=alert + aria-label Dismiss (`ToastBanner.tsx:11,23,30`); SkeletonListRows aria-hidden + parent aria-live loading region (`SkeletonListRows.tsx:15`, `EstimatesPage.tsx:219`); list error state + empty-state reuse (`EstimatesPage.tsx:28,60`). New components justified (window.confirm was inaccessible). |
| Trajectory | 10 | 5 | 2 | 10.0 | 8 wellforge-run/v1 traces for the feature show the right agents in dependency order (T1/T7 roots → BE/FE parallel tracks → e2e convergence → T16 devops → T17 close-out). QE ran every batch; owasp-reviewer ran in parallel on every auth/data/import surface (T3/T4/T6/T14) and drove fixes (TOCTOU→atomic, import bodyLimit MED, root-Docker D-1) then re-verified PASS. One drift event recorded AND resolved (JWKS). Verification never skipped; QE even FAILed the T15/T16 batch on the root-Docker defect before it was fixed. |
| **Total** | 100 | | | **95.0/100** | |

**Verdict: PASS** — weighted total 95.0 ≥ pass_score 80, and every applicable dimension (incl. conditional `design_fidelity`, which applies since design.md exists) is at or above its floor. No sub-floor dimension.

## Findings

No dimension scored below 5. Genuine strengths, and the honest weaknesses that were weighed but did not lower any anchor:

- **Ownership / IDOR is airtight.** Every query is `userId`-scoped from the verified JWT `sub` (never body/path); writes are structurally owner-scoped via atomic `updateMany/deleteMany`, closing the TOCTOU window owasp flagged. Tests are constructed to fail if the predicate were removed.
- **Every AC has a live-stack test**, and the e2e suite caught 5 real bugs unit/mock tests missed — including a feature-breaking wrong-JWKS misconfiguration that would have 401'd every real token in production.
- **Weaknesses noted but non-blocking (did not pull any anchor below 5):**
  - *AC-2.2 e2e proxy:* `persistence.spec.ts:276` asserts the "Total Man/Days" label is present as a proxy that computed values rendered; exact numeric correctness of PERT/Expected/Elapsed is covered at unit level against `useEstimator`, not re-verified numerically in the browser journey. Coverage is sound in aggregate.
  - *`Activity.num` union:* `estimates.schemas.ts:53` accepts `string|number` though the UI types `num` as `string` — a defensive widening, not a correctness gap.
  - *Operability caveat:* `docker compose up estimai-api` needs a complete gitignored `.env` (`AUTH_JWKS_URL`/`AUTH_ISSUER`); documented as an operator step (trace 2026-07-06T12), not a code defect.
  - *Deferred owasp LOWs (recorded, accepted):* 7-day access-token lifetime and the orphaned `/.well-known/jwks.json` endpoint are documented in ADR-0005 §Deferred hardening (`:174,198`); `aud` verification deferred because the auth service does not yet set the claim. All are advisory, not open findings.

## Recommended next step

- PASS → spec 001-estimate-persistence may move to `done`. Consider tracking the ADR-0005 deferred-hardening items (token lifetime, `aud`, orphaned jwks route) as a follow-up security-hardening spec when a second resource server or production launch approaches.
