---
id: 004
slug: auth-roles-permissions
status: in-progress
rigor: production
created: 2026-07-13
approved: 2026-07-13
---

# Authorization: roles, departments & fine-grained permissions

## Problem

The Operai suite authenticates users (who you are) but has no notion of what a user
is allowed to do. Every signed-in user can reach every app and every action in it.
As the suite grows to handle financial and personnel data (refund approvals, HR),
wellD needs to grant access precisely: not everyone should see every app, and inside
an app different people need different privileges (view vs. edit vs. approve vs.
delete), sometimes only over their own data or their entity's data. There is today
no model for roles, departments, or permissions, no way for an administrator to
manage them, and no way for an app to learn a user's permissions — so no app can
safely gate anything.

## Domain language

Terms used throughout (to be reused in the plan, APIs, and UI copy):

- **user** — a signed-in person.
- **role** — a named, reusable bundle of permissions (e.g. `admin`, `accounting`).
- **department** (group) — a team users belong to (e.g. Accounting, HR); carries
  roles/permissions its members inherit. Single wellD organization.
- **resource** — a thing an app owns and protects: an app itself, or a data type
  within an app (e.g. `estimate`, `refund-request`).
- **action** — an operation on a resource (`view`, `create`, `edit`, `delete`,
  `approve`, …).
- **condition** — a constraint narrowing a permission: **ownership** (own records
  vs. any) and **attribute** match on entity (WellD CH / WellD Italia), department,
  or job title.
- **permission (rule)** — a grant of an *action* on a *resource*, optionally with
  *conditions*.
- **permission catalog** — the set of resources + actions (and which conditions
  apply) that an app declares; the source of truth admins build rules from.
- **effective permissions** — the resolved permission set for a user (union of
  direct roles and department roles), surfaced to the suite for a signed-in user.
- **Admin tool** — the dedicated GUI (a suite app) for managing all of the above.

## User stories

### US-1: Administer roles, departments, and user access
As an authorization admin, I want to manage roles, departments, and who has what,
so that access to the suite reflects wellD's real org and duties.

**Acceptance criteria:**
- AC-1.1: Given an admin in the Admin tool, when they create/rename/delete a role,
  then it is persisted and reflected in the roles list.
- AC-1.2: Given an admin, when they create a department and add users to it, then
  those users appear as members and inherit the department's roles/permissions.
- AC-1.3: Given an admin, when they assign a role to a user (directly or via a
  department), then that user's effective permissions include that role's permissions.
- AC-1.4: Given an admin, when they revoke a role/membership/permission, then it no
  longer applies to the affected users' effective permissions.
- AC-1.5: Given a non-admin user, when they attempt to open the Admin tool or call
  its management APIs, then access is denied and no authorization data is exposed or
  modified.

### US-2: Fine-grained permission rules and custom roles
As an authorization admin, I want to grant a specific action on a specific resource,
optionally limited by conditions, and bundle rules into custom roles, so that access
is as precise as the work requires.

**Acceptance criteria:**
- AC-2.1: Given an admin composing a rule, when they pick a resource and action,
  then only resources/actions present in an app's declared catalog can be chosen
  (arbitrary/typo'd permissions cannot be created).
- AC-2.2: Given an admin, when they attach an **ownership** condition (own records
  only vs. any), then the rule records it and it is reflected in affected users'
  effective permissions.
- AC-2.3: Given an admin, when they attach an **attribute** condition — entity
  (WellD CH / WellD Italia), department, or job title — supported by that resource's
  catalog entry, then the rule records it and it is surfaced alongside the permission.
- AC-2.4: Given an admin, when they define a new custom role from selected rules,
  then it is assignable and behaves exactly like a seed role.

### US-3: Apps declare their permission catalog
As an app author, I want my app to publish the resources and actions it protects, so
that admins build rules against real permissions and no app honors a permission it
never defined.

**Acceptance criteria:**
- AC-3.1: Given an app that declares a permission catalog, when the Admin tool loads,
  then that app's resources, actions, and supported condition types are available to
  build rules from.
- AC-3.2: Given a rule referencing a resource/action absent from every app's catalog,
  when an admin tries to create it, then it is rejected.
- AC-3.3: Given the suite's apps are themselves resources (with an `access` action),
  when a user's effective permissions are inspected, then whether they may access
  each app (EstimAI, Refund, Admin, …) is determinable from those permissions.
- AC-3.4: Given the suite's already-shipped app EstimAI, when this feature ships, then
  it declares its own permission catalog (its resources/actions — e.g. `estimate` →
  view/create/edit/delete — plus app `access`), so admins can author EstimAI rules
  from day one. (Declaring a catalog is not the same as enforcing it — see non-goals.)

### US-4: A user's permissions are available to the whole suite
As any Operai app or backend, I want to obtain the signed-in user's effective
permissions from the auth system, so that I can make authorization decisions without
building my own permission store.

**Acceptance criteria:**
- AC-4.1: Given a signed-in user, when they establish a session, then any suite app
  can obtain that user's effective permissions from the auth system as an enumerable
  set of (resource, action, conditions) — verifiable by inspecting the token claims
  or the auth session/permissions response.
- AC-4.2: Given a user who belongs to a department AND holds direct roles, when their
  effective permissions are computed, then they are the union of both, with no grant
  lost or duplicated in effect.
- AC-4.3: Given an admin changes or revokes a user's roles/permissions, when the
  change is saved, then it takes effect **immediately** — the user's subsequent
  requests/navigation reflect the new permissions without waiting for a token to
  expire.
- AC-4.4: Given a user with no grant for a (resource, action), when their effective
  permissions are inspected, then that pair is absent — absence means "no access"
  (default-deny).

### US-5: Audit trail of authorization changes
As wellD, we want every authorization change recorded and reviewable, so that access
to financial/personnel data is governable and accountable.

**Acceptance criteria:**
- AC-5.1: Given an admin makes any authorization change (create/edit/delete/assign/
  revoke of a role, department, rule, or membership), when it is saved, then an audit
  entry is recorded with the actor, timestamp, the target, and what changed.
- AC-5.2: Given recorded audit entries, when an admin opens the audit history in the
  Admin tool, then they see the chronological list of authorization changes.
- AC-5.3: Given an audit entry, when accessed through the app, then it cannot be
  edited or deleted.

### US-6: Safe bootstrap, seed roles, and guardrails
As wellD, we want the system usable and safe from first boot, so that authorization
can be set up without manual database surgery and no one can lock everyone out.

**Acceptance criteria:**
- AC-6.1: Given a fresh deployment with the configured bootstrap admin account, when
  that account signs in, then it can administer authorization with no manual DB edit.
- AC-6.2: Given a fresh deployment, when initialized, then the seed roles `employee`,
  `admin`, `accounting`, and `hr` exist and are editable by admins.
- AC-6.3: Given a newly signed-in user with no explicit assignment, when their session
  is established, then they hold the baseline `employee` role by default.
- AC-6.4: Given the last remaining admin, when an action would leave the system with
  no admin, then it is prevented.

### US-7: The shell shows only the apps a user may access
As a signed-in user, I want to see only the tools I'm allowed to use, so that the
suite reflects my access and I can't stumble into apps that aren't mine.

**Acceptance criteria:**
- AC-7.1: Given a user without `access` on an app, when the shell renders the tool
  navigation, then that app is not listed.
- AC-7.2: Given a user with `access` on an app, when the shell renders, then that app
  is listed and reachable.
- AC-7.3: Given a user without `access` on an app, when they deep-link directly to
  that app's route, then the shell blocks it (routes them to an app they can access,
  or a clear "no access" state) rather than mounting it.
