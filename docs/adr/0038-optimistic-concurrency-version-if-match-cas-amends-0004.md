# 0038 — Optimistic concurrency via integer `version` + required `If-Match` CAS — amends ADR-0004, supersedes its last-write-wins acceptance

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

ADR-0004 (spec 001) accepted last-write-wins as the concurrency posture for estimate saves,
explicitly recorded as a Risk ("Two concurrent editors of the same estimate will overwrite
each other silently. This is the spec's accepted behaviour... not a defect"). That acceptance
was scoped to a single-writer world: one owner, at most editing from two of their own
devices/tabs.

Spec 013 (US-4) deliberately introduces multiple simultaneous writers to the same estimate
document — an owner and one or more `editor` collaborators can now all save the same record.
This makes silent clobbering a real, foreseeable, and much more likely failure mode, not an
edge case. AC-4.1 requires a save be refused (not silently overwritten) if the record changed
since the saving user last loaded or saved it; AC-4.3 requires exactly one of two simultaneous
saves win, never a silent partial merge; AC-4.4 requires the *same* detection apply to a solo
owner's second tab — closing the very scenario ADR-0004 had accepted, uniformly, for every
save from this point forward, not only true multi-collaborator saves.

## Decision

We will add an integer `version` column to `Estimate`, require an HTTP `If-Match` precondition
on every `PUT`, and enforce it with a single-statement compare-and-swap (CAS) —
**superseding spec 001's accepted last-write-wins Non-goal and the LWW clause of ADR-0004**,
for every write, while leaving ADR-0004's persistence shape (whole-document JSONB, listing
columns, 1 MiB size guard, semantic deep-equal fidelity) entirely untouched.

1. **Mechanism.** `version Int @default(1)` on `Estimate`, incremented on every successful
   write. `PUT /estimates/{id}` **requires** an `If-Match: "<version>"` header; the write is
   one statement: `UPDATE … WHERE id = $1 AND version = $2 AND <access predicate> SET
   content = …, version = version + 1`. Postgres serialises two concurrent updates against the
   same row; exactly one matches `version = $2`, the other's affected-row count is 0 (AC-4.3).
   No partial merge is possible because the document is written whole, unchanged from ADR-0004.
2. **`If-Match` is REQUIRED, not optional.** An absent or malformed precondition returns
   `428 Precondition Required`, never a silent fallback to unconditional last-write-wins.
   AC-4.4 demands detection on *every* save, including a solo owner's second tab; if the
   precondition were optional, a mixed old-client/new-client fleet (some tabs sending
   `If-Match`, some not) would reintroduce exactly the clobber this feature closes, for
   whichever tab happened not to send it. Making it mandatory is the only way the guarantee
   holds uniformly.
3. **Denial precedence.** `count === 0` after the CAS is disambiguated by a fresh
   `resolveAccess`: no relationship → 404; insufficient level → 403 (ADR-0037); otherwise →
   `409 estimate_version_conflict`, carrying `currentVersion`, `updatedAt`, and a best-effort
   `lastModifiedBy` identity (ADR-0039). Access is evaluated **before** the conflict is
   reported, so a stranger's probe — even one carrying a guessed `If-Match` value — can never
   elicit a 409 that would confirm the record's existence or current version; it always gets
   404 first.
4. **Deployment consequence, accepted.** A browser tab already open when the rollout begins
   has no `version`/`If-Match` support yet; its next autosave 428s. Mitigation: map 428 to the
   identical "Reload latest" UX as 409 (self-healing in one click), and ship `estimai-api` and
   `estimai-ui` in the same release window (plan Risk R2).

**Rejected preconditions, and why:**
- **`updatedAt` as the precondition.** Millisecond/microsecond granularity mismatch between
  Postgres `timestamptz` and an ISO-8601 JSON round trip makes equality comparison fragile —
  a value truncated in transit silently never matches, turning every save into a false
  conflict; two saves inside the same tick are indistinguishable regardless. Rejected on
  correctness, not preference.
