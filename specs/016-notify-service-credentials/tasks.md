---
spec: 016
generated: 2026-10-13
synced: 2026-10-13
---

# Tasks: Every notify caller authenticates as itself; the shared token is retired

Derived from `plan.md` (approved 2026-10-13). Tier: `production`. No UI, no migration.

The task order follows the plan's three pushes (plan § Architecture 5). Every push to
`main` redeploys all services, so **what is on `main` at each push matters**:

- **Push 1** = T1–T5 only. Callers are unchanged.
- **Push 2** = T7–T12. Their code may be written earlier on a branch, but must not reach
  `main` before T6 is done.
- **Push 3** = T14–T17. Must not reach `main` before T13 is done.

T6, T11, T13 and T18 are done **by a person**: they set or delete secrets, edit env files
the repository guard keeps agents out of, or push and deploy. No agent runs them.

## Push 1 — the new mechanism is accepted, nothing uses it yet

- [ ] T1: `auth` knows the email scope and reserves the client id `auth` — refs: AC-2.6, AC-2.1 — deps: none
  - touch: `auth/src/system/serviceClients.ts`, `auth/src/system/serviceClients.test.ts`
  - done when: `cd auth && bun test src/system/serviceClients` passes with new cases: a
    client with `emails.send` parses; an unknown scope fails naming the client; a client
    id of `auth` fails naming it.
- [ ] T2: `auth` can mint its own credential in process (not yet used) — refs: AC-1.4, AC-1.6, AC-2.1 — deps: T1
  - touch: `auth/src/system/serviceToken.routes.ts`, `auth/src/system/serviceToken.routes.test.ts`,
    `auth/src/system/selfServiceToken*`, `auth/src/system/env.startup.test.ts`,
    `auth/src/lib/env.ts`, `auth/src/index.ts`, `auth/src/test-setup.ts`
  - Claim building and signing extracted into one function used by the endpoint and by the
    self-mint provider; provider takes its signer as a dependency and is wired in
    `index.ts`; `SERVICE_AUDIENCE` required.
  - done when: `cd auth && bun run typecheck && bun test` passes, including: a contract
    test that signs with the real better-auth plugin and verifies against its JWKS
    (`sub=system:auth`, `scope=emails.send`, `aud=SERVICE_AUDIENCE`, 300 s); a provider
    test for caching and refresh 60 s before expiry; a route test with two clients where
    removing one gives 401 for it and 200 for the other; an env test that a missing
    `SERVICE_AUDIENCE` exits naming it.
- [ ] T3: `notify-api` guards both internal routes with one scoped middleware — refs: AC-1.5, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-3.1, AC-3.2, AC-4.1, AC-4.4 — deps: none
  - touch: `notify-api/src/system/*`, `notify-api/src/lib/env*`, `notify-api/src/index.ts`
  - `createSystemAuthMiddleware({ scope })` on `/system/notifications` and `/system/emails`;
    origin bindings for `system:refund-api` and `system:estimai-api`; the caller log line;
    `NOTIFY_INTERNAL_TOKEN` optional; `SERVICE_AUDIENCE` required. Contract: plan § API
    contracts.
  - done when: `cd notify-api && bun run typecheck && bun test` passes, including, per
    route: the matrix {token set, token unset} × {shared token, service credential} =
    accept/accept, refuse/accept; wrong-scope, expired, wrong-audience and user-audience
    tokens → the same 401 body with no email sent and no row stored; every email template
    returns the same body with an `emails.send` credential as with the shared token; a
    push with an unbound `originApp` → 403; an accepted call logs exactly
    `[system-auth] <METHOD> <path> caller=<sub>` (or `caller=shared-token`) and the log
    spy sees no token, address, title or body.
