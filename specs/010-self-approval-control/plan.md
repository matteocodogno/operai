---
spec: 010
status: approved
---

# Plan: Self-approval control — segregation of duties on refund approval

## Summary of resolved open questions (the plan's five calls)

1. **Condition representation** → a distinct condition kind carried in the EXISTING
   `attributes[]` array: `{ key: "self-approval", match: "deny" }`. Not a new `ownership`
   enum value; not a new top-level `RuleConditions` field. (Decision D1.)
2. **Enforcement point** → inline in the **approve decide path** (route + `approveRequest`
   repo), reusing `ownershipOwn`; NOT the shared `authzMiddleware`, NOT the generic
   `ensureInScopeSubmittedRequest` gate. (Decision D2.)
3. **Declare on reject/set-total now (unwired)?** → **NO** — declared on `approve` only
   (confirms the spec default). (Decision D3.)
4. **Observability** → **structured application logging** of a distinct
   `refund.self_approval_denied` event; the new-`AuditAction`-value path is rejected and
   named as the escalation. (Decision D4.)
5. **403 wording + UI** → RFC 7807 with a stable extension member `code:
   "self_approval_forbidden"` (i18n-safe discriminator, AC-6.1); refund-ui **passively
   disables** the approve button on the caller's own restricted request with a tooltip,
   server enforcement authoritative. (Decision D5.)

---

## Architecture

This feature threads one new, opt-in ABAC condition through the same catalog → resolver →
resource-server → admin-UI lifecycle that `entity` (ADR-0015) already uses, deliberately
reusing every existing seam so the change is additive and backward-compatible.

Components touched (nothing new is created; no new route, resource, or action):

- **auth (`auth/src/authz`)** — the declaration + resolution side (ADR-0007):
  - `catalogs/refund.ts` — `request.approve.supportedConditions` grows `["entity"]` →
    `["entity", "self-approval"]`. This is the ONLY change needed for the whole
    catalog/validation/wire chain, because the condition is an *attribute*, not a new
    top-level field.
  - `resolver.ts`, `resolve.routes.ts`, `authz.routes.ts` — **no code change**. The
    resolver's `toRuleConditions` already preserves arbitrary `attributes[]` entries
    verbatim; `ConditionAttributeSchema` on `/authz/me` and `/authz/resolve` is already
    `{ key: z.string(), match: z.string() }` (free-form), so the `{key:"self-approval",
    match:"deny"}` attribute serializes over the wire with zero schema change.
  - `admin/roles.routes.ts` — **no code change**. `findRuleViolations` already pushes
    every `attributes[].key` as a condition kind and validates it via
    `isConditionSupported`. Because the catalog declares `self-approval` on `approve`
    only, an admin attaching it to `reject`/`set-approved-total`/`review`/`read`/`create`
    is rejected 422 automatically (AC-5.2, AC-1.6, AC-4.3) — free from the existing gate.
  - `seed.ts` — **no role-grant change** (AC-3.2: never retrofitted). Only `REFUND_CATALOG`
    (the catalog constant) changes; `seedRefundCatalog`'s `upsertAppCatalog` full-replace
    upsert re-registers it idempotently and additively (US-5, AC-5.3). No seeded role gains
    the restriction.

