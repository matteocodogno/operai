# Operai — Railway Environment Variables

> DATA RESIDENCY: all services deploy to `europe-west4` (EU). No estimate data
> is transmitted outside the EU. Request/response bodies are never logged.

---

## auth service

| Variable | Example / Placeholder | Secret | Source |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/auth` | Yes | Railway reference vars from the shared Postgres service, dbname `auth`. Private networking (`*.railway.internal`). NOT the 1Password `OperAI DB` creds (those are for local compose). |
| `BETTER_AUTH_SECRET` | _(from shell)_ | **Yes** | 1Password → `Employee / Paperclip - BETTER_AUTH_SECRET` (password). Exported by `auth/.envrc` as `$BETTER_AUTH_SECRET`. Must be ≥ 32 chars. |
| `BETTER_AUTH_URL` | `<AUTH_URL>` (e.g. `https://auth.operai.welld.io`) | No | Public URL of the auth service itself. Sets the JWT `iss` claim — must match `AUTH_ISSUER` in estimai-api. Never use the Railway-internal hostname here. |
| `GOOGLE_CLIENT_ID` | _(from shell)_ | **Yes** | 1Password → `AIScream / OperAI - GOOGLE OAuth` (Client ID). Exported by `auth/.envrc` as `$GOOGLE_CLIENT_ID`. |
| `GOOGLE_CLIENT_SECRET` | _(from shell)_ | **Yes** | 1Password → `AIScream / OperAI - GOOGLE OAuth` (Client Secret). `$GOOGLE_CLIENT_SECRET`. |
| `GITHUB_CLIENT_ID` | _(from shell)_ | **Yes** | 1Password → `AIScream / OperAI - GITHUB OAuth` (Client ID). `$GITHUB_CLIENT_ID`. |
| `GITHUB_CLIENT_SECRET` | _(from shell)_ | **Yes** | 1Password → `AIScream / OperAI - GITHUB OAuth` (Client Secret). `$GITHUB_CLIENT_SECRET`. |
| `JWT_PRIVATE_KEY` | _(from shell)_ | **Yes** | 1Password → `AIScream / OperAI Private Key` (private key). `$JWT_PRIVATE_KEY`. RS256 private key PEM. `.pem` files are gitignored — never commit them. |
| `JWT_PUBLIC_KEY` | _(from shell)_ | **Yes** | 1Password → `AIScream / OperAI Private Key` (public key). `$JWT_PUBLIC_KEY`. RS256 public key PEM. |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` | No | Comma-separated list of trusted UI origins (the Vercel deployment). Feeds both Hono CORS and better-auth `trustedOrigins`. No wildcards, no trailing slash. **Do NOT set `BETTER_AUTH_TRUSTED_ORIGINS`** — it bypasses the validated allowlist. |
| `UI_HOME_URL` | `https://operai.welld.io/` | No | Post-login redirect fallback. Must be a URL whose origin is in `ALLOWED_ORIGINS`. |
| `PORT` | _(unset — Railway injects it)_ | No | Server listen port. Railway sets `$PORT` automatically; do not set it. Code default is 3001 for local dev. |
| `NODE_ENV` | `production` | No | Must be `production` in Railway. |
| `ENABLE_TEST_AUTH` | _(absent)_ | — | **MUST REMAIN UNSET IN PRODUCTION.** When set to `true`, a session-mint endpoint (`POST /test-auth/session`) is exposed with no authentication — a complete auth bypass. Only set in local dev and CI. Bootstrap.sh explicitly omits this variable. |

---

## estimai-api service

| Variable | Example / Placeholder | Secret | Source |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/estimai` | Yes | Railway reference vars from the shared Postgres service, dbname `estimai`. Private networking. |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` | No | Same as auth service — the Vercel UI origin. No wildcards, no trailing slash. |
| `AUTH_ISSUER` | `<AUTH_URL>` | No | Cross-service reference: must equal the auth service's `BETTER_AUTH_URL` exactly (this is the JWT `iss` claim). |
| `AUTH_JWKS_URL` | `<AUTH_URL>/auth/jwks` | No | Cross-service reference: better-auth's built-in JWKS endpoint (DB keypair, rotating `kid`). **Use `/auth/jwks`, NOT `/.well-known/jwks.json`** — the latter serves the static env-var key (different keypair from the one that signs `/auth/token` JWTs). |
| `PORT` | _(unset — Railway injects it)_ | No | Server listen port. Railway sets `$PORT`; do not set it. Code default is 8080 for local dev. |
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

Create both databases before the first deploy (Step 2 of `README.md`). Each service's
`preDeployCommand` runs `bun run db:deploy` (`prisma migrate deploy`) against its own
database — non-interactive, production-safe, never re-runs applied migrations.

## Security notes

- `ENABLE_TEST_AUTH` must remain **unset** in the Railway production environment.
  The service code enforces this (`NODE_ENV=production` blocks the endpoint even
  if the var were somehow set), but defence-in-depth means never setting it.
- `BETTER_AUTH_TRUSTED_ORIGINS` must remain **unset**. better-auth appends that
  env var to its trusted list at runtime, bypassing the `ALLOWED_ORIGINS`
  validated allowlist. Origin trust is controlled solely through `ALLOWED_ORIGINS`.
- Secret values (JWT PEM keys, OAuth secrets, `BETTER_AUTH_SECRET`) are exported into
  your shell by `auth/.envrc` (direnv → 1Password) and set on Railway by referencing the
  shell variables — never pasted literally, never written to the repo. The repo carries
  only `.env.example` placeholders. `.pem` files are gitignored.
