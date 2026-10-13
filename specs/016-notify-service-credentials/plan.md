---
spec: 016
status: approved
approved: 2026-10-13
---

# Plan: Every notify caller authenticates as itself; the shared token is retired

## Architecture

No new deployable and no schema change. Four services change (`auth`, `notify-api`,
`refund-api`, `estimai-api`), plus `tools/env-doctor`, `infra/` and the e2e config.
`inventory-api` already works this way (ADR-0044) and is the reference; it changes only
where its client code is the copy source.

### 1. Scopes (`auth`)

`auth/src/system/serviceClients.ts` — `KNOWN_SERVICE_SCOPES` becomes
`["notifications.push", "emails.send"]`. Everything else about `SERVICE_CLIENTS` parsing
stays: an unknown scope still refuses to start (AC-2.6).

One addition: the client id **`auth` is reserved**. A `SERVICE_CLIENTS` entry named `auth`
refuses to start. The reason is in § 2.

### 2. `auth` issues its own credential in process (resolves the spec's open question)

`auth` is the issuer, so it does not call `POST /system/service-token` over HTTP to send
an invitation email. A new module `auth/src/system/selfServiceToken.ts` mints through the
same signer the endpoint uses (`signWithAuth(auth)`, i.e. better-auth's rotating key, the
one `/auth/jwks` publishes) with fixed claims: `sub = "system:auth"`,
`aud = SERVICE_AUDIENCE`, `scope = "emails.send"`, 300 s lifetime, cached and refreshed
60 s before expiry like every other caller.

- The claim-building and signing code is extracted from `serviceToken.routes.ts` into one
  function both paths call, so the endpoint and the self-mint cannot drift.
- The provider takes its signer as a dependency and is wired in `auth/src/index.ts`, for
  the reason already documented at the top of `serviceToken.routes.ts`: several test files
  `mock.module("../auth/auth.config")`, so a module that imports it directly behaves
  differently depending on test file order.
- `auth/src/lib/notify.ts` (`sendInvitationEmail`) takes the token from that provider and
  sends `Authorization: Bearer`. A mint failure is caught and returned as
  `{ status: "failed" }`, exactly like a failed send today (AC-4.3).
- `SERVICE_AUDIENCE` becomes **required** in `auth` (it is optional today, required only
  when `SERVICE_CLIENTS` is set). Production has had it since specs/015.

Because `system:auth` exists without a secret, an operator-defined client with the same id
would let an external holder of that entry's secret mint tokens indistinguishable from
`auth`'s own. Hence the reserved id.

**Chosen over:** `auth` calling its own endpoint with its own `SERVICE_CLIENTS` entry. That
adds a loopback HTTP call on the invitation path, spends the endpoint's rate limit, and
introduces a secret whose only purpose is letting the holder of the signing key prove to
itself that it may sign. Recorded as ADR-0048 (`docs/adr/0048-auth-mints-own-service-credential-in-process.md`).

### 3. One system-auth middleware for both internal routes (`notify-api`)

`notificationsAuth.middleware.ts` is generalised into
`notify-api/src/system/systemAuth.middleware.ts`:

```ts
createSystemAuthMiddleware({ scope: "notifications.push" | "emails.send", jwks?, audience? })
```

- `POST /system/notifications` uses it with `notifications.push` (behaviour unchanged).
- `POST /system/emails` uses it with `emails.send`, replacing `internalTokenMiddleware`.
- Verification is what ADR-0044 already does: RS256 via the suite JWKS, issuer pinned,
  `aud = SERVICE_AUDIENCE`, `sub` of the form `system:<client>`, the route's scope present
  in the space-delimited `scope` claim. Every failure is the same 401 body.
- **Origin bindings** (existing mechanism, push only) gain two rows:
  `system:refund-api → ["refund"]`, `system:estimai-api → ["estimai"]`. A push with another
  `originApp` stays a 403, as for `inventory-api` today.
