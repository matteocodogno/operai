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
Vercel (4 projects, one origin each)          Railway project (europe-west4)
┌───────────────────────────────┐             ┌───────────────────────────────┐
│ shell   https://operai.welld.io│──┐ loads    │ auth        (Bun+Hono)        │
│         (host, entry point)    │  │ remote-  │  https://auth.operai.welld.io │
├───────────────────────────────┤  │ Entry.js ├───────────────────────────────┤
│ estimai-ui  estimai.operai…    │◄─┤ at run-  │ estimai-api (Bun+Hono)        │
│ refund-ui   refund.operai…     │◄─┤ time, in │  https://estimai-api.operai…  │
│ admin-ui    admin.operai…      │◄─┘ browser  ├───────────────────────────────┤
└───────────────────────────────┘             │ Postgres (shared)             │
   shell owns session; remotes                 │   ├─ db: auth                 │
   delegate to shell/session                   │   └─ db: estimai              │
                                               │ estimai-api → auth /auth/jwks │
                                               └───────────────────────────────┘
```

- **Frontends:** the `shell` is the human entry point (`operai.welld.io`); the
  three tools (`estimai-ui`, `refund-ui`, `admin-ui`) are runtime-federated
  remotes, each on its own subdomain, loaded cross-origin by the shell (ADR-0006).
- **Backends:** `auth` (OAuth, sessions, RS256 JWT + JWKS, hosted sign-in,
  authorization/admin API) and `estimai-api` (estimate persistence). One Postgres
  instance, two logical databases (`auth`, `estimai`); service↔DB traffic stays on
  Railway private networking (`*.railway.internal`).
- **The two public URL placeholders** used below — keep them straight; both need
  the `https://` scheme:
  - `<AUTH_URL>` = the **auth** service (e.g. `https://auth.operai.welld.io`). It
    is the JWT **issuer**, so `estimai-api` points back at it.
  - `<API_URL>` = the **estimai-api** service (e.g. `https://estimai-api.operai.welld.io`).
    Only the browser/UI references it.

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
   `direnv allow estimai-api`) once, be signed in to `op`, and run deploy commands
   from within that shell (e.g. `direnv exec auth ./infra/deploy.sh`) so the
   secrets are exported. The full variable → 1Password-item map is in
   **§ Variable reference** below.
3. **Railway project** exists (its id is in 1Password as `$RAILWAY_PROJECT_ID`).
   Creating the project + attaching custom domains is a one-time dashboard action.

---

## Order of operations

Each phase feeds the next, so do them in order:

1. **Railway — backends first.** Yields `<AUTH_URL>` and `<API_URL>`.
2. **Vercel — the four frontends.** Their build-time vars point at the Phase-1 URLs.
3. **Cross-wire origins + OAuth.** Backends trust the shell origin; register OAuth redirects.
4. **Verify** end-to-end (`./infra/check.sh`).

**Chicken-and-egg, resolved:** the shell's production origin is fixed in advance
(`https://operai.welld.io`), so the backends' `ALLOWED_ORIGINS`/`UI_HOME_URL` can
be set in Phase 1 without waiting for Vercel. Only the two **backend** URLs are
discovered during deploy — which is why the frontends' vars come after.

---

## Phase 1 — Railway backends

The automatable parts are in **`./infra/deploy.sh`**; the manual dashboard bits
are called out. What the script does, step by step:

1. **Link** the project: `railway link "$RAILWAY_PROJECT_ID"` (env `production`).
2. **Postgres** (manual first time): dashboard → New → Database → PostgreSQL;
   confirm its **region is `europe-west4`** before adding data. Then create the two
   logical DBs (the script attempts this; or `railway connect Postgres` →
   `CREATE DATABASE auth;` `CREATE DATABASE estimai;`). They must exist before the
   first deploy — each service's `preDeployCommand` runs `prisma migrate deploy`
   against its own DB.
3. **Deploy `auth`** (root dir `auth`, reads `auth/railway.json`): set its vars
   (DATABASE_URL via `${{Postgres.*}}` references, `BETTER_AUTH_SECRET`,
   `GOOGLE_*`/`GITHUB_*`, `JWT_*`, `ALLOWED_ORIGINS=<shell origin>`, `UI_HOME_URL`,
   `BOOTSTRAP_ADMIN_EMAIL`, `NODE_ENV=production`), then deploy. **Generate its
   domain** (dashboard → Settings → Networking, or a custom `auth.operai.welld.io`)
   → this is **`<AUTH_URL>`**.
4. **Deploy `estimai-api`** (root dir `estimai-api`): set `DATABASE_URL` (dbname
   `estimai`), `ALLOWED_ORIGINS`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `NODE_ENV`. **Generate its domain** →
   **`<API_URL>`**.
5. **Cross-wire:** set `auth`'s `BETTER_AUTH_URL=<AUTH_URL>` (the JWT `iss` claim —
   must equal `estimai-api.AUTH_ISSUER`) and redeploy `auth`. Re-run the script
   with `AUTH_PUBLIC_URL=<AUTH_URL>` once the domain exists.

**Run it:**
```bash
export RAILWAY_PROJECT_ID=...        # from 1Password
export BOOTSTRAP_ADMIN_EMAIL=you@welld.ch
export AUTH_PUBLIC_URL=https://auth.operai.welld.io   # after the auth domain exists
direnv exec auth ./infra/deploy.sh
```

