# 0028 — A new `settings` catalog permission, deliberately not a reuse of `rate` — config ≠ rate, gated on both read and write

**Date:** 2026-07-22
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/011-refund-settings` US-3 requires that only an authorized admin may view or change the
accounting distribution email, enforced by the server — "not merely hidden in the UI" (AC-3.1) —
mirroring `specs/009`'s posture for mileage-rate management (AC-4.6, ADR-0023). The spec left the
exact capability an explicit open question: "a new `settings`/`config`-shaped catalog permission,
or reuse of the existing `rate:manage` capability (both would be global, non-entity-scoped, per
ADR-0023's precedent)." `refund`'s catalog (`auth/src/authz/catalogs/refund.ts`) already declares
exactly one precedent for this shape of decision — a global, unconditioned `rate` resource
(`read`/`manage`, no `supportedConditions`) seeded to `admin` and `refund-admin` — created one
spec earlier for mileage-rate administration (ADR-0023), which itself lives in the same admin-ui
Refund tab this feature's panel is added to.

Unlike `rate`, this setting is materially more sensitive on the **read** side: `GET
/rates/effective` (the employee-facing live-recompute read, ADR-0023 Decision 4) is deliberately
**un-gated** by `rate:read` because the figure it exposes (`km × rate`) is something the employee
already sees on their own claim. The accounting distribution email has no such employee-facing
analog — AC-3.2 requires that a user lacking the capability not even learn the mailbox exists, let
alone its value — so this feature needed a capability whose **read** action, not only its
**manage** action, is a genuine authorization boundary.

## Decision

We will declare a **new**, global (non-entity-scoped), unconditioned `settings` resource on the
`refund` app's catalog — actions `read` and `manage`, no `supportedConditions` — seeded to `admin`
and `refund-admin`, enforced server-side in refund-api on **both** `GET` and `PUT
/settings/:key`, and deliberately **not** implemented as a reuse of the existing `rate:manage`
capability.

1. **`settings` is its own catalog resource, not a third action on `rate`.** `auth/src/authz/
   catalogs/refund.ts` gains `{ resource: "settings", actions: ["read", "manage"],
   supportedConditions: [] }`, exactly mirroring `rate`'s shape (ADR-0023). A distribution mailbox
   is not a rate — reusing `rate:manage` would make the two admin surfaces
   un-separable (an admin could never be granted rate management without also being granted
   settings management, and vice versa), and would make each surface un-auditable in isolation:
   a grant/revocation event in `auth`'s admin API would be ambiguous about which capability was
   actually being changed.
2. **Global, unconditioned — the same reasoning ADR-0023 already used for `rate`, not ADR-0015's
   entity condition.** The accounting distribution email is explicitly suite-wide (spec
   Non-goals: "no entity- or user-scoped configuration of any kind"), exactly like `rate`
   management is a rare, high-trust, global policy action rather than a per-user, per-entity
   population to filter. `settings` therefore gets no `entity` condition, consistent with
   ADR-0023's own contrast with ADR-0015.
3. **Seeded identically to `rate`.** `auth/src/authz/seed.ts` gains
   `seedSettingsAdminGrants()`, granting `settings:read` and `settings:manage` to `admin` and
   `refund-admin`, added to the existing seed sequence right alongside
   `seedRateAdminGrants()` — the only `auth`-side change this feature makes (declaration + grant;
   ADR-0007 — no permissions embedded in the JWT, resolved live via `GET /authz/resolve`,
   ADR-0014).
4. **Enforced on both `read` and `write`, unlike `rate`'s deliberately-ungated employee-facing
   read.** `GET /settings/:key` requires `settings:read`; `PUT /settings/:key` requires
   `settings:manage` — both via the existing `jwtMiddleware` + `authzMiddleware` +
   `hasCapability` chain (ADR-0014, fail-closed 503 on an `auth` outage). This is a deliberate
   asymmetry with `rate`: `GET /rates/effective` is intentionally public-to-authenticated-users
   because the value it exposes is not sensitive beyond what the employee already sees; the
   accounting distribution email has no equivalent non-sensitive employee-facing view, so its
   `read` action is a real boundary, not a formality.
5. **admin-ui gates visibility client-side, refund-api gates access server-side.** The new panel
   in `MileageRatesPage` is shown/hidden based on `settings:read` from the existing `getMe()`
   pattern (AC-3.2, UX only) — the actual trust boundary is refund-api's server-side check, exactly
   as ADR-0014/ADR-0023 already establish for `rate`.

## Options considered

### Option A — New global `settings` resource, read+manage both gated, seeded like `rate` (chosen)

Described above.

**Pros:**
- Keeps the two admin surfaces (mileage rates, accounting settings) independently grantable and
  independently auditable in `auth`'s admin API — a genuinely different concern from rate policy,
  now genuinely separable
- Small, additive catalog change (one resource declaration, one seed function) — zero resolver,
  wire-schema, or migration change, mirroring how cheaply `rate` itself was added (ADR-0023)
- Correctly asymmetric with `rate` on the read side: gating `settings:read` (unlike `rate:read`'s
  employee-facing public analog) matches AC-3.2's requirement that the mailbox not even be
  learnable by an unauthorized user

**Cons:**
- One more catalog resource and one more seed function to maintain going forward; a future refund
  setting unrelated to accounting distribution (e.g. a hypothetical batch-cutoff-day setting)
  would, by default, share this same `settings:read`/`manage` gate rather than getting its own —
  an open question this ADR does not resolve, left to whichever future spec introduces the next
  refund setting
- Doubles the number of admin capabilities a `refund-admin`/`admin` role holder is granted by the
  seed the moment this ships, alongside `rate` (see Risks)

### Option B — Reuse `rate:manage`/`rate:read` for the accounting distribution email too (rejected)

Extend the meaning of the existing `rate` resource to also cover settings, with no new catalog
entry.

**Pros:**
- Zero catalog or seed change — the existing `rate:manage` grant already covers everything this
  feature needs to gate

**Cons:**
- Conflates two genuinely unrelated admin concerns under one capability name: "may set the
  per-km reimbursement policy" and "may change where compiled-batch financial emails go" are
  different responsibilities that a future admin might legitimately want to grant separately
- Makes the two admin surfaces structurally un-separable: revoking one always revokes the other,
  and a grant/audit-log entry for `rate:manage` becomes ambiguous about which surface it was
  actually meant to authorize
- `GET /rates/effective` (the un-gated employee read, ADR-0023) has no analog for the accounting
  email — reusing `rate:read` for a genuinely sensitive value would require inventing a
  special-case exception to `rate`'s otherwise-uniform "manage is the real gate, read is mostly
  informational" shape
- Rejected: cheaper today, but permanently entangles two independent admin surfaces for a savings
  of one catalog constant

### Option C — Entity-scope the `settings` capability, mirroring `accounting`'s ADR-0015 condition (rejected)

Add an `entity` condition to `settings:manage`, so a CH-scoped admin could change the setting for
CH's flows but not Italy's.

**Pros:**
- Superficially consistent with the one other entity-scoped condition already in the catalog

**Cons:**
- The accounting distribution email is explicitly suite-wide (spec Non-goals, Domain language) —
  there is no per-entity variant of this setting to scope a condition against in the first place
- No product driver exists, for the identical reason ADR-0023 already rejected this same option
  for `rate`: admin is already a global role, and this is a rare, high-trust, global policy action
- Rejected: would add complexity and a resolver condition path with nothing behind it to scope

### Option D — Leave `GET /settings/:key` ungated (authenticated-only), mirroring `GET /rates/effective`'s public-to-authenticated-users posture (rejected)

Gate only `PUT /settings/:key` on `settings:manage`, leaving the read side open to any
authenticated refund-api caller.

**Pros:**
- Simpler mental model: one capability (`settings:manage`) instead of two actions to track

**Cons:**
- Directly contradicts AC-3.2, which requires the section — and by extension the value — not be
  shown at all to a user lacking the capability, not merely be non-editable; a mailbox address is
  not analogous to `rates/effective`'s already-employee-visible `km × rate` figure
- Rejected: fails an explicit acceptance criterion, and conflates a genuinely different
  sensitivity profile with `rate`'s

## Consequences

**Positive:**
- The two admin surfaces (mileage rate, accounting settings) stay independently grantable,
  revocable, and auditable in `auth`'s admin API, with no shared meaning to disambiguate
- AC-3.1/AC-3.2 are satisfied precisely: server-side enforcement on both read and write
  (AC-3.1), and true invisibility — not just disabled controls — for a non-holder (AC-3.2)
- Zero resolver, wire-schema, or migration change — the entire `auth`-side surface is one catalog
  constant and one seed function, identical in shape and cost to ADR-0023's `rate` addition

**Negative / trade-offs:**
- A future, unrelated refund setting will by default be gated by this same `settings` resource
  unless a later spec deliberately introduces a narrower one — left open rather than resolved here
- The `admin`/`refund-admin` seed grant silently empowers every existing holder of those roles the
  moment the seed runs, identical in shape to ADR-0023's own accepted risk for `rate`

**Risks:**
- **Seed grant blast radius.** Adding `settings:manage`/`settings:read` to `admin`/`refund-admin`
  silently empowers every existing admin. Accepted as intended — settings management is an admin
  function — and bounded by ADR-0027's append-only immutability guarantee (no admin can rewrite
  history, only append to it).
- **`authzMiddleware`'s 30s resolve-cache TTL** (ADR-0014) means a just-revoked `settings:manage`
  grant can remain effective for up to that window — the same, already-accepted posture that
  applies to every other capability change in the suite; no new mitigation introduced here.
- **Future-setting scope creep.** If a later refund setting has a genuinely different sensitivity
  or audience than the accounting distribution email, reusing `settings` unmodified could
  under- or over-gate it. Named as an open question (see Consequences) rather than mitigated now;
  the descriptor registry (ADR-0027) is the seam where a future setting's specific validation
  lives, but its *capability* is a separate decision each new setting's own spec must make.

## Compliance notes

- GDPR/nLPD impact: low — the capability declaration and its evaluation concern authorization
  logic over who may view/change an operational mailbox address, not new personal-data collection
  or automated decision-making about a data subject.
- Data residency: not applicable — no new storage location; the resource rides the existing
  `auth` catalog/seed machinery (already EU-resident, ADR-0007) and is enforced by refund-api
  (already EU-deployed, ADR-0014).
- Audit trail: this ADR governs only the **gating capability** (who may read/write the setting);
  the audit trail of the setting's actual value changes is recorded separately in ADR-0027.

This decision **extends** ADR-0007 (the catalog remains the sole source of grantable permissions,
resolved live via identity + `perm_epoch` claims, never embedded in the JWT) and ADR-0014
(refund-api's existing authorization-enforcing middleware gates the new routes with no new trust
relationship). It is both a **direct structural parallel** to and a **deliberate point of
contrast** with ADR-0023: parallel in shape (global, unconditioned, seeded to the same two roles),
contrasting in that this capability gates its `read` action as a genuine boundary, where
`rate:read` deliberately does not gate the employee-facing `GET /rates/effective`. It also
reaffirms ADR-0023's own contrast with ADR-0015 (entity-scoped ABAC) — a second capability, for a
second reason, choosing global scope over an entity condition.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
