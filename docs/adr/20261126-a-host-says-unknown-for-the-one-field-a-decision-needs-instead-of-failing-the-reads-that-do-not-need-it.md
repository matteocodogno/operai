# 20261126 — A host says unknown for the one field a decision needs, instead of failing the reads that do not need it

**Date:** 2026-11-26  
**Status:** Accepted — approved plan of specs/20261126-teams (approved 2026-11-26 at the plan gate); decision D3 of the plan, and AC-5.4 of the approved spec. Plan ADR candidate A2. **Amends ADR 20261110-activities-service-access-delegated-to-host** (the rule for what a host's `resolve` answer may say about a listing host's `assignees`); the old file is not edited.  
**Deciders:** Matteo Codogno (product owner), at the plan gate; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20261110-activities-service-access-delegated-to-host (amended here), ADR 20261104-meeting-host-contract-resolve-and-notices (the meeting host's `hostVisible`, where an absent field means "not granted"), ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route (hours-api asks the owner for bookability; a booking on an unknown answer is refused), ADR 20261126-teams-live-in-auth-grant-nothing-and-their-members-and-app-access-are-read-from-auth-by-the-consumer-as-itself (the team read whose failure produces the unknown answer), ADR 20261105-meetings-transcript-completeness-detect-retry-mark (a missing part is named, never shown as nothing), ADR 20260807-live-identity-resolution-by-id-fail-soft (a label may degrade where a grant may not), ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-the-deadline-of-the-consumer-and-what-triggered-it-is-derived-by-the-provider-never-claimed-by-the-caller (the 800 ms host-path wait of plan D16 sits strictly inside the consumers' 2 s deadline).

---

## Context

A project's people are now computed from more than its own rows: the project manager, the listed members, and the active members of its attached teams who hold Projects access (specs/20261126-teams AC-4.4, AC-4.7). The team members come from auth, and auth can fail. The spec requires two different behaviours for that failure. A decision that needs the people must be refused as unavailable and never answered from the listed members alone (AC-5.4). A page that only shows work must still load (AC-5.4, second half).

Two consumers call a host's `POST /activity-host/v1/resolve` for a list of projects. My tasks lists tasks across up to 25 projects in one request, and activities-api must not hide any task because one project's team read failed. A task assignment, however, needs the list of people a task may go to. Under the rule of ADR 20261110-activities-service-access-delegated-to-host, a host answer that is malformed or incomplete makes the whole host unavailable (503 `host_unavailable`, for every item of that host in the call). Before this change, the wire schema of `assignees` on a listing host was `z.array(...).optional()`, so a `null` was malformed, which made the whole host unavailable. Failing the batch for one project's team read would hide up to 24 other projects' tasks. Answering the listed members alone would violate AC-5.4. A third option, a plain `false` in a boolean, would be silent: for the meeting host, an absent `hostVisible` already means "not granted" in meetings-api, so a `false` cannot say "unknown".

## Decision

We will let a listing host say **unknown for one field of one item**, and make every consumer refuse only the decision that reads that field.

1. **`assignees: null` on an item is a valid answer.** For a host whose registry entry declares `assignees: host_list` (projects), an item may carry `assignees: null`, meaning "could not find out who is on this project right now". The rest of the item (state, `may`, label, href) is answered normally and the batch stays 200. The field remains required on such a host: `undefined` (absent) is still malformed and makes the host unavailable, because absence is not an answer.
2. **A list is a list, `null` is not one, and `[]` is nobody.** Three wire shapes, three states: an array is the answer, `null` is "unknown", absence is "malformed". No consumer may treat `null` as an empty list, as "nobody", or as the listed members alone.
3. **Only the decision that reads the field refuses.** activities-api refuses an **assignment** (create, reassign to a new person) on a `null` answer with 503 `host_unavailable`. hours-api refuses a **booking** on a project with a `null` answer with 503 `host_unavailable`. Reads proceed: My tasks lists the task, the task page opens, labels resolve, and an unchanged resend of an assignee already on the task is accepted, as AC-3.7 of specs/20261110-activities already allows.
4. **Where the answer's type cannot express "unknown", the host answers 503 for the whole call.** A boolean whose absence means false (meeting-host `hostVisible`) is never given a `false` it cannot back up. meetings-api's resolve answers 503 `teams_unavailable` when the caller is neither the project manager nor a listed member, the project has attached teams, and their members are unavailable. A caller who is a listed member or the manager is answered without a team read.
5. **Unknown is a per-item state on a per-field basis, not a per-host one.** It does not widen the authority of anyone: the host still answers `reader: false` without reading its items (as before), and a non-reader gets no team read and learns nothing.

**Amendment to ADR 20261110-activities-service-access-delegated-to-host.** Its Decision says that any timeout, non-2xx, malformed or incomplete answer, "including an auth outage behind the host", is 503 `host_unavailable` for the call. For a listing host's `assignees` only, that rule is refined: a `null` on an item is a complete, well-formed answer that says "unknown" for that item's assignees, and it is no longer treated as malformed. Everything else in that decision stands, including the 503 for every other malformed or incomplete answer, the 404 for a missing item, and the "named as unavailable, never shown as no items" rule of its Failure shape, which now applies per field as well as per host. Its registry, its `activity host contract: 1` and its Consequences are unchanged. The consumers that read `assignees` change in the same release wave (see Delivery in the plan): activities-api and hours-api accept `null` as unknown before projects-api emits it.

