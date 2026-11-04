# 0059 — Meeting host contract: `resolve` with the caller's own JWT, and content-free, sequenced `notices` under a new `host-notices.send` service scope

**Date:** 2026-11-04
**Status:** Accepted (specs/021-meetings; plan approved by the user on 2026-11-04, D-2)
**Deciders:** wellD
**Project:** Operai
**Relates to:** [ADR-0035](0035-third-party-app-access-decision-endpoint-forwarded-jwt.md), [ADR-0044](0044-scoped-service-jwt-fourth-notify-caller.md), [ADR-0049](0049-all-notify-callers-scoped-credentials-shared-token-retired.md), [ADR-0014](0014-refund-api-authorization-enforcing-resource-server.md), [ADR-0052](0052-crm-tool-shape-and-authorization.md), [ADR-0058](0058-meetings-tool-shape-visibility-by-participation.md)

---

## Context

A meeting is started from, and may be linked to, an entity in another app: today a CRM deal,
later perhaps a PM project or an HR record (US-11). Meetings needs two things from a host.
First, an answer to "may *this person* open this entity, and may they see host-visible
meetings about it?", which decides whether a link can be made and whether a host reader may
open a meeting. Second, the host wants to be told when a meeting linked to one of its entities
is linked, changed, unlinked or deleted; the CRM logs a `meeting` activity on the deal
(US-14). Meetings must not read host data (AC-11.10), no host may need a Meetings code change
(AC-11.4), and a deleted meeting must leave nothing with a title behind in the outbox
(AC-4.6).

## Decision

1. **A host is data, not a branch.** `meetings-api/src/hosts/registry.ts` holds
   `HostDefinition { app, entityType, baseUrl, labels, offersHostVisible,
   hostVisibleRequirement, notices, recommendedTemplates, contract: 1 }`. Production contains
   exactly `crm/deal`. `MEETINGS_TEST_HOSTS` adds test hosts and is refused at startup when
   `NODE_ENV=production`. `GET /hosts` serves the public part, so the meeting screens render
   any host from data. The CRM and the test hosts go through the same HTTP adapter
   (`hosts/client.ts`), which exports only the two calls below.
2. **`POST {baseUrl}/meeting-host/v1/resolve`**, authenticated with **the caller's own JWT,
   forwarded verbatim** (ADR-0035's model: no new secret, the host applies its own live
   authorization). Body `{ entityType, ids[1..25] }`, answer `{ items: [{ id, state:
   "open"|"closed"|"missing", title?, href?, hostVisible? }] }`. A host answers `closed`, not
   403, so one call answers a mixed batch. Any non-2xx, a 2 s timeout or a malformed body is
   *unavailable*: meetings-api **fails closed for every decision that grants** (create with
   host, relink, host-visible read) and **soft only for display labels** (AC-10.3).
3. **`POST {baseUrl}/system/meeting-host/v1/notices`**, only when `notices: true`,
   authenticated with a **scoped service JWT** (`sub="system:meetings-api"`,
   `aud=SERVICE_AUDIENCE`, new scope **`host-notices.send`**, minted through ADR-0044/0049's
   mechanism; `auth`'s `KNOWN_SERVICE_SCOPES` gains the scope and `SERVICE_CLIENTS` gains a
   `meetings-api` entry with `notifications.push host-notices.send`, never `emails.send`). The
   receiving host checks audience, scope and a `sub` allowlist. The body is strict (any other
   key is a 422): `{ noticeId, seq, event: linked|changed|unlinked|deleted, meeting: { id,
   title, startsAt, creatorId }, entity: { type, id } }`. `title` and `startsAt` are **null for
   `unlinked`/`deleted`** (plan amendment A3). `seq` is monotonic per meeting; the host keeps
   its last seen `seq` and answers `applied:false` for any notice with `seq ≤` that value, so
   duplicates and reordering are harmless (AC-14.9).
4. **Delivery is an outbox row written in the same transaction as the change**, then one
   awaited attempt (5 s) so the response can carry `hostNotice: { state: "failed" }`. Two
   policies:
   - `linked`/`changed` are **manual**: a failure stays `failed`, is shown to the creator as a
     non-blocking warning with "Try again", and is never retried silently (AC-11.9, AC-14.8);
   - `unlinked`/`deleted` are **until delivered**: retried by the job runner (ADR-0062) with
     backoff (1 m, 5 m, 30 m, 2 h, then every 6 h), because a removal must happen even when
     no creator is present to press a button (AC-14.6).
   Delivered rows are deleted; the delete notice's outbox row carries no title.
