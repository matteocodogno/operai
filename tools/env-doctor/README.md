# env-doctor

Validate the Operai suite's **cross-service** environment contract for a target
environment **before** you deploy — replacing the "deploy → prod 401/503/CORS →
bisect" loop with a red ✗ and a one-line fix.

```bash
mise run env:doctor -- --env production --dir ./resolved
```

`<dir>` holds one `<service>.env` (plain `KEY=VALUE`) per service. With no
`--dir` it reads each `<service>/.env` locally (a quick local sanity check).

## What it checks

Per-service (Layer A): required keys present (the criticals + invariant inputs;
the authoritative per-service schema stays each service's own `src/lib/env.ts`,
run at startup).

Cross-service invariants (Layer B) — the ones no single schema can see:

| Invariant | Bug it catches |
|---|---|
| `AUTH_AUDIENCE` / `NOTIFY_INTERNAL_TOKEN` identical across their services | suite-wide 401 on drift |
| `AUTH_ISSUER` == auth's `BETTER_AUTH_URL` (all resource servers) | token `iss` mismatch |
| Internal URLs (`AUTH_JWKS_URL`, `AUTH_BASE_URL`, `NOTIFY_INTERNAL_URL`) are `http://` + `*.railway.internal` (prod) + port == the **target's** `PORT` | `AUTH_BASE_URL=localhost` → 503; notify `:8081` vs `:8080` |
| Public URLs (`AUTH_ISSUER`, `BETTER_AUTH_URL`, `UI_HOME_URL`, `REFUND_APP_BASE_URL`) are `https://` public — never localhost/`.railway.internal` in prod | the `iss`-internal trap |
| `ALLOWED_ORIGINS` ⊇ every frontend origin the backend serves (CORS) | admin-ui origin missing on refund-api → CORS |

A Railway `${{svc.…}}` reference value is accepted as-is (self-consistent). An
unresolved `op://…` value is a **warning** (resolve it first — see below).

## Producing the resolved `--dir` (prod values)

The doctor validates *resolved* values, so give it real ones. The intended flow
(Phase 2 will script this) uses your existing 1Password `op`:

```bash
# for each service, resolve its op:// reference template into <dir>/<service>.env
op inject -i auth/.env.template -o resolved/auth.env      # etc.
mise run env:doctor -- --env production --dir ./resolved
```

`resolved/` should be gitignored / a scratch dir — it holds real secrets.

## Extending it

Everything lives in `manifest.ts` — the machine-checked contract. Add a shared
var, a CORS requirement, a frontend origin, etc. there; `check.ts` enforces it
and `check.test.ts` proves it. Confirm the `ORIGINS.production` domains
(placeholders marked `null` make the CORS check WARN, not ERROR).

## Roadmap

- **Phase 1 (this):** the checker + manifest + CLI, offline.
- **Phase 2:** auto-resolve values from the `op` templates (one command per env).
- **Phase 3:** live-diff against the Railway/Vercel APIs (catch dashboard drift)
  + a CI gate on PRs / pre-deploy.
