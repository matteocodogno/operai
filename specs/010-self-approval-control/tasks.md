---
spec: 010
generated: 2026-07-21
---

# Tasks: Self-approval control — segregation of duties on refund approval

Derived from the approved `plan.md`. Levels: unit = pure fn; integration = route + Prisma
(test DB); component = UI (Vitest + Testing Library); e2e = Playwright. Domains in brackets.

- [x] T1: auth — declare `self-approval` on `request:approve` + backward-compat tests — refs: AC-1.2, AC-1.5, AC-1.6, AC-3.2, AC-3.3, AC-4.3, AC-5.1, AC-5.2, AC-5.3 — deps: none  **[backend-dev]**
  - touch: `auth/src/authz/catalogs/refund.ts` (+ catalog/seed/roles-route tests)
  - Change `request.approve.supportedConditions` from `["entity"]` to `["entity", "self-approval"]` — the ONLY code change in auth (the attribute rides existing generic machinery: `ConditionAttributeSchema` `{key,match}`, `toRuleConditions` passthrough, `findRuleViolations` catalog gate). No resolver/wire-schema/migration/seed-grant change.
  - done when: (a) catalog snapshot asserts `self-approval` present on `approve` only, absent elsewhere (AC-4.3/5.1); (b) `PUT /admin/roles/:id/rules` persisting `attributes:[{key:"self-approval",match:"deny"}]` on approve succeeds, `bumpPermissionEpoch` fires, and `/authz/resolve` returns it next call (AC-1.2); removing it drops it (AC-1.5); (c) attaching it to `reject`/`set-approved-total`/`review`/`read`/`create` → 422 (AC-1.6/5.2); (d) seed carries no self-approval grant + existing rules resolve byte-identical after the catalog gains the option (AC-3.2/3.3/5.3).

- [x] T2: refund-api — pure `approveSelfRestricted` predicate + `approveRestrictedForCaller` helper — refs: AC-2.4 (unit), R4 — deps: none  **[backend-dev]**
  - touch: `refund-api/src/authz/conditions.ts` (new `approveSelfRestricted(conditions)`), `refund-api/src/review/review.service.ts` (new `approveRestrictedForCaller(authz)`) (+ unit tests)
  - `approveSelfRestricted(conditions)` = true iff the grant's `attributes[]` contains `{key:"self-approval", match:"deny"}` (its own branch; NEVER routed through `entityScopeForPermission` — opposite polarity, R4). `approveRestrictedForCaller(authz)` = `approveSelfRestricted(findPermission(authz.permissions,"request","approve")?.conditions)`. Reuse `ownershipOwn` verbatim for the owner match.
  - done when: unit tests cover present/absent attribute, wrong `match`, and composition with an `entity` attribute (both evaluated independently, AC-2.4 unit); a test asserts the entity path ignores `key:"self-approval"` and vice-versa (R4).

- [x] T3: refund-api — enforce self-approval denial in the approve decide path — refs: AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-3.1, AC-4.1, AC-4.2, AC-4.4, AC-6.1, AC-6.2, AC-6.3 — deps: T2  **[backend-dev]**
  - touch: `refund-api/src/review/decide.repo.ts` (`approveRequest` gains `selfApprovalRestricted: boolean`, adds `ownerUserId` to the scope-check `select`, throws typed `SelfApprovalDeniedError` when `restricted && ownerUserId === sub` — BEFORE the entity 404 and status 409), `refund-api/src/review/decide.routes.ts` (approve handler computes `approveRestrictedForCaller(authz)`, passes it in, maps the error → 403 with `code:"self_approval_forbidden"` RFC 7807, emits the `refund.self_approval_denied` structured log event {actorUserId, requestId, ISO timestamp}) (+ integration tests). Reject / set-approved-total handlers UNCHANGED.
  - done when: integration proves — owner+restricted → 403 `code:self_approval_forbidden`, request/line-totals/audit unchanged (AC-2.1); non-owned not blocked → proceeds to entity/status gates (AC-2.2); whole-request denial on a multi-line owned request (AC-2.3); composes with entity — owned denied regardless of entity, non-owned still entity-gated (AC-2.4); no restriction → owner self-approves (AC-3.1); reject/set-total on own NOT blocked (AC-4.1/4.2); create/submit own unaffected (AC-4.4); the 403 `code` is distinct from a capability-absent 403 and an entity 404 (AC-6.1); the log event fires with who/which/when (AC-6.2/6.3). Fail-closed: no allow-path on any resolve error.

