# 0088 — Time entries live in their own service, `hours-api`, with a catalog that gives ungated self-service and one oversight permission resolved live only on the oversight path; a single-writer record takes no version precondition

**Date:** 2026-11-12  
**Status:** Accepted (specs/029 plan gate; ledger D21 and D36, decided by the owner; amends nothing, extends ADR-0075's oversight shape to a second tool)  
**Deciders:** wellD (product owner)  
**Project:** Operai

---

## Context

specs/029 records the hours an employee spent on company work: a day, a duration, and what it was on
(a project, a deal, a meeting, or work that is not an entity). Every active user records and reads
their own hours whatever tools they can open (AC-5.1), and an admin or a holder of the new "see
everyone's hours" permission reads everyone's (AC-4.3). The data is personal data about workers, so
the read-everyone grant and the write path must be as narrow as the suite's other personal-data
records. Time entries are written by one person only (AC-1.6), so the concurrency rules that protect
shared estimates (ADR-0038) do not describe them.

The owner chose a separate service over the architect's recommendation of `activities-api` (ledger
D36, 2026-11-12). It keeps the time domain's boundary clean, at the cost of a new service to run and
cross-service reads for the activity pointer and for bookability (ADR-0089).

## Decision

We will store time entries, categories and work types in a new backend service, `hours-api`
(Bun + Hono + Prisma, port 8088, logical database `hours`, Railway EU). It owns those three records and
nothing else. Its access rules are:

- **Catalog.** A new auth catalog `hours` with **no `access` resource**: the feature is ungated
  (AC-5.1). It declares `time-entry:read-all` (see everyone's hours) and `time-list:manage` (create,
  rename and retire categories and work types), both unconditioned and seeded to `admin` only. Neither
  is in `ALL_APP_IDS` or `DIRECTORY_GATE_PERMISSIONS`.
- **Own hours need only a valid JWT.** Every query on an entry is scoped to the verified `sub`; an
  entry that is not the caller's answers 404, identical to a nonexistent one.
- **Oversight is the ADR-0075 shape.** Reads of other people's entries (the global view, its export,
  and `GET` of an entry that is not the caller's) call `auth GET /authz/resolve` with the caller's own
  JWT, and only on that path. A refusal may be cached by `(sub, perm_epoch)` for 30 s; a grant is asked
  for on every request so a revocation applies at once. An `auth` outage answers 503
  `authz_unavailable`, never an allow. No write route accepts an oversight holder: they change nothing
  of someone else's.
- **List management is live and fail closed.** `time-list:manage` is resolved from `auth` on every
  category or work-type write.
- **No version precondition on time entries.** An entry has one writer, its person. Two tabs of the
  same person are last-write-wins. ADR-0038's `If-Match` is not applied to entries.

## Failure shape

**A right to see or change a record being carried by a path, or by a guard, that was built for a
different holder of that right.** Two mistakes recur. First, a privilege for looking at other people's
personal records is wired into the ordinary path, so the common reader now depends on a remote
authority; or a holder of that privilege is treated as an owner because the code tests "may read" where
it should test "is the writer". Second, a guard built for one writer is left out of a record whose writer
set can change. Such a record is single-writer until the first second writer (a manager's correction, an
import, another service) appears, and nothing in the record says so; the guard is then missing exactly
when it is needed. The reverse also happens: a precondition added where no second writer exists turns
every stale tab into a refusal of the person's own work.

Where else the shape can appear, in the mirror positions:

