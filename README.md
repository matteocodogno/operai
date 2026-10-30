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
| `inventory-ui/` | Hardware inventory (federated remote) — asset register, assignments, depreciation ledger and year close; plus the ungated "My devices" screen at `/devices` (specs/015, ADR-0045) |
| `notify-ui/` | Notification center (federated remote) — the `/notify` page; reached from the header bell (specs/005) |
| `auth/` | Bun + Hono auth service — OAuth, sessions, RS256 JWT + JWKS, hosted sign-in; + authorization (roles/departments/permissions, admin API, ADR-0007); user invitations + soft-delete + hosted invite landing (specs/006) |
| `estimai-api/` | Estimate-persistence backend (Bun + Hono) |
| `notify-api/` | Notification backend (Bun + Hono) — persistence + SSE push, ticket-authed stream (specs/005, ADR-0008/0009); + email delivery via Resend, internal `/system/emails` (specs/006, ADR-0011); + internal `/system/notifications` for cross-user push (specs/007, ADR-0017) |
| `refund-api/` | Reimbursement backend (Bun + Hono) — authorization-enforcing resource server, EU object storage for receipt attachments (specs/007, ADR-0014/0015/0016) |
| `inventory-api/` | Hardware-inventory backend (Bun + Hono) — authorization-enforcing resource server, EU object storage for invoices, depreciation derived on read with immutable year closes; pushes notifications to notify-api with a scoped service JWT (specs/015, ADR-0044/0046/0047) |
| `specs/`, `docs/adr/` | Spec-driven workflow + Architecture Decision Records |
| `infra/` | Deploy config + runbooks (Railway, Vercel) |

See `CLAUDE.md` for the full architecture, conventions, and estimation model, and
`docs/adr/0006-*` for the Module-Federation decision.

## Local development

One-time setup:

