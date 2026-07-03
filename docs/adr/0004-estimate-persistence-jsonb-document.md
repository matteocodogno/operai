# 0004 — Estimate persistence: JSONB document + denormalised listing columns

**Date:** 2026-07-03  
**Status:** Accepted  
**Deciders:** wellD  
**Project:** Operai — EstimAI

---

## Context

Spec 001 requires server-side persistence of EstimAI estimates. An estimate is a
whole document: `{ params, releases, acts }` (model parameters, release milestones,
and activities). Spec 001 explicitly rules out granular sub-resource endpoints for
releases, activities, or epics in this iteration — estimates are saved and retrieved
as atomic units. The list view (AC-2.1) must show each estimate's name and last
modified date without parsing the full document. A per-estimate size guard (AC-1.4)
must reject over-large payloads before any write.

`estimai-api` uses PostgreSQL 17 via Prisma 7; Postgres JSONB is the natural fit for
storing a structured JSON document with indexable column projections.

## Decision

We will store each estimate as **one `estimate` row** with a `content` JSONB column
holding the full document (`params`, `releases`, `acts`), and the following columns
promoted out of the document for query efficiency: `name`, `author`, `sizeBytes`,
`userId`, `createdAt`, `updatedAt`. A composite index on `(userId, updatedAt DESC)`
serves the list query. The endpoint contract is whole-document CRUD only; no
sub-resource tables exist.

Round-trip fidelity is defined as **semantic deep-equal**: the value tree returned by
`GET /estimates/{id}` is deep-equal to the value tree sent by the client. Postgres
`jsonb` does not preserve key order or insignificant whitespace, so literal-byte
fidelity is not guaranteed — but it is not required by any acceptance criterion.
AC-1.1 and AC-2.2 depend only on values (the estimation model reads fields, not byte
positions), and the test strategy asserts deep-equal on `content` explicitly.

The per-estimate size guard enforces `MAX_ESTIMATE_BYTES` (default 1 MiB = 1 048 576
bytes, measured as the UTF-8 byte length of the serialised `content`) before any
write. Rejection returns `413 Payload Too Large` (RFC 7807 Problem JSON). There is no
count quota — the number of estimates per user is unlimited (spec 001 non-goal,
decided 2026-07-02).

## Options considered

### Option A — JSONB document + denormalised listing columns (chosen)

One `estimate` table. `content` JSONB stores the full document. `name`, `author`,
`sizeBytes`, `userId`, and timestamps are top-level columns.

```prisma
model Estimate {
  id        String   @id @default(cuid())
  userId    String
  name      String
  author    String   @default("")
  sizeBytes Int
  content   Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId, updatedAt(sort: Desc)])
  @@map("estimate")
}
```

**Pros:**
- List query (`GET /estimates`) reads only indexed columns — no JSON parsing on the
  hot path
- Ownership filter (`WHERE userId = $sub`) is a fast indexed equality predicate
- Size guard reads `sizeBytes` (a plain integer) without touching `content`
- Schema evolution is cheap: adding a field to the document requires no migration if
  the UI is the authoritative shape; Prisma's `Json` type is schemaless at the DB
  level
- Matches the spec's whole-document semantics exactly — no impedance mismatch
  between the API contract and the storage model

**Cons:**
- Querying or indexing individual fields inside `content` (e.g. filtering by release
  name) requires JSONB operators and a partial index — more complex than a normalised
  column
- Deep-equal fidelity (not byte-faithful) must be understood and documented; any
  future consumer that requires literal serialisation must switch `content` to `text`

### Option B — Fully normalised tables: estimate / release / activity / epic (rejected)

Separate tables for each entity, joined on read.

**Pros:**
- Full SQL query power over every field (filter by release, activity, epic)
- Referential integrity enforced at the DB level

**Cons:**
- Granular sub-resource endpoints are an **explicit non-goal** in spec 001; normalised
  tables would add significant schema and query complexity for a capability that is
  explicitly deferred
- Save and load are now multi-table transactions (estimate + N releases + M activities
  per save); the whole-document contract must reconstruct the nested tree from flat
  rows on every read
- Schema migrations are required for every structural change to the estimate model
  (e.g. adding a field to an activity), whereas JSONB absorbs shape changes silently
- Rejected: complexity not justified by any requirement in this iteration

### Option C — `text` column for literal-byte fidelity (rejected)

Store the serialised JSON as a `text` column instead of `jsonb`.

**Pros:**
- Guarantees byte-for-byte round-trip: the exact string sent by the client is stored
  and returned unchanged (key order, whitespace, number formatting all preserved)

**Cons:**
- No AC requires literal-byte fidelity; AC-1.1 and AC-2.2 are satisfied by semantic
  deep-equal, which JSONB provides
- `text` gives up all JSONB capabilities (GIN indexes, `->` operators, future partial
  queries on document fields) for a guarantee that nobody asked for
- Rejected: not needed; noted as the path to take if a future requirement changes
  the fidelity definition

## Consequences

**Positive:**
- Trivial round-trip: `POST` stores the client document verbatim; `GET` returns
  `content` as-is from Prisma's `Json` field — no transform layer
- List and ownership queries are fast index scans; JSONB is never parsed for them
- A future granular-endpoints spec can add normalised tables alongside this one
  without touching the existing CRUD surface
- The 1 MiB size guard (configurable via `MAX_ESTIMATE_BYTES`) bounds abusive or
  accidentally huge payloads while comfortably accommodating real estimates (hundreds
  of activities sit well under 100 KB)

**Negative / trade-offs:**
- Deep-equal fidelity (not byte-faithful) must be documented in tests and in this
  ADR; engineers must not assume key order is preserved
- If a future requirement needs to query inside `content` (e.g. "show all estimates
  containing a release named X"), a JSONB partial index or a normalised column
  extraction will be needed — not a blocker, but a known future cost

**Risks:**
- **JSONB normalisation surprises:** Postgres may coerce numeric types (e.g. trailing
  zeros on floats). Mitigation: the AC-1.1 integration test asserts semantic
  deep-equal on the full `content` tree including all numeric fields; any coercion
  is caught at test time, not in production.
- **Future literal-fidelity requirement:** If a downstream consumer (e.g. a diff or
  audit tool) needs exact byte-for-byte round-trip, the `content` column must change
  from `Json` to `String` (mapped to `text`) in a Prisma migration. This is a
  one-migration change; it is noted here so it is not "discovered" as a surprise.
- **Last-write-wins across tabs/devices:** Two concurrent editors of the same
  estimate will overwrite each other silently. This is the spec's accepted behaviour
  (non-goal, decided 2026-07-02) — not a defect, flagged here so it is not later
  treated as one.

## Compliance notes

- GDPR/nLPD impact: medium — `content` contains project-level effort and pricing
  data (PII-adjacent commercial data for regulated-sector clients). The JSONB column
  must not appear in application logs; only `id`, `userId`, `name`, and `updatedAt`
  may be written to structured logs. The `hono/logger` in `estimai-api` must log
  method/path/status only (no request body)
- Data residency: the `estimate` table must reside in an EU region (Railway EU);
  this is a deployment constraint, not a schema constraint — enforced at deploy time
- Audit trail: not required for this iteration; `createdAt` and `updatedAt` columns
  provide a basic timestamp trail if needed later

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
