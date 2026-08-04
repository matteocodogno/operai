# 0031 — Employee address is an `auth`-owned identity attribute, stored in a 1:1 `employee_address` table: a departure from ADR-0023

**Date:** 2026-08-04
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/012-employee-address` needs somewhere to persist an employee's home address —
required for the admin-managed capture flow (US-1) and the employee's own read-only
transparency view (US-6) — and the approval-gate discussion settled, verbatim, that it
"lives in the existing `auth` service's User profile … alongside the entity/department/
job-title attributes `auth` already records," explicitly **not** `refund-api`-owned
data. That is a live tension with the suite's only prior precedent for "where does a new
piece of domain data live": ADR-0023, one spec earlier, which deliberately kept
mileage-rate data **out** of `auth` and inside `refund-api`, reasoning that resolving and
computing a policy value on every keystroke-driven read is a hot-path dependency that
belongs with the domain service that already owns the money logic. A home address has no
such hot-path computation, no domain-transaction shape, and no other service with a
stronger claim to own it — but ADR-0023 is the only recorded boundary test this suite has,
and a future contributor who reads it without a documented counterexample could
reasonably conclude "domain data never lives in `auth`," which is not actually the rule.
A second question the plan had to settle explicitly: `auth`'s admin API is gated by
`requireAdmin` (`auth/src/auth/auth.middleware.ts`), a **direct `user_role` membership
check** against `ADMIN_ROLE_NAME` — not a `catalog_resource`/`catalog_action` permission
resolved via `auth`'s own catalog (`auth/src/authz/catalogs/estimai.ts`, `refund.ts`,
ADR-0007). The spec's Constraint that "no new catalog permission is introduced" (AC-4.1)
had to be satisfied by an actual mechanism, not merely asserted.

## Decision

We will add a new, `auth`-owned, 1:1 `EmployeeAddress` table (`employee_address`),
keyed on `userId`, with the four AC-1.4-required components (`countryCode`, `city`,
`street`, `houseNumber`) declared `NOT NULL`, the two optional components (`postalCode`,
`region`) nullable, and a derived `formatted` string computed on every read — never
stored. Admin read/write access reuses the **existing** `admin` role / `requireAdmin`
gate verbatim; no new catalog permission is declared.

1. **The boundary test: "an attribute *of the person*, or data *about a domain
   transaction*?"** ADR-0023 kept mileage rates out of `auth` because a rate is a
   refund-domain policy value, computed against on a hot path, with no meaningful
   existence independent of the requests it prices. A home address is the opposite
   shape: it describes the employee themselves, is read rarely (an admin profile view, a
   self-view), and has no computation dependent on it. This is the reusable test for
   every future "where does this data live" question in the suite: if the answer to "is
   this a fact about the person" is yes, and the answer to "does resolving/computing it
   sit on another service's hot path" is no, it belongs in `auth` alongside the entity/
   department/job-title attributes `auth` already owns; otherwise it follows ADR-0023's
   precedent and lives with the domain service that needs it.
2. **A 1:1 table, not columns on `User`, not a JSONB document.** `EmployeeAddress` is its
   own table (`userId @id`, cascading on hard delete) rather than nine new columns on
   `user` or a JSONB blob. Three reasons carry the most weight: (a) `NOT NULL` on the
   four required columns is this suite's way of expressing an **all-or-none required
   component group** at the database level — the row's mere existence already means
   "complete," with no representable partially-filled state, which a hand-written
   9-clause `CHECK` on `User` columns would have to reconstruct and could get wrong; (b)
   a separate table means the address is invisible to any query against `user` that
   doesn't explicitly `include` it — least exposure by default for PII on a table
   (`user`) read on every session resolution; (c) `user` is a better-auth-managed table
   already carrying five Operai-added columns, and keeping unrelated PII off it keeps
   that schema-regeneration seam clean.
3. **`formatted` is derived on read, never persisted.** The Domain language defines it as
   "derived from its structured components" — a stored copy could drift from the
   components that produced it, the exact failure class ADR-0019 (regenerable PDF cache,
   never the source of truth) and ADR-0013 (derived, schedulerless state) already
   establish as this suite's posture for computed representations. One implementation,
   `auth/src/profile/address.format.ts`, computes it fresh on every `GET`; the client
   never composes it.
4. **The admin gate is the existing `admin` role / `requireAdmin` — no new catalog
   permission — a deliberate counterpoint to ADR-0028.** `requireAdmin` is a direct
   `user_role` membership check, structurally outside `auth`'s own
   catalog/permission-resolution machinery (ADR-0007) that gates every `refund-api`/
   `notify-api`/`estimai-api` capability. There is no `user:edit` (or similar) catalog
   entry today, and this feature adds none — `userAddressRouter` re-declares
   `sessionMiddleware, requireAuth, requireAdmin` on its own routes, the same gate that
   already governs editing users, roles, and departments. This satisfies AC-4.1 literally
   ("no new catalog permission is introduced"), and it is the correct contrast with
   ADR-0028: ADR-0028 minted a new `settings` catalog resource because that gate had to
   be resolved **over HTTP** by `refund-api`, a separate resource server with no
   `requireAdmin` equivalent of its own (ADR-0014). `auth` **is** the authority — it needs
   no such indirection for a capability its own middleware already expresses.

## Options considered

### Option A — 1:1 `employee_address` table in `auth`, `NOT NULL` required fields, derived `formatted`, existing `requireAdmin` gate (chosen)

Described above.

**Pros:**
- Passes the "attribute of the person vs. domain transaction" test cleanly, giving the
  suite a reusable rule instead of a one-off exception to ADR-0023
- `NOT NULL` expresses "all four required or none" at the strongest available layer, with
  no hand-maintained multi-column `CHECK` to keep correct as fields are added
- Least PII exposure by default — the address is invisible to any `user` query that
  doesn't explicitly join it
- Zero catalog/resolver/migration change on the authorization side — the entire admin
  gate is a re-declared line of existing middleware

**Cons:**
- `auth` — the suite's identity/session/authorization service — now also owns a piece of
  data with no authorization-relevant purpose of its own, mildly widening what "identity
  service" means in this codebase for future readers
- The gate line (`requireAdmin`) must be **re-declared** on the new router rather than
  inherited, because it lives outside the already-1168-line `users.routes.ts` for file
  hygiene — a forgotten line is a real, single-point failure mode (named explicitly as
  the highest-consequence mistake in the feature; see Risks)

### Option B — Columns directly on `User` (rejected)

Add the nine address fields as nullable columns on the existing `user` table.

**Pros:**
- Avoids one join on the two low-traffic address endpoints

**Cons:**
- The "all four required or none" invariant would need a hand-written multi-clause
  `CHECK` (`(a IS NULL AND b IS NULL AND …) OR (a IS NOT NULL AND b IS NOT NULL AND …)`)
  that must be re-verified correct every time a component is added — `NOT NULL` on a
  sibling table cannot be got wrong the same way
- Address columns would be returned by any future `db.user.findMany()` that forgets a
  `select` — and `user` is read on every session resolution and in `GET /admin/users`;
  under GDPR, that default matters for a home address specifically
- `user` is a better-auth-managed table already carrying five Operai-added columns; nine
  more of unrelated PII increases friction on any future better-auth schema regeneration
- Rejected: loses every structural guarantee Option A gets for free, for a marginal
  join-avoidance gain on two rarely-hit endpoints

### Option C — A JSONB document on `User`, mirroring ADR-0004's estimate shape (rejected)

Store the address as a single JSONB column, the same shape ADR-0004 chose for estimates.

**Pros:**
- One column, no migration-time `CHECK` constraints to author

**Cons:**
- ADR-0004's JSONB is the right shape for an **opaque, client-owned document** (an
  estimate) with fidelity defined as semantic deep-equal. This is the opposite: six
  server-validated, individually-required scalar fields, each needing its own
  per-field validation message (AC-1.4 must name *which* field is missing) and DB-level
  completeness/range invariants — JSONB gives up every one of those constraints
- Rejected: the two features solve different problems; reusing ADR-0004's shape here
  would trade away exactly the guarantees this feature needs

### Option D — Keep the boundary from ADR-0023: place address data in a domain service outside `auth` (rejected)

Follow ADR-0023's precedent literally and give the address its own owning service (or
fold it into `refund-api`, the suite's other data-owning resource server), keeping `auth`
scoped to identity/session/authorization only.

**Pros:**
- Perfectly consistent with the one existing precedent, with zero explaining required

**Cons:**
- Fails the actual boundary test (Decision point 1): a home address is not refund-domain
  data, has no relationship to `refund-api`'s money logic, and inventing a new service —
  or misfiling it into `refund-api` — solely to preserve ADR-0023's letter over its
  reasoning would be cargo-culting a precedent past the case it was designed for
- Directly contradicts the approval-gate's explicit, verbatim Constraint that the address
  lives in `auth`'s User profile
- Rejected: this is precisely the reasoned departure this ADR exists to record — the
  boundary test, not ADR-0023's specific outcome, is the actual reusable rule

### Option E — Gate the admin surface with a new catalog permission, mirroring ADR-0028's `settings` resource (rejected)

Declare a new `user:address:manage`-shaped catalog capability in `auth`'s catalog and
resolve it the way `refund-api` resolves `settings:manage`.

**Pros:**
- Superficially consistent with the suite's most recent precedent for "should this be a
  new capability" (ADR-0028)

**Cons:**
- ADR-0028's reasoning applies specifically to a resource server (`refund-api`) with no
  `requireAdmin` equivalent, which must resolve capabilities live over HTTP (ADR-0014).
  `auth` is the authority itself; introducing a catalog entry and a resolver round-trip
  to gate a route inside the very service that issues the tokens and owns the catalog is
  pure indirection with no security benefit
- Directly contradicts AC-4.1's explicit "no new catalog permission is introduced"
- Rejected: the deliberate counterpoint to ADR-0028, not a reuse of it

## Consequences

**Positive:**
- Gives the suite a reusable, generalizable test ("attribute of the person vs. data about
  a domain transaction") for the next time this exact question comes up, rather than
  leaving ADR-0023 as an unqualified, over-broad-looking precedent
- The four-required-or-none invariant is enforced at the strongest possible layer with
  the simplest possible mechanism (`NOT NULL`), with no hand-maintained multi-column
  `CHECK` to keep correct as the shape evolves
- Zero authorization-side blast radius: no catalog change, no resolver change, no
  migration to `auth`'s permission tables — the entire admin-side authorization surface
  is a re-declared middleware line
- Establishes `formatted`-derived-on-read as the pattern any future rendered/computed
  representation in `auth` should follow, consistent with ADR-0013/ADR-0019 elsewhere in
  the suite

**Negative / trade-offs:**
- `auth` now owns a table with zero relationship to identity, session, or authorization —
  a future contributor skimming `auth`'s schema for "what does this service actually do"
  will need this ADR to understand why an address table lives there
- The gate must be re-declared on the new router file rather than inherited from
  `users.routes.ts`, which is a real, singular point of failure: a missing line silently
  exposes every employee's home address to any authenticated user (mitigated below)
- A future engineer adding a *different* new field to `auth`'s user profile may
  reasonably ask "does this pass the boundary test, or should this be a new table too?" —
  this ADR gives the test but does not, and cannot, pre-answer every future case

**Risks:**
- **Missing `requireAdmin` on the new router.** Because `userAddressRouter` is a new file
  outside `users.routes.ts` (kept separate for file hygiene against an
  already-1168-line file), the admin gate is a re-declared line, not an inherited one.
  Mitigation: `userAddress.routes.test.ts` asserts a non-admin gets `403` on **both**
  routes — a forgotten middleware line can never ship undetected.
- **A future contributor misreads this ADR as "any personal-data field belongs in
  `auth`."** The boundary test (Decision point 1) is deliberately two-part — "fact about
  the person" AND "not on another service's hot path" — precisely so a future field that
  fails the second half (e.g. anything requiring live computation against another
  domain's data) is not wrongly routed into `auth` by over-generalizing this decision.
- **PII on an identity service raises `auth`'s own compliance surface.** `auth` now holds
  home addresses, not just role/department/job-title metadata — a genuinely more
  sensitive category of personal data than anything it previously stored, flagged
  explicitly for the specs/012 owasp review (frontier tier).

## Compliance notes

- GDPR / data-protection impact: medium — a home address is personal data, and the
  1:1-table design is a deliberate GDPR-minimization choice: the address is invisible to
  any `user` query that doesn't explicitly `include` it, unlike columns directly on
  `user` (Option B), which is read on every session resolution and admin listing.
- Data residency: compliant — `EmployeeAddress` lives in `auth`'s existing EU-region
  PostgreSQL database (no new datastore, no new region introduced by this feature).
- Audit trail: every set/change/clear is recorded via `auth`'s existing `audit_log`
  mechanism, reused unchanged — the audit-assurance tier applicable to that mechanism is
  recorded separately in **ADR-0033**, not here.

This decision is an explicit, reasoned **departure from ADR-0023** (which kept
refund-domain data out of `auth`; this ADR supplies the boundary test that explains why
that precedent does not extend to a person-attribute like a home address). It draws on
ADR-0013 and ADR-0019's derived-on-read lineage for `formatted`, and it is the deliberate
**counterpoint to ADR-0028**: where ADR-0028 minted a new catalog capability because
`refund-api` has no `requireAdmin` equivalent and must resolve capabilities live over HTTP
(ADR-0014), this feature's admin gate needs no such indirection because `auth` is the
authority itself.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
