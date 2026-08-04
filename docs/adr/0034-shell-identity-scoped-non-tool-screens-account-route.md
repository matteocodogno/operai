# 0034 — The shell may own identity-scoped, non-tool screens: a new `/account` route, extending ADR-0006 and mirroring ADR-0009's un-gated `/notify`

**Date:** 2026-08-04
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/012-employee-address`'s US-6 requires that a signed-in employee can see their own
stored address, read-only, "without having to ask an admin" — framed explicitly as the
same GDPR data-subject transparency right every employee already has over their own
personal data. The approval gate decided this capability exists, is read-only, and is
scoped to self only; exactly *where* in the suite it lives was left to the plan. Every
existing candidate location is a federated remote — `admin-ui`, `refund-ui`, `estimai-ui`
— and every remote in this suite is reachable only through the shell's
permission-filtered Sidebar, gated by an `access` grant resolved from `TOOLS`
(`shell/src/lib/tools.ts`, ADR-0007's app-access model). An employee can legitimately hold
**zero** app grants — `createToolAccessBeforeLoad` sends such a user to `/no-access`. If
the self-view lived inside any gated remote (most obviously `admin-ui`, which is
admin-only and therefore the worst possible fit), an employee without that specific tool's
grant could never reach their own personal data — directly defeating the GDPR
transparency purpose US-6 exists to serve. Only the **shell** is guaranteed reachable by
every signed-in user regardless of app-access grants, because it owns the chrome and
session for the whole suite (ADR-0006) and already hosts exactly one other route with this
same unconditional-reachability requirement: `/notify` (ADR-0009), reachable by every
signed-in user's bell/notification capability regardless of which tools they can access.

## Decision

We will add a new `/account` route (**"My profile"**) as a child of `shellRoute`, with
**no `beforeLoad` app-access guard**, rendering `shell/src/components/AccountScreen.tsx` —
structurally identical to `/notify`'s placement (ADR-0009) and for the identical reason.
It is deliberately **absent** from `shell/src/lib/tools.ts`'s `TOOLS`, so it never appears
in the permission-filtered Sidebar; its entry point is a new "My profile" item in the
existing `UserMenu` dropdown.

1. **The generalizable rule: any screen every signed-in user must be able to reach,
   regardless of app-access grants, belongs to the shell.** It is a child of `shellRoute`
   with no `beforeLoad` access guard, and it is never listed in `TOOLS` — exactly the
   shape `/notify` already established. This is the rule for the future, not a one-off:
   the next feature that needs "every signed-in user, unconditionally" reachability
   should reuse this shape rather than re-deriving it.
2. **Identity/session is already the shell's domain (ADR-0006); the address is an
   identity attribute served by `auth`, the same service `shell/session` already talks
   to.** `AccountScreen` calls `GET /me/address` via the shell's existing `apiFetch`
   (`shell/src/lib/profileApi.ts`) — no new trusted origin, no new transport mechanism.
3. **Honest, bounded broadening of ADR-0006.** Today the shell renders chrome plus
   `NoAccessScreen` — never a *data* screen. `AccountScreen` is the shell's first data
   screen. Accepted because the scope is deliberately narrow: read-only, identity-scoped
   to the caller only, exactly one endpoint call, with no write path and no
   suggestion/autocomplete affordance (that belongs entirely to the admin edit surface,
   US-1/US-2, hosted in `admin-ui` per ADR-0031).
4. **Rejected: a new `profile-ui` remote.** Building an entire federated remote — its own
   Vercel project, its own `remoteEntry.js`, its own CSP/CORS entries — for one read-only
   paragraph of text is disproportionate, and it would not even solve the actual problem
   without also being un-gated by app-access, which is precisely the special-casing this
   ADR already grants the shell for free.

## Options considered

### Option A — A new, un-gated `/account` route on the shell, mirroring `/notify` (chosen)

Described above.

**Pros:**
- The only location structurally guaranteed reachable by every signed-in user regardless
  of app-access grants — satisfies US-6's GDPR-transparency purpose for **every**
  employee, including one with zero app grants
- Zero new deployable: no new Vercel project, no new federation remote, no new CSP/CORS
  origin — the entire cost is one route, one component, one `UserMenu` entry
- Reuses `/notify`'s already-proven shape (un-gated child route, absent from `TOOLS`)
  rather than inventing a new placement pattern for the same underlying problem
- Establishes a reusable, named rule ("every-signed-in-user reachability ⇒ shell,
  ungated, absent from `TOOLS`") for any future feature with the identical requirement

**Cons:**
- The shell renders an actual data screen for the first time, mildly broadening
  ADR-0006's stated scope ("the shell owns shared chrome + session") — a future
  contributor could misread this as license for the shell to accumulate arbitrary
  feature content rather than a narrowly-scoped, deliberate exception
- The shell now depends on `auth`'s `/me/address` endpoint being reachable to render one
  menu item's destination correctly — a small, new failure surface the shell did not
  previously have

### Option B — Host the self-view inside an existing gated remote (`admin-ui`, `refund-ui`, or `estimai-ui`) (rejected)

Add the read-only address view as a screen inside whichever remote seems the closest fit.

**Pros:**
- No shell change at all — reuses an existing remote's routing and chrome-inheritance

**Cons:**
- Every existing remote requires an `access` grant resolved from `TOOLS`/ADR-0007's
  app-access model. An employee who holds zero app grants — a real, legitimate state —
  would be unable to reach their own personal data, directly defeating US-6's stated
  GDPR-transparency purpose
- `admin-ui` specifically is admin-only, making it the single worst possible fit: the
  overwhelming majority of employees (non-admins) could never reach a self-view hosted
  there at all
- Rejected: fails the requirement on its own terms for any remote chosen, not merely a
  suboptimal placement

### Option C — A new, dedicated `profile-ui` remote, un-gated like `notify-ui` (rejected)

Build a fourth-plus federated remote whose only job is the self-view.

**Pros:**
- Keeps the shell itself free of any data-rendering responsibility, preserving
  ADR-0006's original scope statement unmodified

**Cons:**
- Enormously disproportionate infrastructure — a new Vercel project, a new
  `remoteEntry.js`, new CSP/CORS entries, a new deploy pipeline — for one read-only
  paragraph calling one endpoint
- Would still need the identical un-gating special-case this ADR already grants the
  shell for free (a remote reachable regardless of app-access grants is not the normal
  shape of a remote at all — `notify-ui` is the suite's only other example, and it
  required its own dedicated ADR, 0009, to justify)
- Rejected: strictly more operational surface than Option A for an identical outcome

### Option D — Fold the self-view into `notify-ui`'s existing un-gated `/notify` page (rejected)

Extend the one existing un-gated remote to also show the employee's own address, avoiding
a new route or component in the shell at all.

**Pros:**
- Reuses `/notify`'s already-un-gated reachability with zero new routing decision

**Cons:**
- Conflates two structurally unrelated domains: `notify-ui`'s scope is strictly
  notification business logic (ADR-0009's own explicit constraint — "no notification
  business logic in `shell/session`," by extension no unrelated identity data inside
  `notify-ui` either); an address view has nothing to do with notifications
- Exactly the scope-creep risk ADR-0009 already names explicitly in its own Risks
  section ("it would be easy, under future feature pressure, to let
  [unrelated] behavior creep into" an existing un-gated surface) — repeating rather than
  avoiding a named anti-pattern
- Rejected: solves the reachability problem by breaking domain separation instead

## Consequences

**Positive:**
- US-6's GDPR-transparency purpose is satisfied for every signed-in employee
  unconditionally, including one holding zero app-access grants — the one placement that
  actually meets the requirement as written
- Zero new deployable, zero new CSP/CORS surface, zero new federation remote — the
  cheapest possible correct implementation
- A reusable, named placement rule now exists for the suite's next "every signed-in user,
  regardless of app access" requirement, rather than each future feature re-deriving
  `/notify`'s reasoning independently

**Negative / trade-offs:**
- The shell now renders a genuine data screen, not just chrome and `NoAccessScreen` — a
  real, if narrowly bounded, broadening of what "the shell" means in this codebase that a
  future contributor must actively resist over-generalizing
- The shell gains a new dependency (`auth GET /me/address`) it did not previously have,
  and a new failure mode (a fetch failure must render an explicit error+retry state,
  never silently collapse to "no address on file" — a real UX/correctness distinction the
  implementation must get right)
- `AccountScreen` and `/notify`'s equivalent are now two precedents for "un-gated shell
  content," which makes a future, less-justified third un-gated addition easier to argue
  for by analogy even where the actual reachability requirement doesn't hold

**Risks:**
- **Scope creep into the shell** — the same named risk ADR-0009 already flagged for its
  own un-gated seam, now doubled by a second precedent. Mitigation: this ADR's Decision
  point 1 states the rule precisely (unconditional reachability requirement, not general
  convenience) so a future addition must independently justify itself against that bar,
  not merely point to `/account` or `/notify` as prior art.
- **`AccountScreen` accidentally gains a write affordance over time**, eroding the
  read-only boundary US-6/AC-6.2/AC-6.3 require. Mitigation: enforced server-side
  regardless (`GET /me/address` has no companion write verb — `PUT`/`POST`/`PATCH`/
  `DELETE` all `404`, per ADR-0031's API contract), so a UI regression alone cannot
  reopen the boundary; `AccountScreen.test.tsx` additionally asserts zero interactive
  form elements are present in the address region.
- **`/account` not listed in `TOOLS` drift.** A future contributor unfamiliar with this
  ADR could "fix" the apparent inconsistency of an un-gated route by adding it to
  `TOOLS`, silently re-introducing the app-access gate this ADR exists to avoid.
  Mitigation: this ADR and `/notify`'s own precedent (ADR-0009) are the documented
  record; `router.account.test.tsx` asserts the route has no `beforeLoad` guard.

## Compliance notes

- GDPR / data-protection impact: this route **is** the delivery mechanism for US-6's
  data-subject transparency requirement — an employee's ability to see what personal
  data wellD holds about them without asking an admin. Its unconditional reachability
  (regardless of app-access grants) is load-bearing for that right actually being
  exercisable by every employee, not only those who happen to hold an app grant.
- Data residency: unaffected — `AccountScreen` calls `auth`'s existing `GET /me/address`
  endpoint, itself backed by `auth`'s EU-region PostgreSQL database (ADR-0031); no new
  storage location or cross-border transfer is introduced.
- Audit trail: not applicable — viewing one's own address is a read, not a mutation, and
  carries no audit obligation of its own, mirroring ADR-0009's stance that read/unread
  notification state is ordinary application state, not an audit-relevant event.

This decision **extends** ADR-0006 ("the shell owns shared chrome + session," now
understood to include identity-scoped, read-only, self-only data screens under the
specific reachability test in Decision point 1) and directly **mirrors** ADR-0009's
placement rule for `/notify` (an un-gated child route of `shellRoute`, deliberately absent
from `TOOLS`, entered via existing shell chrome rather than the Sidebar). It reuses
ADR-0001/ADR-0005's transport lineage (`apiFetch`'s trusted-origin Bearer attachment)
verbatim — no new trust mechanism is introduced. It depends on ADR-0031 for the
`GET /me/address` endpoint this screen calls.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
