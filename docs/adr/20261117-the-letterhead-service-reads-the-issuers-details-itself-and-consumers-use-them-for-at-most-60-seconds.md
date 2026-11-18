# 20261117 — The letterhead service reads the issuer's details itself (content version 2, `entityData` ignored, one version pinned per document), and a consumer uses the registry's answer fresh for 30 seconds and, when the registry fails, for 60 seconds at most

**Date:** 2026-11-17  
**Status:** Accepted — approved plan of specs/20261117-legal-entities (approved 2026-11-17); owner decisions OQ-3 (60 seconds), OQ-5 (details still sent are ignored, not refused), OQ-6 (no document when the registry cannot be read) and the constraint that the letterhead service reads the details itself. Supersedes the "caller sends the values" part of specs/20261116-letterhead-service (amendment D1). Plan ADR candidate ADR-2. Point 3 (the pin) and point 4 amended 2026-11-18 by ADR 20261118-a-pin-ahead-of-the-held-version-forces-one-registry-refresh-at-most-once-a-second-and-100-times-in-10-minutes-per-process-and-any-other-mismatching-pin-is-answered-409-at-once (a pin at or below the held version is answered 409 at once; only a newer pin forces a refresh, at most once a second and 30 times in 10 minutes per process; `crm-api` waits 1.1 s before its single retry, T72). The decision otherwise stands.  
**Deciders:** Matteo Codogno (product owner)  
**Project:** operai

---

## Context

The letterhead design (specs/20261116-letterhead-service) has the caller send the issuer's values (`entityData`) with every render: AC-6.3 ("the values are sent by the caller; the service looks nothing up, keeps nothing"), AC-8.5 (the configurator's sample entity data) and AC-10.10 ("crm-api sends … the entity's profile values"), and its plan refuses `contentVersion: 2` (test of AC-1.8). specs/20261117-legal-entities makes the registry in `auth` the one source of those values (ADR 20261117-legal-entity-registry-in-auth-is-append-only-versions-immutable-in-the-database) and requires that the letterhead service read them itself (owner constraint). Three facts shape how:

- A push to `main` redeploys every changed service in no guaranteed order (ADR 20261110-activities-migration-write-pause, Context). A new `crm-api` that stops sending details, talking to an old `letterhead-api`, would produce documents printed **without** an issuer, because the old service prints missing values as nothing and refuses nothing.
- `crm-api` prints the issuer in the body (`[EMITTENTE]`, `[INDIRIZZO]`), in the stored snapshot and on the classic pdf-lib path; `letterhead-api` prints the frame. Each reads the registry through its own cache, so for up to 60 seconds they can hold different versions and print two versions in one PDF (plan R8).
- Both now depend on `auth` for making a document (plan R7). The owner's answers bound the staleness (AC-3.3: a change is used by every tool within 60 seconds) and the failure behaviour (AC-5.5: nothing is printed with details older than that).

## Decision

We will make the letterhead service take the issuer's details from the registry through a service client of its own, and never from the request: `contentVersion` 2 means "the issuer's details are the service's", versions 1 and 2 are both accepted, and in both `entityData` is accepted and discarded. A document is made from one version of the details: content v2 carries an optional `legalEntityVersion`, a mismatch answers 409 and the caller retries once. Every consumer of the registry (`crm-api`, `letterhead-api`) holds one cache entry per process, fresh for 30 seconds, usable for at most 60 seconds when the registry cannot be read, and refuses to make a document after that.

(Plan, Key decisions 6, 7 and 8; API contracts; Sequences "Consumer read" and "Render".)

