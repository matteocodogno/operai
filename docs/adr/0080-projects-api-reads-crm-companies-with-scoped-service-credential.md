# 0080 — projects-api reads CRM companies with a scoped service credential (`crm.companies.read`) through crm-api `GET /system/companies`

**Date:** 2026-11-03
**Status:** Accepted (specs/025-projects, tasks.md § Architecture notes "Decided here"; taken at rigor `mvp` without an architect — review before merge)
**Deciders:** wellD
**Project:** Operai

---

## Context

A client project belongs to one CRM company, and a `saas` project's contracts name any CRM company
(specs/025, D5, D24, D25). `projects-api` stores only the CRM's company id (a text cuid, no
foreign key across services). Two things need the company itself:
- every project row, contract and project page shows the company **name**;
- a manager creating a project or a contract must **pick** a company, and the write must know the
  company exists.

The users of the project module may hold no `crm:access` at all: OPS does not (D13, ADR-0079),
and `crm-api` answers `403` on every route without it (ADR-0052). So the read has to work for
people who are not allowed to read the CRM.

The suite already has a service-to-service channel. `auth` mints a 5-minute RS256 service JWT
from `POST /system/service-token` (ADR-0044) — `sub = system:<client>`, `aud = SERVICE_AUDIENCE`,
one scope per capability (ADR-0049) — and `notify-api` verifies it on its `/system/*` routes. Until
now it carried only pushes and emails. This is the first time it carries a data read between two
tools.

## Decision

1. **`auth` gains the scope `crm.companies.read`** in `KNOWN_SERVICE_SCOPES`
   (`auth/src/system/serviceClients.ts`), and the `SERVICE_CLIENTS` entry `projects-api` holds it
   and no other. One scope per capability (ADR-0049); `sub = system:projects-api`, so every call
   is attributable and revoking the channel is removing that entry.
2. **`crm-api` adds `GET /system/companies?q=&ids=&limit=`** (`crm-api/src/system/`), the first
   `/system/*` route on that service. It is not behind `authorized`: no user, no `crm:access`,
   no entity scope. Its only guard is a middleware copied from notify-api's system auth, which
   accepts exactly one credential, `Authorization: Bearer <service JWT>`:
   - RS256 through the suite JWKS, issuer pinned, `aud = SERVICE_AUDIENCE` (never
     `AUTH_AUDIENCE`, so a user JWT is never a system credential), `sub = system:<client>`, and
     the route's scope in the `scope` claim;
   - **every** failure — no credential, any JWT defect, a user JWT, another scope, `SERVICE_AUDIENCE`
     unset — returns the same `401` body; nothing but the jose error code is logged, and an
     accepted call logs only the caller's `sub`.
3. **What the route returns, and how much.** `{ items: [{ id, name, entity, archived }] }` by name,
   and nothing else about a company (no contacts, deals, owner or money).
   - `q`: case-insensitive substring of the name, **non-archived only** — the picker;
   - `ids`: comma-separated, 1–64 characters each, at most 100 (more is `400`), **archived
     included** — a project must still name a company that was archived later; ANDed with `q`;
   - `limit`: 1–50, default 20, or `ids.length` when `ids` is given without one, so a lookup of a
     page's companies is never silently truncated.
4. **`projects-api` calls as itself** (`projects-api/src/lib/crm.ts`): its service-token provider
   (cached, single-flight, a `401` drops the cached token), a 5-second timeout, batches of 100
   ids, and no token or response body in any log. It needs `CRM_INTERNAL_URL`,
   `SERVICE_CLIENT_ID` and `SERVICE_CLIENT_SECRET` (all three or none); `crm-api` needs
   `SERVICE_AUDIENCE`.
5. **An unanswered question is handled per path, not once.**
   - **Reads fail soft.** A company the CRM cannot answer for, or no longer knows, is
     `CompanyRef { id, name: null }`; the project list and page still render.
   - **Writes that must confirm a company fail closed.** Creating a project with a company,
     creating a contract and the company picker answer `503 crm_unavailable` when `crm-api` cannot
     be reached. A company that does not exist, **or is archived**, is `422 company_not_found`:
     an archived company is readable by id but is not something new work may point at.
   - The picker, `GET /companies?q=`, needs `project:manage` (any entity): only someone who can
     create a project needs to choose a company, and a reader sees names through the projects.

