# 20261126 — Teams live in auth, grant nothing, and their members and each member's app access are read from auth by the consumer as itself

**Date:** 2026-11-26  
**Status:** Accepted — approved plan of specs/20261126-teams (approved 2026-11-26 at the plan gate; spec answers O1, O2, O5, O6, O7 and O8 decided by the owner on 2026-11-26); decisions D1, D2, D8, D10, D11, D13 and D15 of the plan, and spec AC-5.6 (re-approved by the user on 2026-11-26, 31 ACs). Plan ADR candidate A1, amended 2026-11-26 (the plan's § ADR candidates, items 1–11).  
**Deciders:** Matteo Codogno (product owner), at the plan gate; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims (a team is not part of the resolver, and its `perm_epoch` does not move), ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential and ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials (the narrow, purpose-scoped service read this reuses), ADR 20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database (the scope naming: a suite resource hosted by auth has no service prefix and uses the colon form; the `GET /system/legal-entities` shape), ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds (the consumer cache rule, stamped at send), ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-the-deadline-of-the-consumer-and-what-triggered-it-is-derived-by-the-provider-never-claimed-by-the-caller (the app is derived by the provider from the verified caller), ADR 20261104-user-directory-gate-meetings-access (why the directory is not reused), ADR 20261104-meetings-tool-shape-visibility-by-participation (visibility by relationship, which a team widens), ADR 20261112-system-endpoints-limited-per-verified-service (the allowance), ADR 20261110-activities-service-access-delegated-to-host and ADR 20261126-a-host-says-unknown-for-the-one-field-a-decision-needs-instead-of-failing-the-reads-that-do-not-need-it (the hosts that consume the answer), ADR 20261126-auth-admin-writes-carry-their-base-version-in-the-body-because-auth-cors-exposes-no-etag (the admin write shape), ADR 20261112-push-liveness-answer-reused-30-seconds (a per-event check on a budget shared with other callers; the person-driven read's limit in point 7 follows the same shape).

---

## Context

Operai knows only individual people. The one existing grouping, the department, exists to confer roles in bulk: its members get the roles through `department_role`, which the resolver reads. Putting people in a department therefore changes what they may do, so it cannot double as "who works together". On a project, the team is a flat list of individual user ids that a project manager replaces by hand (up to 100). That list decides who may record hours on the project, who may be given its tasks, and who may read its linked meetings. The spec (specs/20261126-teams) adds teams: named groups kept in Admin, managed by administrators only, that take part in projects as a whole and grant no permission (O1, O2). Whether a person is "on the project" through a team needs two facts that only auth can give: the membership, and whether each member holds access to Projects (AC-4.7, O7). The consumers that ask (projects-api, and through it activities-api, hours-api and meetings-api) must see a change to a team within 60 seconds (AC-4.6, O6).

A user's own token cannot be the channel. auth's user routes limit per caller (identities 120 per 10 minutes, app-access-check 40 per 10 minutes), and the access check takes one id per call, so a project page with ten teams of a hundred people would spend the viewer's own budget on every page view, and an activity list spanning 25 projects would fail for the people the feature is for. The existing app-access-check and the user directory were also rejected as the source: the directory's gate includes `meetings:access`, which every employee holds by default (ADR 20261104-user-directory-gate-meetings-access), so using it would hand the list of everyone to every employee.

## Decision

We will keep teams in **auth**, as two tables, `team` and `team_member`, administered by the existing `requireAdmin` gate with **no catalog permission** and **no `perm_epoch` bump**. The permission resolver never reads these tables, so a team grants nothing (AC-2.5). projects-api keeps only **which** teams are attached to a project (`project_attached_team`, ids only, no name and no member). It reads names, members and each member's access to Projects **live, as itself**, from one new narrow service read, `GET /system/teams`, with scope `teams:read`.

1. **Teams are auth's.** Admin's API is auth's `/admin/*`, and a team is a grouping of auth's own user rows. A team is not a department and never feeds `resolveEffectivePermissions`; a source test pins that the resolver references neither `team` nor `team_member`.
2. **One narrow read, as the calling service, in two modes.** `GET /system/teams` is verified in process like `GET /system/legal-entities`: RS256 against auth's key, issuer, `aud = SERVICE_AUDIENCE` (a user token fails), `sub` `system:<client>`, scope `teams:read`, and one identical 401 for every failure. The `sub` must also appear in a code binding, `TEAM_READERS = { "system:projects-api": "projects" }`. A client that holds the scope but is not in the binding gets the same 401. The route takes exactly one of two parameters:
   - **ids mode** (`ids=`, 1..50 ids): the teams with their names, archived flag, members and each member's access bit. This is the decisions' and the project page's read.
   - **options mode** (`state=active`, with an optional `q`): active team names only, for the attach picker. `q` matches team names only, never members, descriptions or archived teams; it is bounded (no NUL, at most 200 characters raw, 1..80 after trimming); it matches literally, `strpos(lower(name), lower(q)) > 0`, never `LIKE`, so `%`, `_` and `\` are characters; it answers at most 50, with `truncated`, ranked exact match, then prefix, then the rest, so every active team is reachable by its whole name whatever the cap; and it reveals nothing that the unfiltered options list does not.
3. **The app is derived from the verified `sub`, never named by the caller.** auth answers `appAccess` for the bound app only, meaning "holds `(projects, access)`". A caller cannot ask about another app, so the read is not an oracle over the other apps' access.
4. **`appAccess` is computed in one batched query, and proven to be the same predicate as app-access-check.** `holdersOfAppAccess(appId, userIds)` sits beside `resolveEffectivePermissions` in the resolver. It uses the same rule as `POST /authz/app-access-check` (any rule on the `access` action of that app, held directly or through a department, whatever its conditions). A contract test runs both over the same fixtures (direct, department-conferred, conditioned, none, soft-deleted) and requires equal answers, so the two cannot drift.
5. **The consumer caches per team, stamped at send, and never serves a stale answer past 60 seconds.** An entry is used for 30 seconds without a call. A refresh is single-flight, with a 5-second deadline and no redirect. If a refresh fails, an entry at most 60 seconds old (counted from when its request was sent) is used and logged, and an older or missing entry is **unavailable**, never "nobody". A 401 drops the cached service token and retries once. The project page reads fresh, within the limits of point 7, and refreshes the cache entries it touches.
6. **The team read is metered per verified caller, by mode.** Two fixed allowances per calling service per 10 minutes are counted after verification, as ADR 20261112-system-endpoints-limited-per-verified-service requires, chosen by which parameter is present: **`teams`, 3 000** (`TEAMS_SERVICE_LIMIT`) for the ids mode, which the decisions and the project view read; and **`teamsOptions`, 1 500** (`TEAMS_OPTIONS_SERVICE_LIMIT`) for the options mode, which only the attach search reads. A malformed request counts against the allowance of the mode it names. The reason for the split: a read whose volume a person drives must not spend the budget a decision depends on. projects-api also limits `GET /attachable-teams` to 120 per caller per 10 minutes.
7. **The consumer limits the person-driven read on the decisions' allowance.** The project page's fresh ids read is the one read on `teams` whose volume a person drives, so projects-api admits it through two in-process sliding windows of 10 minutes, auth's own window shape: **120 per verified `sub`** (`TEAM_READ_PERSON_LIMIT`) and **2 400 for all people together** (`TEAM_READ_SERVICE_LIMIT`). The 2 400 keeps 600 of auth's 3 000 for the cached decision path, so page reads cannot starve a decision. The windows are checked after the route's guards and the row lookup, and before the auth call; only a project with an attached team counts; only an admitted read is recorded, in both windows at once; and a refused load makes no call and serves no cached entry, so the page still loads with every team marked "could not be loaded", with `teamsStatus: "rate_limited"` and `teamsRetryAfterSeconds` for the person's own window, or `"unavailable"` for the service's. A write that must confirm (`PUT …/teams` adding a team) refuses with 429 `rate_limited` or 503 `teams_unavailable` and writes nothing. The decisions (the activity-host and meeting-host resolves) and `GET /attached-teams` never consult these windows. The windows are per process (see Risks).
8. **The consequence is stated, not hidden.** Membership of an attached team decides who may read a linked meeting's content, record hours on the project, and be given its tasks (O8, accepted by the owner). An admin's change to a team therefore changes those answers on every project the team is on, without any write to the project. This is the widening a team is for; it is accepted and recorded in the audit row of each membership change.

## Failure shape

**A grouping meant to carry no authority acquires authority through the place that reads it, or a fact about one person is answered from a copy, or by a rule restated elsewhere, or with the authority of someone other than the person asking.** Three ways in, one defect. The *grouping that starts to grant*: a list of people that a decision consumes begins to confer a right on its members, because a consumer treats membership as permission, or a resolver or a department-like flag reads it; then an admin's list edit silently changes what people may do, with no epoch and no review. The *copy or restated rule that disagrees with the owner*: the consumer keeps its own copy of who is in a team, or computes "has access to this app" with its own reading of the roles, so a removal, a deactivation or a lost grant lands on one side only, for as long as the copy lives. The *answer computed with someone else's authority*: the consumer asks the owner about a member as the requester, through a route that the requester's own budget pays for, or asks the owner about an app the caller chose, so the answer describes a right the caller does not hold.

Where else this shape appears, including the mirror positions:

- **Grant side and deny side.** A removal (a person leaves a team) must stop the right on every consumer within the window, as an addition starts it. A list that has been read before a removal and kept is the deny-side form of the copy-or-restated-rule defect.
- **Read and write of the same membership.** The write (admin adds or removes) and every read by a consumer share one owner. A new route that writes membership from a second place, or reads it into a second table, is the same shape.
- **A person reached two ways.** The same person through a team and as a listed member is one person with one right. Counting them twice, or counting the team's copy of their right after the listed one has been removed, is the same shape.
- **Service and user principal.** A service that reads membership with a user's token, or a user route answering a service's question, is the wrong authority in the mirror position. A user token must never be accepted on the team read.
- **Named by the caller.** Any new read that lets the caller choose the app, the scope of the answer or the owner whose right is computed is an oracle over other owners' rights. The app is derived from the verified identity.
- **A shared budget spent by a read a person drives.** A budget that a decision depends on, shared with a read that a person's own actions drive (a page reload, a search as they type), is spent by whoever reads most: one person looping in a browser can make every other person's decision "unavailable". The mirror position is the decision path, which must never be limited per person, since it is what the others wait for. The person-driven read is limited per person and in total, below the shared budget. ADR 20261112-push-liveness-answer-reused-30-seconds names the same shape.
- **Pushed copies.** A design where the owner pushes membership to a consumer creates a replicated list that must survive loss and reordering; that is the copy-or-restated-rule defect of the Failure shape, however it is delivered.

Recognise a new instance by asking: does a new table or route say "who is in X" and does a decision read it; is a new access bit computed for an app other than the caller's; does any consumer keep a list of members across requests; does the resolver or a department-style flag read a grouping; and does a membership change reach the decisions within the window the consumer promised.

## Options considered

### Option A — Teams in auth, grant nothing, read live by the consumer as itself through one bound service scope (chosen)

Described above.

**Pros:**
- A team is outside the resolver, so AC-2.5 holds by construction and nothing needs an epoch bump
- One owner for teams, next to the other admin objects; Admin's existing gate
- The consumer's question is narrow (its own app's access, its own bound sub) and cannot be widened by the caller
- The consumer's cache is bounded at 60 seconds and cannot hide a removal longer than that (AC-4.6)

**Cons:**
- Projects with teams depend on an auth read for decisions; the failure modes are made narrower by ADR 20261126-a-host-says-unknown-… (per item) and by the cache
- Two cache-stamping rules to implement and test (send-stamp, 60 s fallback)
- A new `teams:read` scope must be granted in production after the auth that knows it is live, or auth refuses to start (deploy skew, risk R5)

### Option B — Teams in projects-api (rejected)

**Pros:**
- No cross-service read on the project page
- Projects keeps all of its own decision data

**Cons:**
- Admin's API is auth's; Admin would have to call a tool's API to manage a grouping of auth's users
- A future team permission would sit in a tool, not in the identity service that owns permissions
- The user rows the membership points at (with their deletion state, AC-2.3) are auth's

### Option C — A department with a flag, or a department that confers no roles (rejected)

**Pros:**
- Existing table, existing admin screens

**Cons:**
- A department confers roles; a department that does not is a second meaning of one word, and the first later change to one of them changes the other
- O1 requires a team to be a separate concept with a separate list

### Option D — A user-token route in auth, `GET /authz/teams/...`, called by projects-api with the requester's token (rejected)

**Pros:**
- Uses the existing user-token path and needs no new scope

**Cons:**
- Per-caller limits: one viewer's budget is spent on every team of every project they open, and a 25-project activity list fails for the people the feature is for (the same posture as the directory)
- The answer about each member is given to the requester's rights, not to the service that owns the project's decision: the host's question ("who is on this project?") would be answered for whoever happened to ask
- Needs a caller gate that names a Projects permission inside auth, the directory-gate shape that widens with every default grant

### Option E — One app-access-check per member (rejected)

**Pros:**
- Uses an existing route and predicate

**Cons:**
- One id per call and 40 per 10 minutes per caller: ten teams of a hundred members cannot be checked on every resolve

### Option F — The user directory filtered by app, `GET /authz/users/directory?appId=projects` (rejected)

**Pros:**
- Existing route and a list of people with names

**Cons:**
- Its gate includes `meetings:access`, which every employee holds by default, so every employee could list everyone
- It lists everyone and gives no team membership, so the team still has to be modelled and read somewhere else

### Option G — Snapshot the members into projects-api when a team is attached (rejected)

**Pros:**
- No live dependency on auth for the project's own page

**Cons:**
- O6 asks for live membership; a snapshot recreates the stale list the feature exists to remove, and a removal would not reach hours, tasks or meeting readers

### Option H — auth pushes membership changes to projects-api (rejected)

**Pros:**
- No read path on the consumer

**Cons:**
- A replicated list that must survive loss, repetition and reordering, which is the copy-or-restated-rule defect of the Failure shape; nothing here needs push, and a missed push would leave a removed member with access

## Consequences

**Positive:**
- A team cannot grant anything: no role, no department, no epoch, and a test pins the resolver's references
- One owner for teams; a new team consumer is one bound `sub`, one scope and one reviewed change
- Membership changes reach every consumer's decision within 60 seconds with no synchronisation

**Negative / trade-offs:**
- A project with teams depends on auth for the answers that decide hours, tasks and meeting readers; the outage shape is handled per item (ADR 20261126-a-host-says-unknown-…) and not by failing a whole list
- When the team read fails and no usable cache entry is held, the project page still loads: it shows each attached team by name when the name could be read, otherwise marked "could not be loaded", and marks that team's members "could not be loaded" (plan D9; spec AC-5.4 as amended 2026-11-26, specs/20261126-teams/spec.md § Amendments). Team names exist only in auth (AC-1.3), so a team's name is never shown from a copy of ours when the read fails; the original AC-5.4 wording, "shows the team names", is withdrawn
- Members of an attached team are counted only while they hold Projects access, so an access grant or removal in auth changes project decisions without a project write (AC-4.7)
- A person over their page limit (120 per 10 minutes) sees each attached team marked "could not be loaded", and its members too, until their oldest admitted read leaves the window; in the meantime they are not offered Record hours on that page through a team (hours-api still decides every save, and nothing is refused for anyone else, AC-5.6)

**Risks:**
- **Contract drift between `holdersOfAppAccess` and app-access-check (R1).** Mitigation: the shared-fixture contract test (AC-4.7), and the predicate lives beside the resolver, not in projects-api.
- **Widened meeting readership (R4, O8).** Accepted by the owner. Mitigation: the audit row of each membership change, and the security review of the host answers.
- **Deploy skew on the scope (R5).** A `teams:read` grant before auth knows the scope stops auth at startup. Mitigation: the step order in the plan (auth first, then the production grant, then projects-api).
- **The consumer's cached service token lacks the scope for up to five minutes after the grant (R9).** Mitigation: a 401 drops the token and retries once.
- **Allowances exhausted (D11, D15).** The `teams` allowance of 3 000 per 10 minutes is about ten times the expected use. Of it, page reads may take at most 2 400 per 10 minutes, so 600 stay for the cached decision path, which needs about 40 per 10 minutes per 50 attached teams. The `teamsOptions` allowance of 1 500 serves the attach search only. When a window is spent, the page fails soft (AC-5.6: the page loads and the markers say why), and decisions use the cache or say unavailable; a spent allowance never answers "nobody".
- **Every limit is per process (R12).** The windows and the per-caller limits are in-process. projects-api runs one replica; a second replica doubles them and uses up the reserve, so it must first divide the figures by the replica count or move the windows to a shared store. The constants carry a comment saying so.

## Escalation triggers

This decision is revisited when any of these happens:

- a team is given a permission, a role or a department-style effect: a resolver change, an epoch rule and a new ADR; the resolver must then read teams deliberately, and AC-2.5's test is changed by that decision, not quietly;
- a second team consumer is added: add its sub to `TEAM_READERS` deliberately, with its own scope or the same one by review, and check the allowance;
- a consumer needs membership to be pushed to it, or needs to keep a list across requests: the replicated-copy shape of the Failure shape, which needs its own ADR;
- the admin list passes about 500 teams: pagination and server-side search replace the browser filter (plan D12);
- a team's membership changes must be seen by a consumer faster than 60 seconds: the answer to a cache is a new decision, not a shorter TTL;
- projects-api runs a second replica: divide the D15 and per-caller figures by the replica count, or move the windows to a shared store (R12);
- a person's or the service's window is reached in normal use, which the refusal log line (`[teams] page-read limited actor=<sub> window=<person|service>`) shows: the figures are then revisited;
- more than about 750 teams are attached to projects: the cached path's worst case approaches the 600 reserve of the decisions' path.

## Evidence

Planned, not yet implemented at the time of writing. The tests the plan names, to be updated when they land: the source test that the resolver references neither `team` nor `team_member` (AC-2.5); the contract test that `holdersOfAppAccess` equals `resolveEffectivePermissions` on direct, department-conferred, conditioned, none and soft-deleted fixtures (AC-4.7); the auth `GET /system/teams` tests of the identical 401 matrix, verify-before-count, the allowance and the no-id log line; the consumer unit tests of the send-stamp, the 30 s and 60 s windows and single flight (AC-4.6).

The D15 tests (AC-5.6 and the plan's *Further tests*), also planned: the AC-5.6 row (`teams.pageLimit.test.ts`): the 121st page read by one person is the degraded view with no team call and no cache entry served, a refused reload does not move the retry time, another person's view and both decisions are unaffected, the service window gives `"unavailable"`, and a `PUT …/teams` that adds a team refuses with 429 or 503 and writes nothing; `rateLimiter.test.ts`: `peek` records nothing, and `admitTeamRead` records in both windows or in neither; a constant test pins 120, 2 400 and 600 000 ms and keeps them distinct from the attach-search limiter; the refusal log line appears once per person and window, with no project, team or name. The two-allowance tests on auth's `GET /system/teams`: a spent `teamsOptions` answers 429 to the options mode while the ids mode still answers 200, and the reverse, and a malformed request counts against the mode it names.

## Compliance notes

- GDPR / data-protection impact: **medium**. Team membership names working groups and, through the membership, who works with whom; a consumer reads names and one access bit of each member. Mitigation: the read goes only to the one bound service, nothing is stored by the consumer, names are read live and fail soft, and the read is logged without any id or name.
- Data residency: compliant. auth and projects-api run in the suite's EU region; no new processor.
- Audit trail: required. Every successful team write writes one `audit_log` row (actor, team, change, and the person for membership), as an application-level entry of auth's audit log (ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level). Refusals and no-ops write none.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
