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

Prerequisites (run these first, in their own terminals):

```bash
docker compose up -d          # Postgres 17 on :5435
cd auth && bun run dev        # auth service on :3001
#   → set ENABLE_TEST_AUTH=true in auth/.env for a seeded local session (e2e/manual)
# optional: estimai-api on :8080 — needed for authenticated EstimAI calls to succeed
```

Then run the frontends. Ports are **pinned** in each app's `vite.config.ts`
(`strictPort`): **shell `5173`, estimai-ui `5174`, refund-ui `5175`**. The shell is the
entry point — open **http://localhost:5173**.

Two `mise` tasks start all three at once (Ctrl-C reaps every dev server):

```bash
mise run dev            # HMR — fast iteration (recommended for day-to-day work)
mise run dev:preview    # build + preview — no HMR; deterministic, mirrors the deploy
```

Prefer `mise run dev`. Use `mise run dev:preview` to reproduce a production-like run
(it's the mode the e2e uses).

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