**Contract version.** This is kept at `activity host contract: 1`, not a v2 path. The change is additive for the consumers in use, because a consumer that predates it fails closed on `null` (its schema rejects it, so the host is unavailable, the answer it gave before). The deploy order makes this safe: activities-api and hours-api ship first (plan step 2.1), and projects-api starts sending `null` only after they accept it. This is a judgement of the architect, recorded here so a reviewer can contest it; if a consumer that fails open on `null` is ever added, this judgement is void and the change needs a v2 path.

## Failure shape

**A component cannot answer one part of a question, and the one answer it can give is made to stand for the whole: either a failure of one part hides every other part that was answerable, or the part it does not know is rendered as a value that reads as a fact (an empty list, a `false`, "nobody").** Both are the same defect on the same field. The first hides work that was fine. The second is worse: a decision that was refused is quietly taken, or a person is shown as not on a project who is on it, and the difference is never seen, because "could not find out" and "found: none" look alike in the data.

Where else this shape appears, including the mirror positions:

- **Listing and deciding on the same field.** A list (My tasks, a project's tasks, a search) shows what it has and marks the rest. A decision made from the same field (an assignment, a booking, a read-or-not gate) refuses. The two consumers of one `assignees` field must not share a reading of `null`. The read path that renders an unknown as "no one" is this shape.
- **Batch and item.** One item's unknown must not become the batch's failure, and a batch's failure (non-200, a malformed body) must not be rendered as a set of items that are simply missing. Recognise it when a loop over many ids returns early on the first defect, or when a `missing` item is produced by a failed read.
- **Absent, null and empty.** Three wire shapes are three states: absent (a broken answer), `null` (unknown), `[]` (nobody). A parser that accepts all three as "an array" collapses them. The same applies to a boolean: `false` is a fact, and a boolean that is only absent when unknown is the meeting-host shape to refuse.
- **Write and read of the same fact.** A write that checks a fact from a field the host could not answer must refuse, not fall back to the last list it saw. A resend of an unchanged value is the mirror: it asks no new decision, and it must be a deliberate, named exception.
- **Every future third-party field.** Any host field that depends on another service (a team's members, a deal's owner, a meeting's readers, an estimate's figure) is a field that can be unknown. Recognise it by asking, for each such field: what does a consumer do with `null`, with absence, and with `[]`, and which decision reads it?

## Options considered

### Option A — `null` per item for the one field, refuse only the decision that reads it (chosen)

Described above.

**Pros:**
- My tasks and the task page keep working through a team-read outage, and the unknown is visible per project
- Assignments and bookings still refuse rather than guess (the fail-closed posture of ADR 20261110 and 20261112 holds for every decision)
- The rule is one rule on one field, and it is testable at the consumer's boundary (`null` → 503 on the decision, 200 on the read)

**Cons:**
- Each consumer gets a third state to handle, and the UI must say so (the task form shows that some team members could not be loaded)
- The schema of a listing host's `assignees` changes from a required array to a nullable one, which is a wire change in two services (activities-api, hours-api)

### Option B — 503 for the whole batch when one project's team read fails (rejected)

**Pros:**
- One rule, no new state, nothing for a consumer to misread

**Cons:**
- One project's team read hides up to 24 other projects' tasks from My tasks, for a failure that concerns only the assignment of people on that one project
- The failure is paid by every reader of every project, not by the decision that needs the list

### Option C — Answer the listed members alone when the team read fails (rejected)

**Pros:**
- Something is always shown, and the answer is never empty

**Cons:**
- AC-5.4: a decision is never "answered from the individual members alone". A team-only person would be refused a task or a booking for a reason that is not true, and a listed person could be treated as the whole team
- It is a guess dressed as a partial answer

### Option D — A `hostVisible: false` (or an empty `assignees`) for an unknown answer (rejected)

**Pros:**
- No schema change; every consumer already handles a boolean or an array

**Cons:**
- A false that means "I could not find out" is the silent answer the spec forbids: a team-only reader would lose meeting access with no cause shown, and a booking would be refused as "not on project" when the truth is "unknown"
- For the meeting host, absence already means "not granted"; it cannot carry a third state, so the host answers 503 instead (Decision point 4)

### Option E — A new contract version (v2) for the field (rejected for now)

**Pros:**
- Makes the change explicit on the wire and in the registry

**Cons:**
- Every consumer would have to be pinned to a version for a change that every deployed consumer already fails closed on; a v2 path doubles the contract for one nullable field
- It is kept as the answer if a consumer is ever found that fails open on `null` (see the contract-version paragraph above)

## Consequences

**Positive:**
- A team-read outage degrades the pages that only show work and refuses only the decisions it affects, per project
- An unknown answer is representable on every listing host field that depends on another service, and the rule for it is written once
- The consumers' tests can pin the three states (array, `null`, absent) at their boundary

**Negative / trade-offs:**
- activities-api and hours-api each change a parser and a decision guard; projects-ui must render the unknown note (AC-5.2, AC-5.4)
- A reader of the activity host contract must know that `assignees` may be `null` on a listing host, and that `null` is never a list

**Risks:**
- **A consumer treats `null` as `[]` (the rendering of an unknown as nobody, in the Failure shape above).** Mitigation: the boundary tests named in the plan (AC-5.1: a booking on `null` → 503, AC-5.2: an assignment on `null` → 503 on create and reassign and 200 on list, AC-5.4: the activity host with `null` for a project with teams and the listed set for one without). A reviewer checks any new `assignees` read for a `null` branch.
- **A consumer deployed before the change fails open on `null`.** The judgement above rests on every consumer failing closed today. Mitigation: the deploy order (activities-api and hours-api first, projects-api after) and the check that both schemas reject `null` before projects-api can send it.
- **An unchanged resend of an assignee after the person left the team is accepted while the answer is `null`.** This is the existing rule (AC-3.7 of specs/20261110-activities) and it is intended: nothing about the person changes, and the task keeps its assignee. A change of assignee is refused.
- **A team read that is slow rather than failed.** *Amended 2026-11-27 (plan D16):* the host path waits at most `TEAMS_HOST_WAIT_MS` (800 ms) for a team read, and 800 ms plus a 1 s margin stays strictly inside the 2 s resolve deadline of activities-api, meetings-api and hours-api (ADR 20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-the-deadline-of-the-consumer-and-what-triggered-it-is-derived-by-the-provider-never-claimed-by-the-caller.md; a cross-package test relates the constants). A read still running at the wait counts as failed for that call: an entry of at most 60 s is used, else `assignees: null` (meeting host: 503 `teams_unavailable`), for projects with attached teams only. The read itself is not aborted, and its answer fills the cache for the next call. *Amended 2026-11-27:* a cold permission check against a slow auth is bounded too: the host waits at most 500 ms (`HOST_AUTHZ_WAIT_MS`) for it, then answers 503 inside the deadline, and the resolve, not aborted, fills the permission cache for the retry (ADR 20261119-on-demand-outbound-work-…, amendment 2026-11-27). The whole call is unavailable only when the caller's permissions cannot be known in time, which is the fail-closed answer, never a guess.

## Escalation triggers

This decision is revisited when any of these happens:

- a consumer that fails open on `null`, or a second listing host whose field a consumer reads as a list without the state, is added: the contract needs a v2 path (Option E);
- a host field whose unknown cannot be represented per item (a boolean whose absence means false, as meetings' `hostVisible`) is needed for a decision that has no 503 fallback: the host must refuse the whole call, and that is a change to the decision, not a new `null`;
- the rule is needed by a decision other than assignment and booking (for example a notice or an export that reads `assignees`): that decision refuses on `null` by the same rule, and the list of decisions is updated here.

## Evidence

Implemented. The tests that pin it, each at its boundary:
- projects-api, the D16 host-path wait (800 ms, `TEAMS_HOST_WAIT_MS`) and the constants relation to the 2 s resolve deadline: `projects-api/src/lib/teams.budgets.cross-package.test.ts` and `projects-api/src/projects/teams.hostWait.test.ts`.
- activities-api host client (`null` from a `host_list` host is a per-item unknown, a `null` from a host that does not list assignees stays `null`, a non-reader's items are not read): `activities-api/src/hosts/client.test.ts`.
- activities-api assignment guard and list (`assertAssignable` on `null` → 503 `host_unavailable` on create and on reassign, 200 on list, on an unchanged resend and on an edit naming no assignee): `activities-api/src/activities/assignable.test.ts`.
- hours-api booking on `null` → 503 `host_unavailable`, labels still resolve: `hours-api/src/targets/bookability.test.ts` (and the `null` read in `hours-api/src/clients/projects.test.ts`).
- projects-api (AC-5.4: `assignees: null` for a project with teams whose members are unavailable, the listed set for a project without): `projects-api/src/activity-host/activity-host.test.ts` and `projects-api/src/projects/teams.test.ts`.
- meetings-api's host contract, through projects-api (503 `teams_unavailable` for a caller who is neither the manager nor listed, the manager and listed members answered without a team read): `projects-api/src/meeting-host/meeting-host.test.ts`.

- *Amended 2026-11-27 (commit ae033cea):* the host permission wait (500 ms, single flight per `(sub, perm_epoch)`, a late resolve fills the cache): `projects-api/src/auth/authz.middleware.test.ts` (new) and `crm-api/src/auth/authz.middleware.test.ts` (new), and the extended `projects-api/src/activity-host/activity-host.test.ts` and `projects-api/src/meeting-host/meeting-host.test.ts`.

No named test is missing.

## Compliance notes

- GDPR / data-protection impact: none new. The field carries the same people as before, and an unknown carries no person.
- Data residency: compliant; no new hop.
- Audit trail: not required by this decision. Refused assignments and bookings are refused like any other host-unavailable answer, as the existing contracts already log.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
