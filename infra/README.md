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
Vercel (5 projects, one origin each)          Railway project (europe-west4)
┌───────────────────────────────┐             ┌───────────────────────────────┐
│ shell   https://operai.welld.io│──┐ loads    │ auth        (Bun+Hono)        │
│         (host, entry point)    │  │ remote-  │  https://auth.operai.welld.io │
├───────────────────────────────┤  │ Entry.js ├───────────────────────────────┤
│ estimai-ui  estimai.operai…    │◄─┤ at run-  │ estimai-api (Bun+Hono)        │
│ refund-ui   refund.operai…     │◄─┤ time, in │  https://estimai-api.operai… │
│ admin-ui    admin.operai…      │◄─┤ browser  ├───────────────────────────────┤
│ notify-ui   notify.operai…     │◄─┘          │ notify-api  (Bun+Hono)        │
└───────────────────────────────┘              │  https://notify-api.operai…  │
   shell owns session; remotes                 │  numReplicas: 1 (R2 — see    │
   delegate to shell/session                   │  below), SSE + ticket store  │
                                                │  are single-instance only    │
                                                ├───────────────────────────────┤
                                                │ Postgres (shared)             │
                                                │   ├─ db: auth                 │
                                                │   ├─ db: estimai              │
                                                │   └─ db: notify               │
                                                │ estimai-api,                  │
                                                │ notify-api → auth /auth/jwks  │
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
  authorization/admin API), `estimai-api` (estimate persistence), and
  `notify-api` (notification persistence + SSE push, specs/005). One Postgres
  instance, three logical databases (`auth`, `estimai`, `notify`); service↔DB
  traffic stays on Railway private networking (`*.railway.internal`).
  **`notify-api` is pinned to a single replica** (`railway.json`
  `numReplicas: 1`) — its in-process EventBus fan-out and stream-ticket store
  are correct for exactly one running instance (plan.md Risk R2). Do not
  enable autoscale/multiple replicas for this service without first moving
  both seams onto Postgres `LISTEN`/`NOTIFY` + a shared ticket table.
- **`notify-api` and `estimai-api` are cross-valid JWKS resource servers**
  (ADR-0010) — both verify the same `auth`-issued tokens, so both (plus
  `auth`, which stamps the claim) require an identical **`AUTH_AUDIENCE`**
  value or a token minted for one is structurally valid at the other. See
  § Variable reference.
- **`auth` → `notify-api` service-to-service email trigger** (specs/006-user-invitations,
  ADR-0011): `auth` calls `notify-api`'s internal `POST /system/emails` to send
  invite/resend emails (Resend, bilingual) — the suite's first non-user-JWT
  cross-service call, authenticated by a shared `NOTIFY_INTERNAL_TOKEN`
  instead of a Bearer JWT. This call is routed over Railway **private
  networking** (`NOTIFY_INTERNAL_URL` → `notify-api.railway.internal`), not
  the public `<NOTIFY_API_URL>` domain the browser uses for SSE — see
  § Variable reference and § Phase 1 step 7.
- **The public URL placeholders** used below — keep them straight; all need
  the `https://` scheme:
  - `<AUTH_URL>` = the **auth** service (e.g. `https://auth.operai.welld.io`). It
    is the JWT **issuer**, so `estimai-api` and `notify-api` point back at it.
  - `<API_URL>` = the **estimai-api** service (e.g. `https://estimai-api.operai.welld.io`).
    Only the browser/UI references it.
  - `<NOTIFY_API_URL>` = the **notify-api** service's **public** domain (e.g.
    `https://notify-api.operai.welld.io`). Only the browser/UI references it
    (via `VITE_NOTIFY_API_URL`); it is also the origin the shell CSP's
    `connect-src` must allow for the SSE `EventSource` (R6 — see Phase 3).
  - `<NOTIFY_INTERNAL_URL>` = notify-api's Railway **private**-networking
    address (e.g. `http://notify-api.railway.internal:8081`) — distinct from
    `<NOTIFY_API_URL>` above. Only `auth`'s server-side `POST /system/emails`
    call uses it (specs/006-user-invitations, ADR-0011); never given to a
    browser, never the public domain — see § Phase 1 step 7.

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
   `direnv allow estimai-api`, `direnv allow notify-api`) once, be signed in to
   `op`, and run deploy commands from within that shell (e.g.
   `direnv exec auth ./infra/deploy.sh`) so the secrets are exported. The full
   variable → 1Password-item map is in **§ Variable reference** below.