- AC-7.4: Given a user with access to no apps at all, when they sign in, then the
  shell shows a clear empty state, not a broken or blank UI.
- AC-7.5: Given a user's app `access` is revoked, when the change is saved (immediate,
  per AC-4.3), then on their next navigation/refresh that app is gone from the nav and
  its route is blocked.

## Non-goals

- **Enforcing permissions on data-level actions inside apps/backends** (EstimAI/Refund
  actually denying view/edit/add/delete of records against a user's permissions). Each
  app/service enforces those in its own spec using the claims this feature provides.
  *App-level access enforcement at the shell boundary IS in scope* (US-7); per-record,
  per-action enforcement inside an app is not.
- **Multi-tenant / multi-organization** (per-client orgs). Single wellD org only.
- **Self-service access requests / approval workflows** (users requesting access for
  an admin to approve). Admins assign directly in v1.
- **Time-boxed / expiring grants and scheduled access.**
- **Changes to authentication** (providers, MFA, password/session policy). Identity
  is unchanged (spec 002 / ADR-0001/0002/0005); this is authorization only.
- **Backfilling historical audit** or migrating existing app data ownership.

## Constraints

*User-volunteered decisions (interview 2026-07-13 + refund roadmap). Captured verbatim
for the plan; not elaborated here.*

- Authorization **extends the existing better-auth `auth` service** and is surfaced in
  **JWT claims** (extends ADR-0005) — not a separate authorization service.
- The management GUI is a **dedicated federated remote ("Admin" tool)** in the suite
  (ADR-0006 pattern), shown only to admins — not embedded in the shell chrome.
- **Apps declare their own permission catalog** (resources + actions + supported
  conditions) as the source of truth for rule-building.
- The model is **per-resource / per-action with conditions** (ownership + attribute) —
  ABAC-style, not only role→app.
- **Groups are departments within a single wellD organization.** `hr` is a seed
  department with no special default powers beyond what admins grant it.
- Attribute conditions in v1 are **entity (WellD CH / WellD Italia), department, and
  job title**.
- Existing apps declare their catalog now — **EstimAI declares its catalog as part of
  this feature** (AC-3.4).
- Permission changes/revocations must take effect **immediately** (AC-4.3) — no waiting
  for token expiry.
- The **initial admin is bootstrapped from configuration/environment**; seed roles
  `employee` / `admin` / `accounting` / `hr` are provisioned.
- Scope of "done": model + Admin GUI + JWT/session claims + audit + **shell app-access
  enforcement (US-7)**. Per-record, per-action enforcement *inside* apps is out of
  scope (delivered later, per app).
- *Recommended direction for the architect (not binding):* immediate revocation makes
  fat static permission claims a poor fit — keep the token small (identity + a
  permission **epoch/version**) and resolve fine-grained permissions live from the auth
  service, cache-keyed by that epoch, bumping the epoch on any change so caches
  invalidate at once. Final mechanism is the plan's call.

## Open questions

*Accepted as risk at approval (2026-07-13): the one item below is an architecture
decision deferred to `/wellforge:plan`, with a recommended direction already noted
under Constraints.*

- [ ] Exact mechanism for immediate, suite-wide permission resolution (small token +
  epoch-invalidated live fetch vs. very-short-lived tokens vs. push invalidation) —
  owner: architect (plan). See the recommended direction under Constraints.