- **An opaque content-hash ETag.** Costs a full content read plus a hash computation on every
  write and buys nothing an integer counter doesn't already provide.
- **`expectedVersion` in the JSON request body.** Functionally workable, but conflates a
  transport-level precondition with the domain payload and forfeits the standard HTTP
  428/412 semantics `If-Match` gives for free. Rejected on hygiene, not correctness.

## Options considered

### Option A — Integer `version` + required `If-Match` CAS, single-statement enforcement (chosen)

Described above.

**Pros:**
- Enforcement is a single atomic SQL statement — no check-then-act window, no possibility of
  a partial merge, and Postgres itself (not application code) resolves the race between two
  concurrent writers
- An integer counter is trivially comparable, monotonic, and immune to the timestamp-
  granularity fragility that ruled out `updatedAt`
- Standard HTTP semantics (`If-Match`/`ETag`, `428`) are well understood, give the client a
  precise machine-readable signal, and require no bespoke precondition protocol
- `If-Match` being *required* (not optional) is the only formulation that satisfies AC-4.4
  uniformly — a mixed fleet cannot silently regress to last-write-wins for whichever client
  omits it

**Cons:**
- Mandatory preconditioning is a breaking change for any already-loaded client — the 428
  deployment risk (Risk R2) is real and requires a coordinated release, not merely a rollout
  of `estimai-api` alone
- Every future `PUT`-style write to `Estimate` must remember to carry the CAS predicate and
  increment `version` — a hand-written invariant, not something the schema enforces on its
  own without the application code cooperating

### Option B — `updatedAt` timestamp as the optimistic-concurrency precondition (rejected)

Reuse the existing `updatedAt` column as the `If-Match` value instead of adding a new
`version` column.

**Pros:**
- No new column, no migration — reuses data the schema already has

**Cons:**
- Postgres `timestamptz` precision and an ISO-8601 JSON round trip do not guarantee
  bit-exact equality after serialization/deserialization — a truncated microsecond silently
  never matches the stored value, turning every save into a spurious conflict
- Two genuinely distinct saves landing inside the same clock tick are indistinguishable by
  timestamp alone, defeating the very detection this feature requires
- Rejected on correctness: this is not a stylistic preference, the mechanism is unreliable

### Option C — Opaque content-hash ETag (rejected)

Compute a hash of the serialized `content` on read and write, using it as the `If-Match`
value instead of a counter.

**Pros:**
- Would also detect content drift from a source other than this API, in principle (e.g. a
  hypothetical future direct-DB edit)

**Cons:**
- Requires reading and hashing the full document on every read and every write — real,
  avoidable cost for no benefit an integer counter doesn't already deliver for this feature's
  actual requirement (detecting a version bump, not verifying byte-for-byte content)
- Rejected: strictly more expensive, no additional guarantee needed by any AC

### Option D — `expectedVersion` field inside the `PUT` JSON body (rejected)

Carry the same integer counter, but as a body field rather than the `If-Match` header.

**Pros:**
- Functionally equivalent detection to Option A; no new HTTP semantics to reason about

**Cons:**
- Conflates a transport-level precondition with the domain payload (`EstimateUpsert`),
  muddying what the request body actually represents
- Forfeits the standard `428 Precondition Required` / `412 Precondition Failed` status
  vocabulary HTTP already defines for exactly this situation, in favour of a bespoke
  in-body convention every client and server must independently agree on
- Rejected on hygiene grounds — not incorrect, just a worse-fitting shape for a solved
  HTTP problem

### Option E — Keep last-write-wins, rely on client-side "are you sure" prompts only (rejected)

Leave the server unconditioned; detect potential conflicts heuristically in the UI (e.g.
comparing a locally cached `updatedAt` before prompting).

**Pros:**
- No server-side change at all; ADR-0004 stays fully untouched

