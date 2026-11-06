# 0061 — estimai-api's first `/system/*` route returns an estimate's man-days to a scoped service credential, and a contract made from a deal never lets the client set them

**Date:** 2026-11-04
**Status:** Accepted (specs/022-projects-handoff, tasks.md § Architecture notes "Decided here"; the credential choice was the user's, 2026-11-04, at task derivation; taken at rigor `mvp` without an architect — review before merge)
**Deciders:** wellD
**Project:** Operai

---

## Context

A `fixed_price` contract made from a won deal starts from the estimated man-days of the deal's
estimate, and that figure cannot be edited afterwards (AC-3.1, ledger D8, A6). `projects-api` must
therefore read it from `estimai-api` at the moment a deal is taken. The person taking the deal —
OPS or BD — is often **not a collaborator** on the estimate, and `estimai-api` accepts only user
JWTs: every route scopes its query to the caller's `sub` (ADR-0005) and shares records through its
own collaborator ACL (ADR-0036). A user token cannot answer this question for the people who ask it.

The suite already has the narrow channel for a data read between two tools: a 5-minute scoped
service JWT minted by `auth` (ADR-0044/0049), used since specs/021 by `projects-api` to read CRM
companies (ADR-0059) and in this spec by the deals reads (ADR-0060). The figure itself already
exists twice: `estimai-ui`'s `pertCalc` is its source of truth, and `crm-api`'s `src/offers/scope.ts`
is pinned to it to print man-days on an offer. The apps are installed separately and are not a
workspace, so code is shared between them only by byte-identical copies guarded by
`scripts/check-shared-copies.ts`.

## Decision

1. **`auth` gains the scope `estimai.estimates.read`**, held by the `projects-api` client (`sub =
   system:projects-api`), one scope per capability (ADR-0049).
2. **`estimai-api` adds `GET /system/estimates/{id}/summary`**, its first `/system/*` route, behind
   that scope. It is not behind `jwtMiddleware`; its guard is a copy of `crm-api`'s
   `systemAuth.middleware.ts` carried on the route itself (RS256 through the suite JWKS, issuer
   pinned, `aud = SERVICE_AUDIENCE` — a new, optional env, different from `AUTH_AUDIENCE` — `sub =
   system:<client>`, the scope in `scope`, one identical `401` for every failure, a user JWT never
   accepted, `SERVICE_AUDIENCE` unset → every request `401`).
3. **It returns `{ id, name, manDays }` and nothing else, never the estimate's content.** It reads
   any estimate regardless of owner or collaborators — this is the one query in `estimai-api` not
   scoped to a `sub`, so the narrowness of the answer is the whole access policy. An unknown id is
   `404 estimate_not_found`.
4. **The figure is the estimate's Expected effort without AI gain:** the sum over activities of PERT
   plus risk buffer, unrounded, then **rounded half up once, to one decimal**, never negative
   (`numeric(6,1)` in the contract). It is the number an offer prints when "AI-assisted" is off.
   A document that is not an estimate with an `acts` array has no effort (`0`) and a malformed
   activity counts for nothing; neither fails the read.
5. **The formula is a byte-identical copy of `crm-api`'s.** The arithmetic between the
   `shared-copy:begin manDays` / `end manDays` markers in `estimai-api/src/system/manDays.ts` equals
   the same region of `crm-api/src/offers/scope.ts`, enforced by the new `manDays` group in
   `scripts/check-shared-copies.ts`; everything outside the markers (the `content` narrowing, the
   one rounding) is estimai-api's own. A change to the arithmetic is made in both files in one commit.
6. **Estimate-backed man-days are server-owned, on every write path.** For a deal with an estimate
   the client **omits** `terms.estimatedManDays`: a take sets it from the estimate, `PATCH` keeps
   the stored value, and sending the member — **even as `null`** — is `422
   estimated_man_days_from_estimate`. Omitted is never read as `null`. The contract keeps the deal's
   `estimateId` (the AC-3.2 link), and the figure is copied **once** when the contract is created
   (A6); later changes to the estimate do not reach it.
7. **EstimAI's answers are not all the same answer.** `projects-api` (`lib/estimai.ts`) reads as
   itself with a 5-second timeout and no token or body in any log: a number → copied; `404` →
   `estimatedManDays: null` with `estimateId` kept (the estimate is gone, the take is not blocked);
   EstimAI down, refusing us, answering nonsense or `ESTIMAI_INTERNAL_URL` unset → `503
   estimai_unavailable` / `estimai_unconfigured` and **nothing written**. It is called only when a
   `fixed_price` contract must copy the figure, before the write.
8. **Mount order is part of the guard.** `systemEstimatesRouter` must be mounted in
   `estimai-api/src/index.ts` **before** `importEstimatesRouter` and `estimatesRouter`:
   `OpenAPIHono.route()` merges the estimates routers' wildcard `.use("*", jwtMiddleware)` into the
   parent app in registration order, and a route registered after that merge answers a valid
   service credential with the user-JWT middleware's `401`.

## Failure shape

**One figure with two authors.** A number that a calculation owns is re-derived or re-entered
somewhere else — a second implementation of the formula that drifts, a rounding applied at a
different step, or a field the client can type into though its authority is a source elsewhere —
and the contract the client signs no longer agrees with the offer that was printed. It starts
invisible (both numbers look plausible) and surfaces as a dispute. The lock that prevents it must
hold on *every* path that writes the value, and *absent* must never be read as *null*, or one
path quietly becomes the author.

Quieter shapes on the same edge:
- **A credential that bypasses a record-level ACL answers for everyone who can reach the caller.**
  The route is then the access policy, so what it may return is chosen at the grain of the narrowest
  fact needed, never the record. Recognise it as the first query on a service that is not scoped to
  the caller.
- **Registration order silently decides a route's guard.** A route that needs a different guard than
  its siblings (a public one, a service one) is swallowed by a wildcard guard mounted before it and
  fails with the wrong error (here a fail-closed `401`: loud, not dangerous); and a guard registered
  *after* a route does not cover it. Where the guard lives relative to the route is part of the code,
  not a detail of wiring.
- **An unknown that is not a refusal and a refusal that is not an unknown.** "EstimAI does not know
  this estimate" lets the write proceed with the figure empty; "EstimAI could not be asked" stops it.
  Collapsing the two either blocks work on a deleted estimate or writes a contract whose figure was
  never checked.

Where else this shape can appear, in the mirror-image position:
- **Create and update.** The take sets the man-days and `PATCH` keeps them; an import, a bulk edit or
  a future "clone contract" is a third path that must honour the same lock, with the same
  omitted-versus-null rule.
- **A document figure copied into a record, and the reverse.** An offer's price lines, a deal's
  amount, a project's effort: when a figure printed in one tool becomes a value in another, it has
  one calculation and one rounding point, and the receiver copies it once and never recomputes.
- **The other direction of the channel.** A future `/system/*` route on estimai-api (existence,
  status, a rate) obeys the same narrowness, and none may write an estimate: a service credential
  must not become a way around the collaborator ACL for mutation.
- **Another figure in estimai-ui's `pertCalc` family.** A second reader of the Expected effort
  (a report, a dashboard) either imports the copy or becomes a third copy that the guard must cover.

## Alternatives considered

- **Forward the caller's JWT to estimai-api.** Rejected: the person taking a deal is often not a
  collaborator, and estimai-api accepts only user JWTs scoped to the caller's own and shared
  estimates, so the read would fail for the people who need it. (The reasoning the user gave when
  choosing the service credential; the same precedent as ADR-0059.)
- **Snapshot the man-days in crm-api when the estimate is marked ready.** Rejected: it misses
  estimates that were already ready when the module shipped and estimates an admin marked ready
  by override, and it creates a second owner of the figure.
- **Take the figure from the deal's latest offer.** Rejected: an offer generated without the
  estimate annex (specs/020) carries no man-days.

## Consequences

**Positive:**
- A contract's man-days equal what the offer printed (AI-assisted off) to one decimal, and a user
  who may not open the estimate can still have it counted, without learning anything else about it.
- Collaborator sharing (ADR-0036) and the user routes of estimai-api are unchanged; `estimai-api`
  stays a non-authorization-enforcing resource server.
- The formula cannot drift silently: `bun scripts/check-shared-copies.ts` fails when the two regions
  differ.

**Negative / trade-offs:**
- `estimai-api` gains a second authentication mode and a `SERVICE_AUDIENCE` it must set
  (different from `AUTH_AUDIENCE`); the verifier is a third copy of notify-api's, not covered by the
  shared-copies guard. The first `/system/*` route breaks the "every query is scoped to `sub`" rule
  of ADR-0005, on purpose and for one named route.
- The arithmetic now lives in three places (estimai-ui's `pertCalc` as source of truth, crm-api,
  estimai-api); only the last two are guarded by the script.
- The figure is the Expected effort **without** AI gain. An offer printed "AI-assisted" shows a
  smaller number; the AI-assisted variant is a knowing deferral (tasks.md § Deferred).
- In `projects-api` the service client is wired through the crm-api group only (`CRM_INTERNAL_URL`
  plus the `SERVICE_CLIENT_*` pair), so `ESTIMAI_INTERNAL_URL` set without that group still answers
  `estimai_unconfigured`. It costs nothing today, since taking a deal needs the CRM too, but it is
  the coupling ADR-0060 removed on the crm-api side and would surprise a consumer of estimai-api
  that needs no CRM.
- Rounding half up to one decimal is a lossy snapshot: a contract's man-days and the estimate's
  unrounded total may differ in the second decimal.

**Risks:**
- A new route mounted before the estimates routers without its own guard would be reachable without
  any credential; every route on this edge carries its guard on the route (`middleware`), never on a
  sub-app `use("*")`, and has a test that a user JWT, another scope and no token get one identical `401`.
- The lock on the man-days is spread across the take and the contract `PATCH` of `projects-api`
  (specs/022 T7 and T8); any new write path on a contract must be checked against Decision 6.
- Production needs `SERVICE_AUDIENCE` on estimai-api and `ESTIMAI_INTERNAL_URL` on projects-api, and
  the `estimai.estimates.read` scope on the `projects-api` client. Missing, taking a `fixed_price`
  deal with an estimate answers `503 estimai_unconfigured` (no URL or credential in projects-api) or
  `503 estimai_unavailable` (estimai-api refusing the credential), and nothing is written.
  env-doctor checks the variables (T16); provisioning is the owner's, after merge.

## Compliance notes

- GDPR / data-protection impact: none — the route returns an estimate's id, name and one number;
  estimate content stays in estimai-api.
- Data residency: compliant — estimates are stored in the EU Railway region and nothing leaves it.
- Audit trail: not required; an accepted call logs the caller's `sub` only.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
