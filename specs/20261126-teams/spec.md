---
id: 20261126
slug: teams
status: done
rigor: production
created: 2026-11-26
approved: 2026-11-26
done: 2026-11-27
---

# Teams — named groups of people, managed in Admin, taking part in projects

## Problem

People at wellD work in teams, but Operai knows only individuals. The one existing grouping,
the **department**, exists to confer roles in bulk (`auth/prisma/schema.prisma:147-158`,
`:196-220`), so it cannot double as "who works together": putting people in a department
changes what they may do. On a project the "team" is a flat list of individual user ids that
a project manager replaces by hand, up to 100 (`projects-api/src/projects/team.routes.ts:21-23,
49-82`). A group that works on five projects must be re-typed on each, and when someone joins
or leaves it every project is stale. That list in turn decides who may record hours on a
project (`hours-api/src/targets/bookability.ts:56-70`), who a task may be given to
(`projects-api/src/activity-host/activity-host.routes.ts:120-124`) and who may read the
meetings linked to it (`projects-api/src/meeting-host/meeting-host.routes.ts:93`). Teams are
wanted now, as plain groups that **take part in projects as an entity**, with no permissions of
their own yet.

## Domain language

- **team** — a named group of Operai users, kept in Admin. A person may be in any number of
  teams; a team may be on any number of projects. A team carries **no permission**: it grants
  nothing and is not a role.
- **department** — unchanged: an org grouping that confers roles to its members. A team is a
  separate concept with a separate list; neither implies the other (O1).
- **project team** (existing wording) — everyone on a project. Today that is the project
  manager plus individually listed members. This spec widens it with **attached teams**; the
  word stays, and the project page lists *people* and *teams* separately (O11).
- **on the project** — being the project manager, an individually listed member, or an active
  member of an attached team who holds access to Projects (AC-4.4, AC-4.7). It is what hours,
  tasks and meetings already ask. A person on a project only through a team counts like a
  listed member for all three: recording hours, being given tasks and reading the project's
  linked meetings (O8, decided by the user on 2026-11-26).
- **archived team** — a team withdrawn from new use, kept with its members and history,
  restorable; never deleted (O3).

## User stories

### US-1: Administrators keep a list of teams
As an administrator, I want to create, edit, archive and restore teams in Admin, so that the
groups people work in exist once and are kept in one place.

**Acceptance criteria:**
- AC-1.1: Given an administrator on Admin → Teams, when they create a team with a name of 1 to
  80 characters (trimmed) and an optional description of up to 500, then the team appears in
  the list as active with no members.
- AC-1.2: Given a team named "Backend", when an administrator creates or renames a team to
  "backend " (any casing, surrounding spaces), then it is refused with a message naming the
  clash and nothing changes; the rule counts archived teams too.
- AC-1.3: Given a team shown on a project page, when an administrator renames it, then the
  next load of the project page shows the new name (projects keep no copy of the name).
- AC-1.4: Given teams exist, when an administrator opens the list, then it shows each team's
  name, number of active members and state; it is searchable by name (case-insensitive
  substring), shows active teams by default and archived ones on request.
- AC-1.5: Given an active team, when an administrator archives it, then it is no longer offered
  when attaching a team to a project, and it keeps its members, its description and every
  project it is already on (O4).
- AC-1.6: Given an archived team, when an administrator restores it, then it is active again
  and offered again.
- AC-1.7: Given any team, when a delete is attempted from the screen or the API, then none is
  possible: the screen has no delete control and the API refuses (O3).
- AC-1.8: Given two administrators edit the same team, when the second saves a stale form,
  then the save is refused and they are asked to reload; no edit is silently lost.

### US-2: Administrators manage who is in a team
As an administrator, I want to add and remove people on a team, so that a team always names
the people who work together today.

**Acceptance criteria:**
- AC-2.1: Given a team, when an administrator adds an active user (found by name or email),
  then that person is listed as a member and counted; the same person may be in any number of
  other teams.
- AC-2.2: Given a member, when an administrator removes them, then they are no longer listed
  or counted and no other team of theirs changes.
