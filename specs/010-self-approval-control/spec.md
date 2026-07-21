---
id: 010
slug: self-approval-control
status: approved
rigor: production
created: 2026-07-21
approved: 2026-07-21
---

# Self-approval control: segregation of duties on refund approval

## Problem

`specs/007-refund-service` lets an admin grant the `accounting` role's `request:approve`
capability to a user, scoped by entity (`specs/004`, ADR-0015) — but that capability
carries no notion of who the requester is. An employee who also holds `accounting` for
their own entity can file their own refund request (US-1, 007) and then, as the very
same person, approve it: nothing in today's model or enforcement distinguishes "a
request submitted by someone else" from "a request I submitted myself." This is a
segregation-of-duties gap and a direct self-reimbursement fraud vector — a financial
control any competent audit would flag — and it exists silently today because approval
was never conditioned on ownership, only on entity scope. As the suite already ships a
DB-level immutable audit trail for financial and authorization changes (ADR-0018,
ADR-0022) and is expanding accounting's surface further (specs/008/009), wellD needs a
way to close this specific gap without weakening or duplicating anything else in the
authorization model.

## Domain language

Extends `specs/004-auth-roles-permissions`'s and `specs/007-refund-service`'s domain
language (role, permission rule, condition, entity, `accounting`, request, owner —
reused verbatim except where amended below). New term for this feature:

- **self-approval restriction** (also: **"cannot approve own request"**, a
  segregation-of-duties condition) — a NEW, opt-in condition that an admin may attach
  to a role's `approve` permission rule for the `request` resource, alongside the
  existing `entity` condition (004, ADR-0015), which it composes with rather than
  replaces. When present on the rule a user's role grants them, that user is denied
  approving a request they themselves **own** — but remains able to approve requests
  they do not own, subject to whatever entity scope the same rule also carries. When
  absent, approve behaves exactly as it does today (self-approval permitted). This
  spec fixes the product-level semantics; the precise representation of the condition
  (e.g. a new `ownership` value alongside the existing `own`/`any`, versus an
  independent condition kind) is an open question for the plan (see Open questions).
