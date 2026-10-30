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
├───────────────────────────────┤  │ Entry.js │  numReplicas: 1 (R7, specs/013│
│ estimai-ui  estimai.operai…    │◄─┤ at run-  │  — see below), app-access-    │
│ refund-ui   refund.operai…     │◄─┤ time, in │  check limiter is in-process  │
│ admin-ui    admin.operai…      │◄─┤ browser  ├───────────────────────────────┤
│ notify-ui   notify.operai…     │◄─┘          │ estimai-api (Bun+Hono)        │
└───────────────────────────────┘              │  https://estimai-api.operai… │
   shell owns session; remotes                 │  numReplicas: 1 (R7, specs/013│
   delegate to shell/session                   │  — see below), share-add     │
                                                │  limiter + identity cache are │
                                                │  in-process, single-instance  │
                                                ├───────────────────────────────┤
                                                │ notify-api  (Bun+Hono)        │
                                                │  https://notify-api.operai…  │
                                                │  numReplicas: 1 (R2 — see    │
                                                │  below), SSE + ticket store  │
                                                │  are single-instance only    │
                                                ├───────────────────────────────┤
                                                │ refund-api  (Bun+Hono)        │
                                                │  https://refund-api.operai…  │
                                                │  → EU object storage (S3-    │
                                                │    compatible, ADR-0016) —   │
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
                                                │   resolve (ADR-0014)          │
                                                │ estimai-api → auth /authz/    │
                                                │   app-access-check +          │
                                                │   /authz/users/identities     │
                                                │   (specs/013, ADR-0035/0039)  │
                                                │ refund-api → notify-api       │
                                                │   /system/notifications       │
                                                │   (ADR-0017)                  │
                                                │ estimai-api → notify-api      │
                                                │   /system/notifications       │
                                                │   (specs/013, ADR-0040)       │
                                                └───────────────────────────────┘