5. **CRM is the first host.** crm-api gains both endpoints; `resolve` returns `hostVisible =
   canSeeFinancials` (ADR-0054, AC-5.6), and `notices` reconciles one `meeting` activity per
   `meetingId` under an advisory lock (`Activity.meetingId` unique, `meeting_host_state.lastSeq`).
   crm-api trusts the `creatorId` because meetings-api resolved the entity *as that creator*
   in the same request before emitting `linked`.

## Failure shape

**A decision about a person being made with someone else's authority, and a replicated state
being overwritten by an older version of itself.** The first: when service A asks service B
"may this user see X" using A's own credential, the answer describes A's rights, not the
user's, and B's live permission rules (financials, entity scope, deactivation) are silently
bypassed. The second: an event stream delivered without order or identity lets a late
`unlinked` undo a later `linked`, a retry duplicate an effect, and a delete race a re-create.
A third, quieter one: the outbox of a deleted record keeps the record's title alive.

Mirror positions. **Inbound vs outbound:** `resolve` (a question whose answer grants) must
fail closed and be asked as the *user*; `notices` (a state push) must be ordered, idempotent
and content-minimal and is sent as the *service*. Do not swap the credentials: a push with the
user's JWT carries a user's rights to a system action, and a question with a service JWT
borrows the service's. **Grant vs display:** a lookup that decides access fails closed; the
same lookup used for a label fails soft. **Create vs delete:** whatever the host is told on
create, it must be told on delete, and the delete message must carry less, not the same.
Recognise the shape in any future cross-service "tell me / tell them" seam: ask who the
authority is, what happens if the message arrives twice, late or out of order, and what the
queue still holds after the thing it describes is gone.

## Alternatives considered

- **meetings-api reads host data directly** (the deal, its company, its permissions).
  Rejected: AC-11.10; meetings-api would become a second owner of CRM authorization.
- **A shared-secret webhook** for notices. Rejected: unattributable and not scoped; ADR-0044/
  0049 retired exactly this for notify-api.
- **Event delivery without `seq`.** Rejected: reordering breaks relink (an `unlinked` for the
  old deal arriving after the `linked` for the new one).
- **A host-side service credential for `resolve`.** Rejected: the host must apply the *caller's*
  permissions (`deal:financials`, deactivation, `crm:access` lost mid-session), which a service
  token cannot express.
- **Always-silent retry for every event.** Rejected for `linked`/`changed` by AC-11.9: the
  creator is told when the host did not get it and decides. `unlinked`/`deleted` retry until
  delivered because nobody is left to decide.
- **Carry the title on `deleted` and `unlinked`** so the host can log it. Rejected (A3): nothing
  with a title may outlive a deletion (AC-4.6).

## Consequences

**Positive:**
- A second host is a registry entry plus two endpoints; no meeting screen changes (AC-11.4),
  proven by a fake host (`testhost/widget`, `quiethost/gadget`) through the same adapter.
- A host outage blocks only the decisions that grant; labels degrade to "CRM · deal".
- Removal reaches the host eventually without a person.

**Negative / trade-offs:**
- A list of meetings needs one batched `resolve` per host per page (≤ 25 ids, 2 s), a latency
  and availability coupling to the host.
- `resolve` is an existence oracle for deal ids toward non-CRM users. Accepted: ids are
  unguessable cuids and no title leaks to a caller who may not open the entity.
- `auth` gains a scope and a client entry; env-doctor's manifest gains a service-client link
  `meetings-api` with `requiredScopes: ["notifications.push", "host-notices.send"]`.

**Risks:**
- A host that is down for days accumulates `deleted` retries (loud log each time; every 6 h).
- A creator who lost `crm:access` surfaces as a refused link (AC-1.5), not a failed activity.
- Contract versioning is `contract: 1` only; a breaking change needs a v2 path.

## Compliance notes

- GDPR / nFADP: the notice carries `creatorId`, title and date only; no transcript, summary or
  participant data crosses to the host.
- Audit trail: the host's reconciler is idempotent by `meetingId` and `seq`; the notice outbox
  is deleted on delivery.

## Amended 2026-11-04 (design stage)

The registry's public part, served by `GET /hosts`, gains two per-language fields in `labels`:
`visibilityHint` (the sentence next to the host-visible toggle, G6) and `noticeFailed` (the
sentence shown when a `linked`/`changed` notice failed, G7). Both are whole sentences per
language rather than an entity word, so Italian articles and gender work; for the CRM,
`noticeFailed` is exactly AC-14.8's text. The host contract v1 endpoints (`resolve` and
`notices`), their bodies, credentials and delivery policies are unchanged. Source: plan.md
§ Amendments 2026-11-04 (design stage), G6 and G7.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