- [ ] T4: the env contract check knows the new clients and their scopes — refs: AC-2.1, AC-4.4, AC-5.3 — deps: none
  - touch: `tools/env-doctor/manifest.ts`, `tools/env-doctor/check.ts`, `tools/env-doctor/check.test.ts`,
    `tools/env-doctor/live.ts`, `tools/env-doctor/live.test.ts`,
    `tools/env-doctor/templates/production/*`
  - `requiredScope` → `requiredScopes: string[]`; links for `refund-api` (both scopes) and
    `estimai-api` (`notifications.push`); a new failure when a client holds a scope its
    link does not require. `NOTIFY_INTERNAL_TOKEN` stays known until T17. Templates show
    the state after Manual A. If the guard refuses the template files, stop and hand the
    exact lines to the user.
  - done when: `cd tools/env-doctor && bun test` passes with cases for mismatched client
    id, mismatched secret, missing required scope and extra scope, and
    `mise run env:doctor -- --env production --dir tools/env-doctor/templates/production`
    reports no failure.
- [ ] T5: the rollout is written in the infrastructure notes; changeset for push 1 — refs: AC-6.1, AC-6.2 — deps: T2, T3
  - touch: `infra/README.md`, `.changeset/*`
  - The six steps of plan § Architecture 5 with exact variable names, the `SERVICE_CLIENTS`
    shape after Manual A, the check that `auth`'s push-1 deployment is live before Manual A
    (R-4), the rate-limit check (R-1), the confirmation step based on the `caller=` log
    line only, and the point of no return. One changeset: `@operai/auth` and
    `@operai/notify-api`, minor.
  - done when: the README section lists the steps in order and its confirmation step reads
    no variable value; `mise run changeset:check` passes.
- [ ] T6: **(person)** push 1, then Manual A — refs: AC-4.4 — deps: T1, T2, T3, T4, T5
  - touch: none (production settings)
  - Push; wait for `auth` and `notify-api` to be live; create one secret per new client;
    add `refund-api` and `estimai-api` to `auth`'s `SERVICE_CLIENTS`; set
    `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` on both callers.
  - done when: `./infra/check.sh` passes, `mise run env:doctor -- --env production --live`
    reports no failure, and an invitation email and a refund decision still arrive (the
    `notify-api` log shows `caller=shared-token` for them).

## Push 2 — the callers switch

- [ ] T7: `auth` sends invitation emails with its own credential — refs: AC-1.4, AC-4.3, AC-5.2 — deps: T2, T6
  - touch: `auth/src/lib/notify*`, `auth/src/lib/env.ts`, `auth/src/system/env.startup.test.ts`,
    `auth/src/index.ts`, `auth/src/test-setup.ts`,
    `auth/src/invitations/*`, `auth/src/system/serviceClients.ts` (comment only)
  - done when: `cd auth && bun run typecheck && bun test` passes, including: the email
    call carries `Authorization: Bearer <provider token>` and no `X-Internal-Token`; a
    provider failure returns `{ status: "failed" }` and the invitation is still created;
    `auth` starts with `NOTIFY_INTERNAL_TOKEN` present and absent; `git grep
    NOTIFY_INTERNAL_TOKEN -- auth/src` is empty.
- [ ] T8: `refund-api` can obtain a service credential and requires its client settings — refs: AC-4.2 — deps: T6
  - touch: `refund-api/src/lib/serviceToken*`, `refund-api/src/lib/env.ts`,
    `refund-api/src/lib/env.test.ts`, `refund-api/src/**/*.test.ts`
  - Copy of `inventory-api/src/lib/serviceToken.ts` and its test; `SERVICE_CLIENT_ID` and
    `SERVICE_CLIENT_SECRET` required; default provider disabled under `NODE_ENV=test`. The
    ~18 test files that build a process env gain the two variables (R-5).
  - done when: `cd refund-api && bun run typecheck && bun test` passes, including an env
    test where each missing variable exits naming it.
