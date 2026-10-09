# 0045 — A gated tool remote may expose a second, ungated federated entry mounted at a shell-owned route when the screen is identity-scoped: `/devices`, extending ADR-0034 and ADR-0009

**Date:** 2026-10-06
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/015-hardware-inventory` US-4 requires that every signed-in user, including one holding
**no** grant for the inventory tool, can see the devices assigned to them and confirm or decline
pending assignments. AC-9.6 requires, at the same time, that the tool itself stays absent from
the navigation of any user holding neither inventory capability. The tool route `/inventory/$`
is guarded by `createToolAccessBeforeLoad('inventory')`, which redirects a user without
`inventory:access` to `/no-access` — so the devices view cannot live behind that route.

ADR-0034 already answers "where does an every-signed-in-user screen live?": in the shell, as an
ungated child of `shellRoute`, absent from `TOOLS`. But its literal placement
(`AccountScreen`, rendered by the shell itself) fits a read-only identity attribute served by
`auth`. Confirm/decline is **tool business logic** over `inventory-api`'s own data, and ADR-0009
forbids tool business logic in the shell. Every existing ungated route is either a shell-native
screen (`/account`) or a remote that is ungated *as a whole* (`/notify`, `notify-ui`); no remote
yet has both a gated entry and an ungated one.

## Decision

We will make `inventory-ui` expose three federated modules — `./App` (the gated tool),
`./MyDevices` (the ungated devices view) and `./version` (ADR-0030) — and add a shell route
`/devices`, a child of `shellRoute` with **no `beforeLoad` app-access guard**, absent from
`TOOLS`, mounting `inventory/MyDevices` through `RemoteMount`. `UserMenu` gains a "My devices"
link beside "My profile". Server-side, `inventory-api`'s `/me/*` routes (`GET /me/devices`,
`POST /me/assignments/{id}/confirm`, `POST /me/assignments/{id}/decline`) require only a valid
JWT, skip the authz middleware entirely (no dependency on `auth GET /authz/resolve`, no catalog
permission), and scope every query unconditionally to the verified JWT `sub` (ADR-0042's
posture); not-yours is 404, and their responses carry no price, book value or ledger field at
all.

1. **The rule.** A gated tool remote may expose additional federated entries mounted at
   shell-owned, unguarded routes when the screen is identity-scoped (ADR-0034's test: every
   signed-in user must reach it regardless of grants), **provided** the backing routes are
   self-scoped to `sub` and gate nothing on a catalog permission. The shell owns the route and
   the menu link; the remote owns the screen and its business logic.
2. **Both halves are required.** An ungated route over an API that still checks a capability
   would render a screen that 403s; an ungated API under a gated route would be unreachable.
   The ungated shell route, the ungated `/me/*` routes and the data they return (nothing the
   privileged view would withhold) are one decision.
3. **Self-scoping ignores grants.** As in ADR-0042, `/me/*` handlers never read the caller's
   resolved grants or their conditions; a holder of `asset:manage` or `ledger:manage` calling
   `/me/devices` still gets only their own assignments.
4. **Does not change ADR-0006.** Remote URLs still resolve at runtime, the remote still owns
   no auth guard and no chrome; the shell still never hosts tool logic.

## Failure shape

An audience that the product promises access to (every employee, over their own data) is
stopped by a gate that was built for a narrower audience (tool users) — or, in repairing that,
the gate is widened until it no longer separates anything. The two failures are mirror images:
locking the person out of their own record, and opening the whole tool to make the lock go
away. A third, quieter variant: an identity-scoped surface that inherits the privileged
surface's data shape or scoping and so leaks the privileged fields, or silently widens to the
holder's wider grant.

Where else this shape appears, and how to recognise it:
- **Route and API, both directions.** The UI route is ungated but a backing call checks a
  capability (screen loads, data 403s); or the API is self-scoped but the UI route inherits the
  tool guard (data reachable, screen not). Check both layers every time.
- **Read and write.** A self-scoped read that ignores grants but a confirm/decline/withdraw
  write that consults them (or addresses a record by id without re-scoping to `sub`).
- **Shell and remote.** A second entry of any gated remote — the other tools' own
  "my requests" or "my estimates" style views — inherits the tool's route guard by being
  placed under the tool's path prefix; recognise it by "a user with zero grants must reach
  this" being true of the screen.
- **Failure of dependencies.** An identity-scoped route that quietly acquires a dependency on
  the authorization service (resolver, catalog) and so fails when that service does.
- **Response shape.** A self view that reuses the privileged view's serializer, then relies on
  the client to hide fields.

## Options considered

### Option A — Second ungated federated entry of `inventory-ui` at a shell `/devices` route (chosen)

Described above.

**Pros:**
- Meets US-4 for every signed-in user and AC-9.6 for navigation simultaneously
- Business logic and strings stay in the remote that already owns the API client; the shell
  holds only a route and a menu link, honouring ADR-0009
- No new deployable, Vercel project or runtime-config entry; reuses the `/notify` shape
- Names a reusable rule for future tools with a "my own records" screen

**Cons:**
- Two federated entries of one remote mounted on different shell routes has no precedent in
  this repo
- The remote's reachability is now partly ungated, so "remote = gated tool" is no longer an
  invariant; a contributor could cite `/devices` to justify an ungated route that does not
  meet ADR-0034's test

### Option B — A shell-native screen like `AccountScreen` (rejected)

**Pros:**
- Literal ADR-0034 placement; no federation change

**Cons:**
- Confirm/decline is tool business logic; ADR-0009 says tool business logic never lives in
  the shell
- The shell would call a tool backend using tool-specific contracts and strings

### Option C — Grant every user `inventory:access` (rejected)

**Pros:**
- No shell route or federation change

**Cons:**
- The tool would appear in everyone's sidebar, violating AC-9.6
- Every tool screen would need its own inner gating, replacing one central gate with many

### Option D — A separate fifth remote for the devices view (rejected)

**Pros:**
- Keeps each remote either wholly gated or wholly ungated

**Cons:**
- A new deployable, Vercel project and runtime-config entry for one screen that shares all of
  its API client code and strings with `inventory-ui`

## Consequences

**Positive:**
- Every employee can see and answer their own device assignments with zero grants
- One reusable placement rule for ungated entries of gated remotes
- `/me/*` has no catalog permission and no `auth` runtime dependency

**Negative / trade-offs:**
- The shell route `/devices` and the remote's `./MyDevices` export are a new shell-to-remote
  contract to keep in sync
- A new menu link; a second precedent for ungated routes beyond `/notify` and `/account`

**Risks:**
- **No precedent for two entries from one remote (plan Risk R-5).** Early check before any
  screen is built: a shell router test asserting `/devices` has no `beforeLoad`, and
  `shell/e2e/mf-singleton.spec.ts` extended to `/devices` so shared singletons are verified on
  the second entry.
- **Remote down.** ADR-0030's degrade-silently rule applies to this seam: `/devices` shows
  the standard `RemoteMount` failure, never a broken shell.
- **`/me/*` during an `auth` outage.** It keeps working, deliberately: it needs only JWKS
  verification, in contrast to the fail-closed capability routes (ADR-0014).
- **Drift into `TOOLS` or an inner guard.** A contributor "fixes" the inconsistency by
  listing `/devices` in `TOOLS` or guarding it. Mitigation: this ADR, and the router test
  above.
- **Field leakage.** Mitigation: the `/me/devices` integration test asserts no key matching
  price, cents, ledger or schedule.

## Compliance notes

- GDPR / data-protection impact: low — each user sees only data about devices held by
  themselves; no price, book value or ledger data is exposed on the self-scoped routes.
- Data residency: unaffected — `inventory-api` follows the suite's EU-region deployment rule.
- Audit trail: confirm/decline are mutations on assignments; their audit treatment is owned by
  specs/015's assignment lifecycle, not changed here.

This decision **extends** ADR-0034 (its test, placed in the shell as a route, now allows the
screen itself to come from a remote) and ADR-0009 (the `/notify` shape, applied for the first
time to a remote that also has a gated entry), **applies** ADR-0042's self-scoping to
`inventory-api`, reuses ADR-0030's degrade-silently rule, and **does not change** ADR-0006.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
