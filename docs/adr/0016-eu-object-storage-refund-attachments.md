# 0016 — EU-region S3-compatible object storage for refund attachments: presigned direct-to-bucket upload, private bucket + short-lived signed GET, two-phase confirm

**Date:** 2026-07-16
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

CLAUDE.md's data residency section is a hard constraint on every Operai backend: "Backend must
deploy to an EU region." Spec `specs/007-refund-service` introduces the suite's first
user-uploaded binary content — receipt attachments on expense lines, which the plan's Security
section identifies as financial documents that may carry PII (names, addresses, card tails).
No existing Operai service (`auth`, `estimai-api`, `notify-api`) stores binary files; all are
pure relational/JSON persistence. `refund-api` must choose a storage mechanism it has never
needed before, ensure it satisfies the same EU-only constraint as its own PostgreSQL database,
and avoid turning receipt bytes into a bandwidth/memory load on a Bun+Hono service whose primary
job is authorization-gated API traffic (ADR-0014/0015). AC-1.3 (removable attachments pre-
submission), AC-6.2 (accounting view/download of attachments), and AC-8.3's decided-request
retention posture all require the file lifecycle to line up with the request lifecycle without
introducing new scheduled-job infrastructure the suite has deliberately avoided elsewhere
(ADR-0013).

## Decision

We will use EU-region S3-compatible object storage, accessed by `refund-api` exclusively through
presigned URLs it mints (POST for upload, GET for download) — never proxying file bytes through
its own request/response cycle — with a two-phase pending/confirm upload lifecycle and no
scheduled cleanup job.

