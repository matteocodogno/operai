# 0023 — Per-entity effective-dated mileage rate model, submit-time snapshot, global `rate` permission, and admin-ui-hosted management calling refund-api directly

**Date:** 2026-07-20
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/007-refund-service` recorded `km` on `travel-km` expense lines purely for reference — the
employee still typed the requested amount by hand, so the actual distance driven was decorative
and accounting had no way to verify a claim against wellD's per-kilometre reimbursement policy
without doing the math themselves. `specs/009-mileage-rate` turns that amount into a genuinely
computed, policy-derived figure: `km × the rate in effect for that line's entity and date`, for
two independent per-entity rate series (WellD CH, WellD Italia) that change over time via an
admin-governed, append-only history. Three questions had to be resolved before that computation
could be built: (1) which service resolves the rate and computes the amount, given resolution
must run on *every* draft read and *every* live keystroke-driven recompute (AC-1.2/1.3); (2) at
what exact moment a line's computed amount stops tracking rate changes and becomes permanently
fixed, given a rate change must never silently rewrite an already-submitted claim (US-3) while a
withdrawn-to-draft line must resume tracking live changes (AC-3.2); (3) what authorization gates
who may add a rate entry (spec Open Question, explicitly deferred to the plan), and where the
management screen and its backing calls live given the plan-gate direction that it be hosted in
**admin-ui** even though the money domain must stay in **refund-api**.