- AC-2.3: Given a deactivated user, when an administrator tries to add them, then it is
  refused; given a member deactivated later, they stay listed marked "Deactivated", are not
  counted as active, and count again if the account is reactivated.
- AC-2.4: Given a team with 100 members, when an administrator adds one more, then it is
  refused with the limit named (O9). An archived team's members can still be edited.
- AC-2.5: Given a person is added to or removed from a team, when their effective permissions
  are read before and after, then they are identical, and no role, department or `perm_epoch`
  changes (a team grants nothing).

### US-3: Only administrators manage teams, and every change is on record
As an administrator, I want team management to follow Admin's rules, so that nobody else
reshapes who is on which team and I can see who did what.

**Acceptance criteria:**
- AC-3.1: Given a signed-in user who is not an administrator, when they look for Teams in
  Admin, then there is no entry, a direct address redirects away, and the API refuses
  (403) every team write and the administrator team list. "Administrator" is whoever Admin's
  existing gate already admits; no permission is added to the catalog and nobody else gains
  team management (O2, decided by the user on 2026-11-26).
- AC-3.2: Given any create, edit, archive, restore, member add or member remove, when it
  succeeds, then the Admin audit log gets one entry naming the actor, the team and the change
  (for membership, the person); a refused change writes none.
- AC-3.3: Given the Admin screen, when the language is English or Italian, then every team
  string is in that language and dates use the library formatters.

### US-4: A project takes teams as well as people
As a project manager, I want to put whole teams on a project, so that I do not list the same
people again on every project and the project follows the team when it changes.

**Acceptance criteria:**
- AC-4.1: Given a holder of `project:manage` for a project's entity, when they attach an
  active team (up to 10 per project, O9) or detach one, then the project's `ETag` changes and
  the page shows it; a holder scoped to the other entity is refused (403 `out_of_scope`), and
  a stale save is refused (409) like every project write.
- AC-4.2: Given an archived team, when a holder tries to attach it, then it is refused; given a
  team attached before it was archived, it stays attached until someone detaches it.
- AC-4.3: Given any holder of `projects:access`, when they open a project, then its team card
  lists the individual people and, separately, each attached team by name with its current
  active members' names; a deactivated member is marked, and a member without access to
  Projects is marked as such (AC-4.7).
- AC-4.4: Given a project with manager M, individual members I and attached teams T, when its
  people are computed, then they are M, I and the active members of every team in T who hold
  access to Projects (AC-4.7), each counted once even when in several places.
- AC-4.5: Given a person on a project both individually and through a team, when the team is
  detached, then they stay on the project; given a person only through that team, then they
  leave it.
- AC-4.6: Given a person is added to or removed from an attached team, when any consumer next
  asks who is on the project, then the answer reflects it within 60 seconds at most (live, not
  a snapshot, O6). The existing individual team editor and its 100-person limit are unchanged.
- AC-4.7: Given a member of an attached team who holds no access to Projects, when the people
  of the project are computed, then they are not counted (so they cannot record hours on the
  project, be given its tasks or read its linked meetings through the team), the team is still
  attached and accepted, and the project page marks that member as without access to Projects
  (O7, decided by the user on 2026-11-26); given the person later gains access, they are
  counted from then on.
- AC-4.8: Given the projects list, when a user filters by team, then only the projects that
  team is attached to are listed; the filter offers only teams attached to at least one project.
- AC-4.9: Given the project manager field, when a team is picked, then it is not possible: a
  project manager stays one person.

### US-5: Being on a project through a team counts everywhere
As a team member, I want being on a project through my team to give me what being listed on it
gives me, so that nobody must be listed twice for the team to be useful.

**Acceptance criteria:**
- AC-5.1: Given a person who is on a project only through a team, when they record hours on that
  project, then it is accepted exactly as for a listed member; given they then leave the team,
  a new entry on that project is refused (`not_on_project`) and the entries already recorded are
  untouched.
- AC-5.2: Given a person on a project only through a team, when a task of the project is given
  to people, then they are offered and accepted as assignee; given they leave the team, tasks
  already assigned to them stay as they are (the same as removing an individual member today).