- [ ] T9: `refund-api` pushes and emails with its own credential — refs: AC-1.1, AC-1.2, AC-4.3, AC-5.2 — deps: T8
  - touch: `refund-api/src/lib/notify.ts`, `refund-api/src/lib/notify.test.ts`,
    `refund-api/src/lib/notifyEmail*`, `refund-api/src/lib/env.ts`, `refund-api/src/lib/env.test.ts`,
    `refund-api/src/index.ts`, `refund-api/src/**/*.test.ts`
  - Two push call sites, two email call sites; one retry after a 401; the shared token
    leaves the env schema and the test files.
  - done when: `cd refund-api && bun run typecheck && bun test` passes, including: all
    four call sites send `Authorization: Bearer` and no `X-Internal-Token`; provider
    rejection (auth down, 401, 429) → the push resolves and logs, the email returns
    `failed`, and the decision / batch route tests show the business action committed;
    the service starts with `NOTIFY_INTERNAL_TOKEN` present and absent; `git grep
    NOTIFY_INTERNAL_TOKEN -- refund-api/src` is empty.
- [ ] T10: `estimai-api` pushes with its own credential — refs: AC-1.3, AC-4.2, AC-4.3, AC-5.2 — deps: T6
  - touch: `estimai-api/src/lib/serviceToken*`, `estimai-api/src/lib/notify.ts`,
    `estimai-api/src/lib/notify.test.ts`, `estimai-api/src/lib/env.ts`,
    `estimai-api/src/lib/env.test.ts`, `estimai-api/src/index.ts`, `estimai-api/src/**/*.test.ts`
  - done when: `cd estimai-api && bun run typecheck && bun test` passes, including: the
    push sends `Authorization: Bearer` and no `X-Internal-Token`; each missing
    `SERVICE_CLIENT_*` exits naming it; provider rejection → the collaborator change is
    still committed; starts with the shared token present and absent; `git grep
    NOTIFY_INTERNAL_TOKEN -- estimai-api/src` is empty.
- [ ] T11: **(person)** local env files match the new settings — refs: AC-5.4 — deps: T7, T9, T10
  - touch: `auth/.env.example`, `refund-api/.env.example`, `estimai-api/.env.example`,
    `notify-api/.env.example`, `inventory-api/.env.example`, each service's local env
  - Agents cannot edit these (R-6). The implementing agent of T7/T9/T10 reports the exact
    lines: remove the shared token everywhere; add `SERVICE_CLIENT_ID` /
    `SERVICE_CLIENT_SECRET` to `refund-api` and `estimai-api`; add both clients to `auth`'s
    local `SERVICE_CLIENTS`; `SERVICE_AUDIENCE` on `auth` and `notify-api`.
  - done when: `mise run env:doctor` (local) reports no failure and `mise run dev` starts
    all five backends with no shared token set anywhere.
- [ ] T12: the whole suite works end to end with no shared token; changeset for push 2 — refs: AC-5.4 — deps: T3, T7, T9, T10, T11
  - touch: `shell/playwright.config.ts`, `shell/e2e/*`, `.changeset/*`
  - Baseline first: the inventory-assignment spec (R-7). The config stops naming the
    shared token as a prerequisite. One changeset: `@operai/auth`, `@operai/refund-api`,
    `@operai/estimai-api`, minor.
  - done when: `cd shell && pnpm e2e` passes for the invitation, refund decision, batch,
    estimate-sharing and inventory-assignment specs with the local stack from T11, and
    the local `notify-api` log shows only `caller=system:*` lines for the run;
    `mise run changeset:check` passes.
- [ ] T13: **(person)** push 2, verify, then Manual B — refs: AC-4.4, AC-5.5 — deps: T12
  - touch: none (production settings)
  - Push; trigger one invitation, one refund decision, one batch email, one collaborator
    change; confirm no `caller=shared-token` line since the push and no 429 from the token
    endpoint (R-1). Then delete `NOTIFY_INTERNAL_TOKEN` from `notify-api` (point of no
    return; restoring it undoes the step), then from `auth`, `refund-api`, `estimai-api`.
  - done when: the four flows work again after the deletion, and the variable list of
    every service, read by **name** only, has no `NOTIFY_INTERNAL_TOKEN`.

