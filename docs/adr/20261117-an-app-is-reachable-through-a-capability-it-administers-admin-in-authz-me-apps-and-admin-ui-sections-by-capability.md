# 20261117 — An app is reachable through a capability it administers: `/authz/me` derives `admin` into `apps` for a holder of `legal-entity:manage`, admin-ui shows its sections by capability, and the admin APIs stay behind `requireAdmin`

**Date:** 2026-11-17  
**Status:** Accepted — approved plan of specs/20261117-legal-entities (approved 2026-11-17); owner decisions AC-4.1 (permission granted through roles, limited to an entity) and amendment D6 (limited means the holder's own entity), and AC-4.3 as proposed and accepted at OQ-4 (the page is shown to people who may manage an entity, hidden from the others). Plan ADR candidate ADR-3.  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

The Legal entities page lives in the administration area (AC-4.3). Two guards stand in front of that area today: the shell's `/admin/$` route is guarded by `apps ∋ "admin"` (`createToolAccessBeforeLoad('admin')`, `shell/src/router.tsx`), and every existing admin-ui API is guarded by `requireAdmin`, the direct `admin` role. The new permission `legal-entity:manage` (resource `legal-entity`, `supportedConditions: ["entity"]`) is declared in the admin app's catalog, `ADMIN_CATALOG`, which replaces the access-only entry of `admin` in `SUITE_APPS` (`upsertAppCatalog` is a full replace per `appId`, so a second registration of `admin` would prune the first). It is granted through roles like every permission, and the seed gives the `admin` role the unconditioned grant. The owner's example is a Swiss accountant who holds the permission for welld_ch only and is not an administrator: as things stand, that person holds a permission that opens a page they cannot reach.

## Decision

We will derive `admin` into the `apps` of `GET /authz/me` for a caller who holds `legal-entity:manage` covering at least one entity, through one function, `adminAreaReachable(permissions, user)`, which uses the same coverage function (`entityGrantFor`) as the management routes. The shell does not change. Inside admin-ui, each section is shown by the capability it needs: Roles, Departments, Users and Audit when the person holds `admin:access` (its meaning unchanged), Legal entities when `GET /legal-entities/manageable` is not empty. The admin APIs keep `requireAdmin`, so the derived entry opens no admin data.

(Plan, Key decisions 4 and 5; API contracts, `GET /authz/me`.)

1. **Derivation.** `apps` = the resources with an `access` grant, as today, plus `"admin"` when the permission covers at least one entity for the caller. `/authz/resolve`, `/authz/app-access-check` and the directory's app filter keep their exact derivation: they answer other questions.
2. **Sections by capability.** The index route redirects to the first visible section; the URL of a hidden section redirects there too. A manager for welld_ch only sees the Admin tool with one section, Legal entities, with welld_ch editable and welld_it read-only (any covered entity may read either history); `/admin/roles` redirects.
3. **Server stays the authority.** Hiding is presentation; every route enforces its own guard. The management routes check coverage per entity; the admin routes check `requireAdmin`.
4. **The condition is the suite's one entity condition**, `{key:"entity", match:"user"}` (amendment D6): a conditioned grant covers the holder's **own** entity attribute, an unconditioned one covers both. It cannot name welld_it for a person attributed to welld_ch, as with every entity-scoped permission; the owner is asked to confirm this is what "limited to one or both entities" meant (plan R12).

## Failure shape

**A person is given a permission whose use requires passing a door that a different permission controls, so the grant is accepted and does nothing; or the door is widened to let them in and opens more rooms than the grant covers.** The two errors are one: the entrance and the rooms are checked by different rules, and someone reconciles them by moving a check to the wrong side. The first is silent for the person (a page that is not there), the second silent for the system (an administrative surface reachable through an unrelated capability).

Where else this shape appears:

- **Show and authorise.** A derived entry in `apps`, a visible tab or a link is presentation. Anything that reads "can see the Admin tool" as "is an administrator" turns a UI hint into an authorization. Recognise it by a check on `apps` or a section list where `requireAdmin`, `admin:access` or a coverage check belongs.
- **Two derivations of "reachable".** `apps` is also answered by other endpoints for other purposes (`/authz/resolve`, `/authz/app-access-check`, the directory's filter). A rule added in one and not the others is acceptable only when they answer different questions, and the difference is written down; a rule that must agree is one function used by every caller (`entityGrantFor` for the page and for the routes).
- **Grant and revoke.** The entry appears when the grant exists and disappears when it is removed or no longer covers an entity, after the epoch bump, with no leftover. A cached `apps` list outliving a revoke is the failure in the other direction; the AC-4.3 test covers a grant change showing and hiding the tool.
- **Client and server evaluation of a condition.** The browser must not evaluate the entity condition itself (`/authz/me` carries no user entity); the server answers with a list (`/legal-entities/manageable`) the browser only displays. Same reason the letterhead plan rejected browser-side condition checks (R3, G4).
- **Another app administered through a narrower capability.** The next resource that lives in an area gated by a broader role (a registry, a catalog, a setting in the administration area) has this exact shape: derive reachability from the capability, show sections by capability, keep the area's own APIs behind their own guards.
- **A hidden URL.** Hidden sections must also refuse by redirect when typed; a link removed from a menu is not a guard.

## Options considered

### Option A — Derive `admin` into `apps` from the capability; sections by capability; admin APIs unchanged (chosen)

**Pros:**
- The shell is unchanged: Sidebar and guard read `apps`
- One coverage function decides both the page's reachability and the routes' authorization, so they cannot drift
- No new admin data is reachable: the derived entry opens `/admin` and nothing behind `requireAdmin`
- AC-4.3 holds as written: a manager sees the page without a second grant

**Cons:**
- `apps` now carries a derived value that is not an `access` grant, and its meaning is documented in one place only; any new reader of `apps` must not read `admin` as "administrator"
- admin-ui must know which sections need which capability, and each new section declares it
- A grant change reaches the shell after the epoch bump, not instantly

### Option B — Grant `admin:access` together with `legal-entity:manage` (rejected)

**Pros:**
- No derivation code

**Cons:**
- Two grants that must travel together; a manager with only the second holds the permission and cannot see the page, breaking AC-4.3. Granting the first also opens the other admin sections' menu for a person who may not use them

### Option C — A shell route outside `/admin` (rejected)

**Pros:**
- No change to `/authz/me`

**Cons:**
- It is the "ungated second entry" shape of ADR 20261006-ungated-second-federated-entry-of-a-gated-remote, which is for identity-scoped screens every user reaches; the spec places the page in the administration area, and this would split the area

### Option D — The browser evaluates the entity condition (rejected)

**Pros:**
- No server list

**Cons:**
- `/authz/me` carries no user entity; the evaluation belongs to the server (ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims: evaluating a condition against a record is the consuming app's job, not the resolver's)

## Evidence

- Planned, not yet run (plan, Test strategy, AC-4.1 to AC-4.3): A-unit and A-int that `/authz/me` `apps` gains `admin` only when the grant covers at least one entity (conditioned grant with the user's entity null: no entry; unrecognised condition: fail closed); E2E: a welld_ch-only manager sees only Legal entities, welld_ch editable and welld_it read-only, `/admin/roles` redirects, a person without the grant sees no Admin tool, an administrator without it sees no Legal entities tab, and a grant change shows or hides the tool after the epoch bump; the existing admin routes return 403 to the derived-entry manager (`requireAdmin` unchanged); `admin:access` still exists after the seed.

## Consequences

**Positive:**
- A person who may manage an entity reaches exactly the page for it, with no other admin surface
- The model scales to other administration-area resources: a capability is a sufficient reason to reach the area, not to use all of it

**Negative / trade-offs:**
- Reachability of the Admin tool is no longer only "holds `admin:access`"; the difference is documented in `/authz/me`'s contract and tested
- Sections gain a capability declaration; admin-ui's navigation is no longer a fixed list (plan R11: a non-administrator no longer sees sections that would 403)

**Risks:**
- **A consumer reading `apps ∋ "admin"` as "is an administrator".** Mitigation: the admin APIs keep `requireAdmin`, so the worst case is a menu entry, and the tests above prove the derived entry opens no admin data. Any new code that needs to know whether someone is an administrator asks for `admin:access` or the guard, never `apps`.
- **The `entity` condition covers the holder's own entity** (D6, R12): a person attributed to welld_ch cannot be given welld_it alone through a condition. Owner to confirm.
- **`apps` derivation and the coverage function drift** if a second copy is written. Mitigation: one function, `adminAreaReachable`, built on the coverage function the routes use.

## Compliance notes

- GDPR / data-protection impact: none. No new personal data; the derivation reads grants the caller already holds.
- Data residency: not affected.
- Audit trail: grants are changed through the existing role editor and audited by `audit_log` (Tier 2) as every grant is.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
