# 0036 — Record-level sharing as a new access primitive: the ACL lives in the resource server that owns the record, not in `auth`

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

Every authorization decision in the suite so far has been **role/department/attribute
based**, resolved centrally in `auth`: ADR-0007 built the hand-rolled RBAC/ABAC resolver and
the identity+epoch JWT claim model; ADR-0014 gave `refund-api` a way to enforce that model
server-side via `GET /authz/resolve`; ADR-0015 added entity-scoped ABAC on top. In every one
of those decisions, "who may do X" is a question about the **caller's role/attributes**,
answerable without reference to any specific record — `auth` can resolve it in isolation.

Spec `specs/013-estimate-sharing` introduces a fundamentally different kind of access
question: "may this specific caller open **estimate #4711**?" That is not resolvable from
role or attribute data at all — it depends on whether estimate #4711's *owner* has
specifically granted this caller a relationship to *that one record*. No catalog action, no
condition type, no role composition in `auth`'s model can express "Marco may open this
specific estimate, but not that one, because Anna granted it to him yesterday." The relevant
fact — the grant itself — exists only inside `estimai-api`'s own database, next to the
estimate it grants access to.

The plan is explicit that `estimai-api` deliberately does **not** become a fourth
authorization-enforcing resource server on the ADR-0014 model: EstimAI's already-declared,
never-enforced `estimate:view/create/edit/delete` catalog actions
(`auth/src/authz/catalogs/estimai.ts`, specs/004 AC-3.4) stay declaration-only. Turning those
on would be a much larger, unrelated feature. This feature's rules simply do not belong in
that model at all.

## Decision

We will introduce a new access primitive — the **record-level access-control list** — owned
entirely by the resource server that owns the record, and we will keep it structurally and
conceptually separate from `auth`'s role/attribute authorization model rather than folding it
into the catalog or the resolver.

1. **New table, new owner.** `estimai-api/prisma/schema.prisma` gains `EstimateCollaborator`
   (`estimateId`, `userId`, `email`, `accessLevel: viewer|editor`, `grantedByUserId`,
   timestamps; `@@unique([estimateId, userId])` is the authoritative "one grant per person"
   invariant). This table lives in `estimai-api`'s own database. `auth` has no table, no
   catalog entry, no resolver logic, and no knowledge whatsoever of who is a collaborator on
   which estimate.