1. **Content version 2.** `CONTENT_VERSION` is the set {1, 2}. `entityData` is parsed with v1's existing structural check, so a request valid yesterday is valid today (AC-5.2: ignored, not refused), then dropped before the job is built. `crm-api` sends 2 with no `entityData`. The one log line gains `legal_entity_version` and `entity_data_ignored`. A version outside the set (0, 3 and above) answers 422 `unsupported_content_version`.
2. **Why bump a version when the body barely changes.** So the skew fails closed. An old `letterhead-api` receiving v2 answers `unsupported_content_version`, and `crm-api` answers 503 `layout_service_unavailable`: no document, rather than a document without an issuer.
3. **The pin.** v2 carries an optional `legalEntityVersion`, the version `crm-api` used for the body and snapshot. `letterhead-api` refreshes if its entry is older; if it still differs, it answers 409 `legal_entity_version_mismatch` with `currentVersion`. `crm-api` drops its cache entry, re-reads, rebuilds the content and retries **once**; a second mismatch is `layout_service_unavailable`. Success answers carry `legalEntityVersion` (preview JSON member; PDF header `Legal-Entity-Version`); new snapshots record it. *(Amended 2026-11-18 by ADR 20261118-a-pin-ahead-of-the-held-version-forces-one-registry-refresh-at-most-once-a-second-and-100-times-in-10-minutes-per-process-and-any-other-mismatching-pin-is-answered-409-at-once: only a newer pin forces a refresh, at most once a second and 30 times in 10 minutes per process; an older or equal pin is answered 409 at once without a registry call; `crm-api` waits 1.1 s before its single retry, T72. The 409 / retry-once contract stands.)*
4. **Cache rule.** One entry per process (the list of both entities), stamped with the monotonic time the request was **sent**. Age under 30 s: used. Otherwise refreshed (single flight, 5 s timeout, no redirects, body at most 64 KiB). Refresh fails and age at most 60 s: the old entry is used and `registry_stale_used` is logged. Refresh fails and age over 60 s: 503 `legal_entities_unavailable` with `Retry-After: 5`, no document. A 401 from the registry drops the cached service token and retries once. `auth` answers `Cache-Control: no-store`; admin-ui reads live. The 30 s is the suite's existing tolerance (`/authz/resolve` cache, `letterhead-api/api/src/authz/resolve.rs`).
5. **Proofs.** AC-3.3: a document started at t > T + 60 uses an entry whose request was sent at ≥ t − 60 > T, so `auth` read the table after the save committed at T. AC-5.5: nothing older than 60 s is ever used.
6. **The configurator preview is not a document.** With the registry unavailable it still renders, every placeholder in the `missing` look, and answers `issuerDetails: "unavailable"` (AC-5.5 is about documents). With the registry available it prints the real details, and an empty value prints its label in the `missing` look with its conditional segment kept (AC-5.4).
7. **Credentials.** `letterhead-api` gets `SERVICE_CLIENT_ID` and `SERVICE_CLIENT_SECRET`; the secret stays in the supervisor, workers' environment is already cleared at spawn; the token client has the same rules as `crm-api`'s `serviceTokens` (cached, refreshed 60 s before expiry, single flight, no redirects, nothing logged).

## Failure shape

**Two parties each print part of one artifact from their own copy of a shared fact, so one artifact can show two versions of the fact, or show none.** Which party chooses the fact is the second half: when the caller supplies the identity that is printed, the caller can print any identity (a forgery surface), and when it stops supplying it, a receiver that does not know that prints nothing and says nothing. The failure is silent in both cases: no error, a plausible PDF, the wrong or missing issuer.

Where else this shape appears:

- **Sender and receiver.** The caller's copy (body, snapshot, classic path) and the service's copy (frame) are the two halves of the document; any new document path in any tool that assembles a body itself and a frame elsewhere has the same split. Recognise it by two reads of one registry inside one request's lifetime without a shared version.
- **Old sender and new receiver, new sender and old receiver.** A change that makes a field optional or removes it is safe only if an old peer refuses it, not if the old peer defaults it. The mirror of this ADR's v2: when a receiver adds a requirement that a sender may not know, a v1 body arriving later must be refused or must carry the old meaning, never be guessed. Check which way the deploy order can go for every contract change.
- **Read and write of the cache.** An entry's age is counted from when the question was **sent**, not when the answer arrived, and a stale entry is allowed only when the refresh failed. A cache that stamps on arrival, or serves stale because it is convenient, can use details older than a save that committed before the document started.
- **Fail open and fail closed.** "Registry unreachable" is a document without issuer in a design that prints what it has, and a refusal in this one; a preview, which is not a document, may degrade visibly. Decide per output, and say which.
- **Stale entry beyond its bound, retry loops.** A retry after a pin mismatch is once; an unbounded retry turns a registry change into a render storm.
- **Other consumers.** The next tool that prints the issuer (refunds, inventory, a contract generator) inherits the cache rule and the pin, not a cache of its own invention.

## Options considered

### Option A — Letterhead service reads the registry; content v2; `entityData` discarded; version pin; 30 s / 60 s cache in each consumer (chosen)

Described above.

**Pros:**
- A caller can no longer choose the issuer printed on a document (an anti-forgery gain, flagged to the security review)
- Skew between deploys fails closed
- One document is one version of the details, with a single retry as the repair
- Staleness has a proof, in terms of when the request was sent