## Failure shape

**A service needing a narrow fact that belongs to another permission domain, and getting it by
widening the domain instead of narrowing the channel.** The three usual ways: borrow the caller's
own credential (it works only for callers who already hold the other domain's rights, and fails —
or is "fixed" by granting those rights — for exactly the people the feature exists for); hand a
whole population the other domain's access so the question stops failing; or copy the data so it
never has to be asked, and own a stale copy with weaker rules. The opposite hazard comes with the
cure: a service credential answers *for anyone who can reach the calling service*, so the route it
opens is itself the access policy — whatever it returns, every user of the caller can see.

A second, quieter failure lives on the same edge: **an outage handled identically on every path.**
A read that dies because a decoration is missing, or a write that goes ahead on an id it could not
verify, are the same mistake made in opposite directions.

Where else this shape can appear, in the mirror-image position:
- **The other direction.** `crm-api` reading project data (a deal page showing its project,
  specs/026) is the same edge reversed: its own scope, its own `/system` route on `projects-api`,
  never the user's token forwarded, never a grant of `projects:access` to CRM users.
- **Other kinds of reference by id.** A deal, an estimate, a user: whichever tool owns the thing,
  ask who may ask, exactly which fields leave, and what the caller does when no answer comes.
- **Read and write.** Decide per path what the worst outcome of a missing answer is: a blank name
  is a degraded read; a persisted reference to something unverified is corruption, so the write
  refuses. The same split applies to *archived, deleted or renamed* targets: reading them by id
  still has to work, new work may not point at them.
- **A route that accepts two kinds of credential.** One that takes both the user's token and the
  service token turns one into the other. Keep the two audiences apart, and make every refusal
  look the same.
- **Recognise it** by the sentence "I need some data from a tool whose users are not my users".

## Alternatives considered

- **Forward the user's JWT to crm-api.** Rejected: it fails by design for the people the module is
  for. An OPS user without `crm:access` would get a 403 on every project row, and `crm-api` rejects
  a user JWT on `/system/*` regardless.
- **Snapshot company names in projects-api.** Rejected: a copy goes stale on rename (ADR-0039's and
  ADR-0053's reasoning), and the picker would still need the CRM's list.
- **Grant OPS `crm:access`.** Rejected: it widens CRM reads — companies, contacts' personal data,
  deals — to people who need a name, and contradicts D13 (the project module's users are not the
  CRM's).

## Consequences

- **Positive:**
  - A project-module user sees company names with no CRM access, and the CRM exposes four fields
    to one named principal, revocable on its own, instead of a new reader role.
  - The CRM's own routes, permissions and tests are unchanged.
- **Negative:**
  - `crm-api` gains its first `/system/*` route and a `SERVICE_AUDIENCE` it must set, different
    from `AUTH_AUDIENCE`. Its verifier is a copy of notify-api's minus the origin binding, so it
    is not covered by `scripts/check-shared-copies.ts` and can drift from it.
  - `projects-api` now depends on `auth` (to mint the token) and on `crm-api` at runtime: reads
    degrade to `name: null`, and a write that names a company is refused while either is down.
  - Every `project:manage` holder can search the names of all active CRM companies of both
    entities through `GET /companies`, whether or not they hold `crm:access`. That is deliberate
    and limited to id, name and entity.
- **Risks:**
  - Each further capability on this channel — specs/026 adds a deals scope — is a new scope in
    `KNOWN_SERVICE_SCOPES` and a new route behind it. It must not widen `crm.companies.read`,
    which only ever answers the four fields above.
  - The configuration is optional and all-or-nothing in projects-api, so a deployment can start
    without it and show every company as `null`. `tools/env-doctor` checks that the three
    variables are set together and that `projects-api`'s `SERVICE_CLIENTS` entry carries the scope.
