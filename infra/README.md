# Operai — Railway Deployment Runbook

Step-by-step manual guide to deploy the two backend services — **`auth`** and
**`estimai-api`** — plus a shared Postgres, to Railway.

The frontend (`estimai-ui`) is **already deployed on Vercel** at
**https://operai.welld.io/** — it is not covered here except for the one step
that points it at these new backends (Step 7).

**Data residency:** all services and the database are pinned to `europe-west4`
(Railway EU). Hard requirement for regulated-sector clients — do not change the
region without an ADR and client sign-off.

---

## Topology

```
Vercel                         Railway project (europe-west4)
┌──────────────────┐           ┌────────────────────────────────────────┐
│ estimai-ui       │  HTTPS    │  auth service ──┐                       │
│ operai.welld.io  │ ────────► │                 ├─► Postgres (shared)   │
│                  │           │  estimai-api ───┤     ├── db: auth      │
└──────────────────┘           │                 │     └── db: estimai   │
                               │  estimai-api ──► auth /auth/jwks (JWT)  │
                               └────────────────────────────────────────┘
```

One Postgres instance, two logical databases (`auth`, `estimai`). Service-to-DB
traffic uses Railway private networking (`*.railway.internal`) and never leaves
the private network.

---

## How secrets are handled (direnv + 1Password)

This repo uses **direnv** + the **1Password CLI**. The `.envrc` files read secrets
from 1Password into `.env.cached` and export them into your shell automatically:

- **repo root `.envrc`** → `RAILWAY_PROJECT_ID`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- **`auth/.envrc`** → `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`,
  `GITHUB_CLIENT_ID`/`_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` (plus the Postgres creds)

So the auth secrets are already in your shell **once you `cd` into `auth/`** with
direnv allowed. You never paste secret values into commands — you reference the
exported shell variables (`$BETTER_AUTH_SECRET`, …). Nothing secret is ever written
to the repo. See `infra/variables.md` for the full variable → 1Password-item map.

> The **Postgres credentials for Railway are NOT the 1Password `OperAI DB` ones** —
> those are for local `docker compose`. On Railway the managed Postgres generates its
> own credentials; you reference them with Railway's `${{Postgres.*}}` variables
> (Steps 3–4). The 1Password DB creds are irrelevant to this deployment.

---

## Prerequisites

1. **Railway CLI** logged in:
   ```bash
   npm install -g @railway/cli    # if not installed
   railway login
   ```
2. **direnv + 1Password** already working locally (you run the app with them). Sanity check
   from the repo root — this must print `set` without printing the value:
   ```bash
   echo "RAILWAY_PROJECT_ID is ${RAILWAY_PROJECT_ID:+set}"
   ```
   If it prints nothing, run `direnv allow` and `op signin` first.

---

## Step 1 — Link the Railway project

The project already exists (its id is in 1Password, loaded as `$RAILWAY_PROJECT_ID`).
Link your local checkout to it:

```bash
# from the repo root
railway link "$RAILWAY_PROJECT_ID"
```

Confirm:
```bash
railway status
```

---

## Step 2 — Provision the shared Postgres (EU)

1. **Railway dashboard → your project → New → Database → PostgreSQL.**
2. Open the new database → **Settings → check the region is `europe-west4`.** If the
   project/environment default is a non-EU region, set the region **before** adding data
   (moving a populated DB region is disruptive).
3. Create the two logical databases. Open a psql shell against the instance:
   ```bash
   railway connect Postgres      # opens psql on the Postgres service
   ```
   Then, at the `psql` prompt:
   ```sql
   CREATE DATABASE auth;
   CREATE DATABASE estimai;
   \l                            -- verify both are listed
   \q
   ```
   > These must exist **before** the services first deploy — each service's
   > `preDeployCommand` runs `prisma migrate deploy` against its own database, which
   > fails if the database is missing.

---

## Step 3 — Deploy the `auth` service

1. **Dashboard → New → GitHub Repo →** select this monorepo.
2. Open the new service → **Settings → Source → Root Directory = `auth`.** Railway then
   reads `auth/railway.json` (Dockerfile build, EU region, `/health` check,
   `preDeployCommand: bun run db:deploy`) automatically.
3. **Set the variables.** Run this **from inside `auth/`** so direnv has exported the
   secrets. `${{...}}` is Railway reference syntax — keep the **single quotes** so your
   shell does not expand it:
   ```bash
   cd auth        # direnv loads BETTER_AUTH_SECRET, GOOGLE_*, GITHUB_*, JWT_* here

   railway variables --service auth \
     --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/auth' \
     --set "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET" \
     --set "GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID" \
     --set "GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET" \
     --set "GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID" \
     --set "GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET" \
     --set "JWT_PRIVATE_KEY=$JWT_PRIVATE_KEY" \
     --set "JWT_PUBLIC_KEY=$JWT_PUBLIC_KEY" \
     --set "ALLOWED_ORIGINS=https://operai.welld.io" \
     --set "UI_HOME_URL=https://operai.welld.io/" \
     --set "NODE_ENV=production"
   ```
   `BETTER_AUTH_URL` is set in Step 5 (it needs the public URL from the next sub-step).
   **Do NOT set `ENABLE_TEST_AUTH`** (auth-bypass endpoint) or `BETTER_AUTH_TRUSTED_ORIGINS`
   (bypasses the validated origin allowlist), or `PORT` (Railway injects it).
4. **Generate a public domain:** service → **Settings → Networking → Generate Domain**
   (or add a custom domain such as `auth.operai.welld.io`). **Note this URL** — call it
   `<AUTH_URL>` below.