**Cons:**
- `auth` becomes a dependency of document making: a registry outage longer than 60 s stops offers and renders (R7)
- A new service client, secret and env-doctor link for `letterhead-api`
- A v1 request no longer renders what its `entityData` said (v1's byte-for-byte promise for a stored request no longer holds for the issuer's text; the pages of old layouts are untouched, ADR 20261116-a-letterhead-version-pins-its-layout-and-old-layouts-stay-compiled-in)

### Option B — Keep content v1 only, `entityData` ignored (rejected)

**Pros:**
- No version bump, no new error

**Cons:**
- During skew, a new `crm-api` and an old `letterhead-api` produce documents with no issuer, silently

### Option C — A capability probe before each render (rejected)

**Pros:**
- Detects an old service without a new content version

**Cons:**
- An extra call per render that still races the deploy

### Option D — `crm-api` keeps sending the details, read from the registry (rejected)

**Pros:**
- The letterhead service stays stateless, as in AC-6.3

**Cons:**
- Contradicts the owner constraint that the service reads them itself; the caller would still choose what prints

### Option E — Different cache rules (not chosen)

- No cache (a call per document): doubles the dependency on `auth` for every render
- A longer stale window: breaks AC-3.3 and AC-5.5 as the owner accepted them (OQ-3, OQ-6)
- Printing the last entry whatever its age (OQ-6, rejected by the owner): a document with details older than the bound

## Evidence

- Planned, not yet run (plan, Test strategy): AC-3.3 with a fake monotonic clock (age 29 s used without a call, 31 s refreshed, and a property test over send and answer times that a document started at T + 60.001 never uses an entry sent before the save at T); AC-5.2 (v1 with `entityData` "EVIL SA" prints the registry's name, never "EVIL"; `crm-api`'s request body has no `entityData`); AC-5.5 (entry age 59 s used, 61 s or none: 503 `legal_entities_unavailable`, no worker job, no partial body, and `crm-api` stores no offer); AC-6.2 (a pin mismatch retries once and never prints two versions in one PDF); each deploy pairing in the switch push (plan R5) as a B-int test.
- The shared fixture `specs/20261117-legal-entities/fixtures/legal-entities.json` is consumed by `auth`'s serializer test and by both clients' tests, so the answer shape cannot drift between them.

## Consequences

**Positive:**
- A document prints one version of the issuer's details everywhere it appears, or is refused
- A change in the registry reaches every tool within 60 seconds
- A tool added later reads the registry the same way

**Negative / trade-offs:**
- A 60 s `auth` outage stops offers and renders; logged `registry_stale_used` and `legal_entities_unavailable` make it visible
- The cache bound, the pin and the retry are logic duplicated in a TypeScript and a Rust client, pinned by the shared fixture
- The letterhead spec's ACs 6.3, 8.5 and 10.10 and its plan's test of AC-1.8 are superseded; that spec must say so so its QE does not test against them (R13)

**Risks:**
- **`specs/20261116-letterhead-service` is still in progress on the same files** (`blocks.ts`, `letterhead-api/*`). Start the `letterhead-api` and `crm-api` tasks after that branch's open tasks are merged (R13).
- **Real details longer than the 40-character fit check** can make every render of an entity fail (`footer_overflow`, `crm-api` 409 `letterhead_overflow`, R9). The preview now uses real details, so the designer sees it; it is not blocked at registry save, which would make `auth` depend on `letterhead-api`.
- **`LETTERHEAD_SERVICE_ENABLED` is `false` in production today**; nothing here depends on it, and if it is on by the release, v2 keeps the skew safe.
- **An old `crm-api` sending v1 with `entityData`** keeps working and is ignored: it prints the registry's details, not its own.

## Escalation triggers

This decision is revisited when any of these happens:

- a registry outage over 60 s stops documents in production and the owner wants a longer bound or a different failure behaviour (AC-3.3 and AC-5.5 are owner decisions);
- a third consumer of the registry is added: it uses these rules, and the shared fixture grows a client test;
- a content version 3 is needed: the same skew analysis applies, and it must also fail closed on an old service;
- the letterhead service is given another source of issuer-like data that a caller sends today.

## Compliance notes

- GDPR / data-protection impact: low. The details are a company's; the contacts line may name a person or a direct number. Service tokens are never logged; the one log line gains only the version and a flag, not a value.
- Data residency: compliant; no new third party, and both services and `auth` stay in the suite's existing EU deployment (Railway `europe-west4` for `letterhead-api`).
- Audit trail: not required by this ADR. The version printed is recorded in the offer snapshot and in the PDF header, so a document can be traced to the version of the details it used.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