- **refund-api (`refund-api/src/authz`, `src/review`)** — the enforcement side
  (ADR-0014/0015):
  - `authz/conditions.ts` — new pure predicate `approveSelfRestricted(conditions)` that
    scans the resolved approve grant's `attributes` for `{key:"self-approval",
    match:"deny"}`, mirroring `entityScopeForPermission`'s attribute scan. `ownershipOwn`
    is reused verbatim for the owner match (`record.ownerUserId === sub`) — no new
    ownership notion (spec Domain language, ADR-0014 point 3).
  - `review/review.service.ts` — new pure helper `approveRestrictedForCaller(authz)`
    (`= approveSelfRestricted(findPermission(authz.permissions,"request","approve")?.conditions)`)
    that composes independently of `scopeForReviewAction(authz,"approve")` — the two
    conditions are evaluated side by side, never one inside the other (AC-1.3, AC-2.4).
  - `review/decide.repo.ts` — `approveRequest` gains a `selfApprovalRestricted: boolean`
    parameter and evaluates the self-approval branch against the request's `ownerUserId`
    (added to the scope-check `select`). A new typed `SelfApprovalDeniedError` is failed
    when `restricted && ownerUserId === sub`, **before** the entity-scope 404 and the
    status 409. Reject/set-total call sites are untouched (US-4).
  - `review/decide.routes.ts` — the `approve` handler computes
    `approveRestrictedForCaller(authz)`, passes it into `approveRequest`, maps
    `SelfApprovalDeniedError` → the distinguishable 403 problem (D5), and emits the
    `refund.self_approval_denied` structured log line (D4). Nothing on the reject or
    set-approved-total handlers changes.

- **refund-ui** — the approve button on a request detail is passively disabled (with a
  tooltip) when the caller owns the request AND their resolved `request:approve` grant
  carries the restriction; the server 403 is authoritative regardless (Non-goal, D5).

- **admin-ui (`RoleEditor.tsx`, `ConditionChip.tsx`)** — a new chip kind + a composer
  toggle for the self-approval restriction, rendered as its own condition indicator,
  never conflated with the entity attribute (AC-1.1, AC-1.4).

Condition lifecycle (catalog → resolver → enforcement → UI):
`REFUND_CATALOG` declares `self-approval` on `request.approve` → admin enables it in
`RoleEditor`, persisted as `attributes:[{key:"self-approval",match:"deny"}]` on the
`permission_rule` (validated against the catalog, AC-5.2) → `resolveEffectivePermissions`
unions it into the caller's effective grant and `/authz/resolve` surfaces it verbatim →
`refund-api`'s `authzMiddleware` caches the resolve result, the approve route reads the
restriction off the grant and denies self-approval with a distinguishable 403 (ADR-0005's
"not yours = 404" is deliberately NOT applied here — the caller owns the record) → the log
event makes the firing observable (AC-6.2/6.3).

ADRs this rests on: ADR-0005 (JWKS resource-server, owner = JWT `sub`), ADR-0007
(hand-rolled RBAC/ABAC, catalog + live resolution, widest-wins union), ADR-0014 (refund-api
authorization-enforcing resource server, fail-closed), ADR-0015 (entity-scoped ABAC,
whole-request decisions, the composition partner), ADR-0018/0022 (immutable financial audit
trail — considered and deliberately NOT extended here, see D4).

---

## Decisions

### D1 — Condition representation: a `self-approval` attribute, `match: "deny"`

Represent the restriction as `{ key: "self-approval", match: "deny" }` inside the existing
`RuleConditions.attributes[]` array, declared via `request.approve`'s catalog
`supportedConditions: ["entity", "self-approval"]`.

Why this over the alternatives:

- **vs. a new `ownership` enum value (`not-own`)** — rejected. `approve` does not support
  `ownership` today at all, so this would require adding `ownership` to its
  `supportedConditions`, extending the `own|any` enum in THREE zod schemas
  (`roles.routes.ts`, `authz.routes.ts`, `resolve.routes.ts`) plus `toRuleConditions` plus
  admin-ui, and would pollute the resolver's width lattice: `ownershipTier` treats
  `own|any` as a *scope* axis (any ⊃ own), but `not-own` is a *deny carve-out*, not a wider
  or narrower scope — it does not belong on that axis. It would also render as a confusing
  third radio in admin-ui's existing any/own radiogroup. More surface, worse semantics.
- **vs. a new top-level `RuleConditions` field** (e.g. `selfApprovalRestricted: boolean`) —
  rejected as most-disruptive. Semantically cleanest, but it touches the resolver type +
  `toRuleConditions` + `widthScore` + both auth route schemas + refund-api
  `ResolveConditions` + admin-ui `RuleConditions` + composer. The attribute representation
  reuses ALL of that plumbing unchanged.
- **The attribute path is least-disruptive AND clearest:** one catalog constant edits from
  1 to 2 supported conditions; the wire schemas, resolver parse, and the admin off-catalog
  validator (`findRuleViolations`) are already generic over `attributes[].key` and a
  free-form `match` string — **zero code change** to any of them.

One documented wrinkle: entity/department/jobTitle attributes mean "record attr must equal
the actor's" (`match:"user"`, an *affirmative scope narrowing*); self-approval is the
opposite polarity — "deny when actor IS the owner." It therefore uses a distinct
`match:"deny"` sentinel and its own evaluator branch (never the entity scope path), and
admin-ui renders it as its own toggle outside the entity/dept/jobTitle checkbox group
(AC-1.4). admin-ui's `AttributeCondition.match` widens from `'user'` to `'user' | 'deny'`.

**Composition/width semantics (surface at the gate).** Because it lives in `attributes[]`,
the resolver's widest-wins dedup (`widthScore` uses `attributeCount` as a tiebreaker, so
"more attributes = narrower") treats a grant carrying the restriction as *narrower* than an
otherwise-equal grant without it. Consequence, identical to how `entity` scoping already
composes (ADR-0015) and consistent with ADR-0007's documented widest-wins union: **the
restriction only bites when the caller's EFFECTIVE (deduped) `approve` grant carries it** —
if the same user also holds another role that grants unconditioned `approve`, the union
resolves to the wider grant and the restriction does not apply. Since `approve` is granted
by very few roles (realistically the single `accounting` role), an admin closing the SoD
gap must enable the restriction on every approve-granting role. See Risks R1 for the narrow
tie/incomparability edge and its mitigation.

### D2 — Enforcement inline in the approve decide path

The self-approval check lives in the approve route + `approveRequest`, not the shared
`authzMiddleware` and not the generic `ensureInScopeSubmittedRequest`:

- `authzMiddleware` only resolves permissions (via `/authz/resolve`); it never loads domain
  records. The self-approval check needs the specific request's `ownerUserId` — a
  record-level attribute — exactly like the entity check needs the request's lines, and the
  entity check already lives at the route/repo layer (`scopeForReviewAction` +
  `ensureInScopeSubmittedRequest`), never the middleware.
- It is APPROVE-ONLY. `ensureInScopeSubmittedRequest` is shared by approve/reject/set-total;
  putting the check there risks bleeding into reject/set-total and violating US-4. A
  dedicated branch in `approveRequest` keeps the blast radius to approve.
- The 403-not-404 outcome is approve-specific and must be shaped distinctly (AC-6.1); the
  route is where problem responses are composed.

**Ordering** in the approve path: capability (403, absent grant → `scopeForReviewAction`
returns `undefined`, existing) → **self-approval (403)** → entity scope (404) → status
submitted (409) → approve. Self-approval is checked BEFORE entity scope deliberately: the
caller provably owns the record (they created it — no existence leak in returning 403), and
AC-2.4 requires the ownership denial to win "regardless of entity match." The shared
scope-check `select` gains `ownerUserId` (harmless extra column); the self-approval branch
runs only inside `approveRequest`.

### D3 — Declare on `approve` only

Confirmed NO for reject/set-approved-total. The catalog is the source of truth of what
refund-api actually ENFORCES (US-5); declaring `self-approval` on an action refund-api does
not check would let an admin attach a silently inert condition — a trust/correctness hole.
AC-4.3/AC-1.6 explicitly require it be undeclared on every action but `approve`.

### D4 — Observability via structured logging

On denial the approve route emits a distinct, parseable structured log event:

```
{ event: "refund.self_approval_denied", actorUserId: <sub>, requestId: <id>,
  timestamp: <ISO-8601> }
