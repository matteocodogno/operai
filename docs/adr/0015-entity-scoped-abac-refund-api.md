# 0015 — Entity-scoped ABAC application in refund-api: request-level "at least one line matches," widest-wins global, whole-request decisions

**Date:** 2026-07-16
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

Specs/004 defined the entity attribute ABAC condition (`{key:"entity", match:"user"}` — "the
record's entity must equal the acting user's `entity` attribute") and ADR-0007 fixed that
*evaluating* such a condition against a record is always the consuming app's job, never the
resolver's. `refund-api` (ADR-0014) is the first app to actually apply this condition, and its
domain immediately breaks the condition's implicit assumption of one entity per record: spec
`specs/007-refund-service` explicitly allows a single refund request to contain expense lines
for **both** WellD Italia and WellD CH — there is no single `request.entity` to compare against
a caller's `user.entity` at all. AC-5.1/5.6 (queue scoping), AC-6.4/6.5 (record-level detail
scoping), and AC-7.6 (decisions apply to the whole request, including out-of-scope lines) all
have to resolve to one coherent rule for what "in scope" means for a request that may straddle
both entities, and the spec also requires a "global" (both-entity) accounting scope to exist
without inventing a bespoke flag or role for it.

## Decision

We will evaluate the entity condition at **request level**, using "at least one line's entity
equals the caller's `user.entity`" as the single membership predicate for both queue visibility
and record-level access, realize "global" scope entirely through the resolver's pre-existing
widest-wins union rather than a new condition type or role, and keep every decision
whole-request regardless of scope.

1. **Queue query.** A single-entity-scoped caller (holds `request:review` with the entity
   condition attached) sees `status=submitted AND lines.some(entity = caller.entity)`. A
   caller whose resolved `review` grant carries **no** entity condition sees `status=submitted`
   unconditionally — every submitted request (AC-5.5). Which case applies is determined entirely
   by what the resolver (ADR-0014's `/authz/resolve`) returns for that permission; `refund-api`
   invents no query-time flag of its own.
2. **Record-level check**, on `GET /requests/:id` and every `/review/*` subroute: the identical
   "at least one line matches" predicate. A caller whose scope matches none of a request's lines
   gets **404**, mirroring ADR-0005/0014's not-yours-not-found denial (AC-6.4) — no existence
   leak, and the same signal an unrelated non-accounting user already gets.
3. **Once in scope, never filtered by entity.** A caller whose scope matches at least one line
   sees, and can act on, **all** of that request's lines — including lines for the other entity
   (AC-6.5). Approve, reject, and set-approved-total are **whole-request** operations by domain
   design (Domain language: "a decision always covers the WHOLE request"): `refund-api` never
   splits a decision by entity, never partially approves only the in-scope lines (AC-7.6).
4. **"Global" is composed, not seeded.** The resolver's existing widest-wins union (`dedupeWithest`:
   an unconditioned grant ∪ a conditioned one resolves to unconditioned, ADR-0007) is the entire
   mechanism for global review scope. The plan ships only the entity-conditioned `accounting`
   role; **no `accounting-global` role is seeded.** An admin composes a global-scoped user by
   additionally granting an unconditioned `request:review` (etc.) through the existing specs/004
   GUI to a user who already holds the entity-conditioned `accounting` role — the union promotes
   them to global. No new condition type, resolver code path, or role concept is introduced.

## Options considered

### Option A — request-level "at least one line matches" + widest-wins global composition, whole-request decisions (chosen)

Described above.

**Pros:**
- Reuses specs/004's entity condition and ADR-0007's widest-wins resolver completely
  unmodified — zero new condition types, zero resolver code paths, zero new roles; "global"
  falls out of a mechanism that already existed for an unrelated reason (de-duplicating grants
  across roles and departments)
- Decisions stay single, atomic, and per-request exactly as the domain model requires (US-7) —
  no partial-decision reconciliation logic is ever needed
- The 404-on-out-of-scope pattern is identical for ownership (employee) and entity scope
  (accounting), keeping `refund-api`'s authorization surface uniform for both audiences

**Cons:**
- "At least one line matches" is intentionally permissive at the visibility boundary: a
  single-entity accounting user can see and decide 100% of a mixed-entity request's lines,
  including lines entirely outside their nominal scope — correct per AC-6.5/7.6, but a real
  widening worth naming plainly (see Consequences)
- "Global" has no explicit flag or role an admin can point to — understanding a user's
  effective scope requires understanding the widest-wins union, a conceptual burden (plan Risk
  R2)

### Option B — Per-line filtering: evaluate the condition per line, show/decide only matching lines (rejected)

Treat a mixed-entity request as effectively split by scope — an accounting user would only ever
see and decide the subset of lines matching their own entity.

**Pros:**
- Keeps the entity condition's per-record semantics closer to specs/004's original, single-
  entity-per-record framing

**Cons:**
- Directly contradicts AC-6.5/7.6, which require a single decision to cover the whole request,
  including lines outside the deciding user's scope
- Breaks the domain model's own definition of "decision" (Domain language: request-level,
  never partial by entity or by line) — would require reconciling two different accounting
  users' partial decisions on the same request, with no product requirement and no mechanism
  for that
- Rejected: violates locked acceptance criteria, not merely a worse design

### Option C — A multi-value `entity IN (...)` condition per grant, instead of "matches caller's single entity" (rejected)

Attach a condition listing which specific entities a grant covers, rather than comparing against
the caller's own single `user.entity` attribute value.

