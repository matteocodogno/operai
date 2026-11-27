# 20261126 — Auth's admin writes carry the version they were made against in the body, because auth's CORS exposes no ETag

**Date:** 2026-11-26  
**Status:** Accepted — approved plan of specs/20261126-teams (approved 2026-11-26 at the plan gate); decisions D5 and D6 of the plan, and AC-1.8 of the approved spec. Plan ADR candidate A3 (lower weight). Generalises the choice of the legal-entity registry (ADR 20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database) from that one resource to every mutable row of auth's admin API.  
**Deciders:** Matteo Codogno (product owner), at the plan gate; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004 (the `If-Match` precondition every other service uses, and the rejected `updatedAt` and content-hash alternatives), ADR 20261103-projects-tool-shape-and-authorization (`If-Match` on every project write), ADR 20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database (`baseVersion` and `version_conflict` with `currentVersion`), ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level (the audit of each successful write), ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims (admin writes that touch no permission bump no epoch).

---

## Context

auth's admin API is the first place where two administrators can edit the same row of a suite resource with no protection in the current code: roles and departments accept writes with no precondition at all. The teams feature (specs/20261126-teams) adds a mutable team, a name and a description with an active or archived state, that two administrators can edit at once (AC-1.8: a stale form is refused and nothing is silently lost). The other suite tools protect their mutable records with `If-Match` on an `ETag` (ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004 for estimai-api, ADR 20261103-projects-tool-shape-and-authorization for projects-api, and crm-api and refund-api likewise). auth cannot follow that path from its admin clients. Its CORS configuration allows only `Content-Type` and `Authorization` as request headers, and exposes only `Retry-After` to the browser (`auth/src/index.ts`, the `cors` call). A `If-Match` header from admin-ui would therefore fail the browser's preflight, and an `ETag` on a response could not be read by the page. Widening that CORS policy on the identity service, for one feature, would change the surface of the service that every tool signs in through.

The legal-entity registry already solved the same problem in auth: a save carries `{ baseVersion }` in the JSON body, a stale `baseVersion` is answered 409 `version_conflict` with `currentVersion`, and nothing is written. The plan takes that shape for every mutable admin row of auth.

## Decision

We will make every **mutable** write of auth's admin API carry the version the client read, as a required integer `baseVersion` (≥ 1) in the strict JSON body, and refuse a write whose `baseVersion` is not the row's current `version` with 409 `version_conflict` and `currentVersion`. For teams this is the team's own fields: name, description and state (archive and restore included, D6).

1. **The row carries an integer `version`.** It starts at 1 and is returned in every body of that resource. A change to the team's own fields (name, description, state) increments it. A save that changes nothing is a 200 with no bump and no audit row.
2. **The check is decided by the database in one conditional write.** The update names the row and the version it was read at (`WHERE id = … AND version = baseVersion`), and a write that matches zero rows is the 409. No read-then-write check decides it. Two parallel writes on the same version produce exactly one success (AC-1.8).
3. **The precondition is required on the mutable fields.** A missing `baseVersion` is a 400, never a skipped check. A client that cannot send one gets a refusal, not a last-write-wins save.
4. **Set operations that commute take no precondition.** Adding or removing a member is a set operation: two administrators adding different people do not conflict, and a repeat add or remove is a no-op with no audit row (D6). Where a set operation must count (the 100-member limit), the count is taken under a row lock on the team (D7), not under the version.
5. **No ETag, no `If-Match`, no CORS change.** The body is the only carrier. auth's CORS policy stays as it is.
6. **Every successful write writes one audit row** and no permission changes: no resolver read, no `perm_epoch` bump (AC-2.5).

## Failure shape

**An edit is written over a picture of the record that is no longer true, and nothing refuses it, so the later writer silently overwrites the earlier one's change and neither is told.** The picture can be old because the form was loaded before someone else saved, or because the list the writer read was loaded before a change to one field, or because a state change (archive, restore) is written from a form that still shows the old name. Nothing about the write itself looks wrong; the loss is invisible until someone notices the value is gone.

Where else this shape can appear, including the mirror-image positions:

- **Create, update and state change are all writes.** A protected update is no protection if the archive or restore of the same row is unprotected: a stale archive reverses a restore someone just made. Recognise it when a route that changes a row's state takes no precondition while the route that changes its fields does.
- **Check and write.** A precondition checked by reading the row and then writing is a race that the check loses, however careful the code looks. The database must decide, in the write itself. Recognise it wherever a version is compared in application code before an update.
- **Read and write.** A list or a detail response that does not return the version makes every later write blind: the client has nothing to send. A new admin resource whose responses omit the version is this shape on the read side, however good its write check is.
- **Commuting and not.** A set operation that carries a precondition refuses edits that do not conflict (two admins adding different people). The mirror failure is the opposite: a count or a limit that is decided by a read outside the row's lock lets two writes both pass. Each kind of write needs the protection its meaning needs, and no more.
- **Required and optional.** A precondition that a client may omit is a precondition a stale client will omit. Recognise it when a new admin route accepts a write with no version and writes anyway.

