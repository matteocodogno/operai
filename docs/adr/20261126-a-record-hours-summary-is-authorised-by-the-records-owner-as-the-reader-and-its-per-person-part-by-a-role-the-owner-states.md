# 20261126 — A record's hours are one aggregated read, authorised by the record's owner as the reader; the per-person part follows a role the owner states, never a copy of who holds it

**Date:** 2026-11-26
**Status:** Accepted (decided in specs/20261112-project-hours plan, D-P1 and D-P2; amends ADR 20261112-hours-api-time-entries-own-service-hours-catalog)
**Deciders:** wellD (product owner)
**Project:** Operai
**Relates to:** [ADR 20261112-hours-api-time-entries-own-service-hours-catalog](20261112-hours-api-time-entries-own-service-hours-catalog.md) (amended: a third read of hours), [ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route](20261112-time-bookability-asked-of-owners-meeting-hosts-system-route.md) (the owner is asked as the caller; this applies it to a read), [ADR 20261108-estimai-oversight-permission-amends-0036](20261108-estimai-oversight-permission-amends-0036.md) (the oversight path stays separate), [ADR 20261116-record-hours-widget-through-the-host-extension-seam](20261116-record-hours-widget-through-the-host-extension-seam.md) (the write-side sibling)

---

## Context

A project page and a deal page show the hours recorded on them: a total, a total in a window, hours per work type and,
for some readers, hours per person (specs/20261112-project-hours US-2). Today the only reads of hours are a person's own
entries and the oversight path `whose=all`, held by `time-entry:read-all`. A project manager or a deal owner without that
permission cannot see where the effort went. projects-ui and crm-ui cannot compute it: they do not hold the entries, and
they must not learn who recorded what.

"Who may see a record's hours" is two questions. The total follows the right to read the record. The per-person figure
is personal data about workers and follows a narrower role. Only the record's owner (projects-api, crm-api) knows both
who may read the record and who holds the role on it.

## Decision

We will serve a record's hours from hours-api as **one aggregated read, `GET /time-entries/summary?projectId=` or
`?dealId=`**, to any caller the record's owner says may read the record. hours-api asks the owner **as the caller**, on
every request, and never caches the answer. No other service composes it.

1. **Reading the record is the owner's answer.** hours-api forwards the caller's JWT to the owner's activity-host resolve
   (projects-api for a project, crm-api for a deal). `reader: false` or a missing record is `404 not_found`, identical for
   both. An unreachable or malformed owner answer is `503 host_unavailable`.
