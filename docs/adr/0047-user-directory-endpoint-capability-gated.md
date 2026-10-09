# 0047 — A list-of-people read is a fact endpoint, acceptable only behind a named capability: `auth GET /authz/users/directory`, gated on `asset:manage`, narrowing ADR-0039 for one audience

**Date:** 2026-10-06
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

Spec `specs/015-hardware-inventory` (US-2, AC-3.7) has an inventory manager assign a hardware
asset to an Operai user and filter the asset list by holder. That means choosing a person from
the suite's users. `auth` offers no such read to anyone but a suite admin: `GET /admin/users`
sits behind `requireAdmin`. The two third-party lookups that exist are each unfit on purpose.
`POST /authz/users/identities` (ADR-0039) is id-keyed, capped at 100, and accepts no email,
name, query or prefix. That is its whole security argument, and a directory-shape contract test
guards it. `POST /authz/app-access-check` (ADR-0035) is a decision endpoint: it answers only
`{eligible}` for one exact email, with byte-identical negatives.

A manager handing over a laptop knows a colleague's name, not reliably their address. The
holder filter and the one-off legacy import's name matching need a **list**, not a yes/no and
not an id lookup. This is the first requirement in the suite for a general "pick a person" read
outside the admin surface. How it is gated fixes how every later consumer will be gated.

## Decision

We will add `auth GET /authz/users/directory`, on the forwarded-caller-JWT model (ADR-0014/
0035: `bearerJwtMiddleware`, no new secret), gated on the caller holding the `inventory`
catalog's `asset:manage` permission, and called directly by `inventory-ui`.

1. **Contract.** Returns `{ users: { id, name: string|null, email, entity: string|null }[] }`:
   active (non-soft-deleted, `deletedAt IS NULL`) users only, sorted by name. There is no
   pagination and no query parameter at wellD's size. There is no address, job title, role or
   any other attribute. Adding a field is a change to this ADR, not a drive-by.
2. **Gate: a named catalog permission, resolved by `auth`'s own resolver.** The caller must
   hold `asset:manage` under **any** entity scope. Otherwise the answer is 403. A soft-deleted
   caller (residual JWT, ADR-0012) is rejected 403 as in ADR-0035. The gate is an **explicit
   allowlist of permissions inside `auth`**. A second consuming app is added to the list
   deliberately. The gate is never loosened to "any app-access holder" or "any signed-in user".
3. **Rate-limited** with the existing `lib/rateLimiter.ts` (`createSlidingWindowRateLimiter`,
   keyed by caller `sub`, 429 + `Retry-After`, same shape as `identities.routes.ts`). It has its
   own env pair, registered in `tools/env-doctor`'s manifest if cross-service. It has no
   response-time floor, because there is no negative to equalise.
4. **Entity scope does not narrow the response.** The endpoint returns users of **both**
   entities even to an entity-scoped manager. A device may be assigned to an employee of either
   company. The entity scope on `asset:manage` constrains which *assets* the manager sees
   (ADR-0015 lineage), not which *people* they can pick.
5. **`inventory-ui` calls it directly** through `shell/session`'s `apiFetch`, following the
   admin-ui to refund-api precedent of ADR-0023. `inventory-api` does not proxy it and keeps no
   copy of the user list. Holder **display names** are still resolved live, by id, through
   `POST /authz/users/identities` (ADR-0039), failing soft to `unknown`.
6. **ADR-0039 stays fully in force for `/authz/users/identities`.** Its id-only, capped,
   no-email contract and its directory-shape test are unchanged. This ADR adds a *different*
   endpoint for a *different*, narrower audience. It does not widen the old one.

## Failure shape