- AC-5.3: Given a meeting linked to the project, when a person who is on the project only
  through a team opens it, then they are a host reader exactly as a listed member is; given
  they leave the team, they no longer read it through the team. This knowingly widens who can
  read meeting content whenever a team is attached (O8, decided and accepted by the user on
  2026-11-26).
- AC-5.4: Given the team members cannot be read (auth unavailable), when hours, activities or
  meetings ask who is on a project, then the decision is refused as unavailable and never
  answered from the individual members alone; when the project page cannot read them, it still
  loads, shows each attached team — by name when the name could be read, otherwise marked
  "could not be loaded" — and marks their members "could not be loaded".
- AC-5.5: Given a person on a project only through a team and without `project:manage`, when
  they try to change the project, then it is refused: a team gives presence, never
  capability.
- AC-5.6: Given one person who opens project pages more often than a per-person limit set in
  the plan allows, when they open another project page, then the page still loads, shows each
  attached team marked "could not be loaded" and its members "could not be loaded" (as in
  AC-5.4), and tells them they made too many requests and to retry later; once they are back
  under the limit, their next ordinary load shows the teams and members again, with any rename
  (AC-1.3). Meanwhile, no other person's project page, and no decision about who is on a
  project (hours, task assignment, meeting reading), is refused as unavailable because of that
  person's reads.

## Non-goals

- **Team-level permissions or roles** — explicitly out for now: a team confers no permission
  and cannot be given a role or a department; the model must leave room for it later.
- **Replacing departments** — departments keep conferring roles; no migration of departments
  into teams or the reverse.
- **Converting existing project members into teams** — current individual members stay as they
  are; nothing is migrated automatically.
- **A team lead / team owner who manages their own team** — administrators only (O2).
- **A new catalog permission for teams** — none is added (O2).
- **Teams in other tools** (CRM deals, estimates, meetings, hours reports by team) — Projects
  only. No hours totals or reports by team.
- **Teams on invitations** — an invitation does not pre-assign teams; an administrator adds the
  person after sign-up.
- **Notifications** to people added to a team or to a project through a team (O12).
- **A "my teams" screen** for ordinary users (O15).
- **Entity scoping of a team** — a team is not tied to a legal entity (O5).
- **Deleting a team** (O3).
- **Changing what any other tool already records**: past time entries, tasks and meeting links
  are not rewritten when team membership changes.

## Delivery

One spec, delivered in two steps (O16, decided by the user on 2026-11-26):

1. **Admin** — US-1 to US-3. Ships a managed list of teams with no consumer yet; accepted.
2. **Projects** — US-4 and US-5, which depend on step 1.

## Amendments

- **2026-11-26 — AC-5.4 (second sentence).** The original said the project page, when it cannot
  read the team members, "shows the team names". That conflicts with AC-1.3: projects keep no
  copy of a team's name, so when the team read fails the name may be unreadable too. Replaced
  with: the page shows each attached team by name when the name could be read, otherwise marked
  "could not be loaded", and marks their members "could not be loaded". Drift found by the
  architect (plan.md § "Spec amendment proposed (drift)"), accepted by the user on 2026-11-26.
  No other criterion changed; the count stays 30.
- **2026-11-26 — AC-5.6 added (US-5).** Closes plan.md risk R11: every project page view makes
  one fresh read of team members on the same per-service allowance that hours bookability, task
  assignment and meeting reading depend on, so one person reloading project pages could make
  those decisions unavailable for everyone. The new criterion limits project-page reads per
  person (the limit itself is set in the plan) and states the observable outcome for a person
  over it. Decided by the user on 2026-11-26. The count becomes 31; the spec gate is re-opened.

## Open questions

### Decided by the user on 2026-11-26

- [x] O2 Who manages teams? — **Decided (user, 2026-11-26): administrators only**, using
  Admin's existing gate (`requireAdmin`, as departments:
  `auth/src/admin/departments.routes.ts:462`), with **no new catalog permission** (a team
  grants nothing, so there is nothing to withhold from line managers yet). Reflected in
  AC-3.1. The alternative, a new `team:manage` capability, is not taken.
