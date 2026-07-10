# Operai

Internal tool suite by **wellD** — *AI tools built by craftspeople, for craftspeople.*
**EstimAI** (software effort estimation) is the first tool; the suite is composed as a
Module-Federation shell that hosts each tool as a runtime remote.

| Directory | What it is |
|---|---|
| `shell/` | Suite host — shared chrome (header/sidebar/footer) + single session; mounts each tool as a federated remote |
| `estimai-ui/` | EstimAI, as a federated remote |
| `refund-ui/` | Reimbursement tool (placeholder remote; domain lands in a later spec) |
| `auth/` | Bun + Hono auth service — OAuth, sessions, RS256 JWT + JWKS, hosted sign-in |
| `estimai-api/` | Estimate-persistence backend (Bun + Hono) |
| `specs/`, `docs/adr/` | Spec-driven workflow + Architecture Decision Records |
| `infra/` | Deploy config + runbooks (Railway, Vercel) |

See `CLAUDE.md` for the full architecture, conventions, and estimation model, and
`docs/adr/0006-*` for the Module-Federation decision.

## Local development

One-time setup:

1. **Backend secrets (direnv + 1Password)** — the backends load their secrets from their
   own `.envrc`. `mise run dev` loads these with `direnv exec` (it runs non-interactively,
   so direnv's shell hook doesn't fire on its own). So: install **direnv**, run
   `direnv allow auth` and `direnv allow estimai-api`, and be signed in to the **1Password
   CLI** (`op`). Set `ENABLE_TEST_AUTH=true` for a seeded local session, and provide real
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (with `http://localhost:3001/auth/callback/google`
   as an authorized redirect URI) if you want Google login locally.
2. **Apply DB migrations** (brings up Postgres, then migrates both backends):

   ```bash
   mise run db:migrate
   ```

Then run the whole suite with **one command**:

```bash
mise run dev            # HMR — Postgres + auth + estimai-api + all 3 frontends
```

`mise run dev` starts everything and reaps every child on Ctrl-C (Postgres is left
running — `docker compose down` to stop it). The shell is the entry point —
open **http://localhost:5173**.

| Service | Port | |
|---|---|---|
| shell (host) | **5173** | ← open this |
| estimai-ui (remote) | 5174 | pinned in `vite.config.ts` (`strictPort`) |
| refund-ui (remote) | 5175 | |
| auth | 3001 | Bun + Hono |
| estimai-api | 8080 | Bun + Hono |
| Postgres | 5435 | `docker compose` |

Other `mise` tasks:

```bash
mise run dev:web        # frontends only (HMR) — when backends run elsewhere
mise run dev:preview    # full stack, but frontends build+preview (no HMR; mirrors deploy)
mise run db:migrate     # apply auth + estimai-api migrations
```

Use `mise run dev:preview` to reproduce a production-like run (it's the mode the e2e uses).

### HMR notes (Module Federation)

All-dev Module Federation works: the shell mounts the remotes, the shared React
singleton is negotiated correctly (no duplicate-React / "Invalid hook call"), and editing
a remote hot-updates it inside the shell. One quirk to know:

- Editing a remote's **MF-exposed root** (`estimai-ui`/`refund-ui` `src/App.tsx`) triggers
  a **full page reload** instead of state-preserving React Fast Refresh — the federation
  plugin's wrapper export is incompatible with Fast Refresh's consistent-exports rule.
  Edits **deeper** in a remote's component tree Fast-Refresh normally.
- A remote is **not** independently runnable for authed flows on its own (it imports
  `shell/session` from the shell) — always run it through the shell.

### Per-app commands (reference)

Each app also has the usual scripts (run from its directory or with `pnpm --dir <app>`):

```bash
pnpm --dir shell dev            # or build / preview / test / lint / e2e
pnpm --dir estimai-ui test
pnpm --dir refund-ui build
```

The cross-app end-to-end suite lives in `shell/e2e/` (`pnpm --dir shell e2e`) and drives
the real assembled suite with a seeded session — it uses **build + preview** (not `dev`)
for determinism; see `shell/playwright.config.ts`.

## Working on the codebase

Operai follows the WellForge **spec-driven** workflow — features go
`specs/NNN-slug/` `spec.md` → `plan.md` → (`design.md`) → `tasks.md` → implement → eval →
done. See `specs/README.md`.