2. **Every owner-scoped query widens uniformly.** `access.ts`'s `resolveAccess(estimateId,
   callerId)` returns `owner | editor | viewer | null` from a single query: fetch the
   estimate including only the caller's own collaborator row; `row.userId === callerId →
   owner`; else the collaborator row's level; else `null`. Every touched call site in
   `estimates.repo.ts` (list/get/update/delete) applies the identical `owner OR grant`
   predicate — there is exactly one place the rule is expressed, never duplicated per route.
3. **`estimai-api` acquires no new runtime dependency on `auth` for its read/write path.** A
   collaborator can open and save a shared estimate while `auth` is entirely down — their JWT
   still verifies against cached JWKS (ADR-0005), and access resolution is a local query
   against `estimai-api`'s own table. Only two narrow paths call `auth` at all: adding a
   collaborator (ADR-0035, fails **closed**, because it's an authorization decision about a
   third party) and display-identity resolution (ADR-0039, fails **soft**, because it's
   decorative). This is a materially better availability posture than `refund-api`'s
   (ADR-0014, which gates *every* route on `auth`), and it is recorded here precisely so a
   future contributor does not "fix" it into a blanket fail-closed dependency by analogy with
   `refund-api`.
4. **The general rule this establishes, for every future Operai app that adds sharing:**
   **role/attribute rules live in `auth` (ADR-0007's resolver, ADR-0014's enforcement
   pattern); per-record grants live in the app that owns the record.** The two must never be
   conflated — a per-record grant is not a role, must not be expressed as a catalog action or
   a condition, and must not be resolved by `auth`. Conversely, "does this user's account
   hold EstimAI app access at all" stays exactly where ADR-0007 US-7 put it (the shell
   boundary) and is not re-implemented or duplicated by this ACL.
5. **The one place the two systems touch is the eligibility check (ADR-0035), and only
   there.** `auth POST /authz/app-access-check` answers "is this person even eligible to be
   considered" (an app-access, role-shaped question `auth` is positioned to answer); the ACL
   itself — who has actually been granted what level on which record — is decided and stored
   entirely inside `estimai-api`. The boundary is exact: `auth` never sees or stores a single
   collaborator grant; `estimai-api` never re-implements role resolution.

## Options considered

### Option A — Record-level ACL owned by the resource server, structurally separate from `auth`'s role/attribute model (chosen)

Described above.

**Pros:**
- Keeps `auth`'s resolver conceptually pure: it answers "what can this role/attribute
  combination do," never "what has been granted about this one row" — a boundary that scales
  to every future Operai app without `auth`'s schema or resolver growing per-app,
  per-record tables
- `estimai-api`'s core read/write path gains zero new hard dependency on `auth`'s
  availability — a materially better availability posture for the common case (open/save an
  estimate) than `refund-api`'s ADR-0014 model, which is appropriate given per-record sharing
  is not itself a regulated financial authorization
- The invariant is trivially auditable: exactly one table, one unique constraint, one
  resolution function, one predicate reused at every call site — no risk of two routes
  independently reinventing the check and drifting
- Establishes a clean, reusable answer for the suite's next sharing feature (any future
  per-record grant in `refund-ui`, `notify-ui`, or a future tool) without inventing a new
  pattern each time

**Cons:**
- The suite now has **two** structurally distinct authorization concepts living in different
  services — a future engineer must understand both the `auth`-resolved role/attribute model
  and each app's own record-level ACL to reason about "can this user do X" end to end
- `estimai-api` now owns and must correctly enforce an authorization-shaped concern
  (grant CRUD, the CAS-embedded access predicate) without the shared fail-closed/epoch-cache
  machinery ADR-0014 built for exactly this class of problem — that machinery is not reused,
  by design, but it also isn't automatically inherited
- A future feature needing to combine "role-based access" and "record-level access" for the
  same resource (e.g. an admin who should see every estimate regardless of grants) has no
  existing composition primitive between the two systems and would need one designed fresh

### Option B — Model per-record sharing as a new `auth` catalog action with a record-scoped condition (rejected)

Extend `auth`'s catalog with an `estimate:collaborator` action and a new condition type that
references a specific record id, resolved the same way `entity`/`self-approval`
(ADR-0015/ADR-0026) are resolved today.

**Pros:**
- Reuses one authorization system for everything — no second concept for engineers to learn
- `auth`'s existing audit log (ADR-0007) would automatically cover grant changes

**Cons:**
- `auth`'s condition model (ADR-0007/ADR-0015/ADR-0026) is designed for a bounded, small set
  of attribute values known at role-definition time (an entity code, a department, a boolean
  self-flag) — a per-*record* condition means one row per (user, record) pair living inside
  `auth`'s `permission_rule` machinery, an unbounded, high-churn dataset the resolver was
  never built to hold or evaluate efficiently
- Would force `estimai-api` to become a fourth ADR-0014-style authorization-enforcing
  resource server just to resolve "does this grant exist" — reintroducing exactly the hard
  runtime dependency on `auth` this feature deliberately avoids (Decision point 3), for a
  concern (individual document sharing) with none of `refund-api`'s regulated-financial
  weight
- Rejected: conflates two different shapes of authorization data (small, role-defined
  attribute sets vs. large, per-record, user-initiated grants) inside one resolver never
  designed for the second shape

### Option C — Turn on EstimAI's already-declared `estimate:view/create/edit/delete` catalog actions and enforce them via `authzMiddleware` (rejected)

Activate the dormant specs/004 catalog entries and build the same `authzMiddleware` +
`/authz/resolve` pattern `refund-api` uses.

**Pros:**
- Reuses ADR-0014's proven, already-battle-tested machinery wholesale — no new pattern
- Would finally realize specs/004 AC-3.4's declaration, closing an existing gap

**Cons:**
- Solves the wrong problem: those catalog actions describe *whether a user can use EstimAI
  at all* (already correctly gated at the shell boundary, ADR-0007 US-7), not *whether this
  specific user may open this specific estimate* — turning them on would not express
  per-record grants at all without also building Option B's record-condition machinery on
  top
- A much larger, unrelated feature (suite-wide enforcement of app-level catalog actions) is
  not what this spec asks for, and bundling it here would materially expand scope and risk
  for no AC in specs/013
- Rejected: category error — conflates "can use the app" with "can access this one record"

## Consequences

**Positive:**
- The suite gains a clean, named, reusable pattern for record-level sharing: an app-owned
  ACL table, a single resolution function, one predicate embedded at every read/write call
  site — the template any future Operai tool needing "share this specific thing with a
  specific colleague" should copy rather than reinvent
- `estimai-api`'s availability for the common case (open, view, edit, save a shared
  estimate) is decoupled from `auth`'s — a collaborator keeps working through an `auth`
  outage, a materially better posture than a blanket-fail-closed alternative would have given
- `auth`'s resolver, catalog, and audit log stay exactly as scoped by ADR-0007 — no
  per-record data ever enters a system designed for role/attribute-shaped data

**Negative / trade-offs:**
- Two structurally different authorization concepts now coexist in the suite (`auth`-
  resolved role/attribute permissions vs. app-owned record-level ACLs); a future engineer
  reasoning about end-to-end access to any given resource must know which model — or both —
  applies
- No shared library or contract test enforces that a *future* app's record-level ACL follows
  this same shape (owner-scoped table, single resolution function, CAS-embedded predicate) —
  the pattern is established by precedent and this ADR, not by reusable code
- `estimai-api` gains its own bespoke, unshared authorization-adjacent surface (grant CRUD,
  access resolution) to maintain correctly forever, without inheriting ADR-0014's
  epoch-cache/fail-closed machinery — appropriate for this feature's lower stakes, but a
  choice each future adopter of this pattern must re-justify for their own domain, not
  assume by default

**Risks:**
- **A future app conflates the two models.** Someone builds a second per-record ACL and,
  under schedule pressure, tries to express it as an `auth` catalog condition instead
  (Option B's rejected shape) because the pattern isn't enforced by tooling. Mitigation: this
  ADR names the rule explicitly ("role/attribute rules live in `auth`; per-record grants live
  in the app that owns the record") as the standing guidance; a future architecture review
  should flag any catalog condition that references a specific record id as a violation.
- **Composition gap.** No mechanism today lets an `auth`-resolved role (e.g. a future
  "estimai-admin" role) override or compose with `estimai-api`'s per-record ACL — an admin
  wanting to see every estimate regardless of grants has no path. Named as a real limitation,
  not solved here; a future feature needing it would need to design the composition
  deliberately, likely as an explicit `estimai-api`-side check against a resolved permission
  the same way `refund-api` does it for entity scope (ADR-0015), layered *on top of*, not
  instead of, the ACL.
- **`estimai-api`'s bespoke authorization surface has no shared hardening.** Unlike
  `refund-api`'s ADR-0014 machinery (epoch-keyed cache, fail-closed on outage, a documented
  denial taxonomy), `estimai-api`'s ACL enforcement is new, standalone code with none of that
  proven infrastructure automatically inherited. Mitigation: the CAS-embedded predicate
  (ADR-0038) closes the TOCTOU window structurally, and the denial taxonomy (ADR-0037) is
  explicitly modelled on ADR-0014's split — but each piece was rebuilt, not reused, and a bug
  in this new code is not caught by any of `refund-api`'s existing test coverage.

## Compliance notes

- GDPR/nLPD impact: medium — this is the first mechanism in EstimAI by which one user's
  data becomes readable and writable by another. The grant record itself (`userId`,
  `email` snapshot, `accessLevel`, `grantedByUserId`) is new personal data, owned and
  retained entirely inside `estimai-api`'s EU-region database, with no new cross-border flow.
- Data residency: unaffected — `estimate_collaborator` is new data owned by `estimai-api`,
  which already deploys to an EU region (CLAUDE.md).
- Audit trail: **not** added by this decision. Grant removal (owner-initiated or
  estimate-deletion cascade) leaves no history — the spec's Non-goals explicitly exclude an
  audit/history log for who had access when (plan Risk R10). This is a deliberate,
  accepted gap for this feature, unlike `refund-api`'s financial audit trail (ADR-0018),
  because a collaborator grant is not a financial or governance record.

This decision establishes a new architectural boundary alongside ADR-0007 (role/attribute
authorization, resolved centrally in `auth`) and ADR-0014 (the pattern for a resource server
enforcing that central model server-side) — this ADR is the suite's first instance of the
**other** kind of access rule, deliberately kept out of both. It also depends on ADR-0035
(the one narrow seam where `estimai-api` does call `auth`, for eligibility only) and is
realized operationally by ADR-0037 (the denial taxonomy) and ADR-0038 (the CAS predicate that
embeds this ACL directly into the write path with no TOCTOU window).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
