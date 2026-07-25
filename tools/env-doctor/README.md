# env-doctor

Validate the Operai suite's **cross-service** environment contract for a target
environment **before** you deploy — replacing the "deploy → prod 401/503/CORS →
bisect" loop with a red ✗ and a one-line fix.

```bash
mise run env:doctor -- --env production            # check the committed templates (offline, CI-safe)
mise run env:doctor -- --env production --resolve  # also resolve ${OP:…} secrets via `op inject`
```

## Where values come from (source precedence)

1. **`--dir <path>`** — one pre-resolved `<service>.env` (plain `KEY=VALUE`) per
   service. You produce them however you like; the doctor just checks them.
2. **`templates/<env>/`** — committed per-environment templates (**the default**,
   no flag needed). This is Phase 2: one command, nothing to hand-assemble.
3. **`<service>/.env`** — each service's own local file, when neither of the
   above is present (a quick local sanity check).

## The templates (`templates/production/*.env`)

Each template is the exact env you set on that service, and doubles as the source
of truth behind `infra/README.md § Variable reference`. Four value shapes, each
checked differently:

| Shape | Example | How the doctor treats it |
|---|---|---|
| **literal** (public identity / browser-facing URL) | `AUTH_ISSUER=https://auth.operai.welld.io` | fully CHECKED (https, public, consistent, CORS) |
| **`${{railway.ref}}`** (internal DNS / shared var) | `AUTH_JWKS_URL=http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks` | shape-checked; value deferred (Railway resolves it, drift-proof) |
| **`${OP:vault/item/field}`** (1Password secret) | `BETTER_AUTH_SECRET=${OP:Employee/Paperclip - BETTER_AUTH_SECRET/password}` | left verbatim offline; `--resolve` expands it via `op inject` |
| **`${{shared.X}}`** (suite-wide constant/secret) | `AUTH_AUDIENCE=${{shared.AUTH_AUDIENCE}}` | identity is drift-proof by construction; a stray literal alongside it WARNs |

The `${OP:…}` spelling is deliberately **not** a literal `op://…`, so committed
template files never trip gitleaks' 1password-reference rule. `--resolve` rewrites
`${OP:…}` → `op://…` and pipes the template through `op inject`, capturing the
resolved values on **stdout** — secrets are never written to disk.

**Offline (default) is still a real check:** every literal (URLs, origins,
audience, issuer, CORS) is validated, and identical `${{shared.X}}` / `${OP:…}`
strings across services still prove the shared var references the same thing.
`--resolve` adds one guarantee on top: the 1Password items actually **exist** and
are non-empty (catches a typo'd vault path / an unpopulated prod vault).

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

A Railway `${{svc.…}}` reference is accepted as self-consistent (Railway resolves
it, so it can't drift). A secret reference (`op://…`/`${OP:…}`) that survives a
run you asked to be **resolved** (`--dir`, or `--resolve`) is a **warning**.

## Extending it

Everything lives in `manifest.ts` — the machine-checked contract. Add a shared
var, a CORS requirement, a frontend origin, etc. there; `check.ts` enforces it,
`check.test.ts` proves it, and `resolve.test.ts` re-runs the shipped templates
through the doctor so a bad template edit fails offline. Confirm the
`ORIGINS.production` domains (placeholders marked `null` make that CORS check
WARN, not ERROR).

## Files

| File | Role |
|---|---|
| `manifest.ts` | the contract (shared/internal/public vars, CORS, origins, ref predicates) |
| `check.ts` | pure checker over a resolved suite → findings |
| `resolve.ts` | Phase 2 — load `templates/<env>/`, optional in-memory `op inject` |
| `parse.ts` | shared `KEY=VALUE` parser |
| `index.ts` | CLI (source selection, `--resolve`, colored output) |
| `templates/<env>/*.env` | the committed per-env contract |
| `*.test.ts` | `bun test tools/env-doctor/` |

## Roadmap

- **Phase 1 (done):** the checker + manifest + CLI, offline.
- **Phase 2 (done):** committed per-env templates + one-command run, resolving
  `${OP:…}` secrets through `op inject` in memory (`--resolve`).
- **Phase 3:** live-diff against the Railway/Vercel APIs (catch dashboard drift —
  the one thing a template can't, since it trusts the file mirrors reality) + a
  CI gate on PRs / pre-deploy.