1. **Provider/region.** Primary candidates: AWS S3 `eu-south-1` (Milan) or Scaleway Object
   Storage `fr-par` (best data-residency fit for wellD's IT/CH client base); Cloudflare R2 with
   an EU jurisdiction restriction is the fallback (fits the suite's Vercel/edge-adjacent
   posture). All three satisfy CLAUDE.md's EU hard constraint; the exact vendor is an
   implementation-time choice within this allowlist, not re-litigated per deploy. Configuration
   is via S3-compatible env vars (`REFUND_S3_ENDPOINT`, `REFUND_S3_REGION`, `REFUND_S3_BUCKET`,
   `REFUND_S3_ACCESS_KEY_ID`, `REFUND_S3_SECRET_ACCESS_KEY`), 1Password-sourced, validated at
   startup in `src/lib/env.ts` (`process.exit(1)` on any missing var, the suite's standard
   convention) — plus a startup assertion that `REFUND_S3_REGION` is a member of an explicit EU
   allowlist (plan Risk R8): a misconfigured non-EU region fails fast at boot, never silently in
   production.
2. **Upload — presigned POST, direct-to-bucket, never proxied.** `refund-api` mints a
   policy-constrained presigned POST — `content-length-range` capped at **10 MiB**, an allowed
   `content-type` set (`application/pdf`, `image/jpeg`, `image/png`) — enforced **server-side, at
   mint time, inside the signed policy itself**, so the browser cannot exceed either regardless
   of what it sends. The browser then uploads directly to the bucket; `refund-api`'s own process
   never touches the file bytes. Data residency holds because the browser's direct upload still
   terminates in the EU bucket — routing bytes through `refund-api` first would add nothing to
   that guarantee while adding real memory/bandwidth cost to a service that also serves every
   other authorization-gated route.
3. **Two-phase confirm, no cron.** An `Attachment` row is created `uploadStatus=pending` at mint
   time, holding the object key. The client calls `.../confirm` after a successful browser-side
   upload; `refund-api` HEADs the object to re-validate that its actual size/content-type match
   the recorded metadata (a defense against a client lying about metadata at mint time) and flips
   `uploadStatus=stored`. Only `stored` attachments are ever returned by any read path — a
   `pending` row whose upload never completed (abandoned draft, browser crash) is simply
   invisible, reconciled on read, extending ADR-0013's schedulerless posture to a second,
   structurally similar orphan-record problem: no background sweep flips or deletes orphaned
   `pending` rows; a bucket lifecycle rule independently expires unconfirmed objects on the
   storage side.
4. **Key namespacing:** `refund/{requestId}/{lineId}/{attachmentId}/{sanitizedFileName}` —
   request/line-scoped, built from non-guessable `cuid`s, with no user PII (name, email) embedded
   in the key itself.
5. **Download — signed GET, authz-gated, minted last.** `GET .../attachments/:aid/url` mints a
   short-lived (~60 s) presigned GET **only after** the ownership/entity-scope check
   (ADR-0014/0015) passes — the signed URL is the last step of an already-authorized request, not
   an independent access path. The bucket itself is private, with no public-read grant; the 60 s
   expiry bounds the exposure window of any single signed link (e.g. one accidentally pasted into
   a chat).

## Options considered

### Option A — Presigned direct-to-bucket upload/download, private bucket, two-phase confirm, reconcile-on-read (chosen)

Described above.

**Pros:**
- `refund-api` never becomes a bandwidth/memory bottleneck for file transfer — its own
  request/response cycle only ever handles small JSON metadata payloads and short-lived signed
  URLs, not file bytes
- Data residency is enforced at two independent layers: the bucket's own region, and a startup
  assertion that fails fast on misconfiguration, rather than relying on provisioning discipline
  alone
- Extends ADR-0013's schedulerless-lifecycle convention to a second, structurally similar
  problem (an upload that may never complete, vs. an invitation that may never be accepted) — no
  new cron/queue infrastructure or failure mode for this feature either
- A signed GET is unreachable without first passing `refund-api`'s own authorization logic — the
  storage layer itself adds no independent access-control surface to get wrong

**Cons:**
- The presigned-POST policy is the sole server-side enforcement point for size/content-type at
  upload time; a policy-construction bug (e.g. an overly permissive `content-length-range`) is
  not caught by any other layer until the confirm-time HEAD re-validation — a second, later
  checkpoint, not a first line of defense
- Orphaned `pending` rows and their never-confirmed objects can persist until a bucket lifecycle
  rule or the next read reconciles them — the same low-severity "data hygiene, not correctness"
  trade-off ADR-0013 already accepted for invitations, now also true of attachment metadata
- The final vendor (S3, Scaleway, or R2) is deferred to implementation time — a legitimate
  flexibility, but this ADR pins the constraint set, not the specific provider

### Option B — Proxy uploads/downloads through refund-api (rejected)

Every receipt byte flows through `refund-api`'s own process on the way to/from the bucket.

**Pros:**
- A single code path handles both metadata and bytes, with no separate presigned-URL contract
  for the client to implement

**Cons:**
- Adds real memory/bandwidth load and latency to a service whose primary job is
  authorization-gated API traffic, for no security benefit — the presigned-URL approach already
  keeps the bucket private and gates access at the mint step
- Rejected: strictly worse resource profile with no corresponding security gain

### Option C — Public bucket with unguessable object keys as the sole access control (rejected)

Rely entirely on non-guessable keys, with no per-request signed-URL gate.

**Pros:**
- Simplest possible download path — a stable, permanent URL per object, no expiry to manage

**Cons:**
- "Security by obscurity" on financial documents containing PII is an explicit anti-pattern; no
  revocation mechanism exists if a key ever leaks (a logged URL, a referrer header, a
  copy-pasted link) short of rotating every affected key
- Fails the plan's own Security section requirement for authz-gated download
- Rejected outright on security grounds

### Option D — Store attachment bytes in PostgreSQL (bytea/large object) (rejected)

Persist file bytes directly alongside metadata in `refund-api`'s existing database.

**Pros:**
- One datastore, one backup/restore story, no second provider to configure

**Cons:**
- Couples file-storage growth to the primary transactional database's backup/replication cost
  and size — precisely what object storage exists to avoid
- No EU-residency advantage over a correctly region-pinned bucket, since the database already
  deploys EU under the existing convention
- Rejected: worse operational profile for no residency or security benefit

### Option E — Non-EU or unpinned multi-region storage (rejected)

Use whichever storage tier is simplest/cheapest without a region constraint.

**Pros:**
- None specific to this suite's constraints

**Cons:**
- Violates CLAUDE.md's hard EU-region requirement for a service handling financial/PII
  documents; not a real option given the suite's stated data-residency rules
- Rejected outright, recorded only for completeness

### Option F — A scheduled cleanup job (cron/queue) for orphaned pending uploads (rejected)

Run a periodic sweep to delete `Attachment` rows (and their objects, if uploaded) that never
reached `confirm`.

**Pros:**
- Keeps the `Attachment` table free of stale `pending` rows without relying on read-time
  filtering

**Cons:**
- Introduces exactly the scheduler infrastructure and failure mode (a missed/delayed sweep) that
  ADR-0013 already rejected for a structurally identical problem, for no product-driven benefit
  the reconcile-on-read + bucket lifecycle rule combination doesn't already provide
- Rejected on the same grounds as ADR-0013's Option B

## Consequences

**Positive:**
- `refund-api` stays a thin, low-resource API service — file transfer load lives entirely
  between the browser and the EU bucket
- Data residency is enforced redundantly (bucket region + startup allowlist assertion), not
  left to a single point of failure
- No new scheduler/cron infrastructure is introduced for this feature, consistent with the
  suite's established schedulerless-lifecycle convention (ADR-0013)
- Signed-GET-after-authz-check means the storage layer adds zero independent authorization
  surface — `refund-api`'s own ownership/entity-scope logic remains the single gate

**Negative / trade-offs:**
- Size/content-type enforcement at upload time relies on the presigned-POST policy being
  constructed correctly; a construction bug is only caught later, at confirm-time HEAD
  re-validation
- Orphaned `pending` metadata rows can persist until read-time reconciliation or a bucket
  lifecycle rule catches up — the same accepted low-severity trade-off as ADR-0013
- The final storage vendor is not pinned by this ADR, only the constraint set (EU region,
  S3-compatible, presigned-URL support) any candidate must satisfy

**Risks:**
- **Region drift** (plan Risk R8): a bucket accidentally provisioned outside the EU allowlist
  would silently violate data residency for financial/PII documents. Mitigation:
  `REFUND_S3_REGION` validated against an EU allowlist at startup, `process.exit(1)` on
  violation, matching the discipline every other required env var already gets.
- **Orphaned pending uploads** (plan Risk R4): abandoned drafts leave `pending` rows and possibly
  uploaded-but-unconfirmed objects. Mitigation: reconcile-on-read (only `stored` ever surfaced)
  plus a bucket lifecycle rule expiring unconfirmed objects independently of application code.
- **Presigned-POST policy misconfiguration** could let an oversize or wrong-type upload actually
  land in the bucket even if `refund-api`'s own metadata validation would reject it. Mitigation:
  confirm-time HEAD re-validation (size/content-type checked against recorded metadata, rejected
  on mismatch) as a second, independent enforcement point; adversarial coverage named explicitly
  in the plan's Security section.
- **Path traversal via `fileName`** into the object key (e.g. `../../other-request/file`) could
  let an upload target an unintended key. Mitigation: `sanitizedFileName` in the key template —
  the raw client-supplied `fileName` is never used verbatim in the object key, only stored as
  display metadata; named in the plan's Security section as a reviewed surface.

## Compliance notes

- GDPR/nLPD impact: medium — receipt attachments may contain personal data (names, addresses,
  partial card numbers) per the plan's Security section; storing them in an EU-region private
  bucket with authz-gated, short-lived signed access is the mitigation, consistent with how the
  rest of the suite treats PII-adjacent data at rest.
- Data residency: this decision's core purpose — EU region hard-pinned via an allowlisted env
  var and startup validation, consistent with CLAUDE.md's data residency rules and the existing
  EU deployment posture of every other Operai backend.
- Audit trail: attachment upload/confirm/removal are ordinary application events, not separately
  audit-logged by this ADR; the request-level actions they support (submit, decide) are covered
  by ADR-0018's immutable audit trail. Object retention (a decided request's attachments are
  never deleted) is enforced by application logic — no delete route exists once a request is
  decided — rather than a bucket-level retention lock in this iteration.

This decision builds on ADR-0013 (the schedulerless, reconcile-on-read/write lifecycle pattern,
reused for a second, structurally similar orphan-record problem), ADR-0005/0014 (the
authorization gate that must pass before any signed URL is minted), and CLAUDE.md's data
residency section (the hard constraint this decision satisfies).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