2. **Every reader gets** `totalMinutes`, `windowMinutes` and `byWorkType`.
3. **`byPerson` is given only to a role the owner states**, checked in order: the owner's own fact, `projectManagerId ===
   sub` or `ownerUserId === sub`, both added to the owner's existing resolve answer; then, for a caller who is neither,
   a live `time-entry:read-all` check against `auth GET /authz/resolve` (refusals cached 30 s, grants never). A project
   awaiting its manager states `projectManagerId: null`, so only holders see its people.
4. **An auth outage withholds, never guesses.** For a caller who is neither manager nor owner, an unanswered check gives
   `byPerson: null` and `"authz"` in `unavailable`. The total still shows; the people do not.
5. **The answer never carries** entries, notes, meeting ids or titles, activity subjects, amounts, prices or rates. A
   key-set test on the answer type fails the build if one appears.
6. **The host never hides a figure it already received.** The browser got it; the server must be the one that withholds it.

**The rule this records:** a relationship to a record grants a read of other people's data only as far as the record's
owner says so, at the moment of the read, asked as the reader. The service's own credential, a copy of who holds a role,
and a flag from the client do not decide it.

## Failure shape

**A right to read other people's data that comes from a relationship to a record, answered by something other than the
record's owner, asked as someone other than the reader.** The data is correct and the route works; the mistake is whose
authority answers. The read uses a service's own credential, a reader-side copy of the owner's facts, or a flag the client
or a host computes, and the answer shows the data to someone the owner would not have shown it to. The copy drifts when
the owner reassigns a role; the service credential outlives the person who asked; the client's flag is never checked.

Symmetric cases, where the same text must still catch the mistake:

- **Who answers, and as whom.** A service that composes a figure for a user with its own token is the same shape as a host
  that reads with a user's cached rights. On every user-facing read, ask which principal answers and whether it is the one
  the person would be asked as.
- **Total and person.** The coarse and the narrow figure are two reads of the same records. A guard on the per-person
  breakdown on one path (the page) and not another (an export, a total grouped by person, a figure derived from the same
  entries) is the usual gap.
- **Owner's fact, cached.** A reader that keeps `projectManagerId` or `ownerUserId` answers for the old holder after a
  reassignment. Read the role fact with the record, every time, or not at all.
- **Show versus send.** A host that hides a figure it already received protects nothing. Check the server's answer, not
  the screen.
- **Read versus write.** Seeing everyone's breakdown is not writing anyone's entries. Each write path asks its own question
  (ADR 20261116-record-hours-widget-through-the-host-extension-seam covers the write side).
- **Fail closed and fail soft.** A record check or a role check that cannot answer must never become a grant, and must
  never read as "nobody" where "nobody" would hide a total.

Recognise it in any new read of a record's data by someone who is not its owner: a summary endpoint, a dashboard card that
sums others' work, an export of a project's people, a notification that names who worked on something.

## Options considered

### Option A — hours-api serves the summary, asks the owner as the caller, takes the role from the owner's fact (chosen)
Described above.

**Pros:** the owner answers the question it owns, with the reader's token; hours-api holds no copy of who may read a
project or deal; the per-person rule comes in the same call that proves the record is readable; the answer has no
entry-level field.
**Cons:** a synchronous dependency on projects-api or crm-api for every summary, and on auth for a non-manager's per-person
check; the owners must add two facts to their resolve answers first (a deploy order).

### Option B — projects-api or crm-api composes the figure, calling hours-api with a service credential
**Pros:** the page calls one service it already knows.
**Cons:** a user-facing read is served with a service's token, so the service decides what the person may see. This is the
borrowed-authority shape of ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route. Rejected.

### Option C — widen `GET /time-entries?whose=all` to readers of a record
**Pros:** no new route.
**Cons:** mixes the oversight permission (admin by seed) with an ordinary read; returns entries, more than the page shows. Rejected.

### Option D — the host page hides the per-person figure in the browser
**Cons:** the figure reaches a browser that may not see it; the check is on the screen, not the data. Rejected.

### Option E — a host-computed boolean, `may.seePeople`, sent with the record
**Cons:** the rule is time tracking's (ledger D22); a host copy drifts. The owner only states who holds the role, as it
already states `assignees` and `involved`. Rejected.

### Option F — a second GET per summary, `GET /projects/{id}` or `GET /deals/{id}`, as the caller
**Cons:** heavier: projects-api's GET reads CRM company names; crm-api's GET carries the whole deal, money included, for
two facts. Rejected.

## Consequences

**Positive:**
- The per-person figure has one rule, decided on the server from the owner's answer and the reader's own right.
- A reassignment, a removal from a deal or an auth outage takes effect on the next read; there is no stored copy to clean.
- "No entry, note or title leaves hours-api in a summary" is a build failure, not a review item.

**Negative / trade-offs:**
- Every page showing hours waits on the owner and, for a non-manager, on auth. On failure the card says "Hours unavailable"
  (specs/20261112-project-hours AC-2.6).
- hours-api now has three reads of hours (own, oversight, record summary). Each new read answers "who is asked, as whom"
  on its own.

**Risks:**
- **A wrong or late role fact.** Mitigation: the fact is read from the record on every request; a contract test per owner
  asserts `projectManagerId` and `ownerUserId` match the stored row.
- **A consumer caches the summary** and shows a stale per-person figure. Mitigation: `Cache-Control: no-store`; any change
  to that header names this ADR.
- **An auth outage hides people for its duration.** Accepted: a withheld figure beats a guessed one.

## Revisit when

- A third kind of reader needs a per-person figure (for example, a finance role): a new fact the owner states, with its own
  row in the rule above.
- A consumer without a user (an alert job) needs the summary: it has no caller to be asked as, and needs its own decision.
- The summary's latency breaks the page budget (specs/20261112-project-hours R2).

## Compliance notes

- **GDPR / nFADP impact: medium.** The per-person figure is personal data about workers, given only to the project manager,
  the deal owner and oversight holders, and only as far as the owner states. Totals and per-work-type figures carry no
  person. Informing workers stays the open go-live condition of specs/20261112-time-tracking (O3).
- **Data residency:** compliant. EU suite services only; no new processor.
- **Audit trail:** not required by this ADR. Summary reads are not logged per person.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
