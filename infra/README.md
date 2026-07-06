# Operai — Railway Infrastructure

This directory contains the Railway deployment configuration for the two Operai
backend services (`auth` and `estimai-api`) plus a shared Postgres instance.

**Data residency:** all services and the database are pinned to `europe-west4`
(Railway EU). This is a hard requirement for regulated-sector clients. Do not
change the region without an ADR and client sign-off.

---

## File overview

| File | Purpose |
|---|---|
| `bootstrap.sh` | Idempotent Railway CLI script — provisions Postgres, creates logical databases, sets variables, deploys both services |
| `variables.md` | Complete per-service variable table (names, placeholders, secrets, sources) |

Per-service Railway config lives next to each service:

| File | Purpose |
|---|---|
| `auth/Dockerfile` | Multi-stage Bun build for the auth service |
| `auth/railway.json` | Railway build + deploy config (region, health check, restart policy, preDeployCommand) |
| `estimai-api/Dockerfile` | Multi-stage Bun build for estimai-api |
| `estimai-api/railway.json` | Railway build + deploy config |

---

## Prerequisites

1. **Railway CLI** — install from https://docs.railway.app/develop/cli
   ```bash
   npm install -g @railway/cli
   railway login
   ```

2. **1Password CLI (`op`)** — for secret export
   ```bash
   brew install 1password-cli
   op signin
   ```

3. A Railway **project** created in the dashboard, pinned to the EU region
   (`europe-west4`). Note the project ID — you will need it below.

---

## First-time deployment

### 1. Login

```bash
railway login
```

### 2. Export secrets from 1Password

All secret values live in the `Operai` vault in 1Password. Export them into
your shell before running bootstrap.sh — the script reads them as env vars and
passes them to Railway via `railway variables --set`. Values are never written
to disk or the repo.

```bash
export BETTER_AUTH_SECRET=$(op read "op://Operai/auth/BETTER_AUTH_SECRET")
export GOOGLE_CLIENT_ID=$(op read "op://Operai/auth/GOOGLE_CLIENT_ID")
export GOOGLE_CLIENT_SECRET=$(op read "op://Operai/auth/GOOGLE_CLIENT_SECRET")
export GITHUB_CLIENT_ID=$(op read "op://Operai/auth/GITHUB_CLIENT_ID")
export GITHUB_CLIENT_SECRET=$(op read "op://Operai/auth/GITHUB_CLIENT_SECRET")
export JWT_PRIVATE_KEY=$(op read "op://Operai/auth/JWT_PRIVATE_KEY")
export JWT_PUBLIC_KEY=$(op read "op://Operai/auth/JWT_PUBLIC_KEY")
```

Generating the JWT keypair for the first time:
```bash
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem
# Store PEM contents in 1Password, then delete the local files:
rm private.pem public.pem
```

### 3. Set the project ID and run bootstrap

```bash
export RAILWAY_PROJECT_ID=<your-railway-project-id>
export UI_ORIGIN=https://app.estimai.io   # your Vercel deployment URL

bash infra/bootstrap.sh
```

The script is idempotent — re-running it is safe. It will skip steps already
completed (e.g. Postgres already provisioned).

### 4. Verify

```bash
railway status --service auth
railway status --service estimai-api

# Once DNS is configured:
curl https://auth.operai.io/health
curl https://api.estimai.operai.io/health
```

---

## How migrations run

Neither service runs `prisma migrate dev` in production. Instead:

- Each `railway.json` sets `preDeployCommand: "bun run db:deploy"`.
- `db:deploy` calls `prisma migrate deploy` — non-interactive, applies only
  pending migrations, never re-runs applied ones, safe for production.
- Migrations run **before** the new version starts, so the DB schema is always
  at least as new as the code.
- Migration files live in `auth/prisma/migrations/` and
  `estimai-api/prisma/migrations/`. Never modify existing migration files.

---

## Rollback

Railway keeps a deployment history per service. To roll back:

1. Open the Railway dashboard → select the service → Deployments tab.
2. Click "Redeploy" on the previous successful deployment.

If the rollback crosses a migration boundary (the previous version does not
understand the current schema), you must manually apply a down-migration or
restore from a Postgres backup before redeploying the older image. Railway does
not automatically reverse migrations.

---

## Updating variables after first deploy

```bash
# Example: rotate the BETTER_AUTH_SECRET
export BETTER_AUTH_SECRET=$(op read "op://Operai/auth/BETTER_AUTH_SECRET")
railway variables --service auth --set "BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}"
railway redeploy --service auth
```

---

## Shared Postgres topology

One Railway Postgres plugin, two logical databases:

```
postgres plugin
├── database: auth      (users, sessions, OAuth, JWKS table — auth service)
└── database: estimai   (estimate documents — estimai-api)
```

Both services use Railway private networking (`.railway.internal`) for
database connections — traffic never leaves the Railway private network.

---

## EU data residency

- Both services and the Postgres instance are deployed to `europe-west4`.
- Request/response bodies are never logged (hono/logger emits method + path +
  status only; Prisma `query` log level is never enabled).
- Estimate content (JSONB) is not included in any log line.
- Do not add a CDN or logging aggregator that would route EU data outside the EU.