3. **Railway project** exists (its id is in 1Password as `$RAILWAY_PROJECT_ID`).
   Creating the project + attaching custom domains is a one-time dashboard action.

---

## Order of operations

Each phase feeds the next, so do them in order:

1. **Railway — backends first.** Yields `<AUTH_URL>`, `<API_URL>`, and `<NOTIFY_API_URL>`.
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
   three logical DBs (the script attempts this; or `railway connect Postgres` →
   `CREATE DATABASE auth;` `CREATE DATABASE estimai;` `CREATE DATABASE notify;`).
   They must exist before the first deploy — each service's `preDeployCommand`
   runs `prisma migrate deploy` against its own DB.
3. **Deploy `auth`** (root dir `auth`, reads `auth/railway.json`): set its vars
   (DATABASE_URL via `${{Postgres.*}}` references, `BETTER_AUTH_SECRET`,
   `GOOGLE_*`/`GITHUB_*`, `JWT_*`, `ALLOWED_ORIGINS=<shell origin>`, `UI_HOME_URL`,
   `AUTH_AUDIENCE` (ADR-0010 — one suite-wide value; see below),
   `NOTIFY_INTERNAL_URL`/`NOTIFY_INTERNAL_TOKEN` (specs/006-user-invitations,
   ADR-0011 — see below), `BOOTSTRAP_ADMIN_EMAIL`, `NODE_ENV=production`), then
   deploy. **Generate its domain** (dashboard → Settings → Networking, or a
   custom `auth.operai.welld.io`) → this is **`<AUTH_URL>`**.
4. **Deploy `estimai-api`** (root dir `estimai-api`): set `DATABASE_URL` (dbname
   `estimai`), `ALLOWED_ORIGINS`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `AUTH_AUDIENCE` (byte-for-byte identical
   to `auth`'s), `NODE_ENV`. **Generate its domain** → **`<API_URL>`**.
5. **Deploy `notify-api`** (root dir `notify-api`, reads `notify-api/railway.json`
   — note it pins **`numReplicas: 1`**, do not change this without first reading
   plan.md Risk R2): set `DATABASE_URL` (dbname `notify`, **not** `estimai`),
   `ALLOWED_ORIGINS=<shell origin>`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `AUTH_AUDIENCE` (same value as the other
   two), `MAX_STREAM_DURATION` (seconds; default `1800`),
   `NOTIFY_INTERNAL_TOKEN` (same value as `auth`'s — see below),
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
   > `auth`, `estimai-api`, …), then redeploy — Railway then reads
   > `<app>/railway.json` (`builder: DOCKERFILE`) and does the correct Bun build.
   > This applies to BOTH GitHub-connected deploys and `deploy.sh`'s
   > `railway up --service <svc>` (which uploads the repo root as context; the
   > Root Directory setting is what scopes the build down to the app).
6. **Cross-wire:** set `auth`'s `BETTER_AUTH_URL=<AUTH_URL>` (the JWT `iss` claim —
   must equal `estimai-api.AUTH_ISSUER` and `notify-api.AUTH_ISSUER`) and
   redeploy `auth`. Re-run the script with `AUTH_PUBLIC_URL=<AUTH_URL>` once the
   domain exists.
7. **Wire the invitation email channel** (specs/006-user-invitations, ADR-0011):
   set `auth`'s `NOTIFY_INTERNAL_URL` to notify-api's **Railway private**
   networking address, e.g. `http://notify-api.railway.internal:8081`
   (dashboard → notify-api service → Settings → Networking → Private Networking
   shows the exact internal hostname/port) — **not** `<NOTIFY_API_URL>`, the
   public domain from step 5 (plan.md Risk R2 / ADR-0011: this
   service-to-service call must stay off the public internet). Generate a
   strong shared secret (`openssl rand -hex 32`) and set it as
   `NOTIFY_INTERNAL_TOKEN` on **both** `auth` and `notify-api` — byte-for-byte
   identical, stored once in 1Password and referenced by both services'
   `.envrc`. Set `notify-api`'s `EMAIL_ENABLED=true` with real
   `RESEND_API_KEY`/`RESEND_FROM` only once the Resend sending domain is
   verified (see § Resend domain setup below) — until then, leave
   `EMAIL_ENABLED=false` so invite emails are stubbed (recorded, not actually
   sent) rather than failing loudly.

