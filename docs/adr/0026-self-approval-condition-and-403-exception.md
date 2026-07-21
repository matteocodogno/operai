# 0026 — Self-approval segregation-of-duties condition: a `match:"deny"` attribute, enforced inline as a documented 403-not-404 exception

**Date:** 2026-07-21
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/007-refund-service` lets an admin grant `accounting`'s `request:approve` capability
scoped by entity (`specs/004`, ADR-0015) but has no notion of who the requester is: a user
who holds `accounting` for their own entity and also files their own refund request can
approve that same request — a segregation-of-duties gap and a direct self-reimbursement
fraud vector. `specs/010-self-approval-control` closes this with a new, opt-in
"cannot approve own request" condition on `request:approve` only. The condition must ride
the suite's existing hand-rolled RBAC/ABAC model (ADR-0007) without touching the JWT
(identity + `perm_epoch` only) and must compose with, not replace, the existing `entity`
condition (ADR-0015). Two design questions the spec deliberately deferred: how to represent
"deny when the caller owns the record" inside a condition model whose only existing
ownership vocabulary is the `own`/`any` `ownership` enum (used today for `request:read`),
and what status code to return, given the suite's established "not yours = 404" convention
(ADR-0005/ADR-0014) is inverted here — the caller unambiguously *does* own the record.

## Decision

We will represent the restriction as a new attribute `{ key: "self-approval", match: "deny" }`
inside the existing `RuleConditions.attributes[]` array — declared via `request.approve`'s
catalog `supportedConditions` growing from `["entity"]` to `["entity", "self-approval"]`, a
one-constant change in `auth/src/authz/catalogs/refund.ts` with no resolver, wire-schema, or
migration change — and we will enforce it **inline in refund-api's approve decide path**
(`review/decide.repo.ts`'s `approveRequest` + a new pure `approveSelfRestricted` predicate in
`src/authz/conditions.ts`, reusing `ownershipOwn` verbatim), returning a distinguishable
**403** *before* the entity-scope 404 and the status 409 gates — a deliberate, documented
exception to ADR-0005/ADR-0014's "not yours = not found" convention.

1. **Representation: an attribute with `match:"deny"`, not a new `ownership` enum value, not a
   new top-level field.** `entity`/`department`/`jobTitle` attributes already mean "record
   attribute must equal the actor's" (`match:"user"` — an affirmative scope narrowing);
   self-approval is the opposite polarity — "deny when the actor IS the owner" — so it gets its
   own sentinel value (`match:"deny"`) and its own evaluator branch, never routed through
   `entityScopeForPermission`. `ConditionAttributeSchema` (`{key: z.string(), match: z.string()}`)
   is already free-form on `/authz/me`, `/authz/resolve`, and `PUT /admin/roles/:id/rules`, and
   the admin off-catalog validator (`findRuleViolations`) already pushes every `attributes[].key`
   through `isConditionSupported` — so the attribute path is zero code change across the entire
   wire/validation chain. Persisted shape:
   ```jsonc
   { "attributes": [ { "key": "entity",        "match": "user" },
                     { "key": "self-approval",  "match": "deny" } ] }
   ```
2. **Enforcement point: inline in `approveRequest`, not `authzMiddleware`, not the shared
   `ensureInScopeSubmittedRequest` gate.** `authzMiddleware` only resolves permissions — it
   never loads domain records — and the check needs the specific request's `ownerUserId`, a
   record-level fact, exactly as the entity check needs the request's lines (also enforced at
   the route/repo layer, per ADR-0015, never the middleware). Restricting the branch to
   `approveRequest` specifically (not the shared submitted/status gate reused by
   reject/set-approved-total) keeps the blast radius to `approve` only, matching US-4.
   **Ordering:** capability (403, no grant at all) → **self-approval (403)** → entity scope
   (404) → status submitted (409) → approve. Self-approval is checked before entity scope
   deliberately: the caller provably owns the record (no existence leak in a 403 here), and the
   ownership denial must win regardless of entity match.
3. **403, not 404 — the documented exception.** ADR-0005/ADR-0014 establish "not yours = 404,"
   used verbatim for `request:read`'s `ownership:own` condition and for entity-scope mismatches
   (ADR-0015). That convention exists to avoid leaking the *existence* of a record the caller has
   no relationship to. Here the inversion is exact: the caller **does** own the record and
   **does** hold the `approve` capability — what's denied is the specific combination "this
   action, on this owned record, under this rule's condition." Returning 404 would be actively
   misleading (the caller already knows the request exists — they created it); 403 with a stable
   discriminator is the correct, non-leaking signal.
4. **Composition: widest-wins, unchanged.** Because the restriction lives in `attributes[]`, the
   resolver's existing widest-wins dedup (ADR-0007) treats a grant carrying it as *narrower* than
   an otherwise-equal grant without it — **the restriction only bites on the caller's effective
   (deduped) `approve` grant.** If the same user also holds a second role granting unconditioned
   `approve`, the union resolves to the wider grant and the restriction does not apply, exactly as
   entity scoping already composes (ADR-0015). This is a decided, accepted property, not a bug: an
   admin closing the SoD gap must enable the restriction on every `approve`-granting role. Realistic
   seeded configs grant `approve` from a single `accounting` role, so the multi-grant collision is
   not reachable today.
5. **Observability: structured logging, not a new `AuditAction`.** A denied attempt emits a
   structured log event `refund.self_approval_denied` (`actorUserId`, `requestId`, ISO-8601
   `timestamp`) from the approve route. We explicitly did **not** add a new `AuditAction` value to
   the append-only `RefundAuditEntry` (ADR-0018/ADR-0022): every existing audit row pairs with a
   real state-transition mutation inside the same transaction, and a denied attempt is a
   security/operational event, not a financial state transition. Recording it there would (a)
   pollute the state-transition trail with non-mutations, (b) open an unbounded-append vector on an
   immutable table — an owner can retry a denied approve arbitrarily while the request stays
   `submitted` — and (c) require a migration for no offsetting benefit, since the durable record
   that actually matters (who *did* approve) is already captured whenever a non-owner approves.
   **Named escalation** (not adopted now): if wellD's auditors later require regulator-grade
   durable retention of denied attempts, adopt an audit-row variant guarded by
   `INSERT … ON CONFLICT DO NOTHING` against a partial unique index on
   `(requestId, actorUserId) WHERE action='self_approval_denied'`, bounding the append.
6. **Wire shape of the denial.** RFC 7807 Problem JSON, `status: 403`, plus a stable extension
   member `code: "self_approval_forbidden"` — the i18n-safe discriminator (detail strings are
   localized), distinguishing this 403 from the pre-existing capability-absent 403 (which carries
   no `code`). refund-ui passively **disables** (never hides) the approve button on the caller's
   own restricted request, computed locally from the caller's `sub`, the request's `ownerUserId`,
   and the resolved `approve` grant — convenience only; the server 403 remains authoritative.

## Options considered

### Option A — Attribute `{key:"self-approval", match:"deny"}`, inline enforcement, 403 (chosen)

Described above.

**Pros:**
- One catalog constant edit is the entire auth-side change — the wire schemas, resolver parse,
  and admin off-catalog validator are already generic over `attributes[].key` and a free-form
  `match` string
- Keeps the ownership *scope* axis (`own`/`any`, used by `read`) conceptually separate from a
  *deny carve-out* axis (self-approval) rather than conflating a widening enum with a narrowing one
- The 403 is honest about what's actually happening: the record indisputably exists and belongs to
  the caller, so denying via "not found" would be a misleading signal for no security benefit

**Cons:**
- Introduces a second polarity (`match:"deny"` vs. `match:"user"`) into the attribute vocabulary
  that a future author could confuse with the affirmative scope-matching semantics — mitigated by a
  dedicated `approveSelfRestricted` predicate with an explicit doc comment, never sharing code with
  `entityScopeForPermission`
- The 403-not-404 choice is a documented, deliberate exception a future contributor must know to
  look up rather than infer from the rest of the codebase's uniform 404-for-mismatch pattern

### Option B — A new `ownership` enum value (`not-own`), reusing `read`'s existing `own`/`any` axis (rejected)

Extend `approve`'s `supportedConditions` to include `ownership`, and extend the `own|any` enum
with a third value.

**Pros:**
- Reuses the one piece of ownership vocabulary the model already has (`request:read`'s
  `ownership:own`)

**Cons:**
- `approve` does not support `ownership` today at all, so this still requires a catalog change,
  plus extending the `own|any` enum across three separate zod schemas (`roles.routes.ts`,
  `authz.routes.ts`, `resolve.routes.ts`), `toRuleConditions`, and admin-ui
- `not-own` is not a wider-or-narrower point on the resolver's `ownershipTier` scope axis (where
  `any ⊃ own`) — it's a deny carve-out on an orthogonal axis, and forcing it onto that lattice
  would produce an incoherent third radio option in admin-ui's existing any/own radiogroup
- Rejected: more surface than Option A, and semantically muddier

### Option C — A new top-level `RuleConditions` field (e.g. `selfApprovalRestricted: boolean`) (rejected)

Add a dedicated boolean field alongside `attributes[]` on the conditions object.

**Pros:**
- Semantically the cleanest possible representation — no polarity ambiguity, no attribute-array
  scanning

**Cons:**
- Touches the resolver type, `toRuleConditions`, `widthScore`, both auth route schemas,
  refund-api's `ResolveConditions`, admin-ui's `RuleConditions` type, and the composer — every
  layer Option A leaves untouched
- Rejected as most disruptive for a feature explicitly designed to be additive to one catalog value

### Option D — 404, matching the suite's uniform "not yours" convention (rejected)

Return 404 for a self-approval denial, exactly as `request:read`'s ownership mismatch and
ADR-0015's entity mismatch do.

**Pros:**
- Keeps every ownership/scope-mismatch denial in refund-api returning the identical status code —
  one rule, no special case to document

**Cons:**
- 404's entire justification is preventing an existence leak to a caller with no relationship to
  the record — inapplicable here, since the caller demonstrably owns and can otherwise act on the
  record; a 404 would misleadingly claim "not found" for something the caller just submitted
- AC-6.1 requires the denial be distinguishable from "nothing happened," which a bare 404
  (indistinguishable from any other not-found) does not satisfy
- Rejected: mechanically consistent but actively wrong for this specific denial's semantics

### Option E — Extend `RefundAuditEntry`/`AuditAction` with a `self_approval_denied` value (rejected)

Record every denied attempt as a new immutable audit row (extending ADR-0018/ADR-0022's pattern).

**Pros:**
- Durable, queryable, DB-level-immutable record consistent with the suite's existing financial
  audit posture

**Cons:**
- Every existing `AuditAction` pairs with a real state-transition mutation in the same
  transaction; a denied attempt changes nothing, so adding it pollutes a trail whose entries today
  are uniformly "this happened"
- An owner can retry a denied approve arbitrarily while the request stays `submitted`, so this
  opens an effectively unbounded-append vector on a table whose whole design point (ADR-0018) is
  bounded, meaningful, immutable rows
- Requires a migration for a feature otherwise entirely additive at the schema level
- Rejected for now; named explicitly as the escalation path if durable regulator-grade retention of
  denied attempts is later required, via a partial-unique-index dedup guard

## Consequences

**Positive:**
- Zero schema/migration/resolver change on the `auth` side — the entire declaration surface is one
  catalog constant, and every downstream consumer (wire schemas, admin validator) already handles
  arbitrary `attributes[]` entries
- The restriction composes cleanly with the pre-existing `entity` condition (ADR-0015) via the same
  side-by-side, independently-evaluated pattern, with no interaction bugs between the two
- The 403 signal is honest and auditor-legible: "you may act on this record in general, but not
  this specific way, because you own it" — a materially different, more useful message than a
  blanket 404
- refund-api's fail-closed posture (ADR-0014) is unaffected: the new branch introduces no allow-path
  on any error, and an `auth` outage still yields 503 upstream of this check

**Negative / trade-offs:**
- A second, opposite-polarity attribute sentinel (`match:"deny"`) now exists alongside `match:"user"`
  in the same free-form array, a subtlety a future author must know to respect — mitigated by an
  explicit doc comment and a dedicated evaluator function, not by the type system
- The 403-not-404 choice is a genuine, permanent exception to an otherwise-uniform convention
  (ADR-0005/ADR-0014/ADR-0015) that every future reader of refund-api's authorization surface must
  be told about explicitly (this ADR is that record)
- Structured logging, not an audit row, means denied self-approval attempts do not automatically
  inherit the DB-level immutability/retention guarantees ADR-0018/ADR-0022 give to actual state
  transitions — acceptable per the reasoning above, but a real capability gap if regulator-grade
  durable retention of *denials specifically* is ever mandated

**Risks:**
- **Widest-wins composition can silently drop the restriction.** A second role granting
  unconditioned `approve` unions to the wider grant and the restriction stops biting for that user —
  a security-relevant, decided property (not a bug), matching how entity scoping already composes
  (ADR-0015). Mitigated by seeded/realistic configs granting `approve` from a single `accounting`
  role only, plus a dedicated resolver composition unit test asserting the documented behavior.
  Escalation path (not adopted now): give the resolver's `widthScore` a dedicated sub-term for the
  self-approval flag so it never ties against a scope attribute, if wellD ever grants `approve` from
  multiple roles to the same user.
- **`authzMiddleware`'s 30s resolve cache** (ADR-0014) means a just-toggled restriction may be stale
  for up to the cache TTL — the same, already-accepted posture that applies to entity-condition
  changes today; no new mitigation.
- **UI/enforcement divergence.** refund-ui's button-disable is a local, best-effort computation; the
  server 403 is the sole authoritative control and is tested independently of any UI state.

## Compliance notes

- GDPR/nLPD impact: low — the condition and its evaluation concern authorization logic over an
  employee's own identifier (`sub`/`ownerUserId`), not new personal-data collection or automated
  decision-making about a data subject beyond the access-control decision itself.
- Data residency: not applicable — no new storage location; the condition rides the existing
  `permission_rule.conditions` JSON column (`auth`, already EU-resident) and the log event is
  emitted by refund-api (already EU-deployed, ADR-0014).
- Audit trail: the *approval itself*, when it succeeds, remains fully covered by ADR-0018/ADR-0022's
  immutable `RefundAuditEntry`. A *denied* self-approval attempt is deliberately NOT added to that
  table (Decision 5) — it is recorded only as a structured log event (`refund.self_approval_denied`:
  `actorUserId`, `requestId`, ISO-8601 `timestamp`, no PII/financial amounts), sufficient to
  reconstruct who attempted what and when, but without the DB-level immutability guarantee the audit
  table provides. If wellD's audit requirements later demand that guarantee for denials specifically,
  see the named escalation under Decision 5 / Option E.

This decision builds on ADR-0005 (JWKS resource-server verification, owner = JWT `sub`), ADR-0007
(hand-rolled RBAC/ABAC, free-form attribute conditions, widest-wins union — reused verbatim, not
extended), ADR-0014 (refund-api as an authorization-enforcing resource server, fail-closed), and
ADR-0015 (entity-scoped ABAC, the composition partner this condition sits alongside). It records a
deliberate, permanent exception to ADR-0005/ADR-0014's "not yours = 404" convention and to
ADR-0018/ADR-0022's audit-trail scope.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
