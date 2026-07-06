---
spec: 001
evaluated: 2026-07-07
rubric: default-v2
score: 91
verdict: PASS
---
# Eval report: Estimate persistence API

Re-eval after commit `6b96be0` (string-numeric coercion fix). The prior report (score 95,
2026-07-06) scored the suite BEFORE that fix and missed a production-breaking defect: the
EstimAI UI persists numeric estimate fields as STRINGS (`ml:"5"`, `risk:"2"`,
`aiGain:"0.15"`), but the content schema required strict `z.number()`, so real estimate
content 400'd on every POST / PUT / import. The prior AC-1.1 and AC-5.2 citations passed
only because their fixtures were clean numerics (`makeContent` at `estimates.routes.test.ts:207` —
`o:1, ml:2, p:4, risk:0.1, fte:2`) and never exercised the string-data path.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | All ACs met with a passing test AND observable behaviour, and AC-1.1/AC-5.2 now hold for the REAL data shape. Coercion regression (`estimates.routes.test.ts:1990-2032`): `POST /estimates/import` with PaperJudge string content (`ml:"5"`, `risk:"2"`, `aiGain:"0.15"`, `1922-1925`) → `status:"imported"` (`:2018`) → `GET` deep-equals `paperJudgeCoerced()` with `ml:5 not "5"` (`:2030`, `1946-1987`) — proves AC-5.2 for string data. AC-1.1 via `POST`+`GET` string round-trip (`:2036-2061`) and `PUT` string round-trip (`:2064-2100`). Numeric-fixture regression still deep-equals (`:2104-2129`). Remaining ACs unchanged and still proven: AC-1.2 update-no-dup `:308`; AC-1.3 save-failure preserves state `EstimatorContext.test.tsx:432`; AC-1.4 413/nothing-persisted `:876,932` + no-cap `:1061`; AC-2.1 `:381`; AC-2.2 model-derived (unit `useEstimator`; the coercion fix makes this hold for real data — UI's `Number(x)||0` copes with the coerced numbers, `useEstimator.ts:8,46`); AC-2.3 `:428`; AC-3.1 `:445`; AC-3.2 `ImportOfferModal`/`persistence.spec.ts`; AC-4.1 IDOR 404 `:489`; AC-4.2 unauth `:1100`; AC-5.1/5.3 offer + session decline `ImportOfferModal.test.tsx:155,211`; AC-5.4 partial-failure `:1313`. Live-stack e2e 29/29. |
| Spec fidelity / no drift | 20 | 5 | 3 | 20.0 | Six endpoints, 404-on-not-owned, 1 MiB guard, last-write-wins, no count quota — all as planned. The coercion fix is a fidelity nuance, not drift: the plan promised "verbatim, no transform" but defined fidelity as **semantic deep-equal** (`plan.md:146-149`), and `z.coerce.number()` yields a semantically identical value (`Number("5")===5`) on which the estimation model depends (`estimates.schemas.ts:54-84`). Coercion is documented in the schema header (`:23-38`) and commit `6b96be0`. Earlier JWKS drift caught by T14, fixed in code + reconciled in plan §Auth model + ADR-0005. No unrequested scope. |
| Test quality | 20 | 4 | 3 | 16.0 | **Downgraded from the prior 5.** The suite let a production-breaking defect ship: for the whole feature, NO round-trip/model test used the data shape the UI actually produces — every AC-1.1/AC-2.2/AC-5.2 fixture was clean numerics (`makeContent:207`, `:743-793`), so `z.number()` "passed" against data no real user generates. That is a demonstrated (not hypothetical) coverage gap in the core fidelity ACs — the anchor-5 clause "would catch regressions" was false for the most important path. The 6 new tests (`:1990-2216`) close it well and are non-vacuous — string input asserts success (200/201/200) AND asserts GET returns coerced numbers, plus a numbers-still-work regression (`:2104`) and garbage-`"abc"`→400 at both endpoints (`:2140,2187`). Other tests remain adversarial (IDOR flips 404→200 if the predicate is dropped `:643`; size-guard fixtures self-check over/under limit; 413 branch fails if it falls through). But most fidelity/model assertions still lean on numeric fixtures; only these 6 cover the real shape. Solid AC coverage with the critical gap now patched — "a few edge cases missing" (anchor 4), not "would catch regressions" across the board (anchor 5). estimai-api 65/0 (323 expects), vitest 83/0, e2e 29/29. |
| Code quality & conventions | 15 | 5 | 3 | 15.0 | The fix is minimal, correct, and idiomatic: `z.coerce.number()` on every field the UI may stringify (Activity `o/ml/p/risk/aiGain`, Release `fte`, all eight Parameters), `num` correctly left as a `string\|number` union since it is display-only (`estimates.schemas.ts:54-87`). The NaN-rejection reasoning is documented and correct — `Number("abc")→NaN→zod rejects→400` at the envelope, `""→0` matches the UI's `Number(x)\|\|0` (`:29-38`), tested (`:2140,2187`). No garbage reaches the DB. Prior structural strengths intact: Effect-wrapped repo, RFC 7807 Problem JSON, atomic `updateMany/deleteMany where{id,userId}` (no TOCTOU), `jose createRemoteJWKSet` RS256/issuer-pinned. No hallucinated APIs. |
| Design fidelity (UI) | 15 | 5 | 3 | 15.0 | Applies (design.md present) and unchanged by this fix. design.md is complete — 5 flows, every loading/empty/error state per screen, full a11y plan, 9 reuse / 4 justified NEW. Implementation realises it: `ConfirmDeleteModal` focus-trap + Cancel-default + Escape=Cancel + role=dialog; `ToastBanner` role=alert + aria-label Dismiss; `SkeletonListRows` aria-hidden + parent aria-live; list error + empty-state reuse (`EstimatesPage.tsx`). |
| Trajectory | 10 | 5 | 2 | 10.0 | Latest trace `2026-07-06T19-18-16Z-implement-001` (wellforge-run/v1): backend-dev made the fix (commit `6b96be0`, `+6` regression tests, typecheck clean, 65/0), then quality-engineer independently verified PASS — cross-checked `types.ts` + `ParametersPanel`/`ActivityTable` onChange emit strings (0 fields missed), confirmed tests non-vacuous and garbage→400, checked scope isolated to schema+test. `drift_events: []`, `verdicts.qe: PASS`. Consistent with the 8 prior feature traces (right agents, dependency order, QE every batch, owasp on auth/data surfaces). Verification not skipped. |
| **Total** | 100 | | | **91.0/100** | |

**Verdict: PASS** — weighted total 91.0 ≥ pass_score 80, and every applicable dimension
(incl. conditional `design_fidelity`, which applies since design.md exists) is at or above
its floor. No sub-floor dimension. Score drops 4 points from the stale 95 because
test_quality is honestly 4/5, not 5/5.

## Findings

- **test_quality 4/5 (was 5/5) — the string-data coverage gap was real and demonstrated.**
  The feature shipped with a suite that "proved" its core fidelity ACs (AC-1.1 round-trip,
  AC-2.2 model correctness, AC-5.2 import) using only numeric fixtures, while the UI
  provably emits strings (`ParametersPanel.tsx:37` `onUpdate(k, e.target.value)`;
  `ActivityTable.tsx:117,478,508,539` emit `e.target.value` for `ml/o/p/risk`;
  `:173` emits `aiGain` as `String(...)`). Strict `z.number()` therefore 400'd every real
  save/import (import surfaced as "0/0"). A suite that passes green while the feature is
  broken in production is the exact failure test_quality exists to catch, so the prior
  5/5 was not defensible in hindsight. It is now 4/5: the 6 coercion regression tests
  (`estimates.routes.test.ts:1990-2216`) are strong and non-vacuous, but the remaining
  fidelity/model assertions still lean on numeric-only fixtures — one representative
  string-shape assertion in the AC-2.2 UI path would earn the 5.

- **AC-1.1 / AC-5.2 now genuinely hold for real data.** The regression tests assert the
  full string→success→coerced-number chain: import returns `status:"imported"` (not
  "failed"), and GET deep-equals the coerced shape (`ml:5`, `risk:2`, `aiGain:0.15`),
  not the string input. Because `useEstimator` coerces with `Number(x)||0` on read
  (`useEstimator.ts:8,15,25-29,46-54`), the coerced numbers round-trip cleanly into the
  compute model — AC-2.2 holds for real data too.

- **Coercion vs "verbatim storage" is a defensible fidelity nuance, not drift.** The value
  is preserved (`Number("5")===5`); only the JSON type narrows string→number. The plan's
  own fidelity definition is semantic deep-equal, and the model reads values not types.
  Garbage (`"abc"`) is still rejected 400 before the DB — no silent corruption.

- **Non-blocking, unchanged from prior eval:** `Activity.num` `string|number` widening
  (correct — display-only); AC-2.2 e2e proxy asserts label presence (numeric correctness
  is unit-covered); deferred owasp LOWs recorded in ADR-0005 (7-day token lifetime, `aud`
  deferred, orphaned `/.well-known/jwks.json`).

## Recommended next step

- **PASS** → spec 001-estimate-persistence may move to `done`.
- Optional hardening (not gating): add one real-string-shape assertion to the AC-2.2 UI/
  model test so the fidelity path is covered end-to-end at the compute layer, which would
  restore test_quality to 5/5. Track the ADR-0005 deferred-hardening items (token lifetime,
  `aud`, orphaned jwks route) as a follow-up security spec before the next resource server
  or production launch.
