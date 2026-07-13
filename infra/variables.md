# Operai — Deployment Environment Variables

Single environment-variable reference for the whole suite across **both** platforms:
the **Railway** backend services (`auth`, `estimai-api`) and the **Vercel** frontend
projects (`shell`, `estimai-ui`, `refund-ui`, `admin-ui`). Deploy procedures: `infra/README.md`
(Railway) and `infra/vercel-deploy-runbook.md` (Vercel).

> DATA RESIDENCY: all **backend** services + Postgres deploy to `europe-west4` (EU).
> No estimate data is transmitted outside the EU. Request/response bodies are never
> logged. The Vercel frontends are static client bundles — they store/transmit no
> estimate data except the authenticated calls the browser makes to the EU backends.

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
| `BOOTSTRAP_ADMIN_EMAIL` | _(from shell)_ | No | specs/004-auth-roles-permissions (AC-6.1). The email of the account that receives the `admin` system role on first `databaseHooks.user.create.after` (in addition to the `employee` role every new user gets, AC-6.3). Not a secret itself, but set it on the Railway `auth` service, not committed — a value baked into the repo would let anyone matching it self-escalate. The env var itself is only **validated** (`auth/src/lib/env.ts` Zod schema) and **consumed** by the seed/bootstrap hook as of T11 (specs/004-auth-roles-permissions/tasks.md); this row documents the deploy-side variable ahead of that code landing. |

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

## Frontend build-time variables (Vercel)

Set per Vercel project → **Settings → Environment Variables** (set for **both**
Production and Preview — preview remotes usually don't share the production hostnames).
**All are read at BUILD time**, so a value change requires a **redeploy** of that project.

Two kinds, distinguished by prefix:
- **`VITE_*`** — client-side (`import.meta.env`), compiled into the browser bundle.
- **unprefixed** (`*_REMOTE_URL`) — read in each app's `vite.config.ts` via `process.env`
  (Node-side Vite config, the federation plugin), **not** shipped to the client.

### `shell` project (the host / entry point)

| Variable | Example / Placeholder | Secret | Source |
|---|---|---|---|
| `VITE_AUTH_URL` | `<AUTH_URL>` (e.g. `https://auth.operai.welld.io`) | No | auth service URL. Drives the `_authed` guard's hosted-sign-in redirect and `shell/session`'s JWT fetch/refresh + trusted-origin allowlist. Same value as auth `BETTER_AUTH_URL`. |
| `VITE_API_URL` | `<API_URL>` (e.g. `https://estimai-api.operai.welld.io`) | No | estimai-api URL. `shell/session` attaches the Bearer JWT **only** to this origin (or `VITE_AUTH_URL`, or same-origin). |
| `ESTIMAI_REMOTE_URL` | `https://estimai.operai.welld.io/remoteEntry.js` | No | Build-time default for the EstimAI remote, baked into the shell bundle. Overridable at runtime by `shell/public/runtime-config.json` without a rebuild (AC-5.3 — see Vercel runbook Step 5). Unprefixed (Vite-config-side). |
| `REFUND_REMOTE_URL` | `https://refund.operai.welld.io/remoteEntry.js` | No | Same as above, for the Refund remote. |
| `ADMIN_REMOTE_URL` | `https://admin.operai.welld.io/remoteEntry.js` | No | specs/004-auth-roles-permissions — build-time default for the new Admin (Roles & Permissions) remote, baked into the shell bundle by `shell/vite.config.ts` (T25). Same runtime-override mechanism as the two above (`shell/src/lib/runtimeRemotes.ts`). Dev default: `http://localhost:5177/remoteEntry.js`. |

### `estimai-ui` project (remote)

| Variable | Example / Placeholder | Secret | Source |
|---|---|---|---|
| `VITE_API_URL` | same as shell's (`https://estimai-api.operai.welld.io`) | No | **REQUIRED in production.** estimai-ui's `src/lib/estimatesApi.ts` builds the request URL `${VITE_API_URL}/estimates` from **its own** baked value — this decides **where** EstimAI's data calls go. Must equal the shell's `VITE_API_URL` (the shell decides *whether* to attach the JWT to that origin; this decides the *origin*). Diverge and requests hit the wrong origin (or, if unset, `undefined/estimates`). Redeploy after setting. |
| `VITE_AUTH_URL` | same as shell's | No | **Standalone-only.** No production effect on the remote — auth/session is owned entirely by the shell (`shell/session`); estimai-ui's own `authClient.ts` is not imported by its prod code. Only the dev/test standalone bootstrap (`src/main.tsx`) reads it. |
| `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` | No | **REQUIRED in production** (build-time, baked into the estimai-ui bundle by `vite.config.ts`). When estimai-ui is mounted inside the shell, its code imports `shell/session` / `shell/tokens.css` from **this** `remoteEntry.js` — so it must point at the shell's origin. **If unset, the build bakes the dev default `http://localhost:5173/remoteEntry.js`**, which the shell's CSP blocks at runtime → `shell/session` fails to load → `[RemoteMount] failed to load remote module "EstimAI"`. Unprefixed (Vite-config-side, read via `process.env`). Set it and **redeploy** the estimai-ui project. |

### `refund-ui` project (remote)

| Variable | Example / Placeholder | Secret | Source |
|---|---|---|---|
| `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` | No | **REQUIRED in production** — same as estimai-ui's `SHELL_REMOTE_URL` above (refund-ui imports `shell/session` / `shell/tokens.css` from the shell when mounted). Unset ⇒ dev-default `localhost:5173` baked ⇒ CSP-blocked ⇒ Refund fails to mount. refund-ui has **no** backend vars of its own today (no direct `auth`/`estimai-api` calls — it delegates to `shell/session`). |

### `admin-ui` project (remote)

| Variable | Example / Placeholder | Secret | Source |
|---|---|---|---|
| `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` | No | **REQUIRED in production** — same pattern as estimai-ui's/refund-ui's `SHELL_REMOTE_URL` (admin-ui imports `shell/session` / `shell/tokens.css` from the shell when mounted; T13, specs/004-auth-roles-permissions). Unset ⇒ dev-default `http://localhost:5173/remoteEntry.js` baked ⇒ CSP-blocked ⇒ Admin fails to mount. Documented in `admin-ui/.env.example`. |

admin-ui has, like refund-ui, **no backend vars of its own** — it has no direct `auth`
calls; the Admin API calls the admin-ui client makes go through the shared
`shell/session` `apiFetch` (same delegation as estimai-ui/refund-ui), so they run under
the shell's own origin and are governed by the shell's `VITE_AUTH_URL`/`VITE_API_URL`
above, not by anything set on the `admin-ui` Vercel project.

> The frontends' **production origin** (`https://operai.welld.io`, the shell) is what the
> backends' `ALLOWED_ORIGINS`/`UI_HOME_URL` must contain — see the Cross-service wiring
> below. Only the shell's origin is needed there: `estimai-ui`/`refund-ui`/`admin-ui`
> never call the backends directly in production (federated modules execute inside the
> shell's document, so `shell/session` runs under the shell's origin regardless of which
> remote is mounted).

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