- **Read and write.** An oversight holder's list, detail and export are reads; their write attempts,
  create-on-behalf and deletes are the same permission asked the other way. Each write route must refuse
  the holder with the answer that leaks least (404 for someone else's entry), and a new write route is
  covered only if it goes through the same guard.
- **List and detail and export.** The global view, the detail route and the spreadsheet are three
  readers of the same records. A rule added to one and not the other is the usual gap.
- **Fast path and escalated path.** The `auth` call happens only on the oversight path. A new `auth`
  call on a route that a plain owner uses is this failure returning.
- **Single writer and several writers.** Before adding or removing a precondition, ask who can write this
  record today and who could next month (a manager's correction, an import, a second service, a second
  device that is not the person's). The answer decides whether the record needs one; the answer is not
  read off the route's current callers.
- **Fail-open and fail-closed.** The oversight check and the list-management check fail closed; a
  label or pointer lookup may degrade. A failure on a guard must never turn into a grant, and a failure
  on a label must never turn into a deletion.

## Options considered

### Option A — A new `hours-api` with its own database and the `hours` catalog (chosen)
Described above.

**Pros:** the time domain has one owner and one maintenance switch; no deal, project or category is
forced into a service that is about something else; the read-everyone grant is one unconditioned
permission that an admin can give to another role (ADR-0007); the common path depends on `auth` only
for a JWT and gains no `auth` call.
**Cons:** a new service to provision, deploy and run; every bookability check and every list label is a
cross-service call; the activity pointer is an id resolved on read.

### Option B — Inside `activities-api` (recommended by the architect; rejected by the owner, D36)
**Pros:** no new service; the activity pointer is a local foreign key and deal involvement is a local
query; existing infrastructure is reused.
**Cons:** two domains share one service and one maintenance switch (ADR-0083); the service's "no
permission catalog" rule (ADR-0081) would have to be amended to hold an `hours` catalog; the time domain
would inherit activity-shaped rules that do not fit a duration.

### Option C — Inside `projects-api` or `crm-api` (rejected)
**Pros:** each already holds part of the answer.
**Cons:** a deal has no project and a category has no company; a time entry on an internal activity or
on no entity would belong to nothing. Putting time in either service makes it the owner of a rule about
the other's records.

### Option D — A gated `hours:access` permission (rejected)
**Pros:** a familiar pattern; one more lever for the admin.
**Cons:** contradicts AC-5.1: everyone records their own hours whatever tools they can open, so the
gate would have to be granted to every employee, which is the default grant ADR-0068 warns against for
a permission that widens a directory.

### Option E — `requireAdmin` for list management, and for the read-everyone path (rejected)
**Pros:** no catalog change; the middleware exists.
**Cons:** cannot be granted to another role without making its holder an admin (ADR-0075 option C).

## Consequences

**Positive:**
- An outage of `auth` does not stop anyone recording or reading their own hours.
- Read-everyone is one catalog row that an admin grants or withdraws, with immediate effect.
- Time has one owner; activities, projects and meetings keep their own rules and are only asked.

**Negative / trade-offs:**
- A new service to provision (`infra/provision-tool.sh hours`), add to the env contract
  (`tools/env-doctor`), and deploy in the order auth → activities-api, crm-api, meetings-api → hours-api
  → UIs.
- The activity pointer is an id resolved on read: a deleted activity shows as no pointer while the
  project or deal is readable, and as hidden when it is not. The stored id is never cleared, not even on
  the owner's next write (amended 2026-11-13, specs/029 ledger D47): activities-api omits an id the
  caller cannot read exactly like a deleted one, so clearing on write would drop a live pointer for an
  author who only lost read access. A 503 from activities-api clears nothing either.
- Labels follow the viewer's access: a holder of read-all who cannot read a project sees the entry's
  type, minutes and day, but not its name (spec AC-4.10).
- No version precondition: a person with two tabs can overwrite their own entry from a stale one.

**Risks:**
- **A second consumer of hours data** (the project and deal pages of specs/030 will read totals) reads
  the same records under a different question. Mitigation: one read API, the same guard, and a contract
  test per consumer.
- **A future writer other than the person** (a correction tool, an import, a suggestion accepted on
  another's behalf) makes the single-writer assumption false. Mitigation: that change revisits this ADR
  before any second writer is added.
- **Escalation triggers:** hours needing writes from another service, or a second consumer of totals,
  revisit the service boundary and the read guard.

## Compliance notes

- **GDPR / nFADP impact: high.** Each entry is a daily record of what a named worker spent time on; a
  holder of read-all reads all of them. Only `admin` holds it by seed, and it is revocable at once. The
  labour-law check on informing workers (spec O3, IT art. 4 L. 300/1970, CH art. 26 OLL 3) is open and
  accepted as a risk at approval; it is a go-live condition, not a design one.
- **Data residency:** compliant. Railway EU, a logical database on the suite's Postgres, and calls only
  to EU suite services. No new processor.
- **Audit trail:** not required by this ADR. A lock or approval of recorded hours (spec O4) is open and
  belongs to a later decision; this ADR records no reads of other people's entries.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
