# Operai — Deployment Guide

The single, step-by-step guide to installing the Operai suite: **frontends on
Vercel**, **backends + Postgres on Railway**. It replaces the previous
per-platform runbooks and variable reference (all folded in below).

Two helper scripts live beside this doc:

| Script | What it does |
|---|---|
| **`./infra/deploy.sh`** | Automates the automatable: Railway backend vars + deploys (+ optional `--vercel` env sync). |
| **`./infra/check.sh`** | Verifies an install — local tooling and/or deployed health (backends, JWKS, remotes, CSP). |

> **Data residency (hard requirement).** All **backend** services and Postgres
> run in **`europe-west4`** (Railway EU). Some wellD clients are regulated
> (energy/finance/health). Don't change the region without an ADR + client
> sign-off. Frontends are static client bundles; they store/transmit no estimate
> data except the browser's authenticated calls to the EU backends.

---

## Topology

```
Vercel (6 projects, one origin each)          Railway project (europe-west4)
┌───────────────────────────────┐             ┌───────────────────────────────┐
│ shell   https://operai.welld.io│──┐ loads    │ auth        (Bun+Hono)        │
│         (host, entry point)    │  │ remote-  │  https://auth.operai.welld.io │
├───────────────────────────────┤  │ Entry.js │  1 replica (R7, specs/20260807-estimate-sharing     │
│ estimai-ui  estimai.operai…    │◄─┤ at run-  │  — see below), app-access-    │
│ refund-ui   refund.operai…     │◄─┤ time, in │  check limiter is in-process  │
│ admin-ui    admin.operai…      │◄─┤ browser  ├───────────────────────────────┤
│ notify-ui   notify.operai…     │◄─┘          │ estimai-api (Bun+Hono)        │
└───────────────────────────────┘              │  https://estimai-api.operai… │
   shell owns session; remotes                 │  1 replica (R7, specs/20260807-estimate-sharing     │
   delegate to shell/session                   │  — see below), share-add     │
                                                │  limiter + identity cache are │
                                                │  in-process, single-instance  │
                                                ├───────────────────────────────┤
                                                │ notify-api  (Bun+Hono)        │
                                                │  https://notify-api.operai…  │
                                                │  1 replica (R2 — see         │
                                                │  below), SSE + ticket store  │
                                                │  are single-instance only    │
                                                ├───────────────────────────────┤
                                                │ refund-api  (Bun+Hono)        │
                                                │  https://refund-api.operai…  │
                                                │  → EU object storage (S3-    │
                                                │    compatible, ADR 20260716-eu-object-storage-refund-attachments) —   │
                                                │    receipt attachments,      │
                                                │    presigned direct-to-bucket│
                                                ├───────────────────────────────┤
                                                │ Postgres (shared)             │
                                                │   ├─ db: auth                 │
                                                │   ├─ db: estimai              │
                                                │   ├─ db: notify               │
                                                │   └─ db: refund               │
                                                │ estimai-api, notify-api,      │
                                                │ refund-api → auth /auth/jwks  │
                                                │ refund-api → auth /authz/     │
                                                │   resolve (ADR 20260716-refund-api-authorization-enforcing-resource-server)          │
                                                │ estimai-api → auth /authz/    │
                                                │   app-access-check +          │
                                                │   /authz/users/identities     │
                                                │   (specs/20260807-estimate-sharing, ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt/0039)  │
                                                │ refund-api → notify-api       │
                                                │   /system/notifications       │
                                                │   (ADR 20260716-system-notifications-cross-user-trigger)                  │
                                                │ estimai-api → notify-api      │
                                                │   /system/notifications       │
                                                │   (specs/20260807-estimate-sharing, ADR 20260807-estimai-api-third-notify-internal-token-holder)       │
                                                └───────────────────────────────┘
```

- **Frontends:** the `shell` is the human entry point (`operai.welld.io`); the
  four tools (`estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui`) are
  runtime-federated remotes, each on its own subdomain, loaded cross-origin by
  the shell (ADR 20260709-suite-frontend-module-federation). `notify-ui` (specs/20260713-notification-center) is the notification-center
  page; the shell's own bell/toast/SSE seam is shipped inside the shell bundle
  itself, not this remote (ADR 20260713-notification-center-standalone-service-shell-seam) — see the shell-side notes in
  `specs/20260713-notification-center/plan.md`.
- **Backends:** `auth` (OAuth, sessions, RS256 JWT + JWKS, hosted sign-in,
  authorization/admin API), `estimai-api` (estimate persistence), `notify-api`
  (notification persistence + SSE push, specs/20260713-notification-center), and `refund-api`
  (reimbursement persistence + authorization-enforcing resource server,
  specs/20260716-refund-service). One Postgres instance, four logical databases (`auth`,
  `estimai`, `notify`, `refund`); service↔DB traffic stays on Railway private
  networking (`*.railway.internal`).
  **`notify-api` is pinned to a single replica** (`.railway/railway.ts`,
  `replicas: { "europe-west4-drams3a": 1 }`) — its in-process EventBus fan-out and stream-ticket store
  are correct for exactly one running instance (plan.md Risk R2). Do not
  enable autoscale/multiple replicas for this service without first moving
  both seams onto Postgres `LISTEN`/`NOTIFY` + a shared ticket table.
  `refund-api` has no equivalent constraint — its `authzMiddleware` cache
  (ADR 20260716-refund-api-authorization-enforcing-resource-server) is a per-replica performance optimization with a 30s TTL
  backstop, not a correctness-dependent single-instance store.
  **`auth` and `estimai-api` are now ALSO pinned to a single replica each**
  (specs/20260807-estimate-sharing, T13, plan.md Risk R7) — `auth`'s
  `APP_ACCESS_CHECK_*` rate limiter (T1, `src/lib/rateLimiter.ts`) and
  `estimai-api`'s `SHARE_ADD_*` rate limiter + 60s in-process identity cache
  (T5, `src/lib/rateLimiter.ts`/`authClient.ts`) are both `Map`-based,
  per-process state — a second replica of either service would silently
  multiply the effective rate limit by the replica count (an attacker
  round-robined across N replicas gets N× the intended budget) and serve a
  stale identity from whichever replica's cache happens to answer. Same
  failure shape as `notify-api`'s SSE constraint above, same fix if this is
  ever revisited: swap the `Map` for a shared store (Redis/Postgres) behind
  the limiter's existing one-interface design (plan.md R7 "Early check") —
  do not enable autoscale/multiple replicas for `auth` or `estimai-api`
  without doing that first. The pins live in `.railway/railway.ts`
  (§ Railway configuration as code below).
- **`notify-api` and `estimai-api` are cross-valid JWKS resource servers**
  (ADR 20260713-jwt-audience-claim-enforcement) — both verify the same `auth`-issued tokens, so both (plus
  `auth`, which stamps the claim) require an identical **`AUTH_AUDIENCE`**
  value or a token minted for one is structurally valid at the other.
  `refund-api` (specs/20260716-refund-service) is a THIRD JWKS resource server on the same
  `AUTH_AUDIENCE` value — see § Variable reference.
- **`auth` → `notify-api` service-to-service email trigger** (specs/20260713-user-invitations,
  ADR 20260714-notify-api-email-channel-service-trust): `auth` calls `notify-api`'s internal `POST /system/emails` to send
  invite/resend emails (Resend, bilingual) — the suite's first non-user-JWT
  cross-service call. Since specs/20261013-notify-service-credentials (ADR 20261013-auth-mints-own-service-credential-in-process/0049) `auth` authenticates it with its
  own scoped 5-minute service JWT (`sub=system:auth`, scope `emails.send`), minted in
  process — there is no shared secret any more. This call is routed over Railway **private
  networking** (`NOTIFY_INTERNAL_URL` → `notify-api.railway.internal`), not
  the public `<NOTIFY_API_URL>` domain the browser uses for SSE — see
  § Variable reference and § Phase 1 step 7.
- **`refund-api` → `auth` `/authz/resolve` + `refund-api` → `notify-api`
  `/system/notifications`** (specs/20260716-refund-service, ADR 20260716-refund-api-authorization-enforcing-resource-server/ADR 20260716-system-notifications-cross-user-trigger):
  `refund-api` is the suite's first AUTHORIZATION-enforcing resource server —
  every request resolves the caller's live permissions from `auth GET
  /authz/resolve` (forwarding the caller's own Bearer JWT, no new secret,
  reuses `AUTH_ISSUER`/`AUTH_JWKS_URL`/`AUTH_AUDIENCE` below — no separate env
  var). After an approve/reject decision it calls `notify-api`'s internal
  `POST /system/notifications` (mirrors `/system/emails`'s shape), and, for the
  monthly batch email, `POST /system/emails`, each authenticated with its own scoped
  service JWT (scopes `notifications.push` + `emails.send`) from `auth POST
  /system/service-token` (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired). Both calls should
  prefer Railway **private networking** where the target service's private
  hostname is known, same posture as `auth`'s existing `NOTIFY_INTERNAL_URL`.
- **`refund-api` → EU object storage** (specs/20260716-refund-service, ADR 20260716-eu-object-storage-refund-attachments): a
  SEPARATE S3-compatible bucket resource (not a Railway service) — receipt
  attachments never transit `refund-api`'s own process (presigned
  direct-to-bucket upload/download). See § Variable reference's `refund-api`
  section and this task's follow-up note on provisioning (not yet done).
- **`estimai-api` → `auth` `/authz/app-access-check` + `/authz/users/identities`,
  `estimai-api` → `notify-api` `/system/notifications`** (specs/20260807-estimate-sharing,
  T13, ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt/ADR 20260807-record-level-acl-resource-server-owned-access-primitive/ADR 20260807-live-identity-resolution-by-id-fail-soft/ADR 20260807-estimai-api-third-notify-internal-token-holder): estimate sharing (US-1..US-7)
  adds `estimai-api`'s first outbound calls to two sibling services, using
  its own `AUTH_BASE_URL` env var (a NEW var — distinct from the
  pre-existing `AUTH_ISSUER`/`AUTH_JWKS_URL` claim-verification values).
  Both `auth` calls forward the CALLER's own Bearer JWT (no new credential;
  `POST /authz/app-access-check` fails CLOSED on error per ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt,
  `POST /authz/users/identities` fails SOFT to `status:"unknown"` per
  ADR 20260807-live-identity-resolution-by-id-fail-soft — deliberately different failure postures on the same service,
  see each ADR). `estimai-api` deliberately does **not** become an
  authorization-enforcing resource server like `refund-api` (ADR 20260807-record-level-acl-resource-server-owned-access-primitive) —
  per-record ACLs live in `estimai-api`'s own `estimate_collaborator` table,
  not in `auth`'s catalog. The `notify-api` call reuses `refund-api`'s exact
  `/system/notifications` contract, authenticated with `estimai-api`'s own
  scoped service JWT (scope `notifications.push` only; ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired — see
  § "Service clients" below). Both calls are additionally bounded by
  `estimai-api`'s own `SHARE_ADD_RATE_LIMIT`/`_WINDOW_MS` and
  `SHARE_LOOKUP_FLOOR_MS` (plan.md AC-1.2's anti-enumeration timing floor,
  mirroring `auth`'s own `APP_ACCESS_CHECK_FLOOR_MS`) — see § Variable
  reference's `estimai-api` section for all six new vars.
- **The public URL placeholders** used below — keep them straight; all need
  the `https://` scheme:
  - `<AUTH_URL>` = the **auth** service (e.g. `https://auth.operai.welld.io`). It
    is the JWT **issuer**, so `estimai-api`, `notify-api`, and `refund-api`
    point back at it (`refund-api` also calls its `/authz/resolve` route).
  - `<API_URL>` = the **estimai-api** service (e.g. `https://estimai-api.operai.welld.io`).
    Only the browser/UI references it.
  - `<NOTIFY_API_URL>` = the **notify-api** service's **public** domain (e.g.
    `https://notify-api.operai.welld.io`). Only the browser/UI references it
    (via `VITE_NOTIFY_API_URL`); it is also the origin the shell CSP's
    `connect-src` must allow for the SSE `EventSource` (R6 — see Phase 3).
  - `<NOTIFY_INTERNAL_URL>` = notify-api's Railway **private**-networking
    address, written as `http://operai.railway.internal:8080`
    (notify-api's real private host is `operai.railway.internal`, NOT
    `notify-api.railway.internal` — see the ⚠ box in § Cross-service wiring) —
    distinct from `<NOTIFY_API_URL>` above. `auth`'s server-side `POST /system/emails` call
    (specs/20260713-user-invitations, ADR 20260714-notify-api-email-channel-service-trust) AND `refund-api`'s server-side
    `POST /system/notifications` call (specs/20260716-refund-service, ADR 20260716-system-notifications-cross-user-trigger) both use this;
    never given to a browser, never the public domain — see § Phase 1 step 7.
  - `<INVENTORY_API_URL>` = the **inventory-api** service's **public** domain
    (e.g. `https://inventory-api.operai.welld.io`). Only the browser references it,
    through the shell's `VITE_INVENTORY_API_URL` (inventory-ui has no copy of its
    own) and the shell CSP's `connect-src`.
  - `<REFUND_API_URL>` = the **refund-api** service's **public** domain (e.g.
    `https://refund-api.operai.welld.io`). Only the browser/UI references it
    (via `VITE_REFUND_API_URL`, both on the `shell` project — trusted-origins
    allowlist — and the `refund-ui` project itself); it is also the origin
    the shell CSP's `connect-src` must allow (see Phase 3).