- [x] O7 Team members who hold no access to Projects? — **Decided (user, 2026-11-26): they
  are not counted** on the project (so no task is given to someone who cannot open it) and the
  project page marks them, rather than refusing the team. Today a person without access is
  refused when added to a project (specs/20261103-projects AC-1.6); the team path differs on
  purpose. Reflected in AC-4.3, AC-4.4, AC-4.7. Plan cost: access must be checked per member.
- [x] O8 Do team-derived people read a project's linked meetings? — **Decided (user,
  2026-11-26): yes**, same as listed members, and the related downstream question (hours
  bookability and task assignment) is yes too: a person on a project only through an attached
  team counts like a listed member for all three. **The user accepted knowingly that this
  widens who can read meeting content** whenever a team is attached to a project. Reflected in
  the domain language, AC-5.1 to AC-5.3.
- [x] O16 Scope and split. — **Decided (user, 2026-11-26): one spec, delivered in two steps**
  (Admin US-1 to US-3 first, then Projects US-4 and US-5). This draft has 30 ACs. See
  Delivery.

### Recommended answers, confirmed by the user at the spec gate on 2026-11-26

The spec assumes the recommended answer to each; all twelve were confirmed by the user at the
spec gate on 2026-11-26.

- [x] O1 Is a team separate from a department? — owner: product owner / user. **Recommend
  separate** (own list, own screen): a department's whole purpose is roles, a team must grant
  nothing, and mixing them would make "add to team" silently change permissions. Confirmed at
  the spec gate, 2026-11-26.
- [x] O3 Archive or delete? — owner: user. **Recommend archive only, no delete**: Admin cannot
  know which projects, hours or meetings a team touched, and history must stay explainable
  (Accounting's deactivate/reactivate posture). Departments, by contrast, are deleted outright
  (`departments.routes.ts:588-606`). Alternative: delete only a team never attached to a
  project (needs projects to answer first). Confirmed at the spec gate, 2026-11-26.
- [x] O4 What does archiving do to projects already using the team? — owner: user.
  **Recommend nothing**: the team stays attached and its members still count until a project
  manager detaches it. Alternative: archiving ends the team's effect everywhere at once
  (surprising: people lose access to hours and tasks by an Admin click). Confirmed at the spec
  gate, 2026-11-26.
- [x] O5 Does a team belong to an entity (`welld_ch` / `welld_it`)? — owner: user. **Recommend
  no**: people work across entities and a project's entity already scopes who may manage it.
  Confirmed at the spec gate, 2026-11-26.
- [x] O6 Live or snapshot membership on a project? — owner: user. **Recommend live**: a team is
  an entity on the project, not a one-off import; a snapshot would recreate today's problem
  (stale lists). The price: a team change instantly changes who may record hours. Confirmed at
  the spec gate, 2026-11-26.
- [x] O9 Limits? — owner: user. **Recommend 100 members per team** (the project team's
  limit) and **10 teams per project**, to keep every consumer's lookup bounded. Confirmed at
  the spec gate, 2026-11-26.
- [x] O10 Propagation freshness (AC-4.6)? — owner: user. **Recommend at most 60 seconds**, the
  suite's ceiling for a cached live fact (ADR 20261119 accounting posture), none beyond.
  Confirmed at the spec gate, 2026-11-26.
- [x] O11 Naming collision: "team" already means "people on a project" in Projects. —
  owner: product owner. **Recommend** the project page's card keeps "Team" with two sections,
  People and Teams; Admin's new section is "Teams". Confirmed at the spec gate, 2026-11-26.
- [x] O12 Notify people added to a team or to a project through a team? — owner: user.
  **Recommend no** for now. Confirmed at the spec gate, 2026-11-26.
- [x] O13 Should invitations assign teams? — owner: user. **Recommend no.** Confirmed at the
  spec gate, 2026-11-26.
- [x] O14 Project-list filter by team (AC-4.8): in this spec or later? — owner: user.
  **Recommend in**, one AC, since without it nobody can tell what archiving a team touches.
  Confirmed at the spec gate, 2026-11-26.
- [x] O15 A "my teams" view for ordinary users? — owner: user. **Recommend not now.**
  Confirmed at the spec gate, 2026-11-26.