`refund-api` already owns the money domain (integer minor units, per-currency subtotals, the
batch PDF, ADR-0016/0018/0019/0020) and already resolves authorization live from `auth`
(ADR-0014). `auth` already owns the suite's single catalog of grantable permissions (ADR-0007)
and admin-ui already renders every admin-facing management screen in the suite, composing
capabilities resolved from `GET /authz/me`. The suite's established posture for policy-derived
state is to compute it on read, never on a schedule (ADR-0013), and its established posture for
authorization conditions is entity-scoping only where the *population being reviewed* is itself
entity-partitioned (ADR-0015, `accounting`'s condition).

## Decision

We will (1) put mileage-rate persistence, resolution, and computation entirely inside
**refund-api**, resolved on every read rather than on a schedule; (2) pin a `travel_km` line's
computed amount exactly once, at the request's transition to `submitted`, with a withdraw-to-draft
clearing the snapshot back to live/derived mode; (3) declare a **new, global (non-entity-scoped)**
`rate:read`/`rate:manage` catalog permission in `auth`'s existing catalog+seed machinery; and (4)
host the rate-management **screen** in **admin-ui**, which calls refund-api's `/rates` endpoints
**directly** (Bearer JWT via the shared `shell/session` `apiFetch`, base URL from a new
shell-owned getter), while refund-api remains the sole owner of the data and all money logic.

1. **Rate persistence + resolution + computation live in refund-api, not auth.** A new `rates/`
   feature module (routes/service/repo/schemas, mirroring `requests/`/`batches/`) owns the
   `MileageRate` table, the "latest `validFrom` ≤ date" resolution per entity, the pure
   `km × rate` computation, the submit-time snapshot, and the read-time live recompute. Making
   this a cross-service call into `auth` on every keystroke-driven recompute would put a hot-path
   dependency in the middle of a UI interaction with no offsetting benefit — the same reasoning
   ADR-0004 already established for estimate persistence: the service owning a domain owns its
   persistence and computation. `auth`'s only involvement is declaring the permission (below).
2. **Effective rate is always derived-on-read, never scheduled.** For a given `(entity, date)`,
   the effective rate is the entry with the latest `validFrom` on or before `date`, resolved fresh
   on every draft read, every live client recompute, and again at submit — no background job ever
   "activates" an entry on its `validFrom` (ADR-0013 lineage, spec Non-goal verbatim). A backdated
   `validFrom` (AC-4.8) is therefore immediately resolvable by any still-draft line without any
   reconciliation step.
3. **Snapshot happens exactly once, at the transition to `submitted`.** A `travel_km` line's
   computed amount is never authoritative during draft — the server recomputes it on every read
   and the client recomputes it on every edit. It is written and frozen exactly once, inside the
   existing submit transaction, alongside `appliedRateMicros`/`appliedRateValidFrom`/
   `appliedRateEntryId`. Withdraw-to-draft clears all three columns back to `null`, returning the
   line to live/derived mode; the next submit re-snapshots against whatever is effective then.
   This makes AC-3.1 ("frozen once decided") and AC-3.2 ("live again once withdrawn, with no
   further edit") both fall out with no special case, because no rate-change code path ever
   writes to a line — only submit and withdraw do, and both already existed as transaction
   boundaries in 007's lifecycle.
4. **A new, global (non-entity-scoped) `rate` catalog permission — a deliberate contrast with
   ADR-0015.** `refund`'s catalog gains a `rate` resource with `read`/`manage` actions, both
   **unconditioned**, granted to the `admin` and `refund-admin` system roles in the seed.
   ADR-0015's entity condition on `accounting` exists because *many* users each review *their own*
   entity's requests — a genuinely per-user, per-entity population. Rate management has neither
   property: admin is already a global role in this suite, exactly two entities exist, and
   rate-setting is a rare, high-trust policy action, not a filtered view over a large population.
   Entity-scoping the capability (`can set CH but not IT`) would add a condition and a
   per-entity resolution path to gate a two-row config surface with no product driver — the entity
   is a field on each rate entry's *body*, not a scope on the *capability*. `GET
   /rates/effective` (the employee-facing live-recompute read) is deliberately **not** gated by
   `rate:read` at all — it exposes only the non-sensitive `km × rate` figure the employee already
   sees, gated by plain authentication + `refund:access`.
5. **The management screen is hosted in admin-ui; refund-api remains the sole owner of the data
   and all money logic.** Per the plan-gate direction, the rate-management screen (per-entity
   history, add-entry form, in-effect highlight, audit list) is a new section inside **admin-ui**,
   alongside Roles/Departments/Users, gated client-side on `rate:manage`. This makes admin-ui a
   cross-service caller for the first time. Two call-path options were evaluated (below); the
   chosen shape is admin-ui calling refund-api's `/rates` endpoints **directly**, via the same
   `shell/session` `apiFetch` admin-ui's existing `adminApi.ts` already uses, obtaining
   refund-api's origin from a new shell-owned `getRefundApiBaseUrl()` getter (mirroring the
   existing `getAuthBaseUrl()`) rather than any `import.meta.env` read of its own — a remote ships
   no build-baked env vars. refund-api's `ALLOWED_ORIGINS` CORS allowlist gains admin-ui's origin.
   Authorization is enforced **server-side in refund-api** via the existing `authzMiddleware`/
   `hasCapability` (ADR-0014) — identical whether the caller is admin-ui, refund-ui, a script, or
   curl; admin-ui's client-side gate is UX only, never the trust boundary, which stays exactly
   where ADR-0014 already put it.

## Options considered

### Option A — refund-api owns data/resolution/computation; snapshot at submit; global permission; admin-ui calls refund-api directly (chosen)

Described above.

**Pros:**
- Effective-rate resolution and the pure computation stay co-located with the lines they compute
  against, in the same query layer, with no cross-service round trip on a hot, keystroke-driven
  path
- Snapshot-at-submit requires zero special-casing for the withdraw/resubmit and backdated-entry
  ACs — "draft ⇒ always derived, submitted ⇒ frozen because submit is the only writer" is a
  two-state rule with no reconciliation logic
- A global permission matches the actual shape of who manages rates (a handful of trusted global
  admins) instead of building an entity-scoped resolution path for a two-row config surface that
  has no per-user population to scope
- admin-ui reuses its own existing cross-origin/auth pattern (`shell/session` `apiFetch` +
  a shell-owned base-URL getter) verbatim, so hosting the screen there costs one new getter and
  one new CORS allowlist entry, not a new trust mechanism

**Cons:**
- admin-ui gains a second cross-origin backend dependency (refund-api, not just auth) and a
  second CORS entry point must be defended, audited, and kept correctly scoped
- The `admin`/`refund-admin` seed grant silently empowers every existing admin the moment it
  ships (accepted — see Risks)
- A non-null `requestedAmountCents Int` column now carries a denormalized, overwritable cache
  during draft and an authoritative frozen value once snapshotted — two different meanings for
  the same column depending on whether `appliedRate*` is null, which a future reader must
  understand from this ADR rather than the schema alone

### Option B — Pin the computed amount at each draft save, not only at submit (rejected)

Write `requestedAmountCents` + the applied-rate snapshot on every draft save, treating each save
as if it were a mini-snapshot, and re-derive only on explicit re-save.

**Pros:**
- Avoids a live server-side recompute on every draft read — the stored value is trusted as of the
  last save

**Cons:**
- AC-3.2 requires a withdrawn-to-draft line, with no further edit, to recompute live against a
  rate change. A save-time-pinned value would go stale exactly there, and because rate changes
  never touch lines (ADR-0013, no cron sweep), the stored value and the required live display
  would permanently diverge without a reconciliation hack
- Rejected: introduces exactly the kind of special case Decision 3 (of the source plan) was
  written to avoid — snapshot-at-submit makes both AC-3.1 and AC-3.2 fall out with a single rule

### Option C — Entity-scope the `rate` capability, mirroring `accounting`'s ADR-0015 condition (rejected)

Add an `entity` condition to `rate:manage`, so a CH-scoped admin could set CH's rate but not
Italy's.

**Pros:**
- Superficially consistent with the one other entity-scoped condition already in the catalog

**Cons:**
- No product driver exists for it: admin is already a global role, there are exactly two
  entities, and rate-setting is rare and high-trust — none of the properties (many users, each
  reviewing their own entity's population) that motivated `accounting`'s condition apply here
- Would require a per-entity resolution path in the authz resolver and in admin-ui's gating for a
  two-row config screen, for a capability nobody asked to scope
- Rejected: complexity with no behavioral requirement behind it; the entity already lives on each
  rate entry's body, which is where the actual per-entity distinction belongs

### Option D — Resolve/compute the mileage rate inside `auth`, alongside the permission it declares (rejected)

Keep rate data, resolution, and the `km × rate` computation in `auth`'s database, with `refund-api`
calling `auth` for both the effective rate and the computation on every read/recompute.

**Pros:**
- Keeps every authorization- and policy-adjacent concept in a single service

**Cons:**
- Effective-rate resolution and computation must run on every draft read and every live,
  keystroke-driven client recompute (AC-1.2/1.3) — making that a cross-service call into `auth`
  puts a synchronous hot-path dependency between two services for no benefit, and duplicates the
  money-computation responsibility `refund-api` already owns (integer minor units, subtotals,
  batch totals)
- Rejected: violates the resource-server-owns-its-own-domain-data pattern already established by
  ADR-0004/ADR-0005/ADR-0016/ADR-0018 for every other Operai backend

### Option E — Proxy admin-ui's `/rates` calls through `auth`'s `/admin` API instead of calling refund-api directly (rejected)

`auth` re-exposes rate CRUD and forwards each request on to refund-api (JWT-forwarding or the
internal service token, ADR-0011/ADR-0017 style).

**Pros:**
- admin-ui would only ever need to know `auth`'s origin, which it already calls for every other
  admin surface — no new cross-origin dependency from admin-ui's point of view

**Cons:**
- Puts `auth` in the money path and duplicates the `/rates` surface across two services for zero
  functional benefit
- Requires either forwarding the caller's JWT through a second hop or minting a new internal
  service-to-service trust relationship into a *financial* endpoint — exactly the
  ownership/logic split the plan's constraint (refund-api must remain the sole money-domain
  authority) forbids
- Rejected: strictly worse than Option A on every axis that matters (ownership clarity, trust
  surface, duplication) for no offsetting gain

## Consequences

**Positive:**
- Establishes a reusable template for any future policy-driven computed amount in the suite:
  service-owns-the-computation, derive-on-read during draft, snapshot exactly once at the
  lifecycle transition that must become immutable
- A rate change (including a backdated one) is immediately visible to every still-draft line with
  zero reconciliation code, and is guaranteed invisible to every already-submitted line with zero
  reconciliation code — both guarantees come from the same "submit is the only writer" rule
- admin-ui's first cross-service backend call reuses proven machinery end-to-end (`shell/session`
  `apiFetch`, a shell-owned base-URL getter, refund-api's existing `authzMiddleware`) rather than
  inventing a new trust or wiring pattern, and establishes the pattern for any future admin-ui
  screen that needs to manage another service's domain data
- The global permission decision keeps the authorization model proportionate to the actual
  population being gated, rather than mechanically copying the one existing entity-scoped
  condition onto every future capability

**Negative / trade-offs:**
- admin-ui now depends on refund-api being reachable to render one section of its own tool — a
  refund-api outage degrades that section to an error banner rather than admin-ui being otherwise
  broken, but it is a new failure mode admin-ui did not previously have
- Two cross-origin CORS entry points into refund-api (refund-ui's own origin, and now admin-ui's)
  must each be kept correctly scoped, not widened into a wildcard, as environments are added
- `requestedAmountCents` on a `travel_km` line carries two different meanings (denormalized
  draft cache vs. frozen authoritative value) distinguished only by whether `appliedRate*` is
  null — a future contributor must read this ADR, not just the schema, to understand that

**Risks:**
- **Rate added between a draft's last save and its submit.** Mitigated by re-resolving the
  effective rate again inside the submit transaction itself, so the snapshot always reflects the
  rate in effect at the exact freezing instant, never a stale draft-save-time resolution.
- **Draft-read recompute cost.** Every draft read now does a rate-resolution query per
  `travel_km` line rather than trusting a stored value. Accepted as the cost of derive-on-read
  correctness (ADR-0013 posture); the query is indexed (`entity, validFrom`) and scoped to a
  single request's lines, not a table scan.
- **Seed grant blast radius.** Adding `rate:manage` to the `admin` role silently empowers every
  existing admin the moment the seed runs. Accepted as intended — rate management is an admin
  function — and bounded by the append-only immutability guarantee recorded in ADR-0024 (no admin
  can rewrite history, only add to it).
- **admin-ui/refund-api cross-origin failure modes** (CORS misconfiguration, base-URL resolution,
  Bearer non-attachment to an untrusted origin) are three concrete, independently testable risks
  from hosting the screen outside refund-api's own frontend; each is mitigated by reusing an
  already-proven mechanism (the existing `getAuthBaseUrl()` shape, refund-api already being a
  trusted `apiFetch` origin via refund-ui) rather than inventing a new one, and is covered by a
  dedicated `ratesApi.ts` unit test mirroring `adminApi.test.ts`.

## Compliance notes

- GDPR/nLPD impact: low — a `MileageRate` row carries the actor's `userId`/`email` (who set the
  rate) alongside a policy value and a date, not a new category of personal data beyond what
  `refund-api` already models for requests (ADR-0018); no special-category data is introduced.
- Data residency: unaffected — all new persistence lives in `refund-api`'s existing EU-region
  PostgreSQL database (ADR-0016's deployment posture); no new datastore or region is introduced.
- Audit trail: the append-only, self-auditing shape of the `MileageRate` table itself is the
  audit-trail decision for rate changes, recorded in full in ADR-0024 rather than duplicated here.

This decision **extends** ADR-0004 (service-owns-its-persistence, applied here to refund-api's
rate data), ADR-0007 (the catalog remains the sole source of grantable permissions; the new `rate`
resource is declared once and resolved live via identity+epoch claims), ADR-0013 (derived-on-read,
never scheduled, applied to effective-rate resolution), and ADR-0014 (refund-api's existing
authorization-enforcing middleware gates the new routes with no new trust relationship). It is a
deliberate **contrast** with ADR-0015 (entity-scoped ABAC), explicitly choosing an unconditioned,
global capability instead, for the reasons in Decision point 4. The rate history's own
append-only/self-auditing shape is recorded separately in ADR-0024; the numeric representation and
rounding rule the computation in this ADR relies on is recorded separately in ADR-0025.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
