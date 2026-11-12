# 0090 — The hours screens are a new, wholly ungated federated remote `hours-ui` mounted at `/hours`, and the admin lists stay in admin-ui: extending ADR-0009, ADR-0034 and ADR-0045

**Date:** 2026-11-12  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai

---

## Context

`specs/029-time-tracking` US-4 and AC-5.1 require that any active Operai user, whatever tools they
can open, can record and see their own hours. Recording hours is a person's own act, not a tool
grant, so the screens must be reachable by every signed-in employee, including one with zero app
grants. The screens also carry tool business logic (entry dialog, target pickers, the global
everyone's-hours view for holders of `time-entry:read-all`, export) over `hours-api`'s own data, so
they cannot be a shell-native screen (ADR-0009). The two admin lists (categories, work types) are
admin configuration gated by `time-list:manage`.

ADR-0034 placed an every-signed-in-user screen in the shell; ADR-0045 added an ungated second entry
to an otherwise gated remote. Hours has no gated half at all, so neither precedent fits exactly.

## Decision

We will build the hours screens as a **new federated remote, `hours-ui`**, a clone of the shape of
`notify-ui` (ADR-0009): it exposes `./App` (the whole hours screen, ungated) and `./version`
(ADR-0030), and the shell mounts it on an **ungated splat route `/hours/$`**, a child of
`shellRoute` with **no `beforeLoad` app-access guard**, absent from `TOOLS` and not nested under
any gated tool's path. The shell owns the route and a "My hours" link in `UserMenu`; the
remote owns the screen, its strings and its calls to `hours-api` through `shell/session`
(`getHoursApiBaseUrl()`, `VITE_HOURS_API_URL`). The admin lists are a `/time-lists` page in
**admin-ui**, shown in navigation only to holders of `time-list:manage`, calling `hours-api`
directly through `apiFetch` (the ADR-0023 mileage-rate pattern).

1. **The rule, for a remote with no gated half.** A remote whose every screen is identity-scoped
   or self-service (ADR-0034's test: every signed-in user must reach it regardless of grants) is
   mounted ungated at a shell-owned route. Its backing routes must not gate on a catalog permission
   for the self-service part; the one oversight part (everyone's hours) is gated by its own
   permission, resolved live, as ADR-0075 shapes it.
2. **Not a `TOOLS` entry.** Listing `hours` in `TOOLS` behind an `hours:access` grant would
   contradict AC-5.1 and recreate the zero-grant lockout ADR-0034 exists to prevent.
3. **Admin configuration stays in admin-ui.** Categories and work types are governed alongside
   rates and settings (ADR-0023, ADR-0028); the list page is gated by `time-list:manage`, and a 403
   renders the standard `PermissionDenied`.
4. **Does not change ADR-0006 or ADR-0030.** Remote URLs resolve at runtime per environment, the
   remote owns no auth guard and no chrome, and the About-modal version seam degrades silently when
   the export is absent.

## Failure shape

An audience the product promises a screen to is stopped by a gate that was built for a narrower
audience, or, in repairing that, the gate is widened until it separates nothing. The two halves are
mirror images: locking a person out of their own record, and opening someone else's record to make
the lock go away. A third variant is quieter: a screen placed as "ungated for self" that also
carries the oversight view's data or its scope, so the wider audience leaks through the narrower
route.

Where else this shape appears:
- **Route and data, both directions.** The screen is ungated but its everyone-view call checks a
  permission (the screen loads, the list 403s); or the self-service data is reachable but the route
  sits under a tool prefix that inherits a guard. Check the route and every backing call.
- **Read and write.** A self-service read that ignores grants while the edit or delete of one's own
  entry consults them, or addresses an entry by id without re-scoping to the caller.
- **Remote and shell.** A second, self-service surface placed under a gated remote's path, or a new
  remote added "for one screen", inherits or duplicates a gate it should not have. Recognise it by
  "a user with zero grants must reach this" being true of the screen.
- **Admin side versus person side.** A configuration list shown to everyone because it lives beside
  a self-service screen, or a person-facing screen hidden because it lives beside an admin list.

## Options considered

### Option A — A new ungated `hours-ui` remote at `/hours/$`, admin lists in admin-ui (chosen)

Described above.

**Pros:**
- Meets AC-5.1 for every active user with no grant, and keeps the tool out of `TOOLS`
- Tool logic and strings stay in a remote that owns the hours API contract (ADR-0009 boundary)
- The admin lists sit with the other admin configuration and reuse the ADR-0023 calling pattern
- Follows precedents that already exist in the suite (`/notify`, `/my-meetings`, `/devices`)

**Cons:**
- One more Vercel project, federated remote and runtime-config entry to provision and keep in sync
- A remote with no gated half weakens the "remote = gated tool" reading; a future contributor could
  cite `/hours` to justify an ungated route that fails the test in Decision point 1

### Option B — An ungated `./Hours` entry in projects-ui (rejected)

**Pros:**
- No new deployable or Vercel project

**Cons:**
- Hours also concern deals, meetings and unmapped work, which are not Projects screens
- Open PR #9 (specs/026) rewrites projects-ui heavily; the same files would conflict

### Option C — A shell-native screen (rejected)

**Pros:**
- Literal ADR-0034 placement, no federation change

**Cons:**
- The entry dialog, pickers and export are tool business logic; ADR-0009 forbids that in the shell

### Option D — A `TOOLS` entry behind an `hours:access` permission (rejected)

**Pros:**
- Uses the existing gated-tool shape unchanged

**Cons:**
- Contradicts AC-5.1: an employee with no grant could not record their own hours

### Option E — The admin lists inside hours-ui behind `time-list:manage` (rejected)

**Pros:**
- One remote owns everything about hours

**Cons:**
- Admin configuration already lives in admin-ui (rates, settings); splitting it would put a second
  configuration surface in a person-facing remote, and the remote would then need an admin-only
  nav entry inside an ungated route

## Consequences

**Positive:**
- Every active employee can record and read their own hours regardless of app grants
- The shell gains one route and one menu link; no tool logic enters the shell
- Admin configuration remains in one place

**Negative / trade-offs:**
- `hours-ui` must be provisioned as a pair with `hours-api` (`infra/provision-tool.sh hours`), with
  runtime remote config, CSP `script-src`/`connect-src` entries and an About-modal version
- A remote outage shows the standard `RemoteMount` error in place, with the chrome intact

**Risks:**
- **Drift into `TOOLS` or a guard.** A contributor "fixes" the apparent inconsistency by listing
  `/hours` in `TOOLS` or adding a guard. Mitigation: this ADR and a router test asserting `/hours/$`
  has no `beforeLoad` (AC-5.1 e2e as a zero-grant user).
- **Ungated route over gated data.** The everyone-view call must stay behind `time-entry:read-all`;
  the self-service calls must never consult it. Mitigation: the `hours-api` matrix test and the
  e2e journey for a user with only `employee`.

## Compliance notes

- GDPR / data-protection impact: low to medium — time records identify what each employee worked on
  and when; the ungated route exposes only the caller's own entries, and the everyone-view stays
  behind `time-entry:read-all` (ADR-0075 posture).
- Data residency: unaffected — `hours-ui` is client-side and talks only to `hours-api` (EU region).
- Audit trail: not required by this decision; the entry lifecycle is owned by specs/029.

This decision **extends** ADR-0034 (the every-signed-in-user test and the shell route shape) and
ADR-0045 (the ungated entry shape, here without a gated half), **mirrors** ADR-0009's `/notify`
placement for a remote, and **applies** ADR-0023's admin-ui calling pattern to the admin lists.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