**`AUTH_AUDIENCE` (ADR-0010) — one value, three services.** `notify-api` is the
suite's first real second JWKS resource server, so a token minted for
`estimai-api` would otherwise be structurally valid at `notify-api` (and vice
versa). `auth` stamps the `audience` claim on every JWT it issues; both
`estimai-api` and `notify-api` verify `audience` against their own
`AUTH_AUDIENCE`. **All three services must carry the byte-for-byte identical
value** (local default: `operai-suite`, see each service's `.env.example`) — a
drifted value fails every request closed (401) in that environment, not open.

**`NOTIFY_INTERNAL_TOKEN` (ADR-0011) — shared secret, two services, no user
identity.** `auth` calls `notify-api`'s `POST /system/emails` to send
invite/resend emails — deliberately NOT the JWKS/Bearer-JWT pattern above,
because the invitee has no `User` row/`sub` yet and `auth` itself isn't a
signed-in end user. Instead both services validate a single shared secret via
the `X-Internal-Token` header. **Both `auth.NOTIFY_INTERNAL_TOKEN` and
`notify-api.NOTIFY_INTERNAL_TOKEN` must be byte-for-byte identical**, sourced
from one 1Password item, ≥32 random chars, never logged by either service —
plan.md Risk R2: a leaked token lets an attacker send arbitrary email over
wellD's Resend domain. Rotate by generating a new value, updating 1Password,
and redeploying **both** services together (a stale value on either side
fails every send closed, 401, not open).

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
export AUTH_AUDIENCE=operai-suite    # ADR-0010 — identical across auth + estimai-api + notify-api
export AUTH_PUBLIC_URL=https://auth.operai.welld.io   # after the auth domain exists
direnv exec auth ./infra/deploy.sh
```

**Do NOT set** `ENABLE_TEST_AUTH` (a complete auth bypass — the `POST
/test-auth/session` mint endpoint), `BETTER_AUTH_TRUSTED_ORIGINS` (bypasses the
validated `ALLOWED_ORIGINS` allowlist), or `PORT` (Railway injects it).

**Migrations + seed run automatically** — each `railway.json` `preDeployCommand`
is `bun run db:deploy && bun run db:seed` (for `auth`; `estimai-api` and
`notify-api` run `db:deploy` only). `migrate deploy` is non-interactive and only
applies pending migrations; the authz seed (idempotent) creates the system
roles + app-access catalog and, on first sign-in of `BOOTSTRAP_ADMIN_EMAIL`, the
first admin. Never edit an existing migration file.

---

## Phase 2 — Vercel frontends

**Project + domain creation is manual** (Vercel CLI can't create+assign domains
here); env-var sync + redeploy is automatable (`./infra/deploy.sh --vercel`).

1. **Create five projects** (dashboard → New Project → import this repo). For each,
   **Root Directory** = the app dir (`shell` / `estimai-ui` / `refund-ui` /
   `admin-ui` / `notify-ui`), framework **Vite**, default build (`pnpm build` →
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

---

## Phase 3 — Cross-wire origins + OAuth

- **`ALLOWED_ORIGINS`** on all three backends (`auth`, `estimai-api`,
  `notify-api`) must be the **shell's** origin (`https://operai.welld.io`) —
  that's what CORS + better-auth `trustedOrigins` validate. Only the shell's
  origin is needed: the remotes never call the backends directly (they
  delegate to `shell/session`, which runs under the shell's origin). This
  includes `notify-api`'s SSE stream endpoint — its
  `Access-Control-Allow-Origin` is pinned to the shell origin too (plan.md).
  Redeploy the affected service after a change.
- **OAuth redirect URIs** (better-auth mounts at `/auth`):
  - Google Cloud Console → your OAuth client → Authorized redirect URIs:
    `<AUTH_URL>/auth/callback/google`
  - GitHub → Developer settings → OAuth App → Authorization callback URL:
    `<AUTH_URL>/auth/callback/github`
- **Shell CSP** (`shell/vercel.json`, a static header) pins each remote origin +
  the auth/API origins in `script-src`/`connect-src`, and allows Google/GitHub
  avatar hosts in `img-src`. If domains change, edit that file.
  **`connect-src` MUST include the `notify-api` origin** —
  `EventSource` (SSE) is governed by `connect-src`, not `script-src`; this is
  the classic miss for a streaming feature (plan.md Risk R6). Both
  `notify.operai.welld.io` (the remote, in `script-src` **and** `connect-src`)
  and `notify-api.operai.welld.io` (the SSE origin, in `connect-src`) are
  already present in `shell/vercel.json`'s CSP string (specs/005 T19) —
  `check.sh` asserts this pin so a future edit that drops it fails loudly.
  *(Known gap: Vercel Preview deploys get `*.vercel.app` URLs the pinned CSP
  won't match — assign preview subdomains or relax CSP via Edge Middleware;
  not implemented.)*

---

## Phase 4 — Verify

```bash
./infra/check.sh
```
It checks backend `/health` for all three backends (`auth`, `estimai-api`,
`notify-api`), the **`/auth/jwks`** RS256 key set (the endpoint both resource
servers verify against — **not** `/.well-known/jwks.json`, an orphaned env-key
endpoint), each remote's `remoteEntry.js` + CORS header (now five: `estimai-ui`,
`refund-ui`, `admin-ui`, `notify-ui`), the shell CSP pins (including the
`notify-api` SSE `connect-src` pin, R6), and warns if `notify-api`'s health
payload doesn't look JWKS-ready. It also probes `POST
$NOTIFY_API_URL/system/emails` (specs/006, ADR-0011): a garbage
`X-Internal-Token` must get 401 (proves the internal-token gate is deployed
and live), and — only if you export `NOTIFY_INTERNAL_TOKEN` locally (the same
value configured on both services) — a deliberately-invalid body with the
*real* token must get 400, not 401 (proves the deployed value matches yours,
without ever printing or transmitting a real send). Then, in a browser at
`https://operai.welld.io/`: hit a guarded route → redirected to
`<AUTH_URL>/sign-in`; sign in with Google + GitHub; the `BOOTSTRAP_ADMIN_EMAIL`
account sees the **Admin** tool in the nav; create an estimate + reload
(persists); sign out (session ends suite-wide, no 403); as an admin, send a
test invitation from the **Invitations** page and confirm `EMAIL_ENABLED`'s
posture matches expectation (stubbed `sent` if `false`, an actual Resend send
if `true`).

---

## Variable reference

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
| `NOTIFY_INTERNAL_URL` | **NEW (specs/006, ADR-0011).** notify-api's Railway **private**-networking address, e.g. `http://notify-api.railway.internal:8081` — **not** `<NOTIFY_API_URL>` (the public domain). Base URL for the `POST /system/emails` call (`src/lib/notify.ts`). | no |
| `NOTIFY_INTERNAL_TOKEN` | **NEW (specs/006, ADR-0011).** Shared secret sent as `X-Internal-Token`; byte-for-byte identical to `notify-api.NOTIFY_INTERNAL_TOKEN`. 1Password → `AIScream / OperAI - NOTIFY_INTERNAL_TOKEN` (≥32 random chars). A leaked value = arbitrary email over wellD's Resend domain (Risk R2) — never logged, rotate + redeploy both services together if compromised. | **yes** |
| `BOOTSTRAP_ADMIN_EMAIL` | email of the first admin (specs/004 AC-6.1; gets `admin` on first sign-in). Set on Railway, not committed. | no |
| `NODE_ENV` | `production` | no |
| `PORT` / `ENABLE_TEST_AUTH` / `BETTER_AUTH_TRUSTED_ORIGINS` | **leave UNSET** (see Phase 1) | — |

### `estimai-api` service (Railway)

| Variable | Value | 
|---|---|
| `DATABASE_URL` | `…@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/estimai` |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`) |
| `AUTH_JWKS_URL` | `<AUTH_URL>/auth/jwks` (**not** `/.well-known/jwks.json`) |
| `AUTH_AUDIENCE` | **NEW (ADR-0010).** Same value as `auth.AUTH_AUDIENCE` and `notify-api.AUTH_AUDIENCE` — `jwtVerify` pins `audience`; a token with a missing/wrong `aud` is rejected 401. | no |
| `NODE_ENV` | `production` · `MAX_ESTIMATE_BYTES`/`MAX_IMPORT_REQUEST_BYTES` optional (defaults) |

### `notify-api` service (Railway) — NEW (specs/005-notification-center)

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/notify` — **its own logical DB, `notify`, not `estimai`** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin) — also what the SSE stream's `Access-Control-Allow-Origin` echoes | no |
| `AUTH_JWKS_URL` | `<AUTH_URL>/auth/jwks` (same endpoint `estimai-api` uses — **not** `/.well-known/jwks.json`) | no |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`) | no |
| `AUTH_AUDIENCE` | **NEW (ADR-0010).** Byte-for-byte identical to `auth.AUTH_AUDIENCE` and `estimai-api.AUTH_AUDIENCE` — `notify-api` is the suite's first real second JWKS resource server, so a drifted value here either rejects everything (401) or (worse, if unset elsewhere) allows cross-service token replay. | no |
| `MAX_STREAM_DURATION` | Seconds an SSE connection may stay open before the server forces a reconnect (ADR-0008). Default `1800` (~30 min). | no |
| `NOTIFY_INTERNAL_TOKEN` | **NEW (specs/006, ADR-0011).** Same 1Password item as `auth.NOTIFY_INTERNAL_TOKEN` — byte-for-byte identical. **Unconditionally required** (no default; `notify-api` refuses to start without it, min 32 chars) — unlike `EMAIL_ENABLED`/`RESEND_*` below, there is no "off" mode. Validated by `internalTokenMiddleware` against `X-Internal-Token` on `POST /system/emails` **only** — never accepted on any `jwtMiddleware` route. | **yes** |
| `EMAIL_ENABLED` | **NEW (specs/006).** `"true"` (exact string, case-insensitive) to make real Resend calls; any other value (including unset) stubs the send and still records an `EmailDelivery` row. Default `false` — safe for first deploys before the Resend domain is verified (see § Resend domain setup). | no |
| `RESEND_API_KEY` | **NEW (specs/006).** 1Password → `AIScream / OperAI - Resend API Key`. Required only when `EMAIL_ENABLED=true` (service refuses to start otherwise once enabled). | **yes** |
| `RESEND_FROM` | **NEW (specs/006).** Verified sending address on the SPF/DKIM-configured domain, e.g. `no-reply@operai.welld.io` (Risk R5). Required only when `EMAIL_ENABLED=true`. | no |
| `NODE_ENV` | `production` | no |

**`notify-api` deploy constraints (do not relax without reading plan.md Risk
R2):** `railway.json` pins **`numReplicas: 1`** — the in-process EventBus
fan-out and the in-process stream-ticket store are correct for exactly one
running instance; a second replica silently splits both. Region **must** be
`europe-west4` (data residency — notification title/body may name
clients/estimates) and the service must never log request/response bodies
(reuses `estimai-api`'s method+path+status-only `hono/logger` posture, enforced
in `notify-api/src/index.ts` and called out in `notify-api/Dockerfile`).

### Frontend build-time vars (Vercel) — `VITE_*` are client-side; `*_REMOTE_URL` are Vite-config-side

| Project | Variable | Value |
|---|---|---|
| **shell** | `VITE_AUTH_URL` / `VITE_API_URL` | `<AUTH_URL>` / `<API_URL>` |
| | `VITE_NOTIFY_API_URL` | **NEW.** `<NOTIFY_API_URL>` — feeds `shell/session`'s trusted-origin allowlist and `getNotifyBaseUrl()` (the raise-capability, `useUnreadCount` SSE manager); also the origin `notify-ui` itself calls (mirrors `VITE_API_URL`/`VITE_AUTH_URL`) |
| | `ESTIMAI_REMOTE_URL` / `REFUND_REMOTE_URL` / `ADMIN_REMOTE_URL` | `https://<estimai/refund/admin>.operai.welld.io/remoteEntry.js` |
| **estimai-ui** | `VITE_API_URL` | `<API_URL>` — **required**: estimai-ui builds `${VITE_API_URL}/estimates` from its *own* value (must match the shell's) |
| | `VITE_AUTH_URL` / `SHELL_REMOTE_URL` | standalone-only / `https://operai.welld.io/remoteEntry.js` |
| **refund-ui**, **admin-ui**, **notify-ui** | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` (no backend vars of their own — `notify-ui`'s calls to `notify-api` go through the shared `shell/session` module's `VITE_NOTIFY_API_URL`, same pattern `admin-ui` uses for the auth service's admin API) |

Cross-service wiring: `auth.BETTER_AUTH_URL == estimai-api.AUTH_ISSUER ==
notify-api.AUTH_ISSUER`; `estimai-api.AUTH_JWKS_URL == notify-api.AUTH_JWKS_URL
== <AUTH_URL>/auth/jwks`; all three backends' `ALLOWED_ORIGINS == shell
origin`; **`auth.AUTH_AUDIENCE == estimai-api.AUTH_AUDIENCE ==
notify-api.AUTH_AUDIENCE`** (ADR-0010 — new as of specs/005);
**`auth.NOTIFY_INTERNAL_TOKEN == notify-api.NOTIFY_INTERNAL_TOKEN`** (ADR-0011
— new as of specs/006, this pair only, not `estimai-api`); `auth.NOTIFY_INTERNAL_URL`
is notify-api's **private**-networking address, distinct from
`<NOTIFY_API_URL>`/`VITE_NOTIFY_API_URL` (the public address every other row
above uses).

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
  across `auth`, `estimai-api`, **and `notify-api`** (the last handles
  notification title/body, which may name clients/estimates — the same
  no-body-logging rule applies). Don't add a CDN/log-aggregator/backup target
  that routes EU data outside the EU.
- **`notify-api` single-replica constraint (specs/005 Risk R2):** never scale
  `notify-api` past `numReplicas: 1` (Railway dashboard autoscale or a
  `railway.json` edit) without first moving its EventBus fan-out and
  stream-ticket store onto Postgres `LISTEN`/`NOTIFY` + a shared ticket table
  — both are designed behind an interface for that migration, but the current
  in-process implementation silently breaks (missed events, ticket
  mint↔connect mismatches) across two or more instances.
- **`NOTIFY_INTERNAL_TOKEN` rotation (specs/006, ADR-0011 Risk R2):** if
  compromise is suspected, generate a new value (`openssl rand -hex 32`),
  update the single 1Password item, then `railway variables --set
  "NOTIFY_INTERNAL_TOKEN=$NEW" --service auth` **and** `--service notify-api`,
  and redeploy **both** services close together — there is no dual-key grace
  period (unlike the JWKS keypair), so a gap between the two redeploys is a
  short window where every `POST /system/emails` call 401s. Never log the
  value; `railway variables` output containing it should not be pasted into
  chat/tickets.
- **`/system/emails` network exposure (specs/006 Risk R2):** the shared token
  is the enforced access control regardless of network path, but reduce
  exposure further by keeping `auth`'s `NOTIFY_INTERNAL_URL` on notify-api's
  Railway **private**-networking hostname (never the public
  `<NOTIFY_API_URL>` domain) — this specific call should never traverse the
  public internet. `notify-api` still needs its public domain for the
  browser-facing SSE/notification routes; there is currently no per-route
  network-level isolation (Railway private networking is per-service, not
  per-route) — flagged here, not solved, since splitting `/system/emails` onto
  a network-isolated deployment would be a new infra topology decision (ADR
  territory), not something to adopt unilaterally.
- **Secrets** are only ever referenced from the direnv/1Password shell, never
  pasted literally or committed; `.pem` files are gitignored; the pre-commit
  gitleaks hook guards commits.