1. **Backend secrets (direnv + 1Password)** — the backends load their secrets from their
   own `.envrc`. `mise run dev` loads these with `direnv exec` (it runs non-interactively,
   so direnv's shell hook doesn't fire on its own). So: install **direnv**, run
   `direnv allow .`, `direnv allow auth`, `direnv allow estimai-api`, `direnv allow notify-api`,
   `direnv allow refund-api`, `direnv allow inventory-api` and `direnv allow admin-ui`, and set up
   the 1Password service account described in
   [1Password for local development](#1password-for-local-development). All five backends require `AUTH_AUDIENCE` (the same suite-wide value, e.g. `operai-suite`) — the
   `aud` claim `auth` stamps and the resource servers verify (ADR-0010); a mismatch rejects
   every token with 401. Set `ENABLE_TEST_AUTH=true` for a seeded local session, and provide
   real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (with
   `http://localhost:3001/auth/callback/google` as an authorized redirect URI) if you want
   Google login locally. `refund-api`, `estimai-api` and `inventory-api` each need
   `SERVICE_CLIENT_ID`/`SERVICE_CLIENT_SECRET` (their own credentials for `auth`'s
   service-token endpoint, matching an entry of `auth`'s `SERVICE_CLIENTS`; ADR-0049) — see
   each `.env.example`. `refund-api`'s object-storage vars (`REFUND_S3_*`) are documented
   but not yet enforced (no bucket provisioned yet); `inventory-api` also needs its own
   `INVENTORY_S3_*` bucket.
2. **Apply DB migrations** (brings up Postgres, then migrates all five backends):

   ```bash
   mise run db:migrate
   ```

Then run the whole suite with **one command**:

```bash
mise run dev            # HMR — Postgres + MinIO + auth + estimai-api + notify-api + refund-api + inventory-api + all 5 frontends
```

The three `dev*` tasks open the shell (http://localhost:5173) in your browser as soon as it
answers. Set `OPERAI_NO_OPEN=1` to skip that.

`mise run dev` starts everything and reaps every child on Ctrl-C (Postgres is left
running — `docker compose down` to stop them). The shell is the entry point —
open **http://localhost:5173**.

| Service | Port | |
|---|---|---|
| shell (host) | **5173** | ← open this |
| estimai-ui (remote) | 5174 | pinned in `vite.config.ts` (`strictPort`) |
| refund-ui (remote) | 5175 | |
| notify-ui (remote) | 5176 | notification center `/notify` (specs/005) |
| admin-ui (remote) | 5177 | roles & permissions admin (specs/004) |
| inventory-ui (remote) | 5178 | hardware inventory + `/devices` (specs/015) |
| auth | 3001 | Bun + Hono |
| estimai-api | 8080 | Bun + Hono |
| notify-api | 8081 | Bun + Hono — SSE push (specs/005) |
| refund-api | 8082 | Bun + Hono — authz-enforcing resource server (specs/007) |
| inventory-api | 8083 | Bun + Hono — authz-enforcing resource server (specs/015) |
| Postgres | 5435 | `docker compose` (databases: `auth`, `estimai`, `notify`, `refund`, `inventory`) |
| MinIO | 9000 / 9001 | `docker compose` — local S3 + console for receipts and invoices |

Other `mise` tasks:

```bash
mise run dev:web        # frontends only (HMR) — when backends run elsewhere
mise run dev:preview    # full stack, but frontends build+preview (no HMR; mirrors deploy)
mise run db:migrate     # apply auth + estimai-api + notify-api + refund-api + inventory-api migrations
```

One-off, production only: the legacy Excel asset register is loaded by
`inventory-api/scripts/import-legacy.ts` (dry-run by default; see
`infra/README.md` § Legacy register import before using `--apply`).

Use `mise run dev:preview` to reproduce a production-like run (it's the mode the e2e uses).

### 1Password for local development

Every `.envrc` (the root one and each app's) reads its secrets with `op read
"op://OperAILocal/<item>/<field>"`. They do not go through the 1Password desktop app: they use a
**service account** whose token sits in the macOS Keychain. The desktop app asks for Touch ID
on every new process. A service account never asks, so `mise run dev`, `direnv exec` and a
coding agent can run while you are away from the Mac.

| What | Value |
|---|---|
| 1Password account | `welldsagl.1password.com` |
| Vault | `OperAILocal`: local-development secrets only, **never** production ones |
| Service account | one per developer, `read_items` on `OperAILocal` only, expires in under 90 days (1Password's maximum) |
| Keychain entry | service `op-sa-operai-local`, account `$USER` |

Anyone who can read the Keychain as you (any process running as your user, a coding agent
included) can read that token. It only reaches local secrets, and you can revoke it with one
click. That is why the vault holds nothing from production.

**One-time setup.** You need `op` (signed in to the wellD account), `direnv` and `jq`, and access
to the `OperAILocal` vault.

1. Create your service account and store its token. If you cannot create service accounts,
   ask a 1Password admin to create it and to send you the token through 1Password, never in
   chat or email. The snippet writes to the Keychain only if a token actually came back, and the
   token never reaches the screen or the shell history:

   ```bash
   ACC=welldsagl.1password.com
   TOKEN="$(op service-account create "operai-local-$USER" --account "$ACC" \
              --vault OperAILocal:read_items --expires-in 89d --raw)" \
     && [ -n "$TOKEN" ] \
     && security add-generic-password -U -a "$USER" -s op-sa-operai-local -T /usr/bin/security -w "$TOKEN" \
     && echo "token stored"
   unset TOKEN
   ```

2. Make sure the first line of every `.envrc` loads the token. It is already there; check it:

   ```bash
   export OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -a "$USER" -s op-sa-operai-local -w)"
   ```

3. Allow the files and check that none is missing a variable. Nothing should ask for Touch ID:

   ```bash
   for d in . auth estimai-api notify-api refund-api inventory-api admin-ui; do direnv allow "$d"; done
   OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -a "$USER" -s op-sa-operai-local -w)" \
     op item list --vault OperAILocal --format json | jq length   # the items the service account can see
   mise run env:doctor -- --env local
   ```

**Rotating the token.** Run step 1 again before the expiry date. `-U` overwrites the Keychain
entry. Then revoke the old service account in 1Password.com → Developer → Service Accounts.

**Adding a secret.** Create the item in `OperAILocal` and reference it as
`op://OperAILocal/<item>/<field>`. Item names may contain spaces; the reference just has to stay
inside double quotes. Never reference another vault (`AIScream`, `Employee`, a personal one):
the service account cannot read it, so `op read` fails and the `.envrc` leaves the variable
empty. To copy an existing item without printing its values:

```bash
op item get "<item>" --vault <source-vault> --account "$ACC" --format json \
  | op item create --vault OperAILocal --account "$ACC" >/dev/null
```

The CLI refuses to create a *Password* item whose password field is empty. Duplicate that kind
of item from the desktop app instead (⋯ → Duplicate, then move the copy to `OperAILocal`).

**Troubleshooting.**

| Symptom | Cause |
|---|---|
| Touch ID / password prompt | the token line is missing or below the first `op read` in that `.envrc`, or the Keychain entry is missing (`security find-generic-password -a "$USER" -s op-sa-operai-local -w \| wc -c` must print more than 1) |
| `"<x>" isn't an item in the "<vault>" vault` | the reference points outside `OperAILocal`, or the item name in the reference does not match the one in the vault |
| `(401) Unauthorized` / `invalid token` | the service account expired or was revoked; rotate it |
| Postgres or Railway values are empty or stale at the root | the root `.envrc` caches them in `.env.cached` for a day: `rm -f .env.cached && direnv reload` |
| Works in the terminal, prompts after the Mac slept | the login Keychain is set to lock on sleep (Keychain Access → Settings) |

### Git signing and GitHub access without 1Password prompts

If your global git config signs commits through 1Password (`gpg.ssh.program` pointing at
`op-ssh-sign`) and reaches GitHub through the 1Password SSH agent, every commit and every fetch
or push asks for Touch ID. A coding agent stops at the first commit. The settings below apply
**to this repository only** (`--local`), so your other repositories keep signing through
1Password. `gh` is not affected: it keeps its token in the macOS Keychain and never prompts.

1. **A signing-only key.** Register it on GitHub as a *Signing key*, so it cannot authenticate.
   It has no passphrase because a passphrase would be asked on every signature. Anyone who can
   read `~/.ssh` as you can therefore sign commits as you, but cannot push or reach GitHub with
   it. Revoke it under GitHub → Settings → SSH and GPG keys.

   ```bash
   ssh-keygen -t ed25519 -N "" -C "operai local commit signing" -f ~/.ssh/operai_signing
   gh auth refresh -h github.com -s admin:ssh_signing_key
   gh ssh-key add ~/.ssh/operai_signing.pub --type signing --title "operai local signing"

   git config --local gpg.ssh.program ssh-keygen
   git config --local user.signingkey "$HOME/.ssh/operai_signing"
   echo test | ssh-keygen -Y sign -f ~/.ssh/operai_signing -n git >/dev/null && echo "signing ok"
   ```

   Commits stay *Verified* on GitHub. To verify signatures locally as well, git needs an
   allowed-signers file. Without it, `git log --show-signature` reports "No signature" even on a
   signed commit:

   ```bash
   echo "$(git config user.email) namespaces=\"git\" $(cat ~/.ssh/operai_signing.pub)" >> ~/.ssh/allowed_signers
   git config --local gpg.ssh.allowedSignersFile "$HOME/.ssh/allowed_signers"
   git log --show-signature -1   # after the next commit: Good "git" signature for <your email>
   ```

2. **Fetch and push over HTTPS with `gh`'s token** (optional). It adds no new credential.
   Today Touch ID is a physical confirmation on every push; with this change an agent can push
   without it, and the only thing left stopping it is the rule that nobody pushes without being
   asked. Skip this step to keep that confirmation; then fetch and push still prompt.

   ```bash
   gh auth setup-git
   git remote set-url origin https://github.com/<owner>/operai.git
   git fetch && echo "fetch ok"
   ```

Before either step, `git config --local --list | grep -E 'gpg|signingkey|remote.origin.url'`
shows what this repository overrides. To go back to 1Password:
`git config --local --unset gpg.ssh.program && git config --local --unset user.signingkey`.

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
