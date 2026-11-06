# 0060 — The projects hand-off reads between crm-api and projects-api over scoped service credentials, deals read live and never synced

**Date:** 2026-11-04
**Status:** Accepted (specs/022-projects-handoff, tasks.md § Architecture notes "Decided here"; taken at rigor `mvp` without an architect — review before merge)
**Deciders:** wellD
**Project:** Operai

**Amended 2026-11-05** (specs/022 steering, ledger D37–D42, D49; [ADR-0062](0062-terms-and-purchase-order-two-optional-records-of-a-project-contract-retired.md),
[ADR-0063](0063-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047.md)).
The decision to read live over scoped service credentials, and every failure rule below, stand. What changed
is the names, one route and one new channel; the text below is kept as written (it is the record of the
2026-11-04 decision) and reads as follows:

- **"Contract" is "purchase order" (PO).** The scope `projects.contracts.read` became
  `projects.purchase-orders.read` and the route `GET /system/contracts?dealIds=` became
  `GET /system/purchase-orders?dealIds=`, answering `{ items: [{ dealId, purchaseOrderId, project: { id, name },
  bexioOrderId }] }` (a deal with no PO is still absent; still no terms, dates, people, amounts or contact data).
  The old scope is no longer known to `auth`: a `SERVICE_CLIENTS` entry carrying it refuses to start. crm-api's
  entry is now `notifications.push emails.send projects.purchase-orders.read`. The deal page's `delivery` /
  `deliveryKnown` shape is unchanged, so crm-ui was not touched; crm-api reads `purchaseOrderId` instead of
  `contractId`.
- **What a take writes** (Decision 6): the project, its terms **and** its PO in one transaction; the unique
  index that decides a race between two takes is `purchase_order.dealId`. A take is no longer "attach or new
  project": there is no attach (D39), the take needs `handoff:take` **and** `project:manage` for the deal's
  entity (ADR-0063), and the queue is readable by sales and admins only (D37), not by every access holder.
- **The Bexio order id** (Consequences) is now `purchase-order:bexio`, and still readable by every CRM user who
  opens the deal page.
- **A third channel, with personal data: `crm.contacts.read`.** projects-api reads CRM contacts as
  `system:projects-api` through crm-api `GET /system/contacts` (`?companyId=` or `?ids=`, ≤ 20), the same system
  auth as `GET /system/deals` and one explicit shape per mode, to show and validate a PO's referent live
  (ADR-0063). The Compliance note below ("no contact … field crosses either channel") holds for the two channels
  it describes and **not for this one**: contact data flows CRM → projects-api here, never stored, cached or
  logged, and never in the opposite channel (`/system/purchase-orders` carries none).

---

## Context

specs/022 connects the CRM pipeline to the project module (ledger D2, D4, D17): every won deal waits
in a **to-start queue** until a person takes it into a project, the project and its contract then
show the deal, and the CRM's deal page shows the project and the contract's Bexio order id (AC-1.1,
AC-2.1–2.4, AC-3.3, AC-3.4). Two tools that own different facts therefore have to see each other's:
the deal's stage and estimate live in `crm-api`, the contract that took the deal lives in
`projects-api`.

The people on each side are not each other's users. OPS and `accounting` hold no `crm:access`;
CRM users hold no `projects:access` (D13, ADR-0058). A user JWT forwarded to the other service
answers 403 for exactly the people the feature is for, and `crm-api` rejects a user JWT on
`/system/*` regardless (ADR-0059). specs/021 already built the channel in one direction —
`projects-api` reads CRM companies as `system:projects-api` with scope `crm.companies.read`
(ADR-0059, ADR-0044/0049 pattern). Rigor is `mvp` and the user's standing preference on uncertain
designs is the least invasive, easiest-to-change option (D17): no event, no webhook, no change to
any CRM write path.

## Decision

