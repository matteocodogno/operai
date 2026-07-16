# Operai

Internal tool suite by **wellD** — *AI tools built by craftspeople, for craftspeople.*
**EstimAI** (software effort estimation) is the first tool; the suite is composed as a
Module-Federation shell that hosts each tool as a runtime remote.

| Directory | What it is |
|---|---|
| `shell/` | Suite host — shared chrome (header/sidebar/footer) + single session; mounts each tool as a federated remote |
| `estimai-ui/` | EstimAI, as a federated remote |
| `refund-ui/` | Reimbursement tool (federated remote) — expense requests + accounting review/decision (specs/007) |
| `admin-ui/` | Admin tool (federated remote) — roles, departments, users & fine-grained permissions (specs/004); user invitations, resend/revoke & soft-delete (specs/006, admin-only) |
| `notify-ui/` | Notification center (federated remote) — the `/notify` page; reached from the header bell (specs/005) |
| `auth/` | Bun + Hono auth service — OAuth, sessions, RS256 JWT + JWKS, hosted sign-in; + authorization (roles/departments/permissions, admin API, ADR-0007); user invitations + soft-delete + hosted invite landing (specs/006) |
| `estimai-api/` | Estimate-persistence backend (Bun + Hono) |
| `notify-api/` | Notification backend (Bun + Hono) — persistence + SSE push, ticket-authed stream (specs/005, ADR-0008/0009); + email delivery via Resend, internal `/system/emails` (specs/006, ADR-0011); + internal `/system/notifications` for cross-user push (specs/007, ADR-0017) |
| `refund-api/` | Reimbursement backend (Bun + Hono) — authorization-enforcing resource server, EU object storage for receipt attachments (specs/007, ADR-0014/0015/0016) |
| `specs/`, `docs/adr/` | Spec-driven workflow + Architecture Decision Records |
| `infra/` | Deploy config + runbooks (Railway, Vercel) |

See `CLAUDE.md` for the full architecture, conventions, and estimation model, and
`docs/adr/0006-*` for the Module-Federation decision.

## Local development

One-time setup:

1. **Backend secrets (direnv + 1Password)** — the backends load their secrets from their
   own `.envrc`. `mise run dev` loads these with `direnv exec` (it runs non-interactively,
   so direnv's shell hook doesn't fire on its own). So: install **direnv**, run
   `direnv allow auth`, `direnv allow estimai-api`, `direnv allow notify-api`, and
   `direnv allow refund-api`, and be signed in to the **1Password CLI** (`op`). All four
   backends require `AUTH_AUDIENCE` (the same suite-wide value, e.g. `operai-suite`) — the
   `aud` claim `auth` stamps and the resource servers verify (ADR-0010); a mismatch rejects
   every token with 401. Set `ENABLE_TEST_AUTH=true` for a seeded local session, and provide
   real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (with
   `http://localhost:3001/auth/callback/google` as an authorized redirect URI) if you want
   Google login locally. `refund-api` additionally needs `NOTIFY_INTERNAL_TOKEN` (shared
   with `auth`/`notify-api`, see `refund-api/.env.example`) — its object-storage vars
   (`REFUND_S3_*`) are documented but not yet enforced (no bucket provisioned yet).
2. **Apply DB migrations** (brings up Postgres, then migrates all four backends):

   ```bash
   mise run db:migrate
   ```

Then run the whole suite with **one command**:

```bash
mise run dev            # HMR — Postgres + auth + estimai-api + notify-api + refund-api + all 4 frontends
```

`mise run dev` starts everything and reaps every child on Ctrl-C (Postgres is left
running — `docker compose down` to stop it). The shell is the entry point —
open **http://localhost:5173**.

| Service | Port | |
|---|---|---|
| shell (host) | **5173** | ← open this |
| estimai-ui (remote) | 5174 | pinned in `vite.config.ts` (`strictPort`) |
| refund-ui (remote) | 5175 | |
| notify-ui (remote) | 5176 | notification center `/notify` (specs/005) |
| admin-ui (remote) | 5177 | roles & permissions admin (specs/004) |
| auth | 3001 | Bun + Hono |
| estimai-api | 8080 | Bun + Hono |
| notify-api | 8081 | Bun + Hono — SSE push (specs/005) |
| refund-api | 8082 | Bun + Hono — authz-enforcing resource server (specs/007) |
| Postgres | 5435 | `docker compose` (databases: `auth`, `estimai`, `notify`, `refund`) |

Other `mise` tasks:

```bash
mise run dev:web        # frontends only (HMR) — when backends run elsewhere
mise run dev:preview    # full stack, but frontends build+preview (no HMR; mirrors deploy)
mise run db:migrate     # apply auth + estimai-api + notify-api + refund-api migrations
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
