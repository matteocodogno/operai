---
spec: 004
evaluated: 2026-07-13
rubric: default-v2 (reconstructed — see note)
score: 85
verdict: PASS
---
# Eval report: Authorization — roles, departments & fine-grained permissions

> **Rubric-source note.** The central `gates/configs/eval-rubric.yml` does not exist in
> the repo (the `gates/` tree is empty), and no `specs/004-auth-roles-permissions/eval.md`
> override is present. Dimensions, weights, floors, and `pass_score` (80) were reconstructed
> from the repo's own established **default-v2** rubric as applied in the merged
> `specs/001/002/003` eval-reports (identical dimension set, weights, and floors). Scoring
> is otherwise unaffected.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | All 29 ACs met with fresh passing tests (auth 196/196, admin-ui 182/182, shell 99/99, re-run this session). Independently verified the hard ones: AC-4.3 immediate-revocation epoch bump asserted `beforeEpoch+1` (`users.routes.test.ts:311-325`); AC-2.1/3.2 off-catalog pair → 422 (`roles.routes.test.ts:434-450`); AC-6.4 last-admin guard snapshots other admins → 422 + RFC7807 type (`users.routes.test.ts:413-457`); AC-5.3 audit immutability via PATCH/PUT/DELETE → 404 (`audit.routes.test.ts:314-339`); AC-4.2/4.4 union/dedup/widest-wins + default-deny (`resolver.ts:152-217`, `resolver.test.ts`); AC-1.5 non-admin → 403 (`auth.middleware.ts:89`, `departments.routes.test.ts:162`). **Held to 4:** US-7 route-boundary ACs (AC-7.3 deep-link block, AC-7.5 revoke-on-next-nav, the admin-ui-route leg of AC-1.5) are proven at vitest/jsdom **component** level against a mocked `/authz/me` (`shell` router tests: "revocation blocked on the very next navigation", `router.root-redirect.test.tsx`), not the **live-stack e2e** the plan named for them (plan.md test-strategy rows AC-7.3/7.5 = "e2e"). Every AC met → floor satisfied. |
| Spec fidelity / no drift | 20 | 4 | 3 | 16.0 | Topology matches plan.md: authz domain in `auth/src/authz` + `auth/src/admin`, small token + `perm_epoch` via `definePayload`, live `GET /authz/me`, shell guard, `admin-ui` remote. ADR-0007 authored as required (`docs/adr/0007-...md`). Multiple drifts were **surfaced in design.md "Gaps" and reconciled through the plan** (dept-member endpoint, `?q=` user search, `GET /admin/users/:id/permissions`, `GET /admin/departments/:id` embeds members — all annotated "design drift fix" in plan.md API table and implemented), plus a response-shape reconciliation commit (`4bcbf77`, departments bare-array vs envelope). No scope creep (no catalog-browse screen, correctly). Owasp hardening (block dept-conferred admin, block system-role rename) slightly extends behavior beyond the literal plan but is consistent with plan.md's Security section. Real, well-documented, reconciled drift → 4. |
| Test quality | 20 | 4 | 3 | 16.0 | Non-tautological and adversarial: integration tests run **real Prisma queries against a test DB** (unique-constraint negative paths deliberately exercised, 0 fail); resolver unit tests cover union/dedup/widest-wins/default-deny; JWT-claims contract test (`auth/src/auth/jwt-claims.contract.test.ts`) guards the `definePayload` seam; admin-ui component tests assert focus-trap/Escape/pagination-bounds/aria (`GuardrailDialog`, `ConfirmDeleteModal`, `Pagination`, `RoleEditor` 19 tests). Both owasp regressions have dedicated tests (`departments.routes.test.ts:313`, `roles.routes.test.ts:354`, seed `emailVerified===true`). Auth line coverage **96.39%** (fresh `bun test --coverage`; `resolver.ts` 92.7%, `lastAdminGuard.ts` 100%, `audit.ts` 100%). **Held to 4:** the e2e layer the plan named for the cross-app US-7 flows is absent — no live admin e2e against the assembled shell+auth+admin-ui stack (contrast spec 003's 30/30 live-stack e2e that earned a 5). |
| Code quality & conventions | 15 | 5 | 3 | 15.0 | Idiomatic, no hallucinated APIs/deps. `resolver.ts` is defensive (malformed `conditions` JSON degrades to widest/null, never throws), transaction-aware (`PrismaClientLike`), NUL-safe permission key. Effect TS + RFC 7807 throughout; Zod validation; Prisma-only DB access. ADR adherence: admin API inside `auth` (no 2nd resource server → ADR-0005 `aud` not triggered), small token + `perm_epoch` + live `/authz/me` (ADR-0007), in-memory JWT preserved in shell (ADR-0001). Security-fix quality is notable: shared `ADMIN_ROLE_NAME` constant makes the `requireAdmin` gate and `lastAdminGuard` unable to drift (`auth.middleware.ts:89`, `lastAdminGuard.ts:31`); last-admin guard deliberately counts department-conferred admins wider than the gate. `definePayload` correctly replaces the dead better-auth `jwt.fields` no-op. |
| Design fidelity (UI) | 15 | 5 | 3 | 15.0 | `design.md` present → **applies**. Complete: 8 flows, 12 screens/dialogs each with a full L/E/P/Err/403/G state matrix, a thorough a11y plan (`role="alertdialog"` dialogs, `aria-live` on the rule-composer Resource/Action cascade, focus-to-heading on E1/S1, `<th scope="col">` tables, `role="radiogroup"` ownership, `aria-disabled` pagination bounds), and a component inventory mapped to the repo's Tailwind + `shell/tokens.css` approach (no new UI kit, ADR-0006 federation constraint honored). Realized: `admin-ui` ships `RoleEditor`/rule composer, `GuardrailDialog` (D2), `PermissionDenied` (E1), `Pagination`, `ConditionChip`, `SystemBadge`, `SectionNav`, `ConfirmDeleteModal` — each with component tests confirming the a11y contract. Honest gaps (dept-member endpoint, no cross-user perms preview) were routed to the architect, not designed-around. |
| Trajectory | 10 | 4 | 2 | 8.0 | **No structured `.forge/runs/*004*` trace exists** (only 001/002/003 have `wellforge-run/v1` JSONs; `.events.jsonl` carries only generic `subagent_stop` events with no 004/agent identity). Falling to git-history evidence: the full ordered chain is visible — spec/plan/design + ADR-0007, per-task worktree-merged feature commits (T8 `90deb2b`, T9 `8ff4bea`/`4bcbf77`, T11 `d91cbbd`, T17/18 `cdfc14e`, T20 `40edc90`, T26 `b473797`), then a dedicated consolidated security-fix commit `244512a` ("owasp/QE") whose four fixes I **independently verified** exist and are regression-tested. Held to 4 (not 5): the structured per-agent trace that would confirm QE ran round-by-round / verification was not skipped is absent for this spec. |
| **Total** | 115 | | | **98.0 → 85/100** | normalised over applicable weights (design_fidelity applies) |

**Verdict: PASS** — 85/100 ≥ pass_score 80, and every applicable dimension is at or above its floor (ac_satisfaction 4 = floor 4; all others above). No sub-floor dimension.

## Findings
- **AC satisfaction (4/5):** the only reason this isn't 5 — the US-7 route-boundary ACs
  (AC-7.3 deep-link block, AC-7.5 revoke-on-next-navigation, and the admin-ui-route-block
  leg of AC-1.5) are verified at vitest/jsdom **component** level against a mocked
  `/authz/me`, whereas plan.md's test strategy named **e2e** for them. The component tests
  are meaningful (they exercise the real router `beforeLoad` guard, the force-refetch
  `revalidatePermissions` path, and the Sidebar filter), so every AC is genuinely met — but
  the cross-app behavior isn't proven against the assembled shell+auth+admin-ui stack.
  **To reach 5:** a live admin e2e (Playwright, seeded session) covering deep-link-block,
  revoke-gone-next-nav, and Admin-tool-hidden-for-non-admin against the running stack.
- **Test quality (4/5):** strong unit + integration + component depth (real-DB Prisma
  integration, adversarial 422/404/epoch assertions, 96.4% auth line coverage, both owasp
  regressions test-backed), but the e2e apex the plan called for is missing for the US-7
  flows. Same live-stack gap as the AC finding; closing it lifts both dimensions.
- **Spec fidelity (4/5):** several contract additions beyond the original plan table (dept
  member/roles endpoints, `?q=`, `/admin/users/:id/permissions`, dept response-shape fix
  `4bcbf77`) — all surfaced in design.md's Gaps section and reconciled through the plan, so
  healthy documented drift rather than silent divergence, but drift nonetheless.
- **Non-blocking, honestly-scoped:** `bun audit` on `auth` reports **0 critical** (the
  better-auth GHSA-pw9m-5jxm-xr6h CVE is fixed — installed `better-auth@1.6.23`), confirming
  the QE claim; however 3 **HIGH** advisories remain (`fast-uri` ×2 host-confusion/path-
  traversal, Hono CORS-wildcard-reflection). These are pre-existing framework/transitive
  advisories, largely N/A to this deployment (auth uses an explicit `ALLOWED_ORIGINS`
  allowlist, not wildcard CORS; no Lambda adapters), and are not a regression introduced by
  this feature — noted for a dependency-hygiene follow-up, not a blocker. Catalog global-key
  namespacing remains deferred (plan R6, LOW/INFO).

## Recommended next step
- **PASS** → spec 004 may move to `done`; T28 (close) can proceed (QE PASS, owasp findings
  fixed + regression-tested, this eval PASS, T1–T27 all checked). Recommended (non-blocking)
  follow-ups for the team: (1) add the live-stack US-7 Playwright e2e to convert AC/test
  evidence from component-level to the planned e2e level; (2) triage the 3 remaining HIGH
  `bun audit` advisories as routine dependency hygiene.