```

This satisfies AC-6.2 (a distinct attempted-but-denied event, never "nothing happened") and
AC-6.3 (who / which request / when).

Rejected: a new `AuditAction` value (`self_approval_denied`) on the append-only
`RefundAuditEntry` (ADR-0018/0022). A denied attempt is a *security/operational* event, not
a financial *state transition* — every existing audit row pairs with a real mutation inside
the same transaction, and the durable financial record that matters (who actually approved)
is already captured when a non-owner approves. Adding denied attempts would (a) pollute that
state-transition trail, (b) open an unbounded-append vector on an immutable table (an owner
can retry a denied approve arbitrarily — the request stays `submitted`), and (c) require a
migration. Structured logging is fully additive and satisfies the ACs.

Named escalation (ADR-0012-style "future hardening"): if wellD's auditors require
regulator-grade durable retention of denied attempts, adopt the audit-row variant with an
`INSERT … ON CONFLICT DO NOTHING` against a partial unique index on
`(requestId, actorUserId) WHERE action='self_approval_denied'` to bound the append. **Flag
for the gate:** this is a genuine judgment call; a reviewer who weights durability over trail
purity may prefer the audit-row variant now.

### D5 — 403 problem shape + UI

- **Wire:** RFC 7807 Problem JSON, `status: 403`, `title: "Forbidden"`, human `detail`
  ("You cannot approve a refund request you submitted yourself."), plus a stable **extension
  member `code: "self_approval_forbidden"`**. The `code` is the robust, i18n-safe
  discriminator (detail strings are localized/variable), distinguishing this 403 from the
  capability-absent 403 (which carries no such `code`) — satisfying AC-6.1. (An entity-scope
  denial is a 404, so it is already distinct by status.)
- **refund-ui:** passively **disable** (not hide) the approve button when the caller owns the
  request AND their resolved `request:approve` grant carries the restriction, with an
  explanatory tooltip (the suite's `aria-disabled` + `title` house pattern). Hiding would
  leave the absence unexplained. The UI computes this locally from its own `sub`, the
  request's `ownerUserId`, and its resolved grant — but this is convenience only; the server
  403 is authoritative (spec Non-goal / Constraints). refund-ui also maps the 403 `code` to
  localized copy if the action is somehow attempted (no hardcoded UI strings, per CLAUDE.md).
- **admin-ui:** no approve action exists there; the only admin-ui change is the RoleEditor
  chip + composer toggle (AC-1.1/1.4).

---

## Data model

**No schema/enum change, no migration.** The restriction is stored inside the existing
`permission_rule.conditions` `Json?` column as an `attributes[]` entry — the same column and
shape `entity` already uses. `RefundAuditEntry`/`AuditAction` are deliberately untouched
(D4). Prisma migrations remain additive-by-nothing.

Persisted rule shape for a fully-configured approve rule (both conditions):

```jsonc
{ "attributes": [ { "key": "entity", "match": "user" },
                  { "key": "self-approval", "match": "deny" } ] }
