# Operai — Railway Environment Variables

> DATA RESIDENCY: all services deploy to `europe-west4` (EU). No estimate data
> is transmitted outside the EU. Request/response bodies are never logged.

---

## auth service

| Variable | Example / Placeholder | Secret | Source |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://user:pass@postgres.railway.internal:5432/auth` | Yes | Composed by bootstrap.sh from Railway Postgres plugin vars (`PGUSER`/`PGPASSWORD`/`PGHOST`/`PGPORT`) with dbname `auth`. Uses private networking (`.railway.internal`). |
| `BETTER_AUTH_SECRET` | `op://Operai/auth/BETTER_AUTH_SECRET` | **Yes** | 1Password item `Operai/auth`. Must be ≥ 32 random characters. |
| `BETTER_AUTH_URL` | `https://auth.operai.io` | No | Public URL of the auth service itself. Sets the JWT `iss` claim — must match `AUTH_ISSUER` in estimai-api. Never use the Railway-internal hostname here. |
| `GOOGLE_CLIENT_ID` | `op://Operai/auth/GOOGLE_CLIENT_ID` | **Yes** | 1Password item `Operai/auth`. From Google Cloud Console → APIs & Credentials. |
| `GOOGLE_CLIENT_SECRET` | `op://Operai/auth/GOOGLE_CLIENT_SECRET` | **Yes** | 1Password item `Operai/auth`. |
| `GITHUB_CLIENT_ID` | `op://Operai/auth/GITHUB_CLIENT_ID` | **Yes** | 1Password item `Operai/auth`. From GitHub → Settings → Developer Applications. |
| `GITHUB_CLIENT_SECRET` | `op://Operai/auth/GITHUB_CLIENT_SECRET` | **Yes** | 1Password item `Operai/auth`. |
| `JWT_PRIVATE_KEY` | `op://Operai/auth/JWT_PRIVATE_KEY` | **Yes** | 1Password item `Operai/auth`. RS256 private key PEM content (newlines as `\n`). Generated with `openssl genrsa -out private.pem 2048`. The `.pem` files are gitignored — never commit them. |
| `JWT_PUBLIC_KEY` | `op://Operai/auth/JWT_PUBLIC_KEY` | **Yes** | 1Password item `Operai/auth`. RS256 public key PEM. Generated with `openssl rsa -in private.pem -pubout -out public.pem`. Exposed via `GET /.well-known/jwks.json` (static env-var key, distinct from better-auth's DB keypair). |
| `ALLOWED_ORIGINS` | `https://app.estimai.io` | No | Comma-separated list of trusted UI origins. Feeds both Hono CORS and better-auth `trustedOrigins`. No wildcards. **Do NOT set `BETTER_AUTH_TRUSTED_ORIGINS`** — it bypasses the validated allowlist. |
| `UI_HOME_URL` | `https://app.estimai.io` | No | Post-login redirect fallback. Must be a URL whose origin is in `ALLOWED_ORIGINS`. |
| `PORT` | `3001` | No | Server listen port. Railway overrides this; keep `3001` as the default. |
| `NODE_ENV` | `production` | No | Must be `production` in Railway. |
| `ENABLE_TEST_AUTH` | _(absent)_ | — | **MUST REMAIN UNSET IN PRODUCTION.** When set to `true`, a session-mint endpoint (`POST /test-auth/session`) is exposed with no authentication — a complete auth bypass. Only set in local dev and CI. Bootstrap.sh explicitly omits this variable. |

---

## estimai-api service

| Variable | Example / Placeholder | Secret | Source |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://user:pass@postgres.railway.internal:5432/estimai` | Yes | Composed by bootstrap.sh from Railway Postgres plugin vars with dbname `estimai`. Uses private networking (`.railway.internal`). |
| `ALLOWED_ORIGINS` | `https://app.estimai.io` | No | Same as auth service — comma-separated trusted UI origins. No wildcards. |
| `AUTH_ISSUER` | `https://auth.operai.io` | No | Cross-service reference: must equal the auth service's `BETTER_AUTH_URL` exactly (this is the JWT `iss` claim). |
| `AUTH_JWKS_URL` | `https://auth.operai.io/auth/jwks` | No | Cross-service reference: better-auth's built-in JWKS endpoint (DB keypair, rotating `kid`). **Use `/auth/jwks`, NOT `/.well-known/jwks.json`** — the latter serves the static env-var key (different keypair from the one that signs `/auth/token` JWTs). |
| `PORT` | `8080` | No | Server listen port. |
| `NODE_ENV` | `production` | No | Must be `production` in Railway. |
| `MAX_ESTIMATE_BYTES` | `1048576` | No | Per-estimate content size cap in bytes. Default: 1 MiB (1048576). Optional — omit to use the default. |
| `MAX_IMPORT_REQUEST_BYTES` | `33554432` | No | Bulk-import raw body limit in bytes. Default: `min(MAX_ESTIMATE_BYTES × 200 + 64 KiB, 32 MiB)`. Optional — omit to use the default. |

---

## Cross-service wiring

```
auth BETTER_AUTH_URL      ──►  estimai-api AUTH_ISSUER
                                (JWT 'iss' claim — must match exactly)

auth public URL + /auth/jwks  ──►  estimai-api AUTH_JWKS_URL
                                (better-auth DB keypair; NOT /.well-known/jwks.json)

Vercel UI origin          ──►  auth ALLOWED_ORIGINS + UI_HOME_URL
                                estimai-api ALLOWED_ORIGINS
```

## Shared Postgres topology

One Railway Postgres plugin instance, two logical databases:

| Database | Used by | `DATABASE_URL` dbname |
|---|---|---|
| `auth` | auth service | `.../auth` |
| `estimai` | estimai-api | `.../estimai` |

Bootstrap.sh creates both databases idempotently before deploying the services.
Each service's `preDeployCommand` runs `bun run db:deploy` (`prisma migrate deploy`)
against its own database — non-interactive, production-safe, never re-runs
applied migrations.

## Security notes

- `ENABLE_TEST_AUTH` must remain **unset** in the Railway production environment.
  The service code enforces this (`NODE_ENV=production` blocks the endpoint even
  if the var were somehow set), but defence-in-depth means never setting it.
- `BETTER_AUTH_TRUSTED_ORIGINS` must remain **unset**. better-auth appends that
  env var to its trusted list at runtime, bypassing the `ALLOWED_ORIGINS`
  validated allowlist. Origin trust is controlled solely through `ALLOWED_ORIGINS`.
- JWT PEM keys are injected as Railway variables from 1Password at bootstrap time.
  The repo carries only `.env.example` placeholders. `.pem` files are gitignored.