## Push 3 — the old mechanism leaves the code

- [ ] T14: `notify-api` no longer understands the shared token — refs: AC-5.1, AC-5.2 — deps: T3, T13
  - touch: `notify-api/src/system/*`, `notify-api/src/lib/env*`, `notify-api/src/index.ts`
  - Legacy path, `internalToken.middleware.ts` and the variable removed; the transition
    tests from T3 (AC-3.2, AC-4.1) are replaced by the refusal tests.
  - done when: `cd notify-api && bun run typecheck && bun test` passes, including:
    `X-Internal-Token` with any value → 401 on both routes; the service starts with the
    variable present and absent; `git grep NOTIFY_INTERNAL_TOKEN -- notify-api/src` is empty.
- [ ] T15: deploy and check scripts stop using the shared token — refs: AC-5.1, AC-5.5 — deps: T13
  - touch: `infra/deploy.sh`, `infra/check.sh`
  - `deploy.sh` checks by name that each caller has `SERVICE_CLIENT_SECRET` and `auth` has
    `SERVICE_CLIENTS`; `check.sh` drops the shared-token positive control and adds
    "an `X-Internal-Token` header → 401" on both routes.
  - done when: `bash -n` passes on both; `./infra/check.sh` passes against production
    (run by the user) and prints no variable value.
- [ ] T16: no document or comment still describes the shared token as current; changeset for push 3 — refs: AC-5.2, AC-6.1 — deps: T5, T13
  - touch: `AGENTS.md`, `README.md`, `infra/README.md`, `tools/env-doctor/README.md`,
    `inventory-api/src/lib/env.ts`, `inventory-api/src/lib/notify.ts`, `.gitleaksignore`,
    `.changeset/*`
  - `AGENTS.md`: the `notify-api` and `inventory-api` bullets and the `service client`
    row. `infra/README.md`: the service-client section generalised to all callers.
    `.gitleaksignore`: remove the entry only if it is for the shared token's reference.
    One changeset: `@operai/notify-api` minor, `@operai/inventory-api` patch.
  - done when: `git grep -n NOTIFY_INTERNAL_TOKEN -- . ':!docs/adr' ':!specs' ':!.forge'
    ':!*CHANGELOG.md' ':!.changeset' ':!tools/env-doctor' ':!*.env.example'` is empty
    apart from `infra/README.md`'s rollout history; `cd inventory-api && bun run typecheck`
    passes; `mise run changeset:check` passes.
- [ ] T17: the env contract check forbids the shared token — refs: AC-5.2, AC-5.3 — deps: T4, T14, T16
  - touch: `tools/env-doctor/manifest.ts`, `tools/env-doctor/check.ts`, `tools/env-doctor/check.test.ts`,
    `tools/env-doctor/live.test.ts`, `tools/env-doctor/templates/production/*`,
    `tools/env-doctor/*.test.ts`
  - Out of `SHARED_VARS`, the per-service lists and the secrets list; into
    `FORBIDDEN_VARS` for all five services. A new repository test asserts the name appears
    in no service's `src/`.
  - done when: `cd tools/env-doctor && bun test` passes, including: the variable present
    on any service → flagged; the `src/` test green; `mise run env:doctor -- --env
    production --dir tools/env-doctor/templates/production` reports no failure.
- [ ] T18: **(person)** push 3 and the production check — refs: AC-5.5 — deps: T14, T15, T16, T17
  - touch: none
  - done when: `./infra/check.sh` passes against production and
    `mise run env:doctor -- --env production --live` reports no failure.
- [ ] T19: all gates green, spec status → done — refs: AC-1.1–AC-6.2 — deps: T18
  - touch: `specs/016-notify-service-credentials/*`
  - done when: QE verdict PASS, the security review (plan § Security) PASS, a fresh passing
    `eval-report.md`, no drift, and `/wellforge:done 016-notify-service-credentials` closes
    the feature.
