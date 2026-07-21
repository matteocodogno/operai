---
spec: 010
evaluated: 2026-07-21
rubric: default-v2
score: 93
verdict: PASS
---
# Eval report: Self-approval control — segregation of duties on refund approval

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 5 | 4 | 35.0 | All 24 ACs met, each backed by a passing test AND observed behavior (see below). refund-api decide/service 42/42, conditions unit 29/29, admin-ui 31/31, refund-ui 18/18, auth catalog 11/11 — all re-run and green here. |
| Spec fidelity | 20 | 5 | 3 | 20.0 | Matches plan.md D1–D5 / ADR-0026 exactly; zero unrequested scope (see below). |
| Test quality | 20 | 5 | 3 | 20.0 | Real-Postgres integration with concrete non-mutation assertions; edge/error/ordering cases covered; honest R1 tie test (see below). |
| Code quality | 15 | 4 | 3 | 12.0 | Idiomatic Effect-TS, correct subtle guards, no hallucinated APIs; one incomplete-refactor nit (broken call site) (see below). |
| Trajectory | 10 | 3 | 2 | 6.0 | No `.forge/runs/*.json` trace for spec 010; correct order inferable from git; QE ran and caught real gaps; one dev-agent misdiagnosis (see below). |
| design_fidelity | — | N/A | — | — | No `design.md` present — conditional dimension excluded; weights re-normalise over the remaining 100. |
| **Total** | | | | **93.0/100** | |

**Verdict: PASS** — 93.0 ≥ pass_score 80, and every applicable dimension ≥ its floor (AC 5≥4, spec 5≥3, test 5≥3, code 4≥3, trajectory 3≥2). No sub-floor dimension.

## Findings

### AC satisfaction — 5/5
Every AC is met with a passing test and observable behavior, independently re-verified:
- Admin/catalog side (US-1, US-4 catalog, US-5): `auth/src/authz/catalogs/refund.test.ts` asserts `approve.supportedConditions == ["entity","self-approval"]` and absent elsewhere (AC-4.3/5.1) — 11/11 pass; `admin/roles.routes.test.ts` proves persistence + `bumpPermissionEpoch` + 422 on non-`approve` attach (AC-1.2/1.5/1.6/5.2); `ConditionChip`/`RoleEditor` render a distinct toggle+chip (AC-1.1/1.3/1.4) — 31/31 pass.
- Enforcement side (US-2/3/4/6): `refund-api/src/review/decide.routes.test.ts` — 42/42 pass — proves owner+restricted → 403 `code:self_approval_forbidden` with request/line-totals/audit **unchanged** (AC-2.1, asserts `status==="submitted"`, `approvedTotalCents===null`, `auditRows.length===0`); non-owned unblocked (AC-2.2); whole-request multi-line denial (AC-2.3); self-approval 403 wins over entity 404 while a non-owned request stays entity-gated 404 (AC-2.4, both directions); no-restriction owner self-approves (AC-3.1); reject/set-total on own not blocked (AC-4.1/4.2); capability-absent 403 carries **no** `code` (AC-6.1); and I observed the actual `{"event":"refund.self_approval_denied",...}` log line with `actorUserId`/`requestId`/ISO-8601 `timestamp` in the run output (AC-6.2/6.3).
- AC-4.4 (create/submit inert) and Risk R1 (widest-wins drop) were coverage gaps in the dev-authored suite; QE added them (commit 471baa9) in `requests.routes.test.ts`/`lifecycle.routes.test.ts` and four `dedupeWidest` cases in `resolver.test.ts`. They are now present and passing, so the AC set is fully covered in the branch under eval.

### Spec fidelity — 5/5
Implementation realises plan.md / ADR-0026 with no drift: attribute representation `{key:"self-approval",match:"deny"}` (one-constant catalog edit, `auth/src/authz/catalogs/refund.ts`), inline enforcement in the approve decide path (`decide.repo.ts:235-282`), ordering capability→**self-approval 403**→entity 404→status 409 (`decide.repo.ts:256-276`), distinguishable 403 `code` (`decide.routes.ts:88-95`), structured log not a new `AuditAction` (`decide.routes.ts:105-114`), catalog declares `approve` only, `RefundAuditEntry`/migrations untouched. No unrequested scope; reject/set-total handlers unchanged.

### Test quality — 5/5
Tests genuinely verify behavior, not shape: negative assertions confirm nothing mutated on denial; the two 403s are distinguished by presence/absence of `code`; the log assertion parses the emitted JSON and round-trips the ISO-8601 timestamp; ordering is proven by an owned+out-of-scope request returning 403 (not 404). The R1 `dedupeWidest` test is notably honest — it asserts the order-dependent, incomparable-tie outcome the plan documents as a known limitation rather than papering over it. Conditions unit suite covers present/absent/wrong-`match` and the R4 cross-polarity isolation.

### Code quality — 4/5 (below 5)
Production code is clean and idiomatic (Effect-TS, `ownershipOwn` reused verbatim, a dedicated `approveSelfRestricted` predicate with an explicit opposite-polarity doc comment, and a correct `row &&` guard at `decide.repo.ts:256` so a genuinely missing request still 404s rather than leaking a self-approval 403). The single nit: T3's signature change to `approveRequest` (new 5th param) left a stale call site in `refund-api/src/lib/db.batches-schema.test.ts` that broke `bun run typecheck` — an incomplete refactor across call sites. Fixed in one line (commit 9286685). What would raise it to 5: an atomic signature-change refactor that updates every call site (and a `tsc` check before hand-off).

### Trajectory — 3/5 (below 5, above floor)
No `.forge/runs/*.json` run trace exists for spec 010 (verified: no `010`/`self-approval` entries in `.forge/runs/` or `.events.jsonl`), so this is not scored 4–5 on trace evidence. Git history nonetheless shows the correct sequence (T1–T6 per-task commits in dependency order, ADR-0026 written before implementation, a QE pass that genuinely caught the AC-4.4/R1 gaps and a real typecheck regression, then a fix), plus 2 human gates and an OWASP pass — so trajectory is plausible and partly observable, not "no evidence." Held below 4 by the one honest blemish: the refund-api dev agent mischaracterized the typecheck failure it introduced (T3's signature change) as "pre-existing/unrelated"; QE correctly identified it as a regression and it was fixed. Verification was not skipped — QE demonstrably ran and did its job.

## Recommended next step
- PASS → spec 010 may move to `done` (close T7). Gates align: QE PASS (after fix), OWASP PASS (0 findings), eval PASS 93/100.
- Non-blocking, for hygiene only: the 4 auth full-suite failures are pre-existing shared-dev-DB `employee`-role seed pollution (reproduced here at `auth/src/authz/seed.test.ts:591`, `employeeRules` length 3 vs 0) — unrelated to spec 010 (T1 changes no seed grant); worth a separate cleanup of the shared test DB but not a gate for this feature.