- **Caller in the log** (AC-1.5): on every accepted call the middleware logs
  `[system-auth] <METHOD> <path> caller=<sub>`, or `caller=shared-token` while the legacy
  path exists. Nothing else about the request is logged. This line is also what the
  rollout's confirmation step reads (AC-6.2).
- **Transition switch.** `NOTIFY_INTERNAL_TOKEN` becomes *optional* in `notify-api`. Set:
  both routes also accept `X-Internal-Token` (today's behaviour, extended to no new
  route). Unset: the header is never accepted. Retiring the shared token in production is
  therefore deleting one variable, which can be put back, before any code is removed.
- `SERVICE_AUDIENCE` becomes required in `notify-api`.

No per-template binding on the email scope (spec non-goal). Recorded as rejected-for-now in
the ADR, with its trigger.

### 4. Callers (`refund-api`, `estimai-api`)

Each gets a copy of `inventory-api/src/lib/serviceToken.ts` (cached, single-flight, 5 s
timeout, `redirect: "error"`, never logs a secret or token) and its test. Copied, not
shared: the backends are separately installed and deployed, with no workspace (AGENTS.md
§ Git), which is the same reason every frontend re-authors shared components.

- `refund-api/src/lib/notify.ts` (two push call sites) and `notifyEmail.ts` (two email call
  sites), `estimai-api/src/lib/notify.ts` (one call site): `X-Internal-Token` is replaced
  by `Authorization: Bearer <token>`; one 401 invalidates the cached token and retries
  once (as `inventory-api/src/lib/notify.ts` does). Any token failure maps onto the
  function's existing failure result; none of them starts throwing.
- Env: `NOTIFY_INTERNAL_TOKEN` is removed from each service's schema; `SERVICE_CLIENT_ID`
  and `SERVICE_CLIENT_SECRET` (≥ 32 chars) are added and required, so a deployment without
  them exits at startup naming the variable (AC-4.2). Both services already have
  `AUTH_BASE_URL`. A leftover `NOTIFY_INTERNAL_TOKEN` in the environment is simply not read
  (AC-5.2).
- The default token provider is disabled under `NODE_ENV=test`, as in `inventory-api`, so
  a route test can never mint against a developer's real `auth`.

### 5. Three pushes, because one push deploys every service

A push to `main` redeploys all five Railway services at once, in no guaranteed order. So
the safe order is expressed as three pushes with manual steps between them:

| Step | What | After it |
|---|---|---|
| **Push 1** | `auth`: new scope, reserved id, self-mint available (not yet used). `notify-api`: both routes accept a service credential, bindings, caller log, shared token optional. `env-doctor`: knows the new scope and links. | Nothing changes for callers; every caller still sends the shared token and it still works. |
| **Manual A** | A person creates one secret per new client as a Railway shared variable, adds `refund-api` and `estimai-api` to `auth`'s `SERVICE_CLIENTS`, sets `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` on both callers. | Old caller code ignores the new variables. `auth` (already on push 1) accepts the new scope. |
| **Push 2** | `auth`, `refund-api`, `estimai-api` send their own credential. | `notify-api` log shows `caller=system:*` for every flow. |
| **Verify** | Trigger one invitation, one refund decision, one batch email, one collaborator change; confirm no `caller=shared-token` line since push 2. | — |
| **Manual B** | Delete `NOTIFY_INTERNAL_TOKEN` from `notify-api`. **This is the step after which the shared token stops working**; restoring the variable undoes it. Then delete it from `auth`, `refund-api`, `estimai-api`. | The shared token authenticates nothing. |
| **Push 3** | `notify-api`: the legacy path and the variable are removed from the code. `env-doctor`, `infra/deploy.sh`, `infra/check.sh`, `shell/playwright.config.ts`, docs: every mention removed. | AC-5.1 to AC-5.5. |

Manual A must come after push 1: `auth` on the old code refuses to start on a
`SERVICE_CLIENTS` value containing `emails.send`.