1. **Two new service scopes, one per capability** (`KNOWN_SERVICE_SCOPES` in `auth`, ADR-0049):
   - `crm.deals.read`, held by the `projects-api` client, accepted by `crm-api` `GET /system/deals`;
   - `projects.contracts.read`, held by the `crm-api` client, accepted by `projects-api`
     `GET /system/contracts`.

   Both routes copy `crm-api`'s `src/system/systemAuth.middleware.ts` (ADR-0059): `aud =
   SERVICE_AUDIENCE` (never `AUTH_AUDIENCE`), `sub = system:<client>`, the route's scope in `scope`,
   one identical `401` for every failure, a user JWT never accepted, `SERVICE_AUDIENCE` unset →
   every request is `401`. The guard rides on the route, never on a sub-app `use("*")`. Neither
   route sits behind `authorized`: the credential is the whole access policy, so each returns an
   explicit, narrow `select`.
2. **What each route returns.**
   - `GET /system/deals` takes exactly one of `stage=won` or `ids=a,b` (1–64 characters each, at
     most 100; neither or both → `400`) and answers `{ items: DealSummary[], truncated }`,
     `DealSummary = { id, title, stage, entity, company: { id, name }, wonAt, estimate: { id, name } | null }`.
     **No amount, currency, owner or notes** (D14). `stage=won` is won deals by win date
     descending, **capped at 500** with `truncated: true` beyond (pagination is deferred, A26);
     `ids` returns those deals in any stage, `wonAt` `null` unless the stage is `won`.
   - `GET /system/contracts?dealIds=` (1–100) answers `{ items: [{ dealId, contractId, project: { id,
     name }, bexioOrderId }] }`; a deal with no contract is absent. No terms, dates, people or
     amounts leave the module.
3. **The deal is read live, never synced or evented.** The queue is "deals `won` in the CRM" minus
   "deals that already have a contract here", computed on every `GET /queue`; a contract's "this deal
   is no longer won" notice is the deal's stage read at the time the contract or project is read.
   A reopen, a re-win and a deal that was already won when the module shipped (A26) therefore hold
   by construction (AC-2.1, AC-2.2, AC-2.4): there is no message to lose and no backfill to run.
4. **Each path decides what an unanswered question means.**
   - **The queue fails closed:** `crm-api` unreachable is `503 crm_unavailable` — an empty list
     would read as "nothing is waiting".
   - **A project or contract fails soft:** the deal's `title` and `won` are `null` ("unknown"),
     distinct from `won: false` ("known not won"); the notice shows on `false` only, never on
     `null`.
   - **The deal page fails soft, and says so:** `GET /deals/{id}` gains `delivery` and
     `deliveryKnown`. `deliveryKnown: false` (projects-api not configured, down, refusing us or
     answering nonsense) means *unknown*; `delivery: null` with `deliveryKnown: true` means *no
     project carries this deal*. The UI never renders the first as the second. The read never
     throws, times out after 3 seconds and retries once after a `401` with a fresh token.
   - **Taking a deal fails closed:** `crm-api` unreachable is `503 crm_unavailable` and nothing is
     written.
5. **`crm-api` uses a dedicated token provider for projects-api.** `src/lib/projects.ts` builds its
   own `createServiceTokenProvider` (imported from `serviceToken.ts`, whose shared region is not
   edited) instead of the module-level `serviceTokens`, which exists only when the notifier is
   configured; the deal page must not depend on notify. Consequently `SERVICE_CLIENT_ID` and
   `SERVICE_CLIENT_SECRET` are now a pair **required with either `NOTIFY_INTERNAL_URL` or
   `PROJECTS_INTERNAL_URL`**, and refused alone — they are no longer tied to notify. The same client
   entry in `SERVICE_CLIENTS` therefore carries `notifications.push emails.send projects.contracts.read`.
   Under `NODE_ENV=test` the reader is off, so no route test reaches a real projects-api.
6. **Taking a deal is one write, and the database arbitrates the race.** `POST /queue/{dealId}/project`
   and `/attach` read the deal live (it must exist, be `won` now, and have no contract), check the
   caller holds `project:manage` for the **deal's** entity, then write the project and its contract
   in **one nested create**. The unique index on `contract.dealId` (specs/021) is what decides two
   concurrent takes of one deal: the loser gets `409 deal_taken`, with no project and no contract
   left behind. The explicit "already taken?" read before the write only gives the common case a
   friendly answer first; it is not the guard.

## Failure shape

**Two tools disagreeing about one fact because one of them holds, or is told about, a copy of it.**
A mirrored stage, a webhook that must arrive, a nightly sync: each makes the receiving tool's answer
only as good as the last delivery, and the receiving tool cannot tell a missed update from no update.
Every cure (replay, reconcile, backfill for what pre-dated the feature) is more machinery that must
itself be kept right. When a fact is owned elsewhere, ask the owner when you need it, with a scoped
read, and derive the rest at the moment you need it.

Two quieter failures live on the same edge, and recur wherever one tool reads another:

- **An unanswered question rendered as a negative answer.** "The other tool did not reply" shown as
  "there is nothing there" — an empty queue, a deal page with no project, a notice that quietly
  does not appear — is a wrong answer, not a degraded one. Keep *unknown* a distinct value on the
  wire (`deliveryKnown`, `won: null`), and decide per path whether unknown is shown as unknown (reads)
  or refuses the action (anything that lists work to do, or writes).
- **"Still free?" decided by a check instead of by the store.** Two people each see an unclaimed
  thing and each claim it; a read-then-write cannot tell them apart. When a record may be claimed
  once, the claim must be a constraint the database enforces, and the refusal must leave nothing
  half-written, so the whole claim is one write.

Where else this shape can appear, in the mirror-image position:
- **The other direction.** `crm-api` reading projects-api (deal page) is the same edge reversed:
  own scope, own route, never the viewer's token. A future "projects-api tells the CRM the delivery
  state" starts from a scoped read by the CRM at view time, not a push that must arrive.
- **Read and write.** A list that guides action (the queue) and the action it guides (the take)
  both read the owner live; the take must not trust the client's or the list's earlier picture, so
  it re-reads the stage and re-asks the store. The same rule applies on any write that cites
  another tool's record: the record's *current* state, not the state when the form opened.
- **Other cross-tool facts.** An estimate's figure, a company's name, a user's role: ask who owns
  it, whether a copy is really necessary, what the receiver shows when the owner is silent
  (unknown, or refusal), and exactly which fields the route may return — a service credential
  answers for everyone who can reach the caller, so the route is the access policy.
- **Recognise it** by the sentence "to be sure this stays right, we also need to notify / sync
  / mirror ...", or by a boolean that is `false` both for "no" and for "could not find out".

## Alternatives considered

- **Sync or event the deal into projects-api** (copy won deals, or have the CRM push on `won`
  / reopen). Rejected (D17: least invasive): it adds a write path to the CRM, a delivery guarantee
  to build, a backfill for deals already won (A26), and a place where reopened and re-won deals can
  drift. Reading live makes AC-2.1, AC-2.2 and AC-2.4 true by construction.
- **Forward the user's JWT to the other service.** Rejected, as in ADR-0059: it fails for the people
  the feature serves (CRM users holding no `projects:access`, OPS holding no `crm:access`), and
  both `/system/*` routes refuse a user JWT.
- **Grant each side the other's access** so the plain routes work. Rejected as in ADR-0059: it widens
  reads to people who need one fact and contradicts D13.
- **Reuse crm-api's notifier token provider for the projects read.** Rejected: that provider exists
  only when notify is configured, so the deal page would silently go dark in a deployment without
  it. The cost is the env rule in Decision 5.

## Consequences

**Positive:**
- A reopened deal leaves the queue and comes back when won again with no code to keep it so; the
  CRM's pipeline, write paths and permissions are unchanged (its deal read gains two fields).
- Each channel is revocable on its own: `projects-api` loses `crm.deals.read`, or `crm-api` loses
  `projects.contracts.read`, and nothing else changes.
- The deal page, the project page and the queue all degrade in a defined way when the other tool is
  down, and the UI can tell "unknown" from "none".

**Negative / trade-offs:**
- Every queue read and every deal read costs a service-to-service request, and there is no cache.
  `projects-api` now depends on `crm-api` at runtime for the queue and every take, and `crm-api` on
  `projects-api` for the deal page's Delivery card.
- The queue holds at most the 500 newest won deals; past that it says "showing the newest 500". `q`
  and `entity` filter within them. Pagination is a knowing deferral, fine while the CRM is weeks old.
- The Bexio order id, which ADR-0058 gave its own route and capability (`contract:bexio`) so that
  only `accounting` writes it, is now **readable by every CRM user who can open the deal page**
  (AC-3.4), through `GET /system/contracts`. It remains read-only there and decides nothing.
- A take is **entity-scoped on the deal**, not the target project: attaching a deal of one entity to
  a project of the other is allowed (A9), so `project:manage` for the project's entity is not asked.
- `crm-api`'s `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` stop being "the notifier's": either URL
  makes the pair required, and the pair without a URL is refused at startup. A deployment that
  sets only `PROJECTS_INTERNAL_URL` now needs the pair too; env-doctor and the env examples change
  with it (T16).

**Risks:**
- Between the live read of the deal and the write, the deal can be reopened. The contract then exists
  for a deal that is no longer won; the "no longer won" notice (AC-2.3) is the designed answer, and
  no lock is taken on the CRM.
- `GET /system/deals` and `GET /system/contracts` return what their `select` names, nothing more.
  Adding a field to either is a change of access policy for every user of the caller; it needs a new
  decision, and a new capability gets a new scope, never a wider one.
- The verifier is a copy (crm-api's, from notify-api's) and is not covered by the shared-copies guard;
  a fix to one must be carried to the others by hand.

## Compliance notes

- GDPR / data-protection impact: low — deals expose a title, company name, entity and estimate name;
  no contact, amount or personal field crosses either channel.
- Data residency: compliant — both services run in the EU Railway region and the data stays between them (the internal URLs are meant for private networking, as notify's).
- Audit trail: not required; every accepted `/system/*` call logs the caller's `sub` only.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