```

An approve rule with only the self-approval restriction: `{ "attributes":
[{ "key": "self-approval", "match": "deny" }] }`. Absent restriction = today's shape,
unchanged (AC-3.1/3.3).

---

## API contracts

No new routes. Two contract touch-points, both additive:

### 1. Catalog declaration (`GET /authz/catalog` / `GET /admin/catalog`)

`request.approve.supportedConditions` changes from `["entity"]` to
`["entity", "self-approval"]`. Every other action's `supportedConditions` is unchanged
(AC-5.1). The wire schema (`CatalogActionView.supportedConditions: string[]`) is unchanged.

### 2. Condition shape on `/authz/me` + `/authz/resolve` (and `PUT /admin/roles/:id/rules`)

Unchanged schema — the restriction rides the existing free-form `attributes[]`:

```jsonc
// one permission entry in a /authz/resolve response
{ "resource": "request", "action": "approve",
  "conditions": { "attributes": [ { "key": "entity",        "match": "user" },
                                  { "key": "self-approval",  "match": "deny" } ] } }
```

`ConditionAttributeSchema` is `{ key: z.string(), match: z.string() }` on all three routes
today, so this validates as-is. Attaching `self-approval` to any non-`approve` action via
`PUT /admin/roles/:id/rules` returns the existing 422 (AC-5.2).

### 3. Approve self-approval denial (`POST /review/requests/{id}/approve` → 403)

```jsonc
{ "type":   "https://httpstatuses.com/403",
  "title":  "Forbidden",
  "status": 403,
  "detail": "You cannot approve a refund request you submitted yourself.",
  "instance": "/review/requests/{id}/approve",
  "code":   "self_approval_forbidden" }        // ← distinguishing extension member (AC-6.1)
