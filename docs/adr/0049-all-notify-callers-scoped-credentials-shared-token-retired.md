# 0049 — Every `notify-api` caller authenticates with its own scoped service credential, one scope per capability, and the shared `NOTIFY_INTERNAL_TOKEN` is retired through a three-push transition

**Date:** 2026-10-13
**Status:** Accepted
**Deciders:** wellD (decided by the user at the specs/016 plan gate)
**Project:** Operai

---

## Context

`notify-api` has two internal routes, `POST /system/emails` (ADR-0011) and `POST /system/notifications` (ADR-0017). Both were gated by one shared secret, `NOTIFY_INTERNAL_TOKEN`, held by `auth`, `refund-api` (ADR-0017) and `estimai-api` (ADR-0040). ADR-0044 gave the fourth caller, `inventory-api`, a scoped, 5-minute `auth`-minted service JWT, honoured ADR-0040's hard stop for that caller only, and named the migration of the other three as a follow-up. That left two trust mechanisms side by side, and the shared token still meant that a leak from any of three deployments yields arbitrary email over wellD's Resend domain and arbitrary in-app push, with no attribution. Spec 016 is that follow-up.

Two further constraints shaped the decision. First, a push to `main` redeploys all five Railway services at once, in no guaranteed order, so a caller's new version can start before `notify-api` accepts what it sends. Second, `/system/emails` has not been reachable by any JWT so far: the email capability needs a scope of its own, because `inventory-api` and `estimai-api` must never be able to send email.

## Decision

We will move every `notify-api` caller (`auth`, `refund-api`, `estimai-api`, `inventory-api`) to its own scoped, short-lived service credential, with one scope per capability, and retire `NOTIFY_INTERNAL_TOKEN` through a three-push transition.