**Chosen over:** (a) one push with everything, which loses sends whenever a caller's new
version starts before `notify-api`'s; (b) callers falling back to the shared token when
they cannot get a credential, which keeps the shared token alive indefinitely and hides a
misconfigured client. Recorded as ADR-0049
(`docs/adr/0049-all-notify-callers-scoped-credentials-shared-token-retired.md`).

### 6. Contract checker, scripts, docs

- `tools/env-doctor/manifest.ts`: `SERVICE_CLIENT_LINKS` gains `refund-api` (requires both
  scopes) and `estimai-api` (requires `notifications.push`); `requiredScope` becomes
  `requiredScopes: string[]`. A new check fails when a client holds a scope its link does
  not require (AC-2.1: `estimai-api` and `inventory-api` must not hold `emails.send`).
  `NOTIFY_INTERNAL_TOKEN` leaves `SHARED_VARS`, the per-service lists and the secrets list
  at push 3, and moves to `FORBIDDEN_VARS` for all five services so a leftover is flagged.
  Production templates under `tools/env-doctor/templates/production/` follow each push.
- `infra/deploy.sh`: stops requiring and setting `NOTIFY_INTERNAL_TOKEN`; checks, by name
  only, that each caller has `SERVICE_CLIENT_SECRET` and `auth` has `SERVICE_CLIENTS`.
- `infra/check.sh`: the opt-in positive control that presents the shared token is removed;
  the negative checks stay (no credential → 401) and one is added (an `X-Internal-Token`
  header → 401).
- `infra/README.md`: the rollout table above with the exact variable names (AC-6.1), and
  the service-client section generalised from "inventory-api" to all callers.
- `AGENTS.md`: the `notify-api` and `inventory-api` bullets, the `service client` glossary
  row and the ADR index.

## Data model

None. No table, no migration.

## API contracts

### `auth POST /system/service-token` (shape unchanged)

```
request   { "clientId": "refund-api", "clientSecret": "<secret>" }
200       { "token": "<jwt>", "expiresInSeconds": 300 }      Cache-Control: no-store
400       malformed body          401  unknown client OR wrong secret (one body)
429       rate limited (Retry-After)
```