- **own** (as applied to this condition) — the caller is the request's **owner**: the
  employee who created/submitted it (007's `ownerUserId`), matched against the caller's
  authenticated identity (the JWT `sub`, ADR-0005). This reuses 007/ADR-0014's existing
  owner-matching semantics (already used for `request:read`'s `ownership:own`
  condition) — this feature does not introduce a new notion of ownership, only a new
  place that notion is checked and a new outcome (denial) when it matches.
- **self-approval denial** — the 403 response returned when a user whose `approve` rule
  carries the self-approval restriction attempts to approve a request they own. This is
  a deliberate, visible contrast with the suite's usual "not yours = not found" 404
  convention for ownership mismatches (ADR-0005/ADR-0014): here the caller unambiguously
  DOES have both the capability and the record (it is their own request) — what is
  denied is the specific combination of "this action, on this owned record, under this
  rule's condition" — so a 403 (forbidden), not a 404, is the correct and expected
  status. See Constraints.

## User stories

### US-1: Admin enables the self-approval restriction on a role's approve rule

As an authorization admin, I want to mark a role's refund-approve permission as
"cannot approve own request," so that I can close the self-reimbursement gap for
whichever roles should never let a person sign off on their own claim, without
touching any other role or any other action.

**Acceptance criteria:**
- AC-1.1: Given an admin editing a role's permission rule for `request` → `approve`,
  when they open the rule's condition options, then a "cannot approve own request"
  condition is offered as a distinct, independently toggleable option — separate from
  the existing entity condition (004).
- AC-1.2: Given an admin, when they enable the self-approval restriction on a role's
  `approve` rule and save it, then it is persisted as part of that rule and every user
  holding that role (directly or via a department, 004) is affected the next time their
  effective permissions are resolved (`/authz/me`/`/authz/resolve`, 004/ADR-0007) —
  no re-login or manual propagation step is required.
- AC-1.3: Given a role's `approve` rule that has BOTH the entity condition and the
  self-approval restriction enabled, when it is saved and later re-opened, then both
  conditions are shown as attached and neither one's presence or configuration is
  altered by editing the other — the two compose independently (see US-2, AC-2.4).
- AC-1.4: Given a rule with the self-approval restriction enabled, when an admin (or any
  viewer with rule-visibility) inspects it in the role-rule builder, then it is visibly
  distinguished by its own condition indicator (mirroring the existing condition-chip
  presentation for entity/ownership/department/job-title, 004), never conflated with or
  hidden inside the entity condition's display.
- AC-1.5: Given an admin, when they DISABLE a previously-enabled self-approval
  restriction on a role's `approve` rule and save it, then self-approval becomes
  possible again for users holding that role, exactly as if the condition had never
  been set (AC-1.2's live-propagation guarantee applies symmetrically to removal).
- AC-1.6: Given the self-approval restriction, when an admin attempts to attach it to
  any `request` action OTHER than `approve` (e.g. `reject`, `set-approved-total`,
  `review`, `read`, `create`), then it is not offered/accepted there — the catalog
  declares it as supported on `approve` only (see US-4).

### US-2: A user with the restriction cannot approve their own request

As wellD, I want a user whose role carries the self-approval restriction to be
concretely stopped from approving a request they filed themselves, so that the control
actually prevents self-reimbursement rather than merely being configurable.

**Acceptance criteria:**
- AC-2.1: Given a user holding a role whose `approve` rule has the self-approval
  restriction enabled, when they attempt to approve a request they own (their
  `ownerUserId`, US-1's "own"), then the attempt is denied with a 403 and no approval
  is recorded — the request's status, per-line approved totals, and audit trail are
  left exactly as they were before the attempt (see US-6 for the denial's
  observability).
- AC-2.2: Given the same user and the same rule, when they attempt to approve a request
  they do NOT own, then the self-approval restriction does not block them — the
  attempt proceeds to whatever the rule's OTHER conditions (e.g. entity scope, 007
  AC-7.2) allow or deny, exactly as if the self-approval restriction were absent.
- AC-2.3: Given a request with multiple expense lines, when the requesting user is also
  its owner and attempts to approve it, then AC-2.1 applies to the WHOLE request —
  there is no partial approval by line, consistent with 007's existing whole-request
  decision model (007 "decision," "entity" domain terms).
- AC-2.4: Given a role whose `approve` rule carries BOTH the entity condition and the
  self-approval restriction, when a user holding that role attempts to approve a
  request, then BOTH conditions are enforced together — a request they own is denied
  regardless of entity match (AC-2.1), and a request they do not own is still subject
  to the entity condition exactly as it is today (007 AC-6.4/AC-6.5, ADR-0015)
  unaffected by this feature.

### US-3: A user without the restriction is unaffected

As an authorization admin, I want roles that never had this condition enabled to keep
behaving exactly as they do today, so that turning on the self-approval restriction
for some roles never surprises the roles I didn't touch.

**Acceptance criteria:**
- AC-3.1: Given a role whose `approve` rule does NOT carry the self-approval
  restriction (the default — condition absent), when a user holding that role attempts
  to approve a request they own, then the approval proceeds exactly as it does before
  this feature ships (007 AC-7.2), gated only by whatever OTHER conditions (e.g.
  entity) the rule already carries.
- AC-3.2: Given every role and permission rule that exists in the system at the moment
  this feature ships, when this feature is deployed, then none of them gain the
  self-approval restriction automatically — it is never retrofitted, defaulted-on, or
  bulk-applied to any existing rule; an admin must explicitly opt each role in
  (US-1, AC-1.2).
- AC-3.3: Given the catalog change that adds the new condition (US-4), when it ships,
  then it is additive only — no existing role, rule, or resolved permission set changes
  meaning or behavior as a side effect of the catalog gaining this new option.

### US-4: The restriction applies to approve only

As wellD, I want the self-approval restriction to affect exactly the approve decision
and nothing else, so that accounting's ability to reject or adjust their own submitted
claims (where that's already permitted) is not collaterally removed by a control aimed
squarely at approval.

**Acceptance criteria:**
- AC-4.1: Given a user holding a role whose `approve` rule has the self-approval
  restriction enabled, when they attempt to REJECT a request they own (with the
  `reject` capability, 007 AC-7.3), then the attempt is NOT blocked by this feature —
  it proceeds exactly as 007 already specifies, gated only by whatever conditions the
  `reject` rule itself carries.
- AC-4.2: Given the same user, when they attempt to SET the approved-total on a line of
  a request they own (with the `set-approved-total` capability), then the attempt is
  likewise NOT blocked by this feature.
- AC-4.3: Given the permission catalog (US-5), when it is inspected, then the
  self-approval restriction is declared as a supported condition on `request` →
  `approve` only — it is not declared as supported on `reject`, `set-approved-total`,
  `review`, `read`, or `create` (mirrors AC-1.6 from the admin-UI side; this is the
  catalog-level source of that constraint).
- AC-4.4: Given a request an employee both owns and has submitted, when that same
  employee (separately) holds a role whose `approve` rule carries the restriction, then
  self-SUBMISSION and self-CREATION of the request (007 US-1) are entirely unaffected
  by this feature at every step prior to a decision — the restriction only ever
  activates at the moment an approve action is attempted.

### US-5: The catalog declares the new condition, backward compatibly

As an app author (refund-api) and as the Admin tool, we want the permission catalog to
be the single source of truth for which conditions `approve` supports, so that the
role-rule builder only ever offers real, enforced options and refund-api never accepts
a condition it doesn't actually check.

**Acceptance criteria:**
- AC-5.1: Given the refund permission catalog after this feature ships, when it is
  loaded (by the Admin tool or any consumer), then the `request` resource's `approve`
  action declares the self-approval restriction as one of its `supportedConditions`,
  alongside the existing `entity` condition — `approve`'s declared conditions grow from
  one to two; every other action's declared conditions are unchanged (AC-4.3).
- AC-5.2: Given an admin attempts to attach the self-approval restriction to an action
  that does not declare it as supported (US-4, AC-1.6), then the attempt is rejected —
  mirroring 004's existing AC-3.2 behavior for any rule referencing an
  unsupported/undeclared condition.
- AC-5.3: Given every role and rule that existed before this feature's catalog change,
  when the catalog is reloaded post-ship, then they remain exactly as valid and
  functional as before — no existing rule is invalidated, migrated, or requires
  re-saving because the catalog gained this new declared condition (AC-3.3).

### US-6: A denied self-approval is distinguishable

As wellD (and as an auditor), I want a denial caused specifically by the self-approval
restriction to be identifiable after the fact, so that the control's operation is
observable and reviewable, not just silently enforced.

**Acceptance criteria:**
- AC-6.1: Given a self-approval denial (US-2, AC-2.1), when the response reaches the
  caller, then its error body clearly communicates that the denial is because the
  caller owns the request they attempted to approve — a generic, undifferentiated 403
  (indistinguishable from, say, an entity-scope denial) does not satisfy this AC. The
  exact wire format/problem-type is the plan's call (RFC 7807 Problem JSON is the
  suite's existing convention).
- AC-6.2: Given a self-approval denial, when it occurs, then it is observable after the
  fact through the suite's existing operational visibility (e.g. logs, or the request's
  existing audit trail, ADR-0018) as a distinct, attempted-but-denied event — the exact
  mechanism (a new audit-entry action type vs. structured log entry vs. another means)
  is left to the plan, but a denial must not be indistinguishable from "nothing
  happened."
- AC-6.3: Given a self-approval denial, when it is recorded/logged, then it captures at
  minimum: which user attempted it, which request, and the timestamp — sufficient for
  an auditor to reconstruct that the control fired and for whom.

## Non-goals

- **Applying the restriction to `reject` or `set-approved-total`.** Explicitly out of
  scope for this feature (US-4) — only `approve` gains the condition; a future spec
  would be required to extend it further.
- **A global, always-on self-approval rule.** This is strictly per-role and opt-in
  (US-1, AC-3.2) — there is no suite-wide default that blocks self-approval regardless
  of role configuration.
- **Changing the existing `entity` condition** on `approve` or any other `request`
  action — its behavior, semantics, and composition (ADR-0015) are untouched; this
  feature only adds a second, independent condition that composes alongside it
  (AC-1.3, AC-2.4).
- **Blocking self-submission or self-creation of a request.** An employee filing their
  own refund request (007 US-1) is completely unaffected — only the `approve` action,
  at decision time, is gated by this feature (AC-4.4).
- **Retroactively altering already-approved requests.** A request approved before this
  feature shipped, or approved under a rule that never had the restriction enabled, is
  never revisited, flagged, or unwound by this feature — it applies only to future
  approve attempts evaluated under a rule that has the restriction enabled at the time
  of the attempt.
- **Migrating or bulk-enabling the restriction on any existing role.** Every role
  starts, and stays, without the restriction unless an admin explicitly enables it
  (AC-3.2) — this feature ships the capability, not a decision about which of wellD's
  actual roles should use it.
- **A new distinct UI surface in refund-ui beyond what the existing decision flow
  already needs to reflect a denial.** How the approve action's disabled/denied state
  is presented to the accounting user in refund-ui is a UX concern for the plan, not
  specified here beyond "server-side enforcement is authoritative regardless of what
  the UI shows or hides" (see Constraints).

## Constraints

*Facts already established by the codebase/prior specs, captured verbatim for the
plan, not elaborated here.*

- Authorization is hand-rolled RBAC/ABAC in the `auth` service (ADR-0007): a per-app
  catalog declares each (resource, action, `supportedConditions`); roles carry
  permission rules with conditions; effective permissions are resolved live via
  `/authz/me` and `/authz/resolve` — never embedded in the JWT. This feature adds one
  new condition option to one existing (resource, action) pair; it introduces no new
  resource and no new action.
- `refund-api` is the authorization-enforcing resource server (ADR-0014) for the
  `request` resource; entity-scoped ABAC on `approve`/`reject`/`review`/
  `set-approved-total` is ADR-0015. Enforcement of this feature's condition belongs in
  the same place refund-api already enforces `approve` (`src/review/`, `src/authz/`)
  — the exact enforcement point (the shared `authzMiddleware` vs. the decide
  route/service itself) is the plan's call (see Open questions).
- The `request` resource's catalog (`auth/src/authz/catalogs/refund.ts`) currently
  declares `approve` with `supportedConditions: ["entity"]` only, and separately
  declares `read` with `supportedConditions: ["ownership"]` (an `own`/`any` enum
  value). This feature's representation choice — extending the existing `ownership`
  enum with a new value (e.g. `not-own`) vs. introducing an independent condition kind
  — is explicitly not decided here (see Open questions).
- `refund-api`'s existing ownership-mismatch pattern (`ownershipOwn` in
  `src/authz/conditions.ts`) returns a record-level 404 for "not yours" (ADR-0005/
  ADR-0014's "not yours = not found" convention, used for `request:read`'s
  `ownership:own`). This feature's self-approval denial is the OPPOSITE case — the
  record IS the caller's own — and per this spec's fixed decision (Problem statement,
  Domain language) it is a 403, not a 404; the plan should treat this as a deliberate,
  documented exception to that existing pattern, not a bug to reconcile away.
- admin-ui's role-rule builder (`RoleEditor.tsx`, `ConditionChip.tsx`) renders
  conditions from the catalog's `supportedConditions` and today's `ConditionChipKind`
  enum is `'own' | 'any' | 'entity' | 'department' | 'jobTitle'` — this feature
  requires at least a new chip presentation for the self-approval restriction (exact
  chip kind/label is the plan's call, consistent with whatever representation is
  chosen for the condition itself).
- A request's owner is `RefundRequest.ownerUserId`, set from the JWT `sub` at creation
  (007, ADR-0005) — this feature reuses that field and matching rule verbatim; it does
  not introduce a new notion or storage of ownership.
- The suite's financial/authorization audit posture (ADR-0018, ADR-0022) favors
  durable, queryable records of consequential actions; whether a denied self-approval
  attempt specifically warrants a new `RefundAuditEntry`/`AuditAction` value (extending
  ADR-0018/0022's pattern) or is satisfied by structured logging is the plan's call
  (US-6, Open questions) — but per AC-6.2/AC-6.3, "nothing recorded at all" does not
  satisfy this spec.

## Open questions

- [ ] Exact condition representation: a new `ownership` enum value (e.g. `not-own`)
  alongside the existing `own`/`any`, versus an entirely distinct condition kind (e.g.
  a boolean `selfApprovalRestricted` flag on the `approve` rule). Affects the catalog
  schema, the resolver's `conditions` shape, admin-ui's `ConditionChip`, and
  refund-api's evaluator. — owner: architect (plan)
- [ ] Enforcement point: whether the self-approval check belongs in the shared
  `authzMiddleware`/condition-resolution layer (alongside `entityScopeForPermission`)
  or is evaluated inline in the `approve` decide route/service after the record is
  loaded (since it needs the specific request's `ownerUserId`, unlike the
  entity-scope check which today only needs the request's lines). — owner: architect
  (plan)
- [ ] Whether the self-approval restriction should also be DECLARED as a supported
  condition in the catalog for `reject`/`set-approved-total` even though this feature
  only wires enforcement for `approve` (i.e. ship the option now, activate it there
  later) — default per this spec is NO, declare it on `approve` only (US-4, AC-4.3);
  confirm or override at plan time. — owner: architect (plan)
- [ ] Exact mechanism for US-6's denial observability: a new `AuditAction` value on the
  existing append-only `RefundAuditEntry` (extending ADR-0018/0022) vs. structured
  application logging only. — owner: architect (plan)
- [ ] Exact RFC 7807 problem-type/detail wording for the self-approval 403 (AC-6.1),
  and whether refund-ui/admin-ui should preemptively hide or merely passively disable
  the approve action in the UI when the caller's own request is in view under a
  restricted role. — owner: architect (plan)