- [x] T4: admin-ui — self-approval condition chip + RoleEditor composer toggle — refs: AC-1.1, AC-1.3, AC-1.4 — deps: none (works against the catalog contract; mock in tests)  **[frontend-dev]**
  - touch: `admin-ui/src/components/ConditionChip.tsx` (new chip kind + label/glyph, `ConditionChipKind` gains `'self-approval'`), `admin-ui/src/pages/RoleEditor.tsx` (composer offers the toggle when `approve`'s catalog `supportedConditions` includes `self-approval`; persists `{key:"self-approval",match:"deny"}` in `attributes[]`; `AttributeCondition.match` widens `'user' → 'user' | 'deny'`; render its own chip, never merged with entity) (+ component tests)
  - done when: component tests show the toggle rendered distinct from the entity checkbox for `request.approve` (AC-1.1); save+reopen a rule with BOTH → two independent chips, toggling one leaves the other (AC-1.3); a dedicated self-approval chip renders, never conflated with entity (AC-1.4). Match admin-ui house style (inline copy, no strings.ts).

- [x] T5: refund-ui — passively disable approve on caller's own restricted request + 403 mapping — refs: AC-6.1 (UI), D5 — deps: none (works against contract; mock)  **[frontend-dev]**
  - touch: refund-ui request/review detail approve action (`ReviewDetailPage.tsx` / decision dialog), `refund-ui/src/strings.ts` (+ component tests)
  - Disable (not hide) the approve button + explanatory tooltip (`aria-disabled` + `title` house pattern) when the caller owns the request (their `sub` === `ownerUserId`) AND their resolved `request:approve` grant carries `{key:"self-approval",match:"deny"}`. Map a server 403 with `code:"self_approval_forbidden"` to localized copy (no hardcoded strings). Server 403 authoritative — the UI is convenience only.
  - done when: component tests cover the disabled+tooltip state for an owned restricted request, the enabled state otherwise, and the 403-`code`→copy mapping.

- [ ] T6: e2e — segregation-of-duties journey — refs: US-1, US-2, US-3, US-4 — deps: T1, T3, T4, T5  **[quality-engineer]**
  - touch: `shell/e2e/self-approval-control.spec.ts`
  - Admin enables "cannot approve own request" on a role's approve rule (admin-ui) → a user with that role is blocked (403 / disabled button) approving their OWN request → the same user CAN approve another employee's request → reject/set-total on their own still work.
  - done when: the Playwright path passes against the running stack (or is authored + committed with each AC independently proven at integration/component level, per the 007/008/009 env-blocked posture).

- [ ] T7: close — all gates green, spec status → done — deps: T1–T6
  - done when: every task checked, QE PASS + owasp clean (≥medium fixed), eval PASS; spec `status: done`.

## Coverage map (AC → task)

AC-1.1 T4 · AC-1.2 T1 · AC-1.3 T4 · AC-1.4 T4 · AC-1.5 T1 · AC-1.6 T1 · AC-2.1 T3 · AC-2.2 T3 · AC-2.3 T3 · AC-2.4 T2,T3 · AC-3.1 T3 · AC-3.2 T1 · AC-3.3 T1 · AC-4.1 T3 · AC-4.2 T3 · AC-4.3 T1 · AC-4.4 T3 · AC-5.1 T1 · AC-5.2 T1 · AC-5.3 T1 · AC-6.1 T3,T5 · AC-6.2 T3 · AC-6.3 T3.

Every AC covered by ≥1 task; every task serves ≥1 AC. Parallelizable waves:
W1 {T1, T2, T4, T5} · W2 {T3} · W3 {T6} · close T7.