Token claims (all callers, including `auth`'s self-mint):

```
iss   BETTER_AUTH_URL          aud   SERVICE_AUDIENCE (never AUTH_AUDIENCE)
sub   "system:<clientId>"      scope space-delimited subset of the two scopes
iat, exp = iat + 300, jti
```

### `auth` `SERVICE_CLIENTS` after Manual A

```json
{
  "inventory-api": { "secret": "<…>", "scope": "notifications.push" },
  "estimai-api":   { "secret": "<…>", "scope": "notifications.push" },
  "refund-api":    { "secret": "<…>", "scope": "notifications.push emails.send" }
}
```

Startup refusals: invalid JSON; unknown key; secret outside 32–256 chars; a scope outside
the two known; **a client id of `auth`** (new).

### `notify-api POST /system/emails`

```
credential   Authorization: Bearer <service JWT with scope emails.send>
             (transition only, while NOTIFY_INTERNAL_TOKEN is set: X-Internal-Token)
request      unchanged — { to, template, data } per template
200 / 400    unchanged
401          no credential · wrong shared token · bad signature · wrong issuer ·
             wrong audience (incl. a user JWT) · expired · sub not "system:<id>" ·
             scope lacks emails.send        — one body for all of them
```

### `notify-api POST /system/notifications`

```
credential   Authorization: Bearer <service JWT with scope notifications.push>
             (transition only: X-Internal-Token)
request      unchanged — { recipientId, originApp, severity, title, body, link? }
401          as above, with notifications.push
403          originApp not bound to the caller's sub
             (refund-api → refund, estimai-api → estimai, inventory-api → inventory)
```

### Caller settings

| Service | Added | Removed |
|---|---|---|
| `refund-api`, `estimai-api` | `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` (required) | `NOTIFY_INTERNAL_TOKEN` |
| `auth` | `SERVICE_AUDIENCE` required | `NOTIFY_INTERNAL_TOKEN` |
| `notify-api` | `SERVICE_AUDIENCE` required | `NOTIFY_INTERNAL_TOKEN` optional at push 1, gone at push 3 |

### Log line (`notify-api`, accepted internal calls only)

```
[system-auth] POST /system/emails caller=system:refund-api
```

## Test strategy

| AC | Level | Test |
|---|---|---|
| AC-1.1 | unit | `refund-api` `notify.test.ts`: decision push sends `Authorization: Bearer <token from provider>` and no `X-Internal-Token` header |
| AC-1.2 | unit | `refund-api` `notifyEmail` test: both email call sites, same assertion |
| AC-1.3 | unit | `estimai-api` `notify.test.ts`: same assertion |
| AC-1.4 | unit + contract | `auth` `notify` test: Bearer from the self-mint provider, no shared header; contract test signs with the real better-auth plugin and verifies against its JWKS: `sub=system:auth`, `scope=emails.send`, `aud=SERVICE_AUDIENCE` |
| AC-1.5 | integration | `notify-api` middleware test: an accepted call logs exactly the caller line; the spy sees no token, address, title or body |
| AC-1.6 | integration | `auth` route test: two clients configured, one removed → 401 for it, 200 for the other |
| AC-2.1 | unit | `env-doctor` `check.test.ts` on the production templates: each client's scopes equal its link's `requiredScopes`; `auth` self-mint scope asserted in its unit test |
| AC-2.2 | integration | `notify-api` `/system/emails`: push-only token → 401, the email channel stub not called |
| AC-2.3 | integration | `notify-api` `/system/notifications`: email-only token → 401, no row, no fan-out |
| AC-2.4 | integration | both routes: a token with `aud=AUTH_AUDIENCE` → 401 |
| AC-2.5 | integration | both routes: expired token → 401; other audience → 401 |
| AC-2.6 | unit | `auth` `serviceClients` test: unknown scope → parse error naming the client; id `auth` → parse error |
| AC-3.1 | integration | `/system/emails` with an `emails.send` token: every template renders and returns the same body as the shared-token case |
| AC-3.2 | integration | `/system/emails` with `NOTIFY_INTERNAL_TOKEN` set: `X-Internal-Token` accepted |
| AC-4.1 | integration | both routes, token set: shared token accepted alongside a service credential in the same test process |
| AC-4.2 | unit | `refund-api` and `estimai-api` `env.test.ts`: missing `SERVICE_CLIENT_ID` or `SERVICE_CLIENT_SECRET` → exit with the variable named |
| AC-4.3 | unit | each caller: provider rejects (auth down, 401, 429) → push resolves without throwing and logs; email returns `failed`; route tests confirm the decision / invitation / collaborator change is still committed |
| AC-4.4 | integration | `notify-api` matrix over the rollout states: {token set, token unset} × {shared token, service credential} per route gives accept/accept, refuse/accept; plus the `env-doctor` templates passing at each push |
| AC-5.1 | integration | `notify-api` after push 3: `X-Internal-Token` with any value → 401 on both routes |
| AC-5.2 | unit | each service's `env.test.ts`: starts with `NOTIFY_INTERNAL_TOKEN` present and with it absent; a repo-wide test asserts the name appears in no `src/` file |
| AC-5.3 | unit | `env-doctor` `check.test.ts`: mismatched client id, mismatched secret, missing required scope, extra scope → each fails; `NOTIFY_INTERNAL_TOKEN` present on any service → flagged |
| AC-5.4 | e2e | `shell` Playwright with no shared token in any service's environment: the existing invitation, refund decision, batch, estimate-sharing and inventory-assignment specs pass |
| AC-5.5 | manual, scripted | `infra/check.sh` passes against production; `railway variables` listed by **name** shows no `NOTIFY_INTERNAL_TOKEN` on any service (step in the README) |
| AC-6.1 | review | `infra/README.md` contains the six-step table with variable names and the point of no return |
| AC-6.2 | review | the README's confirmation step greps the `caller=` log line and reads no variable value |

## Risks

- **R-1: the token endpoint's rate limit is keyed by network address, and callers on
  Railway's private network may all appear as one address.** Three callers plus restarts
  could trip it. Checked while planning: the default is 20 requests per 10 minutes, and
  off-proxy callers all share the key `direct`. Each caller mints at most once per
  ~4 minutes thanks to the cache, so three callers use about 8 of the 20 in steady state.
  That holds, but a deploy restarting all three while a 401 retry is in flight eats into
  it. *Early check, before push 2:* confirm production does not override the default
  downward, and watch for a 429 from the endpoint during the verify step; raise the
  default to 60 if one appears.
- **R-2: a caller's first send after start pays one extra round trip to `auth`.** Pushes
  are fire-and-forget, so no user waits; a batch email is awaited after the transaction
  commits. Mitigation: 5 s timeout already in the provider; no warm-up at startup (it
  would make `auth` a boot dependency).
- **R-3: `auth` unreachable now also stops notifications from `estimai-api`**, which
  deliberately has no hard runtime dependency on `auth` for reads and writes (ADR-0036).
  Accepted: the dependency is only on the best-effort push, the write still succeeds
  (AC-4.3), and the cached token covers outages shorter than its remaining lifetime.
- **R-4: Manual A done before push 1 has finished deploying `auth`** makes Railway restart
  `auth` on old code with a value it rejects. The old instance keeps serving, but the
  deploy fails. Mitigation: the README step says to confirm `auth`'s push-1 deployment is
  live first; `env-doctor --live` checks it.
- **R-5: test files.** About 25 test files in `refund-api` and `estimai-api` set
  `NOTIFY_INTERNAL_TOKEN` in their process env. They need `SERVICE_CLIENT_*` instead or
  the env module exits. Mechanical, but it is most of the diff; the tasks size it
  separately.
- **R-6: env example files and local `.env` files** must gain `SERVICE_CLIENT_*` and lose
  the shared token for local runs and e2e (AC-5.4). The repository guard blocks agents
  from editing env files, examples included, so those edits are done by a person; the
  tasks list the exact lines.
- **R-7: the three test-auth and e2e paths.** `shell/playwright.config.ts` documents the
  shared token as a prerequisite; if the local stack is started with stale env the e2e
  run fails at the first notification. Early check: run the inventory-assignment spec
  (already on service credentials) before touching anything, as the baseline.

## Security

**YES.** This changes service-to-service authentication, adds a second way to mint a
credential (in process), opens the email endpoint to JWTs, and ends by deleting a
credential in production. An `owasp-reviewer` pass runs in parallel with QE. Points it
must cover: the reserved `auth` client id; that a user JWT and a wrong-scope service JWT
are refused on both routes; that no log line, error message or test fixture carries a
secret or token; that the 401 body does not distinguish causes; that removing the legacy
path left no route on `internalTokenMiddleware`.

## ADR candidates

- **A (ADR-0048, `docs/adr/0048-auth-mints-own-service-credential-in-process.md`) — `auth` mints its own service credential in process under a reserved client id.**
  Rejected: calling its own `POST /system/service-token` with a `SERVICE_CLIENTS` entry;
  keeping the shared token for `auth` alone.
- **B (ADR-0049, `docs/adr/0049-all-notify-callers-scoped-credentials-shared-token-retired.md`) — All notify callers move to scoped service credentials, one scope per capability,
  and the shared token is retired by a three-push transition.** Completes ADR-0011's
  Option C and ADR-0044's named follow-up; supersedes the shared-token parts of ADR-0011,
  ADR-0017 and ADR-0040. Rejected: a single scope for push and email; a single push; a
  caller-side fallback to the shared token; per-template binding of the email scope
  (deferred, trigger: a client that should send only some templates).