1. **One scope per capability.** `auth`'s `KNOWN_SERVICE_SCOPES` becomes `notifications.push` and `emails.send`. Scopes are assigned per service: `estimai-api` and `inventory-api` hold `notifications.push` only; `auth` holds `emails.send` only; `refund-api` holds both. An unknown scope still refuses `auth`'s startup.
2. **Origin binding stays per client (push only).** The existing binding table gains `system:refund-api` to `["refund"]` and `system:estimai-api` to `["estimai"]`, beside `system:inventory-api` to `["inventory"]`. A push with another `originApp` stays a 403.
3. **One middleware guards both routes.** `notificationsAuth.middleware.ts` is generalised into `notify-api/src/system/systemAuth.middleware.ts`, `createSystemAuthMiddleware({ scope, jwks?, audience? })`. `/system/notifications` uses it with `notifications.push`; `/system/emails` uses it with `emails.send`, replacing `internalTokenMiddleware`. Verification is what ADR-0044 already does (RS256 via the suite JWKS, issuer pinned, `aud = SERVICE_AUDIENCE`, `sub` of the form `system:<client>`, the route's scope present in the space-delimited `scope` claim), and every failure returns the same 401 body. On every accepted call it logs `[system-auth] <METHOD> <path> caller=<sub>` (`caller=shared-token` while the legacy path exists) and nothing else about the request. `SERVICE_AUDIENCE` becomes required in `notify-api` and in `auth`.
4. **Callers.** `refund-api` and `estimai-api` each get a copy of `inventory-api/src/lib/serviceToken.ts` (cached, single-flight, 5 s timeout, `redirect: "error"`, never logs a secret or token), copied rather than shared because the backends are installed and deployed separately with no workspace. `X-Internal-Token` is replaced by `Authorization: Bearer`; a 401 invalidates the cached token and retries once; any token failure maps onto the function's existing failure result and never starts throwing (best-effort posture of ADR-0017 kept). `SERVICE_CLIENT_ID` and `SERVICE_CLIENT_SECRET` (at least 32 characters) are required, so a deployment without them exits at startup naming the variable. `auth` mints its own credential in process under the reserved client id `auth` (ADR-0048, `docs/adr/0048-auth-mints-own-service-credential-in-process.md`).
5. **Retirement in three pushes with manual steps between them.** `NOTIFY_INTERNAL_TOKEN` becomes optional in `notify-api`; while set, both routes also accept `X-Internal-Token`; when unset, the header is never accepted.
   - **Push 1.** `auth` gets the new scope, the reserved id and the self-mint (unused yet); `notify-api` accepts a service credential on both routes, with bindings, the caller log line and the shared token optional; `env-doctor` learns the new scope and links. Nothing changes for callers.
   - **Manual A.** A person creates one secret per new client, adds `refund-api` and `estimai-api` to `auth`'s `SERVICE_CLIENTS`, and sets `SERVICE_CLIENT_ID` and `SERVICE_CLIENT_SECRET` on both callers. This must follow push 1 being live, because `auth` on old code refuses a `SERVICE_CLIENTS` value containing `emails.send`.
   - **Push 2.** `auth`, `refund-api` and `estimai-api` send their own credential.
   - **Verify.** Trigger one invitation, one refund decision, one batch email and one collaborator change; confirm the `notify-api` log has no `caller=shared-token` line since push 2.
   - **Manual B.** A person deletes `NOTIFY_INTERNAL_TOKEN` from `notify-api`, then from the three callers. This is the point of no return, after which the shared token authenticates nothing; restoring the variable in `notify-api` undoes it.
   - **Push 3.** The legacy code path, the variable, the `env-doctor` entries (the name moves to `FORBIDDEN_VARS` for all five services so a leftover is flagged), `infra/` script handling and the docs are removed.

This supersedes the shared-token parts of ADR-0011 (its `X-Internal-Token` trust for `/system/emails` and the "leak = arbitrary email" accepted risk), ADR-0017 (reuse of the same token for `/system/notifications`) and ADR-0040 (the third-holder arrangement; its hard stop is now fully discharged). It completes ADR-0044's named follow-up and finishes ADR-0011's Option C. ADR-0044 stays in force for the issuer endpoint and the service-JWT shape. Those earlier ADRs are not edited; the supersession is recorded here.

## Failure shape

A credential that identifies no caller and bundles every capability, so that holding it for one purpose silently grants all the others and a leak from any holder is indistinguishable from legitimate use. The sibling mistake is in how such a credential is removed: retiring it while deploys are unordered, or leaving a fallback to it "just in case", yields either lost traffic or a dead path that stays alive forever and hides a caller whose real credential was never set up.

It recurs in every service-to-service edge, in either direction: a new internal route mounted behind the same guard without its own scope (a push credential quietly reaching email, or the reverse); a future caller that "only needs one thing" being handed the credential that does two; outbound calls from `notify-api` to another service; and the mirror-image of retirement, namely introducing a new credential type next to an old one. Recognise it by asking of any internal call: which caller is this, which single capability may it exercise, can I see who used it in a log, and can I revoke it without touching anyone else? For any migration of a credential: in what order do the sides actually deploy, what is the undo, and does any caller-side fallback make a misconfiguration look like success?

## Options considered

### Option A — Scoped credential per caller, one scope per capability, three-push retirement (chosen)

Described above.

**Pros:**
- Every caller is attributable (`sub`), limited to its capabilities, short-lived (5 minutes) and individually revocable by removing its `SERVICE_CLIENTS` entry
- `estimai-api` and `inventory-api` can no longer send email, and `auth` can no longer push; least privilege follows from the scope split
- One middleware and one verification path for both routes, so the two cannot drift; the caller log line gives the rollout a verifiable confirmation step
- No lost sends during the transition, and the irreversible step is a single variable deletion that can be put back before any code is removed
- Retires the last holder-set growth path that ADR-0040 and ADR-0044 deferred

**Cons:**
- Three pushes and two manual steps instead of one; a person must follow the table in `infra/README.md` in order
- `estimai-api`, which deliberately has no hard runtime dependency on `auth` for reads and writes (ADR-0036), now depends on `auth` for its best-effort push; the write still succeeds and the cached token covers short outages
- Each caller carries a copy of the token provider; about 25 test files in `refund-api` and `estimai-api` need mechanical env changes
- More client secrets to create and rotate (one per client), and `auth` becomes a hard dependency of every notification flow rather than only of the user-facing ones

### Option B — A single scope for both push and email (rejected)

**Pros:**
- Simpler `SERVICE_CLIENTS` and a single check in the middleware

**Cons:**
- `estimai-api` and `inventory-api` would acquire the ability to send email over wellD's Resend domain, which the shared token already gave them no reason to need; it reproduces the over-broad blast radius under a new name

### Option C — A single push with everything (rejected)

**Pros:**
- One deploy, no manual steps between, shortest path

**Cons:**
- Railway redeploys all services in no fixed order, so whenever a caller's new version starts before `notify-api`'s, its sends are rejected and lost; with no recovery since delivery is best-effort

### Option D — Callers fall back to the shared token when they cannot obtain a credential (rejected)

**Pros:**
- No lost sends during the rollout; tolerant of `auth` outages

**Cons:**
- Keeps the shared token alive indefinitely, so it can never be retired
- Hides a misconfigured client: a missing secret looks like a working deployment, which is the failure the caller log line and the startup refusal exist to expose

### Option E — Bind the email scope per template (deferred)

**Pros:**
- Would let a client send only some email templates

**Cons:**
- A spec 016 non-goal, and no client needs it today. Trigger to revisit: a client that should send only some templates

## Consequences

**Positive:**
- `notify-api` has exactly one internal trust mechanism, and every accepted call names its caller
- A leak from one caller now compromises one capability set on one client and expires within 5 minutes of revocation, instead of all of email and push from every deployment
- ADR-0040's hard stop and ADR-0044's follow-up are closed, not deferred

**Negative / trade-offs:**
- During the transition both mechanisms coexist on both routes, the same kind of mixed state ADR-0044 accepted, now shorter and with a defined end
- Completing the rollout depends on manual steps in Railway by a person; the code cannot enforce them
- `emails.send` opens `/system/emails` to JWTs for the first time, so the credential-confusion surface (a push-only token reaching email and the reverse) must be covered by tests on both routes

**Risks:**
- **Token endpoint rate limit (R-1).** The limit is keyed by network address and off-proxy callers share the key `direct`; default 20 requests per 10 minutes, about 8 used in steady state by three callers. A restart of all three during a 401 retry eats into it. Check before push 2 that production does not lower the default, watch for a 429 during verification, and raise the default to 60 if one appears.
- **First send after start pays a round trip to `auth` (R-2).** Pushes are fire-and-forget; a batch email is awaited after commit. No startup warm-up, which would make `auth` a boot dependency.
- **`auth` unreachable stops `estimai-api` notifications (R-3).** Accepted and noted above.
- **Manual A before push 1 is live (R-4).** `auth` restarts on old code with a value it rejects; the old instance keeps serving but the deploy fails. The README says to confirm `auth`'s push-1 deployment first; `env-doctor --live` checks it.
- **Premature or mistaken Manual B.** Deleting the token before every flow shows `caller=system:*` would drop sends from a caller still on the shared token. Mitigation: the verify step reads the log line, and restoring the variable undoes the step.
- **Leftover variable.** A stale `NOTIFY_INTERNAL_TOKEN` in some environment is not read by callers and is flagged by `env-doctor` once it is in `FORBIDDEN_VARS`.

## Compliance notes

- GDPR / data-protection impact: none added. This changes how callers authenticate, not what is sent. The log line carries only the method, path and caller `sub`; never a token, secret, address, title or body.
- Data residency: unaffected; every call remains EU-to-EU between `auth`, `notify-api` and the callers.
- Audit trail: not required beyond the caller log line; secrets and tokens must never be logged.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
