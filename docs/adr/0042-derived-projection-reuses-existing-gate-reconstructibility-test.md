# 0042 — A derived projection over data an existing grant already authorises reuses that gate: the reconstructibility test, and a self-scoped read that ignores the grant's conditions entirely

**Date:** 2026-08-11
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/014-motivo-autocomplete` adds one new authenticated route to `refund-api`,
`GET /line-suggestions` (ADR-0041), returning a grouped, ranked projection of the caller's own
`travel_km` expense lines. Every new route on an authorization-enforcing resource server
(ADR-0014) forces the same question: which capability gates it?

The suite's ADR record contains two prior answers that look, at a glance, contradictory.
ADR-0028 **minted** a new `settings` catalog resource for the accounting distribution email,
explicitly refusing to reuse `rate:manage`, because "a distribution mailbox is not a rate" — a
different subject with a different audience, which had to stay separately grantable, separately
revocable, and separately auditable. ADR-0031 **reused** the existing `admin` role /
`requireAdmin` gate for the employee-address admin surface with no new catalog permission at all,
because it was the same authority over the same subject and `auth` is itself the authority, so a
catalog entry would have been pure indirection. Neither of those two tests decides the present
case: this is neither a different subject (it is literally the caller's own expense lines, which
`request:read` already governs) nor a question about where the authority lives (the check runs in
`refund-api`, over `auth`-resolved permissions, exactly as ADR-0014 prescribes).

What is genuinely new here is the **shape of the data**: a *derived projection* — a re-grouping
and re-ranking of rows an existing grant already authorises the caller to read in full. A holder
of `request:read` can already enumerate `GET /requests` and fetch each `GET /requests/{id}`, which
return every line's `motivo`, `km`, `entity` and `date`, and reconstruct this exact corpus by
hand. That fact, not the subject or the authority locus, is what decides the case.

A second question rides along with it. `request:read` is declared with
`supportedConditions: ["ownership"]` (`auth/src/authz/catalogs/refund.ts`), and ADR-0007's
resolver composes grants with a **widest-wins union** — an unconditioned grant unions away a
conditioned one (ADR-0015 point 4 uses exactly this mechanism to compose "global" review scope
without seeding a global role). AC-4.2 requires that a user who additionally holds accounting
review capability over other employees' requests still sees **only their own** past lines. So the
route's scoping cannot be derived from the resolved grant's conditions: the same widest-wins union
that is a *feature* for review scope is a *hazard* for a personal-data read.

## Decision

We will gate `GET /line-suggestions` on the **existing `request:read` capability**, introducing no
new catalog resource, no new action, no seed change and no `auth` change of any kind; and the
handler will **ignore the grant's conditions entirely**, scoping unconditionally to the verified
JWT `sub`.

1. **The reconstructibility test — the reusable rule this ADR adds.** When a new route exposes a
   *derived projection* of data an existing grant already authorises the caller to read, ask:
   **could a holder of the existing grant reconstruct this output by hand, using endpoints they
   are already authorised to call?** If yes, reuse the existing gate. A separate permission would
   be independently revocable while remaining trivially reconstructible, and a permission that
   cannot actually withhold anything is **worse than no permission**, because it advertises a
   control that does not exist — to the admin composing roles, to the auditor reading the grant
   log, and to the next engineer reasoning about the security model.
2. **How this composes with ADR-0028 and ADR-0031 into one decision procedure.** For any new
   surface needing a gate, in order:
   (a) **Different subject / different audience, needing to be separately grantable, revocable and
   auditable?** → mint a new catalog resource (ADR-0028's `settings` vs `rate`).
   (b) **Same authority over the same subject, and is the gate already expressible where the check
   actually runs?** → reuse it, and do not add indirection (ADR-0031's `requireAdmin` inside
   `auth`).
   (c) **A derived projection of data an existing grant already fully authorises?** → reuse that
   grant, always — the reconstructibility test makes a new permission unenforceable by
   construction (this ADR).
   The three are not in tension: (a) turns on *subject*, (b) on *authority locus*, (c) on *data
   derivation*. A future case is decided by whichever question it actually poses.
3. **`request:read`, not `refund:access`.** The app-access grant (`refund:access` — the "you can
   see the Refund tool" capability, and the reason `GET /rates/effective` is deliberately ungated
   beyond authentication, ADR-0023/ADR-0028) is too weak for this route: it authorises using the
   tool, not reading line-level personal content. `request:read` is the established gate for
   exactly that content, so it is the gate whose reconstructibility argument applies.
4. **Capability absent → 403, and there is no 404 branch at all.** The handler checks
   `hasCapability(permissions, "request", "read")` and returns **403** when it is missing —
   wholesale capability denial with no record to hide, matching `GET /requests` verbatim and
   ADR-0014 point 3's split. ADR-0005's "not yours = 404" and ADR-0037's relationship-based
   403-vs-404 taxonomy **do not engage here at all**: the route addresses no record, accepts no
   identifier, and therefore has no existence to leak or protect. That absence is itself the
   design (ADR-0041), and it is recorded so a future contributor does not add a 404 branch by
   analogy with routes that have one.
5. **Conditions are ignored; scope comes from the JWT `sub`, unconditionally.** The handler never
   consults the resolved grant's `ownership` condition, never consults ADR-0015's entity
   predicate, and never derives its `WHERE` clause from anything the resolver returned. The owner
   filter is `request.ownerUserId = sub` from the already-verified token and nothing else. This is
   what makes AC-4.2 **structural** rather than incidental: even a caller holding an unconditioned
   `request:review`, or a hypothetically unconditioned `request:read` promoted by ADR-0007's
   widest-wins union, gets exactly their own lines — because widening is not expressible anywhere
   in this route's query. ADR-0015's entity condition is a *review* concept over other people's
   requests; this is a self-scoped read of one's own history, and applying an entity predicate to
   it would either be a no-op or perversely hide the caller's own cross-entity trips.
6. **The capability is an admission gate, not a scoping input — and that separation is the
   generalisable part.** For any self-scoped derived read, the resolved permission set answers
   only "may this caller use this route at all"; the *scope* is fixed by the token's subject at
   the repository layer. Conditions are for routes that operate over a population (ADR-0015's
   review queue); they must not be wired into a route whose population is, by construction, one
   person.
7. **Where the premise stops holding.** The reconstructibility argument depends on the corpus
   being drawn exclusively from rows `request:read` already exposes to this caller. Widening the
   feature to a team's, department's or company's shared trip history — explicitly a Non-goal
   today — would grant reach **beyond** what `request:read` gives, break the reconstructibility
   test outright, and require its own capability decision under step (a). Widening to further
   expense types (a stated, deliberate possibility) does **not** break it, because those lines are
   governed by the same grant. This distinction is the whole point of stating the test rather than
   only its outcome.

## Options considered

### Option A — Reuse the existing `request:read`; ignore conditions; scope unconditionally to `sub` (chosen)

Described above. Zero change in `auth`: no catalog entry, no seed function, no migration, no
resolver path.

**Pros:**
- The gate is honest: it withholds exactly what it appears to withhold, because a caller denied
  `request:read` genuinely cannot obtain this data by any other route either
- AC-4.2 holds structurally — no combination of grants, present or future, can widen a route whose
  query has no widening term in it, which is a far stronger guarantee than "the condition
  evaluates correctly today"
- Zero authorization-side blast radius (no catalog, seed, resolver or migration change), matching
  ADR-0031's outcome in cost and ADR-0028's in shape-of-reasoning without contradicting either
- Gives the suite a third, genuinely distinct data point on the new-permission-vs-reuse axis, and
  turns three precedents into one ordered decision procedure a future author can actually apply
  instead of pattern-matching against whichever prior ADR they happen to read first

**Cons:**
- Suggestions can never be revoked independently of reading one's own requests. If a future
  product decision wants "this user gets no autocomplete", there is no capability to remove — it
  would have to be a setting or a feature flag, not a permission. Accepted: that is a *product*
  toggle, not an access-control boundary, and conflating the two is precisely what this decision
  refuses
- "Ignore the resolved conditions" is an unusual instruction on an authorization-enforcing
  resource server whose other routes are built to evaluate them (ADR-0014 point 3, ADR-0015); it
  reads like an omission unless a reader knows this ADR
- One more route whose correctness rests on a repository-layer invariant (`ownerUserId` comes only
  from the verified `sub`) rather than on the middleware chain that gates everything else

### Option B — Mint a new `suggestion:read` catalog resource, mirroring ADR-0028's `settings` (rejected)

Declare `{ resource: "suggestion", actions: ["read"], supportedConditions: [] }` on the `refund`
catalog, seed it, and gate the route on it.

**Pros:**
- Superficially consistent with the suite's most recent "should this be a new capability" decision
  (ADR-0028), and makes the new surface visibly separable in the admin role composer
- Would allow disabling the feature per-role without touching `request:read`

**Cons:**
- The control would be **fictional**: any holder of `request:read` denied `suggestion:read` can
  reconstruct the identical corpus from `GET /requests` + `GET /requests/{id}` in a few seconds.
  The grant log would then record a revocation that revoked nothing, and an auditor or admin would
  reasonably believe a boundary exists where none does — strictly worse than not having the
  permission at all
- ADR-0028's reasoning does not transfer: the accounting distribution email is a genuinely
  different subject with a genuinely different audience, and a non-holder there must not even
  learn the mailbox exists (AC-3.2). Here the non-holder already holds every underlying fact
- Adds a catalog resource, a seed function, and a permanent maintenance obligation to `auth` to
  buy a boundary that cannot be enforced
- **Rejected:** cheap to add, permanently misleading

### Option C — Gate on `refund:access` (the app-access grant) instead (rejected)

Treat the route the way `GET /rates/effective` is treated — available to any authenticated caller
who can use the Refund tool at all.

**Pros:**
- Simplest possible gate; no capability check to write beyond the existing middleware chain
- Consistent with the one existing precedent for an employee-facing derived read in this service

**Cons:**
- `GET /rates/effective` is ungated because the value it returns (`km × rate`) is policy
  configuration the employee already sees on their own claim (ADR-0023/ADR-0028 point 4). This
  route returns **line-level personal content** — motivo free text naming clients and
  destinations, with distances and dates — for which `request:read` is the established gate
- Would make the feature reachable by a caller deliberately denied the ability to read their own
  requests, an incoherent access state
- **Rejected:** the analogy to `rates/effective` fails on sensitivity, which is the exact axis it
  would need to hold on

### Option D — Derive the route's scope from the resolved grant's conditions (rejected)

Honour `ownership:own` when present (scope to `sub`) and, when the grant is unconditioned, do not
scope — the mechanically "consistent" reading of ADR-0014 point 3's capability-then-condition
split.

**Pros:**
- Uniform with every other `refund-api` route, which does evaluate conditions locally against the
  record
- No special-case instruction for a future contributor to know about

**Cons:**
- Directly violates AC-4.2. ADR-0007's widest-wins union means a user who holds both the
  entity-conditioned `accounting` role and any unconditioned grant resolves to unconditioned —
  exactly the composition ADR-0015 point 4 relies on for global review scope — and this route
  would then serve them other employees' motivo text through an autocomplete. The suite's own
  mechanism for legitimately widening review reach becomes a personal-data leak the moment it is
  wired into a self-scoped read
- Makes a security-critical property depend on a condition evaluating correctly at runtime, rather
  than on there being no widening term in the query at all
- **Rejected:** consistency with the general pattern is not worth a criterion this feature exists
  to guarantee

### Option E — Add an `entity` condition to the gate, mirroring ADR-0015 (rejected)

Scope suggestions by the caller's `user.entity` the way review surfaces are scoped.

**Pros:**
- Consistent with the only conditioned scoping mechanism the refund catalog actually has

**Cons:**
- Entity scoping exists to filter *other people's* requests into a reviewer's queue; a self-scoped
  read has no population to filter
- It would be either a no-op or actively wrong: an employee who legitimately filed trips under
  both `welld_it` and `welld_ch` would be hidden from half their own history
- **Rejected:** category error — this reaffirms ADR-0023's and ADR-0028's own contrasts with
  ADR-0015, for a third and different reason

## Consequences

**Positive:**
- The authorization model gains no fictional control: every capability in the refund catalog
  continues to correspond to something a denial actually prevents
- AC-4.1/AC-4.2/AC-4.3 hold structurally rather than behaviourally — there is no parameter to
  widen scope with, no condition whose evaluation could be wrong, and no grant composition that
  could promote the caller beyond themselves
- `auth` is untouched by this feature entirely: no catalog constant, no seed function, no
  migration, no resolver path — the cheapest possible authorization-side footprint, and one fewer
  permanently-maintained catalog entry
- The suite's new-permission-vs-reuse question now has an ordered, three-branch procedure with a
  worked example for each branch, instead of two precedents with opposite-looking outcomes that a
  future author must reconcile unaided

**Negative / trade-offs:**
- Suggestions are permanently coupled to `request:read` for revocation purposes; there is no way
  to grant one without the other, and any future need to separate them would require re-running
  the reconstructibility test against whatever the feature has become by then (see point 7)
- "Ignore the resolved conditions" is a deliberate local deviation from the pattern every other
  route in `refund-api` follows, and it is invisible in the code without a comment pointing here —
  a contributor tidying the route "into consistency" with its neighbours would silently reopen
  AC-4.2
- The reconstructibility test is a judgement call, not a mechanical check: "could a holder
  reconstruct this by hand" has to be answered honestly, including for projections that aggregate,
  correlate or summarise in ways the underlying endpoints do not (where the honest answer may be
  no, and a new permission is then genuinely warranted)

**Risks:**
- **The test is applied to a projection that is not actually reconstructible.** An aggregate that
  spans users, or one that reveals a statistical fact no individual read discloses, fails the test
  even though each underlying row is individually readable. Mitigation: the test is stated with
  its premise attached (point 7) — the corpus must be drawn exclusively from rows the existing
  grant already exposes *to this caller*; a cross-user aggregation is a different question with a
  different answer.
- **A future contributor wires the resolved conditions into the query.** This is the single
  highest-consequence mistake available on this route and it fails silently for anyone without a
  review grant. Mitigation: the AC-4.2 integration test seeds a caller holding **unconditioned**
  `request:review` and asserts the response is still exactly their own lines; AC-4.3's fixture
  matrix (employee / entity-scoped accounting / global accounting / `request:read` only / no
  refund grants) covers the rest.
- **A future widening to shared/team history keeps the gate by inertia.** The moment suggestions
  are drawn from anyone but the caller, `request:read` stops authorising what the route returns.
  Mitigation: point 7 names this explicitly as the premise's failure condition, and such a change
  must go back to step (a) of the decision procedure.
- **ADR-0028 is read as "new surfaces get new permissions".** Mitigation: the ordered procedure in
  point 2 makes the three branches' triggering questions explicit, so ADR-0028 is applied to
  different-subject cases only.

## Compliance notes

- GDPR / nLPD impact: low for this decision in isolation — it governs *who may invoke* a route
  whose data-protection profile is assessed in ADR-0041 (medium). The relevant point here is that
  the gate reuse does not widen the population able to read any employee's motivo history by a
  single person: exactly the holders of `request:read` who could already read it, and only ever
  their own.
- Data residency: not applicable — no new storage, no new data flow; the capability check rides
  `refund-api`'s existing `authzMiddleware` against `auth GET /authz/resolve` (ADR-0014), both
  EU-region, and continues to fail **closed** (503) on an `auth` outage.
- Audit trail: not required and not added. A capability check on a read is ordinary request
  handling, not a governance event — consistent with ADR-0037's treatment of denials and
  deliberately unlike ADR-0026, which logs its self-approval denials because those record an
  attempted breach of a segregation-of-duties rule rather than a routine authorization outcome.

This decision is the third data point on the suite's new-permission-vs-reuse axis, after
**ADR-0028** (mint a new resource: different subject, different audience, must be separately
grantable and auditable) and **ADR-0031** (reuse the existing gate: same authority, same subject,
and `auth` is itself the authority) — and it adds the branch neither covers, the derived
projection, decided by the reconstructibility test. It operates entirely inside **ADR-0014**'s
authorization-enforcing resource-server model (capability-absent → 403, fail-closed on an `auth`
outage, no new trust relationship and no new secret), deliberately declines **ADR-0015**'s
entity-scoped ABAC as a category mismatch for a self-scoped read, and neutralises **ADR-0007**'s
widest-wins union for this route by making scope structural rather than resolved. It gates the
endpoint introduced by **ADR-0041**, and the two should be read together.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