**Do NOT set** `ENABLE_TEST_AUTH` (a complete auth bypass — the `POST
/test-auth/session` mint endpoint), `BETTER_AUTH_TRUSTED_ORIGINS` (bypasses the
validated `ALLOWED_ORIGINS` allowlist), or `PORT` (Railway injects it).

**Migrations + seed run automatically** — each `railway.json` `preDeployCommand`
is `bun run db:deploy && bun run db:seed` (for `auth`; `estimai-api` runs
`db:deploy`). `migrate deploy` is non-interactive and only applies pending
migrations; the authz seed (idempotent) creates the system roles + app-access
catalog and, on first sign-in of `BOOTSTRAP_ADMIN_EMAIL`, the first admin. Never
edit an existing migration file.

---

## Phase 2 — Vercel frontends

**Project + domain creation is manual** (Vercel CLI can't create+assign domains
here); env-var sync + redeploy is automatable (`./infra/deploy.sh --vercel`).

1. **Create four projects** (dashboard → New Project → import this repo). For each,
   **Root Directory** = the app dir (`shell` / `estimai-ui` / `refund-ui` /
   `admin-ui`), framework **Vite**, default build (`pnpm build` → `dist`). Each app
   ships its own `vercel.json` (SPA rewrites + headers) picked up automatically.
2. **Assign domains:**

   | Project | Domain | Notes |
   |---|---|---|
   | `shell` | `operai.welld.io` | **Reassign** from the old `estimai-ui` project — the human entry point |
   | `estimai-ui` | `estimai.operai.welld.io` | remote-only; keeps a redirect for the old URL (below) |
   | `refund-ui` | `refund.operai.welld.io` | remote-only |
   | `admin-ui` | `admin.operai.welld.io` | remote-only (roles & permissions, specs/004) |

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
   reads it at every page load (`shell/src/lib/runtimeRemotes.ts`).

---

## Phase 3 — Cross-wire origins + OAuth

- **`ALLOWED_ORIGINS`** on both backends must be the **shell's** origin
  (`https://operai.welld.io`) — that's what CORS + better-auth `trustedOrigins`
  validate. Only the shell's origin is needed: the remotes never call the backends
  directly (they delegate to `shell/session`, which runs under the shell's origin).
  Redeploy the affected service after a change.
- **OAuth redirect URIs** (better-auth mounts at `/auth`):
  - Google Cloud Console → your OAuth client → Authorized redirect URIs:
    `<AUTH_URL>/auth/callback/google`
  - GitHub → Developer settings → OAuth App → Authorization callback URL:
    `<AUTH_URL>/auth/callback/github`
- **Shell CSP** (`shell/vercel.json`, a static header) pins each remote origin +
  the auth/API origins in `script-src`/`connect-src`, and allows Google/GitHub
  avatar hosts in `img-src`. If domains change, edit that file. *(Known gap: Vercel
  Preview deploys get `*.vercel.app` URLs the pinned CSP won't match — assign
  preview subdomains or relax CSP via Edge Middleware; not implemented.)*

---

## Phase 4 — Verify

```bash
./infra/check.sh
```
It checks backend `/health`, the **`/auth/jwks`** RS256 key set (the endpoint
`estimai-api` verifies against — **not** `/.well-known/jwks.json`, an orphaned
env-key endpoint), each remote's `remoteEntry.js` + CORS header, and the shell CSP
pins. Then, in a browser at `https://operai.welld.io/`: hit a guarded route →
redirected to `<AUTH_URL>/sign-in`; sign in with Google + GitHub; the
`BOOTSTRAP_ADMIN_EMAIL` account sees the **Admin** tool in the nav; create an
estimate + reload (persists); sign out (session ends suite-wide, no 403).

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
| `NODE_ENV` | `production` · `MAX_ESTIMATE_BYTES`/`MAX_IMPORT_REQUEST_BYTES` optional (defaults) |

### Frontend build-time vars (Vercel) — `VITE_*` are client-side; `*_REMOTE_URL` are Vite-config-side

| Project | Variable | Value |
|---|---|---|
| **shell** | `VITE_AUTH_URL` / `VITE_API_URL` | `<AUTH_URL>` / `<API_URL>` |
| | `ESTIMAI_REMOTE_URL` / `REFUND_REMOTE_URL` / `ADMIN_REMOTE_URL` | `https://<estimai/refund/admin>.operai.welld.io/remoteEntry.js` |
| **estimai-ui** | `VITE_API_URL` | `<API_URL>` — **required**: estimai-ui builds `${VITE_API_URL}/estimates` from its *own* value (must match the shell's) |
| | `VITE_AUTH_URL` / `SHELL_REMOTE_URL` | standalone-only / `https://operai.welld.io/remoteEntry.js` |
| **refund-ui**, **admin-ui** | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` (no backend vars of their own) |

Cross-service wiring: `auth.BETTER_AUTH_URL == estimai-api.AUTH_ISSUER`;
`estimai-api.AUTH_JWKS_URL == <AUTH_URL>/auth/jwks`; both backends'
`ALLOWED_ORIGINS == shell origin`.

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
  (hono/logger emits method+path+status only; Prisma `query` logging off in prod).
  Don't add a CDN/log-aggregator/backup target that routes EU data outside the EU.
- **Secrets** are only ever referenced from the direnv/1Password shell, never
  pasted literally or committed; `.pem` files are gitignored; the pre-commit
  gitleaks hook guards commits.