- **`inventory-api` and `inventory-ui`** (specs/20261006-hardware-inventory, T43;
  ADR 20261006-scoped-service-jwt-fourth-notify-caller..0047) are the fifth backend and sixth frontend project. The diagram
  above predates them; they add a sixth Vercel project (`inventory-ui` →
  `inventory.operai.welld.io`, a remote exposing `./App`, `./MyDevices` and
  `./version`), a fifth Railway service (`inventory-api` → `inventory-api.operai.welld.io`,
  logical DB `inventory`, port `8083`, region `europe-west4`) and a SEPARATE EU
  invoice bucket. `inventory-api` is an authorization-enforcing resource server
  (calls `auth GET /authz/resolve` and `POST /authz/users/identities` on the
  caller's forwarded JWT) and the one of four notify callers: it pushes to
  `notify-api POST /system/notifications` with a 5-minute scoped service JWT
  minted by `auth POST /system/service-token` (ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049). Browsers also call
  `auth GET /authz/users/directory` directly from `inventory-ui` (ADR 20261006-user-directory-endpoint-capability-gated).
  Full variable list and the manual rollout steps: § `inventory-api` service.
- **Service tokens are signed by better-auth's rotating key, NOT by
  `JWT_PRIVATE_KEY`** (ADR 20261006-scoped-service-jwt-fourth-notify-caller, plan risk R-4, resolved in the T4 contract
  test): the token carries the same `kid` that `auth` publishes at
  `/auth/jwks`, and `notify-api` verifies it against its existing `AUTH_JWKS_URL`
  (`aud = SERVICE_AUDIENCE`, `scope` containing `notifications.push`). The
  static pair served at `/.well-known/jwks.json` signs nothing here — do not
  point anything at it for this flow, and do not rotate `JWT_PRIVATE_KEY`
  expecting it to affect service tokens.

**Hostnames.** The `*.operai.welld.io` scheme is the proposed, welld.io-parented
layout (shared registrable parent matters for the credentialed `/auth/token`
cookie call — ADR 20260607-jwt-in-memory-never-web-storage R7). If the real domains differ, update them here **and**
in the static `vercel.json` CSP/redirect strings (Vercel doesn't interpolate env
vars into those).

---

## Prerequisites

1. **Tooling:** `railway` CLI (logged in: `railway login`), `vercel` CLI (logged
   in: `vercel login`) if you want Vercel automation, **direnv**, the **1Password
   CLI** (`op`, signed in), Node 24 + `pnpm`, and `bun`. Verify with
   **`./infra/check.sh --prereqs`**.
2. **Secrets (direnv + 1Password).** Backend secrets never live in the repo —
   they load from 1Password via `.envrc`. Run `direnv allow auth` (and
   `direnv allow estimai-api`, `direnv allow notify-api`, `direnv allow
   refund-api`) once, be signed in to `op`, and run deploy commands from
   within that shell (e.g. `direnv exec auth ./infra/deploy.sh`) so the
   secrets are exported. The full variable → 1Password-item map is in
   **§ Variable reference** below. **`refund-api`'s object-storage
   credentials (`REFUND_S3_*`) have NO 1Password item yet** — provision a real
   EU-region bucket first (see § Variable reference's `refund-api` section);
   `deploy.sh` does not yet set these vars automatically for that reason.
3. **Railway project** exists (its id is in 1Password as `$RAILWAY_PROJECT_ID`).
   Creating the project + attaching custom domains is a one-time dashboard action.

---

## Order of operations

Each phase feeds the next, so do them in order:

1. **Railway — backends first.** Yields `<AUTH_URL>`, `<API_URL>`, `<NOTIFY_API_URL>`, and `<REFUND_API_URL>`.
2. **Vercel — the five frontends.** Their build-time vars point at the Phase-1 URLs.
3. **Cross-wire origins + OAuth.** Backends trust the shell origin; register OAuth redirects.
4. **Verify** end-to-end (`./infra/check.sh`).

**Chicken-and-egg, resolved:** the shell's production origin is fixed in advance
(`https://operai.welld.io`), so the backends' `ALLOWED_ORIGINS`/`UI_HOME_URL` can
be set in Phase 1 without waiting for Vercel. Only the three **backend** URLs
are discovered during deploy — which is why the frontends' vars come after.

---

## Railway configuration as code (ADR 20261113-railway-infrastructure-as-code)

The Railway project — every backend service, the shared Postgres and its volume, the
buckets, custom domains, build and deploy settings, replicas and region — is declared in
**`.railway/railway.ts`** (Railway IaC, TypeScript SDK `railway`, pinned in the root
`package.json`). It replaces the per-service `railway.json` files (Config as Code,
deprecated, no longer read after 2026-12-01), migrated on 2026-11-13 and removed.

```bash
pnpm install                      # once, at the repo root: the SDK the CLI evaluates the file with
railway link -p 3bafd4c0-226f-4621-821b-a063976498a2 -e production
railway config plan               # read-only: what would change
railway config apply              # re-plans, shows the diff, asks for confirmation
```

Rules:

- **Change the file, not the dashboard.** A dashboard edit is drift: the next plan
  shows it and the next apply undoes it. `railway config plan --detailed-exit-code`
  exits `2` when Railway and the file differ (the scheduled `railway-drift` workflow
  runs it).
- **Plan before apply, commit before apply.** What is applied must be what is in git.
- **Never `--confirm-destructive` without reading the plan.** In a single-file setup a
  resource missing from the file is DELETED by the apply — the Postgres, its volume and
  the buckets included. A destructive plan is a stop, never a flag to add.
- **Region stays `europe-west4-drams3a`** (services, Postgres, volume) and **`ams`**
  (buckets) — data residency. A bucket's region cannot change after creation.
- **Variables are not managed** (`variables: { managed: false }`): the file holds no
  value and no secret; variables stay in Railway (dashboard, `deploy.sh`,
  `provision-tool.sh`). Making them managed would put every name under the file and a
  removed name would be deleted — a separate decision.
- **Single-replica services stay at 1**: `notify-api`, `meetings-api`, `auth`,
  `estimai-api` (see § Topology). Every other service is also declared at 1 today.
- The migration's undo snapshot (`.railway/.cac-migration.json`) is local only and
  ignored by git; after 2026-12-01 there is nothing to undo to.

## Phase 1 — Railway backends

The shape of every service — build, start, healthcheck, pre-deploy, replicas, region,
custom domain, root directory — is **`.railway/railway.ts`** (§ above), applied with
`railway config apply`; the steps below that say "pin", "root dir" or "domain" are
already declared there. What is left to this phase is what IaC does not manage: the
logical databases and the **variables**. The automatable parts of that are in
**`./infra/deploy.sh`**; the manual bits are called out. Step by step:

1. **Link** the project: `railway link "$RAILWAY_PROJECT_ID"` (env `production`).
2. **Postgres**: declared in `.railway/railway.ts` (`postgres("Postgres", { region:
   "europe-west4-drams3a" })` plus its volume) — never removed from the file, an
   apply would delete it. Then create the
   four logical DBs (the script attempts this; or `railway connect Postgres` →
   `CREATE DATABASE auth;` `CREATE DATABASE estimai;` `CREATE DATABASE notify;`
   `CREATE DATABASE refund;`). They must exist before the first deploy — each
   service's `preDeploy` runs `prisma migrate deploy` against its own DB.
3. **Deploy `auth`** (root dir `auth`, settings in `.railway/railway.ts`): set its vars
   (DATABASE_URL via `${{Postgres.*}}` references, `BETTER_AUTH_SECRET`,
   `GOOGLE_*`/`GITHUB_*`, `JWT_*`, `ALLOWED_ORIGINS=<shell origin>`, `UI_HOME_URL`,
   `AUTH_AUDIENCE` (ADR 20260713-jwt-audience-claim-enforcement — one suite-wide value; see below),
   `NOTIFY_INTERNAL_URL` (specs/20260713-user-invitations, ADR 20260714-notify-api-email-channel-service-trust — see below),
   `SERVICE_AUDIENCE` + `SERVICE_CLIENTS` (ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049 — see § "Service clients"
   below), `BOOTSTRAP_ADMIN_EMAIL`, `NODE_ENV=production`, and —
   **optional, code defaults apply if unset (specs/20260807-estimate-sharing,
   T1/T2/T27)** — `APP_ACCESS_CHECK_FLOOR_MS`/`APP_ACCESS_CHECK_RATE_LIMIT`/
   `APP_ACCESS_CHECK_RATE_WINDOW_MS` and `IDENTITIES_RATE_LIMIT`/
   `IDENTITIES_RATE_WINDOW_MS`), then deploy. Pin **one replica**
   (`.railway/railway.ts` — plan.md Risk R7, see § Topology above; the
   in-process `APP_ACCESS_CHECK`/`IDENTITIES` rate limiters are per-instance
   state). Its custom domain `auth.operai.welld.io` is declared in
   `.railway/railway.ts` → this is **`<AUTH_URL>`**.
4. **Deploy `estimai-api`** (root dir `estimai-api`): set `DATABASE_URL` (dbname
   `estimai`), `ALLOWED_ORIGINS`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `AUTH_AUDIENCE` (byte-for-byte identical
   to `auth`'s), `NODE_ENV`, and — **NEW (specs/20260807-estimate-sharing, T13)** —
   `AUTH_BASE_URL` (internal, bucket ① — same private-DNS shape as
   `refund-api`'s own `AUTH_BASE_URL`, see step 8 below), `NOTIFY_INTERNAL_URL`
   (internal, set at step 8 alongside `auth`'s and `refund-api`'s),
   `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` (specs/20261013-notify-service-credentials — see § "Service
   clients" below), and `SHARE_LOOKUP_FLOOR_MS`/
   `SHARE_ADD_RATE_LIMIT`/`SHARE_ADD_RATE_WINDOW_MS` (optional — code
   defaults `300`/`20`/`600000` apply if unset). Pin **one replica**
   (`.railway/railway.ts` — plan.md Risk R7, see § Topology above; the
   in-process share-add rate limiter and identity cache are per-instance
   state). **Generate its domain** → **`<API_URL>`**.
5. **Deploy `notify-api`** (root dir `notify-api`, settings in `.railway/railway.ts`
   — note it pins **one replica**, do not change this without first reading
   plan.md Risk R2): set `DATABASE_URL` (dbname `notify`, **not** `estimai`),
   `ALLOWED_ORIGINS=<shell origin>`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `AUTH_AUDIENCE` (same value as the other
   two), `MAX_STREAM_DURATION` (seconds; default `1800`),
   `SERVICE_AUDIENCE` (same value as `auth`'s — see § "Service clients" below),
   `EMAIL_ENABLED`/`RESEND_API_KEY`/`RESEND_FROM` (specs/20260713-user-invitations —
   see below), `NODE_ENV=production`. Confirm region **`europe-west4`** (data
   residency — notification bodies may name clients/estimates and must stay
   EU-only, never logged). **Generate its domain** → this is
   **`<NOTIFY_API_URL>`** (public — browser/SSE only; see step 7 for the
   private URL `auth` uses instead).

   > ⚠️ **Build fails with `Corepack is about to download … pnpm-…tgz` (exit 1)?**
   > That means Railway ignored the service's Dockerfile and fell back to
   > **Nixpacks**, which scans the monorepo and tries to corepack-install pnpm.
   > Root cause: the service's **Root Directory is not set to the app dir**, so
   > Railway builds from the repo root (which has no Dockerfile/`package.json`).
   > **Fix:** the service's block in `.railway/railway.ts` must declare
   > `source: github(..., { rootDirectory: "/<app>" })` and `builder: "DOCKERFILE"`;
   > `railway config plan` shows the difference, `railway config apply` restores it
   > (a dashboard fix would be undone by the next apply). This applies to BOTH
   > GitHub-connected deploys and `deploy.sh`'s `railway up --service <svc>` (which
   > uploads the repo root as context; the root directory is what scopes the build
   > down to the app).
6. **Deploy `refund-api`** (root dir `refund-api`, settings in `.railway/railway.ts`
   — T19, specs/20260716-refund-service): set `DATABASE_URL` (dbname `refund`,
   **not** `estimai`/`notify`), `ALLOWED_ORIGINS=<shell origin>`,
   `AUTH_ISSUER=<AUTH_URL>`, `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`,
   `AUTH_AUDIENCE` (same value as the other three), `NOTIFY_INTERNAL_URL`
   (notify-api's **private**-networking address — same value as `auth`'s, see
   step 8), `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` (specs/20261013-notify-service-credentials — see
   § "Service clients" below), `REFUND_S3_ENDPOINT`/`REFUND_S3_REGION`/`REFUND_S3_BUCKET`/
   `REFUND_S3_ACCESS_KEY_ID`/`REFUND_S3_SECRET_ACCESS_KEY` (EU-region object
   storage, ADR 20260716-eu-object-storage-refund-attachments — **NOT YET PROVISIONED**, see § Variable reference),
   `REFUND_APP_BASE_URL` (monthly batch processing, T14,
   specs/20260719-refund-monthly-processing, ADR 20260719-refund-batch-signed-link-email-delivery — see § Variable
   reference), `NODE_ENV=production`. Do **NOT** set
   `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — as of specs/20260722-refund-settings
   this is no longer a `refund-api` env var at all (AC-4.1); see
   § "Cutover — accounting-distribution-email setting" below for the
   one-time post-deploy step that replaces it. Confirm region
   **`europe-west4`** (data residency —
   this service handles financial figures and receipt-attachment metadata that
   may carry PII, never logged). **Generate its domain** → this is
   **`<REFUND_API_URL>`**.
7. **Cross-wire:** set `auth`'s `BETTER_AUTH_URL=<AUTH_URL>` (the JWT `iss` claim —
   must equal `estimai-api.AUTH_ISSUER`, `notify-api.AUTH_ISSUER`, and
   `refund-api.AUTH_ISSUER`) and redeploy `auth`. Re-run the script with
   `AUTH_PUBLIC_URL=<AUTH_URL>` once the domain exists.
8. **Wire the invitation email channel + refund decision notifications +
   estimate-sharing notifications** (specs/20260713-user-invitations ADR 20260714-notify-api-email-channel-service-trust,
   specs/20260716-refund-service ADR 20260716-system-notifications-cross-user-trigger, specs/20260807-estimate-sharing ADR 20260807-estimai-api-third-notify-internal-token-holder):
   set `auth`'s, `refund-api`'s, **and now `estimai-api`'s**
   `NOTIFY_INTERNAL_URL` to notify-api's **Railway private** networking
   address, as the reference
   `http://operai.railway.internal:8080` —
   do NOT hand-type `notify-api.railway.internal`, which does not resolve
   (the label is declared in `.railway/railway.ts`, notify-api's
   `networking: { privateNetworkEndpoint: "operai" }` → `operai.railway.internal`; see the ⚠
   box in § Cross-service wiring) — **not** `<NOTIFY_API_URL>`, the public domain from step 5
   (plan.md Risk R2 / ADR 20260714-notify-api-email-channel-service-trust: this service-to-service call must stay off
   the public internet). Every caller authenticates with its own credential — set up
   the service clients as described in § "Service clients" below (no shared
   secret). Also set `estimai-api`'s `AUTH_BASE_URL` to
   `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` here (same
   private-DNS shape as `refund-api`'s own `AUTH_BASE_URL` two rows up in §
   Variable reference's ① table) — it is the base for `estimai-api`'s
   `POST /authz/app-access-check` and `POST /authz/users/identities` calls
   (specs/20260807-estimate-sharing, ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt/0039). Set `notify-api`'s
   `EMAIL_ENABLED=true` with real `RESEND_API_KEY`/`RESEND_FROM` only once
   the Resend sending domain is verified (see § Resend domain setup below) —
   until then, leave `EMAIL_ENABLED=false` so invite emails are stubbed
   (recorded, not actually sent) rather than failing loudly.

**`AUTH_AUDIENCE` (ADR 20260713-jwt-audience-claim-enforcement) — one value, FOUR services (as of specs/20260716-refund-service).**
`notify-api` was the suite's first real second JWKS resource server, so a
token minted for `estimai-api` would otherwise be structurally valid at
`notify-api` (and vice versa); `refund-api` (specs/20260716-refund-service) is now a third. `auth`
stamps the `audience` claim on every JWT it issues; `estimai-api`,
`notify-api`, AND `refund-api` each verify `audience` against their own
`AUTH_AUDIENCE`. **All four services must carry the byte-for-byte identical
value** (local default: `operai-suite`, see each service's `.env.example`) — a
drifted value fails every request closed (401) in that environment, not open.

**Service clients (ADR 20261006-scoped-service-jwt-fourth-notify-caller, ADR 20261013-auth-mints-own-service-credential-in-process, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired; specs/20261013-notify-service-credentials) — one credential per
notify-api caller, no shared secret, no user identity.** `notify-api`'s two internal routes
are `POST /system/emails` (scope `emails.send`) and `POST /system/notifications` (scope
`notifications.push`). Every caller authenticates **as itself** with
`Authorization: Bearer <service JWT>`: a 5-minute RS256 JWT with `sub=system:<client>` and
`aud=SERVICE_AUDIENCE` (never `AUTH_AUDIENCE`), signed by better-auth's rotating key and
verified by `notify-api` through its existing `AUTH_JWKS_URL`. The callers are:

| Caller | `sub` | Scope(s) | Obtains its credential by |
|---|---|---|---|
| `auth` | `system:auth` | `emails.send` | minting it in process (ADR 20261013-auth-mints-own-service-credential-in-process); the client id `auth` is **reserved** — a `SERVICE_CLIENTS` entry named `auth` refuses to start |
| `refund-api` | `system:refund-api` | `notifications.push` + `emails.send` | `auth POST /system/service-token` with `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` |
| `estimai-api` | `system:estimai-api` | `notifications.push` + `estimate-notices.send` (crm-api `POST /system/estimate-notices`, ADR 20261105-estimai-closes-the-estimate-crm-follows; needs `CRM_INTERNAL_URL` on estimai-api and `SERVICE_AUDIENCE` on crm-api) | same |
| `inventory-api` | `system:inventory-api` | `notifications.push emails.send` (the weekly reminder to confirm an assignment is an email notice, specs/20261006-hardware-inventory US-15; grant it BEFORE deploying inventory-api with reminders) | same |
| `crm-api` | `system:crm-api` | `notifications.push` + `emails.send` + `deal-link-notices.send` (estimai-api `POST /system/deal-link-notices`, specs/20261108-estimate-list-oversight, ADR 20261108-crm-pushes-deal-links-to-estimai; needs `ESTIMAI_INTERNAL_URL` on crm-api and `SERVICE_AUDIENCE` on estimai-api) | same |

A person creates, per client, one Railway **Shared Variable** `<NAME>_SERVICE_CLIENT_SECRET`
(32-256 random chars, e.g. `openssl rand -hex 32`, no 1Password item), references it from
that client's `SERVICE_CLIENT_SECRET` (`${{shared.<NAME>_SERVICE_CLIENT_SECRET}}`) and from
its entry in `auth`'s `SERVICE_CLIENTS` JSON (shape in § Notify credential rollout); the
client's `SERVICE_CLIENT_ID` is its literal service name, a key of `SERVICE_CLIENTS`. Each
client holds exactly the scopes it needs (`estimai-api` must not hold `emails.send`;
`inventory-api` holds it since its assignment reminders, specs/20261006-hardware-inventory US-15); `notify-api` additionally binds each `sub` to the origin app it may push for.
`SERVICE_AUDIENCE` is a Shared Variable required on **both** `auth` and `notify-api`, identical
on the two and different from `AUTH_AUDIENCE`. To **revoke** one caller, remove its entry from
`SERVICE_CLIENTS` (credentials already minted expire within 5 minutes); the others keep
working. To **rotate** one caller's secret, change its shared variable and redeploy `auth` and
that caller (a window of 401s on that caller's pushes is the cost; the push is best-effort and
never rolls back the originating action). A leaked secret lets its holder send what its scopes
allow (for `refund-api`, email over wellD's Resend domain — plan.md Risk R2) until its entry is
removed; it is never logged. The previous shared token was retired by specs/20261013-notify-service-credentials: § Notify
credential rollout below is the history of that migration.

**Resend domain setup (plan.md Risk R5, ADR 20260714-notify-api-email-channel-service-trust compliance notes).** Before
setting `EMAIL_ENABLED=true` in production:
1. Add `operai.welld.io` (or the chosen sending subdomain) as a verified
   domain in the Resend dashboard.
2. Add the SPF and DKIM DNS records Resend provides to that domain's DNS zone;
   wait for Resend to report the domain "Verified" — an unverified domain
   means invite emails are likely to land in spam or be rejected outright.
3. Prefer Resend's **EU sending region** where available (data residency —
   CLAUDE.md; this is the transactional MTA hop, not data-at-rest, but keep
   the suite's EU-only posture consistent).
4. Set `RESEND_FROM` to an address on that verified domain (e.g.
   `no-reply@operai.welld.io`) and `RESEND_API_KEY` from the Resend dashboard
   (1Password-sourced, never committed).
Until this is done, keep `EMAIL_ENABLED=false` — the email channel stubs the
send and records an `EmailDelivery` row without calling Resend, so the rest of
the invitation flow (create/resend/revoke, admin-ui) is fully testable without
a verified domain.

**Run it:**
```bash
export RAILWAY_PROJECT_ID=...        # from 1Password
export BOOTSTRAP_ADMIN_EMAIL=you@welld.ch
export AUTH_AUDIENCE=operai-suite    # ADR 20260713-jwt-audience-claim-enforcement — identical across auth + estimai-api + notify-api + refund-api
export AUTH_PUBLIC_URL=https://auth.operai.welld.io   # after the auth domain exists
direnv exec auth ./infra/deploy.sh
```

`deploy.sh` as of T19 does NOT yet set `refund-api`'s `REFUND_S3_*` vars (no
bucket provisioned — see § Variable reference); set those manually via
`railway variables --service refund-api --set "REFUND_S3_...=..."` once a real
EU bucket + credentials exist.

**Do NOT set** `ENABLE_TEST_AUTH` (a complete auth bypass — the `POST
/test-auth/session` mint endpoint), `BETTER_AUTH_TRUSTED_ORIGINS` (bypasses the
validated `ALLOWED_ORIGINS` allowlist), or `PORT` (Railway injects it).

**Migrations + seed run automatically** — each service's `preDeploy` in
`.railway/railway.ts` runs before the new deployment starts: `bun run db:release`
for `auth` (migrations + the authz seed), `bun run db:deploy` for every other backend. `migrate deploy` is
non-interactive and only applies pending migrations; the authz seed (idempotent)
creates the system roles + app-access catalog and, on first sign-in of
`BOOTSTRAP_ADMIN_EMAIL`, the first admin. Never edit an existing migration file.

---

## Phase 2 — Vercel frontends

**Project + domain creation is manual** (Vercel CLI can't create+assign domains
here); env-var sync + redeploy is automatable (`./infra/deploy.sh --vercel`).

1. **Create six projects** (dashboard → New Project → import this repo). For each,
   **Root Directory** = the app dir (`shell` / `estimai-ui` / `refund-ui` /
   `admin-ui` / `notify-ui` / `inventory-ui`), framework **Vite**, default build (`pnpm build` →
   `dist`). Each app ships its own `vercel.json` (SPA rewrites + headers) picked
   up automatically.
2. **Assign domains:**

   | Project | Domain | Notes |
   |---|---|---|
   | `shell` | `operai.welld.io` | **Reassign** from the old `estimai-ui` project — the human entry point |
   | `estimai-ui` | `estimai.operai.welld.io` | remote-only; keeps a redirect for the old URL (below) |
   | `refund-ui` | `refund.operai.welld.io` | remote-only |
   | `admin-ui` | `admin.operai.welld.io` | remote-only (roles & permissions, specs/20260713-auth-roles-permissions) |
   | `notify-ui` | `notify.operai.welld.io` | remote-only (notification center, specs/20260713-notification-center) |
   | `inventory-ui` | `inventory.operai.welld.io` | remote-only (hardware inventory, specs/20261006-hardware-inventory; exposes `./App`, `./MyDevices`, `./version`) |

3. **Env vars** (Settings → Environment Variables, Production **and** Preview;
   all build-time → **redeploy** after changing). See **§ Variable reference**.
4. **EstimAI old-URL redirect:** `estimai-ui/vercel.json` 302-redirects only
   top-level document nav (`sec-fetch-dest: document`) to `operai.welld.io/estimai`
   — so it never catches the shell's `remoteEntry.js` fetches. Smoke-test on first
   deploy (`check.sh` checks it).
5. **Runtime remote URLs (optional):** the shell bakes `*_REMOTE_URL` at build.
   With stable custom domains you need nothing more. To repoint a remote's origin
   without rebuilding the shell, publish `shell/public/runtime-config.json` (see
   `shell/public/runtime-config.example.json` — includes `admin`) — the shell
   reads it at every page load (`shell/src/lib/runtimeRemotes.ts`). **Note:**
   as of this task (T20), `shell/vite.config.ts` does not yet declare a
   `notify` remote (`NOTIFY_REMOTE_URL`) — that lands with specs/20260713-notification-center's T13,
   mirroring `ADMIN_REMOTE_URL` exactly. `notify-ui` is deployable and
   reachable on its own domain today; the shell mounting it at `/notify` is a
   separate, not-yet-merged app-code change, not an infra gap.

**Google Maps API key — provisioning (`admin-ui`, T16, specs/20260803-employee-address,
ADR 20260804-google-places-browser-direct-referrer-restricted-key) — before setting `VITE_GOOGLE_MAPS_API_KEY` in the `admin-ui` Vercel
project.** `admin-ui`'s AddressSection calls **Google Places API (New)**
browser-direct from the admin's own browser — never proxied through `auth`
(ADR 20260804-google-places-browser-direct-referrer-restricted-key: routing a third party through the identity service would put
Google's latency/availability on the critical path of every tool in the
suite, since every tool authenticates through `auth`). This is admin-ui's
**first** `VITE_*` var and its **first** third-party credential.

1. **Enable the right APIs** on the wellD Google Cloud project — Cloud
   Console → APIs & Services → Library: enable **"Places API (New)"**
   *specifically* (not the legacy "Places API" — a project with only the old
   one enabled returns `REQUEST_DENIED` for the new endpoints, plan.md R6)
   and **"Maps JavaScript API"**.
2. **Create a browser key** — APIs & Services → Credentials → Create
   Credentials → API key, then edit it: **Application restriction = HTTP
   referrers (web sites).**

   > ⚠️ **The referrer list must contain the SHELL's origins, not
   > admin-ui's.** admin-ui runs as a Module Federation remote *inside the
   > shell's document* (ADR 20260709-suite-frontend-module-federation) — the `Referer` header on every Google call
   > from that page is the **top-level** URL, i.e. the shell's, **never**
   > `admin.operai.welld.io`. Listing admin-ui's own origin here fails
   > **100% of requests** — and because AC-3.2 makes the feature degrade
   > silently (no error banner, no blocked save, just an address field that
   > quietly never suggests anything), that failure is **invisible** until
   > someone happens to notice. This is risk **R2** (plan.md/ADR 20260804-google-places-browser-direct-referrer-restricted-key) and
   > the single easiest way to ship this feature broken. Add exactly:
   > - `https://operai.welld.io/*`
   > - `http://localhost:5173/*`
   > - the shell's Vercel preview pattern (confirm the exact wildcard in the
   >   **`shell`** Vercel project's domain settings — Preview URLs are
   >   per-deploy, same caveat as the CSP known-gap in § Phase 3)

3. **API restriction:** "Restrict key" → select **Places API (New)** and
   **Maps JavaScript API** only. Never leave it unrestricted; never reuse the
   existing `GOOGLE_CLIENT_ID`/`_SECRET` OAuth credentials for this — a
   separate, browser-exposed key with a different threat model entirely.
4. **Shell CSP — update `shell/vercel.json` too.** This is **the classic
   miss for this repo** (see § Phase 3 "Shell CSP" below — it happened on
   2026-07-31 with the receipt-bucket `connect-src` entry, and would recur
   here without this step). `admin-ui` runs Module-Federated *inside the
   shell's own document* (ADR 20260709-suite-frontend-module-federation), so the **shell's** CSP governs the page,
   not admin-ui's own `vercel.json` — exactly the same fact step 2's referrer
   box relies on. Add `https://maps.googleapis.com` to `script-src` (the
   `<script>` bootstrap `googlePlaces.ts` injects) and add BOTH
   `https://maps.googleapis.com` and `https://places.googleapis.com` to
   `connect-src` (the Places API (New) SDK's own fetch/XHR calls once
   `google.maps.importLibrary` runs). Without this, the browser blocks the
   bootstrap script outright — and because AC-3.2 makes the feature degrade
   *silently* (a `console.warn`, no error banner), every admin in every CSP-
   enforcing environment permanently falls back to manual entry with nothing
   visibly wrong. It also means step 8's own verification (a
   `places.googleapis.com` request returning 200) can never pass, because the
   request is never made. `infra/check.sh` pins both origins (§ Phase 4) so a
   future CSP edit that drops them fails loudly instead of silently.
5. **Daily quota cap + budget alert (R4).** This key is public by design —
   referrer restrictions are spoofable by a non-browser client presenting a
   forged `Referer` header, so the residual risk is **billing theft, not
   data theft** (the key, API-restricted per step 3, grants nothing but
   address lookups).
   - Cloud Console → APIs & Services → Places API (New) → Quotas: set a hard
     **daily request cap** sized to admin-only traffic (AC-4.2 — a handful of
     wellD staff, not the whole suite).
   - Billing → Budgets & alerts: create a budget alert on the project (or a
     budget scoped to this key's SKU) so a spike pages a human before it
     becomes an invoice surprise.
6. **1Password.** Create a new sibling item next to the existing OAuth
   credential — 1Password → `AIScream / OperAI - Google Maps API Key` — and
   store the key value there. Do **not** reuse the `AIScream / OperAI -
   GOOGLE OAuth` item; unrelated credentials, different restriction models.
7. **Wire it as a build-time frontend var, not a `.envrc`/direnv value.**
   This key is consumed entirely client-side by `admin-ui`'s Vite build
   (`import.meta.env.VITE_GOOGLE_MAPS_API_KEY`) — the same shape as every
   other `VITE_*` in this repo, **not** the direnv/1Password-at-runtime
   pattern the backends use (§ Prerequisites step 2). Set
   `VITE_GOOGLE_MAPS_API_KEY` in the **`admin-ui`** Vercel project's
   Environment Variables (Production **and** Preview), sourced from the
   1Password item above, then **redeploy** (build-time vars need a rebuild —
   § Phase 2 step 3). It goes on no other Vercel project, and never on
   Railway. Deliberately **not** a `shell/session` getter (ADR 20260804-google-places-browser-direct-referrer-restricted-key Option E)
   — that module is for suite-wide service origins the shell configures for
   every tool; a single remote's own third-party credential doesn't belong
   in a module every remote imports.
8. **Verify.** Load the **deployed shell** (not a local/standalone admin-ui
   dev server — the referrer that matters is the shell's), sign in as an
   admin, open a user's detail page, focus the Street address field, and
   type 3 characters. Open devtools → Network and confirm a
   `places.googleapis.com` request returns **`200`** (and suggestions
   render). A `403`/`REQUEST_DENIED` here almost always means the referrer
   list carries admin-ui's origin instead of the shell's (step 2) — recheck
   the restriction before suspecting the key value. If the request never
   appears in the Network tab at all (not even a blocked/red entry), suspect
   step 4's CSP pins instead — the browser refuses to make the call in the
   first place.

---

## Phase 3 — Cross-wire origins + OAuth

- **`ALLOWED_ORIGINS`** on all backends (`auth`, `estimai-api`,
  `notify-api`, `refund-api`, and `inventory-api` as of specs/20261006-hardware-inventory) must be the **shell's** origin
  (`https://operai.welld.io`) — that's what CORS + better-auth
  `trustedOrigins` validate. Only the shell's origin is needed: the remotes
  never call the backends directly (they delegate to `shell/session`, which
  runs under the shell's origin). This includes `notify-api`'s SSE stream
  endpoint — its `Access-Control-Allow-Origin` is pinned to the shell origin
  too (plan.md). Redeploy the affected service after a change.
- **`refund-api.ALLOWED_ORIGINS` gains admin-ui's OWN origin**
  (specs/20260720-mileage-rate, T8, plan.md Risk R8; **obsolete since 2026-11-13**:
  the screen moved to refund-ui's Settings tab, ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition amendment, so admin-ui
  no longer calls refund-api and the entry can be dropped) — admin-ui's Mileage
  Rates screen calls `refund-api`'s `/rates` endpoints directly (Bearer-authed,
  cross-origin, via `shell/session`'s `apiFetch`), the plan's chosen wiring
  (admin-ui hosts the screen; `refund-api` stays the sole data/logic owner —
  see ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition). When admin-ui runs COMPOSED inside the shell (the normal
  path in production), the browser Origin is already the SHELL's — already
  covered by the entry above, no change needed there. The NEW origin this
  bullet adds is for admin-ui's OWN origin — its standalone dev server
  (`http://localhost:5177`) and any Vercel Preview deploy of the `admin-ui`
  project (`https://admin-ui-<hash>.vercel.app` — Vercel Preview URLs are
  per-deploy, so exact-match CORS can't pin one in advance; treat Preview
  verification of this specific flow as a manual step, same known gap noted
  for the shell CSP below) — add these to `refund-api`'s `ALLOWED_ORIGINS`
  per environment. Hono CORS layer ONLY; `refund-api` has no better-auth
  `trustedOrigins` to keep in sync (unlike the `auth` service).
- **OAuth redirect URIs** (better-auth mounts at `/auth`):
  - Google Cloud Console → your OAuth client → Authorized redirect URIs:
    `<AUTH_URL>/auth/callback/google`
  - GitHub → Developer settings → OAuth App → Authorization callback URL:
    `<AUTH_URL>/auth/callback/github`
- **Shell CSP** (`shell/vercel.json`, a static header) pins each remote origin +
  the auth/API origins in `script-src`/`connect-src`, and allows Google/GitHub
  avatar hosts in `img-src`. If domains change, edit that file.
  **`connect-src` MUST include the `notify-api` AND `refund-api` origins** —
  `EventSource` (SSE) is governed by `connect-src`, not `script-src`; this is
  the classic miss for a streaming feature (plan.md Risk R6). `notify.operai.
  welld.io` (the remote, in `script-src` **and** `connect-src`) and
  `notify-api.operai.welld.io` (the SSE origin, in `connect-src`) are already
  present in `shell/vercel.json`'s CSP string (specs/20260713-notification-center T19) — `check.sh`
  asserts this pin so a future edit that drops it fails loudly.
  `refund-api.operai.welld.io` was added to `connect-src` (T20,
  specs/20260716-refund-service) — `refund-api` never streams (no SSE), but it's an
  ordinary fetch target from `refund-ui`'s calls (via `shell/session`'s
  `apiFetch`) and `connect-src` governs `fetch`/`XHR` origins too, not just
  EventSource.
  **`connect-src` must ALSO include the receipt-bucket origin**
  (`https://t3.storageapi.dev`, ADR 20260716-eu-object-storage-refund-attachments): receipt uploads POST *directly* to
  the bucket, so that request is subject to the shell's CSP even though no
  Operai service is involved. Missing on 2026-07-31 — uploads stayed broken
  after the bucket's CORS rule was fixed, because CSP blocks the request
  before it ever leaves the page. `img-src` does NOT need the bucket today
  (downloads use `window.open`), but would if inline receipt previews are ever
  added.
  **`script-src` AND `connect-src` must include the two Google origins**
  (`https://maps.googleapis.com`, `https://places.googleapis.com`,
  specs/20260803-employee-address, ADR 20260804-google-places-browser-direct-referrer-restricted-key — see § Phase 2 step 4): `admin-ui`
  runs Module-Federated inside the shell's document, so the shell's CSP (not
  admin-ui's own `vercel.json`) governs the `<script>` bootstrap and the
  Places API (New) SDK's fetch/XHR calls. `script-src` needs only
  `maps.googleapis.com` (the bootstrap loader); `connect-src` needs BOTH —
  `maps.googleapis.com` (the SDK's own internal calls) and
  `places.googleapis.com` (autocomplete/place-details lookups). Same failure
  shape as the two entries above: silently missing here means every admin
  permanently falls back to manual address entry with no visible error
  (AC-3.2's mandated silent degradation), and the T16 provisioning runbook's
  own "confirm a 200" verification step can never pass. `check.sh` asserts
  both pins so a future edit that drops either one fails loudly.
  *(Known gap: Vercel Preview deploys get `*.vercel.app` URLs the pinned CSP
  won't match — assign preview subdomains or relax CSP via Edge Middleware;
  not implemented.)*
  **Inventory (specs/20261006-hardware-inventory):** `shell/vercel.json` already carries
  `https://inventory.operai.welld.io` in `script-src` and `connect-src` and
  `https://inventory-api.operai.welld.io` in `connect-src`. Those hostnames are an
  assumption until the domains exist: if the real ones differ, edit the file and
  redeploy the shell. The invoice bucket's origin is a separate pin — see § `inventory-api`
  service.

> **⚠ A CSP change does not reach a browser that has the document cached.** CSP
> is a response **header**, and a `304 Not Modified` does not carry it — RFC
> 9111 has the client keep any header absent from the 304, so the browser goes
> on enforcing the **old** policy while `curl` against the same URL shows the
> new one. And editing only `shell/vercel.json` leaves `index.html`'s bytes —
> hence its ETag — identical, so nothing ever breaks that 304 loop. On
> 2026-08-03 receipt uploads were still blocked by a CSP that had been fixed
> and deployed two days earlier, with the correct header visibly live.
>
> `max-age=0, must-revalidate` is **not** enough — it still permits the 304.
> The shell document is therefore served `Cache-Control: no-store` (the last
> rule in `shell/vercel.json`, scoped by negative lookahead so `/assets/`,
> `/remoteEntry.js`, and `/runtime-config.json` keep their own caching), and
> `infra/check.sh` asserts it. A client poisoned before that rule shipped
> self-heals after one more navigation; a hard reload
> (<kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>) fixes it immediately.
>
> The four remote UIs (`estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui`) still
> carry the default caching on their own documents. They are loaded as federated
> remotes rather than as top-level documents, so the shell's CSP is the one that
> governs in production — but apply the same rule to any of them that ever
> becomes a directly-visited page.

---

## Phase 4 — Verify

```bash
./infra/check.sh
```
It checks backend `/health` for all FOUR backends (`auth`, `estimai-api`,
`notify-api`, `refund-api`), the **`/auth/jwks`** RS256 key set (the endpoint
every resource server verifies against — **not** `/.well-known/jwks.json`, an
orphaned env-key endpoint), each remote's `remoteEntry.js` + CORS header (five:
`estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui`), the shell CSP pins
(including the `notify-api` SSE `connect-src` pin, R6, the `refund-api`
`connect-src` pin, T20, the receipt-bucket `connect-src` pin, ADR 20260716-eu-object-storage-refund-attachments —
override its default with `REFUND_BUCKET_ORIGIN` — and the Google Maps
`script-src`/`connect-src` pins, ADR 20260804-google-places-browser-direct-referrer-restricted-key/specs/20260803-employee-address), and
warns if `notify-api`'s health payload doesn't
look JWKS-ready. It also probes both of notify-api's internal routes, `POST
$NOTIFY_API_URL/system/emails` and `/system/notifications` (specs/20260713-user-invitations, specs/20261013-notify-service-credentials): a
call with no credential must get 401, and so must one carrying the retired
`X-Internal-Token` header (proves the service-credential gate is deployed and
live and the shared-token path is gone). No credential is read or sent. Then, in a browser at
`https://operai.welld.io/`: hit a guarded route → redirected to
`<AUTH_URL>/sign-in`; sign in with Google + GitHub; the `BOOTSTRAP_ADMIN_EMAIL`
account sees the **Admin** tool in the nav; create an estimate + reload
(persists); sign out (session ends suite-wide, no 403); as an admin, send a
test invitation from the **Invitations** page and confirm `EMAIL_ENABLED`'s
posture matches expectation (stubbed `sent` if `false`, an actual Resend send
if `true`).

---

## Variable reference

### Private networking & shared variables (the Layer-2 contract)

All four backends are services in ONE Railway project/environment, so they talk
to each other over Railway **private networking**. Getting these three buckets
right is what removes the recurring "localhost in prod / missing origin"
401·503·CORS class of bug. **Rule of thumb: a *call* between backends uses
internal DNS; a *claim* or a *browser-facing* URL stays public.**

**① Internal-DNS URLs** — one backend *calling* another. Use the target's
private domain over **plain `http://`** (the private net carries no TLS), on the
target's listen port. Each `src/index.ts` binds to IPv6 `::` when Railway's
`RAILWAY_PRIVATE_DOMAIN` is present (handled in code) — that's what makes
`*.railway.internal` reachable; without it Bun binds IPv4 `0.0.0.0` and internal
calls silently fail.

> **⚠ A service's private domain is NOT derived from its current name.** Railway
> pins `RAILWAY_PRIVATE_DOMAIN` when the service is **created** and never moves
> it on a later rename. In this project two of four are already mismatched:
>
> | Service (display name) | Actual `RAILWAY_PRIVATE_DOMAIN` | Key to use inside `${{…}}` |
> |---|---|---|
> | `auth` | `auth.railway.internal` ✅ | `auth` |
> | `estimai-api` | `estimai-api.railway.internal` ✅ | `estimai-api` |
> | **`notify-api`** | **`operai.railway.internal`** ❌ | **`operai`** |
> | **`refund-api`** | **`operai-b6e4.railway.internal`** ❌ | **`operai-b6e4`** |
>
> So **never write `http://<display-name>.railway.internal`** — it looks
> perfectly correct in the dashboard and resolves to nothing. Use the
> `${{target.RAILWAY_PRIVATE_DOMAIN}}` reference where it resolves, and the
> literal from the third column where it does not (see immediately below).
>
> **…and for `notify-api` the `${{…}}` reference does not resolve at all —
> verified 2026-08-10.** Both spellings come back as an **empty string**, so the
> value silently collapses:
>
> | Written | Resolves to |
> |---|---|
> | `http://${{notify-api.RAILWAY_PRIVATE_DOMAIN}}:${{notify-api.PORT}}` | `http://:` |
> | `http://${{operai.RAILWAY_PRIVATE_DOMAIN}}:8080` | `http://:8080` |
>
> This is NOT a blanket rule about references: `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}`
> in every service's `DATABASE_URL` and `${{auth.RAILWAY_PRIVATE_DOMAIN}}` in
> `AUTH_JWKS_URL`/`AUTH_BASE_URL` both resolve correctly today — those services'
> reference keys match their display names, `notify-api`'s does not.
>
> **So: prefer the reference, but VERIFY the resolved value in the Variables tab
> before redeploying.** A value containing `http://:` means the key matched no
> service. When the reference will not resolve — as with `notify-api` — write
> the literal private domain, copied from that service's **Settings → Private
> Networking** panel (shown with a green check and "Ready to talk privately")
> and cross-checked against the third column above; never derive it from the
> display name. Railway pins the private domain at service **creation** and
> never moves it on a rename, so the literal is stable. The failure mode this
> box exists to prevent is a `<display-name>.railway.internal` host that never
> existed — not the literal form itself.
>
> Re-verify after any service is recreated (as opposed to merely renamed). On 2026-07-31
> both `auth` and `refund-api` held a literal
> `http://notify-api.railway.internal:8080`, which silently killed every
> invitation email and every refund decision/paid push for as long as it was
> set (both call sites are best-effort by design — ADR 20260714-notify-api-email-channel-service-trust/ADR 20260716-system-notifications-cross-user-trigger — so
> nothing surfaced to users, only `[notify]`/`[notifyEmail] failed to reach
> notify-api` lines in refund-api's logs). `env:doctor --live` now flags a
> hardcoded internal host that doesn't match the target's real private domain.
> Confirm any service's value with:
>
> ```bash
> railway run --service <svc> -- node -e 'console.log(process.env.RAILWAY_PRIVATE_DOMAIN)'
> ```

| Var | Owner(s) | Value |
|---|---|---|
| `AUTH_JWKS_URL` | estimai-api, notify-api, refund-api, inventory-api | `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks` |
| `AUTH_BASE_URL` | inventory-api (`GET /authz/resolve`, `POST /authz/users/identities`, `POST /system/service-token`, specs/20261006-hardware-inventory); refund-api (the `GET /authz/resolve` call); estimai-api (the `POST /authz/app-access-check` + `POST /authz/users/identities` calls, specs/20260807-estimate-sharing, ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt/0039) | `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` |
| `NOTIFY_INTERNAL_URL` | auth, refund-api, estimai-api (specs/20260807-estimate-sharing, ADR 20260807-estimai-api-third-notify-internal-token-holder), inventory-api (specs/20261006-hardware-inventory, ADR 20261006-scoped-service-jwt-fourth-notify-caller) | `http://operai.railway.internal:8080` |

**Use the Railway reference-variable form above (`${{svc.PORT}}`) — do NOT
hardcode the port.** A service listens on exactly ONE port (its `PORT`), and it
is the SAME for public and private traffic. The literal numbers in
`src/lib/env.ts` (auth 3001, estimai-api 8080, notify-api 8081, refund-api 8082)
are only the **code defaults** that apply when `PORT` is unset — Railway may set
a different value (e.g. notify-api's public domain targets **8080**, so its
`PORT` is 8080, *not* the code default 8081; hardcoding `:8081` internally would
fail to connect). For `${{svc.PORT}}` to resolve, **set `PORT` explicitly as a
variable on each backend** (any consistent value), then reference it everywhere —
the port is then unambiguous and can never drift from what the service actually
binds.

**② Public — MUST stay the public URL (the trap).** These are identity *claims*
or *browser-facing* URLs, not backend calls — repoint them at internal DNS and
things break silently:

| Var | Owner(s) | Why it stays public |
|---|---|---|
| `AUTH_ISSUER` | estimai-api, notify-api, refund-api, inventory-api | The JWT **`iss` claim**, string-compared at verify time (`jwt.middleware.ts` `issuer: env.AUTH_ISSUER`) — must equal auth's public `BETTER_AUTH_URL`. Internal DNS here → **every token rejected 401**. |
| `UI_HOME_URL` | auth | Browser post-login redirect. |
| `REFUND_APP_BASE_URL` | refund-api | Deep-link base opened in the recipient's browser. |
| `ALLOWED_ORIGINS` | all | Browser Origins (the frontends' public URLs). |

**③ Shared variables — define ONCE at the Railway *project* level, reference
with `${{shared.NAME}}`.** These are byte-for-byte identical across services
today, copied by hand — the source of drift (a mismatched `AUTH_AUDIENCE` is a
suite-wide 401):

| Var | Shared by |
|---|---|
| `AUTH_AUDIENCE` | auth + all 4 resource servers (ADR 20260713-jwt-audience-claim-enforcement; `inventory-api` is the fourth, specs/20261006-hardware-inventory) |
| `SERVICE_AUDIENCE` | auth + notify-api (ADR 20261006-scoped-service-jwt-fourth-notify-caller) — must be byte-identical across the two **and different from `AUTH_AUDIENCE`**; both refuse to start otherwise. `env:doctor` checks both. |
| `<NAME>_SERVICE_CLIENT_SECRET` (`INVENTORY_`, `ESTIMAI_`, `REFUND_`, `ACTIVITIES_`, `LETTERHEAD_`) | the `secret` inside `auth`'s `SERVICE_CLIENTS` entry for that caller AND that caller's own `SERVICE_CLIENT_SECRET` (secret, 32–256 chars; ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049). One per caller; `auth` mints its own credential in process and has none. Set as a Railway Shared Variable directly on the project — there is no 1Password item, so it is never in a template. |
| `AUTH_ISSUER` | all 4 resource servers (same public value) |
| `NOTIFY_INTERNAL_URL` | auth + refund-api + estimai-api — the three services that CALL notify-api |

Set each as a Railway **Shared Variable** once; each service then references
`${{shared.AUTH_AUDIENCE}}` etc. — one place to change, no hand-copying.

> `NOTIFY_INTERNAL_URL` was added to this list on 2026-08-10, after the private-
> domain trap below had silently broken it for the **third** time (auth and
> refund-api on 2026-07-31; estimai-api from the day specs/20260807-estimate-sharing shipped until it
> was noticed in production). It is one value used by three services and there
> is no reason for three independently-editable copies of it. Sharing it means
> the private-domain question is answered **once**, and a future service rename
> is a one-line fix rather than a silent, per-service outage nobody sees.

The per-service tables below reflect these conventions (a URL marked *internal*
follows bucket ①).

### `auth` service (Railway)

| Variable | Value / source | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/auth` | yes |
| `BETTER_AUTH_SECRET` | 1Password → `Employee / Paperclip - BETTER_AUTH_SECRET` (≥32 chars) | **yes** |
| `BETTER_AUTH_URL` | `<AUTH_URL>` — the JWT `iss`; must equal estimai-api `AUTH_ISSUER` | no |
| `GOOGLE_CLIENT_ID` / `_SECRET` | 1Password → `AIScream / OperAI - GOOGLE OAuth` | **yes** |
| `GITHUB_CLIENT_ID` / `_SECRET` | 1Password → `AIScream / OperAI - GITHUB OAuth` | **yes** |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | 1Password → `AIScream / OperAI Private Key` (RS256 PEM; `.pem` gitignored) | **yes** |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin; no wildcard/trailing slash) | no |
| `UI_HOME_URL` | `https://operai.welld.io/` (post-login fallback; origin ∈ ALLOWED_ORIGINS) | no |
| `AUTH_AUDIENCE` | **NEW (ADR 20260713-jwt-audience-claim-enforcement).** One suite-wide value (e.g. `operai-suite`), byte-for-byte identical to `estimai-api.AUTH_AUDIENCE` and `notify-api.AUTH_AUDIENCE`. Stamped as the JWT `audience` claim on every token `auth` mints; closes the cross-service token-replay gap now that `notify-api` is a second JWKS resource server. | no |
| `NOTIFY_INTERNAL_URL` | **NEW (specs/20260713-user-invitations, ADR 20260714-notify-api-email-channel-service-trust).** notify-api's Railway **private**-networking address — always write it as `${{shared.NOTIFY_INTERNAL_URL}}` (shared — see ③; its value is the literal `http://operai.railway.internal:8080`), **never** a hand-typed `notify-api.railway.internal` (that host does not exist — see the ⚠ box in § Cross-service wiring), and **not** `<NOTIFY_API_URL>` (the public domain). Base URL for the `POST /system/emails` call (`src/lib/notify.ts`). | no |
| `BOOTSTRAP_ADMIN_EMAIL` | email of the first admin (specs/20260713-auth-roles-permissions AC-6.1; gets `admin` on first sign-in). Set on Railway, not committed. | no |
| `APP_ACCESS_CHECK_FLOOR_MS` / `APP_ACCESS_CHECK_RATE_LIMIT` / `APP_ACCESS_CHECK_RATE_WINDOW_MS` | **NEW (specs/20260807-estimate-sharing, T1/T2).** In-process anti-enumeration floor + rate limit for `POST /authz/app-access-check` (ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt). Optional — code defaults `150`/`40`/`600000` apply if unset; set explicitly only to tune per environment. | no |
| `IDENTITIES_RATE_LIMIT` / `IDENTITIES_RATE_WINDOW_MS` | **NEW (specs/20260807-estimate-sharing, T27).** In-process rate limit for `POST /authz/users/identities` (reuses the same `rateLimiter.ts` module as the pair above, a second instance keyed separately). Optional — code defaults `120`/`600000` apply if unset. No response-time floor needed (ADR 20260807-live-identity-resolution-by-id-fail-soft — this endpoint leaks no existence signal the caller doesn't already hold). | no |
| `SERVICE_AUDIENCE` | **ADR 20261006-scoped-service-jwt-fourth-notify-caller, required since specs/20261013-notify-service-credentials (ADR 20261013-auth-mints-own-service-credential-in-process).** The `aud` stamped on scoped service JWTs, including `auth`'s own in-process credential for `POST /system/emails`: `${{shared.SERVICE_AUDIENCE}}`, byte-identical to `notify-api`'s and **different from `AUTH_AUDIENCE`** (startup exits otherwise). Startup also exits if it is absent. | no |
| `SERVICE_CLIENTS` | **ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049.** JSON object keyed by client id, one entry per caller that asks `POST /system/service-token` (`inventory-api`, `estimai-api`, `refund-api`): `{"inventory-api":{"secret":"${{shared.INVENTORY_SERVICE_CLIENT_SECRET}}","scope":"notifications.push emails.send"},…}` — full shape in § Notify credential rollout. Secret 32–256 chars; scopes are `notifications.push` and/or `emails.send`, each client only what it needs; client id is lower-case alphanumerics and single hyphens, and `auth` is reserved (ADR 20261013-auth-mints-own-service-credential-in-process). Never logged; a parse failure names the rule, never a value. Revoking a client = removing its entry (tokens already minted expire within 5 minutes). Verify the shared references resolved inside the JSON in the Variables tab. **specs/20261117-legal-entities:** the scope `legal-entities:read` (the registry's service read) is held by `crm-api` (added to its scopes) and by a new `letterhead-api` client, exactly that scope; `auth` refuses to start with a scope it does not know, so edit this variable only after the `auth` that knows it is live (§ Legal entities rollout). **specs/20261119-accounting:** the scope `accounting.reference.read` (accounting-api's `/system/v1/*` read) is held by `refund-api` only: its entry goes to `notifications.push emails.send accounting.reference.read`, after the new `auth` is live (§ Accounting release runbook, step 4). | **yes** |
| `SERVICE_TOKEN_SERVICE_LIMIT` | **NEW (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service).** Service tokens `POST /system/service-token` mints per calling service (the verified `system:<clientId>`) per window. Positive integer, optional, default `300` (steady state is about 3 per service per window). | no |
| `USERS_CONTACT_SERVICE_LIMIT` | **NEW (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service).** Contact lookups `POST /system/users/contact` answers per calling service per window. Only `system:notify-api` holds `users.contact`. Positive integer, optional, default `600`. | no |
| `SYSTEM_INVALID_CREDENTIAL_LIMIT` | **NEW (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service).** Requests with an INVALID credential per source address per window, one count shared by both routes. Positive integer, optional, default `20`. It never touches a valid credential. | no |
| `SYSTEM_RATE_WINDOW_MS` | **NEW (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service).** The one window of the three limits above and the value of `Retry-After` (in seconds) on their single 429. Integer >= 1000, optional, default `600000`. | no |
| `SERVICE_TOKEN_RATE_LIMIT` / `SERVICE_TOKEN_RATE_WINDOW_MS` | **RETIRED (specs/20261111-push-notifications US-7).** The old per-address limit (20 per 600000 ms) shared by the whole suite. Now ignored: `auth` starts, never reads the values and logs one warning naming them; env-doctor flags them on `auth` (`FORBIDDEN_VARS`). **Delete them from Railway once the new `auth` is live** (Step 0 command), and from the local direnv / 1Password source. Do not "reuse" them: an override sized for the old rule would no longer mean anything. | no |
| `DIRECTORY_RATE_LIMIT` / `DIRECTORY_RATE_WINDOW_MS` | **NEW (T5, ADR 20261006-user-directory-endpoint-capability-gated).** In-process limiter on `GET /authz/users/directory`, keyed by caller `sub`. Optional — defaults `60`/`600000`. | no |
| `NODE_ENV` | `production` | no |
| `PORT` | **set explicitly** (any consistent value, e.g. `8080`) so private-networking callers can reference `${{auth.PORT}}` (see § Private networking) — the service binds `env.PORT`, default 3001 if unset, but leaving it unset makes `${{auth.PORT}}` unresolvable | no |
| `ENABLE_TEST_AUTH` / `BETTER_AUTH_TRUSTED_ORIGINS` | **leave UNSET** (see Phase 1) | — |

**`auth` deploy constraint — NEW (specs/20260807-estimate-sharing, T13, plan.md
Risk R7):** `.railway/railway.ts` pins **one replica** — the
`APP_ACCESS_CHECK_*`/`IDENTITIES_RATE_*` limiters above are in-process
`Map`-based sliding windows, correct for exactly one running instance (same
shape as `notify-api`'s existing SSE constraint, § Topology above). Do not
enable autoscale/multiple replicas without first moving the limiter behind a
shared store (the module is written behind one interface specifically so
that swap doesn't require a rewrite).

### `estimai-api` service (Railway)

| Variable | Value | 
|---|---|
| `DATABASE_URL` | `…@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/estimai` |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`; **public** claim — bucket ②; use `${{shared.AUTH_ISSUER}}`) |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001/auth/jwks` (**not** the public `<AUTH_URL>`, **not** `/.well-known/jwks.json`) |
| `AUTH_AUDIENCE` | **ADR 20260713-jwt-audience-claim-enforcement.** `${{shared.AUTH_AUDIENCE}}` — same value as every service; `jwtVerify` pins `audience`; a token with a missing/wrong `aud` is rejected 401. | no |
| `AUTH_BASE_URL` | **NEW (specs/20260807-estimate-sharing, T13).** **internal** (bucket ①): `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` — base for the Bearer-forwarded `POST /authz/app-access-check` (fails CLOSED, ADR 20260807-third-party-app-access-decision-endpoint-forwarded-jwt) and `POST /authz/users/identities` (fails SOFT, ADR 20260807-live-identity-resolution-by-id-fail-soft) calls. **Required** — `src/lib/env.ts` `process.exit(1)`s if absent. | no |
| `NOTIFY_INTERNAL_URL` | **NEW (specs/20260807-estimate-sharing, T13).** **internal** (bucket ①): `${{shared.NOTIFY_INTERNAL_URL}}` (shared — see ③; its value is the literal `http://operai.railway.internal:8080`) — **not** `<NOTIFY_API_URL>`, the public domain. **Required.** | no |
| `SERVICE_CLIENT_ID` | **specs/20261013-notify-service-credentials (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired).** `estimai-api` — must be a key of `auth`'s `SERVICE_CLIENTS` (scope `notifications.push` only). **Required** — `src/lib/env.ts` `process.exit(1)`s if absent. | no |
| `SERVICE_CLIENT_SECRET` | **specs/20261013-notify-service-credentials (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired).** `${{shared.ESTIMAI_SERVICE_CLIENT_SECRET}}` — byte-identical to that entry's `secret`; 32–256 chars. **Required.** Used to ask `auth POST /system/service-token` (via `AUTH_BASE_URL`) for the 5-minute credential presented to `notify-api`. | **yes** |
| `SERVICE_AUDIENCE` | **specs/20261108-estimate-list-oversight (ADR 20261108-crm-pushes-deal-links-to-estimai).** `${{shared.SERVICE_AUDIENCE}}` — the `aud` of the service JWT crm-api posts deal-link notices with; byte-identical to `auth`'s, **different** from `AUTH_AUDIENCE`. Optional in `src/lib/env.ts`: unset, `POST /system/deal-link-notices` refuses every call and the "Deal" badge never changes. | no |
| `SHARE_LOOKUP_FLOOR_MS` / `SHARE_ADD_RATE_LIMIT` / `SHARE_ADD_RATE_WINDOW_MS` | **NEW (specs/20260807-estimate-sharing, T13).** Anti-enumeration floor (AC-1.2) + rate limit for `POST /estimates/{id}/collaborators`. Optional — code defaults `300`/`20`/`600000` apply if unset. | no |
| `NODE_ENV` | `production` · `MAX_ESTIMATE_BYTES`/`MAX_IMPORT_REQUEST_BYTES` optional (defaults) |

**`estimai-api` deploy constraint — NEW (specs/20260807-estimate-sharing, T13,
plan.md Risk R7):** `.railway/railway.ts` pins **one replica** — the
`SHARE_ADD_*` rate limiter AND the 60s in-process identity cache
(`src/lib/authClient.ts`) are both per-process state, correct for exactly one
running instance (same shape as `notify-api`'s existing SSE constraint, §
Topology above). A second replica would silently multiply the effective
`SHARE_ADD_RATE_LIMIT` by the replica count and serve a stale cached identity
from whichever replica answers. Do not enable autoscale/multiple replicas
without first moving both behind a shared store.

### `notify-api` service (Railway) — NEW (specs/20260713-notification-center)

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/notify` — **its own logical DB, `notify`, not `estimai`** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin) — also what the SSE stream's `Access-Control-Allow-Origin` echoes | no |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001/auth/jwks` (same endpoint every resource server uses — **not** the public `<AUTH_URL>`, **not** `/.well-known/jwks.json`) | no |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`; **public** claim — bucket ②; `${{shared.AUTH_ISSUER}}`) | no |
| `AUTH_AUDIENCE` | **ADR 20260713-jwt-audience-claim-enforcement.** `${{shared.AUTH_AUDIENCE}}` — byte-for-byte identical suite-wide; a drifted value here either rejects everything (401) or (worse, if unset elsewhere) allows cross-service token replay. | no |
| `MAX_STREAM_DURATION` | Seconds an SSE connection may stay open before the server forces a reconnect (ADR 20260713-sse-stream-auth-short-lived-ticket). Default `1800` (~30 min). | no |
| `EMAIL_ENABLED` | **NEW (specs/20260713-user-invitations).** `"true"` (exact string, case-insensitive) to make real Resend calls; any other value (including unset) stubs the send and still records an `EmailDelivery` row. Default `false` — safe for first deploys before the Resend domain is verified (see § Resend domain setup). | no |
| `RESEND_API_KEY` | **NEW (specs/20260713-user-invitations).** 1Password → `AIScream / OperAI - Resend API Key`. Required only when `EMAIL_ENABLED=true` (service refuses to start otherwise once enabled). | **yes** |
| `RESEND_FROM` | **NEW (specs/20260713-user-invitations).** Verified sending address on the SPF/DKIM-configured domain, e.g. `no-reply@operai.welld.io` (Risk R5). Required only when `EMAIL_ENABLED=true`. | no |
| `SERVICE_AUDIENCE` | **ADR 20261006-scoped-service-jwt-fourth-notify-caller, required since specs/20261013-notify-service-credentials (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired).** `${{shared.SERVICE_AUDIENCE}}` — byte-identical to `auth`'s, **different from `AUTH_AUDIENCE`** (startup exits otherwise; it also exits if absent). The `aud` of every credential accepted on `POST /system/notifications` (scope `notifications.push`) and `POST /system/emails` (scope `emails.send`), verified through the existing `AUTH_JWKS_URL`. There is no other credential: the retired `X-Internal-Token` header is refused (401), and a leftover shared-token variable is simply not read. | no |
| `PUSH_ENABLED` | **NEW (specs/20261111-push-notifications).** Literal `"true"` enables web push; anything else (including unset) is off. Default off. When on, the four email-notice variables below (`APP_BASE_URL`, `AUTH_BASE_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`) and the three `VAPID_*` are required or the service exits at startup. See § Push notifications. | no |
| `VAPID_PUBLIC_KEY` | **NEW (specs/20261111-push-notifications).** Base64url P-256 public key. Required when `PUSH_ENABLED=true`. | no |
| `VAPID_PRIVATE_KEY` | **NEW (specs/20261111-push-notifications).** Base64url P-256 private key; startup checks it derives the public key. Required when `PUSH_ENABLED=true`. 1Password, never in the repo. | **yes** |
| `VAPID_SUBJECT` | **NEW (specs/20261111-push-notifications).** `mailto:` or `https:` contact the push services may use. Required when `PUSH_ENABLED=true`. | no |
| `PUSH_EXCLUDED_ORIGINS` | **NEW (specs/20261111-push-notifications).** Optional CSV of origin apps (`OriginAppSchema` values) whose notifications are never pushed. Default empty. | no |
| `NODE_ENV` | `production` | no |

**`notify-api` deploy constraints (do not relax without reading plan.md Risk
R2):** `.railway/railway.ts` pins **one replica** — the in-process EventBus
fan-out and the in-process stream-ticket store are correct for exactly one
running instance; a second replica silently splits both. Region **must** be
`europe-west4` (data residency — notification title/body may name
clients/estimates) and the service must never log request/response bodies
(reuses `estimai-api`'s method+path+status-only `hono/logger` posture, enforced
in `notify-api/src/index.ts` and called out in `notify-api/Dockerfile`).

### `refund-api` service (Railway) — NEW (specs/20260716-refund-service, T19)

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/refund` — **its own logical DB, `refund`** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin) **+ admin-ui's own origin** (specs/20260720-mileage-rate, T8: `https://admin.operai.welld.io` — or its Preview URL, see § Phase 3 — for the `/rates` Mileage Rates screen's direct cross-origin call; composed-shell traffic is already covered by the shell origin alone) | no |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001/auth/jwks` (same endpoint every resource server uses — **not** the public `<AUTH_URL>`, **not** `/.well-known/jwks.json`) | no |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`; **public** claim — bucket ②, `${{shared.AUTH_ISSUER}}`). Pinned as the JWT `iss` in `jwt.middleware.ts`. NOTE: `refund-api`'s `GET /authz/resolve` call does **not** use this — it uses the separate `AUTH_BASE_URL` below (`resolveClient.ts`). | no |
| `AUTH_BASE_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001` — the base `refund-api`'s `authzMiddleware`/`resolveClient.ts` builds `GET /authz/resolve` against (ADR 20260716-refund-api-authorization-enforcing-resource-server). A *call*, so internal DNS; distinct from `AUTH_ISSUER`. (This is the var that was `localhost` in prod → 503.) | no |
| `AUTH_AUDIENCE` | **ADR 20260713-jwt-audience-claim-enforcement.** `${{shared.AUTH_AUDIENCE}}` — byte-for-byte identical suite-wide; `refund-api` is the THIRD JWKS resource server on this shared value. | no |
| `NOTIFY_INTERNAL_URL` | notify-api's **private**-networking address — always `${{shared.NOTIFY_INTERNAL_URL}}` (shared — see ③; its value is the literal `http://operai.railway.internal:8080`), **never** a hand-typed `notify-api.railway.internal` (see the ⚠ box in § Cross-service wiring) — for the decision→notification push (`POST /system/notifications`, T13, ADR 20260716-system-notifications-cross-user-trigger). **Not** `<NOTIFY_API_URL>` (the public domain). | no |
| `SERVICE_CLIENT_ID` | **specs/20261013-notify-service-credentials (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired).** `refund-api` — must be a key of `auth`'s `SERVICE_CLIENTS` with scopes `notifications.push` and `emails.send`. **Required** — `src/lib/env.ts` exits if absent. | no |
| `SERVICE_CLIENT_SECRET` | **specs/20261013-notify-service-credentials (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired).** `${{shared.REFUND_SERVICE_CLIENT_SECRET}}` — byte-identical to that entry's `secret`; 32–256 chars. **Required.** For the decision push (`/system/notifications`) and the batch email (`/system/emails`). | **yes** |
| `REFUND_S3_ENDPOINT` / `REFUND_S3_REGION` / `REFUND_S3_BUCKET` / `REFUND_S3_ACCESS_KEY_ID` / `REFUND_S3_SECRET_ACCESS_KEY` | EU-region S3-compatible object storage for receipt attachments (ADR 20260716-eu-object-storage-refund-attachments) — `REFUND_S3_REGION` validated against an EU allowlist at startup once T9 lands. **NOT YET PROVISIONED as of T19** — no bucket exists, no 1Password item exists. See this task's final report / § "Object storage — provisioning" below before T9. | **yes** |
| `REFUND_APP_BASE_URL` | **NEW (T14, specs/20260719-refund-monthly-processing, ADR 20260719-refund-batch-signed-link-email-delivery).** Absolute base URL of the shell-hosted app — **the shell's own public origin**, e.g. `https://operai.welld.io`, same value as `refund-api.ALLOWED_ORIGINS`/every other backend's shell-origin row — **not** `<REFUND_API_URL>`. Used to build the compiled-batch email's in-app deep link `${REFUND_APP_BASE_URL}/refund/batches/:id`; the email never carries a raw presigned S3 URL. | no |
| `ACCOUNTING_INTERNAL_URL` | **NEW (specs/20261119-accounting, T17).** accounting-api's **private**-networking address, `http://${{accounting-api.RAILWAY_PRIVATE_DOMAIN}}:${{accounting-api.PORT}}` (port 8089), never its public domain: refund-api reads Accounting's ledger accounts, VAT codes and monthly exchange rates live over `/system/v1/*` with its own service JWT, and the token must not leave the project. **Required: `src/lib/env.ts` exits 1 without it**, so a refund-api deployed before the variable is set keeps its previous deployment (the healthcheck never passes). The scope `accounting.reference.read` on refund-api's `SERVICE_CLIENTS` entry is a separate step, made only after the new `auth` is live (§ Accounting release runbook, step 4). | no |
| `NODE_ENV` | `production` | no |

**`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — REMOVED (specs/20260722-refund-settings,
AC-4.1).** Do **NOT** set this on the `refund-api` Railway service — the
running service does not read, require, or validate it at all anymore. The
accounting-distribution-email is now an admin-managed, append-only
`refund_setting` row (ADR 20260722-refund-settings-append-only-self-auditing-store/0029), viewable/editable in Admin > Refund
(`settings:read`/`settings:manage`). See the cutover runbook immediately
below for moving the currently-deployed value across.

**`REFUND_FX_SOURCE` — REMOVED (specs/20261119-accounting, T23).** Do **NOT** set it on `refund-api`: the monthly
exchange rates, their on-demand fetch from the federal source and the switch that turns the fetch off moved to
`accounting-api` (variable `ACCOUNTING_FX_SOURCE`, § `accounting-api` service). refund-api no longer fetches a rate and no longer
needs outbound HTTPS to `www.backend-rates.bazg.admin.ch`. A leftover value is ignored by the running service, which starts
normally, but it makes `off` look as if it still stopped an outbound call from refund-api: `mise run env:doctor` flags it by name,
so remove it in the release runbook's step 2. (Introduced by specs/20261118-refund-accounting-export, T9, ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-outbound-fetch-is-hardened.)

**`refund-api` deploy notes:** declared at one replica in `.railway/railway.ts`
like every service, but with no correctness reason to stay there (unlike
`notify-api`) — its `authzMiddleware` in-process cache (T6, ADR 20260716-refund-api-authorization-enforcing-resource-server) is a
per-replica performance optimization with a 30s TTL backstop, not a
correctness-dependent shared store, so raising its replicas in the file is fine. Region **must** be
`europe-west4` (data residency — financial figures + receipt-attachment
metadata that may carry PII, ADR 20260716-eu-object-storage-refund-attachments) and the service must never log
request/response bodies (same `hono/logger` posture as every other backend,
enforced in `refund-api/src/index.ts`, called out in `refund-api/Dockerfile`).

**Cutover — accounting-distribution-email setting (T5, specs/20260722-refund-settings,
D7).** A one-time, OPERATOR-RUN step, run **once**, immediately after this
deploy lands (the migration that creates `refund_setting` — T2 — must already
be applied). It is deliberately **not** a schema migration carrying the value
and **not** a server startup env read (AC-4.1 stays strictly honored — the
*running* `refund-api` process never touches
`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`) — it is an idempotent maintenance
script an operator invokes explicitly, passing the value themselves:

```bash
cd refund-api
DATABASE_URL=<refund-api's production DATABASE_URL> \
  bun run settings:seed <the value currently deployed as REFUND_ACCOUNTING_DISTRIBUTION_EMAIL>
```

1. **Before removing the env var from Railway**, read the current
   `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` value off the `refund-api` service
   (Railway dashboard → Variables).
2. Run the command above against **production's** `DATABASE_URL` (the `refund`
   database), passing that value. The script (`refund-api/scripts/seed-setting.ts`)
   appends ONE `refund_setting` row for key `accounting-distribution-email`
   **only if the key has no rows yet** — `createdByUserId:"system:settings-cutover"`,
   `createdByEmail:"system-cutover@welld.ch"` (a documented, honest first audit
   row — never attributed to a real admin who didn't actually make the
   change). A second run (accidental re-run, redeploy, CI retry) is a
   guaranteed no-op — it never appends a duplicate or overwrites anything
   (the table is append-only at the DB level, ADR 20260722-refund-settings-append-only-self-auditing-store).
3. Verify: `GET /settings/accounting-distribution-email` (as an admin/
   `refund-admin`, via Admin > Refund or the API directly) shows
   `configured:true` with the expected value and `updatedByEmail:"system-cutover@welld.ch"`.
4. **Only after verifying step 3**, remove `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`
   from the `refund-api` Railway service's variables (it is already unused by
   the running code — this step is housekeeping, not a functional dependency).

There is no cron/scheduled version of this script and none should ever be
added (ADR 20260714-invitation-lifecycle-derived-expiry-state posture, mirrors the mileage-rate/settings "derived-on-read,
never scheduled" lineage) — it is a single deliberate command run by a human
at cutover time, never a recurring job.

**Release runbook — refund accounting export (specs/20261118-refund-accounting-export; the release itself is task T40).**
**Amended by specs/20261119-accounting: steps 1–4 stand, but the lists, the script and its inputs moved, so step 5 is now
the one in § Accounting release runbook (step 7 there) and the two releases are cut together (D21), never one after the other.**
The feature adds a migration, a permission, a shell formatter and one operator-run script. Do these in order; each step
names the check that lets the next one start.

*Before anything:* T39 (the owner's task, the accounting sign-off) gates T40, and T50 of specs/20261119-accounting does the same
for what moved. The accounting sign-off of 2026-11-19 settled the lists and the export format, so the release now has **three
inputs**, and each is checked before step 5:
- **The seed** (Accounting's catalog): `accounting-api/scripts/data/seed.welld-ch.json`, loaded by `seed:welld-ch`, holds the signed-off
  **19 ledger accounts** (among them 5902, 5903, 6501, 2620.1, and 7122 "Spese da riaddebitare a WellD Italia") and **6 VAT codes**
  (`IPM81`, `IPM77`, `IP00`, `BZM81`, `IPM26`, `IPM38`; there is no `IMP81`, `IMP77` or `NOVAT`). The labels of the VAT codes are the
  operator's, written from the rates, until accounting confirms them; a later change is a new code and a deactivation in the app.
- **The defaults**: `refund-api/scripts/data/accounting-defaults.welld-ch.json` (the former `accounting-seed.welld-ch.json` no longer
  exists), read by `accounting:release --defaults <json>` (the old `--seed` option is gone). It holds the default **account** of each of
  the **14 expense types** and nothing else: there is no VAT default and no foreign-currency VAT code, and the script refuses a file that
  carries either. Settings changes them afterwards.
- **The 2026 baseline list** (`--offsets <csv>`, **required**): the last receipt number each employee issued by hand in 2026, so that
  Refund continues the paper register (an employee whose last number is 81 gets `MC26/082` next). It is a CSV `email,year,lastIssuedSeq`,
  year 2026 only, one row per employee, and a **header-only file** (`email,year,lastIssuedSeq`) is the explicit statement that no employee
  has a hand-issued number. It names people, so it is a release input **kept outside the repository** (see step 5, personal data), never
  committed. To derive it from the accounting register, export the register's sheet to CSV (outside the repository, with a `receiptNumber`
  column and optionally `expenseDate`) and run `bun run receipt-baseline:from-register --register <csv>` in `refund-api/` (T64): it prints
  the highest 2026 sequence per initials and the anomalies (duplicates, wrong-year numbers, malformed cells) and reads no name or email. The
  operator maps initials to email addresses (two employees may share initials: that needs a person) and writes the list; accounting
  confirms the anomalies and the list before the dry run;
- the source of the exchange rates (now `ACCOUNTING_FX_SOURCE` on accounting-api): the AFC/ESTV's monthly average rates for VAT, read
  from the "XML-File" the BAZG serves. Check the channel once per release, from a networked machine (never in CI):
  `cd accounting-api && ACCOUNTING_LIVE_RATES=1 bun test src/rates/afc.live.test.ts` expects EUR 0.9246 for 2026-03. Without the flag the
  test is skipped.

The export is an **Excel workbook** (`.xlsx`: one sheet, header `Date, Description, Debit, Credit, Amount, Currency, Tax, Note`;
`refund-api/src/accounting/exportFormat.ts` holds every choice, a change bumps `FORMAT_VERSION`, now 2, and the golden files in
`src/accounting/fixtures/`).

The defaults are applied only where Refund holds no row, a receipt number is never reissued, and the classification of a numbered line of
a paid request can never change, so a wrong list is corrected in Accounting (the catalog) and in Refund's Settings (the defaults)
afterwards, for new approvals and for unpaid lines, not for those paid ones.

1. **auth.** Its `preDeploy` (`db:release`) migrates and seeds the permission catalog, so `request:reclassify` exists
   (granted to the holders of `request:approve`, with the same conditions: if a role's approve carries `self-approval:
   deny`, its reclassify does too, and its holders cannot classify the requests they submitted themselves, 403
   `self_approval_forbidden`). The seed never rewrites an existing `reclassify` rule: whenever an admin later adds or
   removes `self-approval: deny` on a role's `request:approve`, mirror it on that role's `request:reclassify` (refund-api
   refuses the owner anyway when either grant is self-restricted, so a missed mirror fails closed). Check: `auth` is live on the new version. If refund-api goes first,
   changing a classification after approval answers 403 until auth is live; nothing else breaks.
2. **The shell** (Vercel), which carries `formatMonth` from `@operai/ui`. Check: `curl -s https://operai.welld.io/version.json`
   shows the new version. refund-ui shows months as `YYYY-MM` until it is live.
3. **refund-api** (Railway). `preDeploy` runs `bun run db:deploy`, which applies the accounting migration
   (`refund-api/prisma/migrations/20261119090000_accounting_export`). Check: `GET /health` reports the new version. From now
   on every approval answers 409 `accounting_release_pending`, and the UI says so, until step 5.
4. **refund-ui** (Vercel).
5. **Run the release script, once**, from a checkout at the released commit, **after accounting-api is live and has its catalog**
   (§ Accounting release runbook, steps 3–6): the script reads Accounting first and exits 2, writing nothing, if it cannot
   (AC-7.4). **The refund-api Docker image does not contain `scripts/`** (its Dockerfile copies `src` and `prisma` only), so this cannot
   be run inside the Railway service: it runs from a checkout (`bun install` and `bun run db:generate` in `refund-api/` first: the
   Prisma client is generated, not committed) under `railway run`, which injects refund-api's own variables (the service client
   included), with the three overrides the exact commands of § Accounting release runbook, step 7, spell out: the `refund` database through
   its public connection string, and accounting-api and auth through their public hosts, because the private ones do not resolve from a laptop.
   The arguments are the ones this runbook names:

   ```bash
   bun run accounting:release --dry-run                       # reads Accounting, writes nothing; prints what the real run would do
   bun run accounting:release --dry-run --offsets <file.csv>  # the dry run WITH the baseline list: this is the one accounting reads
   # accounting reads the report: numbers per employee and year, lines left unclassified, rate pending, Italian lines left alone
   bun run accounting:release --offsets <file.csv>            # the real run, one transaction, with the same arguments as the dry run
   # without --offsets (a dry run too) nothing is written and the exit code is 3
   # --defaults <json> replaces the committed defaults file (scripts/data/accounting-defaults.welld-ch.json), e.g. for a rehearsal
   ```

   - **Personal data (security review S-03, S-04).** The offsets file names employees by email: keep it **outside the
     repository** (for example in the operator's home directory), never `git add` it, and delete it after the run. The
     script prints a warning if the path is inside a git worktree, and `.gitignore` refuses `**/*offsets*.csv` and
     `**/accounting-offsets*` as a second line of defence, not as the rule. Run the script **only from an operator
     shell**, never from CI or any job whose output is shipped to a log service: the report is financial and personal
     data. It names an employee as `<initials> · <first 8 characters of the user id>` (for example `MC · 1a2b3c4d`); add
     `--show-emails` only when you need the full address, in a terminal that is not logged. Errors mask the email as
     `m***@welld.ch`.
   - `--dry-run` runs everything and rolls it back; the report is the exact result of the real run, and its marker line
     says `Release marker written: no (dry run: the real run would write it)`: a dry run never releases, and every
     approval still answers 409 `accounting_release_pending` until the real run. Read the
     "left unclassified" list: those legacy lines get a number and keep what resolved, but their export stays blocked
     until accounting sets the missing value (a holder of `request:reclassify`), and a line of an already paid request cannot be
     reclassified at all. Set the type defaults first if that is not acceptable.
   - `--offsets` is **required** (AC-7.4). Without it the run writes nothing at all (no number, no default, no marker), prints "the list of last
     hand-issued 2026 numbers is missing: nothing was numbered" and **exits 3**; approvals stay refused, so no number is consumed meanwhile, and a
     rerun with the list is safe. A dry run without it reads Accounting, writes nothing, reports `BLOCKED: list missing` and exits 3 too. Rows are
     refused (exit 1, nothing written) when the year is not 2026, an email appears twice, the sequence is not 1 to 99999, or the employee already has
     2026 numbers with another start; a baseline can only be loaded before an employee's first 2026 number. The report shows, per row, the initials
     Refund will use: **check them against the register's** (a wrong set of initials would continue the wrong series), and an employee who is "not yet in
     Refund" still gets the baseline for their first approval.
   - A second run changes nothing (no second marker). A failure anywhere rolls the whole run back
     (`accounting:release failed, nothing was changed: …`, exit code 1). **Exit code 2** is Accounting unreadable (the read did not come back clean and
     complete: accounting-api not live or not reachable at `ACCOUNTING_INTERNAL_URL`, or the scope `accounting.reference.read` not yet granted to refund-api): the message is `Accounting cannot be read: nothing was
     numbered or classified; run again later`, and nothing was written, not a number, a copy, a default or the marker. Fix the cause and run it again. Accounting is read **first**, so
     when both problems exist the exit code is 2, not 3. **Exit code 3** is the baseline list missing (above).
   - File the report. Check afterwards: an approval no longer answers 409 `accounting_release_pending`, and a compiled batch's
     export card says how many rows it will export.

**Outbound HTTPS to `www.backend-rates.bazg.admin.ch` — moved to accounting-api (specs/20261119-accounting).** refund-api no longer
calls that host and `REFUND_FX_SOURCE` is gone (§ `refund-api` variables). With `ACCOUNTING_FX_SOURCE=bazg` (the default) it is
accounting-api that calls it, on demand only, 10 s at most for a manager's fetch and 6 s for a consumer's, to read the monthly average rates
(§ `accounting-api` service). `.railway/railway.ts` declares no egress rule, so nothing is to be configured; if egress is ever restricted,
the host must be allowed for accounting-api, or `ACCOUNTING_FX_SOURCE=off` set and the rates typed in Accounting. A failed fetch is never an
error page: the month is a "missing rate" and blocks the export of a batch that needs it.

Pushing `main` starts every deploy at once (RELEASING.md): when the order above matters, let each step finish before
the next is allowed to start, or accept the fallbacks named in steps 1 and 2. The e2e suite runs the script itself
(AGENTS.md § Running locally, `E2E_SKIP_REFUND_ACCOUNTING_RELEASE`); production never does.

**Object storage — provisioning (DONE).** ADR 20260716-eu-object-storage-refund-attachments named AWS S3 `eu-south-1`
(Milan) or Scaleway `fr-par` as primary candidates, leaving "the exact vendor
an implementation-time choice within this allowlist." What was actually
provisioned is a **Railway S3-compatible bucket** — a custom, non-AWS endpoint
(`t3.storageapi.dev`), which is why `src/lib/s3Residency.ts` is endpoint-aware
and `REFUND_S3_EU_ENDPOINT_HOSTS` exists at all. The five `REFUND_S3_*` vars
are set directly on the `refund-api` Railway service (they are NOT in
`deploy.sh` and were long absent from
`tools/env-doctor/templates/production/refund-api.env`).

> **Residency caveat — verify, don't assume.** `t3.storageapi.dev` is a
> generic multi-region Railway storage host; allowlisting that suffix in
> `REFUND_S3_EU_ENDPOINT_HOSTS` does **not** by itself prove the bucket sits
> in the EU — the startup guard checks the *endpoint host*, not the geography.
> `REFUND_S3_REGION` is `ams`, which reads as Amsterdam and is consistent with
> ADR 20260716-eu-object-storage-refund-attachments, but it is a vendor string this repo cannot verify. Given data
> residency is a hard requirement (CLAUDE.md § Data residency), confirm the
> bucket's region once in the Railway dashboard and treat that as the record.

Current production values (the two credential vars are secrets, held only on
the Railway service — there is still no 1Password item for them):

| Var | Value |
|---|---|
| `REFUND_S3_ENDPOINT` | `https://t3.storageapi.dev` |
| `REFUND_S3_REGION` | `ams` |
| `REFUND_S3_BUCKET` | `refund-receipt-g0jy7xar4e` |
| `REFUND_S3_EU_ENDPOINT_HOSTS` | `t3.storageapi.dev` |
| `REFUND_S3_ACCESS_KEY_ID` / `REFUND_S3_SECRET_ACCESS_KEY` | secret |

**Receipt bucket CORS — MANDATORY, and easy to miss.** The browser uploads
receipts **directly to the bucket**, never through refund-api (ADR 20260716-eu-object-storage-refund-attachments):
`refund-ui/src/lib/attachmentsApi.ts`'s `uploadToPresignedPost` issues a
cross-origin `POST` from the shell origin straight to the presigned URL. The
bucket must therefore carry a CORS rule naming that origin, or the browser
blocks the upload and the user sees only "Upload failed". This bit us in
production on 2026-07-31: the bucket had **no** CORS configuration at all, and
nothing in this repo had ever set one.

Downloads are NOT affected and do not need a rule — `AttachmentDownloadLink`
uses `window.open`, a top-level navigation, which CORS does not govern. `GET`
is included below only to keep a future fetch-based preview from breaking.

Apply with any S3 client pointed at `REFUND_S3_ENDPOINT` (`PutBucketCors`):

```json
[
  {
    "AllowedOrigins": ["https://operai.welld.io"],
    "AllowedMethods": ["POST", "GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Location"],
    "MaxAgeSeconds": 3000
  }
]
```

> **The upload passes THREE independent gates — all must be right, and all
> three fail identically ("Upload failed") from the user's side:**
> 1. the shell CSP's `connect-src` must list the bucket origin (§ Phase 3);
> 2. the bucket must carry the CORS rule below;
> 3. refund-api's presigned POST policy must accept the file (size ≤10 MiB,
>    `Content-Type` in `pdf`/`jpeg`/`png` — `src/lib/storage.ts`).
>
> Note that the compiled-batch PDF is NOT a counter-example when uploads are
> broken: refund-api writes it server-side with `PutObject` (ADR 20260719-refund-batch-pdf-generation-pdf-lib), so it
> passes none of these gates. A working batch PDF tells you the credentials
> and endpoint are fine — nothing more.

Only the **shell** origin belongs here: `refund-ui` is a federated remote
reached through the shell (ADR 20260709-suite-frontend-module-federation), so the browser `Origin` on the upload is
always the shell's — this is deliberately narrower than refund-api's own
`ALLOWED_ORIGINS` (which carried admin-ui for the `/rates` + `/settings`
calls until they moved to refund-ui, ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition amendment). Add a `http://localhost:5173` entry ONLY to a
non-production bucket; `refund-api/.env.example` points local dev at the real
bucket, so uploads will not work locally until you do.

### `inventory-api` service (Railway) — NEW (specs/20261006-hardware-inventory)

Authoritative list: `inventory-api/src/lib/env.ts` (validated at startup, exits 1 on
any miss). Committed contract: `tools/env-doctor/templates/production/inventory-api.env`.

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/inventory` — **its own logical DB, `inventory`** (create it before the first deploy; its `preDeploy` in `.railway/railway.ts` runs `bun run db:deploy`) | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin only; a `*` fails startup). inventory-ui is a federated remote, so the browser Origin is always the shell's. | no |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks` | no |
| `AUTH_ISSUER` | `<AUTH_URL>` — **public** claim, bucket ② (`${{shared.AUTH_ISSUER}}`) | no |
| `AUTH_AUDIENCE` | `${{shared.AUTH_AUDIENCE}}` — the fourth resource server on this value (ADR 20260713-jwt-audience-claim-enforcement) | no |
| `AUTH_BASE_URL` | **internal** (bucket ①): `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` — base for `GET /authz/resolve` (ADR 20260716-refund-api-authorization-enforcing-resource-server; fails **closed**, 503), `POST /authz/users/identities` (ADR 20260807-live-identity-resolution-by-id-fail-soft; fails soft) and `POST /system/service-token` (ADR 20261006-scoped-service-jwt-fourth-notify-caller) | no |
| `NOTIFY_INTERNAL_URL` | **internal**: `${{shared.NOTIFY_INTERNAL_URL}}` (literal `http://operai.railway.internal:8080`) — never the public domain, never a hand-typed `notify-api.railway.internal` | no |
| `SERVICE_CLIENT_ID` | `inventory-api` — must be a key of `auth`'s `SERVICE_CLIENTS` | no |
| `SERVICE_CLIENT_SECRET` | `${{shared.INVENTORY_SERVICE_CLIENT_SECRET}}` — byte-identical to that entry's `secret`; at least 32 chars | **yes** |
| `INVENTORY_S3_ENDPOINT` / `_REGION` / `_BUCKET` | the invoice bucket — its **own** bucket and credentials, never refund-api's. The bucket MUST be private (every read is a ~60 s presigned GET minted after the entity-scope check). | no |
| `INVENTORY_S3_ACCESS_KEY_ID` / `INVENTORY_S3_SECRET_ACCESS_KEY` | credentials of that bucket, set directly on the Railway service (no 1Password item) | **yes** |
| `INVENTORY_S3_EU_ENDPOINT_HOSTS` | comma-separated EU endpoint host suffixes. Consulted only for a non-AWS endpoint, where the region string is an opaque placeholder; **empty, unset or non-matching on a non-AWS endpoint exits 1**. An AWS endpoint instead requires an EU `INVENTORY_S3_REGION`. | no |
| `PORT` | `8083` — set explicitly so `${{inventory-api.PORT}}` resolves, and make the public domain target this port | no |
| `NODE_ENV` | `production` | no |

**Deploy notes.** Declared at one replica, with no correctness reason to stay there:
authorization results are cached per replica with a short TTL backstop and the
service-token cache is per-process; neither is a correctness-dependent shared store. `.railway/railway.ts` pins region `europe-west4-drams3a`. The
service handles financial figures and personal data (who holds which device), so it
must never log request/response bodies (method + path + status only,
`inventory-api/src/lib/logger.ts`).

**Invoice bucket CORS and CSP — MANDATORY.** Like receipts (§ `refund-api` above), the
browser uploads invoices **directly to the bucket** from the shell origin (presigned
POST; `pdf`/`jpeg`/`png`, size capped by the policy). The bucket needs a CORS rule
naming `https://operai.welld.io` (`POST`, `GET`; expose `ETag` and `Location`), AND the
shell CSP `connect-src` must list the bucket's origin. `shell/vercel.json` currently
lists `https://t3.storageapi.dev` (the refund bucket's host), which covers an inventory
bucket only if it is served from the same host and addressing style. **If the
inventory bucket's origin differs (virtual-hosted style, another host, or another
provider), add it to `connect-src` and redeploy the shell**, or every invoice upload
fails in the browser with no server-side trace. All three gates (CSP, bucket CORS,
presigned-POST policy) fail identically as "upload failed".

**Local dev.** `compose.yaml` creates the dev buckets in MinIO (`:9000`);
`inventory-api/.env.example` documents the local `INVENTORY_S3_*` values.

#### Rollout checklist

`infra/deploy.sh` automates the Railway variables that need no secret and no
provisioned resource (`inventory-api`: `DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_ISSUER`,
`AUTH_JWKS_URL`, `AUTH_BASE_URL`, `AUTH_AUDIENCE`, `NOTIFY_INTERNAL_URL`, `SERVICE_CLIENT_ID`,
`PORT`, `NODE_ENV`; and, when exported, `SERVICE_AUDIENCE` on `auth` + `notify-api`), creates
the `inventory` logical database, and — with `--vercel` — syncs the shell's
`INVENTORY_REMOTE_URL` / `VITE_INVENTORY_API_URL` and `inventory-ui`'s `SHELL_REMOTE_URL`.
It does **not** set `INVENTORY_S3_*`, `SERVICE_CLIENT_SECRET` or `auth`'s `SERVICE_CLIENTS`
(steps 2-4 below stay manual), and skips the `inventory-api` deploy trigger with a warning
(names only) until those exist. For `refund-api` and `estimai-api` it likewise sets
`SERVICE_CLIENT_ID` but checks by name that `SERVICE_CLIENT_SECRET` exists and skips their
deploy trigger until it does; it warns when `auth` has no `SERVICE_CLIENTS`.
`infra/check.sh` asserts the service, the remote, the shell CSP pins, the service-token
endpoint and the gated-route 401 once DNS exists (its default hostnames are assumptions).

1. **Order matters: `auth` and `notify-api` first, `inventory-api` last.** Deploying
   `inventory-api` before `auth` has `SERVICE_CLIENTS` makes every push a silent 401
   (the push is best-effort and never rolls back a mutation); deploying `auth` with
   `SERVICE_CLIENTS` but no `SERVICE_AUDIENCE` exits at startup.
2. Generate the client secret (at least 32 random characters) and add the Railway
   **Shared Variables** `SERVICE_AUDIENCE` (a value different from `AUTH_AUDIENCE`)
   and `INVENTORY_SERVICE_CLIENT_SECRET`. Never paste either into the repo or a PR.
3. Set on **`auth`**: `SERVICE_AUDIENCE`, `SERVICE_CLIENTS` (JSON above). Set on
   **`notify-api`**: `SERVICE_AUDIENCE`. Redeploy both and confirm they boot.
   `auth`'s `preDeploy` (`db:release`) seeds the `inventory` catalog and the
   `inventory-manager` / `accounting` / `admin` grants.
4. Railway: create the `inventory` database, the `inventory-api` service (root
   `inventory-api`, Dockerfile build, region `europe-west4`), its variables (table
   above), a **custom domain** `inventory-api.operai.welld.io` targeting port `8083`,
   and the private invoice bucket with its CORS rule.
5. Vercel: create the `inventory-ui` project (Root Directory `inventory-ui`, Vite)
   with domain `inventory.operai.welld.io` and `SHELL_REMOTE_URL=https://operai.welld.io/remoteEntry.js`.
   On the **`shell`** project add `INVENTORY_REMOTE_URL=https://inventory.operai.welld.io/remoteEntry.js`
   and `VITE_INVENTORY_API_URL=<INVENTORY_API_URL>` (§ Frontend build-time vars), then
   **redeploy the shell** (both are build-time).
6. DNS for the two new hostnames (`inventory` and `inventory-api` under `operai.welld.io`).
7. Run `mise run env:doctor -- --env production`, and `--live` once the service exists.
8. Assign people to `inventory-manager` / `accounting` in Admin. The two launch
   depreciation rules come with the first migration; **confirm the wellD IT rule
   (spec O1) before the first `welld_it` asset is registered.**
9. Legacy register import — below.

#### Legacy register import (one-off, specs/20261006-hardware-inventory US-12)

`inventory-api/scripts/import-legacy.ts` imports the legacy Excel register for
`welld_ch`. It is a script, not a route. **Dry-run is the default and writes nothing.**

```bash
cd inventory-api
# 1. Dry run: reads the sheet, plans every row, prints counts and row numbers (no row content).
bun scripts/import-legacy.ts --file <register.xlsx> [--user-map <users.json>]

# 2. Apply: ONLY with the opening balance accounting confirmed for 2026, in integer cents.
#    Refused (nothing written) unless the sum of book values at 31.12.2025 equals it exactly.
bun scripts/import-legacy.ts --file <register.xlsx> [--user-map <users.json>] \
  --expected-opening-cents <cents> --apply
```

- `--user-map` is **optional**. It is a JSON file you build by hand from the user directory:
  `[{"id":"<auth user id>","name":"<full name>"}, ...]`; an assignee text becomes the
  holder only if it matches exactly one entry (case, accents and spacing aside).
  Without it no assignee is matched: every asset comes in as stock, flagged "to verify",
  with the sheet's assignee text in its location note, and a manager assigns the holders
  afterwards (each assignment then waits for the employee's confirmation). Because an apply
  cannot be repeated, decide this before `--apply`: holders can only be imported as
  already-confirmed in the one run that carries the map.
- It reads the target database from the environment, as the service does. Run it
  against production only from a trusted workstation, never committing a connection
  string. The workbook is company data and untrusted input: keep it out of the repo.
- The tables it writes (`asset_year_figure`, `fiscal_year`, `asset_event`) are
  **append-only at the database**, so a wrong apply cannot be corrected later. It is
  all-or-nothing in one transaction under the entity lock, a second run on an entity
  that already holds the import writes nothing, and an unreadable row stops the apply.
  Exit codes: `0` done or clean dry run, `1` refused, `2` bad usage.
- The opening-balance figure (spec O3) is an accounting decision. Do not invent it, and
  do not paste it into the repo or a PR.

### `meetings-api` service (Railway) — NEW (specs/20261104-meetings)

Authoritative list: `meetings-api/src/lib/env.ts` (validated at startup, exits 1 on any miss).
Committed contract: `tools/env-doctor/templates/production/meetings-api.env`. Port **8085**, DB
`meetings`, domain `meetings-api.operai.welld.io`; the remote is `meetings-ui`
(`meetings.operai.welld.io`, local port 5180). **One replica** (declared in `.railway/railway.ts`) — the job runner
(`MEETINGS_WORKER=on`) runs inside the process (ADR 20261104-durable-job-runner-work-queued-state-derived).

Everything below is a **checklist for a person**: nothing in this section has been provisioned yet.

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `…/meetings` — **its own logical DB** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell only; meetings-ui is a federated remote) | no |
| `AUTH_JWKS_URL` / `AUTH_BASE_URL` | internal, `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}…` | no |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` | public claim `${{shared.AUTH_ISSUER}}` / `${{shared.AUTH_AUDIENCE}}` (the sixth resource server on this value) | no |
| `NOTIFY_INTERNAL_URL` | `${{shared.NOTIFY_INTERNAL_URL}}` | no |
| `CRM_API_URL` | internal, `http://${{crm-api.RAILWAY_PRIVATE_DOMAIN}}:${{crm-api.PORT}}` — the host contract (ADR 20261104-meeting-host-contract-resolve-and-notices) | no |
| `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` | `meetings-api` / `${{shared.MEETINGS_SERVICE_CLIENT_SECRET}}` (≥ 32 chars, byte-identical to its `SERVICE_CLIENTS` entry) | secret: yes |
| `MEETINGS_S3_ENDPOINT` / `_REGION` / `_EU_ENDPOINT_HOSTS` | the audio bucket; a non-AWS endpoint needs its host in the EU list or the service exits 1 (ADR 20260716-eu-object-storage-refund-attachments lineage) | no |
| `MEETINGS_S3_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | set by reference to the Railway bucket by `provision-tool.sh --bucket`; **its own bucket and credentials**, never crm's or refund's | secrets: yes |
| `MEETINGS_SPEECH_LOCATION` | `eu` — the only value accepted (Chirp 3 is GA in `eu` and `us` only); the Speech endpoint is derived, never configured | no |
| `MEETINGS_VERTEX_LOCATION` | `eu` recommended; `europe-west1` and `europe-west4` are also accepted. `global`, `us` and anything else are refused; the base URL is derived | no |
| `MEETINGS_VERTEX_MODEL_ID` | the pinned Claude model id (`claude-…`); never a Fable or Mythos model. A placeholder until the live eval is green on it | no |
| `MEETINGS_GCP_PROJECT_ID` | the dedicated Google Cloud project (holds Speech, the Vertex enablement and the transient bucket, nothing else) | no |
| `MEETINGS_GCP_SERVICE_ACCOUNT_KEY` | the runtime service account's JSON key, **base64-encoded** (1Password `AIScream/OperAI - Meetings GCP SA/key-base64`); its `project_id` must equal `MEETINGS_GCP_PROJECT_ID` | key: yes |
| `MEETINGS_GCS_TRANSIENT_BUCKET` | the transient bucket's name; its location is read at startup | no |
| `MEETINGS_AI_PROVIDER` | `real` — `fake` is refused when `NODE_ENV=production` | no |
| `MEETINGS_TEST_HOSTS` | **must not be set** in production (the service exits 1) | — |
| `PORT` / `NODE_ENV` | `8085` / `production` | no |

**The audio bucket (ADR 20261104-audio-retention-bucket-lifecycle-verified-at-startup, AC-4.4) — the service refuses to start without this.** A private
EU bucket, holding audio only (`meetings/<id>/…`), with one bucket-wide lifecycle rule that
expires every object after **29 days**, no prefix filter, versioning **off**, and a CORS rule for
the shell origin (`POST` for the presigned upload, `GET` for playback). `provision-tool.sh`
cannot set the rule, so a person runs `infra/meetings-bucket-policy.sh` once the bucket exists
and **before** the first deploy (needs the AWS CLI and `jq`; credentials come from the
environment only):

```bash
# credentials of THE MEETINGS BUCKET, in the environment of this one command (never on a command line)
export MEETINGS_S3_ACCESS_KEY_ID=… MEETINGS_S3_SECRET_ACCESS_KEY=…   # from the Railway bucket's variables
infra/meetings-bucket-policy.sh --apply --require-cors --endpoint <MEETINGS_S3_ENDPOINT> --bucket <name> --region <MEETINGS_S3_REGION>
infra/meetings-bucket-policy.sh --check --require-cors --endpoint <MEETINGS_S3_ENDPOINT> --bucket <name> --region <MEETINGS_S3_REGION>
```

`--apply` replaces the bucket's lifecycle configuration, so it refuses a bucket that holds
anything outside `meetings/` (a mistyped name would otherwise put a 29-day expiry on offers or
receipts) and a bucket with versioning Enabled (that cannot be switched off). Exit codes: `0` the
policy holds, `1` it does not, `2` usage, `3` could not tell (access denied, unreachable) — **a
check that cannot reach the bucket is never a pass.** Re-run `--check` after any provider change.
Risk R10 is open until this has succeeded on the chosen provider: if it rejects a lifecycle rule
or CORS, stop and pick another EU provider rather than deploying. A `--require-cors` pass only
proves the rule exists; the shell CSP must also list the bucket in `connect-src` (upload) and
`media-src` (playback) — see the note under `inventory-api` above; all three gates fail alike as
"upload failed".

**Google Cloud (ADR 20261104-meetings-ai-providers-eu-zero-retention principle, ADR 20261105-meetings-ai-providers-google-cloud-eu; plan "Amendment 2026-11-05" G-2, G-5, G-6) — verified at
startup, so it must exist before the first deploy.** Transcription is Cloud Speech-to-Text v2 (Chirp 3,
`BatchRecognize`) through a **transient EU bucket**; summaries and Q&A are Claude on Vertex AI in the
`eu` multi-region. Everything the Google APIs let the service read is checked at startup (exit 1,
value-free message); what they do not expose is a **recorded sign-off** (H1-H6 below). Nothing in this
subsection has been provisioned: it is the checklist a person follows, in this order, and the commands
are templates to read first, not a script to paste.

*1. Project and APIs.* One **dedicated** project (nothing else in it: it is the unit of the sign-offs),
in an organization where the policies of step 6 can be set. Enable `speech.googleapis.com`,
`aiplatform.googleapis.com`, `storage.googleapis.com`, `iam.googleapis.com` and, for the eval
identity, `iamcredentials.googleapis.com` and `sts.googleapis.com`. Billing is linked by the
project owner.

*2. Claude in Model Garden.* In the console (Vertex AI → Model Garden) enable the pinned Claude model in
the project. **This accepts Anthropic's Commercial Terms (sign-off H5).** Never enable a Fable or Mythos
model, and never accept the "Advanced AI Safety Addendum" (H3): those models log prompts and responses
for up to 30 days. The model id goes into `MEETINGS_VERTEX_MODEL_ID` **only after the live
prompt-injection eval is green on it** (T103/T104); a model change is a deploy that needs a green eval.

*3. Disable Vertex data caching for the project (check N3).* The setting is project-wide; the service
refuses to start unless it reads `disableCache: true`. Template (confirm the host and shape in Google's
current docs; the T107 spike records which host serves it for `eu`):

```bash
# a person with the permission to update cacheConfig, once. The runtime service account must NOT hold it.
curl -sS -X PATCH -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" \
  "https://aiplatform.googleapis.com/v1/projects/<MEETINGS_GCP_PROJECT_ID>/cacheConfig" \
  -d '{"name":"projects/<MEETINGS_GCP_PROJECT_ID>/cacheConfig","disableCache":true}'
# verify: a GET on the same URL must answer {"disableCache": true}
```

*4. The transient bucket (check N2).* Create it **in the project, in an EU or CH location**
(`EUROPE-WEST4`, Netherlands, next to Railway Amsterdam, is the recommendation; London is refused), then
apply and prove the rules with the script. It never creates the bucket and never changes IAM; it runs as
a person (the runtime account cannot update bucket settings). Needs the `gcloud` CLI and `jq`:

```bash
gcloud storage buckets create gs://<name> --project <MEETINGS_GCP_PROJECT_ID> --location=EUROPE-WEST4 \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0
infra/meetings-gcs-transient-policy.sh --apply --bucket <name> --project <MEETINGS_GCP_PROJECT_ID>
infra/meetings-gcs-transient-policy.sh --check --bucket <name> --project <MEETINGS_GCP_PROJECT_ID>
bash infra/meetings-gcs-transient-policy.test.sh     # the script's own harness, a fake gcloud: no cloud call
```

The rules (all must hold; exit `0` they do, `1` they do not, `2` usage, `3` could not tell; **a check
that cannot read the bucket is never a pass**): location in the EU multi-region or one EU/CH region;
an enabled `Delete` lifecycle rule on `age` exactly 1 day (0 is refused) as its **only** condition (no prefix or suffix
filter); **soft delete off** (Cloud Storage turns on 7 days for every new bucket, which would leave a
deleted object recoverable for a week); versioning off; no retention policy; no default event-based
hold; uniform bucket-level access on; public access prevention `enforced`. Lifecycle is only a backstop
(it runs late): the service deletes `transcribe/<meetingId>/` itself, at the start and end of every
attempt and before any deletion route changes the database. Re-run `--check` after any change to the
project, and keep the script's location list equal to the service's.

*5. Service accounts, roles and bindings (least privilege; confirm exact permission names with Policy
Troubleshooter, the names below are the intent).*

| Identity | Holds | Never holds |
|---|---|---|
| Runtime `meetings-api@<project>.iam.gserviceaccount.com` (a JSON key, since Railway has no workload OIDC) | a **custom role** on the project: Speech `recognizers.recognize` on `recognizers/_`, `operations.get`, `operations.delete`; Vertex `aiplatform.endpoints.predict` on publisher models, read of `cacheConfig` and of `publisherModelConfig`. **On the bucket only**: `storage.objects.create/get/list/delete` and `storage.buckets.get` | any project-level storage role; `setPublisherModelConfig`; `cacheConfig` update; `aiplatform.consents.update`; `serviceusage`; any IAM permission |
| Speech service agent `service-<project number>@gcp-sa-speech.iam.gserviceaccount.com` (exists once the Speech API is enabled; confirm in the console) | **on the bucket only**: `storage.objects.get` (reads the audio parts) and `storage.objects.create` (writes the result) | everything else |
| Eval `meetings-eval@<project>.iam.gserviceaccount.com` (no key: Workload Identity Federation, step 7) | Vertex predict on the publisher models only | Speech, any bucket, any key |

*6. Key, rotation, expiry and organization policies.*
- **Key (runtime only).** Create it once, straight into 1Password, never into the repo, a terminal log
  or a chat. The base64 text is the variable's value:
  ```bash
  umask 077; f="$(mktemp)"
  gcloud iam service-accounts keys create "$f" --iam-account meetings-api@<project>.iam.gserviceaccount.com
  base64 < "$f" | tr -d '\n'   # -> 1Password "AIScream/OperAI - Meetings GCP SA", field key-base64
  rm -P "$f" 2>/dev/null || shred -u "$f"
  ```
- **Rotation: every 90 days** (a calendar entry owned by the sign-off owner): create a second key, update
  1Password and Railway `MEETINGS_GCP_SERVICE_ACCOUNT_KEY`, redeploy, check the service starts (it exits 1
  on a bad key) and answers its health check, then **delete the old key**
  (`gcloud iam service-accounts keys delete`) and confirm with `keys list` that exactly one user-managed
  key remains. `mise run env:doctor` treats the variable as a secret and never prints it.
- **Escalation trigger:** when Railway ships workload OIDC, move the runtime to Workload Identity
  Federation and delete the key.
- **Organization policies on the project** (defence in depth, the code does not rely on them; set by an
  organization administrator):
  - `constraints/iam.serviceAccountKeyExpiryHours` set to about 2400 h (100 days), so a forgotten key dies;
  - `constraints/iam.disableServiceAccountKeyCreation` **not enforced for this project** (an explicit,
    reviewed exception: the runtime key needs it), enforced everywhere else;
  - `constraints/gcp.resourceLocations` allowing `in:eu-locations` only;
  - `constraints/storage.publicAccessPrevention` and `constraints/storage.uniformBucketLevelAccess` enforced;
  - Google's Vertex AI organization policy that blocks **global-endpoint** usage (confirm the current
    constraint name in Google's docs; the code already refuses `global`).

*7. Live eval identity (GitHub Actions, no key).* A Workload Identity Pool and an OIDC provider for
`https://token.actions.githubusercontent.com`, with an **attribute mapping** and an **attribute condition**
pinning this repository, the `main` branch AND the `meetings-eval` environment (all three, never fewer),
bound to the eval service account with
`roles/iam.workloadIdentityUser` on that principal set only. Set the **variables** of the `meetings-eval`
GitHub environment (none is secret): `MEETINGS_EVAL_GCP_WIF_PROVIDER`
(`projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`),
`MEETINGS_EVAL_GCP_SERVICE_ACCOUNT`, `MEETINGS_EVAL_GCP_PROJECT_ID`, `MEETINGS_EVAL_VERTEX_LOCATION`
(`eu`) and `MEETINGS_EVAL_VERTEX_MODEL_ID`. They replace the previous provider's `MEETINGS_EVAL_*`
secrets and variables: delete those from the repository and from the environment. The workflow is
`.github/workflows/meetings-eval-live.yml` (nightly: skips when unconfigured; on dispatch: fails naming the
missing variables). The evals' content is synthetic.

Attribute mapping (`--attribute-mapping`): `google.subject=assertion.sub`,
`attribute.repository=assertion.repository`, `attribute.ref=assertion.ref`,
`attribute.environment=assertion.environment`. Attribute condition (`--attribute-condition`), with
`<owner>/<repo>` replaced by this repository (preferably also pin `assertion.repository_id`):

```
assertion.repository == '<owner>/<repo>' && assertion.ref == 'refs/heads/main' && assertion.environment == 'meetings-eval'
```

The `meetings-eval` GitHub environment must have **required reviewers** and a **deployment-branch
policy limited to `main`** (settings, done by a person): the condition stops a foreign token, the
environment stops an unreviewed or off-main run of this one. The workflow adds a guard step that fails
unless `github.ref == 'refs/heads/main'` before it authenticates, and installs dependencies BEFORE the
auth step so no dependency script can read the credentials file.

*8. Sign-off checklist (H1-H6): a person records an owner and a date; re-attest quarterly and on any
change to the project. The service cannot read these, so they are not checked at startup.* H4 **blocks
go-live.**

| # | Sign-off | Owner | Date |
|---|---|---|---|
| H1 | **Speech-to-Text data logging is not enrolled** for the project (an opt-in console toggle; the v2 API cannot read it) | ____ | ____ |
| H2 | **Contract:** wellD's use is under the Google Cloud **Master Agreement + CDPA**, not the online Terms of Service (only then is abuse-monitoring prompt logging, up to 90 days for flagged prompts, and human review exempt by default); and written confirmation that it does not apply to Claude on Vertex | ____ | ____ |
| H3 | **No consent to the Advanced AI Safety Addendum** in the project and no Advanced AI model (Fable, Mythos) enabled | ____ | ____ |
| H4 | **Written confirmation from Google on Q1:** with `gcsOutputConfig`, the Speech service keeps no copy of the transcript after the operation, or keeps it for how long (its FAQ says about 5 days for async results). The consent notice discloses the retention (T112). **Blocks go-live** | ____ | ____ |
| H5 | **Anthropic's terms:** enabling Claude in Model Garden accepts Anthropic's Commercial Terms; the data-protection lead confirms this does not make Anthropic a processor of meeting content (Google states prompts and responses are not shared with third parties, partner models included) | ____ | ____ |
| H6 | **Cloud Audit Logs Data Access** for `speech`, `aiplatform` and `storage` do not record request payloads (checked at provisioning) | ____ | ____ |

- The Google DPA and the transfer-impact note (plan O3) are a go-live decision for the data-protection
  lead, not something this checklist closes.

**Wiring in `auth` (do this first).** `SERVICE_CLIENTS` gains exactly:
`"meetings-api":{"secret":"${{shared.MEETINGS_SERVICE_CLIENT_SECRET}}","scope":"notifications.push host-notices.send"}`
(no `emails.send`). Generate the secret (≥ 32 random chars) as the Railway Shared Variable
`MEETINGS_SERVICE_CLIENT_SECRET`. `crm-api` needs `SERVICE_AUDIENCE=${{shared.SERVICE_AUDIENCE}}`
to verify the notices; `env:doctor` fails a template without it.

**Provisioning and order.** From the repo root (plan first, `--apply` only after reading it):

```bash
./infra/provision-tool.sh meetings --port 8085 --bucket           # read-only audit
./infra/provision-tool.sh meetings --port 8085 --bucket --apply   # service, DB, bucket, domains, DNS, Vercel project
# apply the bucket policy (above), set the secrets the script lists, then:
./infra/provision-tool.sh meetings --port 8085 --bucket --connect --redeploy-shell --apply
```

Order: `auth` (scope, client, catalog, default `employee` grant) → `notify-api` → `crm-api` → `meetings-api`
→ `meetings-ui` → shell. A step deployed before the one it depends on degrades silently (a push
that 401s), so check the previous one first. The auth re-seed must be live before anyone opens the tool.

**Shell wiring.** On the `shell` Vercel project set `VITE_MEETINGS_API_URL=<meetings-api public URL>`
(build-time; feeds the trusted-origin allowlist, unset means no Bearer JWT is attached and every
call 401s) and `MEETINGS_REMOTE_URL=https://meetings.operai.welld.io/remoteEntry.js`, then **redeploy
the shell**. `meetings-ui` has `SHELL_REMOTE_URL=https://operai.welld.io/remoteEntry.js` and no
backend variable of its own. To repoint the remote without a rebuild add `"meetings": "…/remoteEntry.js"`
to `shell/public/runtime-config.json`. The shell CSP (`shell/vercel.json`) needs `meetings-api` and
the bucket in `connect-src`, the bucket in `media-src`, and `Permissions-Policy: microphone=(self),
display-capture=(self), camera=()`.

**Local dev.** `docker compose up -d minio minio-createbucket` creates the private `meetings` bucket with
the 29-day rule and no versioning (re-runs replace the rule, never duplicate it). Verify it with the
default MinIO dev credentials:

```bash
MEETINGS_S3_ACCESS_KEY_ID=minioadmin MEETINGS_S3_SECRET_ACCESS_KEY=minioadmin \
  infra/meetings-bucket-policy.sh --check --endpoint http://localhost:9000 --bucket meetings --path-style
```

MinIO has no bucket-level CORS (that step prints `SKIP`; only `--require-cors` makes it fail), and dev
runs `MEETINGS_AI_PROVIDER=fake` until the real Google configuration exists (the fake never touches the transient bucket).

### `activities-api` service (Railway) — NEW (specs/20261110-activities)

Authoritative list: `activities-api/src/lib/env.ts` (validated at startup, exits 1 on any miss).
Committed contract: `tools/env-doctor/templates/production/activities-api.env`. Port **8087**, DB
`activities`, domain `activities-api.operai.welld.io`. **Backend-only**: there is no `activities-ui`;
the CRM and Projects remotes call it from the shell's origin. It owns no permission catalog (every
access decision is asked of crm-api / projects-api as the caller, ADR 20261110-activities-service-access-delegated-to-host). Since ADR 20261113-task-description-files-in-activities-api-bucket it owns
one private EU bucket, `activities`, for task images and attachments.

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `…/activities` — **its own logical DB** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell only) | no |
| `AUTH_JWKS_URL` / `AUTH_BASE_URL` | internal, `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}…` | no |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` | public claim `${{shared.AUTH_ISSUER}}` / `${{shared.AUTH_AUDIENCE}}` | no |
| `CRM_API_URL` / `PROJECTS_API_URL` | internal, `http://${{crm-api.RAILWAY_PRIVATE_DOMAIN}}:${{crm-api.PORT}}` / the same for `projects-api` — the hosts it asks (ADR 20261110-activities-service-access-delegated-to-host). Unset, the service exits 1 | no |
| `NOTIFY_INTERNAL_URL` | `${{shared.NOTIFY_INTERNAL_URL}}` | no |
| `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` | `activities-api` / `${{shared.ACTIVITIES_SERVICE_CLIENT_SECRET}}` (≥ 32 chars, byte-identical to its `SERVICE_CLIENTS` entry). All three notify variables or none | secret: yes |
| `SERVICE_AUDIENCE` | `${{shared.SERVICE_AUDIENCE}}` — what crm-api's `/system/v1/*` calls are verified against; must differ from `AUTH_AUDIENCE` | no |
| `ACTIVITIES_S3_BUCKET` / `_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | **by reference** to the Railway bucket `activities` (ADR 20261113-task-description-files-in-activities-api-bucket): `${{activities.BUCKET}}`, `${{activities.ENDPOINT}}`, `${{activities.ACCESS_KEY_ID}}`, `${{activities.SECRET_ACCESS_KEY}}`. Unset, the file routes answer 503 `storage_unconfigured` and everything else works | keys: yes |
| `ACTIVITIES_S3_REGION` / `ACTIVITIES_S3_EU_ENDPOINT_HOSTS` | `ams` / `t3.storageapi.dev` — the residency check at startup (ADR 20260716-eu-object-storage-refund-attachments) | no |
| `ACTIVITIES_MAINTENANCE` | `false` in steady state. `true` makes every route except `GET /health` answer 503 `maintenance` (the migration window below). Any other value stops the start | no |
| `PORT` / `NODE_ENV` | `8087` / `production` | no |

**Wiring in `auth` (do this first, and only after the new `auth` is live).** `SERVICE_CLIENTS`
gains `"activities-api":{"secret":"${{shared.ACTIVITIES_SERVICE_CLIENT_SECRET}}","scope":"notifications.push emails.send"}`
(both scopes: the task-assigned and task-unblocked notices are email notices, ADR 20261101-notify-api-resolves-email-notice-address-from-auth), and
the `crm-api` entry gains `activities.write`. An `auth` that does not know a scope named in
`SERVICE_CLIENTS` refuses to start, which is why the order is: deploy `auth` code, then edit the variable.
Generate the secret (≥ 32 random chars) as the Railway **Shared Variable**
`ACTIVITIES_SERVICE_CLIENT_SECRET`, directly on the project; there is no 1Password item and it is
never written to a template, a command line or a PR. `crm-api` needs
`ACTIVITIES_API_URL=http://${{activities-api.RAILWAY_PRIVATE_DOMAIN}}:${{activities-api.PORT}}`.
`notify-api` must know the `projects` origin and the binding `system:activities-api` → `crm`, `projects`
(code, not a variable) before the first write, or every push is refused silently.

**Task files bucket (ADR 20261113-task-description-files-in-activities-api-bucket), once.** The bucket is declared in `.railway/railway.ts`
(`bucket("activities", { region: "ams" })`): `railway config plan` shows `+ Create bucket activities`,
`railway config apply` creates it. Then set the four `ACTIVITIES_S3_*` references above on
activities-api, and a CORS rule on the bucket for `https://operai.welld.io` (methods POST, GET;
expose `ETag`, `Location`), the same as the CRM's: the browser uploads straight to it. Test one
picture and one attachment on a task. The shell's CSP already allows `img-src https://t3.storageapi.dev blob:`.

**Provisioning.** The service, its logical database, both hostnames and the DNS record come from
the `provision-tool` skill (`.claude/skills/provision-tool/SKILL.md`), backend only:

```bash
./infra/provision-tool.sh activities --port 8087 --no-ui           # read-only audit
./infra/provision-tool.sh activities --port 8087 --no-ui --apply   # service, DB, domain, DNS
# set the secrets it lists (DATABASE_URL by reference, SERVICE_CLIENT_SECRET shared), and
# ACTIVITIES_MAINTENANCE=true BEFORE the first deploy (see § Activities migration)
./infra/provision-tool.sh activities --port 8087 --no-ui --connect --apply
```

The script's shell wiring runs only for a tool with a UI, so set `VITE_ACTIVITIES_API_URL`
(`https://activities-api.operai.welld.io`) on the shell's Vercel project by hand and redeploy the
shell (it is read at build time; the CSP `connect-src` in `shell/vercel.json` already names the host).
Do not open or `curl` the new hostname before the DNS record is reported live (30-minute negative cache).

**Verify.** `mise run env:doctor -- --env production` before; `./infra/check.sh` after (it checks
`/health`, the 401 on a gated route and the 401 on `/system/v1/*`; while maintenance is on it reports
those two as a warning, not a pass).

### `letterhead-api` service (Railway) — NEW (specs/20261116-letterhead-service)

The one Rust service (ADR 20261116-letterhead-api-is-a-rust-service-with-typst-embedded-for-document-layout-only). Authoritative list:
`letterhead-api/api/src/env.rs` (validated at startup, exits 1 on any miss). Committed contract:
`tools/env-doctor/templates/production/letterhead-api.env`. Port **8088**, DB `letterhead`, domain
`letterhead-api.operai.welld.io`, its own private EU bucket `letterhead` (logos and backgrounds). The browser
reaches it only for the configurator (`letterheads-ui`, its own Vercel project, provisioned apart from this block);
crm-api reaches it with a scoped service JWT (`letterhead:render`).

**What `.railway/railway.ts` declares** (task T13; nothing is applied from a branch):

| Setting | Value | Why |
|---|---|---|
| `start` / `preDeploy` | `letterhead-api` / `letterhead-api migrate` | Plan, amendment 2026-11-17 item 4. The image has `CMD`, not `ENTRYPOINT`, so both are whole commands. `migrate` reads only `DATABASE_URL`, exits 0 when up to date, and on failure exits non-zero without the URL. `serve` never migrates and refuses a database that is behind, so the `preDeploy` is the only place the schema changes. |
| `limitOverride` | 2 vCPU, `memoryBytes` 5 000 000 000 | The pool is bounded by memory (ADR 20261116-renders-run-in-killable-worker-processes-and-concurrency-is-bounded-by-memory): `LH_WORKERS=2` x 2 GiB RSS cap (`LH_WORKER_RSS_MB`, default 2048), plus the supervisor, plus up to 6 held 20 MiB bodies: the caps alone are 4.3 GB and the whole is about 4.6 GB of the 5.0 GB limit, so it holds even if both workers sit at their cap. **Cost (T46, owner to confirm):** the limit was 4 GB while the cap was 1 GiB or 1.5 GiB; the worst accepted table (4 984 blocks, 300 pages) peaks at 1.53 GiB in a worker on Linux (VmHWM, `spike.md` § Not measured), above 1.5 GiB, so the cap is 2 GiB and the container 5 GB, 1 GB more than before, billed for as long as the service is up. The 4 GB container with the 1 GiB cap is what `letterhead-api/perf/` (T13, 2.1 GB for two concurrent worst-case previews) measured; repeat that with `--memory=5000000000` before raising `LH_WORKERS` or the cap. Without an override the service would get the plan's maximum, and a runaway would take the whole project's headroom. Raise it with a measurement, never to hide a 429. |
| `replicas` | `{ "europe-west4-drams3a": 1 }` | EU only. The pool, its queue and the per-caller share are in-process: a second replica doubles the bound, it does not share it. |
| `domains` | `letterhead-api.operai.welld.io` → 8088 | Railway configuration cannot register a custom domain: it was created with `railway domain … --service letterhead-api --port 8088` and its CNAME + `_railway-verify` TXT added on Cloudflare (2026-11-17), then declared here. |
| `healthcheck` | `/health`, 30 s | The Docker `HEALTHCHECK` is not read by Railway. |
| bucket | `letterhead`, `ams` | A bucket's region cannot change. |
| `source` | `github(matteocodogno/operai, main, /letterhead-api)` | Added after the variables were set (step 3, 2026-11-17). |

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/letterhead` — **its own logical DB** | yes (by reference) |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (the shell only) | no |
| `AUTH_ISSUER` / `AUTH_JWKS_URL` / `AUTH_BASE_URL` | public claim `https://auth.operai.welld.io`; internal `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks` and `…:${{auth.PORT}}` | no |
| `AUTH_AUDIENCE` / `SERVICE_AUDIENCE` | `${{shared.AUTH_AUDIENCE}}` / `${{shared.SERVICE_AUDIENCE}}` — must differ (the service refuses to start otherwise) | no |
| `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` | **NEW (specs/20261117-legal-entities, AC-3.2).** `letterhead-api` / `${{shared.LETTERHEAD_SERVICE_CLIENT_SECRET}}` (≥ 32 chars, byte-identical to its `SERVICE_CLIENTS` entry, which holds exactly `legal-entities:read`). It reads the issuer's details from `auth`'s registry as itself. Required in production by the contract; set in release step 2 (§ Legal entities rollout) | secret: yes |
| `LETTERHEAD_S3_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | **by reference** to the Railway bucket `letterhead`: `${{letterhead.BUCKET}}`, `${{letterhead.ACCESS_KEY_ID}}`, `${{letterhead.SECRET_ACCESS_KEY}}` (set by `provision-tool.sh --bucket`) | keys: yes |
| `LETTERHEAD_S3_ENDPOINT` / `_REGION` / `_EU_ENDPOINT_HOSTS` | `https://t3.storageapi.dev` / `ams` / `t3.storageapi.dev` — the residency guard (AC-3.8): without a match the service does not start. ASSUMED to be the other tools' endpoint (template comment): confirm against the bucket once it exists | no |
| `LH_WORKERS` / `LH_QUEUE` / `PORT` | `2` / `4` / `8088` | no |

The script sets every one of them by reference; there is no secret for a person to enter. `RAILWAY_PRIVATE_DOMAIN` is set by
Railway, and its presence makes the service bind `::` (private networking is IPv6-only); the same start was tested in a container.

**Owner steps (T40).** Run in the main session, not by an agent: step 2 and step 3 each ask for a yes, and a plan that
deletes anything is a stop.

```bash
# 0. The branch is merged: letterhead-api/ and .railway/railway.ts are on origin/main; the root `pnpm install` was run.
railway login
railway link -p 3bafd4c0-226f-4621-821b-a063976498a2 -e production

# 1. Read the plan. It must show ONLY additions: + service letterhead-api, + bucket letterhead. Any delete or change of
#    another resource is a stop; never pass --confirm-destructive.
railway config plan

# 2. Audit, then create: the logical database `letterhead`, `railway config apply` (it asks), the variables above, the domain, DNS.
#    --no-ui: letterheads-ui is a Vercel project of its own, provisioned apart from this block. Its name is not
#    `letterhead-ui`, so when it is time to provision it use `--ui letterheads-ui` (T42): directory `letterheads-ui`,
#    project and host `letterheads.operai.welld.io`, shell variables LETTERHEADS_REMOTE_URL / VITE_LETTERHEADS_API_URL.
./infra/provision-tool.sh letterhead --bucket --no-ui --port 8088
./infra/provision-tool.sh letterhead --bucket --no-ui --port 8088 --apply
#    The script prints "Bucket 'letterhead': set a CORS rule ...". Not needed here: the browser never talks to the bucket
#    (plan G3: assets are uploaded to the service as multipart and read back through GET /v1/assets/{id}). Do not open or
#    curl letterhead-api.operai.welld.io until the script says it resolves (30-minute negative cache).

# 3. Connect the repo (this starts the first build; preDeploy runs `letterhead-api migrate` first).
#    Add, as the first property of the letterhead-api block in .railway/railway.ts, then commit and push to main:
#      source: github("matteocodogno/operai", { branch: "main", checkSuites: false, rootDirectory: "/letterhead-api" }),
./infra/provision-tool.sh letterhead --bucket --no-ui --port 8088 --connect --apply

# 4. Verify (a connection is established only when this says so).
curl -s -o /dev/null -w '%{http_code}\n' https://letterhead-api.operai.welld.io/health                          # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://letterhead-api.operai.welld.io/v1/render/pdf          # 401, the one 401
railway logs --service letterhead-api | head                                                                    # "letterhead-api listening on [::]:8088 (workers 2, queue 4)"
mise run env:doctor -- --env production
./infra/check.sh      # T42: lists letterhead-api: /health 200, GET /v1/letterheads/status and POST /v1/render/pdf answer 401 with no credential, and the shell CSP's connect-src names it
```

**Then the measurement (AC-1.9, AC-1.10).** It needs two things that this task cannot give:

1. **A `welld_it` letterhead version saved through the service** (T14 and T15 deployed; the configurator form, T21 onwards, is not needed: a `curl` with a person token is enough). With none, every render answers
   409 `letterhead_not_configured`. Do not seed production with `perf/seed-local.ts` (it refuses): the rows can never be removed,
   and a version 1 that a script made would turn the first real save (`baseVersion` 0) into a `version_conflict`.
2. **A service credential with the scope `letterhead:render`**: a temporary client in `auth`'s `SERVICE_CLIENTS`, e.g.
   `"letterhead-perf":{"secret":"${{shared.LETTERHEAD_PERF_CLIENT_SECRET}}","scope":"letterhead:render"}`, with the secret (≥ 32 chars)
   generated as a Railway **Shared Variable** on the project, never in a command line or a PR. `auth` must be running the code that
   knows the scope (T18) before the variable is edited, or it refuses to start. Delete the client afterwards.

```bash
read -rs LETTERHEAD_PERF_CLIENT_SECRET && export LETTERHEAD_PERF_CLIENT_SECRET     # paste, Enter
export LETTERHEAD_PERF_CLIENT_ID=letterhead-perf
bun letterhead-api/perf/render-perf.ts --base-url https://letterhead-api.operai.welld.io \
  --auth-url https://auth.operai.welld.io --json perf-deployed.json
```

Record preview and PDF p50 and p95 in `specs/20261116-letterhead-service/spike.md` (§ Not measured), client and server side
(`railway logs --service letterhead-api` has `ms=` for every render). If preview p95 is 1 s or more, or PDF p95 is 3 s or
more, revisit O10 before the CRM switch. The local proxy numbers (a container with `--cpus=2 --memory=4000000000`) are in the
same section.

**Rollback.** Before step 3 nothing runs: delete the service and the bucket by removing their blocks from the file and
reading the plan (a bucket delete is destructive: the bucket is empty, but read it). After step 3 the service has no callers
until the CRM switch (`LETTERHEAD_SERVICE_ENABLED`, off by default), so a bad deploy affects nobody; redeploy the previous
deployment from the dashboard. A migration is never rolled back by the service: the tables refuse `UPDATE`, `DELETE` and
`TRUNCATE`, so a wrong migration is fixed by a new one.

### The CRM switch: offers on the layout service (specs/20261116-letterhead-service T30, AC-10.1, AC-10.11, AC-10.12)

`LETTERHEAD_SERVICE_ENABLED` on `crm-api` is the one switch. Off (the default, `tools/env-doctor/templates/production/crm-api.env`),
the CRM behaves as it always did: it draws its own pages from the uploaded letterhead PDF. On, every offer's pages come from
`letterhead-api` (the wizard's generate and the classic `POST /deals/{id}/offers` and `PUT /deals/{id}/offers/{offerId}`),
the two preview routes exist, `GET /scope` answers `letterheadService: true`, and the three letterhead upload routes answer
**410** `letterhead_upload_retired`. Only the literal `true` turns it on (`1` and `TRUE` are off, with a warning in the log).
With it on, one person has at most 2 previews in flight across the two preview routes (a counter per `crm-api` process, keyed by the token's
`sub`); a third answers **429** `preview_busy` with `Retry-After: 1` and never reaches the service (security review F1).

**There is no way back to the uploaded letterhead (owner, O5).** Step 5 deletes the files. Rolling the switch back after step 5
makes `crm-api` draw offers without a letterhead, because nothing is left to draw. Until step 5 the switch can be turned off
again at any time and the CRM is as before. Offers already issued are never changed: their stored PDFs, snapshots and
references stay as they are and still open, because no offer reads the letterhead object (AC-10.9, AC-10.12).

**Before the switch** (all of them; the check in step 2 proves only the second):

1. `letterhead-api` is deployed and healthy (the block above), `crm-api` has `LETTERHEAD_API_URL`, and the `crm-api` entry of `auth`'s
   `SERVICE_CLIENTS` holds the scope `letterhead:render` (T18; `auth` must run the code that knows it).
2. Both entities have an active letterhead version, saved in Letterheads by a person with access (configured to the brand templates).
3. The owner has signed off real offers drawn by the service (T35, `specs/20261116-letterhead-service/signoff/README.md`).

**The scripts** run from a checkout of the release commit, like `check-letterheads.ts` (§ CRM offer wizard rollout, below): they are not in the running
image. They need `crm-api`'s production variables (`railway run` injects them, the bucket and the service client included), the `crm`
database through its public connection string, and the public hosts of `letterhead-api` and `auth`, because the private ones do not
resolve from a laptop. `LETTERHEAD_SERVICE_ENABLED` is read from the injected variables. None prints a token, a secret, a link or bytes.

```bash
cd crm-api && bun install
# 1. The three conditions above hold. In every command below the three overrides are the public database, letterhead-api and
#    auth: the variables `railway run` injects name their private hosts.

# 2. THE CHECK. Asks GET /v1/letterheads/status as crm-api and prints one line per entity: "active vN" or NONE.
railway run --service crm-api --environment production -- sh -c \
  'DATABASE_URL="$CRM_PUBLIC_DATABASE_URL" LETTERHEAD_API_URL=https://letterhead-api.operai.welld.io AUTH_BASE_URL=https://auth.operai.welld.io bun scripts/check-letterhead-service.ts'
echo "exit $?"   # 0: both entities active, go on. 1: one has none, or the service did not answer: the switch stays OFF. 2: not configured

# 3. Set LETTERHEAD_SERVICE_ENABLED=true on crm-api in Railway and redeploy it. Do this ONLY after step 2 exited 0.

# 4. Verify, with the switch on: GET /scope answers letterheadService true; one test offer on a scratch deal generates (its PDF is
#    the service's pages, and its `letterheadVersion` is set); the offer wizard's preview shows the service's pages.

# 4b. KEEP A RECOVERABLE COPY before step 5 (the delete is permanent, security review F10). Either enable versioning on the CRM bucket
#     for the retirement window, or copy the letterhead objects to an archive prefix and check the copy lists both files:
#       aws s3 sync "s3://$CRM_S3_BUCKET/letterheads/" "s3://$CRM_S3_BUCKET/archive/letterheads-$(date +%F)/" --endpoint-url "$CRM_S3_ENDPOINT"
#     (any S3 client works; the point is two copies of each file before the script deletes one)
#     Do not run `--apply` until one of the two is done. Delete the archive after the retirement window, once offers have drawn well.

# 5. RETIRE the uploaded letterheads. DRY RUN first (the default): it runs the check, renders a sample PDF of each entity, then lists
#    what it would delete.
railway run --service crm-api --environment production -- sh -c \
  'DATABASE_URL="$CRM_PUBLIC_DATABASE_URL" LETTERHEAD_API_URL=https://letterhead-api.operai.welld.io AUTH_BASE_URL=https://auth.operai.welld.io bun scripts/retire-uploaded-letterheads.ts'
#    Read the list. Then, and only then (this deletes the two files from the bucket and clears the references; no rollback):
railway run --service crm-api --environment production -- sh -c \
  'DATABASE_URL="$CRM_PUBLIC_DATABASE_URL" LETTERHEAD_API_URL=https://letterhead-api.operai.welld.io AUTH_BASE_URL=https://auth.operai.welld.io bun scripts/retire-uploaded-letterheads.ts --apply'
echo "exit $?"   # 0: done (or nothing left). 1: refused, or an entity could not be retired: read the message and run it again
```

`retire-uploaded-letterheads.ts` is safe to run twice. It refuses, and changes nothing, unless the check of step 2 passes (also in
the dry run), unless a small sample PDF of **each** entity renders through `crm-api`'s own client, the one the offers use (also in
the dry run: the check proves an active version is listed, not that a render works, and a missing asset still lists; a render that
fails prints `<entity> sample PDF did NOT render (<code>)` and exits 1: fix the service, never skip it), and, with `--apply`,
unless the switch is on in this environment. It renders only when there is something to retire. Enable bucket versioning or copy
`letterheads/` to an archive prefix (step 4b) before `--apply`: the script keeps no copy. For each entity that still holds a letterhead it
deletes the object, then sets `letterheadKey`, `letterheadBy` and `letterheadAt` to null; a failed delete keeps the reference, so
running it again finishes the job, and a run with nothing left does nothing and touches neither the bucket nor the database. It
deletes only `letterheads/<entity>/<uuid>.pdf` of the entity's own row: any other reference (an offer PDF, another entity's file) is
reported as `SKIPPED` and left, with exit 1, for a person to look at. Offer PDFs (`offers/...`) are never read or deleted. It prints
the entity and the key it deleted. An upload that was started and never confirmed is not referenced by any row and is not listed by
the script, and stays in the bucket; if the bucket must hold no letterhead at all, list its `letterheads/` prefix by hand once after step 5.

**If the check fails (exit 1).** Do not enable the switch. `NONE` or `INVALID` names the entity: save a version in Letterheads and run
step 2 again. A non-200 or a timeout is the service or the credential (`railway logs --service letterhead-api`; the script prints the
status only; a 401 or 403 usually means the `letterhead:render` scope is missing from the `crm-api` entry of `SERVICE_CLIENTS`).
Nothing was changed.

### `accounting-api` service (Railway) — NEW (specs/20261119-accounting)

Ledger accounts, VAT codes and monthly exchange rates of each legal entity (ADR 20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it). Authoritative list:
`accounting-api/src/lib/env.ts` (validated at startup, exits 1 naming the variable, never its value). Committed contract:
`tools/env-doctor/templates/production/accounting-api.env`. Port **8089**, DB `accounting` (its own logical database on the shared
Postgres), domain `accounting-api.operai.welld.io`. A JWKS and authorization-enforcing resource server (person tokens on `/v1/*`,
checked against `auth`'s `/authz/resolve`) with one narrow service read, `GET /system/v1/entities/{entity}/…`, for refund-api. It stores
no file (no bucket), sends no notice, and holds **no service client of its own**: it calls no service but `auth` and, on demand, the one
federal rates host. The browser reaches it through `accounting-ui` (its own Vercel project, host `accounting.operai.welld.io`, a remote
of the shell); refund-api reads it over private networking with a scoped service JWT (`accounting.reference.read`, `sub`
`system:refund-api`, `aud` = `SERVICE_AUDIENCE`).

**What `.railway/railway.ts` declares** (task T43; nothing is applied from a branch, the operator applies it, D30):

| Setting | Value | Why |
|---|---|---|
| `build` | `DOCKERFILE`, `Dockerfile` | The image copies `src`, `prisma` **and `scripts/`** (the data they read included; the tests, `src/test-support` and the test fixtures are excluded by `.dockerignore`, whose `**/*.test.ts` is the recursive form: a bare `*.test.ts` matches the build-context root only), so `seed:welld-ch` runs inside the service (§ Accounting release runbook, step 6). |
| `start` / `preDeploy` | `bun run src/index.ts` / `bun run db:deploy` | The one Prisma migration runs against `accounting` before every start; the database must exist before the first deploy (step 1). |
| `healthcheck` | `/health`, 30 s | 200 with `db.status` `ok`; 503 when Prisma cannot reach Postgres. |
| `replicas` | `{ "europe-west4-drams3a": 1 }` | EU only. The rate fetch is single-flight per (entity, month) in process, so a second replica doubles the outbound calls, it does not share them. |
| `source` | **none** | Declared without it on purpose (plan D30): the service is created unbuilt, its variables are set, and the source is added at step 3. A first build with a missing variable exits 1. |
| `domains` | **none yet** | `railway config plan` refuses to register a custom domain from configuration, which stopped the `railway-drift` job from reading the file for letterhead-api (commit dc7c49c1). The domain is attached after the service exists, then declared: `domains: [{ domain: "accounting-api.operai.welld.io", port: 8089 }]` (step 1). |
| `limitOverride` | none | The service's own default. |
| bucket | none | |

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/accounting` — **its own logical DB** | yes (by reference) |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (the shell only; accounting-ui is a remote, so the browser's `Origin` is the shell's). A wildcard is refused at startup | no |
| `AUTH_ISSUER` | `https://auth.operai.welld.io` — the public claim, byte-identical to `auth`'s `BETTER_AUTH_URL` | no |
| `AUTH_JWKS_URL` / `AUTH_BASE_URL` | internal: `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks` and `…:${{auth.PORT}}`. `AUTH_BASE_URL` is the base of the `GET /authz/resolve` call, distinct from the claim | no |
| `AUTH_AUDIENCE` | `${{shared.AUTH_AUDIENCE}}` — byte-for-byte the suite's | no |
| `SERVICE_AUDIENCE` | `${{shared.SERVICE_AUDIENCE}}` — the `aud` of the service JWTs `/system/v1/*` verifies. **Required** (the service exits 1 without it) and **different from `AUTH_AUDIENCE`** (it refuses to start when they are equal) | no |
| `ACCOUNTING_FX_SOURCE` | `bazg` (default) or `off`. **Moved here from refund-api's `REFUND_FX_SOURCE`.** `bazg` fetches the federal monthly average rates ON DEMAND (a manager's Fetch now, or a consumer's read that finds a month missing), never by a scheduler; `off` makes no outbound call, every attempt is recorded as `disabled` and rates are typed by hand (offline, e2e). Any other value stops the service at startup. The host is a constant in `src/rates/bazgSource.ts`, not a variable. Optional | no |
| `PORT` / `NODE_ENV` | `8089` / `production` | no |

`infra/provision-tool.sh` sets every uncommented `KEY=VALUE` of the template by reference; there is **no secret for a person to enter**,
no `SERVICE_CLIENT_*`, no `*_INTERNAL_URL`, no bucket variable.

**Outbound HTTPS to `www.backend-rates.bazg.admin.ch`** (moved from refund-api, which no longer calls it): with `ACCOUNTING_FX_SOURCE=bazg`
accounting-api calls it, on demand only, 10 s at most for a manager's fetch and 6 s for a consumer's. `.railway/railway.ts` declares no
egress rule, so nothing is to be configured; if egress is ever restricted, allow that host for accounting-api, or set
`ACCOUNTING_FX_SOURCE=off` and type the rates. A failed fetch is never an error page: the month is a "missing rate" and blocks the export of
a batch that needs it.

**Wiring in `auth`.** No new client and no new shared secret: refund-api's own client (`REFUND_SERVICE_CLIENT_SECRET`) gains one scope.
`SERVICE_CLIENTS`'s `refund-api` entry goes from `"scope":"notifications.push emails.send"` to
`"scope":"notifications.push emails.send accounting.reference.read"`, every other entry unchanged. **Only after the new `auth` is
live**: an `auth` that does not know a scope named in `SERVICE_CLIENTS` refuses to start (R13), and it restarts when the variable
changes (§ Accounting release runbook, step 4). The scope is read-only; a consumer that must write to Accounting is a new scope.
`accounting-api` additionally checks the token's `sub` against its own allow-list (`system:refund-api` only, in code, not a variable).

**Access.** Who may see or change what is `auth`'s: the catalog `accounting` (`read`, `manage`, entity condition) is seeded by
`auth`'s `preDeploy` (`db:release`), which gives `admin` both actions and the `accounting` role both, conditioned on the entity. accounting-api
refuses everyone until that catalog exists (403), which is why `auth` must be live first.

**Provisioning and release:** § Accounting release runbook. **Verify:** `mise run env:doctor -- --env production` before;
`./infra/check.sh` after (accounting-api `/health` 200; a 401 on `GET /v1/me` with no token; a 401 on
`GET /system/v1/entities/welld_ch/reference-data` with no credential; the CSP `connect-src` pin).

### Provisioning a new tool

`infra/provision-tool.sh <tool>` creates, or audits, everything a tool needs in
production that `infra/deploy.sh` leaves manual: the Railway service and its logical
database on the shared Postgres, an optional EU bucket, both custom domains, their
Cloudflare DNS records, the Vercel project with its first deployment, and the shell's
two build-time variables. It sets no secret and reads none.

```bash
./infra/provision-tool.sh <tool> [--bucket]                  # plan: read-only audit; prints the block to add
# add the printed service block (and bucket) to .railway/railway.ts WITHOUT a source, commit
./infra/provision-tool.sh <tool> [--bucket] --apply          # database, `railway config apply`, variables, DNS
# set the remaining secrets on <tool>-api in Railway (the script lists their names)
# uncomment the block's source: github(...), commit
./infra/provision-tool.sh <tool> [--bucket] --connect --redeploy-shell --apply
./infra/check.sh
```

The Railway service, its bucket and its domain are declared in `.railway/railway.ts`
(§ Railway configuration as code); the script checks the declaration, refuses to
apply an uncommitted file, and applies it with `railway config apply`, which asks for
confirmation. A block that declares a source while the service has none is refused
without `--connect`, because connecting the repo starts the first build.

`--ui <remote>` names the frontend when it is not `<tool>-ui` (`--ui letterheads-ui` for tool `letterhead`; the stem
`letterheads` works too): it sets the UI directory, the Vercel project, the host and the two shell variables, while the
backend keeps the tool's name. A commented `// source: github(...)` line in the block is not a declared source.

Without `--apply` nothing is changed. It is safe to re-run: it fills gaps only, never
overwrites a variable and never deletes. Needs the `railway`, `vercel` and `cf`
(Cloudflare) CLIs logged in, plus `jq` and `dig`. Two things it cannot do: set the
bucket's CORS rule, and choose secrets.

Do not open or `curl` a new hostname before the script reports that it resolves: a
lookup made before the DNS record exists is cached as "no such host" for 30 minutes.
The order of operations, the human decisions and the reasons behind them are in
`.claude/skills/provision-tool/SKILL.md`.

Status: the plan mode is verified against `activities` and `meetings` (both report
nothing missing, 2026-11-13). The `--apply` path with IaC has not yet been run on a new
tool — in particular that `railway config apply` creates a service declared without a
source and leaves it unbuilt is Railway's documented behaviour, not yet observed here;
treat its first use as a supervised run.

### Frontend build-time vars (Vercel) — `VITE_*` are client-side; `*_REMOTE_URL` are Vite-config-side

| Project | Variable | Value |
|---|---|---|
| **shell** | `VITE_AUTH_URL` / `VITE_API_URL` | `<AUTH_URL>` / `<API_URL>` |
| | `VITE_NOTIFY_API_URL` | `<NOTIFY_API_URL>` — feeds `shell/session`'s trusted-origin allowlist and `getNotifyBaseUrl()` (the raise-capability, `useUnreadCount` SSE manager); also the origin `notify-ui` itself calls (mirrors `VITE_API_URL`/`VITE_AUTH_URL`) |
| | `VITE_REFUND_API_URL` | **NEW (T20, specs/20260716-refund-service).** `<REFUND_API_URL>` — feeds `shell/session`'s trusted-origin allowlist ONLY (`getTrustedOrigins()`, `shell/src/lib/session.ts`); `refund-ui` calls refund-api using its OWN copy of this same var (own build, see the `refund-ui` row below) — both copies MUST carry the identical `<REFUND_API_URL>` value or `apiFetch` will not recognize refund-ui's request origin as trusted and every call 401s. |
| | `VITE_ACTIVITIES_API_URL` | **NEW (specs/20261110-activities).** `https://activities-api.operai.welld.io` — build-time, feeds `shell/session`'s trusted-origin allowlist AND `getActivitiesApiBaseUrl()`, which `crm-ui` and `projects-ui` use for every activity and task call (no `VITE_*` of their own; there is no `activities-ui`). `provision-tool.sh --no-ui` does not set it: set it by hand and redeploy the shell. |
| | `VITE_INVENTORY_API_URL` | **NEW (T41/T43, specs/20261006-hardware-inventory).** `<INVENTORY_API_URL>` — build-time, feeds `shell/session`'s trusted-origin allowlist AND `getInventoryApiBaseUrl()`, which `inventory-ui` uses for every inventory-api call (**inventory-ui has no `VITE_INVENTORY_API_URL` of its own** — unlike `refund-ui`, it asks the shell). **Optional by design and unset by default: when unset the inventory origin is NOT trusted, `apiFetch` sends no Bearer JWT there, and every inventory call 401s** — a silent failure, so set it on the shell project and redeploy. Typed in `shell/src/vite-env.d.ts`. |
| | `ESTIMAI_REMOTE_URL` / `REFUND_REMOTE_URL` / `ADMIN_REMOTE_URL` / `NOTIFY_REMOTE_URL` / `INVENTORY_REMOTE_URL` | `https://<estimai/refund/admin/notify/inventory>.operai.welld.io/remoteEntry.js` (the code defaults are the `localhost:517x` dev origins, so an unset value ships a shell pointing at localhost) |
| | `ACCOUNTING_REMOTE_URL` / `VITE_ACCOUNTING_API_URL` | **NEW (specs/20261119-accounting).** `https://accounting.operai.welld.io/remoteEntry.js` / `https://accounting-api.operai.welld.io` — build-time; the second feeds `shell/session`'s trusted-origin allowlist AND `getAccountingApiBaseUrl()` (the Bearer is attached to accounting-api calls only through it). Set by `provision-tool.sh accounting`, which also checks `shell/vite.config.ts` reads the first; redeploy the shell after setting them. |
| **accounting-ui** | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` (no backend vars of its own: accounting-api through `getAccountingApiBaseUrl()` of the shell) |
| **estimai-ui** | `VITE_API_URL` | `<API_URL>` — **required**: estimai-ui builds `${VITE_API_URL}/estimates` from its *own* value (must match the shell's) |
| | `VITE_AUTH_URL` / `SHELL_REMOTE_URL` | standalone-only / `https://operai.welld.io/remoteEntry.js` |
| **refund-ui** | `VITE_REFUND_API_URL` | **NEW (T20).** `<REFUND_API_URL>` — **required**: `refund-ui/src/lib/refundApi.ts` builds every refund-api URL from its *own* value (must byte-for-byte match the shell's copy above — see that row's note) |
| | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` |
| **inventory-ui** | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` (no backend vars of its own: inventory-api via `getInventoryApiBaseUrl()`, the user directory via `getAuthBaseUrl()`, both from the shell) |
| **admin-ui**, **notify-ui** | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` (no backend vars of their own — `notify-ui`'s calls to `notify-api` go through the shared `shell/session` module's `VITE_NOTIFY_API_URL`, same pattern `admin-ui` uses for the auth service's admin API) |
| **admin-ui** | `VITE_GOOGLE_MAPS_API_KEY` | **NEW (T16, specs/20260803-employee-address, ADR 20260804-google-places-browser-direct-referrer-restricted-key).** Google Places API (New) + Maps JavaScript API browser key, referrer-restricted to the **shell's** origins (not admin-ui's own — see § Phase 2's "Google Maps API key — provisioning"). admin-ui's own third-party credential, deliberately **not** a `shell/session` getter. |

Cross-service wiring: `auth.BETTER_AUTH_URL == estimai-api.AUTH_ISSUER ==
notify-api.AUTH_ISSUER == refund-api.AUTH_ISSUER`; `estimai-api.AUTH_JWKS_URL
== notify-api.AUTH_JWKS_URL == refund-api.AUTH_JWKS_URL == <AUTH_URL>/auth/jwks`;
all four backends' `ALLOWED_ORIGINS == shell origin`;
**`auth.AUTH_AUDIENCE == estimai-api.AUTH_AUDIENCE == notify-api.AUTH_AUDIENCE
== refund-api.AUTH_AUDIENCE`** (ADR 20260713-jwt-audience-claim-enforcement — extended to `refund-api` as of
specs/20260716-refund-service); **`auth.SERVICE_AUDIENCE == notify-api.SERVICE_AUDIENCE`, and each
`refund-api` / `estimai-api` / `inventory-api` `SERVICE_CLIENT_ID` is a key of
`auth.SERVICE_CLIENTS` whose `secret` equals that service's `SERVICE_CLIENT_SECRET`
and whose scopes are exactly what it needs** (ADR 20261006-scoped-service-jwt-fourth-notify-caller/0049, specs/20261013-notify-service-credentials);
`auth.NOTIFY_INTERNAL_URL == refund-api.NOTIFY_INTERNAL_URL` is notify-api's **private**-networking
address, distinct from `<NOTIFY_API_URL>`/`VITE_NOTIFY_API_URL` (the public
address every other row above uses); **`shell.VITE_REFUND_API_URL ==
refund-ui.VITE_REFUND_API_URL == <REFUND_API_URL>`** (T20 — two independent
Vercel projects, one value; a drift here silently breaks the Bearer-attach
trusted-origins check even though both builds succeed); **`refund-api.REFUND_APP_BASE_URL ==
refund-api.ALLOWED_ORIGINS == <shell origin>`** (T14, specs/20260719-refund-monthly-processing,
ADR 20260719-refund-batch-signed-link-email-delivery — the compiled-batch email's deep link must resolve inside the same shell origin
CORS/trustedOrigins already allow; a drift here doesn't break the build, it just mails a
dead or untrusted link).
**specs/20261006-hardware-inventory additions:** `auth.AUTH_AUDIENCE == … == inventory-api.AUTH_AUDIENCE`;
`inventory-api.AUTH_ISSUER == auth.BETTER_AUTH_URL`; **`auth.SERVICE_AUDIENCE ==
notify-api.SERVICE_AUDIENCE`, and each differs from its own service's
`AUTH_AUDIENCE`** (ADR 20261006-scoped-service-jwt-fourth-notify-caller); `inventory-api.SERVICE_CLIENT_ID` is a key of
`auth.SERVICE_CLIENTS` whose `secret` equals `inventory-api.SERVICE_CLIENT_SECRET` and
whose `scope` contains `notifications.push`; no service holds the retired shared token
(`env:doctor` flags it by name); `inventory-api.INVENTORY_S3_ENDPOINT`'s host is in
`INVENTORY_S3_EU_ENDPOINT_HOSTS` (or an AWS endpoint in an EU region). All except the
bucket's own CORS rule are checked by `mise run env:doctor`
(`tools/env-doctor/README.md`).

---

## Notify credential rollout (specs/20261013-notify-service-credentials, ADR 20261013-auth-mints-own-service-credential-in-process/0049)

> **Rollout completed on 2026-10-30.** All three pushes and Manual A/B are done:
> every caller uses its own service credential, `NOTIFY_INTERNAL_TOKEN` is deleted from
> every Railway service and refused by `notify-api`, and env-doctor forbids it. This
> section is kept as the record of how it was done; for the current setup see the
> **Service clients** paragraph above (§ Phase 1 — Railway backends).

Every caller of `notify-api`'s internal routes moves from the shared
`NOTIFY_INTERNAL_TOKEN` to its own scoped service credential, and the shared token is
then deleted. A push to `main` redeploys all five Railway services at once, in no fixed
order, so the safe order is **three pushes with manual steps between them**. Each step
starts only when the previous one is confirmed.

Roles: **P1/P2/P3** are pushes (T6, T13 and T18 in `specs/20261013-notify-service-credentials/tasks.md`
are done by a person, never by an agent). **Manual A/B** edit Railway variables. No step below
reads or prints a variable value; where a check lists variables it lists **names only**
(`| jq -r 'keys[]'` keeps the values off the terminal).

### Variables (names; nothing here is a value)

| Variable | Where | Role |
|---|---|---|
| `SERVICE_AUDIENCE` | Shared Variable; referenced by `auth` and `notify-api` | The `aud` on service JWTs. **Required in both from push 1**; must differ from `AUTH_AUDIENCE` and be identical on the two. Already set in production since specs/20261006-hardware-inventory. |
| `INVENTORY_SERVICE_CLIENT_SECRET` | Shared Variable | Exists. `inventory-api` is unchanged. |
| `ESTIMAI_SERVICE_CLIENT_SECRET` | Shared Variable (**new**, Manual A) | One secret, 32-256 chars. Referenced inside `auth`'s `SERVICE_CLIENTS` and by `estimai-api`'s `SERVICE_CLIENT_SECRET`. |
| `REFUND_SERVICE_CLIENT_SECRET` | Shared Variable (**new**, Manual A) | Same, for `refund-api`. |
| `SERVICE_CLIENTS` | `auth` | JSON of all clients, shape below. |
| `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` | `refund-api`, `estimai-api` (**new**, Manual A) | Literal client id (`refund-api` / `estimai-api`) and `${{shared.<NAME>_SERVICE_CLIENT_SECRET}}`. |
| `NOTIFY_INTERNAL_TOKEN` | `notify-api`, `auth`, `refund-api`, `estimai-api` | The shared token. Optional in `notify-api` from push 1; deleted at Manual B; gone from the code at push 3. |

`SERVICE_CLIENTS` on `auth` after Manual A (as in
`tools/env-doctor/templates/production/auth.env`; the secrets are Railway references, never
literals). Each client holds exactly the scopes it needs; `estimai-api` must not hold
`emails.send` (`inventory-api` does, for its assignment reminders, US-15), and a client id of `auth` is refused at startup (ADR 20261013-auth-mints-own-service-credential-in-process):

```json
{
  "inventory-api": { "secret": "${{shared.INVENTORY_SERVICE_CLIENT_SECRET}}", "scope": "notifications.push emails.send" },
  "estimai-api":   { "secret": "${{shared.ESTIMAI_SERVICE_CLIENT_SECRET}}",   "scope": "notifications.push" },
  "refund-api":    { "secret": "${{shared.REFUND_SERVICE_CLIENT_SECRET}}",    "scope": "notifications.push emails.send" }
}
```

(On one line in the Variables tab. After saving, open it and confirm each `${{shared.…}}`
resolved inside the JSON.)

### Step 0 - before push 1: preconditions (names only)

```bash
# SERVICE_AUDIENCE must exist on BOTH auth and notify-api before push 1: both now exit at startup without it.
for s in auth notify-api; do
  printf '%s: ' "$s"
  railway variables --service "$s" --json | jq -r 'keys[]' | grep -qx SERVICE_AUDIENCE && echo present || echo MISSING
done
# Retired names: the old per-address token limit (SERVICE_TOKEN_RATE_*) is ignored since specs/20261111-push-notifications US-7.
# Listing one is not a failure; it is a leftover to delete once the new auth is live.
railway variables --service auth --json | jq -r 'keys[]' | grep '^SERVICE_TOKEN_RATE' || echo "none (nothing to delete)"
```

- Anything `MISSING`: stop. Add the `${{shared.SERVICE_AUDIENCE}}` reference first (its value
  must differ from `AUTH_AUDIENCE`), otherwise push 1 stops `auth` or `notify-api` from starting.
- If a `SERVICE_TOKEN_RATE_*` name is listed: since specs/20261111-push-notifications US-7 it has no effect (the limit is
  per calling service, `SERVICE_TOKEN_SERVICE_LIMIT` default 300 and `USERS_CONTACT_SERVICE_LIMIT`
  default 600, both per `SYSTEM_RATE_WINDOW_MS`). Do not size it; delete it after the new `auth`
  is live (§ Push notifications -> Rollout order). Only if `SERVICE_TOKEN_SERVICE_LIMIT`,
  `USERS_CONTACT_SERVICE_LIMIT`, `SYSTEM_INVALID_CREDENTIAL_LIMIT` or `SYSTEM_RATE_WINDOW_MS` is
  set, check that the value is not below the default (the same listing with
  `grep -E '^(SERVICE_TOKEN_SERVICE_LIMIT|USERS_CONTACT_SERVICE_LIMIT|SYSTEM_)'`).
- `mise run env:doctor -- --env production` passes on the committed templates.

### Step 1 - Push 1: the new mechanism is accepted, nothing uses it yet

Contains (T1-T5): `auth` (scope `emails.send`, reserved id `auth`, in-process self-mint, not
yet used); `notify-api` (both routes accept a service credential, origin bindings
`system:refund-api -> refund` and `system:estimai-api -> estimai`, the `caller=` log line,
shared token optional); `env-doctor`; this section. Callers are unchanged.

Result: every caller still sends the shared token and it still works. The `notify-api` log now
shows `caller=shared-token` for each of those calls.

### Step 2 - Wait for push 1 to be live, then confirm (R-4)

`auth` on the old code refuses to start on a `SERVICE_CLIENTS` value containing `emails.send`,
so Manual A must not begin until `auth`'s **push-1 deployment is the live one**.

```bash
railway deployment list --service auth        # newest row: status SUCCESS, commit = push 1
railway deployment list --service notify-api  # same
./infra/check.sh                              # all checks pass
mise run env:doctor -- --env production --live
```

Continue only when both services show the push-1 commit as the active, successful deployment
and `env-doctor --live` reports no failure.

### Step 3 - Manual A: create the credentials (a person, in Railway)

1. Create two **Shared Variables** on the project, each at least 32 random characters
   (e.g. `openssl rand -hex 32 | tr -d '\n' | pbcopy`, so the value goes to the clipboard and
   is never echoed, then pasted straight into Railway, never into the repo, a PR, a chat or a
   shell history): `ESTIMAI_SERVICE_CLIENT_SECRET`, `REFUND_SERVICE_CLIENT_SECRET`.
2. On **`auth`**, set `SERVICE_CLIENTS` to the JSON above.
3. On **`refund-api`**: `SERVICE_CLIENT_ID=refund-api`,
   `SERVICE_CLIENT_SECRET=${{shared.REFUND_SERVICE_CLIENT_SECRET}}`.
   On **`estimai-api`**: `SERVICE_CLIENT_ID=estimai-api`,
   `SERVICE_CLIENT_SECRET=${{shared.ESTIMAI_SERVICE_CLIENT_SECRET}}`.
4. Let the redeploys finish. The callers' running code (pre push 2) ignores the new
   variables; `auth` (already on push 1) accepts the new scope. Do **not** touch
   `NOTIFY_INTERNAL_TOKEN`.
5. Verify: `./infra/check.sh` passes; `mise run env:doctor -- --env production --live`
   reports no failure (it checks that each caller's id and secret match its `SERVICE_CLIENTS`
   entry, that each entry holds exactly its scopes, and flags a missing variable by name);
   then trigger one invitation email and one refund decision and confirm both still arrive
   and the log shows `caller=shared-token` for them (step 5 shows the command).

### Step 4 - Push 2: the callers switch

`auth`, `refund-api` and `estimai-api` send their own credential (T7-T12). Wait until the
deployments of all three, and of `notify-api`, are the active successful ones.

If a call fails with HTTP 429 from `auth POST /system/service-token` in a caller log during
this window, do not retry in a loop and do not set `SERVICE_TOKEN_RATE_*` (retired, ignored).
Read `auth`'s log: `allowance exhausted caller=system:<id>` means that service passed its own
`SERVICE_TOKEN_SERVICE_LIMIT` (300 per window by default; raise it for the environment);
`invalid-credential limit reached` means requests with a wrong credential arrived from one
address (fix the caller's secret). The refusal is the same 429 either way, with `Retry-After`
set to the window in seconds.

### Step 5 - Verify with the log line only

Trigger every call site at least once: an invitation email and a resend, a refund approval
and a rejection, a batch email, a collaborator grant and a removal on an estimate, and an
inventory assignment. A call site you skip can still be on the shared token without showing
up here. Then read the caller identity (never a variable):

```bash
railway logs --service notify-api --since 30m \
  | grep -o '\[system-auth\] [A-Z]* [^ ]* caller=[^ ]*' | sort | uniq -c
```

Expect one line per flow, each `caller=system:auth`, `caller=system:refund-api`,
`caller=system:estimai-api` or `caller=system:inventory-api`, and **no
`caller=shared-token` line since push 2 finished deploying**. If the CLI has no `--since`,
use the dashboard log view of `notify-api` filtered by `caller=` and the trigger time.
Any `caller=shared-token` line means a caller is still on the shared token: find it, fix it,
and repeat this step. Do not go on.

### Step 6 - Manual B: delete the shared token (point of no return)

**This is the step after which the shared token stops working.** It is undone by putting the
`NOTIFY_INTERNAL_TOKEN` variable back on `notify-api` and redeploying it (paste the value from
1Password, item `AIScream / OperAI - NOTIFY_INTERNAL_TOKEN`; never echo it), because
`notify-api` still contains the legacy path until push 3.

1. Delete `NOTIFY_INTERNAL_TOKEN` from **`notify-api` only**. Redeploy it.
2. Re-run the step 5 triggers and the same `grep`: every flow still logs `caller=system:*`.
   A flow that stopped delivering is a caller you missed; restore the variable and go back to step 5.
3. Run `./infra/check.sh`: the no-credential 401 checks still pass.
4. Only then delete `NOTIFY_INTERNAL_TOKEN` from `auth`, `refund-api` and `estimai-api`.
5. Verify, by name: `for s in auth notify-api refund-api estimai-api inventory-api; do railway variables --service "$s" --json | jq -r 'keys[]' | grep -x NOTIFY_INTERNAL_TOKEN && echo "$s still has it"; done`
   prints nothing.

### Step 7 - Push 3: the legacy code and the variable leave the repository

`notify-api` drops the legacy path and the variable; `env-doctor` moves
`NOTIFY_INTERNAL_TOKEN` to `FORBIDDEN_VARS` for all five services; `infra/deploy.sh`,
`infra/check.sh`, `shell/playwright.config.ts` and the docs lose every mention (T14-T17). It
must not reach `main` before Manual B is done. Afterwards `X-Internal-Token` with any value is
a 401 on both routes. Retire the 1Password item once nothing reads it.
After the deploy: `./infra/check.sh` passes (both routes answer 401 to no credential and to
an `X-Internal-Token` header) and `mise run env:doctor -- --env production --live` reports no
failure (it flags the retired variable by name on any service).

### Rollback by step

| Failure at | Action |
|---|---|
| Step 1 | Redeploy the previous deployment of `auth` and `notify-api`. No variable changed yet. |
| Step 3 | Remove the new `SERVICE_CLIENT_*` variables and restore the previous `SERVICE_CLIENTS` value (the single `inventory-api` entry). Callers were never using them. |
| Step 4 | Redeploy the previous deployment of the failing caller; the shared token still works at this point. |
| Step 6 | Put `NOTIFY_INTERNAL_TOKEN` back on `notify-api` (pasted from 1Password, never echoed) and redeploy it; the legacy path is still in the code. After 6.4, rolling a caller back below push 2 also needs the variable restored on that caller, because those builds still require it at startup. |
| Step 7 | Revert the push. Push 3 only removes code and docs; if it also has to undo step 6, restore the variable first. |

---

## EstimAI oversight and deal badge rollout (specs/20261108-estimate-list-oversight, ADR 20261108-estimai-oversight-permission-amends-0036/0076)

Order matters: `auth` refuses to start when `SERVICE_CLIENTS` names a scope it does not know.

1. Deploy `auth` (new `estimate:read-all` catalog action, seeded to `admin`; new scope
   `deal-link-notices.send`). The seed runs at startup.
2. Only after that deploy is live: add `deal-link-notices.send` to the `crm-api` entry of
   `auth`'s `SERVICE_CLIENTS` (template: `tools/env-doctor/templates/production/auth.env`).
3. Set `SERVICE_AUDIENCE=${{shared.SERVICE_AUDIENCE}}` on `estimai-api` and
   `ESTIMAI_INTERNAL_URL=http://${{estimai-api.RAILWAY_PRIVATE_DOMAIN}}:${{estimai-api.PORT}}`
   on `crm-api`, then deploy `estimai-api` (migration `crmDealId`/`crmLinkAt`) and `crm-api`.
4. `mise run env:doctor -- --env production` before, and the shell/estimai-ui deploy after.
5. Backfill the existing links once (dry run first; safe to re-run, it is also the repair for
   a lost notice). It needs crm-api's own variables and reaches estimai-api over private
   networking, so run it INSIDE the crm-api service (e.g. `railway ssh --service crm-api`), not
   from a laptop:

   ```bash
   bun scripts/backfill-estimate-links.ts            # dry run: prints how many would be sent
   bun scripts/backfill-estimate-links.ts --apply
   ```

## CRM offer wizard rollout (specs/20261115-crm-offer-wizard, ADR 20261115-offer-template-format-supersession-per-entity-language, risks R4, R11, R13)

The wizard adds wizard templates, server-held drafts and new routes to `crm-api`, new design tokens
to `@operai/ui`, and a new offer flow to `crm-ui`. No new variable, scope or service; the one
migration is `20261115120000_offer_wizard` (columns, the `offer_draft` table, two CHECK constraints),
applied by `crm-api`'s `preDeploy` (`bun run db:deploy`). It changes no existing row and never touches
`deal_offer` (AC-9.4).

### Before the deploy: count the texts a backslash will change (R13)

`markup.ts` now reads a backslash before a markup character (`[` `*` `_` `|` `{` `\`) as an escape: `\*`
prints `*`. Until now it printed both characters. Only a classic template's opening and section
bodies, and the same two members of a classic offer's stored snapshot, are read as markup. Run both
files on the production database (read-only) and keep the numbers:

```sql
-- r13-count.sql
SELECT count(*) AS classic_templates_affected
  FROM offer_template
 WHERE format = 'sections'
   AND (opening ~ '\\(\*|_|\||\{|\[|\\)'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(sections) AS s WHERE s ->> 'body' ~ '\\(\*|_|\||\{|\[|\\)'));

SELECT count(*) FILTER (WHERE "sentAt" IS NULL)     AS offers_unsent_affected,
       count(*) FILTER (WHERE "sentAt" IS NOT NULL) AS offers_sent_affected
  FROM deal_offer
 WHERE "deletedAt" IS NULL
   AND snapshot ->> 'kind' = 'contract'
   AND (snapshot ->> 'opening' ~ '\\(\*|_|\||\{|\[|\\)'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot -> 'sections') AS s WHERE s ->> 'body' ~ '\\(\*|_|\||\{|\[|\\)'));
```

```bash
psql "$PRODUCTION_DATABASE_URL" -f r13-count.sql   # the crm database; any read-only role
```

Zero in all three columns: nothing to do. Otherwise the deploy is not blocked, but each text is read
by a person first. List them (ids, names and flags only, never the text) with the same `WHERE`
clauses and `SELECT id, entity, language, name` for templates, `SELECT id, "dealId", number,
"sentAt" IS NOT NULL AS sent` for offers. A template is corrected in Settings before the deploy
(the backslash was meant literally, so write it as `\\`). A stored offer is never re-rendered by this
change: its PDF and snapshot stay as they are (AC-9.4); only editing a classic offer re-renders its
text, so the unsent ones are the ones to open and check after the deploy.

### Before the deploy: audit the stored letterheads (security M-4, DD-76, DD-78, R35)

The new `crm-api` checks a stored letterhead before it uses it: a file over the decoded-size bound
(32 MiB decoded, 8 MiB of non-image data, 10 000 objects, 1 000 streams, 40 MP per image) is refused with
409 `letterhead_unusable` on `GET /entity-profiles/{entity}/letterhead`, on `POST /deals/{id}/offer-draft/generate`
and on `POST /deals/{id}/offers`. A production letterhead that is over a cap would therefore stop that entity's
offers the moment the deploy goes live. **Run the audit against production BEFORE the `crm-api` deploy. A
refusal (exit 1) blocks the deploy**: upload the letterhead again in CRM Settings (the upload is checked and
stored as a copy), or revisit the caps with the owner, and run it again until it exits 0.

The script is read-only (it reads each stored letterhead, at most 5 MiB, and writes nothing: no row, no object)
and prints, per entity, `ok` / `REFUSED <reason>` / `UNREADABLE` / `none` and the figures the bound measured,
never a key, a link or bytes. It is not in the running image yet, so run it from a checkout of the release
commit, with the production `crm-api` variables (`railway run` injects them, including the bucket) and the
`crm` database reached through its public connection string (the private one does not resolve from a laptop;
a read-only role is enough):

```bash
cd crm-api && bun install
railway run --service crm-api --environment production -- \
  sh -c 'DATABASE_URL="$CRM_PUBLIC_DATABASE_URL" bun scripts/check-letterheads.ts'
echo "exit $?"   # 0: every stored letterhead is usable, deploy. 1: a refusal or an unreadable file, do NOT deploy. 2: bucket not configured
```

Keep the printed figures: the caps are set at least four times above them (plan DD-74), and a figure that
has grown close to a cap is a reason to talk to the owner before the deploy rather than after.

### Deploy order: `crm-api`, then the shell, then `crm-ui`. Never the UI first (R4)

1. **`crm-api`.** Safe on its own: `GET /offer-templates` answers classic templates by default
   (`formats=sections`), so the live `crm-ui` is unchanged, and nothing is seeded or archived. Check
   the deploy log for `prisma migrate deploy` applying `20261115120000_offer_wizard`, then
   `GET /health`.
2. **The shell** (Vercel). It carries `@operai/ui` with the new tokens, and a remote runs on the LIVE
   shell's library (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell): the tokens must be
   live before the remote that uses them.
3. **`crm-ui`** (Vercel). A new `crm-ui` against an old `crm-api` meets 404 on `/offer-draft` and
   `/offer-wizard/context` and shows error panels; that is why the UI is last.

The cut-over is not a deploy step. The first read that asks for `formats=wizard` (the first person
who opens Settings › Templates or the offer flow in the new `crm-ui`) seeds welld_ch's seven Italian
wizard templates once and, in the same transaction, archives that entity's Italian classic templates
(AC-9.2). welld_ch English, welld_it Italian and welld_it English keep their classic templates until
a wizard template is created for them. Do not probe `?formats=wizard` by hand on production unless you
mean to switch welld_ch Italian over; for a smoke test, use `GET /offer-templates?entity=welld_ch`
(classic only, changes nothing).

### Release checklist: the CRM bucket must allow GET from the shell origin (R22, DD-54)

The offer preview draws the entity's letterhead in the browser (US-11): `crm-ui` makes a plain `fetch`
of the 60 s presigned GET that `GET /entity-profiles/{entity}/letterhead` returns. Until now the CRM only
POSTed to its bucket from the browser (uploads) and opened downloads with `window.open`, which CORS does
not govern, so **nothing in this repository sets or records the CRM bucket's CORS rule** (it is not in
`.railway/railway.ts`; `bucket("crm", { region: "ams" })` declares the bucket only), and MinIO, which allows
every origin, cannot catch a missing `GET` in dev or e2e. Without it the fetch fails in the browser, the
preview shows no letterhead (a soft failure, AC-11.4) and nothing is logged server-side. Before `crm-ui` is
released, a person with the bucket's credentials (the `CRM_S3_*` values of `crm-api`, in the environment of
this one command, never on a command line) checks the rule:

```bash
export AWS_ACCESS_KEY_ID=<CRM_S3_ACCESS_KEY_ID> AWS_SECRET_ACCESS_KEY=<CRM_S3_SECRET_ACCESS_KEY>
aws s3api get-bucket-cors --endpoint-url <CRM_S3_ENDPOINT> --region <CRM_S3_REGION> --bucket <CRM_S3_BUCKET> \
  | jq -e '.CORSRules | any(.[]; (.AllowedOrigins | index("https://operai.welld.io")) and (.AllowedMethods | index("GET")))'
```

`true` and exit 0: ONE rule allows both the shell origin and `GET` (a single predicate on the same rule: a `GET` rule for
another origin beside an origin-only `POST` rule for the shell prints `false`). The command does not look for a wildcard
origin; read the output of `get-bucket-cors` once and refuse a rule that allows `*`. Anything else (`false`, `NoSuchCORSConfiguration`, an error): add it
with `PutBucketCors`, GET beside POST, the shell origin only (the same rule as § `refund-api` above and the
activities bucket):

```bash
aws s3api put-bucket-cors --endpoint-url <CRM_S3_ENDPOINT> --region <CRM_S3_REGION> --bucket <CRM_S3_BUCKET> \
  --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://operai.welld.io"],"AllowedMethods":["POST","GET"],"ExposeHeaders":["ETag","Location"],"MaxAgeSeconds":3000}]}'
```

There is no `AllowedHeaders` on purpose: the letterhead fetch sends no header of its own (no `Authorization`, no
custom header, `credentials: 'omit'`) and the upload is a form `POST`, so both are simple requests that the browser
does not preflight, and `*` would only widen the rule. If a browser console ever shows a failed preflight for the
bucket, add the one header it names, not `*`. Applying it replaces the bucket's whole CORS configuration: read the
existing rules first and keep any that are there. The shell CSP already lists the bucket origin in `connect-src` and `img-src`
(`https://t3.storageapi.dev`); the preview's own image is a `blob:` URL. Then open one offer preview on the
live site with the browser console open: no CORS error, and the letterhead appears. The `pdfjs-dist` chunks
are crm-ui's own static assets, served by Vercel with the origin that already serves `remoteEntry.js`, so
they need no rule.

### Supersession rollback (R11)

There is no undo in the product, on purpose: the API refuses to restore a classic template while an
active wizard template exists for the entity and language (`409 template_superseded`). To go back for
one entity and language, a person runs this, after `crm-ui` has been rolled back to the classic dialog (an
archived seed counts as present, so the wizard is not seeded again). It archives the wizard templates
FIRST (a seeded "Formazione" would otherwise clash with the classic "Formazione" on the active-name
unique index), then restores the classic templates that supersession archived: those archived from
one minute before the first wizard template of the pair was created. Offers and drafts are left alone:
an offer made with a wizard template stays in the deal's list and downloadable, and a draft stays in
its table, unused.

```sql
-- rollback-supersession.sql   psql "$PRODUCTION_DATABASE_URL" -v entity=welld_ch -v language=it -f rollback-supersession.sql
-- DOCUMENTATION: read the first SELECT, and the two row counts psql prints, before COMMIT.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('crm-offer-templates:' || :'entity'));   -- the lock the application takes

SELECT id, name, format, "archivedAt" IS NOT NULL AS archived, "seedKey", "archivedAt"
  FROM offer_template
 WHERE entity = :'entity'::"Entity" AND language = :'language'::"OfferLanguage"
 ORDER BY format, name;

UPDATE offer_template
   SET "archivedAt" = now(), version = version + 1, "updatedBy" = 'runbook-rollback', "updatedAt" = now()
 WHERE entity = :'entity'::"Entity" AND language = :'language'::"OfferLanguage"
   AND format = 'wizard' AND "archivedAt" IS NULL;

UPDATE offer_template
   SET "archivedAt" = NULL, version = version + 1, "updatedBy" = 'runbook-rollback', "updatedAt" = now()
 WHERE entity = :'entity'::"Entity" AND language = :'language'::"OfferLanguage"
   AND format = 'sections' AND "archivedAt" IS NOT NULL
   AND "archivedAt" >= (SELECT min("createdAt") - interval '1 minute' FROM offer_template
                         WHERE entity = :'entity'::"Entity" AND language = :'language'::"OfferLanguage" AND format = 'wizard');

COMMIT;   -- or ROLLBACK; if the second count is not the number of classic templates the first SELECT shows archived
```

A classic template a person archived by hand after the wizard went live cannot be told apart from
one supersession archived; the first `SELECT` shows each row's `archivedAt` so it can be left out
(add `AND id NOT IN (…)` to the second `UPDATE`). Afterwards `GET /offer-templates?entity=…` lists the
classic templates again, and the classic dialog is what that entity and language use.

## Activities migration (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host/0082/0083)

The CRM's activities, participants, "blocked by" links and meeting host state move into the new
`activities-api`. The move is **expand, switch, copy, unpause, contract**, with a short announced
write pause between expand and unpause (accepted by the owner, AC-2.5). Two rules run through all
of it: a record is "moved" only when the **found-versus-present count** says so, never because a
command exited 0; and the CRM tables are **not dropped** until a later push, after the production
report is clean. A push to `main` redeploys every Railway service in no fixed order (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired), so
the order below is enforced by *what is live when*, not by the push order: wait for each deploy to
be live (and read its log) before the next step.

**Roles.** One person owns the window and is the only one who can end it (`ACTIVITIES_MAINTENANCE`
is a manual variable; a failed copy that is not re-run leaves the pause in place). Announce the
pause to CRM users beforehand: during it nobody can record or change a CRM activity or task, and
the CRM shows "activities unavailable" (AC-1.5).

**Step 0 - preconditions (names only).**
`mise run env:doctor -- --env production` passes; `activities-api` exists on Railway with its own
database (see § `activities-api` service); `ACTIVITIES_SERVICE_CLIENT_SECRET` exists as a Shared
Variable; `ACTIVITIES_MAINTENANCE=true` is already set on `activities-api` **before its first
deploy**; `ACTIVITIES_API_URL` is set on `crm-api`; `VITE_ACTIVITIES_API_URL` is set on the shell's
Vercel project. You hold a connection string for the CRM database for the window of the copy (see
Step 3); the copy writes no file and no dump.

**Step 1 - Expand: the grants, notify, then the new service in maintenance.**
Deploy, in this order, each live before the next:
1. `auth` (new scope `activities.write` among the known scopes). Only then edit `SERVICE_CLIENTS`
   (the `activities-api` entry; `crm-api` gains `activities.write`) and redeploy `auth`; an unknown
   scope stops `auth`.
2. `notify-api` (origin `projects`, binding `system:activities-api` → `crm`, `projects`, email
   footer label). It is additive and harmless with no caller, and it must be live before Step 4,
   the first moment `activities-api` writes and so pushes. Without it every push is refused and the
   refusal is invisible (best effort, the write stands).
3. `activities-api` with `ACTIVITIES_MAINTENANCE=true` (its `preDeploy` applies the
   migration), and `projects-api` with its host endpoint.

Verify (the service is up and refusing):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://activities-api.operai.welld.io/health   # 200: health stays up
curl -s -o /dev/null -w '%{http_code}\n' https://activities-api.operai.welld.io/tasks    # 503: maintenance, before authentication
```

**Step 2 - Switch: the new code that stops using the old tables.**
Deploy `crm-api` (new code; the old activity tables are still in its database, now read only by
the copy), then `shell`, `crm-ui`, `projects-ui` and `notify-ui` (an older `notify-ui` shows the raw
id `projects` as the origin tag: degraded, never broken). From here the CRM's activity writes go to
`activities-api` and are refused with 503 `maintenance`; its meeting-host notices are forwarded and
refused the same way, so the old `meeting_host_state` is frozen. Nothing writes to either side.

**Step 3 - Copy: dry run, then apply, each accounted for.**
The script is in the `activities-api` image, reaches both databases over private networking, and
prints counts, ids and field names only (never an activity subject, body or address). Run it
**inside** the `activities-api` service so its own `DATABASE_URL` is the target; give it the CRM
database as `CRM_DATABASE_URL` in the environment of that one shell. The script takes both
connection strings from the environment only and rejects `--crm-database-url`/`--database-url`
(a URL on a command line lands in `ps` and the shell history). A source activity that refers to a
contact erased in the target (`erased_contact`) is a `mismatched` row (field `contactId`), never
written:

```bash
railway ssh --service activities-api
# inside; CRM_DATABASE_URL = the crm database on the shared Postgres (private domain), set for this shell only
bun scripts/import-crm-activities.ts            # dry run: reads, writes nothing
bun scripts/import-crm-activities.ts            # again: every `found` must be identical (the source is frozen)
bun scripts/import-crm-activities.ts --apply    # one transaction; it re-reads the target and compares before it commits
bun scripts/import-crm-activities.ts --apply    # a second run: inserted=0 (re-runnable, AC-2.2)
```

Gate for every run: per table (`activity`, `activity_participant`, `task_blocker`,
`meeting_mirror_state`) the report shows `found`, `inserted` (dry run: `to-insert`),
`already-present` and `mismatched`, and ends with `ACCOUNTED FOR`. Exit 0 and that line are the
condition to go on. **`mismatched` above 0, `NOT ACCOUNTED FOR`, or a `found` that changed between
two dry runs stops the window**: nothing is written, the script repairs nothing, the pause stays
and the decision goes back to the owner. If `--apply` fails nothing was committed (it rolls back);
fix the cause and re-run. Keep the final report with the release notes; it is the record that the
move was accounted for. The old tables stay untouched, so until the contract push the undo is
"keep the CRM tables" (see Rollback by step).

**Step 4 - Unpause, then prove notifications reach people.**
Only with a clean report from Step 3: set `ACTIVITIES_MAINTENANCE=false` on `activities-api` and
redeploy it. Then:

1. `./infra/check.sh`: the 401 gates are provable again, so no maintenance warning remains for
   `activities-api`.
2. **Retry the meeting notices that arrived during the pause.** `meetings-api` could not deliver
   them while `activities-api` refused (503). `unlinked`/`deleted` notices retry by themselves
   (1 min, 5 min, 30 min, 2 h, then every 6 h) until delivered; `linked`/`changed` ones are **never**
   retried silently and need their creator to press "Try again" on the meeting (it calls
   `POST /meetings/:id/host-notice/retry`). List what is still undelivered since the window began
   (read only; ids and states only; delivered rows are deleted) and have each creator retry:

   ```sql
   -- on the meetings database, read only
   SELECT "meetingId", "creatorUserId", event, policy, state, attempts, "lastErrorCode", "createdAt"
   FROM host_notice WHERE "hostApp" = 'crm' AND "createdAt" >= '<pause start, ISO 8601>' ORDER BY "createdAt";
   ```

   Done when the query returns no row for the window (re-run it after the creators have retried and
   the automatic ones have had their next attempt).
3. **Assign one test task in each host to a second person** (a CRM task on a company, a task on a
   project) and check that each reaches that person's `/notify` page with the origin "CRM" and
   "Projects" respectively. notify-api's `caller=system:activities-api` log line alone does **not**
   prove it (the middleware logs it before the route's 400/403, and the push is best effort, so a
   refusal is otherwise invisible). Delete the two test tasks afterwards.

**Step 5 - Contract: a LATER push, never with the switch.**
Only after the production report of Step 3 is filed and clean, and the CRM has run on
`activities-api` for a while with nothing amiss, merge the separate crm-api migration (specs/20261110-activities T14)
that drops `task_blocker`, `activity_participant`, `activity`, `meeting_host_state` and the
`ActivityType` enum. Its commit says it ships only after the import report. It is **one-way**: take a
database backup first, and never put it in the same push as Step 2 (AC-2.3: nothing leaves the CRM
until the copy is accounted for). Afterwards verify that `crm-api` is healthy and that the CRM's
timeline and tasks still load (they no longer depend on those tables).

### Rollback by step
- Before Step 3 applies: nothing was copied. Redeploy the previous `crm-api`, `crm-ui` and `shell`
  if the CRM must come back; delete nothing.
- After Step 3, before Step 4's unpause: the CRM tables are intact. Keep the pause on, fix the cause
  and re-run the copy; or redeploy the previous `crm-api`/`crm-ui` (the CRM's own tables hold
  everything up to the freeze) and leave `activities-api` in maintenance.
- After the unpause, before Step 5: `activities-api` now holds records the CRM tables do not, so
  going back to the previous `crm-api` loses them. Roll forward (fix and redeploy) instead; the old
  tables are only a fallback for the state at the freeze.
- After Step 5: one-way; restore from the backup taken before it.

## Legal entities rollout (specs/20261117-legal-entities, ADR 20261117-the-crms-legal-details-move-to-the-registry-by-expand-copy-switch-contract-and-version-1-is-attributed-to-the-system, ADR 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds)

The legal name, address, VAT number and IBAN of `welld_it` and `welld_ch` move from `crm-api`'s
`entity_profile` into a registry in `auth`, so that the CRM, the letterhead service and the
administration page all print and edit one set of details. The move is **expand, credentials,
copy, switch, contract**, with an announced freeze of the CRM's entity settings between the copy
and the switch. Three rules run through all of it:

- A push to `main` redeploys every changed Railway service and Vercel frontend in no fixed order
  (ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired), and `auth` **refuses to start** with a `SERVICE_CLIENTS` scope it does not know. So the
  order below is enforced by *what is live when*: wait for each step to be live, and read its log,
  before the next.
- The copy is "done" only when the **report** says so (both entities `inserted`, `present` or
  `resolved`, `mismatched` 0, flags read by the owner), never because a command exited 0 once.
- The CRM's four columns stay until Step 6, in a later release, so that reverting the switch is a
  working undo. **Registry saves made after the switch are not in the CRM** (see Rollback by step).

Everything below is commands and variable **names**. No value, connection string or secret is
written in this file, in the release log or in a chat; the copy's report prints counts, categories
and field names only, and can be pasted into the release log as it is.

**Roles.** One person (the release owner) runs the steps and owns the freeze; an agent may prepare
the commands, but the production ones are run by the owner, with the production credentials in the
environment only. Steps 1, 5 and 6 are releases (RELEASING.md); Steps 2
to 4 and 5b are environment and operator steps with no code push.

**Release order (plan G15, owner decision 2026-11-17).** Push 1 is **not** released early: both pushes go out at the
end, in one release session, still as two pushes, because the copy (Step 3) needs the push-1 `auth` live and the
push-2 consumers need the copy. The order, nothing skipped, nothing reordered:

1. QE passes (T45) and the security re-review is closed (T70), before anything is pushed.
2. **Push 1** (Step 1): `auth`, `@operai/ui`, shell and **`notify-api`** (the notice path needs its idempotency
   migration and the `legal_entity_change` template live first; an old `notify-api` answers 400 to the new template
   and `auth` would only retry it).
3. Steps 2, 3 (**copy role first**, 3a) and 4.
4. **Push 2** (Step 5): `crm-api`, `crm-ui`, `letterhead-api`, `letterheads-ui`, `admin-ui` and **`auth` again**
   (the US-9 notices: outbox and dispatcher).
5. Step 5 smoke and Step 5b (the post-switch dry run), then **drop the copy role** (3b).
6. **Step 7** (set `LEGAL_ENTITY_NOTICE_EMAIL`, confirm a notice arrives), and **only after it** may anyone but the
   `admin` role be granted `legal-entity:manage`.

Between push 1 and push 2 (minutes, same session) a save by an administrator stores no notice: only the `admin`
role holds the grant then (the seed), and the copy itself is never a protected change (AC-9.16).

### Variables (names; nothing here is a value)

| Where | Variable | What it is |
|---|---|---|
| Railway **Shared Variable** (project level) | `LETTERHEAD_SERVICE_CLIENT_SECRET` | **NEW.** The secret of the new `letterhead-api` service client: 32-256 random characters (`openssl rand -hex 32`, 64 characters), no 1Password item, never written to a file. Referenced from BOTH sides below, byte-identical by construction. |
| `auth` | `SERVICE_CLIENTS` | **Two edits.** The `crm-api` entry's `scope` gains `legal-entities:read` (it keeps every scope it has, `letterhead:render` included). A new entry `"letterhead-api":{"secret":"${{shared.LETTERHEAD_SERVICE_CLIENT_SECRET}}","scope":"legal-entities:read"}`: exactly that scope, nothing else. Shape of the whole variable: `tools/env-doctor/templates/production/auth.env`. |
| `letterhead-api` | `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` | **NEW.** `letterhead-api` / `${{shared.LETTERHEAD_SERVICE_CLIENT_SECRET}}`. Code that does not read them yet ignores both, so they can be set before the switch. |
| `auth` | `LEGAL_ENTITY_NOTICE_EMAIL` | **NEW, optional (AC-9.10, plan G4).** One email address **outside the suite** that also receives every protected-change notice (legal name, VAT number, IBAN), for both entities, whoever saved. Unset = no outside recipient, nothing else changes. A malformed value stops `auth` at startup (the new deployment then fails its `/health` check instead of replacing the running one). **Set by the owner at Step 7, in the dashboard only**, after push 2 is live: the template holds only a comment, never the address, and the address never goes in a file, a log or a chat. env-doctor's manifest holds the rule (`legalEntityConfigProblems`: one address, or unset) and its test checks the shipped template, but `mise run env:doctor` does not yet apply it to a deployed value: read the variable in the dashboard after setting it. |
| `auth` | `LEGAL_ENTITY_WRITE_RATE_LIMIT`, `LEGAL_ENTITY_CHECK_RATE_LIMIT`, `LEGAL_ENTITY_RATE_WINDOW_MS` | **NEW, optional, leave unset in production** (security review F3, plan G9). Per person, per replica: saves and restores share the write limit (default **10**), the dry-run check has its own (default 60), one window for both (default 600000 ms). **Production must not set the write limit above 10**: env-doctor's test refuses a template that does, and a value that is not an integer stops `auth` at startup. The e2e stack raises the write limit in `auth/.env.example` (local only). |
| `notify-api` | none | Push 1 carries its additive migration (idempotency columns), applied by its `preDeploy` like `auth`'s. Its email group must already be configured (`EMAIL_ENABLED=true`, sender and key: § Resend domain setup): without it every email notice is `skipped` and retried for 24 h, then given up. |
| `crm-api` | none | Its registry client uses the `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` pair it already has (plan, E14); its env contract does not change. |
| the operator's shell, for Steps 3, 4 and 5b only | `DATABASE_URL`, `CRM_DATABASE_URL` | The registry's database (`auth`'s own, already in the service's environment) and the CRM's database, **opened as the copy role of Step 3a** (`legal_copy_ro`, a `SELECT`-only role that exists only for the copy window), the URL assembled by hand in that one shell. **Environment only**, never arguments (a URL on a command line lands in `ps` and the shell history), never stored (ADR 20261110-activities-service-access-delegated-to-host, amendment L4). |

The scope is `legal-entities:read` (colon form, like `letterhead:render`), **not** `companies:read`
and not `crm.companies.read`, which is about the CRM's customers. `.railway/railway.ts` is **not**
changed by this feature (no new service, domain or bucket; the project's variables are unmanaged):
`railway config plan` must still show no drift at each push.

### Step 0 - preconditions (names only)

- On the release commit, `mise run env:doctor` passes (the committed contract already carries the
  new link: `crm-api` and `letterhead-api` against `auth`'s `SERVICE_CLIENTS`).
- The owner has decided the spec's drift points D7 and D8 and has read both IBANs in the production
  CRM Settings (the early check R2: does grouping in fours change their print), and has the day-before issuer
  lines of both entities in a note (Step 5 compares with them).
- Announce **now**, for the whole window up to Step 5: *the CRM's entity settings (legal name, address, VAT number, IBAN) are not edited*.
  This is an announcement, not a code refusal; the pre-switch dry run (Step 4) is what catches a
  slip.
- QE has passed (T45) and the security re-review is closed (T70): this release is run once, at the end.
- **Do not grant `legal-entity:manage` to anyone but the `admin` role until Step 7 is done.** Push 1 makes
  `auth` derive the Admin tool into `apps` for a holder of that permission, while the old `admin-ui` has no
  section for them (so not before push 2 is live); and a manager changing the IBAN must be one whose change is
  announced to the administrators and to the outside mailbox, which is only true once Step 7 has confirmed a
  notice. The seed grants it only to the `admin` role, who already reach `admin-ui`.
- The owner has chosen the address for `LEGAL_ENTITY_NOTICE_EMAIL` (OQ-7), or has decided to leave it unset;
  and has a throwaway password ready for the copy role (Step 3a: `openssl rand -hex 24`, never stored).

### Step 1 - Expand (push 1): auth, `@operai/ui`, shell, notify-api

Push 1 is **not the branch head**: build it as a branch from `main` holding only the push-1 commits
(auth, `operai-ui`, shell, **notify-api**, docs and specs, their changesets), rebased in branch order (tasks.md, T16).
`auth` gets the migration (table and trigger), the routes, the scope `legal-entities:read` among its
known scopes, the derived `apps` entry and the import script, and the hardening of those routes (a deleted
person is refused, saves and restores are throttled, the history is paged, the dry-run `check` route that
push-2's `admin-ui` calls); `notify-api` gets its additive idempotency migration, the `legal_entity_change`
template and per-recipient delivery, which `auth`'s notices (push 2) need live first; the library ships with the
shell so a remote never loads before a shell that has its new exports. No consumer reads the registry yet, and
`auth` sends no notice yet (that is push 2).

Release exactly as RELEASING.md says (before, release, after):

```bash
mise run env:doctor && mise run shared:check && mise run react:skew && mise run ui:check
railway config plan                      # no drift, nothing destructive
pnpm exec changeset status --verbose     # auth (minor), notify-api (minor), @operai/ui (minor), shell (patch)
mise run release:version                 # then commit, as RELEASING.md says
mise run release:tag
git push --follow-tags                   # deploys auth and notify-api (preDeploy applies each migration), shell, and the rest that changed
```

Gate to go on (observed, not assumed):

```bash
curl -s https://auth.operai.welld.io/health        # the new auth version; the migration ran in preDeploy
curl -s https://notify-api.operai.welld.io/health  # the new notify-api version; its migration ran in preDeploy
curl -s https://operai.welld.io/version.json       # {"version":"<push-1 version>"}: the library change is live
railway config plan                                # still no drift
```

and, signed in, `https://auth.operai.welld.io/legal-entities` answers **both** entities with
`version: 0`. Read `railway logs --service notify-api | head` for a migration error: an old `auth` never
calls the new fields, but push 2's `auth` must find them.

### Step 2 - Credentials (environment only, no code)

Only after Step 1 is live (the new `auth` knows the scope; an old `auth` would refuse to start with it).

1. In the Railway project's **Shared Variables**, create `LETTERHEAD_SERVICE_CLIENT_SECRET` with a
   fresh random value (`openssl rand -hex 32`, pasted into the dashboard only).
2. On `auth`, edit `SERVICE_CLIENTS`: add `legal-entities:read` to the `crm-api` entry's scope and add the
   `letterhead-api` entry (both shapes in the table above), then let `auth` redeploy. Check the resolved
   JSON in the Variables tab. A typo in a scope stops `auth` at startup; the new deployment then fails
   its `/health` check instead of replacing the running one: read `railway logs --service auth`,
   fix the variable, redeploy.
3. On `letterhead-api`, set `SERVICE_CLIENT_ID=letterhead-api` and
   `SERVICE_CLIENT_SECRET=${{shared.LETTERHEAD_SERVICE_CLIENT_SECRET}}`.
4. Verify, with the real values:

```bash
curl -s https://auth.operai.welld.io/health                              # auth restarted healthy on the new SERVICE_CLIENTS
railway logs --service auth | head                                       # no scope or SERVICE_CLIENTS error at startup
mise run env:doctor -- --env production --resolve                        # green: 1Password items exist, the link is checked
mise run env:doctor -- --env production --live                           # green: the DEPLOYED values, secrets shown only as fingerprints
```

   Do not try the new credential by hand with `curl`: the secret would land in your shell history.
   The doctor compares the two secrets and the scopes without printing them. Log the outcome in the
   release log (no secret). To **revoke** the client, remove its `SERVICE_CLIENTS` entry (tokens already
   minted expire within 5 minutes); to **rotate**, change the shared variable, then redeploy `auth` and
   `letterhead-api`.

### Step 3 - Copy: dry run, apply, dry run

The script `auth/scripts/import-crm-legal-details.ts` is **in `auth`'s production image** (the
Dockerfile copies it; nothing else of `scripts/`). Run it inside the running `auth` service, so its own
`DATABASE_URL` is the target and the CRM's database is on the same private Postgres. The CRM's
connection string is **not** `auth`'s own: since the security review (F5) it is the one of a role that can only
read (Step 3a), assembled in that shell. It copies **nothing but version 1**, attributed to the system, with one `legal_entity.import` audit row per
entity, under the entity's advisory lock; it never overwrites or repairs, and prints no value except each IBAN's last four characters (below).

Announce the freeze first (Step 0). Then, in order: 3a the copy role, the three runs below, and (after Step 5b) 3b.

#### 3a - The copy role (security review F5, item 1)

The script opens the CRM session read only, but that is a session default any statement can override, and `auth`'s
own database role can write to the CRM database on the shared Postgres. So "read only" would hold only because the
script happens to issue `SELECT`s. For the copy window it runs as a role the database itself limits: `SELECT` on
**seven columns of `entity_profile`** and nothing else, in the `crm` database. Those are the four legal columns
(`legalName`, `addressLines`, `vatNumber`, `iban`), `updatedAt` and `updatedBy` (the import's audit row names who
last edited the row) and **`entity`**, which the script filters on: Postgres needs the privilege on a column used
in a `WHERE`, so without it the first read fails with `permission denied`. No other column (`offerTermsEn`,
`letterheadKey`, …) and no other table is readable. The role is created before the first dry run and **dropped
after Step 5b** is logged (Steps 4 and 5b read the CRM too); if the window is abandoned, drop it that day.

```bash
openssl rand -hex 24 | pbcopy      # on your machine: a throwaway password, hex only (it goes into a URL); the clipboard only, no file
railway connect Postgres           # a psql session as the database administrator; Railway supplies the credentials
```

```sql
CREATE ROLE legal_copy_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
-- next line: paste the password at both prompts (not echoed, not in the history, sent hashed). Never `PASSWORD '...'`: the literal is logged
\password legal_copy_ro
ALTER ROLE legal_copy_ro SET default_transaction_read_only = on;
\c crm
GRANT CONNECT ON DATABASE crm TO legal_copy_ro;
GRANT USAGE ON SCHEMA public TO legal_copy_ro;
GRANT SELECT ("entity", "legalName", "addressLines", "vatNumber", "iban", "updatedAt", "updatedBy") ON TABLE "entity_profile" TO legal_copy_ro;
```

Prove the limit before relying on it (`SET ROLE` tests the role's privileges from the administrator's session; read
the output, do not assume it):

```sql
SET ROLE legal_copy_ro;
SELECT count(*) FROM entity_profile;                                 -- works
SELECT "offerTermsEn" FROM entity_profile;                           -- ERROR: permission denied for table entity_profile
SELECT "letterheadKey" FROM entity_profile;                          -- ERROR: permission denied
UPDATE entity_profile SET "updatedBy" = "updatedBy" WHERE false;     -- ERROR: permission denied (checked even though no row matches)
SELECT 1 FROM deal_offer LIMIT 1;                                    -- ERROR: permission denied for table deal_offer
RESET ROLE;
\q
```

All four errors, and the `count`, or stop: do not run the copy with a role that reads more. (Rehearsed on compose by
QE, T45, with `docker compose exec postgres psql -U postgres` in place of `railway connect`.) Then, in the shell
that will run the script, build the URL by hand from `auth`'s own host, with the password pasted at a prompt:

```bash
railway ssh --service auth
# inside (the image's shell, user bun, /app):
cd /app
unset HISTFILE
read -rsp 'copy role password: ' COPYPW; echo           # paste; not echoed. If this shell lacks `read -s`: stty -echo; read COPYPW; stty echo
rest="${DATABASE_URL#*@}"                               # host:port/database of auth's own URL (if it has a ?query, build the host part by hand)
export CRM_DATABASE_URL="postgresql://legal_copy_ro:${COPYPW}@${rest%/*}/crm"   # same server, database `crm`, the copy role
unset COPYPW rest
echo "${DATABASE_URL##*/} ${CRM_DATABASE_URL##*/}"      # database NAMES only: "auth crm"
echo "${CRM_DATABASE_URL#*://}" | cut -d: -f1           # the role name only: "legal_copy_ro" (never the password)
bun run scripts/import-crm-legal-details.ts             # 1. dry run: reads the CRM, writes nothing
bun run scripts/import-crm-legal-details.ts --apply     # 2. version 1 of each entity that has none, with its audit row
bun run scripts/import-crm-legal-details.ts             # 3. dry run again: the move is accounted for
```

The role is the same for Steps 4 and 5b: stay in this shell, or rebuild the URL as above. **Do not** fall back to
`auth`'s own connection string if the role fails (`permission denied`, `password authentication failed`): fix the
role (3a) instead; the whole point is that the database refuses what the script should never do.

`--json` prints the same report as JSON. Exit codes: **0** accounted for; **1** a `mismatched` or a
failure (the report or `import failed: <code>` says which); **2** `crm_legal_columns_absent` (the CRM's
columns are dropped: the move is over, Step 6 happened); **64** usage (an unknown argument, a missing
or equal pair of connection strings).

**The CRM session must open read only.** The script opens it with `default_transaction_read_only = on`
as a startup parameter and reads the setting back before it reads anything: a server or pooler that
drops the parameter ends the run with `crm_not_read_only` (exit 1, nothing read), by design. Check it
on the real image: **the first dry run is that check**, and a run that reaches the report has passed
it. If it ends `crm_not_read_only`, stop, do not work around it (no pooler URL, no other role), and
report it. Use the private-domain connection above, direct to Postgres.
To check the same on the image **before** the window, from a checkout with the compose databases up,
without touching any environment (a dry run: no `--apply`; local credentials, as `mise run
legal-entities:import` uses):

```bash
docker build -t auth-import-check auth
docker run --rm --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5435/operai_auth" \
  -e CRM_DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5435/crm" \
  auth-import-check bun run scripts/import-crm-legal-details.ts          # a report and exit 0, not crm_not_read_only
docker run --rm auth-import-check bun run scripts/import-crm-legal-details.ts --help   # usage, exit 64: the script is in the image
```

**Reading the report.** One line of counts (`found`, `inserted` - in a dry run `would insert` -,
`present`, `resolved`, `mismatched`), one line of flags (`incomplete`, `invalid`, `ibanPrintChanged`),
then a block per entity and the closing line `ACCOUNTED FOR` or `NOT ACCOUNTED FOR`. Per entity:

Under each entity's category line the report prints **one IBAN line** (security review F5, item 3): `IBAN …1234`, `IBAN set`
or `IBAN none`. It is the only part of an IBAN the report, the log or any notice ever shows, and it is what lets the
owner check the copy against something other than the CRM itself:

| Line | Meaning |
|---|---|
| `IBAN …1234` | the last four characters of the IBAN being copied, as the CRM holds it (spaces and case ignored) |
| `IBAN set` | there is an IBAN but nothing is shown: it has 8 characters or fewer, or its last four are not letters and digits |
| `IBAN none` | the CRM holds no IBAN for the entity |

**How the owner reads it.** (1) On the **first dry run, before `--apply`**, compare each entity's four characters with the
IBAN on the bank's own document (the account statement or the bank's letter), not with the CRM screen: `present`
proves the copy equals the CRM, not that the CRM was right, and this is the only check against the bank. (2) The
line must be **identical on every later run**: the second dry run, Step 4, Step 5b. A different tail means the CRM
value was edited during the freeze: stop, find out who edited the CRM row, and settle it with a registry save before going on. The tail does not replace `mismatched`, which catches an
edit anywhere in the number. (3) `IBAN set` cannot be checked this way: read that IBAN in full in the CRM Settings
against the bank's document, by eye, and write "checked by eye" in the release log. (4) An `IBAN none` you did not
expect: stop before `--apply` and find out why. The four characters may be copied into the release log with the counts.

| Category | Meaning |
|---|---|
| `inserted` (dry run: `would_insert`) | no version existed; version 1 written (or would be) from the CRM row |
| `present` | a version exists and the CRM row, under the mapping, equals version 1 |
| `resolved` | the CRM row differs from version 1 but equals the **current** registry version on the four values the CRM holds: someone carried the CRM edit into the registry |
| `mismatched` | differs from both: an edit made in the CRM after the copy. **Nothing is overwritten**; the entity is not moved until an administrator resolves it |

**Gate for every run:** both entities `inserted`, `present` or `resolved`, `mismatched` 0, the closing
line `ACCOUNTED FOR`, and the owner has read the flags: `incomplete` (a required value is missing: the
CRM refuses offers for that entity after the switch until a registry save completes it, so
complete it **before** Step 5), `invalid` (a value today's rules refuse, moved as it is: the page marks "Needs
correction", documents print as before), `ibanPrintChanged` (the IBAN now prints in groups of four: the
owner signs off each one, D2). The first and the third dry run must show the same `found` (the source
is frozen); the third must show `inserted 0` / `present 2`. A re-run of `--apply` inserts nothing, writes
no audit row and exits 0. If `--apply` fails on the second entity, the first stays inserted and the
next run reports it `present`. `crm_entity_profile_absent` means the wrong database. Keep the three
reports (counts and flags only) in the release log with the date of the freeze announcement.

### Step 4 - Pre-switch check (just before push 2)

Run the same dry run once more from `auth`, immediately before cutting push 2:

```bash
railway ssh --service auth
cd /app        # CRM_DATABASE_URL = the copy role's, built as in Step 3a (the role still exists until Step 5b is logged)
bun run scripts/import-crm-legal-details.ts      # present/resolved 2, mismatched 0, the IBAN lines unchanged
```

A `mismatched` entity, or an IBAN line that differs from the copy's, means the CRM's legal fields were edited after the copy. **The switch does not
happen.** An administrator resolves it with a registry save (the Legal entities page or its API, a new
version carrying the edit); re-run until the entity reads `resolved`. The script never repairs it and
the CRM columns are never edited back. Keep Step 4 and push 2 close together: an edit between them is
not detected until Step 5b.

### Step 5 - Switch (push 2), smoke, then Step 5b

Push 2 is crm-api, crm-ui, letterhead-api, letterheads-ui, admin-ui and **auth** (the US-9 notices: the outbox
table and the dispatcher; its migration runs in `auth`'s `preDeploy`) together; it is correct in
whatever order they come up (content version 2 fails closed against an old `letterhead-api`; `crm-api`
ignores the legacy legal keys from an old `crm-ui`; `crm-ui` falls back to `issuerAddressLines` from an old
`crm-api`; `admin-ui` only calls `auth`, already live, and needs only push 1's `check` route; `auth`'s notices need only push 1's
`notify-api`, and an old `notify-api` answering 400 is retried). Release as in Step 1 (`pnpm exec changeset status
--verbose`, `mise run release:version`, commit, `mise run release:tag`, `git push --follow-tags`),
with Step 4's dry run just before. After the push:

```bash
curl -s https://operai.welld.io/version.json                 # the new suite version, once the shell's Vercel deploy is live
curl -s https://crm-api.operai.welld.io/health              # crm-api reports its new version: the freeze ends here
curl -s https://letterhead-api.operai.welld.io/health       # letterhead-api reports its new version
curl -s https://auth.operai.welld.io/health                  # auth reports the push-2 version; its notice table migration ran in preDeploy
railway config plan                                          # still no drift
```

End the freeze announcement when `crm-api` is live. Then **smoke, per entity** (`welld_it`, `welld_ch`):
preview an offer in the CRM (the classic path and, where `LETTERHEAD_SERVICE_ENABLED` is `true`, the
service path) and compare its issuer lines with the day before. They must be identical, apart from the
contacts line and the IBAN grouping the owner signed off. A document that prints no issuer, or an
offer refused with a message naming a missing value, means the entity is incomplete in the registry:
complete it on the Legal entities page.

**Step 5b - the post-switch dry run.** From now on the CRM's `PUT` ignores the legal keys, so the columns are
final. Run the dry run once more (commands of Step 4): `mismatched` 0. A mismatch is an edit made between
Step 4's check and `crm-api` going live; resolve it with a registry save. Log the report (counts, flags and the
IBAN lines). **Then drop the copy role** (Step 3b); the copy window is over.

#### 3b - Drop the copy role (Step 3's last act, after Step 5b is logged)

Leave the `railway ssh` shells first (`exit`), so no session holds the role, then:

```bash
railway connect Postgres
```

```sql
\c crm
DROP OWNED BY legal_copy_ro;                                  -- revokes its table, schema and database privileges
DROP ROLE legal_copy_ro;
SELECT count(*) FROM pg_roles WHERE rolname = 'legal_copy_ro';   -- 0
```

Write "copy role dropped" and the count in the release log. The password was a throwaway and is not kept anywhere.

**Do not grant the managers yet:** Step 7 comes first.

### Step 7 - Notices on, then managers (the end of the same release session)

Added by the security-review amendment (T71, AC-9.8, AC-9.10); numbered 7 to keep the older steps' numbers, it runs
**right after Step 5b**, before Step 6 (which is a later release). Precondition: push 2 is live and Step 5b is logged.
Until this step is done only the `admin` role holds `legal-entity:manage`.

1. **Decide the address** (the owner, OQ-7): one mailbox **outside the suite** that the owner reads, for both
   entities. Deliberately leaving it unset is allowed (the notices then go to the people only): write which it is
   in the release log.
2. **Set `LEGAL_ENTITY_NOTICE_EMAIL`** on `auth` in the Railway dashboard (typed there only: never in a file, the
   template, a log or a chat) and let `auth` redeploy. A mistyped address stops `auth` at startup (R21): the new
   deployment fails its `/health` check instead of replacing the running one; read `railway logs --service auth`,
   fix the variable, redeploy.
3. **Check, with observed output:**

```bash
curl -s https://auth.operai.welld.io/health                                       # healthy on the new variable
railway logs --service auth | grep -iE "dispatcher|legal_entity_notice" | head    # the dispatcher started; no legal_entity_notice_overdue
mise run env:doctor -- --env production --live                                    # green for the values it checks
```

   and `notify-api` sends email (its email group configured; an unconfigured one makes every email notice
   `skipped`, retried for 24 h, then `notice_given_up`).
4. **Confirm a notice arrives.** The next protected change (legal name, VAT number or IBAN) made by an administrator
   must produce, within about a minute, the in-app notice in the notification centre and the email for each
   administrator, the actor included, and the email in the outside mailbox. The owner reads those and notes the date
   in the release log (no address and no value in it). If no protected change is due soon, a deliberate one and its
   restore (two notices, two history rows that stay) is the owner's call: the issuer's details print as the
   changed value for up to a minute (consumers cache for at most 60 seconds), so do it when no document is being
   issued, or record why none was triggered. If a notice does **not** arrive, read the entity's history and
   `railway logs --service auth` (`legal_entity_notice_failed` names row, channel and reason, never a value),
   fix, and do not go on: rows are retried for 24 hours.
5. **Only then** grant `legal-entity:manage` to the people who manage the details through the role editor,
   unconditioned for both entities or conditioned on the `entity` attribute for one (a Swiss accountant: `welld_ch`
   only). They then see only the Legal entities section of Admin. Record the date from which managers may be granted.

### Step 6 - Contract (a later release, never with the switch)

Only after Step 5 has been live in production for a while and the reports are filed: a `crm-api` migration
drops `legalName`, `addressLines`, `vatNumber` and `iban` from `entity_profile`, and the `issuerAddressLines`
compatibility field and the legacy-key tolerance go. It is **one-way**: take a database backup first, and
never put it in the push of Step 5. The CHANGELOG of push 2 names it as the next step. After it the import
script exits **2** `crm_legal_columns_absent` before reading any row (expected); it stays in the repository
as history.

### Rollback by step

- **Before Step 3 applies:** nothing was copied. Push 1 is inert (the registry answers `version: 0`, no
  consumer reads it); to withdraw the credentials, remove the `letterhead-api` entry from
  `SERVICE_CLIENTS` (the new scope may stay on `crm-api`: `auth` still knows it).
- **Any time before Step 5b is logged:** the copy role is the only extra thing created; if the window is abandoned,
  drop it (Step 3b) that day.
- **After Step 3, before push 2:** the CRM is still the source; registry version 1 exists and is unused. Nothing to
  undo; a re-run changes nothing.
- **After push 2, before Step 6:** revert push 2 (redeploy the previous `crm-api`, `crm-ui`, `letterhead-api`,
  `letterheads-ui` and `admin-ui`): the CRM columns are intact, so offers print CRM-sourced issuers again.
  **Registry saves made after the switch are not in the CRM, and reverting loses them.** Before reverting, read
  the registry history of both entities (version, who, when, changed fields), and after the revert re-enter any
  change in the CRM's entity settings by hand; a document made after the revert prints the CRM's values.
- **Step 7:** to stop the outside mailbox, unset `LEGAL_ENTITY_NOTICE_EMAIL` and redeploy `auth` (the people still get
  their notices; a notice row already stored for the outside address ends `given_up` `outside_address_unset`). If the
  notice path does not work, do not grant managers; revoke any grant already given until it does.
- **After Step 6:** one-way; restore from the backup taken before it.

## Accounting release runbook (specs/20261119-accounting, ADR 20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it; plan § Deploy order, D20, D21, D30)

**Document only. No agent runs any step below**: provisioning, the variables, the push, the seed and the Refund release are the
owner's (task T52), in the main session, each step asking for its own yes. Nothing here has been run; the commands marked *(unverified)*
use a Railway or Vercel CLI form this repository has not exercised, so read the CLI's own `--help` before the first use.

The feature moves Refund's chart of accounts, VAT codes and exchange rates into a new service, `accounting-api`, with its own database,
UI remote and authorization catalog, and it replaces Refund's release script (the 20261118 runbook, § Release runbook — refund accounting
export, steps 1–4 of which stand). **One push** to `main` redeploys every changed service in no fixed order (RELEASING.md; D21), so every
pairing must fail closed during the window:

| Pairing during the window | What happens |
|---|---|
| new refund-api before Refund's release script | every approval answers 409 `accounting_release_pending` (the D6 gate of 20261118) |
| new refund-api before Accounting answers | 503 on what needs Accounting (`accounting_unavailable`); nothing is written |
| new refund-api without `ACCOUNTING_INTERNAL_URL` | it exits 1 at startup, the healthcheck never passes and **the previous deployment keeps serving** (hence step 2 before the push) |
| accounting-api before `auth`'s `accounting` catalog | 403 for everyone |
| the shell before accounting-ui | the remote's error panel, and only for holders of the derived app |
| `auth` edited with a scope it does not know | `auth` refuses to start (R13): never edit `SERVICE_CLIENTS` before step 4's check |

**Approvals are refused from step 3 to step 7.** Run the release outside the monthly batch day; with steps 0–2 done beforehand the window
is minutes (R1). Do not start step 3 until step 2 is complete and `mise run env:doctor -- --env production` is green.

**Step 0 — Before.**
- Accounting signed off the lists and the defaults on 2026-11-19 (T50 of this spec, T39 of 20261118): `accounting-api/scripts/data/seed.welld-ch.json`
  (19 ledger accounts, 6 VAT codes) and `refund-api/scripts/data/accounting-defaults.welld-ch.json` (the default account of each of the 14 expense types; no VAT
  default). What stays open: the seed or typing by hand, and the VAT code labels, written by the operator until accounting confirms them.
- **The 2026 baseline list is a release input** (`--offsets <csv>`, required; § Release runbook — refund accounting export, "Before anything"): prepared
  **outside the repository** (it names people), derived with `bun run receipt-baseline:from-register --register <csv>` (T64) and confirmed by accounting.
  Without it step 7 writes nothing and exits 3. A header-only file states that no employee has a hand-issued number.
- The AFC live check, once from a networked machine: `cd accounting-api && ACCOUNTING_LIVE_RATES=1 bun test src/rates/afc.live.test.ts` (EUR 0.9246 for 2026-03).
- From a checkout of the release commit (the one whose `.railway/railway.ts` declares `accounting-api`), at the repository root:
  `mise run env:doctor -- --env production` is green, and `railway link -p 3bafd4c0-226f-4621-821b-a063976498a2 -e production` is done.

**Step 1 — Provision, without a source.** `railway config plan` must show **only** `+ service accounting-api`: anything else, and any
delete, is a stop, and `--confirm-destructive` is never passed (§ Railway configuration as code). The block is committed without `source`
and without `domains` (§ `accounting-api` service), so the provisioning script's audit prints one expected ✗ ("does not declare
domains"), and it does not run `railway config apply` itself while that ✗ stands:

```bash
railway config plan                                  # only: + service accounting-api. Read it.
railway config apply                                 # creates the service UNBUILT (no source), asks for confirmation
./infra/provision-tool.sh accounting --port 8089                 # read-only audit: expect ✗ on `domains`, and on "NOT on origin/main" until step 3
./infra/provision-tool.sh accounting --port 8089 --apply         # database `accounting` on the shared Postgres, the variables by reference
railway domain accounting-api.operai.welld.io --service accounting-api --port 8089     # (unverified form; the letterhead-api precedent used `railway domain … --service … --port …`)
./infra/provision-tool.sh accounting --port 8089 --apply         # again: the DNS records (CNAME, then the verification TXT), the Vercel project `accounting-ui`, host
                                                                 # accounting.operai.welld.io, and the shell's two variables ACCOUNTING_REMOTE_URL / VITE_ACCOUNTING_API_URL
railway config pull                                  # the domain appears in the file: declare it in the accounting-api block, commit (it travels with the push)
```

- **Do not open or `curl` the new hostnames** until the script reports that they resolve: a lookup before the record exists is cached as
  "no such host" for 30 minutes (§ Provisioning a new tool).
- The Vercel project's first deployment, and connecting the source, need `accounting-api/` and `accounting-ui/` on `origin/main`; the script
  says "NOT on origin/main" and skips them until step 3.
- **Apply from the release commit only, never from `main`.** Until the push, `main`'s `.railway/railway.ts` does not declare `accounting-api`,
  so a plan from `main` would DELETE the service you just created, and the scheduled `railway-drift` job fails by design (R18). Nobody applies
  in that window.
- The audit's remaining ✓ and `+` lines must be read, not skipped: a `+ variable …` after the second `--apply` is a variable that was not set.

**Step 2 — Variables.** Everything for `accounting-api` is set by the script from `tools/env-doctor/templates/production/accounting-api.env`
(§ `accounting-api` service). By hand, and before the push:

| Service | Change |
|---|---|
| `refund-api` | **set** `ACCOUNTING_INTERNAL_URL=http://${{accounting-api.RAILWAY_PRIVATE_DOMAIN}}:${{accounting-api.PORT}}` (private networking, never the public domain), e.g. `railway variable set 'ACCOUNTING_INTERNAL_URL=…' --service refund-api --skip-deploys` so nothing redeploys. **Required**: a refund-api without it exits 1 and keeps its previous deployment. |
| `refund-api` | **remove** `REFUND_FX_SOURCE` (retired; a leftover is ignored, and `env:doctor` flags it by name). Dashboard. |
| shell (Vercel) | `ACCOUNTING_REMOTE_URL` (`https://accounting.operai.welld.io/remoteEntry.js`) and `VITE_ACCOUNTING_API_URL` (`https://accounting-api.operai.welld.io`) — build-time, set by the script; check they exist **before** the shell is redeployed (§ Provisioning a new tool). |

Then `mise run env:doctor -- --env production --live` (it pulls the real values with the Railway CLI): green, with no finding about
`accounting-api` or `refund-api`. The scope is not part of that check yet (step 4).

**Step 3 — Release per RELEASING.md, then connect.**
1. Add, as the first property of the `accounting-api` block in `.railway/railway.ts`, together with the `domains` line from step 1, and commit:
   `source: github("matteocodogno/operai", { branch: "main", checkSuites: false, rootDirectory: "/accounting-api" }),`
   (it joins the release commit; until the apply below connects it, Railway builds nothing for the service, and `railway-drift` reports a difference: expected).
2. Release (RELEASING.md): `mise run release:version`, the version commit, `mise run release:tag`, **`git push --follow-tags`**. This is the one push:
   every changed Railway service and Vercel project redeploys, in no fixed order. refund-api's `preDeploy` applies its additive migration; `auth`'s
   `preDeploy` (`db:release`) migrates and seeds the `accounting` catalog and grants.
3. Connect accounting-api: `./infra/provision-tool.sh accounting --port 8089 --connect --redeploy-shell --apply`. This starts its **first build**, whose `preDeploy`
   runs `bun run db:deploy` against `accounting`; `--redeploy-shell` rebuilds the shell with the two variables of step 2.

**Step 4 — After the new `auth` is live, grant the scope.** Check first: `curl -s https://auth.operai.welld.io/health` reports the new version, and
`auth`'s deploy log of step 3 shows its seed line ending `… + accounting catalog + accounting grants + bootstrap admin`. Only then edit `auth`'s
`SERVICE_CLIENTS` so that refund-api's entry — and only that entry — becomes `"scope":"notifications.push emails.send accounting.reference.read"`
(shape: § `accounting-api` service, "Wiring in `auth`"; every secret stays a `${{shared.…}}` reference, never a literal). `auth` restarts on the change; read its health afterwards.
If it does not come back, the scope is the first suspect: remove it again.

In the same change set (a follow-up commit, not part of the push), make the contract say the same, or `env:doctor` fails in the other direction (a scope
held on one side only): add `accounting.reference.read` to refund-api's `requiredScopes` in `tools/env-doctor/manifest.ts` and to the `refund-api` entry of the
`SERVICE_CLIENTS` line in `tools/env-doctor/templates/production/auth.env`, and rewrite the test of `tools/env-doctor/check.test.ts` that pins the pending state.

**Step 5 — Verify.**
- `./infra/check.sh`: accounting-api `/health` 200; a 401 on `GET /v1/me` without a token; a 401 on `GET /system/v1/entities/welld_ch/reference-data`
  without a credential; the shell's CSP `connect-src` names the accounting-api origin. No credential is used or printed.
- `auth`'s seed log shows the accounting grants (step 4's check).
- An accounting user sees **Accounting** in the menu, and a user without the capability does not.

**Step 6 — Seed Accounting** (optional: accounting may type the list in the app instead). `bun run seed:welld-ch [--dry-run]` adds each account and VAT code of
`seed.welld-ch.json` (the signed-off **19 accounts and 6 VAT codes**) that does not exist yet, as `system:accounting-seed`, in one transaction; it never deactivates, reactivates or renames anything, never touches
WellD Italia, and prints counts and the numbers and codes added, no personal data. The accounting-api image **contains `scripts/` and their data**, so it runs
inside the service with its own `DATABASE_URL`, over private networking (the activities-api and auth precedent):

```bash
railway ssh --service accounting-api
# inside (the image's shell, user bun, /app):
bun run seed:welld-ch --dry-run     # rolled back; accounting reads "added" and "left as it is, differs from the seed"
bun run seed:welld-ch               # the real run; a second run adds nothing
exit
```

(Alternative, from a checkout: `railway run --service accounting-api --environment production -- sh -c 'DATABASE_URL="$ACCOUNTING_PUBLIC_DATABASE_URL" bun run seed:welld-ch --dry-run'`
with the `accounting` database's **public** connection string in that variable, assembled the way step 7 assembles Refund's. Never type a URL on a command line.)

**Step 7 — Release Refund** (`accounting:release`; D20). It **reads Accounting first** and exits **2**, writing nothing, if it cannot (AC-7.4), so this step needs steps 3–6
done (and step 4: refund-api cannot read without the scope). It runs from a checkout of the release commit under `railway run`, which injects refund-api's own variables,
the service client included; it reaches three things that the private hosts of those variables cannot give a laptop, so three are overridden: the `refund` database
(public connection string), accounting-api and `auth` (their public hosts). The credentials are injected by `railway run`, never typed. Operator shell only, never CI or any
job whose output is shipped to a log service (SR-4). Offsets and personal data: § Release runbook — refund accounting export, step 5.

**The release has three inputs**: the seed (step 6: 19 accounts, 6 VAT codes), the defaults (`accounting-defaults.welld-ch.json`: the 14 expense types' accounts, read by
default, `--defaults <json>` replaces it) and the **baseline list** (`--offsets <file.csv>`, required, kept outside the repository). Put the list in a path outside any
git worktree (for example `~/accounting-offsets-2026.csv`) and delete it after the run.

```bash
cd refund-api && bun install && bun run db:generate
# the refund database through the shared Postgres's PUBLIC url (kept in this shell only; never echoed, never on a command line). (unverified)
export REFUND_PUBLIC_DATABASE_URL="$(railway run --service Postgres --environment production -- sh -c 'printf %s "${DATABASE_PUBLIC_URL%/*}/refund"')"
echo "${REFUND_PUBLIC_DATABASE_URL##*/}"      # the database NAME only: "refund"

railway run --service refund-api --environment production -- sh -c \
  'DATABASE_URL="$REFUND_PUBLIC_DATABASE_URL" ACCOUNTING_INTERNAL_URL=https://accounting-api.operai.welld.io AUTH_BASE_URL=https://auth.operai.welld.io bun run accounting:release --dry-run --offsets ~/accounting-offsets-2026.csv'
echo "exit $?"   # 0: read it. 2: Accounting cannot be read, nothing written (see below). 3: the baseline list is missing, nothing written. 1: failed, rolled back.
```

Accounting reads the dry-run report: numbers per employee and year, the defaults **skipped** because the entry is not active in Accounting, "rate pending: N lines", and "left unclassified".
A paid legacy line left unclassified stays locked (R2), so the owner decides whether to set the defaults or the catalog first. **Run the real one only after a clean, read dry run**, with the same
arguments (the same `--offsets <file.csv>`; the baseline can only be loaded on this first run):

```bash
railway run --service refund-api --environment production -- sh -c \
  'DATABASE_URL="$REFUND_PUBLIC_DATABASE_URL" ACCOUNTING_INTERNAL_URL=https://accounting-api.operai.welld.io AUTH_BASE_URL=https://auth.operai.welld.io bun run accounting:release --offsets ~/accounting-offsets-2026.csv'
echo "exit $?"; unset REFUND_PUBLIC_DATABASE_URL
```

Exit **2** prints `Accounting cannot be read: nothing was numbered or classified; run again later` and wrote nothing: check accounting-api's health, that `ACCOUNTING_INTERNAL_URL` is the public host
here, and that step 4 is done, then run it again. Exit **3** prints `the list of last hand-issued 2026 numbers is missing: nothing was numbered (AC-7.4)` and wrote nothing: pass `--offsets <file.csv>` (a
header-only file if no employee has a hand-issued number) and run it again; no number was consumed meanwhile. A second run finds nothing to do and writes no second marker. File the report.

**Step 8 — Check.** The first production approval of a WellD CH request succeeds (it no longer answers 409 `accounting_release_pending`), the line carries the copied account and VAT code,
and a compiled batch's export card says how many rows it will export. From here approvals are open again.

**Rollback.**
- *Before step 3's push:* nothing is built. Applying `.railway/railway.ts` from a checkout that no longer declares `accounting-api` would delete the service, so read that plan: it is a decision, not a reflex.
- *Step 4 failed* (`auth` does not start): remove the scope from refund-api's entry; `auth` restarts on the previous value.
- *Between steps 3 and 7:* approvals are refused by design. **Migrations are one way: there is no down migration, and none of them is reset or edited to go back.** refund-api's `preDeploy` applies, in one go,
  `20261119090000_accounting_export` (the tables, columns and type of the unreleased 20261118), `20261119120000_accounting_copies` (adds the copy columns, the two history tables of copies and the new guard; additive)
  and `20261119130000_accounting_reference_moved_out`, **which drops** the old ledger account, VAT code, rate and attempt tables, `accounting_catalog_status`, `expense_type_default`, the two FK columns of `refund_line` and the type
  `ExchangeRateOrigin`. accounting-api has one migration, `20261119120000_init` (additive, on its own database `accounting`).
- *What rollback means after `..._accounting_reference_moved_out` has run:* the schema does not go back. A refund-api build that reads the dropped tables (any build of 20261118 or of this feature before the move) fails against it,
  so "redeploy the previous refund-api" is safe only for the build that is in production today, which predates 20261118 and never read them; nothing more recent is a rollback target (that older build running on the migrated schema is inferred from the migrations being additive plus drops of tables it never used, not exercised). The drop is justified only by the premise that
  production held none of that data (20261118 was never released; plan § Data migration strategy, D5), and the migration's own pre-flight checks `refund_line` and `expense_type_default` only, **not** the rate, catalog and attempt tables.
  Data in a dropped table comes back only from a database restore (provider backup), never from a migration: so before step 3, confirm by a read-only count that those tables hold no row (or are absent) in production, and
  take a backup of the `refund` database if any does. If the premise is false, stop before step 3 and ask for a plan; do not push.
- *accounting-api:* it can be taken out by removing the service (the block in `.railway/railway.ts`, applied from a checkout that has it, never from `main`; see above). That leaves its `accounting` database and what accounting typed or
  seeded there in place, and deleting that database is the owner's separate, destructive decision. Redeploying an older accounting-api image needs no schema step (its one migration is additive and has nothing to undo), but with no
  accounting-api refund-api answers 503 `accounting_unavailable`.
- *After step 7:* the release wrote numbers, copies and the marker in one transaction. It is not undone by a redeploy; reverting it is the owner's decision with the plan (§ Risks R1, R2), and the marker is never deleted by hand.

## Push notifications (specs/20261111-push-notifications, ADR 20261111-web-push-encrypted-payloads-not-fcm/0085)

System notifications on the user's desktop (Chrome, Edge, Firefox, Safari on macOS) through standard
Web Push with encrypted payloads. `notify-api` holds the VAPID pair, stores one row per browser and sends
after it has stored the in-app notification; the shell serves `/push-sw.js` and a "Push notifications"
section in My profile. Everything is off until you turn it on; nothing below is a value.

### Generate the VAPID keys (once per environment)

```bash
bunx web-push generate-vapid-keys --json     # prints {"publicKey": "...", "privateKey": "..."}
```

- One pair **per environment** (production, and any preview/staging that enables push). Never reuse the
  production pair elsewhere.
- Keep the output out of the shell history and the repo: copy it straight into 1Password.
- The public key is not secret (the shell fetches it from `GET /push/config`); the private key is.

### Store the private key in 1Password

`tools/env-doctor/templates/production/notify-api.env` references the item
`AIScream/OperAI - Web Push VAPID` (field `private-key`). **That item is a placeholder and does not exist
yet.** Before enabling, either create the item in the `AIScream` vault with a `private-key` field (and keep
the public key and the subject beside it for the operator), or change the reference in the template to the
item you did create. env-doctor resolves references by name, so a wrong name is a failed check, not a
silent default.

### Variables on `notify-api` (Railway)

| Variable | Rule |
|---|---|
| `PUSH_ENABLED` | Literal `true` enables, anything else is off (same parsing as `EMAIL_ENABLED`). Default off: with it off no VAPID variable is read and nothing is sent. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Required when enabled. The service exits at startup if the private key does not derive the public key. |
| `VAPID_SUBJECT` | Required when enabled; `mailto:` or `https:`. The push services see it with every send. |
| `PUSH_EXCLUDED_ORIGINS` | Optional CSV of origin apps never pushed (for example `meetings`); values are validated, an unknown one stops the start. Default empty. |
| `APP_BASE_URL`, `AUTH_BASE_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` | The email-notice group: **required when `PUSH_ENABLED=true`**, because a push first asks `auth` whether the recipient is still an active user (AC-5.2). Enabling push without them exits at startup. |

### Rollout order (specs/20261111-push-notifications US-7, ADR 20261112-system-endpoints-limited-per-verified-service/0087)

Push makes `notify-api` ask `auth` about each recipient, so it depends on `auth`'s per-service
limits. Three steps, in this order:

1. **`auth` first.** It only widens what is admitted (20 per address becomes 300 service tokens and
   600 contact lookups per calling service per window); request and answer shapes are unchanged.
   `auth` logs `[system] limits per <ms> ms: ...` at startup: confirm the four effective values.
   Once it is live, list `auth`'s variables for the retired `SERVICE_TOKEN_RATE_*` names (the
   Step-0 command in § Notify credential rollout, Step 0) and delete any found from Railway, and
   from the local direnv / 1Password source. `mise run env:doctor -- --env production --live` then
   reports no forbidden variable.
2. **`notify-api` second** (30 s liveness memo, single-flight, bounded send pool, atomic device
   cap). It works against the old and the new `auth`; against the old one it is still bound by the
   shared 20, which is why step 3 waits.
3. **`PUSH_ENABLED=true` only after the AC-7.7 live re-measure** (specs/20261111-push-notifications T12) passes on the
   deployed pair. This, not merge order, is the gate: Railway redeploys every service of one push
   in no fixed order, and neither order is harmful while push is off.

### Enabling in production

1. **ADR 20261111-web-push-encrypted-payloads-not-fcm go-live sign-off first.** `docs/adr/20261111-web-push-encrypted-payloads-not-fcm.md` has a
   "Go-live sign-off" line that reads *pending*. The owner records the date and the acceptance (push
   services outside the EU observe the endpoint, send time, size and VAPID contact, never the content)
   before `PUSH_ENABLED=true` is set in production. Do not enable it while that line is pending.
2. Generate the pair, store the private key, set the variables above on `notify-api`, then
   `mise run env:doctor -- --env production --dir ./resolved` (names and shape only, no values printed).
3. Deploy. `notify-api` stays a single replica (unchanged). Verify with a signed-in browser: My profile
   shows the push section, `GET /push/config` answers with the public key, and turning it on lists the
   device. With push off, `GET /push/config` answers `{ "enabled": false }` and the shell hides the section.
4. The shell serves `/push-sw.js` at the site root (the service worker must sit at the scope it controls);
   nothing extra to configure on Vercel.

### Capacity and the live re-measure

- **What push costs `auth`:** at most one contact lookup per push recipient per 30 s (the liveness
  memo; only a `found` answer is remembered, `inactive` and `failed` are asked again) plus one per
  `email: true` notice (never memoised, ADR 20261101-notify-api-resolves-email-notice-address-from-auth). Against `USERS_CONTACT_SERVICE_LIMIT` (600 per
  10 min) that leaves room for well over 100 notifications in 10 minutes. A user raising notifications
  at themselves in a loop is bounded at 20 lookups per 10 min.
- **Re-measure (T12, AC-7.7):** raise more than 100 notifications in 10 minutes on the dev stack, then
  on the deployed pair, and read the logs:

  ```bash
  railway logs --service auth --since 15m | grep -E 'allowance exhausted|invalid-credential limit reached' || echo "none"
  railway logs --service notify-api --since 15m | grep 'HTTP 429' || echo "none"
  ```

  Pass = `none` for both. `allowance exhausted caller=system:notify-api` means the 600 was reached
  (raise `USERS_CONTACT_SERVICE_LIMIT` or find the loop); `invalid-credential limit reached` means a
  wrong credential from one address.
- **Send pool and memo constants** (not environment variables; changing one is a code change), exported
  from `notify-api/src/channels/push.channel.ts`: `SEND_POOL_OPTIONS` = 16 concurrent sends, 1 000
  queued in total, 100 queued per recipient; `ACTIVITY_MEMO_TTL_MS` = 30 000. A full queue drops the
  push (the in-app row and SSE event stand) and logs `backlog full`.
- **A `409 device_limit` on `PUT /push/devices`** means the atomic per-user cap of 20 devices fired for
  a new endpoint; re-registering an existing endpoint is never refused. It is the cap working, not a
  database fault.

### Operating notes

- **Rotating the VAPID keys invalidates every subscription.** Each subscription was made against the old
  public key, so sends signed with the new key are not accepted for them; only 404/410 answers delete a row
  automatically, so those rows are not cleaned up on their own. After a rotation every user must turn push off and on again
  in My profile, and stale rows stay until removed there or until the user is deactivated. Rotate only
  deliberately, and announce it.
- A device the push service reports gone (404/410) is deleted on the spot; any other failure keeps the row
  and never fails the notification itself (the in-app row and the SSE event always stand).
- The browser decides whether to show: on Chrome, Edge and Firefox the service worker shows nothing while an
  Operai tab is visible (the toast covers it). **Safari always shows**, because Safari cancels a
  subscription after pushes that show nothing (ADR 20261111-push-suppression-decided-by-the-browser), so a Safari user with Operai open gets both the
  toast and the system notification.
- **Apple answers 201 for subscriptions that are dead.** On `web.push.apple.com` a successful send proves
  nothing about delivery, and a cancelled Safari subscription is never reported back as 404/410; its row
  lingers until the user removes it in My profile. Do not read "no errors from Apple" as "delivered".
- Turning push off for one origin without redeploying code: set `PUSH_EXCLUDED_ORIGINS` and restart
  `notify-api`. Turning it off entirely: `PUSH_ENABLED=false`; existing rows stay and are used again when
  it is re-enabled.
- Logs carry the device id and the push status only, never an endpoint, key, title or body.

## Rollback & operations

- **Rollback:** each Railway service and each Vercel project keeps its own
  deployment history — redeploy the last good one from the dashboard. Frontends
  are independent, so rolling back one remote doesn't touch the others. If a
  Railway rollback crosses a migration boundary (older code, newer schema),
  restore Postgres from a backup or down-migrate **before** redeploying the older
  image — Railway doesn't reverse migrations.
- **Update one var later:** `railway variables --service <svc> --set "K=$K"` then
  `railway redeploy --service <svc>` (run inside the direnv shell if `K` is a
  secret). Frontend var changes need a Vercel **redeploy** (build-time).
- **EU residency (operational):** request/response bodies are never logged
  (hono/logger emits method+path+status only; Prisma `query` logging off in prod)
  across `auth`, `estimai-api`, `notify-api`, **and `refund-api`** (the last
  two handle notification title/body and financial/receipt-PII data
  respectively — the same no-body-logging rule applies to both). Don't add a
  CDN/log-aggregator/backup target that routes EU data outside the EU — this
  now also covers `refund-api`'s EU object-storage bucket once provisioned
  (ADR 20260716-eu-object-storage-refund-attachments).
- **`notify-api` single-replica constraint (specs/20260713-notification-center Risk R2):** never scale
  `notify-api` past one replica (Railway dashboard autoscale or a
  `.railway/railway.ts` edit) without first moving its EventBus fan-out and
  stream-ticket store onto Postgres `LISTEN`/`NOTIFY` + a shared ticket table
  — both are designed behind an interface for that migration, but the current
  in-process implementation silently breaks (missed events, ticket
  mint↔connect mismatches) across two or more instances.
- **Service-client secret rotation / revocation (specs/20261013-notify-service-credentials, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired):** if one caller's
  secret is suspected, set a new value on its `<NAME>_SERVICE_CLIENT_SECRET` Shared
  Variable and redeploy `auth` (its `SERVICE_CLIENTS` references it) and that caller. To cut
  a caller off at once, remove its entry from `SERVICE_CLIENTS` and redeploy `auth`;
  credentials already minted expire within 5 minutes. The other callers are unaffected —
  there is no shared secret to rotate in lockstep. Never log the value; `railway variables`
  output containing it should not be pasted into chat/tickets.
- **`/system/emails` and `/system/notifications` network exposure (specs/20260713-user-invitations
  Risk R2, specs/20260716-refund-service ADR 20260716-system-notifications-cross-user-trigger, specs/20261013-notify-service-credentials):** the scoped service credential is the enforced
  access control regardless of network path, but reduce exposure further by keeping
  `auth`'s and `refund-api`'s `NOTIFY_INTERNAL_URL` on notify-api's Railway
  **private**-networking hostname (never the public `<NOTIFY_API_URL>`
  domain) — these calls should never traverse the public internet.
  `notify-api` still needs its public domain for the browser-facing
  SSE/notification routes; there is currently no per-route network-level
  isolation (Railway private networking is per-service, not per-route) —
  flagged here, not solved, since splitting these internal routes onto a
  network-isolated deployment would be a new infra topology decision (ADR
  territory), not something to adopt unilaterally.
- **`refund-api` object storage not yet provisioned (T19 follow-up, human
  action required):** no EU-region bucket exists and no 1Password item exists
  for `REFUND_S3_*` — see § Variable reference's `refund-api` section, "Object
  storage — provisioning". `refund-api/src/lib/storage.ts` (T9) will consume
  these vars; local dev's placeholder values in `.env.example` are non-
  functional until a real bucket is created. This is the primary blocker for
  a genuine end-to-end T9 deploy verification (mint→confirm→signed-GET against
  a real bucket) — `bun test` itself does not require one (storage is mocked).
- **Secrets** are only ever referenced from the direnv/1Password shell, never
  pasted literally or committed; `.pem` files are gitignored; the pre-commit
  betterleaks hook guards commits.

---

## Users who entered without an invitation (specs/20261105-signup-gate, ADR 20261105-access-only-by-invitation-waiting-list, AC-6.2)

Since specs/20261105-signup-gate `auth` creates a user only for an email in `ALLOWED_SIGNUP_DOMAINS` that
holds a live pending invitation (or is the bootstrap admin, whose email must also be in an allowed domain); an allowed-domain email without one
joins the waiting list and an outside-domain email is refused. Users who signed in before that are left untouched
(AC-1.6); these two read-only queries list them so an admin can review by hand. Run them
against the `auth` database; neither writes anything.

**Rollout step (before the push):** on Railway, service `auth`, set
`ALLOWED_SIGNUP_DOMAINS=welld.ch,welld.it`. Without it `auth` refuses to start. After the
push `auth` migrates `access_request` on start; then run the queries below in production.

(a) Active users with no accepted invitation:

```sql
SELECT u.id, u.name, u.email, u."createdAt"
FROM "user" u
WHERE u."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM invitation i WHERE i."acceptedByUserId" = u.id)
ORDER BY u."createdAt";
```

(b) Active users whose email domain is outside `welld.ch` / `welld.it`:

```sql
SELECT u.id, u.name, u.email, u."createdAt"
FROM "user" u
WHERE u."deletedAt" IS NULL
  AND lower(split_part(u.email, '@', 2)) NOT IN ('welld.ch', 'welld.it')
ORDER BY u."createdAt";
```

Locally: `psql "$DATABASE_URL" -f query.sql`, or `bunx prisma db execute --stdin` from `auth/`.

---

## Audit-log redaction — GDPR/nLPD subject-erasure requests (specs/20260803-employee-address, ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level, Risk R5)

As of specs/20260803-employee-address, `auth`'s `audit_log` carries employee home addresses
(`user.address.set` entries) in its `data.before`/`data.after` payload. Per
**ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level** — a deliberate, user-decided (2026-08-04) two-tier
audit-assurance model for the suite — `audit_log` is **Tier 2
(application-level immutability only)**: no mutating export from the audit
module, no mutating route on the audit API, no production code path that
updates or deletes a row. This is unlike the suite's Tier 1 tables
(`RefundAuditEntry`/`MileageRate`/`RefundSetting`, ADR 20260716-immutable-financial-audit-trail-refund/0024/0027), which
carry a database-level `BEFORE UPDATE/DELETE` trigger and are permanently
unremovable by design.

That absence of a database-level guard is what makes a genuine GDPR/nLPD
**subject-erasure request technically honourable at all** for this table —
redacting the `data.before`/`data.after` payload of specific rows is
possible precisely because nothing at the database layer forbids it (a Tier 1
table would not permit this). The residual risk is **procedural, not
technical**: an ad-hoc `UPDATE`/`DELETE` leaves no record of who redacted
what, when, or why — the trail cannot record its own redaction. This runbook
exists so a real request is handled consistently, not improvised under time
pressure.

1. **Who may perform a redaction.** A person with direct production database
   access **and** explicit authorization for this specific request — e.g.
   wellD's DPO/privacy lead, or an engineer they've directed. This is
   deliberately **not** a self-service admin-panel action, because none
   exists (by design — ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level §1(c): every mutating verb on `/admin/audit`
   and `/admin/audit/{id}` returns `404`). Treat the absence of a UI for this
   as a feature, not a gap to fill.
2. **Scope the redaction to an enumerated `audit_log.id` set — never a broad
   `WHERE`.** Identify the exact rows before touching anything:
   ```sql
   SELECT id, "targetType", "targetId", action, "createdAt"
   FROM audit_log
   WHERE "targetType" = 'user' AND "targetId" = '<the subject's user id>'
     AND action = 'user.address.set';
   ```
   Record the returned `id` list — this is the set the redaction targets,
   and only this set. Never issue an `UPDATE`/`DELETE` scoped directly by
   `targetId`/`action`/a date range; always resolve to explicit `id`s first
   and redact by `id IN (...)`.
3. **Redact the payload, not the row.** Null or replace the address fields
   inside `data.before`/`data.after` (the personal data) in place — leave
   `id`, `targetType`, `targetId`, `action`, `actorUserId`, `createdAt`
   untouched, so the *fact that a change happened* stays visible and only
   the erased subject's personal-data content is removed:
   ```sql
   UPDATE audit_log
   SET data = jsonb_set(jsonb_set(data, '{before}', 'null'::jsonb, true), '{after}', 'null'::jsonb, true)
   WHERE id IN (<the enumerated id list from step 2>);
   ```
   Confirm the actual `data` shape recorded for `user.address.set` with a
   `SELECT data FROM audit_log WHERE id = <one id>` before writing the
   `UPDATE` — do not assume the JSON path above is byte-exact against the
   handler's current `withAudit` call shape.
4. **Record the act out-of-band — the trail cannot record its own
   redaction.** Before or immediately after running the `UPDATE`, open a
   ticket (or wellD's existing DPA/privacy log) recording: the requesting
   subject, the enumerated `id` list from step 2, who ran the redaction, the
   timestamp, and the legal basis (the erasure request's reference). This
   ticket **is** the audit trail for the redaction itself — `audit_log` has
   no mechanism to audit changes made to it.
5. **Do not automate this.** No cron, no scheduled job, no self-service admin
   action — consistent with this suite's standing "derived-on-read, never
   scheduled" posture for one-time operator actions (ADR 20260714-invitation-lifecycle-derived-expiry-state lineage,
   mirrored by the accounting-distribution-email cutover script above in §
   Variable reference). Every redaction is a deliberate, individually
   authorized command run by a human against production, exactly once per
   request.

See **ADR 20260804-two-tier-audit-assurance-auth-audit-log-application-level** for the full reasoning — why `audit_log` is Tier 2 rather
than Tier 1, why that is a deliberate trade-off rather than an oversight, and
the escalation path (dropping `AuditLog.actorUserId`'s FK first) if a future
regulatory or product trigger requires raising `audit_log` to Tier 1.