---

## Step 4 — Deploy the `estimai-api` service

1. **Dashboard → New → GitHub Repo →** same monorepo; **Root Directory = `estimai-api`.**
   It reads `estimai-api/railway.json` automatically.
2. **Set the variables** (`estimai-api` has no repo secrets of its own beyond the DB URL;
   `<AUTH_URL>` is from Step 3):
   ```bash
   railway variables --service estimai-api \
     --set 'DATABASE_URL=postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/estimai' \
     --set "ALLOWED_ORIGINS=https://operai.welld.io" \
     --set "AUTH_ISSUER=<AUTH_URL>" \
     --set "AUTH_JWKS_URL=<AUTH_URL>/auth/jwks" \
     --set "NODE_ENV=production"
   ```
   `MAX_ESTIMATE_BYTES` / `MAX_IMPORT_REQUEST_BYTES` are optional (sane defaults — 1 MiB).
3. **Generate a public domain** (or custom domain e.g. `api.operai.welld.io`). Note it as
   `<API_URL>`.

> **Postgres service name:** the `${{Postgres.*}}` references assume the database service
> is named `Postgres` (Railway's default). If you renamed it, substitute the actual name.

---

## Step 5 — Cross-wire the two services

Now both public URLs exist. The JWT `iss` claim must match exactly, so:

```bash
# auth must know its own public URL (this becomes the JWT issuer)
railway variables --service auth --set "BETTER_AUTH_URL=<AUTH_URL>"
```

Confirm the wiring is consistent:
- `auth.BETTER_AUTH_URL` **==** `estimai-api.AUTH_ISSUER`  (both `<AUTH_URL>`)
- `estimai-api.AUTH_JWKS_URL` **==** `<AUTH_URL>/auth/jwks`
  (better-auth's rotating DB keypair — **NOT** `/.well-known/jwks.json`, which serves a
  different static key and will fail verification)

Redeploy both services so the new variables take effect:
```bash
railway redeploy --service auth
railway redeploy --service estimai-api
```

---

## Step 6 — Register the OAuth redirect URIs

better-auth mounts at `basePath: /auth`, so the social callback URLs are:

- **Google** — Google Cloud Console → your OAuth client → *Authorized redirect URIs*:
  `<AUTH_URL>/auth/callback/google`
- **GitHub** — GitHub → Developer settings → your OAuth App → *Authorization callback URL*:
  `<AUTH_URL>/auth/callback/github`

(The OAuth **client id/secret** themselves are already set from 1Password in Step 3;
this step only registers the redirect URL on the provider side.)

---

## Step 7 — Point the Vercel UI at the deployed backends

The UI reads its backend URLs at **build time** from Vite env vars, so they must be set in
Vercel **and the UI redeployed** — a running build will not pick them up otherwise.

In the Vercel project for `estimai-ui` → **Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `VITE_AUTH_URL` | `<AUTH_URL>` |
| `VITE_API_URL` | `<API_URL>` |

Then **redeploy** the Vercel project. Also confirm `<AUTH_URL>` and `<API_URL>` are present
in each service's `ALLOWED_ORIGINS` reasoning: the UI origin `https://operai.welld.io` is
already set on both services (Steps 3–4), which is what CORS + better-auth `trustedOrigins`
check — no change needed there.

---

## Step 8 — Verify end-to-end

```bash
# Health checks (Railway also gates deploys on /health)
curl -fsS <AUTH_URL>/health && echo " auth OK"
curl -fsS <API_URL>/health  && echo " api OK"

# JWKS reachable (estimai-api verifies tokens against this)
curl -fsS <AUTH_URL>/auth/jwks | head -c 200; echo
```

Then in a browser at **https://operai.welld.io/**:
1. Visit a guarded route → you are redirected to `<AUTH_URL>/sign-in`.
2. Sign in with Google and with GitHub → you land back on the UI.
3. Create an estimate, reload → it persisted (estimai-api + `estimai` DB).
4. Sign out → session terminates (no 403).

---

## How migrations run

- Each `railway.json` sets `preDeployCommand: "bun run db:deploy"`.
- `db:deploy` runs `prisma migrate deploy` — non-interactive, applies only pending
  migrations, never re-runs applied ones, production-safe.
- Migrations run **before** the new version starts, so the schema is always at least as
  new as the code. Migration files live in `auth/prisma/migrations/` and
  `estimai-api/prisma/migrations/` — never modify an existing migration file.

---

## Rollback

Railway keeps a per-service deployment history: **service → Deployments → Redeploy** on the
last good deployment. If the rollback crosses a migration boundary (older code cannot read
the newer schema), restore the Postgres from a backup or apply a down-migration **before**
redeploying the older image — Railway does not reverse migrations automatically.

---

## Updating a variable later

```bash
cd auth        # if the value comes from a direnv-loaded secret
railway variables --service auth --set "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET"
railway redeploy --service auth
```

---

## Optional: scripted bootstrap

`infra/bootstrap.sh` automates the variable-setting and deploy triggers (it cannot create
the Railway services or the logical databases — do Steps 2–3's service/DB creation in the
dashboard first). The manual steps above are the source of truth; the script is a
convenience wrapper for repeat runs.

---

## EU data residency

- Both services and the Postgres instance run in `europe-west4`.
- Request/response **bodies are never logged** (hono/logger emits method + path + status
  only; Prisma `query` log level is never enabled). Estimate JSONB never appears in a log line.
- Do not add a CDN, log aggregator, or backup target that would route EU data outside the EU.