**Pros:**
- Would allow more granular per-user entity sets than "one entity" or "everything"

**Cons:**
- specs/004's entity condition is deliberately `match:"user"` — it compares against the
  caller's own attribute, and `user.entity` is singular (a user belongs to exactly one entity in
  the current model), so "does any line equal my one entity" already covers the single-entity
  case completely
- A caller wanting both entities already has the widest-wins global composition (Option A)
  available — a new multi-value condition type would duplicate that capability via a second
  mechanism with no additional expressiveness the suite currently needs
- Rejected: no product requirement motivates the added condition-type complexity

### Option D — A persisted `request.entity` or "primary entity," derived at submit time (rejected)

Compute and store a single representative entity per request (e.g. the first line's entity, or
whichever entity has the largest requested amount) so the existing single-entity condition shape
applies directly.

**Pros:**
- Would let the entity condition apply to `RefundRequest` exactly as specs/004 originally
  modeled it, with no request-vs-line distinction to reason about

**Cons:**
- Directly contradicts the spec's Domain language and Non-goals: mixed-entity requests are a
  first-class allowed shape (AC-3.5/6.6), and no combined/blended entity or amount is ever
  computed or displayed
- Any tie-break rule for "primary" entity would be arbitrary and have no product basis,
  misrepresenting the actual claim
- Rejected: violates explicit spec Non-goals

### Option E — A distinct `accounting-global` role, seeded alongside `accounting` (rejected for v1)

Seed a second role with an unconditioned `review`/`approve`/`reject` grant set, so "global"
accounting users hold a visibly distinct role rather than a composed one.

**Pros:**
- Makes global scope an explicit, self-describing role name in the admin GUI, rather than
  something that must be inferred from the widest-wins union of two separate grants

**Cons:**
- Duplicates most of `accounting`'s permission set in a second role definition purely to drop
  the entity condition, adding seed-data and role-count growth for a distinction the resolver's
  existing mechanism already expresses
- Rejected for v1: the plan explicitly decided to compose global via an additional unconditioned
  grant on the existing role instead, accepting the documentation/UX cost (Risk R2) over the
  seed-data duplication cost; this remains revisitable if admin confusion proves real in practice

## Consequences

**Positive:**
- Zero new authorization primitives: this decision is entirely an *application* of ADR-0007's
  existing condition model and widest-wins resolver to a new domain shape, not an extension of
  the model itself
- Decisions remain single, atomic, and per-request, matching US-7 exactly — no partial-decision
  state machine is ever needed
- The out-of-scope denial (404) is uniform across ownership and entity checks, keeping
  `refund-api`'s authorization surface easy to reason about end to end

**Negative / trade-offs:**
- Entity scoping bounds **which requests** are visible/decidable, not **which lines within a
  visible request** — a single-entity accounting user genuinely sees and can approve/reject
  amounts belonging to the other entity, whenever at least one line puts the request in their
  scope; this is a deliberate, spec-mandated widening that must be understood by anyone reasoning
  about the authorization boundary
- Because "global" has no explicit flag, an admin auditing a user's grants must understand the
  widest-wins union to correctly predict single-entity vs. global scope — accepted per Option A's
  Cons, mitigated only by documentation and tests, not by a UI affordance
- The queue's `lines.some(entity=...)` predicate and the record-level detail/decide gate must
  stay in lockstep; a future change to one without the other would silently desync what appears
  in the queue from what can actually be opened/decided

**Risks:**
- **Divergent implementations of the same predicate across the queue query and the record-level
  gate.** If the queue's SQL-level `EXISTS`/join and the detail endpoint's application-level
  check are written as two independent code paths, they could drift out of sync (e.g. one uses
  `<=` semantics the other doesn't replicate). Mitigation: a single shared predicate/query
  fragment backing both surfaces, exercised directly by the AC-5.6/6.4 adversarial tests named in
  the plan.
- **The mixed-entity boundary is the highest-value adversarial test in this plan's security
  surface** (named explicitly in the plan's Security section) — a subtle off-by-scope bug here is
  a direct authorization bypass on financial data. Mitigation: dedicated integration tests for
  single-entity exclusion, single-entity inclusion via exactly one matching line, and the global
  case, all required before this ships.
- **Admin confusion about what "global" means without an explicit toggle** (plan Risk R2). A
  future admin could misconfigure scope (e.g. assume adding an unconditioned grant to one user
  affects others, or fail to realize a second grant is required for global) without a dedicated
  UI signal. Mitigation: the specs/004 admin-facing catalog copy documents this precisely; not
  mitigated by a code-level safeguard.

## Compliance notes

- GDPR/nLPD impact: low — `entity` (WellD Italia vs. WellD CH) is an organizational attribute,
  not special-category personal data; its use here is access-control logic, not profiling or
  automated decision-making about the data subject.
- Data residency: not directly applicable to this decision (covered by ADR-0016 for the
  underlying attachment data, and by `refund-api`'s existing EU deployment for everything else).
- Audit trail: not directly required for the ABAC evaluation itself (a read-time authorization
  check, not a mutation); the decisions this scoping gates are covered by ADR-0018's audit trail.

This decision builds directly on ADR-0007 (the entity attribute condition and the widest-wins
resolver mechanism, both reused verbatim rather than extended) and ADR-0014 (the resource-server
enforcement mechanism — `authzMiddleware`, capability-vs-condition split, ownership-style
404 — that this ADR's request-level evaluation runs inside).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