```

- **Frontends:** the `shell` is the human entry point (`operai.welld.io`); the
  four tools (`estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui`) are
  runtime-federated remotes, each on its own subdomain, loaded cross-origin by
  the shell (ADR-0006). `notify-ui` (specs/005) is the notification-center
  page; the shell's own bell/toast/SSE seam is shipped inside the shell bundle
  itself, not this remote (ADR-0009) — see the shell-side notes in
  `specs/005-notification-center/plan.md`.
- **Backends:** `auth` (OAuth, sessions, RS256 JWT + JWKS, hosted sign-in,
  authorization/admin API), `estimai-api` (estimate persistence), `notify-api`
  (notification persistence + SSE push, specs/005), and `refund-api`
  (reimbursement persistence + authorization-enforcing resource server,
  specs/007). One Postgres instance, four logical databases (`auth`,
  `estimai`, `notify`, `refund`); service↔DB traffic stays on Railway private
  networking (`*.railway.internal`).
  **`notify-api` is pinned to a single replica** (`railway.json`
  `numReplicas: 1`) — its in-process EventBus fan-out and stream-ticket store
  are correct for exactly one running instance (plan.md Risk R2). Do not
  enable autoscale/multiple replicas for this service without first moving
  both seams onto Postgres `LISTEN`/`NOTIFY` + a shared ticket table.
  `refund-api` has no equivalent constraint — its `authzMiddleware` cache
  (ADR-0014) is a per-replica performance optimization with a 30s TTL
  backstop, not a correctness-dependent single-instance store.
  **`auth` and `estimai-api` are now ALSO pinned to a single replica each**
  (specs/013-estimate-sharing, T13, plan.md Risk R7) — `auth`'s
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
  without doing that first. See § Variable reference's per-service
  `railway.json` notes below for the actual pins.
- **`notify-api` and `estimai-api` are cross-valid JWKS resource servers**
  (ADR-0010) — both verify the same `auth`-issued tokens, so both (plus
  `auth`, which stamps the claim) require an identical **`AUTH_AUDIENCE`**
  value or a token minted for one is structurally valid at the other.
  `refund-api` (specs/007) is a THIRD JWKS resource server on the same
  `AUTH_AUDIENCE` value — see § Variable reference.
- **`auth` → `notify-api` service-to-service email trigger** (specs/006-user-invitations,
  ADR-0011): `auth` calls `notify-api`'s internal `POST /system/emails` to send
  invite/resend emails (Resend, bilingual) — the suite's first non-user-JWT
  cross-service call. Since specs/016 (ADR-0048/0049) `auth` authenticates it with its
  own scoped 5-minute service JWT (`sub=system:auth`, scope `emails.send`), minted in
  process — there is no shared secret any more. This call is routed over Railway **private
  networking** (`NOTIFY_INTERNAL_URL` → `notify-api.railway.internal`), not
  the public `<NOTIFY_API_URL>` domain the browser uses for SSE — see
  § Variable reference and § Phase 1 step 7.
- **`refund-api` → `auth` `/authz/resolve` + `refund-api` → `notify-api`
  `/system/notifications`** (specs/007-refund-service, ADR-0014/ADR-0017):
  `refund-api` is the suite's first AUTHORIZATION-enforcing resource server —
  every request resolves the caller's live permissions from `auth GET
  /authz/resolve` (forwarding the caller's own Bearer JWT, no new secret,
  reuses `AUTH_ISSUER`/`AUTH_JWKS_URL`/`AUTH_AUDIENCE` below — no separate env
  var). After an approve/reject decision it calls `notify-api`'s internal
  `POST /system/notifications` (mirrors `/system/emails`'s shape), and, for the
  monthly batch email, `POST /system/emails`, each authenticated with its own scoped
  service JWT (scopes `notifications.push` + `emails.send`) from `auth POST
  /system/service-token` (ADR-0049). Both calls should
  prefer Railway **private networking** where the target service's private
  hostname is known, same posture as `auth`'s existing `NOTIFY_INTERNAL_URL`.
- **`refund-api` → EU object storage** (specs/007-refund-service, ADR-0016): a
  SEPARATE S3-compatible bucket resource (not a Railway service) — receipt
  attachments never transit `refund-api`'s own process (presigned
  direct-to-bucket upload/download). See § Variable reference's `refund-api`
  section and this task's follow-up note on provisioning (not yet done).
- **`estimai-api` → `auth` `/authz/app-access-check` + `/authz/users/identities`,
  `estimai-api` → `notify-api` `/system/notifications`** (specs/013-estimate-sharing,
  T13, ADR-0035/ADR-0036/ADR-0039/ADR-0040): estimate sharing (US-1..US-7)
  adds `estimai-api`'s first outbound calls to two sibling services, using
  its own `AUTH_BASE_URL` env var (a NEW var — distinct from the
  pre-existing `AUTH_ISSUER`/`AUTH_JWKS_URL` claim-verification values).
  Both `auth` calls forward the CALLER's own Bearer JWT (no new credential;
  `POST /authz/app-access-check` fails CLOSED on error per ADR-0035,
  `POST /authz/users/identities` fails SOFT to `status:"unknown"` per
  ADR-0039 — deliberately different failure postures on the same service,
  see each ADR). `estimai-api` deliberately does **not** become an
  authorization-enforcing resource server like `refund-api` (ADR-0036) —
  per-record ACLs live in `estimai-api`'s own `estimate_collaborator` table,
  not in `auth`'s catalog. The `notify-api` call reuses `refund-api`'s exact
  `/system/notifications` contract, authenticated with `estimai-api`'s own
  scoped service JWT (scope `notifications.push` only; ADR-0049 — see
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
    (specs/006-user-invitations, ADR-0011) AND `refund-api`'s server-side
    `POST /system/notifications` call (specs/007, ADR-0017) both use this;
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

- **`inventory-api` and `inventory-ui`** (specs/015-hardware-inventory, T43;
  ADR-0044..0047) are the fifth backend and sixth frontend project. The diagram
  above predates them; they add a sixth Vercel project (`inventory-ui` →
  `inventory.operai.welld.io`, a remote exposing `./App`, `./MyDevices` and
  `./version`), a fifth Railway service (`inventory-api` → `inventory-api.operai.welld.io`,
  logical DB `inventory`, port `8083`, region `europe-west4`) and a SEPARATE EU
  invoice bucket. `inventory-api` is an authorization-enforcing resource server
  (calls `auth GET /authz/resolve` and `POST /authz/users/identities` on the
  caller's forwarded JWT) and the one of four notify callers: it pushes to
  `notify-api POST /system/notifications` with a 5-minute scoped service JWT
  minted by `auth POST /system/service-token` (ADR-0044/0049). Browsers also call
  `auth GET /authz/users/directory` directly from `inventory-ui` (ADR-0047).
  Full variable list and the manual rollout steps: § `inventory-api` service.
- **Service tokens are signed by better-auth's rotating key, NOT by
  `JWT_PRIVATE_KEY`** (ADR-0044, plan risk R-4, resolved in the T4 contract
  test): the token carries the same `kid` that `auth` publishes at
  `/auth/jwks`, and `notify-api` verifies it against its existing `AUTH_JWKS_URL`
  (`aud = SERVICE_AUDIENCE`, `scope` containing `notifications.push`). The
  static pair served at `/.well-known/jwks.json` signs nothing here — do not
  point anything at it for this flow, and do not rotate `JWT_PRIVATE_KEY`
  expecting it to affect service tokens.

**Hostnames.** The `*.operai.welld.io` scheme is the proposed, welld.io-parented
layout (shared registrable parent matters for the credentialed `/auth/token`
cookie call — ADR-0001 R7). If the real domains differ, update them here **and**
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

## Phase 1 — Railway backends

The automatable parts are in **`./infra/deploy.sh`**; the manual dashboard bits
are called out. What the script does, step by step:

1. **Link** the project: `railway link "$RAILWAY_PROJECT_ID"` (env `production`).
2. **Postgres** (manual first time): dashboard → New → Database → PostgreSQL;
   confirm its **region is `europe-west4`** before adding data. Then create the
   four logical DBs (the script attempts this; or `railway connect Postgres` →
   `CREATE DATABASE auth;` `CREATE DATABASE estimai;` `CREATE DATABASE notify;`
   `CREATE DATABASE refund;`). They must exist before the first deploy — each
   service's `preDeployCommand` runs `prisma migrate deploy` against its own
   DB (`refund-api`'s first migration, `0001_init`, lands with specs/007's T5
   — until then `preDeployCommand` is a safe no-op against an empty
   migrations directory).
3. **Deploy `auth`** (root dir `auth`, reads `auth/railway.json`): set its vars
   (DATABASE_URL via `${{Postgres.*}}` references, `BETTER_AUTH_SECRET`,
   `GOOGLE_*`/`GITHUB_*`, `JWT_*`, `ALLOWED_ORIGINS=<shell origin>`, `UI_HOME_URL`,
   `AUTH_AUDIENCE` (ADR-0010 — one suite-wide value; see below),
   `NOTIFY_INTERNAL_URL` (specs/006-user-invitations, ADR-0011 — see below),
   `SERVICE_AUDIENCE` + `SERVICE_CLIENTS` (ADR-0044/0049 — see § "Service clients"
   below), `BOOTSTRAP_ADMIN_EMAIL`, `NODE_ENV=production`, and —
   **optional, code defaults apply if unset (specs/013-estimate-sharing,
   T1/T2/T27)** — `APP_ACCESS_CHECK_FLOOR_MS`/`APP_ACCESS_CHECK_RATE_LIMIT`/
   `APP_ACCESS_CHECK_RATE_WINDOW_MS` and `IDENTITIES_RATE_LIMIT`/
   `IDENTITIES_RATE_WINDOW_MS`), then deploy. Pin **`numReplicas: 1`**
   (`auth/railway.json` — plan.md Risk R7, see § Topology above; the
   in-process `APP_ACCESS_CHECK`/`IDENTITIES` rate limiters are per-instance
   state). **Generate its domain** (dashboard → Settings → Networking, or a
   custom `auth.operai.welld.io`) → this is **`<AUTH_URL>`**.
4. **Deploy `estimai-api`** (root dir `estimai-api`): set `DATABASE_URL` (dbname
   `estimai`), `ALLOWED_ORIGINS`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `AUTH_AUDIENCE` (byte-for-byte identical
   to `auth`'s), `NODE_ENV`, and — **NEW (specs/013-estimate-sharing, T13)** —
   `AUTH_BASE_URL` (internal, bucket ① — same private-DNS shape as
   `refund-api`'s own `AUTH_BASE_URL`, see step 8 below), `NOTIFY_INTERNAL_URL`
   (internal, set at step 8 alongside `auth`'s and `refund-api`'s),
   `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` (specs/016 — see § "Service
   clients" below), and `SHARE_LOOKUP_FLOOR_MS`/
   `SHARE_ADD_RATE_LIMIT`/`SHARE_ADD_RATE_WINDOW_MS` (optional — code
   defaults `300`/`20`/`600000` apply if unset). Pin **`numReplicas: 1`**
   (`estimai-api/railway.json` — plan.md Risk R7, see § Topology above; the
   in-process share-add rate limiter and identity cache are per-instance
   state). **Generate its domain** → **`<API_URL>`**.
5. **Deploy `notify-api`** (root dir `notify-api`, reads `notify-api/railway.json`
   — note it pins **`numReplicas: 1`**, do not change this without first reading
   plan.md Risk R2): set `DATABASE_URL` (dbname `notify`, **not** `estimai`),
   `ALLOWED_ORIGINS=<shell origin>`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `AUTH_AUDIENCE` (same value as the other
   two), `MAX_STREAM_DURATION` (seconds; default `1800`),
   `SERVICE_AUDIENCE` (same value as `auth`'s — see § "Service clients" below),
   `EMAIL_ENABLED`/`RESEND_API_KEY`/`RESEND_FROM` (specs/006-user-invitations —
   see below), `NODE_ENV=production`. Confirm region **`europe-west4`** (data
   residency — notification bodies may name clients/estimates and must stay
   EU-only, never logged). **Generate its domain** → this is
   **`<NOTIFY_API_URL>`** (public — browser/SSE only; see step 7 for the
   private URL `auth` uses instead).

   > ⚠️ **Build fails with `Corepack is about to download … pnpm-…tgz` (exit 1)?**
   > That means Railway ignored the service's Dockerfile and fell back to
   > **Nixpacks**, which scans the monorepo and tries to corepack-install pnpm.
   > Root cause: the service's **Root Directory is not set to the app dir**, so
   > Railway builds from the repo root (which has no `railway.json`/`package.json`).
   > **Fix:** service → **Settings → Root Directory = `<app>`** (`notify-api`,
   > `auth`, `estimai-api`, `refund-api`, …), then redeploy — Railway then reads
   > `<app>/railway.json` (`builder: DOCKERFILE`) and does the correct Bun build.
   > This applies to BOTH GitHub-connected deploys and `deploy.sh`'s
   > `railway up --service <svc>` (which uploads the repo root as context; the
   > Root Directory setting is what scopes the build down to the app).
6. **Deploy `refund-api`** (root dir `refund-api`, reads `refund-api/railway.json`
   — T19, specs/007-refund-service): set `DATABASE_URL` (dbname `refund`,
   **not** `estimai`/`notify`), `ALLOWED_ORIGINS=<shell origin>`,
   `AUTH_ISSUER=<AUTH_URL>`, `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`,
   `AUTH_AUDIENCE` (same value as the other three), `NOTIFY_INTERNAL_URL`
   (notify-api's **private**-networking address — same value as `auth`'s, see
   step 8), `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` (specs/016 — see
   § "Service clients" below), `REFUND_S3_ENDPOINT`/`REFUND_S3_REGION`/`REFUND_S3_BUCKET`/
   `REFUND_S3_ACCESS_KEY_ID`/`REFUND_S3_SECRET_ACCESS_KEY` (EU-region object
   storage, ADR-0016 — **NOT YET PROVISIONED**, see § Variable reference),
   `REFUND_APP_BASE_URL` (monthly batch processing, T14,
   specs/008-refund-monthly-processing, ADR-0021 — see § Variable
   reference), `NODE_ENV=production`. Do **NOT** set
   `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — as of specs/011-refund-settings
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
   estimate-sharing notifications** (specs/006-user-invitations ADR-0011,
   specs/007-refund-service ADR-0017, specs/013-estimate-sharing ADR-0040):
   set `auth`'s, `refund-api`'s, **and now `estimai-api`'s**
   `NOTIFY_INTERNAL_URL` to notify-api's **Railway private** networking
   address, as the reference
   `http://operai.railway.internal:8080` —
   do NOT hand-type `notify-api.railway.internal`, which does not resolve
   (dashboard → notify-api service → Settings → Networking → Private
   Networking shows the real hostname: `operai.railway.internal`; see the ⚠
   box in § Cross-service wiring) — **not** `<NOTIFY_API_URL>`, the public domain from step 5
   (plan.md Risk R2 / ADR-0011: this service-to-service call must stay off
   the public internet). Every caller authenticates with its own credential — set up
   the service clients as described in § "Service clients" below (no shared
   secret). Also set `estimai-api`'s `AUTH_BASE_URL` to
   `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` here (same
   private-DNS shape as `refund-api`'s own `AUTH_BASE_URL` two rows up in §
   Variable reference's ① table) — it is the base for `estimai-api`'s
   `POST /authz/app-access-check` and `POST /authz/users/identities` calls
   (specs/013-estimate-sharing, ADR-0035/0039). Set `notify-api`'s
   `EMAIL_ENABLED=true` with real `RESEND_API_KEY`/`RESEND_FROM` only once
   the Resend sending domain is verified (see § Resend domain setup below) —
   until then, leave `EMAIL_ENABLED=false` so invite emails are stubbed
   (recorded, not actually sent) rather than failing loudly.

**`AUTH_AUDIENCE` (ADR-0010) — one value, FOUR services (as of specs/007).**
`notify-api` was the suite's first real second JWKS resource server, so a
token minted for `estimai-api` would otherwise be structurally valid at
`notify-api` (and vice versa); `refund-api` (specs/007) is now a third. `auth`
stamps the `audience` claim on every JWT it issues; `estimai-api`,
`notify-api`, AND `refund-api` each verify `audience` against their own
`AUTH_AUDIENCE`. **All four services must carry the byte-for-byte identical
value** (local default: `operai-suite`, see each service's `.env.example`) — a
drifted value fails every request closed (401) in that environment, not open.

**Service clients (ADR-0044, ADR-0048, ADR-0049; specs/016) — one credential per
notify-api caller, no shared secret, no user identity.** `notify-api`'s two internal routes
are `POST /system/emails` (scope `emails.send`) and `POST /system/notifications` (scope
`notifications.push`). Every caller authenticates **as itself** with
`Authorization: Bearer <service JWT>`: a 5-minute RS256 JWT with `sub=system:<client>` and
`aud=SERVICE_AUDIENCE` (never `AUTH_AUDIENCE`), signed by better-auth's rotating key and
verified by `notify-api` through its existing `AUTH_JWKS_URL`. The callers are:

| Caller | `sub` | Scope(s) | Obtains its credential by |
|---|---|---|---|
| `auth` | `system:auth` | `emails.send` | minting it in process (ADR-0048); the client id `auth` is **reserved** — a `SERVICE_CLIENTS` entry named `auth` refuses to start |
| `refund-api` | `system:refund-api` | `notifications.push` + `emails.send` | `auth POST /system/service-token` with `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` |
| `estimai-api` | `system:estimai-api` | `notifications.push` | same |
| `inventory-api` | `system:inventory-api` | `notifications.push` | same |

A person creates, per client, one Railway **Shared Variable** `<NAME>_SERVICE_CLIENT_SECRET`
(32-256 random chars, e.g. `openssl rand -hex 32`, no 1Password item), references it from
that client's `SERVICE_CLIENT_SECRET` (`${{shared.<NAME>_SERVICE_CLIENT_SECRET}}`) and from
its entry in `auth`'s `SERVICE_CLIENTS` JSON (shape in § Notify credential rollout); the
client's `SERVICE_CLIENT_ID` is its literal service name, a key of `SERVICE_CLIENTS`. Each
client holds exactly the scopes it needs (`estimai-api` and `inventory-api` must not hold
`emails.send`); `notify-api` additionally binds each `sub` to the origin app it may push for.
`SERVICE_AUDIENCE` is a Shared Variable required on **both** `auth` and `notify-api`, identical
on the two and different from `AUTH_AUDIENCE`. To **revoke** one caller, remove its entry from
`SERVICE_CLIENTS` (credentials already minted expire within 5 minutes); the others keep
working. To **rotate** one caller's secret, change its shared variable and redeploy `auth` and
that caller (a window of 401s on that caller's pushes is the cost; the push is best-effort and
never rolls back the originating action). A leaked secret lets its holder send what its scopes
allow (for `refund-api`, email over wellD's Resend domain — plan.md Risk R2) until its entry is
removed; it is never logged. The previous shared token was retired by specs/016: § Notify
credential rollout below is the history of that migration.

**Resend domain setup (plan.md Risk R5, ADR-0011 compliance notes).** Before
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
export AUTH_AUDIENCE=operai-suite    # ADR-0010 — identical across auth + estimai-api + notify-api + refund-api
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

**Migrations + seed run automatically** — each `railway.json` `preDeployCommand`
is `bun run db:deploy && bun run db:seed` (for `auth`; `estimai-api`,
`notify-api`, and `refund-api` run `db:deploy` only). `migrate deploy` is
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
   | `admin-ui` | `admin.operai.welld.io` | remote-only (roles & permissions, specs/004) |
   | `notify-ui` | `notify.operai.welld.io` | remote-only (notification center, specs/005) |
   | `inventory-ui` | `inventory.operai.welld.io` | remote-only (hardware inventory, specs/015; exposes `./App`, `./MyDevices`, `./version`) |

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
   `notify` remote (`NOTIFY_REMOTE_URL`) — that lands with specs/005's T13,
   mirroring `ADMIN_REMOTE_URL` exactly. `notify-ui` is deployable and
   reachable on its own domain today; the shell mounting it at `/notify` is a
   separate, not-yet-merged app-code change, not an infra gap.

**Google Maps API key — provisioning (`admin-ui`, T16, specs/012-employee-address,
ADR-0032) — before setting `VITE_GOOGLE_MAPS_API_KEY` in the `admin-ui` Vercel
project.** `admin-ui`'s AddressSection calls **Google Places API (New)**
browser-direct from the admin's own browser — never proxied through `auth`
(ADR-0032: routing a third party through the identity service would put
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
   > shell's document* (ADR-0006) — the `Referer` header on every Google call
   > from that page is the **top-level** URL, i.e. the shell's, **never**
   > `admin.operai.welld.io`. Listing admin-ui's own origin here fails
   > **100% of requests** — and because AC-3.2 makes the feature degrade
   > silently (no error banner, no blocked save, just an address field that
   > quietly never suggests anything), that failure is **invisible** until
   > someone happens to notice. This is risk **R2** (plan.md/ADR-0032) and
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
   shell's own document* (ADR-0006), so the **shell's** CSP governs the page,
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
   Railway. Deliberately **not** a `shell/session` getter (ADR-0032 Option E)
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
  `notify-api`, `refund-api`, and `inventory-api` as of specs/015) must be the **shell's** origin
  (`https://operai.welld.io`) — that's what CORS + better-auth
  `trustedOrigins` validate. Only the shell's origin is needed: the remotes
  never call the backends directly (they delegate to `shell/session`, which
  runs under the shell's origin). This includes `notify-api`'s SSE stream
  endpoint — its `Access-Control-Allow-Origin` is pinned to the shell origin
  too (plan.md). Redeploy the affected service after a change.
- **`refund-api.ALLOWED_ORIGINS` gains admin-ui's OWN origin**
  (specs/009-mileage-rate, T8, plan.md Risk R8) — admin-ui's new Mileage
  Rates screen calls `refund-api`'s `/rates` endpoints directly (Bearer-authed,
  cross-origin, via `shell/session`'s `apiFetch`), the plan's chosen wiring
  (admin-ui hosts the screen; `refund-api` stays the sole data/logic owner —
  see ADR-0023). When admin-ui runs COMPOSED inside the shell (the normal
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
  present in `shell/vercel.json`'s CSP string (specs/005 T19) — `check.sh`
  asserts this pin so a future edit that drops it fails loudly.
  `refund-api.operai.welld.io` was added to `connect-src` (T20,
  specs/007-refund-service) — `refund-api` never streams (no SSE), but it's an
  ordinary fetch target from `refund-ui`'s calls (via `shell/session`'s
  `apiFetch`) and `connect-src` governs `fetch`/`XHR` origins too, not just
  EventSource.
  **`connect-src` must ALSO include the receipt-bucket origin**
  (`https://t3.storageapi.dev`, ADR-0016): receipt uploads POST *directly* to
  the bucket, so that request is subject to the shell's CSP even though no
  Operai service is involved. Missing on 2026-07-31 — uploads stayed broken
  after the bucket's CORS rule was fixed, because CSP blocks the request
  before it ever leaves the page. `img-src` does NOT need the bucket today
  (downloads use `window.open`), but would if inline receipt previews are ever
  added.
  **`script-src` AND `connect-src` must include the two Google origins**
  (`https://maps.googleapis.com`, `https://places.googleapis.com`,
  specs/012-employee-address, ADR-0032 — see § Phase 2 step 4): `admin-ui`
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
  **Inventory (specs/015):** `shell/vercel.json` already carries
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
`connect-src` pin, T20, the receipt-bucket `connect-src` pin, ADR-0016 —
override its default with `REFUND_BUCKET_ORIGIN` — and the Google Maps
`script-src`/`connect-src` pins, ADR-0032/specs/012-employee-address), and
warns if `notify-api`'s health payload doesn't
look JWKS-ready. It also probes both of notify-api's internal routes, `POST
$NOTIFY_API_URL/system/emails` and `/system/notifications` (specs/006, specs/016): a
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
> set (both call sites are best-effort by design — ADR-0011/ADR-0017 — so
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
| `AUTH_BASE_URL` | inventory-api (`GET /authz/resolve`, `POST /authz/users/identities`, `POST /system/service-token`, specs/015); refund-api (the `GET /authz/resolve` call); estimai-api (the `POST /authz/app-access-check` + `POST /authz/users/identities` calls, specs/013-estimate-sharing, ADR-0035/0039) | `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` |
| `NOTIFY_INTERNAL_URL` | auth, refund-api, estimai-api (specs/013-estimate-sharing, ADR-0040), inventory-api (specs/015, ADR-0044) | `http://operai.railway.internal:8080` |

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
| `AUTH_AUDIENCE` | auth + all 4 resource servers (ADR-0010; `inventory-api` is the fourth, specs/015) |
| `SERVICE_AUDIENCE` | auth + notify-api (ADR-0044) — must be byte-identical across the two **and different from `AUTH_AUDIENCE`**; both refuse to start otherwise. `env:doctor` checks both. |
| `<NAME>_SERVICE_CLIENT_SECRET` (`INVENTORY_`, `ESTIMAI_`, `REFUND_`) | the `secret` inside `auth`'s `SERVICE_CLIENTS` entry for that caller AND that caller's own `SERVICE_CLIENT_SECRET` (secret, 32–256 chars; ADR-0044/0049). One per caller; `auth` mints its own credential in process and has none. Set as a Railway Shared Variable directly on the project — there is no 1Password item, so it is never in a template. |
| `AUTH_ISSUER` | all 4 resource servers (same public value) |
| `NOTIFY_INTERNAL_URL` | auth + refund-api + estimai-api — the three services that CALL notify-api |

Set each as a Railway **Shared Variable** once; each service then references
`${{shared.AUTH_AUDIENCE}}` etc. — one place to change, no hand-copying.

> `NOTIFY_INTERNAL_URL` was added to this list on 2026-08-10, after the private-
> domain trap below had silently broken it for the **third** time (auth and
> refund-api on 2026-07-31; estimai-api from the day specs/013 shipped until it
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
| `AUTH_AUDIENCE` | **NEW (ADR-0010).** One suite-wide value (e.g. `operai-suite`), byte-for-byte identical to `estimai-api.AUTH_AUDIENCE` and `notify-api.AUTH_AUDIENCE`. Stamped as the JWT `audience` claim on every token `auth` mints; closes the cross-service token-replay gap now that `notify-api` is a second JWKS resource server. | no |
| `NOTIFY_INTERNAL_URL` | **NEW (specs/006, ADR-0011).** notify-api's Railway **private**-networking address — always write it as `${{shared.NOTIFY_INTERNAL_URL}}` (shared — see ③; its value is the literal `http://operai.railway.internal:8080`), **never** a hand-typed `notify-api.railway.internal` (that host does not exist — see the ⚠ box in § Cross-service wiring), and **not** `<NOTIFY_API_URL>` (the public domain). Base URL for the `POST /system/emails` call (`src/lib/notify.ts`). | no |
| `BOOTSTRAP_ADMIN_EMAIL` | email of the first admin (specs/004 AC-6.1; gets `admin` on first sign-in). Set on Railway, not committed. | no |
| `APP_ACCESS_CHECK_FLOOR_MS` / `APP_ACCESS_CHECK_RATE_LIMIT` / `APP_ACCESS_CHECK_RATE_WINDOW_MS` | **NEW (specs/013-estimate-sharing, T1/T2).** In-process anti-enumeration floor + rate limit for `POST /authz/app-access-check` (ADR-0035). Optional — code defaults `150`/`40`/`600000` apply if unset; set explicitly only to tune per environment. | no |
| `IDENTITIES_RATE_LIMIT` / `IDENTITIES_RATE_WINDOW_MS` | **NEW (specs/013-estimate-sharing, T27).** In-process rate limit for `POST /authz/users/identities` (reuses the same `rateLimiter.ts` module as the pair above, a second instance keyed separately). Optional — code defaults `120`/`600000` apply if unset. No response-time floor needed (ADR-0039 — this endpoint leaks no existence signal the caller doesn't already hold). | no |
| `SERVICE_AUDIENCE` | **ADR-0044, required since specs/016 (ADR-0048).** The `aud` stamped on scoped service JWTs, including `auth`'s own in-process credential for `POST /system/emails`: `${{shared.SERVICE_AUDIENCE}}`, byte-identical to `notify-api`'s and **different from `AUTH_AUDIENCE`** (startup exits otherwise). Startup also exits if it is absent. | no |
| `SERVICE_CLIENTS` | **ADR-0044/0049.** JSON object keyed by client id, one entry per caller that asks `POST /system/service-token` (`inventory-api`, `estimai-api`, `refund-api`): `{"inventory-api":{"secret":"${{shared.INVENTORY_SERVICE_CLIENT_SECRET}}","scope":"notifications.push"},…}` — full shape in § Notify credential rollout. Secret 32–256 chars; scopes are `notifications.push` and/or `emails.send`, each client only what it needs; client id is lower-case alphanumerics and single hyphens, and `auth` is reserved (ADR-0048). Never logged; a parse failure names the rule, never a value. Revoking a client = removing its entry (tokens already minted expire within 5 minutes). Verify the shared references resolved inside the JSON in the Variables tab. | **yes** |
| `SERVICE_TOKEN_RATE_LIMIT` / `SERVICE_TOKEN_RATE_WINDOW_MS` | **NEW (T4).** In-process limiter on `POST /system/service-token`, keyed by network address. Optional — defaults `20`/`600000`. | no |
| `DIRECTORY_RATE_LIMIT` / `DIRECTORY_RATE_WINDOW_MS` | **NEW (T5, ADR-0047).** In-process limiter on `GET /authz/users/directory`, keyed by caller `sub`. Optional — defaults `60`/`600000`. | no |
| `NODE_ENV` | `production` | no |
| `PORT` | **set explicitly** (any consistent value, e.g. `8080`) so private-networking callers can reference `${{auth.PORT}}` (see § Private networking) — the service binds `env.PORT`, default 3001 if unset, but leaving it unset makes `${{auth.PORT}}` unresolvable | no |
| `ENABLE_TEST_AUTH` / `BETTER_AUTH_TRUSTED_ORIGINS` | **leave UNSET** (see Phase 1) | — |

**`auth` deploy constraint — NEW (specs/013-estimate-sharing, T13, plan.md
Risk R7):** `railway.json` now pins **`numReplicas: 1`** — the
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
| `AUTH_AUDIENCE` | **ADR-0010.** `${{shared.AUTH_AUDIENCE}}` — same value as every service; `jwtVerify` pins `audience`; a token with a missing/wrong `aud` is rejected 401. | no |
| `AUTH_BASE_URL` | **NEW (specs/013-estimate-sharing, T13).** **internal** (bucket ①): `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` — base for the Bearer-forwarded `POST /authz/app-access-check` (fails CLOSED, ADR-0035) and `POST /authz/users/identities` (fails SOFT, ADR-0039) calls. **Required** — `src/lib/env.ts` `process.exit(1)`s if absent. | no |
| `NOTIFY_INTERNAL_URL` | **NEW (specs/013-estimate-sharing, T13).** **internal** (bucket ①): `${{shared.NOTIFY_INTERNAL_URL}}` (shared — see ③; its value is the literal `http://operai.railway.internal:8080`) — **not** `<NOTIFY_API_URL>`, the public domain. **Required.** | no |
| `SERVICE_CLIENT_ID` | **specs/016 (ADR-0049).** `estimai-api` — must be a key of `auth`'s `SERVICE_CLIENTS` (scope `notifications.push` only). **Required** — `src/lib/env.ts` `process.exit(1)`s if absent. | no |
| `SERVICE_CLIENT_SECRET` | **specs/016 (ADR-0049).** `${{shared.ESTIMAI_SERVICE_CLIENT_SECRET}}` — byte-identical to that entry's `secret`; 32–256 chars. **Required.** Used to ask `auth POST /system/service-token` (via `AUTH_BASE_URL`) for the 5-minute credential presented to `notify-api`. | **yes** |
| `SHARE_LOOKUP_FLOOR_MS` / `SHARE_ADD_RATE_LIMIT` / `SHARE_ADD_RATE_WINDOW_MS` | **NEW (specs/013-estimate-sharing, T13).** Anti-enumeration floor (AC-1.2) + rate limit for `POST /estimates/{id}/collaborators`. Optional — code defaults `300`/`20`/`600000` apply if unset. | no |
| `NODE_ENV` | `production` · `MAX_ESTIMATE_BYTES`/`MAX_IMPORT_REQUEST_BYTES` optional (defaults) |

**`estimai-api` deploy constraint — NEW (specs/013-estimate-sharing, T13,
plan.md Risk R7):** `railway.json` now pins **`numReplicas: 1`** — the
`SHARE_ADD_*` rate limiter AND the 60s in-process identity cache
(`src/lib/authClient.ts`) are both per-process state, correct for exactly one
running instance (same shape as `notify-api`'s existing SSE constraint, §
Topology above). A second replica would silently multiply the effective
`SHARE_ADD_RATE_LIMIT` by the replica count and serve a stale cached identity
from whichever replica answers. Do not enable autoscale/multiple replicas
without first moving both behind a shared store.

### `notify-api` service (Railway) — NEW (specs/005-notification-center)

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/notify` — **its own logical DB, `notify`, not `estimai`** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin) — also what the SSE stream's `Access-Control-Allow-Origin` echoes | no |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001/auth/jwks` (same endpoint every resource server uses — **not** the public `<AUTH_URL>`, **not** `/.well-known/jwks.json`) | no |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`; **public** claim — bucket ②; `${{shared.AUTH_ISSUER}}`) | no |
| `AUTH_AUDIENCE` | **ADR-0010.** `${{shared.AUTH_AUDIENCE}}` — byte-for-byte identical suite-wide; a drifted value here either rejects everything (401) or (worse, if unset elsewhere) allows cross-service token replay. | no |
| `MAX_STREAM_DURATION` | Seconds an SSE connection may stay open before the server forces a reconnect (ADR-0008). Default `1800` (~30 min). | no |
| `EMAIL_ENABLED` | **NEW (specs/006).** `"true"` (exact string, case-insensitive) to make real Resend calls; any other value (including unset) stubs the send and still records an `EmailDelivery` row. Default `false` — safe for first deploys before the Resend domain is verified (see § Resend domain setup). | no |
| `RESEND_API_KEY` | **NEW (specs/006).** 1Password → `AIScream / OperAI - Resend API Key`. Required only when `EMAIL_ENABLED=true` (service refuses to start otherwise once enabled). | **yes** |
| `RESEND_FROM` | **NEW (specs/006).** Verified sending address on the SPF/DKIM-configured domain, e.g. `no-reply@operai.welld.io` (Risk R5). Required only when `EMAIL_ENABLED=true`. | no |
| `SERVICE_AUDIENCE` | **ADR-0044, required since specs/016 (ADR-0049).** `${{shared.SERVICE_AUDIENCE}}` — byte-identical to `auth`'s, **different from `AUTH_AUDIENCE`** (startup exits otherwise; it also exits if absent). The `aud` of every credential accepted on `POST /system/notifications` (scope `notifications.push`) and `POST /system/emails` (scope `emails.send`), verified through the existing `AUTH_JWKS_URL`. There is no other credential: the retired `X-Internal-Token` header is refused (401), and a leftover shared-token variable is simply not read. | no |
| `NODE_ENV` | `production` | no |

**`notify-api` deploy constraints (do not relax without reading plan.md Risk
R2):** `railway.json` pins **`numReplicas: 1`** — the in-process EventBus
fan-out and the in-process stream-ticket store are correct for exactly one
running instance; a second replica silently splits both. Region **must** be
`europe-west4` (data residency — notification title/body may name
clients/estimates) and the service must never log request/response bodies
(reuses `estimai-api`'s method+path+status-only `hono/logger` posture, enforced
in `notify-api/src/index.ts` and called out in `notify-api/Dockerfile`).

### `refund-api` service (Railway) — NEW (specs/007-refund-service, T19)

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/refund` — **its own logical DB, `refund`** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin) **+ admin-ui's own origin** (specs/009-mileage-rate, T8: `https://admin.operai.welld.io` — or its Preview URL, see § Phase 3 — for the `/rates` Mileage Rates screen's direct cross-origin call; composed-shell traffic is already covered by the shell origin alone) | no |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001/auth/jwks` (same endpoint every resource server uses — **not** the public `<AUTH_URL>`, **not** `/.well-known/jwks.json`) | no |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`; **public** claim — bucket ②, `${{shared.AUTH_ISSUER}}`). Pinned as the JWT `iss` in `jwt.middleware.ts`. NOTE: `refund-api`'s `GET /authz/resolve` call does **not** use this — it uses the separate `AUTH_BASE_URL` below (`resolveClient.ts`). | no |
| `AUTH_BASE_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001` — the base `refund-api`'s `authzMiddleware`/`resolveClient.ts` builds `GET /authz/resolve` against (ADR-0014). A *call*, so internal DNS; distinct from `AUTH_ISSUER`. (This is the var that was `localhost` in prod → 503.) | no |
| `AUTH_AUDIENCE` | **ADR-0010.** `${{shared.AUTH_AUDIENCE}}` — byte-for-byte identical suite-wide; `refund-api` is the THIRD JWKS resource server on this shared value. | no |
| `NOTIFY_INTERNAL_URL` | notify-api's **private**-networking address — always `${{shared.NOTIFY_INTERNAL_URL}}` (shared — see ③; its value is the literal `http://operai.railway.internal:8080`), **never** a hand-typed `notify-api.railway.internal` (see the ⚠ box in § Cross-service wiring) — for the decision→notification push (`POST /system/notifications`, T13, ADR-0017). **Not** `<NOTIFY_API_URL>` (the public domain). | no |
| `SERVICE_CLIENT_ID` | **specs/016 (ADR-0049).** `refund-api` — must be a key of `auth`'s `SERVICE_CLIENTS` with scopes `notifications.push` and `emails.send`. **Required** — `src/lib/env.ts` exits if absent. | no |
| `SERVICE_CLIENT_SECRET` | **specs/016 (ADR-0049).** `${{shared.REFUND_SERVICE_CLIENT_SECRET}}` — byte-identical to that entry's `secret`; 32–256 chars. **Required.** For the decision push (`/system/notifications`) and the batch email (`/system/emails`). | **yes** |
| `REFUND_S3_ENDPOINT` / `REFUND_S3_REGION` / `REFUND_S3_BUCKET` / `REFUND_S3_ACCESS_KEY_ID` / `REFUND_S3_SECRET_ACCESS_KEY` | EU-region S3-compatible object storage for receipt attachments (ADR-0016) — `REFUND_S3_REGION` validated against an EU allowlist at startup once T9 lands. **NOT YET PROVISIONED as of T19** — no bucket exists, no 1Password item exists. See this task's final report / § "Object storage — provisioning" below before T9. | **yes** |
| `REFUND_APP_BASE_URL` | **NEW (T14, specs/008-refund-monthly-processing, ADR-0021).** Absolute base URL of the shell-hosted app — **the shell's own public origin**, e.g. `https://operai.welld.io`, same value as `refund-api.ALLOWED_ORIGINS`/every other backend's shell-origin row — **not** `<REFUND_API_URL>`. Used to build the compiled-batch email's in-app deep link `${REFUND_APP_BASE_URL}/refund/batches/:id`; the email never carries a raw presigned S3 URL. | no |
| `NODE_ENV` | `production` | no |

**`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — REMOVED (specs/011-refund-settings,
AC-4.1).** Do **NOT** set this on the `refund-api` Railway service — the
running service does not read, require, or validate it at all anymore. The
accounting-distribution-email is now an admin-managed, append-only
`refund_setting` row (ADR-0027/0029), viewable/editable in Admin > Refund
(`settings:read`/`settings:manage`). See the cutover runbook immediately
below for moving the currently-deployed value across.

**`refund-api` deploy notes:** no `numReplicas` pin (unlike `notify-api`) —
its `authzMiddleware` in-process cache (T6, ADR-0014) is a per-replica
performance optimization with a 30s TTL backstop, not a correctness-dependent
shared store, so normal Railway autoscale is fine. Region **must** be
`europe-west4` (data residency — financial figures + receipt-attachment
metadata that may carry PII, ADR-0016) and the service must never log
request/response bodies (same `hono/logger` posture as every other backend,
enforced in `refund-api/src/index.ts`, called out in `refund-api/Dockerfile`).

**Cutover — accounting-distribution-email setting (T5, specs/011-refund-settings,
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
   (the table is append-only at the DB level, ADR-0027).
3. Verify: `GET /settings/accounting-distribution-email` (as an admin/
   `refund-admin`, via Admin > Refund or the API directly) shows
   `configured:true` with the expected value and `updatedByEmail:"system-cutover@welld.ch"`.
4. **Only after verifying step 3**, remove `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`
   from the `refund-api` Railway service's variables (it is already unused by
   the running code — this step is housekeeping, not a functional dependency).

There is no cron/scheduled version of this script and none should ever be
added (ADR-0013 posture, mirrors the mileage-rate/settings "derived-on-read,
never scheduled" lineage) — it is a single deliberate command run by a human
at cutover time, never a recurring job.

**Object storage — provisioning (DONE).** ADR-0016 named AWS S3 `eu-south-1`
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
> ADR-0016, but it is a vendor string this repo cannot verify. Given data
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
receipts **directly to the bucket**, never through refund-api (ADR-0016):
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
> broken: refund-api writes it server-side with `PutObject` (ADR-0019), so it
> passes none of these gates. A working batch PDF tells you the credentials
> and endpoint are fine — nothing more.

Only the **shell** origin belongs here: `refund-ui` is a federated remote
reached through the shell (ADR-0006), so the browser `Origin` on the upload is
always the shell's — this is deliberately narrower than refund-api's own
`ALLOWED_ORIGINS` (which additionally carries admin-ui for the `/rates` +
`/settings` calls, ADR-0023). Add a `http://localhost:5173` entry ONLY to a
non-production bucket; `refund-api/.env.example` points local dev at the real
bucket, so uploads will not work locally until you do.

### `inventory-api` service (Railway) — NEW (specs/015-hardware-inventory)

Authoritative list: `inventory-api/src/lib/env.ts` (validated at startup, exits 1 on
any miss). Committed contract: `tools/env-doctor/templates/production/inventory-api.env`.

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/inventory` — **its own logical DB, `inventory`** (create it before the first deploy; `railway.json`'s `preDeployCommand` runs `bun run db:deploy`) | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin only; a `*` fails startup). inventory-ui is a federated remote, so the browser Origin is always the shell's. | no |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks` | no |
| `AUTH_ISSUER` | `<AUTH_URL>` — **public** claim, bucket ② (`${{shared.AUTH_ISSUER}}`) | no |
| `AUTH_AUDIENCE` | `${{shared.AUTH_AUDIENCE}}` — the fourth resource server on this value (ADR-0010) | no |
| `AUTH_BASE_URL` | **internal** (bucket ①): `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` — base for `GET /authz/resolve` (ADR-0014; fails **closed**, 503), `POST /authz/users/identities` (ADR-0039; fails soft) and `POST /system/service-token` (ADR-0044) | no |
| `NOTIFY_INTERNAL_URL` | **internal**: `${{shared.NOTIFY_INTERNAL_URL}}` (literal `http://operai.railway.internal:8080`) — never the public domain, never a hand-typed `notify-api.railway.internal` | no |
| `SERVICE_CLIENT_ID` | `inventory-api` — must be a key of `auth`'s `SERVICE_CLIENTS` | no |
| `SERVICE_CLIENT_SECRET` | `${{shared.INVENTORY_SERVICE_CLIENT_SECRET}}` — byte-identical to that entry's `secret`; at least 32 chars | **yes** |
| `INVENTORY_S3_ENDPOINT` / `_REGION` / `_BUCKET` | the invoice bucket — its **own** bucket and credentials, never refund-api's. The bucket MUST be private (every read is a ~60 s presigned GET minted after the entity-scope check). | no |
| `INVENTORY_S3_ACCESS_KEY_ID` / `INVENTORY_S3_SECRET_ACCESS_KEY` | credentials of that bucket, set directly on the Railway service (no 1Password item) | **yes** |
| `INVENTORY_S3_EU_ENDPOINT_HOSTS` | comma-separated EU endpoint host suffixes. Consulted only for a non-AWS endpoint, where the region string is an opaque placeholder; **empty, unset or non-matching on a non-AWS endpoint exits 1**. An AWS endpoint instead requires an EU `INVENTORY_S3_REGION`. | no |
| `PORT` | `8083` — set explicitly so `${{inventory-api.PORT}}` resolves, and make the public domain target this port | no |
| `NODE_ENV` | `production` | no |

**Deploy notes.** No `numReplicas` pin: authorization results are cached per replica
with a short TTL backstop and the service-token cache is per-process; neither is a
correctness-dependent shared store. `railway.json` pins region `europe-west4`. The
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
   `auth`'s `preDeployCommand` (`db:release`) seeds the `inventory` catalog and the
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

#### Legacy register import (one-off, specs/015 US-12)

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

### Provisioning a new tool

`infra/provision-tool.sh <tool>` creates, or audits, everything a tool needs in
production that `infra/deploy.sh` leaves manual: the Railway service and its logical
database on the shared Postgres, an optional EU bucket, both custom domains, their
Cloudflare DNS records, the Vercel project with its first deployment, and the shell's
two build-time variables. It sets no secret and reads none.

```bash
./infra/provision-tool.sh <tool> [--bucket]                  # plan: read-only audit
./infra/provision-tool.sh <tool> [--bucket] --apply          # create what needs no secret
# set the remaining secrets on <tool>-api in Railway (the script lists their names)
./infra/provision-tool.sh <tool> [--bucket] --connect --redeploy-shell --apply
./infra/check.sh
```

Without `--apply` nothing is changed. It is safe to re-run: it fills gaps only, never
overwrites a variable and never deletes. Needs the `railway`, `vercel` and `cf`
(Cloudflare) CLIs logged in, plus `jq` and `dig`. Two things it cannot do: set the
bucket's CORS rule, and choose secrets.

Do not open or `curl` a new hostname before the script reports that it resolves: a
lookup made before the DNS record exists is cached as "no such host" for 30 minutes.
The order of operations, the human decisions and the reasons behind them are in
`.claude/skills/provision-tool/SKILL.md`.

Status: the plan mode is verified against `inventory` and `refund` (both report
nothing missing). The `--apply` path has not yet been run end to end on a new tool;
treat its first use as a supervised run.

### Frontend build-time vars (Vercel) — `VITE_*` are client-side; `*_REMOTE_URL` are Vite-config-side

| Project | Variable | Value |
|---|---|---|
| **shell** | `VITE_AUTH_URL` / `VITE_API_URL` | `<AUTH_URL>` / `<API_URL>` |
| | `VITE_NOTIFY_API_URL` | `<NOTIFY_API_URL>` — feeds `shell/session`'s trusted-origin allowlist and `getNotifyBaseUrl()` (the raise-capability, `useUnreadCount` SSE manager); also the origin `notify-ui` itself calls (mirrors `VITE_API_URL`/`VITE_AUTH_URL`) |
| | `VITE_REFUND_API_URL` | **NEW (T20, specs/007-refund-service).** `<REFUND_API_URL>` — feeds `shell/session`'s trusted-origin allowlist ONLY (`getTrustedOrigins()`, `shell/src/lib/session.ts`); `refund-ui` calls refund-api using its OWN copy of this same var (own build, see the `refund-ui` row below) — both copies MUST carry the identical `<REFUND_API_URL>` value or `apiFetch` will not recognize refund-ui's request origin as trusted and every call 401s. |
| | `VITE_INVENTORY_API_URL` | **NEW (T41/T43, specs/015).** `<INVENTORY_API_URL>` — build-time, feeds `shell/session`'s trusted-origin allowlist AND `getInventoryApiBaseUrl()`, which `inventory-ui` uses for every inventory-api call (**inventory-ui has no `VITE_INVENTORY_API_URL` of its own** — unlike `refund-ui`, it asks the shell). **Optional by design and unset by default: when unset the inventory origin is NOT trusted, `apiFetch` sends no Bearer JWT there, and every inventory call 401s** — a silent failure, so set it on the shell project and redeploy. Typed in `shell/src/vite-env.d.ts`. |
| | `ESTIMAI_REMOTE_URL` / `REFUND_REMOTE_URL` / `ADMIN_REMOTE_URL` / `NOTIFY_REMOTE_URL` / `INVENTORY_REMOTE_URL` | `https://<estimai/refund/admin/notify/inventory>.operai.welld.io/remoteEntry.js` (the code defaults are the `localhost:517x` dev origins, so an unset value ships a shell pointing at localhost) |
| **estimai-ui** | `VITE_API_URL` | `<API_URL>` — **required**: estimai-ui builds `${VITE_API_URL}/estimates` from its *own* value (must match the shell's) |
| | `VITE_AUTH_URL` / `SHELL_REMOTE_URL` | standalone-only / `https://operai.welld.io/remoteEntry.js` |
| **refund-ui** | `VITE_REFUND_API_URL` | **NEW (T20).** `<REFUND_API_URL>` — **required**: `refund-ui/src/lib/refundApi.ts` builds every refund-api URL from its *own* value (must byte-for-byte match the shell's copy above — see that row's note) |
| | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` |
| **inventory-ui** | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` (no backend vars of its own: inventory-api via `getInventoryApiBaseUrl()`, the user directory via `getAuthBaseUrl()`, both from the shell) |
| **admin-ui**, **notify-ui** | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` (no backend vars of their own — `notify-ui`'s calls to `notify-api` go through the shared `shell/session` module's `VITE_NOTIFY_API_URL`, same pattern `admin-ui` uses for the auth service's admin API) |
| **admin-ui** | `VITE_GOOGLE_MAPS_API_KEY` | **NEW (T16, specs/012-employee-address, ADR-0032).** Google Places API (New) + Maps JavaScript API browser key, referrer-restricted to the **shell's** origins (not admin-ui's own — see § Phase 2's "Google Maps API key — provisioning"). admin-ui's own third-party credential, deliberately **not** a `shell/session` getter. |

Cross-service wiring: `auth.BETTER_AUTH_URL == estimai-api.AUTH_ISSUER ==
notify-api.AUTH_ISSUER == refund-api.AUTH_ISSUER`; `estimai-api.AUTH_JWKS_URL
== notify-api.AUTH_JWKS_URL == refund-api.AUTH_JWKS_URL == <AUTH_URL>/auth/jwks`;
all four backends' `ALLOWED_ORIGINS == shell origin`;
**`auth.AUTH_AUDIENCE == estimai-api.AUTH_AUDIENCE == notify-api.AUTH_AUDIENCE
== refund-api.AUTH_AUDIENCE`** (ADR-0010 — extended to `refund-api` as of
specs/007); **`auth.SERVICE_AUDIENCE == notify-api.SERVICE_AUDIENCE`, and each
`refund-api` / `estimai-api` / `inventory-api` `SERVICE_CLIENT_ID` is a key of
`auth.SERVICE_CLIENTS` whose `secret` equals that service's `SERVICE_CLIENT_SECRET`
and whose scopes are exactly what it needs** (ADR-0044/0049, specs/016);
`auth.NOTIFY_INTERNAL_URL == refund-api.NOTIFY_INTERNAL_URL` is notify-api's **private**-networking
address, distinct from `<NOTIFY_API_URL>`/`VITE_NOTIFY_API_URL` (the public
address every other row above uses); **`shell.VITE_REFUND_API_URL ==
refund-ui.VITE_REFUND_API_URL == <REFUND_API_URL>`** (T20 — two independent
Vercel projects, one value; a drift here silently breaks the Bearer-attach
trusted-origins check even though both builds succeed); **`refund-api.REFUND_APP_BASE_URL ==
refund-api.ALLOWED_ORIGINS == <shell origin>`** (T14, specs/008-refund-monthly-processing,
ADR-0021 — the compiled-batch email's deep link must resolve inside the same shell origin
CORS/trustedOrigins already allow; a drift here doesn't break the build, it just mails a
dead or untrusted link).
**specs/015 additions:** `auth.AUTH_AUDIENCE == … == inventory-api.AUTH_AUDIENCE`;
`inventory-api.AUTH_ISSUER == auth.BETTER_AUTH_URL`; **`auth.SERVICE_AUDIENCE ==
notify-api.SERVICE_AUDIENCE`, and each differs from its own service's
`AUTH_AUDIENCE`** (ADR-0044); `inventory-api.SERVICE_CLIENT_ID` is a key of
`auth.SERVICE_CLIENTS` whose `secret` equals `inventory-api.SERVICE_CLIENT_SECRET` and
whose `scope` contains `notifications.push`; no service holds the retired shared token
(`env:doctor` flags it by name); `inventory-api.INVENTORY_S3_ENDPOINT`'s host is in
`INVENTORY_S3_EU_ENDPOINT_HOSTS` (or an AWS endpoint in an EU region). All except the
bucket's own CORS rule are checked by `mise run env:doctor`
(`tools/env-doctor/README.md`).

---

## Notify credential rollout (specs/016, ADR-0048/0049)

Every caller of `notify-api`'s internal routes moves from the shared
`NOTIFY_INTERNAL_TOKEN` to its own scoped service credential, and the shared token is
then deleted. A push to `main` redeploys all five Railway services at once, in no fixed
order, so the safe order is **three pushes with manual steps between them**. Each step
starts only when the previous one is confirmed.

Roles: **P1/P2/P3** are pushes (T6, T13 and T18 in `specs/016-notify-service-credentials/tasks.md`
are done by a person, never by an agent). **Manual A/B** edit Railway variables. No step below
reads or prints a variable value; where a check lists variables it lists **names only**
(`| jq -r 'keys[]'` keeps the values off the terminal).

### Variables (names; nothing here is a value)

| Variable | Where | Role |
|---|---|---|
| `SERVICE_AUDIENCE` | Shared Variable; referenced by `auth` and `notify-api` | The `aud` on service JWTs. **Required in both from push 1**; must differ from `AUTH_AUDIENCE` and be identical on the two. Already set in production since specs/015. |
| `INVENTORY_SERVICE_CLIENT_SECRET` | Shared Variable | Exists. `inventory-api` is unchanged. |
| `ESTIMAI_SERVICE_CLIENT_SECRET` | Shared Variable (**new**, Manual A) | One secret, 32-256 chars. Referenced inside `auth`'s `SERVICE_CLIENTS` and by `estimai-api`'s `SERVICE_CLIENT_SECRET`. |
| `REFUND_SERVICE_CLIENT_SECRET` | Shared Variable (**new**, Manual A) | Same, for `refund-api`. |
| `SERVICE_CLIENTS` | `auth` | JSON of all clients, shape below. |
| `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET` | `refund-api`, `estimai-api` (**new**, Manual A) | Literal client id (`refund-api` / `estimai-api`) and `${{shared.<NAME>_SERVICE_CLIENT_SECRET}}`. |
| `NOTIFY_INTERNAL_TOKEN` | `notify-api`, `auth`, `refund-api`, `estimai-api` | The shared token. Optional in `notify-api` from push 1; deleted at Manual B; gone from the code at push 3. |

`SERVICE_CLIENTS` on `auth` after Manual A (as in
`tools/env-doctor/templates/production/auth.env`; the secrets are Railway references, never
literals). Each client holds exactly the scopes it needs; `estimai-api` and `inventory-api`
must not hold `emails.send`, and a client id of `auth` is refused at startup (ADR-0048):

```json
{
  "inventory-api": { "secret": "${{shared.INVENTORY_SERVICE_CLIENT_SECRET}}", "scope": "notifications.push" },
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
# R-1: does production override the token endpoint's rate limit downward? (default 20 per 600000 ms)
railway variables --service auth --json | jq -r 'keys[]' | grep '^SERVICE_TOKEN_RATE' || echo "no override (defaults apply)"
```

- Anything `MISSING`: stop. Add the `${{shared.SERVICE_AUDIENCE}}` reference first (its value
  must differ from `AUTH_AUDIENCE`), otherwise push 1 stops `auth` or `notify-api` from starting.
- If a `SERVICE_TOKEN_RATE_*` name is listed, open it in the Railway dashboard (not a secret)
  and confirm the limit is at least 20 per window of at least 600000 ms. Three callers use
  about 8 of 20 in steady state; a deploy that restarts all three while a 401 retry is in
  flight eats into it.
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
this window, raise the default `SERVICE_TOKEN_RATE_LIMIT` to 60 (R-1) rather than retrying
in a loop.

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
  (ADR-0016).
- **`notify-api` single-replica constraint (specs/005 Risk R2):** never scale
  `notify-api` past `numReplicas: 1` (Railway dashboard autoscale or a
  `railway.json` edit) without first moving its EventBus fan-out and
  stream-ticket store onto Postgres `LISTEN`/`NOTIFY` + a shared ticket table
  — both are designed behind an interface for that migration, but the current
  in-process implementation silently breaks (missed events, ticket
  mint↔connect mismatches) across two or more instances.
- **Service-client secret rotation / revocation (specs/016, ADR-0049):** if one caller's
  secret is suspected, set a new value on its `<NAME>_SERVICE_CLIENT_SECRET` Shared
  Variable and redeploy `auth` (its `SERVICE_CLIENTS` references it) and that caller. To cut
  a caller off at once, remove its entry from `SERVICE_CLIENTS` and redeploy `auth`;
  credentials already minted expire within 5 minutes. The other callers are unaffected —
  there is no shared secret to rotate in lockstep. Never log the value; `railway variables`
  output containing it should not be pasted into chat/tickets.
- **`/system/emails` and `/system/notifications` network exposure (specs/006
  Risk R2, specs/007 ADR-0017, specs/016):** the scoped service credential is the enforced
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

## Audit-log redaction — GDPR/nLPD subject-erasure requests (specs/012-employee-address, ADR-0033, Risk R5)

As of specs/012, `auth`'s `audit_log` carries employee home addresses
(`user.address.set` entries) in its `data.before`/`data.after` payload. Per
**ADR-0033** — a deliberate, user-decided (2026-08-04) two-tier
audit-assurance model for the suite — `audit_log` is **Tier 2
(application-level immutability only)**: no mutating export from the audit
module, no mutating route on the audit API, no production code path that
updates or deletes a row. This is unlike the suite's Tier 1 tables
(`RefundAuditEntry`/`MileageRate`/`RefundSetting`, ADR-0018/0024/0027), which
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
   exists (by design — ADR-0033 §1(c): every mutating verb on `/admin/audit`
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
   scheduled" posture for one-time operator actions (ADR-0013 lineage,
   mirrored by the accounting-distribution-email cutover script above in §
   Variable reference). Every redaction is a deliberate, individually
   authorized command run by a human against production, exactly once per
   request.

See **ADR-0033** for the full reasoning — why `audit_log` is Tier 2 rather
than Tier 1, why that is a deliberate trade-off rather than an oversight, and
the escalation path (dropping `AuditLog.actorUserId`'s FK first) if a future
regulatory or product trigger requires raising `audit_log` to Tier 1.
