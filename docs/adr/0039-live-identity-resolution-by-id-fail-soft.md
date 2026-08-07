# 0039 — Display identity resolved live from `auth` by id, never denormalised — fails soft, in explicit contrast to the fail-closed authorization path in the same service

**Date:** 2026-08-07
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`estimai-api` stores only opaque `sub`s (`Estimate.userId`, `EstimateCollaborator.userId`).
Once estimates are visible across users (ADR-0036), the UI must render a human-readable
identity for the owner of a shared estimate and for the "last modified by" field of a version
conflict (ADR-0038) — a raw cuid is meaningless to a collaborator.

AC-10.5 makes the requirement precise: when an estimate's owner account has been
soft-deleted (specs/006, ADR-0012), the UI must render a clear, non-crashing placeholder
("Former wellD member" or equivalent) — **never blank, never an error, never a raw
identifier, and never stale/misleading identity information that implies the account is
still active**. That last clause is the crux: a name is not merely a lookup, it carries a
truth claim about the account's current status, and that claim must be **current**, not
whatever was true when the estimate was created — potentially months or years before a
collaborator ever looks at it.

## Decision

We will resolve display identity **live**, on every render, from a new `auth` endpoint that
accepts only opaque ids and returns a bounded tri-state result — and we will make that
resolution fail **soft** to a neutral placeholder on any error, a deliberate, explicit
contrast to `estimai-api`'s only other `auth`-calling path (adding a collaborator, ADR-0035),
which fails **closed**.

1. **Two candidate sources, one decisively rejected.** Denormalising the owner's name onto
   the estimate at create time is impossible to retrofit onto existing estimates (no such
   column, nothing to backfill from) and — decisively, independent of the retrofit problem —
   it can **never** satisfy AC-10.5: a name frozen at creation time can never express "this
   account was later deleted." A denormalised field is a snapshot; AC-10.5 requires a live
   truth claim. **Rejected**, not merely disfavoured.
2. **`POST /authz/users/identities`** takes **ids only** (1–100, opaque cuids the caller
   already holds from `estimai-api`'s own data — never an email, a name, a prefix, or a
   wildcard) and returns `{ id, status: "active"|"deleted"|"unknown", name }`, with `name`
   populated **only** for `status: "active"`. Accepting ids only, with no search or
   pagination, is the whole security argument: this is explicitly **not** the user-
   directory/search UI specs/004/006 keep admin-only, and a directory-shape contract test
   guards that boundary (rejects a body containing `email`/`name`/`query`/`prefix`, rejects
   >100 ids).