```

The pre-existing capability-absent 403 (no `approve` grant at all) is unchanged and carries
no `code`. The out-of-scope case remains 404 (unchanged). On this 403 the request's status,
per-line approved totals, and audit trail are left exactly as they were (AC-2.1).

---

## Test strategy

Every AC mapped to a level and the artifact that proves it. Mapping is total (24 ACs).

| AC | Level | What proves it |
|----|-------|----------------|
| AC-1.1 | admin-ui component | RoleEditor composer for `request.approve` renders a distinct "cannot approve own request" toggle, separate from the entity checkbox |
| AC-1.2 | auth integration + admin-ui component | `PUT /admin/roles/:id/rules` persists the `self-approval` attribute; `bumpPermissionEpoch` fires; `/authz/resolve` returns it on the next call (no re-login) |
| AC-1.3 | admin-ui component | save+reopen a rule with BOTH entity and self-approval → two independent chips; toggling one leaves the other |
| AC-1.4 | admin-ui component | `ConditionChip` renders a dedicated self-approval chip glyph/label, never merged into the entity chip |
| AC-1.5 | auth integration | disabling the restriction and re-saving removes the attribute; `/authz/resolve` no longer returns it; refund-api then allows self-approval |
| AC-1.6 | auth integration | `PUT /admin/roles/:id/rules` with `self-approval` on `reject`/`set-approved-total`/`review`/`read`/`create` → 422 (`findRuleViolations`) |
| AC-2.1 | refund-api integration | owner + restricted approve grant → `POST .../approve` returns 403 `code:self_approval_forbidden`; request row, line totals, audit rows unchanged |
| AC-2.2 | refund-api integration | same caller, a request they do NOT own → self-approval does not block; proceeds to entity/status gates as today |
| AC-2.3 | refund-api integration | multi-line owned request → whole-request 403, no partial/per-line approval |
| AC-2.4 | refund-api integration | grant with BOTH entity + self-approval: owned request denied regardless of entity match; non-owned request still entity-gated exactly as 007 AC-6.4/6.5 |
| AC-2.4 | refund-api unit | `approveSelfRestricted` + `entityScopeForPermission` evaluated independently on the same conditions object |
| AC-3.1 | refund-api integration | approve grant WITHOUT the restriction → owner self-approves successfully (007 AC-7.2 unchanged) |
| AC-3.2 | auth integration | seed run asserts no seeded role/rule carries `self-approval`; catalog re-register does not mutate any existing rule |
| AC-3.3 | auth integration | catalog upsert is additive — existing rules' resolved meaning byte-identical before/after; resolver golden test unchanged |
| AC-4.1 | refund-api integration | owner + restricted approve grant + reject grant → `POST .../reject` NOT blocked by this feature |
| AC-4.2 | refund-api integration | same owner → `PUT .../approved-total` NOT blocked |
| AC-4.3 | auth unit | `REFUND_CATALOG` snapshot: `self-approval` in `approve.supportedConditions` only; absent from all other actions |
| AC-4.4 | refund-api integration | owner creates/submits their own request while holding a restricted role → create/submit unaffected; restriction inert until approve |
| AC-5.1 | auth unit | catalog snapshot: `approve.supportedConditions == ["entity","self-approval"]`; other actions unchanged |
| AC-5.2 | auth integration | (covered by AC-1.6) unsupported-condition attach → 422 |
| AC-5.3 | auth integration | pre-existing roles/rules remain valid and resolve identically after the catalog gains the condition |
| AC-6.1 | refund-api integration | the 403 body carries `code:self_approval_forbidden`, distinct from a capability-absent 403 (no `code`) and an entity 404 |
| AC-6.2 | refund-api integration | a denied attempt emits the `refund.self_approval_denied` structured log event (assert via captured logger) |
| AC-6.3 | refund-api integration | the logged event includes `actorUserId`, `requestId`, ISO-8601 `timestamp` |

Plus a refund-api **unit** suite for the new pure predicate `approveSelfRestricted`
(present/absent attribute, wrong `match`, composed with entity) and reuse of `ownershipOwn`.

No AC is unmappable — the spec and plan are consistent.

---

## Risks

- **R1 — Widest-wins composition can drop the restriction (security-relevant).** Per D1, a
  second role granting unconditioned `approve` unions to the wider grant and the restriction
  stops biting; and a narrow tie exists between a self-approval-only grant and an entity-only
  grant (both score `1000×1 − 1` under `attributeCount`), which the flat `widthScore` cannot
  correctly join (they are incomparable multi-axis grants). *Mitigation / early check:* seeded
  and realistic configs grant `approve` from a single `accounting` role, so the multi-grant
  collision is not reachable in practice; an admin closing the SoD gap enables the restriction
  on every approve-granting role. Add an explicit resolver/composition unit test asserting the
  documented behavior. *Escalation (do NOT do now):* give `widthScore` a dedicated sub-unit
  term for the self-approval flag (so it never ties against a scope attribute), or move to
  per-axis lattice join — named as an ADR follow-up if wellD ever grants `approve` from
  multiple roles. Surface this at the gate.

- **R2 — `authzMiddleware`'s 30s resolve cache (ADR-0014).** After an admin toggles the
  restriction, refund-api may serve a stale grant for up to the cache TTL. This is the
  established, accepted ADR-0014 posture (also true for entity changes today) and AC-1.2's
  "next time their effective permissions are resolved" tolerates it. No new mitigation; called
  out for completeness.

- **R3 — UI/enforcement divergence.** refund-ui disables the button from its own local
  computation; if it computed wrongly (e.g. stale `/authz/me`), the button could be enabled
  when the server will deny (or vice-versa). *Mitigation:* the server 403 is authoritative and
  is the tested contract (AC-2.1/6.1); the UI hint is convenience only. Test the server path
  independently of any UI state.

- **R4 — `match:"deny"` polarity confusion.** A future author could mistake the self-approval
  attribute for an affirmative `match:"user"` scope attribute and route it through
  `entityScopeForPermission`. *Mitigation:* a dedicated `approveSelfRestricted` predicate with
  an explicit doc comment on the opposite polarity, and a unit test asserting the entity path
  ignores `key:"self-approval"` and vice-versa.

---

## Security

**Security-sensitive: YES.** This is an authorization-enforcement change on a financial
approval action — a segregation-of-duties / self-reimbursement fraud control. The orchestrator
should schedule an **`owasp-reviewer` pass in parallel with QE** (production rigor; the change
sits on the auth model + a financial-approval control). Because it touches an authorization
control on regulated financial data, consider escalating that review to the frontier tier.

Surfaces to review specifically:

- `POST /review/requests/:id/approve` (refund-api `decide.routes.ts` + `decide.repo.ts`) —
  the enforcement point. Verify: fail-closed (an `auth`/resolve outage already yields 503 via
  `authzMiddleware`, ADR-0014 — the new branch must not introduce an allow-path on any error);
  the check cannot be bypassed by omitting/altering the request body (approve takes no body);
  ordering (self-approval evaluated before status/scope so the denial is not masked); the 403
  leaks nothing beyond "you own this" (which the owner already knows).
- **Can't-bypass-via-UI:** refund-ui only *disables* the button; the server denial is the
  control. Assert the 403 fires even when the request is issued directly (bypassing the UI).
- **Catalog/validation gate** (`findRuleViolations`) — confirm `self-approval` cannot be
  attached to any action other than `approve` (A01 broken-access-control: no inert/misapplied
  condition on reject/set-total).
- **Composition with entity** (A01) — confirm the restriction is enforced together with, and
  independently of, entity scope (AC-2.4), and review R1's widest-wins drop as an intentional,
  documented property, not an accidental bypass.
- **Log hygiene (A09)** — the `refund.self_approval_denied` event carries `actorUserId`/
  `requestId` (identifiers) only, no PII/financial amounts.

---

## ADR candidates

For the caller to invoke `adr-writer` (I do not write ADRs):

- **Self-approval / "not-own" condition semantics + the 403-not-404 exception.** A new,
  opt-in `attributes:[{key:"self-approval",match:"deny"}]` deny-carve-out condition on
  `request:approve`, evaluated at the approve decide path against `ownerUserId`, returning a
  **403 (not the suite-standard "not yours = 404")** because the caller provably owns the
  record and holds the capability — a deliberate, documented exception to ADR-0005/0014.
  Records the `match:"deny"` polarity vs. entity's `match:"user"`, and the widest-wins
  composition property (R1: the restriction only bites on the effective deduped grant).
- **(Conditional) Observability of denied authorization attempts via structured logging vs.
  the immutable audit trail** — if the gate accepts D4, a short ADR (or an addendum to
  ADR-0018) recording that *denied* authz attempts are logged, not written to the
  state-transition `RefundAuditEntry`, and naming the audit-row variant as the escalation.
  Only worth an ADR if D4 is contested at the gate.

---

## Proposed spec amendments

None. The spec is internally consistent and every AC maps cleanly; the five open questions
it delegated to the plan are resolved above.