**Cons:**
- Directly fails AC-4.1/AC-4.3: the server itself must refuse the write and guarantee
  exactly one of two simultaneous saves wins — a client-side heuristic cannot enforce
  atomicity across two different browser sessions racing the same `PUT`
- A determined or buggy client could always bypass the prompt and clobber regardless
- Rejected: does not meet the acceptance criteria; this is precisely the posture spec 013
  was written to close

## Consequences

**Positive:**
- AC-4.1/4.3/4.4 are satisfied with a single, simple, atomic mechanism — no distributed
  locking, no application-level merge logic, no polling
- The CAS predicate composes cleanly with the access predicate (ADR-0037) inside the same
  statement, so there is no window in which access could change between checking and acting
- ADR-0004's persistence shape is fully preserved — this is a narrow, additive amendment,
  not a rearchitecture; the whole-document JSONB write, the size guard, and deep-equal
  fidelity are all unchanged

**Negative / trade-offs:**
- `If-Match` being mandatory means a deployment-window coordination requirement that did not
  exist before — `estimai-api` and `estimai-ui` must ship together, and any already-open tab
  will 428 once, requiring a reload (Risk R2, accepted and mitigated by mapping 428 to the
  same UX as 409)
- Every future write path to `Estimate.content` (there is currently only one — `PUT`) must
  remember to participate in the CAS; a hypothetical future bulk-update or migration script
  touching `content` directly would silently bypass version tracking unless it's written to
  respect it

**Risks:**
- **Prisma's relation-filter CAS predicate may not compile to efficient SQL.** The
  `updateMany` combines `id`, `version`, and an `OR`-composed access predicate that includes
  a `collaborators: { some: … }` relation filter; Prisma compiles this to a subquery whose
  generated SQL has not been proven at scale (plan Risk R8). Mitigation: the fallback is a
  `$executeRaw` CAS with an explicit `EXISTS`; the very first implementation slice asserts
  the CAS behaviour under the AC-4.3 concurrent test, surfacing any issue immediately rather
  than at integration.
- **428 breaks any tab open before rollout.** Named and accepted above (Risk R2); mitigated
  by UX parity between 428 and 409, and a same-window joint release.
- **This is an amendment, not a superset — future readers of ADR-0004 must be told.** Anyone
  reading ADR-0004 in isolation would still believe last-write-wins is the accepted posture
  for `estimai-api` writes. This ADR is the authoritative correction; ADR-0004 itself is
  **not** rewritten (only amended by cross-reference here), consistent with this repo's
  practice of recording amendments as new ADRs rather than silently editing history.

## Compliance notes

- GDPR/nLPD impact: none beyond ADR-0004's original assessment — this decision changes only
  the write-conflict mechanism, not what data is stored or who can see it.
- Data residency: unaffected — the `version` column lives in the same EU-region `estimate`
  table ADR-0004 already covers.
- Audit trail: not introduced by this decision — a version conflict is not logged or
  persisted beyond the transient 409 response; `lastModifiedByUserId` (added alongside
  `version`) exists only to populate the 409's best-effort `lastModifiedBy` display, not as
  an audit mechanism.

**This ADR amends ADR-0004.** Specifically superseded: ADR-0004's Decision text ("no
duplicate is created... last-write-wins," implicit in its silence on conflict detection) and
its Risks entry "Last-write-wins across tabs/devices... This is the spec's accepted
behaviour... not a defect" are both superseded, for every write, from this feature forward.
**Not** superseded, and explicitly reaffirmed: ADR-0004's persistence shape (one `estimate`
row, `content` JSONB, denormalised `name`/`author`/`sizeBytes` listing columns, the 1 MiB
`MAX_ESTIMATE_BYTES` guard, and semantic-deep-equal round-trip fidelity) — all unchanged.
This decision also depends on ADR-0037 (the denial taxonomy governing what a failed CAS
`count === 0` resolves to) and ADR-0036 (the access predicate embedded inside the same CAS
statement).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