3. **`estimai-api` caches results in-process, keyed by `sub`, 60 s TTL**, and calls the
   endpoint in one batch per list render (distinct owner `sub`s, caller's own excluded) —
   not one call per row.
4. **On failure, `estimai-api` degrades to `status: "unknown"` — never an error, never a
   fabricated identity.** The UI renders three states from this tri-state: `active` → the
   resolved name; `deleted` → "Former wellD member" (AC-10.5's own requirement); `unknown` →
   a neutral placeholder (used both for a genuinely unresolvable id and for any `auth`-call
   failure — the two are indistinguishable to the caller by design, since neither implies
   anything about the account's actual status).
5. **The email snapshot is never resolved live.** The collaborator's `email` column
   (ADR-0036) is a denormalised label by deliberate design — the owner typed it and thinks in
   it, and it remains a stable fallback if identity resolution is degraded. Only `name`/
   `status` are live; email is explicitly the one piece of identity data this feature *does*
   snapshot, and this ADR does not disturb that choice.
6. **Fail-soft here, in deliberate, named contrast to fail-closed elsewhere in the same
   service.** `estimai-api` has exactly two outbound calls to `auth`: adding a collaborator
   (ADR-0035, an authorization decision — an `auth` outage there returns 503, never a silent
   allow) and this identity lookup (a decorative rendering concern — an `auth` outage here
   degrades to `unknown`, never blocking the read). The split is deliberate and load-bearing:
   identity resolution never gates access to anything, so failing it soft costs nothing
   security-relevant, while failing the authorization decision soft would silently let
   ineligible collaborators through.

## Options considered

### Option A — Live resolution by id via a new, capped, id-only `auth` endpoint, fail-soft with a tri-state result (chosen)

Described above.

**Pros:**
- The only option that can satisfy AC-10.5 at all: only a live query against `auth`'s
  current `deletedAt` state can express "this account is deleted **now**," regardless of
  when the estimate or grant was created
- Costs nothing on the availability of the estimate's core read/write path — an `auth`
  outage degrades cosmetically (a neutral placeholder), never blocks opening, editing, or
  saving a shared estimate (reaffirming ADR-0036's decision that `estimai-api`'s hot path has
  no hard `auth` dependency)
- The id-only, capped, non-searchable contract makes this endpoint structurally incapable of
  being repurposed as a directory/search feature, closing off a scope-creep path before it
  opens
- In-process 60 s caching plus one batched call per list render bounds the added load on
  `auth` predictably

**Cons:**
- A 60 s cache means a just-completed account soft-deletion can render as "active" for up to
  a minute after the fact — a small, accepted staleness window
- `estimai-api` now depends on `auth`'s availability for a *rendering* concern in addition to
  its one authorization concern (ADR-0035) — two different failure postures to the same
  upstream service, which a future contributor must keep straight
- Batching per list render, not per estimate, means a page rendering many distinct owners
  still issues one call per distinct `sub` set — bounded, but not zero, cost per render

### Option B — Denormalise the owner's name onto the `Estimate` row at creation time (rejected)

Store `ownerName` (and similarly a collaborator's display name) as a column, set once when
the estimate/grant is created, read directly with no external call.

**Pros:**
- Zero runtime dependency on `auth` for rendering — always available, always fast, no cache
  invalidation to reason about

**Cons:**
- Cannot be retrofitted onto the estimates that already exist in production — there is no
  historical name to backfill from at all
- Cannot satisfy AC-10.5 under any circumstance: a value written once at creation time is, by
  construction, incapable of ever reflecting a *later* account status change — this is not a
  staleness trade-off to be tuned, it is a category mismatch between what the mechanism can
  express and what the requirement demands
- Rejected outright, not weighed against Option A on cost/benefit — it fails the acceptance
  criterion structurally

### Option C — Fail closed on identity-resolution failure (return an error, block the render) (rejected)

Treat an `auth` outage during identity lookup the same way ADR-0035 treats one during
collaborator addition: refuse the request rather than degrade.

**Pros:**
- Consistent, single failure posture across every `estimai-api → auth` call — one rule,
  easier to reason about in isolation

**Cons:**
- Identity display is decorative, not an authorization decision — the estimate's content,
  access level, and every mutating capability are entirely unaffected by whether a name can
  be resolved; failing the whole list/get request closed over a cosmetic concern would take
  down a working feature (opening and editing a shared estimate) for a reason that has
  nothing to do with the caller's actual access
- Directly contradicts the plan's explicit design intent that `estimai-api`'s core read/write
  path acquire no hard dependency on `auth` at all (ADR-0036) — this option would introduce
  exactly the dependency that decision was written to avoid, for the lowest-stakes call in
  the whole feature
- Rejected: the "one rule for everything" simplicity is not worth breaking working
  functionality over a display concern

### Option D — Client-side (browser) resolution directly against `auth`, bypassing `estimai-api` (rejected)

Have `estimai-ui` call `auth`'s identity endpoint directly with the user's own JWT, instead
of `estimai-api` proxying the call server-side.

**Pros:**
- Removes one hop and one server-side cache layer; `estimai-api` need not talk to `auth` for
  this purpose at all

**Cons:**
- `estimai-ui` does not itself hold the list of owner/collaborator `sub`s to resolve until
  after `estimai-api`'s own response has already returned them — the client would need a
  second round trip regardless, just moved to a different tier
- Splits identity-resolution logic (and its 60 s caching, batching, and fail-soft
  degradation) across two codebases instead of one, doubling the surface that must implement
  the tri-state/fail-soft contract correctly
- Rejected: no material benefit over server-side resolution, and it duplicates logic that
  belongs in exactly one place

## Consequences

**Positive:**
- AC-10.5 is fully satisfiable, including the deleted-account case, because the source of
  truth is always queried live — no stale/misleading identity information can ever be shown
  by construction
- The two `estimai-api → auth` call sites now have clearly differentiated, individually
  justified failure postures (ADR-0035's fail-closed for an authorization decision; this
  ADR's fail-soft for a rendering concern) rather than one blanket policy applied
  indiscriminately to two structurally different kinds of call
- The id-only contract cannot be abused as a directory/search feature even if a future
  caller tries — it structurally cannot answer "who is this email" or "list users matching
  X," only "what is the current status of this exact id I already hold"

**Negative / trade-offs:**
- A 60 s cache window means identity displays can lag reality by up to a minute — acceptable
  for a cosmetic concern, but a real, named staleness bound that must not silently grow
  (e.g. if a future change raises the TTL "for efficiency" without re-checking against
  AC-10.5's intent)
- `estimai-api` now has two different resilience behaviours toward the same upstream
  dependency, which increases the cognitive load of reasoning about `auth` outages overall —
  a future engineer must know *which* call they're looking at before predicting its failure
  mode
- Batched-per-render calls to `auth` add load proportional to distinct owners/collaborators
  shown per page — bounded by the ≤100 id cap, but not zero, and not visible in
  `estimai-api`'s own request latency without correlating logs across both services

**Risks:**
- **The 60 s cache masks a just-deleted account briefly.** A viewer opening a list moments
  after an owner's account is soft-deleted could see the stale "active" name for up to the
  cache window. Mitigation: accepted as a bounded, small window; not treated as a defect.
  A future stricter freshness requirement would need to shorten or remove the TTL, trading
  cache efficiency for tighter accuracy.
- **Fail-soft degrading to `unknown` is indistinguishable from a genuinely unresolvable id.**
  A caller cannot tell "auth is down right now" from "this id doesn't exist in auth's
  database" — both render the same neutral placeholder. Mitigation: this is intentional (the
  UI has no actionable difference to offer for either case), but it does mean an `auth`
  outage is invisible to end users beyond a slightly degraded, still-fully-functional UI —
  operational monitoring of `auth`'s health must not rely on `estimai-api`'s identity display
  as a signal.
- **A future caller of `POST /authz/users/identities` misuses the batch cap.** If a future
  feature needs to resolve more than 100 distinct identities in one render (unlikely given
  no per-estimate collaborator cap exists, per spec Non-goals, but a page listing many
  estimates each with many collaborators is conceivable at scale), the cap forces multiple
  round trips or partial degradation. Mitigation: named here as a scaling consideration, not
  addressed — the cap exists specifically to bound the endpoint's abuse potential
  (Directory-shape contract test) and should not be raised without re-evaluating that
  boundary.

## Compliance notes

- GDPR/nLPD impact: low — the endpoint returns only a name and a coarse status for an id the
  caller already legitimately holds (they are already the owner or a collaborator on the
  record referencing that id); no email, search capability, or bulk directory access is ever
  exposed. `status: "deleted"` itself carries no additional personal data beyond what
  specs/006's soft-delete mechanism already establishes as visible elsewhere in the suite.
- Data residency: unaffected — both `auth` and `estimai-api` are EU-region; the call is
  EU-to-EU, and no identity data is persisted by `estimai-api` beyond the 60 s in-process
  cache (never written to a database or log).
- Audit trail: not applicable — this is a read-only display lookup, not a mutation or an
  authorization-relevant decision.

This decision depends on ADR-0012 (soft-delete, `deletedAt`, and the resource-server posture
of "doing nothing at delete time" that this ADR's live query relies on to reflect current
status) and is deliberately posed in contrast to ADR-0035 and ADR-0014's fail-closed
authorization postures — the split those two ADRs establish (authorization fails closed;
decoration fails soft) is the organizing principle this ADR applies to `estimai-api`'s second
`auth`-calling path.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