## Options considered

### Option A — A required body `baseVersion`, a row `version`, a conditional update, 409 `version_conflict` with `currentVersion` (chosen)

Described above.

**Pros:**
- Works through auth's existing CORS policy with no change to the identity service's surface
- The same shape as the legal-entity registry, so a second admin resource is a copy of a proven pattern
- The client reads the version from the body it already has, with no header or `ETag` to read
- The conflict body names `currentVersion`, so the screen can show the banner and keep the typed values (AC-1.8)

**Cons:**
- A second convention in the suite beside `If-Match` (estimai-api, crm-api, projects-api, refund-api), so a developer moving between services must learn both
- Every admin client must send the field on every mutable write, and a client that forgets gets a 400 rather than a working save

### Option B — `If-Match` and `ETag`, with the CORS policy widened on auth (rejected)

**Pros:**
- One convention across the suite, and the one the other services use

**Cons:**
- Widens the identity service's CORS policy (`allowHeaders` gains `If-Match`, `exposeHeaders` gains `ETag`) for one feature, on the service every sign-in passes through
- The preflight change is a security-relevant change to a service that the rest of the suite trusts, made for an admin screen

### Option C — No precondition: last write wins (rejected)

**Pros:**
- Simplest; no version to store or send

**Cons:**
- AC-1.8: "no edit is silently lost" is the requirement, and last-write-wins is the failure shape of this record

### Option D — `updatedAt` as the precondition (rejected)

**Pros:**
- No new column; the timestamp already exists

**Cons:**
- Timestamp precision and clock behaviour make two writes in the same instant indistinguishable; ADR 20260807-optimistic-concurrency-version-if-match-cas-amends-0004 rejected it on correctness grounds for the same reason

### Option E — A lock held by the form for the duration of the edit (rejected)

**Pros:**
- No stale write is possible while a form is open

**Cons:**
- A lock across HTTP requests needs a session-scoped state that abandoned tabs never release; it is a worse failure than a refused save

## Consequences

**Positive:**
- A stale form is refused with the current version, and the admin screen can show a reload banner while keeping the typed values
- No CORS change on auth; the admin screens need no ETag support
- Each mutable admin resource in auth follows one rule, so the next one (roles, departments, if they gain edit by form) is a copy and not a decision

**Negative / trade-offs:**
- Two precondition conventions in the suite, and the reader of one must know the other
- Admin clients must carry the version in every mutable call, and a missing version is a 400, so a client change is needed before a route is enabled

**Risks:**
- **A client sends a version it did not read.** A stale or invented version is refused like any stale one. The version is a number per row: it proves the row has not changed since the read, not that the form was loaded for the row in the path. A form loaded for team A and sent to team B, when B happens to be at the same version, is not caught by this ADR; it is a client defect the screen must prevent by keying the form to the id.
- **A route added later skips the version because its meaning seems to commute.** Mitigation: the commuting exception is named in this ADR (set operations, with a row lock where a count is taken), and each exception is a reviewed decision.
- **Two conventions cause a wrong client to be copied.** Mitigation: the conventions are stated per service in AGENTS.md and in each service's plan.

## Escalation triggers

This decision is revisited when any of these happens:

- auth's CORS policy is changed for another reason, in which case `If-Match` and `ETag` become a cheap choice and the two conventions should be merged by a new decision;
- an admin resource needs a precondition that spans rows (a change to several records that must all be at their read version): the single-row conditional update is no longer enough, and the design needs its own decision;
- a suite-wide precondition convention is chosen: this ADR is superseded, and the older ones it sits beside are re-read together.

## Evidence

Planned, not yet implemented at the time of writing. The tests the plan names, to be updated when they land: PATCH, archive and restore with a stale `baseVersion` → 409 `version_conflict` with `currentVersion`, nothing changed, no audit row; a missing `baseVersion` → 400; two parallel PATCHes on the same version → exactly one 200 (AC-1.8); a no-op save → 200, no bump, no audit row; the admin-ui TeamDetail shows the reload banner and keeps the typed values on 409.

## Compliance notes

- GDPR / data-protection impact: none new. The version is an integer on a team row.
- Data residency: compliant. auth is in the suite's EU region.
- Audit trail: required for each successful write, as AC-3.2 of specs/20261126-teams states; refusals and no-ops write none.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