**Data about people, readable as a list, becoming available to a population that has no
business need to enumerate it.** The usual way in is not malice. A "just a picker" read is added
with the gate of the nearest convenient endpoint (every signed-in user, every holder of some
app's access), and the roster of the whole company has quietly become public inside the suite.
A second, quieter route to the same defect is a convenience copy: a consuming service caches or
mirrors the list "so the picker is fast". That copy then has its own, weaker access rules and
goes stale. A third is drift of the response shape, where one more attribute is added "since
we're returning the user anyway".

Where else this shape can appear, including the mirror-image positions:

- **Read and write.** Any endpoint that *accepts* a person-selector for a write (assign,
  grant, invite, share) invites a matching read that lists candidates. The write is gated by
  its own capability, and the candidate read must be gated by that **same** capability, not by
  something broader.
- **Inbound and outbound.** A consumer service that fetches the list and stores it, or logs
  it, has re-created the directory without the gate. Recognise it by a table, cache or log line
  holding names and emails for users who are not that service's own records.
- **Widening the gate versus widening the shape.** Letting a second consumer in by relaxing the
  gate, and adding a field to the response, are the same defect from two directions. The
  population or the attribute set grew without a deliberate decision.
- **Fact versus decision.** When the caller only needs to confirm one known person, a decision
  endpoint (ADR-0035) leaks nothing about the rest of the roster. A list is warranted only
  when the human genuinely has to choose from people they cannot name exactly.

## Options considered

### Option A — A capability-gated list endpoint in `auth`, forwarded JWT, rate-limited, called directly by the UI (chosen)

Described above.

**Pros:**
- Meets the actual need: pick by name, filter by holder, match legacy names
- No new secret and no new trust model; the caller is attributable, so per-caller rate limiting
  works
- The audience is exactly the people with a business need, not a role (admin) far wider than it
- `auth` stays the sole owner of identity data. Nothing downstream holds a copy, so nothing
  goes stale and ADR-0039's live-resolution posture is preserved
- Follows ADR-0028's logic of gating on a specific capability rather than `admin`. Unlike
  ADR-0028, no *new* permission is minted, because the subject here is the same one the holder
  already manages (assets, people who hold them) and `asset:manage` is already specific

**Cons:**
- A first in the suite: a non-admin-readable list of people, with a standing obligation to keep
  the gate and the shape from eroding
- No pagination: acceptable now, a hard limit later (see escalation trigger)
- The picker has a hard runtime dependency on `auth` availability. That is acceptable: the
  assignment itself is already an authorized, `auth`-dependent action, and it fails closed (503)

### Option B — An exact-email decision endpoint in ADR-0035's style (rejected)

**Pros:** returns no roster at all; reuses a proven anti-enumeration pattern.

**Cons:** a manager knows a colleague's name, not reliably their address. The holder filter
(AC-3.7) and the legacy import's name matching need a list, so a yes/no for one exact email
cannot serve them. Rejected because it fails the use case, not because it is a worse design.

### Option C — Reuse `GET /admin/users` (rejected)

**Pros:** exists already; no new `auth` code.

**Cons:** it sits behind `requireAdmin`, so every inventory manager would have to become a suite
admin. That is a far wider grant than the need: roles, departments, invitations, permissions,
all for the sake of a picker.

### Option D — Proxy or cache the list in `inventory-api` (rejected)

**Pros:** the UI talks to one backend; the list could be served without an `auth` call per use.

**Cons:** it is a second copy of identity data that goes stale, which is exactly what ADR-0039
forbids. It also adds a hard runtime dependency and a store of names and emails outside `auth`
that needs its own protection. The picker gains nothing from the hop.

### Option E — Add search/email to `POST /authz/users/identities` (rejected)

**Pros:** no new route.

**Cons:** it would silently widen an endpoint ADR-0039 deliberately kept id-keyed, for all its
existing callers, including `estimai-api` and every future caller with no capability gate. It
would also erase the directory-shape contract test that makes that endpoint safe by structure.

## Consequences

**Positive:**
- Inventory managers can pick a person by name without being admins and without a copy of the
  roster anywhere but `auth`
- ADR-0039's id-only boundary and its contract test remain intact
- Establishes the reusable rule: a list-of-people read lives in `auth`, behind a named
  capability with a business need, with an explicit allowlist that is extended deliberately

**Negative / trade-offs:**
- This is a **deliberate narrowing of ADR-0039's "no email/search" stance, for capability
  holders only.** It is stated plainly so a reader does not take ADR-0039 as an absolute: it
  holds for `/authz/users/identities`, and this ADR is the named, gated exception
- Names and work emails of **all active employees of both entities** become readable by every
  inventory manager, including an entity-scoped one
- Enumeration is bounded by the **capability gate plus the rate limiter**, not by the response
  shape. This is in contrast to ADR-0035, whose negatives are byte-identical so that any
  caller learns nothing. Here a holder is *meant* to learn the roster, so the controls are who
  may ask and how often
- The allowlist and the response shape are a standing maintenance obligation, guarded by a
  contract test that a non-holder gets 403 and the response carries exactly the four fields

**Risks:**
- **Gate erosion.** A later consumer asks for the list and the gate is relaxed instead of
  extended. Mitigation: the allowlist is explicit and a test asserts a signed-in user without
  the permission gets 403.
- **Over-broad grant of `asset:manage`.** Holding it now also exposes the roster. Mitigation:
  it is already a deliberate, admin-assigned manager capability. The grant UI/seed notes should
  say so.
- **Per-instance rate limiting.** In-process, as in ADR-0035; a scale-out of `auth` multiplies
  the limit. Mitigation: named there, shared store is the escalation path.
- **Unpaginated growth.** Fine at wellD's size. **Escalation trigger:** a second consuming app,
  or a user count that makes an unpaginated list unreasonable, revisits this ADR (paging, a
  server-side query, or a different shape) rather than quietly extending it.

## Compliance notes

- GDPR / nLPD impact: medium-low. Names and work emails of all active employees are personal
  data, readable by inventory managers. The use is internal, need-to-know, for a stated purpose
  (assigning company devices), and the audience is limited by an explicit capability. No client
  data, no home address (ADR-0031's address is excluded by contract) and no role or other
  attribute is exposed. Nothing is persisted by the consumers: the list is held in browser
  memory only and not logged.
- Data residency: compliant. `auth` and the consuming UI's traffic stay within the suite's EU
  deployment; no third party is involved.
- Audit trail: not required for the read itself (gated, rate-limited, not a mutation). The
  resulting assignment is `inventory-api`'s own record.

Builds on ADR-0014/0035 (forwarded caller JWT), ADR-0023 (direct UI call to the owning
service), ADR-0028 (gate on a specific capability, not `admin`). It narrows ADR-0039 for one
gated audience, and contrasts with ADR-0035 (decision endpoint versus fact endpoint).

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
