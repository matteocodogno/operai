# Operai — Deployment Guide

The single, step-by-step guide to installing the Operai suite: **frontends on
Vercel**, **backends + Postgres on Railway**. It replaces the previous
per-platform runbooks and variable reference (all folded in below).

Two helper scripts live beside this doc:

| Script | What it does |
|---|---|
| **`./infra/deploy.sh`** | Automates the automatable: Railway backend vars + deploys (+ optional `--vercel` env sync). |
| **`./infra/check.sh`** | Verifies an install — local tooling and/or deployed health (backends, JWKS, remotes, CSP). |

> **Data residency (hard requirement).** All **backend** services and Postgres
> run in **`europe-west4`** (Railway EU). Some wellD clients are regulated
> (energy/finance/health). Don't change the region without an ADR + client
> sign-off. Frontends are static client bundles; they store/transmit no estimate
> data except the browser's authenticated calls to the EU backends.

---

## Topology

```
Vercel (5 projects, one origin each)          Railway project (europe-west4)
┌───────────────────────────────┐             ┌───────────────────────────────┐
│ shell   https://operai.welld.io│──┐ loads    │ auth        (Bun+Hono)        │
│         (host, entry point)    │  │ remote-  │  https://auth.operai.welld.io │
├───────────────────────────────┤  │ Entry.js ├───────────────────────────────┤
│ estimai-ui  estimai.operai…    │◄─┤ at run-  │ estimai-api (Bun+Hono)        │
│ refund-ui   refund.operai…     │◄─┤ time, in │  https://estimai-api.operai… │
│ admin-ui    admin.operai…      │◄─┤ browser  ├───────────────────────────────┤
│ notify-ui   notify.operai…     │◄─┘          │ notify-api  (Bun+Hono)        │
└───────────────────────────────┘              │  https://notify-api.operai…  │
   shell owns session; remotes                 │  numReplicas: 1 (R2 — see    │
   delegate to shell/session                   │  below), SSE + ticket store  │
                                                │  are single-instance only    │
                                                ├───────────────────────────────┤
                                                │ refund-api  (Bun+Hono)        │
                                                │  https://refund-api.operai…  │
                                                │  → EU object storage (S3-    │
                                                │    compatible, ADR-0016) —   │
                                                │    receipt attachments,      │
                                                │    presigned direct-to-bucket│
                                                ├───────────────────────────────┤
                                                │ Postgres (shared)             │
                                                │   ├─ db: auth                 │
                                                │   ├─ db: estimai              │
                                                │   ├─ db: notify               │
                                                │   └─ db: refund               │
                                                │ estimai-api, notify-api,      │
                                                │ refund-api → auth /auth/jwks  │
                                                │ refund-api → auth /authz/     │
                                                │   resolve (ADR-0014)          │
                                                │ refund-api → notify-api       │
                                                │   /system/notifications       │
                                                │   (ADR-0017)                  │
                                                └───────────────────────────────┘
```

- **Frontends:** the `shell` is the human entry point (`operai.welld.io`); the
  four tools (`estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui`) are
  runtime-federated remotes, each on its own subdomain, loaded cross-origin by
  the shell (ADR-0006). `notify-ui` (specs/005) is the notification-center
  page; the shell's own bell/toast/SSE seam is shipped inside the shell bundle
  itself, not this remote (ADR-0009) — see the shell-side notes in
  `specs/005-notification-center/plan.md`.
- **Backends:** `auth` (OAuth, sessions, RS256 JWT + JWKS, hosted sign-in,
  authorization/admin API), `estimai-api` (estimate persistence), `notify-api`
  (notification persistence + SSE push, specs/005), and `refund-api`
  (reimbursement persistence + authorization-enforcing resource server,
  specs/007). One Postgres instance, four logical databases (`auth`,
  `estimai`, `notify`, `refund`); service↔DB traffic stays on Railway private
  networking (`*.railway.internal`).
  **`notify-api` is pinned to a single replica** (`railway.json`
  `numReplicas: 1`) — its in-process EventBus fan-out and stream-ticket store
  are correct for exactly one running instance (plan.md Risk R2). Do not
  enable autoscale/multiple replicas for this service without first moving
  both seams onto Postgres `LISTEN`/`NOTIFY` + a shared ticket table.
  `refund-api` has no equivalent constraint — its `authzMiddleware` cache
  (ADR-0014) is a per-replica performance optimization with a 30s TTL
  backstop, not a correctness-dependent single-instance store, so it deploys
  like `estimai-api` (no replica pin).
- **`notify-api` and `estimai-api` are cross-valid JWKS resource servers**
  (ADR-0010) — both verify the same `auth`-issued tokens, so both (plus
  `auth`, which stamps the claim) require an identical **`AUTH_AUDIENCE`**
  value or a token minted for one is structurally valid at the other.
  `refund-api` (specs/007) is a THIRD JWKS resource server on the same
  `AUTH_AUDIENCE` value — see § Variable reference.
- **`auth` → `notify-api` service-to-service email trigger** (specs/006-user-invitations,
  ADR-0011): `auth` calls `notify-api`'s internal `POST /system/emails` to send
  invite/resend emails (Resend, bilingual) — the suite's first non-user-JWT
  cross-service call, authenticated by a shared `NOTIFY_INTERNAL_TOKEN`
  instead of a Bearer JWT. This call is routed over Railway **private
  networking** (`NOTIFY_INTERNAL_URL` → `notify-api.railway.internal`), not
  the public `<NOTIFY_API_URL>` domain the browser uses for SSE — see
  § Variable reference and § Phase 1 step 7.
- **`refund-api` → `auth` `/authz/resolve` + `refund-api` → `notify-api`
  `/system/notifications`** (specs/007-refund-service, ADR-0014/ADR-0017):
  `refund-api` is the suite's first AUTHORIZATION-enforcing resource server —
  every request resolves the caller's live permissions from `auth GET
  /authz/resolve` (forwarding the caller's own Bearer JWT, no new secret,
  reuses `AUTH_ISSUER`/`AUTH_JWKS_URL`/`AUTH_AUDIENCE` below — no separate env
  var). After an approve/reject decision it calls `notify-api`'s internal
  `POST /system/notifications` (mirrors `/system/emails`'s shape), reusing the
  **same** `NOTIFY_INTERNAL_TOKEN` `auth` and `notify-api` already share —
  ADR-0017 explicitly notes this trips ADR-0011's named "second internal
  caller" escalation trigger without acting on it yet. Both calls should
  prefer Railway **private networking** where the target service's private
  hostname is known, same posture as `auth`'s existing `NOTIFY_INTERNAL_URL`.
- **`refund-api` → EU object storage** (specs/007-refund-service, ADR-0016): a
  SEPARATE S3-compatible bucket resource (not a Railway service) — receipt
  attachments never transit `refund-api`'s own process (presigned
  direct-to-bucket upload/download). See § Variable reference's `refund-api`
  section and this task's follow-up note on provisioning (not yet done).
- **The public URL placeholders** used below — keep them straight; all need
  the `https://` scheme:
  - `<AUTH_URL>` = the **auth** service (e.g. `https://auth.operai.welld.io`). It
    is the JWT **issuer**, so `estimai-api`, `notify-api`, and `refund-api`
    point back at it (`refund-api` also calls its `/authz/resolve` route).
  - `<API_URL>` = the **estimai-api** service (e.g. `https://estimai-api.operai.welld.io`).
    Only the browser/UI references it.
  - `<NOTIFY_API_URL>` = the **notify-api** service's **public** domain (e.g.
    `https://notify-api.operai.welld.io`). Only the browser/UI references it
    (via `VITE_NOTIFY_API_URL`); it is also the origin the shell CSP's
    `connect-src` must allow for the SSE `EventSource` (R6 — see Phase 3).
  - `<NOTIFY_INTERNAL_URL>` = notify-api's Railway **private**-networking
    address (e.g. `http://notify-api.railway.internal:8081`) — distinct from
    `<NOTIFY_API_URL>` above. `auth`'s server-side `POST /system/emails` call
    (specs/006-user-invitations, ADR-0011) AND `refund-api`'s server-side
    `POST /system/notifications` call (specs/007, ADR-0017) both use this;
    never given to a browser, never the public domain — see § Phase 1 step 7.
  - `<REFUND_API_URL>` = the **refund-api** service's **public** domain (e.g.
    `https://refund-api.operai.welld.io`). Only the browser/UI references it
    (via `VITE_REFUND_API_URL`, both on the `shell` project — trusted-origins
    allowlist — and the `refund-ui` project itself); it is also the origin
    the shell CSP's `connect-src` must allow (see Phase 3).

**Hostnames.** The `*.operai.welld.io` scheme is the proposed, welld.io-parented
layout (shared registrable parent matters for the credentialed `/auth/token`
cookie call — ADR-0001 R7). If the real domains differ, update them here **and**
in the static `vercel.json` CSP/redirect strings (Vercel doesn't interpolate env
vars into those).

---

## Prerequisites

1. **Tooling:** `railway` CLI (logged in: `railway login`), `vercel` CLI (logged
   in: `vercel login`) if you want Vercel automation, **direnv**, the **1Password
   CLI** (`op`, signed in), Node 24 + `pnpm`, and `bun`. Verify with
   **`./infra/check.sh --prereqs`**.
2. **Secrets (direnv + 1Password).** Backend secrets never live in the repo —
   they load from 1Password via `.envrc`. Run `direnv allow auth` (and
   `direnv allow estimai-api`, `direnv allow notify-api`, `direnv allow
   refund-api`) once, be signed in to `op`, and run deploy commands from
   within that shell (e.g. `direnv exec auth ./infra/deploy.sh`) so the
   secrets are exported. The full variable → 1Password-item map is in
   **§ Variable reference** below. **`refund-api`'s object-storage
   credentials (`REFUND_S3_*`) have NO 1Password item yet** — provision a real
   EU-region bucket first (see § Variable reference's `refund-api` section);
   `deploy.sh` does not yet set these vars automatically for that reason.
3. **Railway project** exists (its id is in 1Password as `$RAILWAY_PROJECT_ID`).
   Creating the project + attaching custom domains is a one-time dashboard action.

---

## Order of operations

Each phase feeds the next, so do them in order:

1. **Railway — backends first.** Yields `<AUTH_URL>`, `<API_URL>`, `<NOTIFY_API_URL>`, and `<REFUND_API_URL>`.
2. **Vercel — the five frontends.** Their build-time vars point at the Phase-1 URLs.
3. **Cross-wire origins + OAuth.** Backends trust the shell origin; register OAuth redirects.
4. **Verify** end-to-end (`./infra/check.sh`).

**Chicken-and-egg, resolved:** the shell's production origin is fixed in advance
(`https://operai.welld.io`), so the backends' `ALLOWED_ORIGINS`/`UI_HOME_URL` can
be set in Phase 1 without waiting for Vercel. Only the three **backend** URLs
are discovered during deploy — which is why the frontends' vars come after.

---

## Phase 1 — Railway backends

The automatable parts are in **`./infra/deploy.sh`**; the manual dashboard bits
are called out. What the script does, step by step:

1. **Link** the project: `railway link "$RAILWAY_PROJECT_ID"` (env `production`).
2. **Postgres** (manual first time): dashboard → New → Database → PostgreSQL;
   confirm its **region is `europe-west4`** before adding data. Then create the
   four logical DBs (the script attempts this; or `railway connect Postgres` →
   `CREATE DATABASE auth;` `CREATE DATABASE estimai;` `CREATE DATABASE notify;`
   `CREATE DATABASE refund;`). They must exist before the first deploy — each
   service's `preDeployCommand` runs `prisma migrate deploy` against its own
   DB (`refund-api`'s first migration, `0001_init`, lands with specs/007's T5
   — until then `preDeployCommand` is a safe no-op against an empty
   migrations directory).
3. **Deploy `auth`** (root dir `auth`, reads `auth/railway.json`): set its vars
   (DATABASE_URL via `${{Postgres.*}}` references, `BETTER_AUTH_SECRET`,
   `GOOGLE_*`/`GITHUB_*`, `JWT_*`, `ALLOWED_ORIGINS=<shell origin>`, `UI_HOME_URL`,
   `AUTH_AUDIENCE` (ADR-0010 — one suite-wide value; see below),
   `NOTIFY_INTERNAL_URL`/`NOTIFY_INTERNAL_TOKEN` (specs/006-user-invitations,
   ADR-0011 — see below), `BOOTSTRAP_ADMIN_EMAIL`, `NODE_ENV=production`), then
   deploy. **Generate its domain** (dashboard → Settings → Networking, or a
   custom `auth.operai.welld.io`) → this is **`<AUTH_URL>`**.
4. **Deploy `estimai-api`** (root dir `estimai-api`): set `DATABASE_URL` (dbname
   `estimai`), `ALLOWED_ORIGINS`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `AUTH_AUDIENCE` (byte-for-byte identical
   to `auth`'s), `NODE_ENV`. **Generate its domain** → **`<API_URL>`**.
5. **Deploy `notify-api`** (root dir `notify-api`, reads `notify-api/railway.json`
   — note it pins **`numReplicas: 1`**, do not change this without first reading
   plan.md Risk R2): set `DATABASE_URL` (dbname `notify`, **not** `estimai`),
   `ALLOWED_ORIGINS=<shell origin>`, `AUTH_ISSUER=<AUTH_URL>`,
   `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`, `AUTH_AUDIENCE` (same value as the other
   two), `MAX_STREAM_DURATION` (seconds; default `1800`),
   `NOTIFY_INTERNAL_TOKEN` (same value as `auth`'s — see below),
   `EMAIL_ENABLED`/`RESEND_API_KEY`/`RESEND_FROM` (specs/006-user-invitations —
   see below), `NODE_ENV=production`. Confirm region **`europe-west4`** (data
   residency — notification bodies may name clients/estimates and must stay
   EU-only, never logged). **Generate its domain** → this is
   **`<NOTIFY_API_URL>`** (public — browser/SSE only; see step 7 for the
   private URL `auth` uses instead).

   > ⚠️ **Build fails with `Corepack is about to download … pnpm-…tgz` (exit 1)?**
   > That means Railway ignored the service's Dockerfile and fell back to
   > **Nixpacks**, which scans the monorepo and tries to corepack-install pnpm.
   > Root cause: the service's **Root Directory is not set to the app dir**, so
   > Railway builds from the repo root (which has no `railway.json`/`package.json`).
   > **Fix:** service → **Settings → Root Directory = `<app>`** (`notify-api`,
   > `auth`, `estimai-api`, `refund-api`, …), then redeploy — Railway then reads
   > `<app>/railway.json` (`builder: DOCKERFILE`) and does the correct Bun build.
   > This applies to BOTH GitHub-connected deploys and `deploy.sh`'s
   > `railway up --service <svc>` (which uploads the repo root as context; the
   > Root Directory setting is what scopes the build down to the app).
6. **Deploy `refund-api`** (root dir `refund-api`, reads `refund-api/railway.json`
   — T19, specs/007-refund-service): set `DATABASE_URL` (dbname `refund`,
   **not** `estimai`/`notify`), `ALLOWED_ORIGINS=<shell origin>`,
   `AUTH_ISSUER=<AUTH_URL>`, `AUTH_JWKS_URL=<AUTH_URL>/auth/jwks`,
   `AUTH_AUDIENCE` (same value as the other three), `NOTIFY_INTERNAL_URL`
   (notify-api's **private**-networking address — same value as `auth`'s, see
   step 8), `NOTIFY_INTERNAL_TOKEN` (same value as `auth`'s/`notify-api`'s —
   see step 8), `REFUND_S3_ENDPOINT`/`REFUND_S3_REGION`/`REFUND_S3_BUCKET`/
   `REFUND_S3_ACCESS_KEY_ID`/`REFUND_S3_SECRET_ACCESS_KEY` (EU-region object
   storage, ADR-0016 — **NOT YET PROVISIONED**, see § Variable reference),
   `REFUND_APP_BASE_URL` (monthly batch processing, T14,
   specs/008-refund-monthly-processing, ADR-0021 — see § Variable
   reference), `NODE_ENV=production`. Do **NOT** set
   `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — as of specs/011-refund-settings
   this is no longer a `refund-api` env var at all (AC-4.1); see
   § "Cutover — accounting-distribution-email setting" below for the
   one-time post-deploy step that replaces it. Confirm region
   **`europe-west4`** (data residency —
   this service handles financial figures and receipt-attachment metadata that
   may carry PII, never logged). **Generate its domain** → this is
   **`<REFUND_API_URL>`**.
7. **Cross-wire:** set `auth`'s `BETTER_AUTH_URL=<AUTH_URL>` (the JWT `iss` claim —
   must equal `estimai-api.AUTH_ISSUER`, `notify-api.AUTH_ISSUER`, and
   `refund-api.AUTH_ISSUER`) and redeploy `auth`. Re-run the script with
   `AUTH_PUBLIC_URL=<AUTH_URL>` once the domain exists.
8. **Wire the invitation email channel + refund decision notifications**
   (specs/006-user-invitations ADR-0011, specs/007-refund-service ADR-0017):
   set `auth`'s **and** `refund-api`'s `NOTIFY_INTERNAL_URL` to notify-api's
   **Railway private** networking address, e.g.
   `http://notify-api.railway.internal:8081` (dashboard → notify-api service
   → Settings → Networking → Private Networking shows the exact internal
   hostname/port) — **not** `<NOTIFY_API_URL>`, the public domain from step 5
   (plan.md Risk R2 / ADR-0011: this service-to-service call must stay off
   the public internet). Generate a strong shared secret (`openssl rand -hex
   32`) and set it as `NOTIFY_INTERNAL_TOKEN` on **all three** of `auth`,
   `notify-api`, **and `refund-api`** — byte-for-byte identical, stored once
   in 1Password and referenced by all three services' `.envrc` (ADR-0017:
   this is now a THIRD caller sharing one secret, a named-but-not-yet-acted-on
   escalation trigger from ADR-0011). Set `notify-api`'s `EMAIL_ENABLED=true`
   with real `RESEND_API_KEY`/`RESEND_FROM` only once the Resend sending
   domain is verified (see § Resend domain setup below) — until then, leave
   `EMAIL_ENABLED=false` so invite emails are stubbed (recorded, not actually
   sent) rather than failing loudly.

**`AUTH_AUDIENCE` (ADR-0010) — one value, FOUR services (as of specs/007).**
`notify-api` was the suite's first real second JWKS resource server, so a
token minted for `estimai-api` would otherwise be structurally valid at
`notify-api` (and vice versa); `refund-api` (specs/007) is now a third. `auth`
stamps the `audience` claim on every JWT it issues; `estimai-api`,
`notify-api`, AND `refund-api` each verify `audience` against their own
`AUTH_AUDIENCE`. **All four services must carry the byte-for-byte identical
value** (local default: `operai-suite`, see each service's `.env.example`) — a
drifted value fails every request closed (401) in that environment, not open.

**`NOTIFY_INTERNAL_TOKEN` (ADR-0011, extended by ADR-0017) — shared secret,
THREE services (as of specs/007), no user identity.** `auth` calls
`notify-api`'s `POST /system/emails` to send invite/resend emails, and
`refund-api` calls `notify-api`'s `POST /system/notifications` to push
decision notifications — both deliberately NOT the JWKS/Bearer-JWT pattern
above (the invitee has no `User` row/`sub` yet for the email case; the
notification case reuses the same internal-token shape rather than forwarding
a caller's JWT to a different service for a system-initiated push). All three
services validate a single shared secret via the `X-Internal-Token` header.
**`auth.NOTIFY_INTERNAL_TOKEN`, `notify-api.NOTIFY_INTERNAL_TOKEN`, and
`refund-api.NOTIFY_INTERNAL_TOKEN` must be byte-for-byte identical**, sourced
from one 1Password item, ≥32 random chars, never logged by any service —
plan.md Risk R2: a leaked token lets an attacker send arbitrary email over
wellD's Resend domain (and, as of specs/007, push arbitrary in-app
notifications to any user). Rotate by generating a new value, updating
1Password, and redeploying **all three** services together (a stale value on
any one side fails every send/push closed, 401, not open). ADR-0017 names
this "a THIRD internal caller sharing one secret" as an explicit,
knowingly-deferred escalation trigger from ADR-0011 — not re-litigated here,
just flagged.

**Resend domain setup (plan.md Risk R5, ADR-0011 compliance notes).** Before
setting `EMAIL_ENABLED=true` in production:
1. Add `operai.welld.io` (or the chosen sending subdomain) as a verified
   domain in the Resend dashboard.
2. Add the SPF and DKIM DNS records Resend provides to that domain's DNS zone;
   wait for Resend to report the domain "Verified" — an unverified domain
   means invite emails are likely to land in spam or be rejected outright.
3. Prefer Resend's **EU sending region** where available (data residency —
   CLAUDE.md; this is the transactional MTA hop, not data-at-rest, but keep
   the suite's EU-only posture consistent).
4. Set `RESEND_FROM` to an address on that verified domain (e.g.
   `no-reply@operai.welld.io`) and `RESEND_API_KEY` from the Resend dashboard
   (1Password-sourced, never committed).
Until this is done, keep `EMAIL_ENABLED=false` — the email channel stubs the
send and records an `EmailDelivery` row without calling Resend, so the rest of
the invitation flow (create/resend/revoke, admin-ui) is fully testable without
a verified domain.

**Run it:**
```bash
export RAILWAY_PROJECT_ID=...        # from 1Password
export BOOTSTRAP_ADMIN_EMAIL=you@welld.ch
export AUTH_AUDIENCE=operai-suite    # ADR-0010 — identical across auth + estimai-api + notify-api + refund-api
export AUTH_PUBLIC_URL=https://auth.operai.welld.io   # after the auth domain exists
direnv exec auth ./infra/deploy.sh
```

`deploy.sh` as of T19 does NOT yet set `refund-api`'s `REFUND_S3_*` vars (no
bucket provisioned — see § Variable reference); set those manually via
`railway variables --service refund-api --set "REFUND_S3_...=..."` once a real
EU bucket + credentials exist.

**Do NOT set** `ENABLE_TEST_AUTH` (a complete auth bypass — the `POST
/test-auth/session` mint endpoint), `BETTER_AUTH_TRUSTED_ORIGINS` (bypasses the
validated `ALLOWED_ORIGINS` allowlist), or `PORT` (Railway injects it).

**Migrations + seed run automatically** — each `railway.json` `preDeployCommand`
is `bun run db:deploy && bun run db:seed` (for `auth`; `estimai-api`,
`notify-api`, and `refund-api` run `db:deploy` only). `migrate deploy` is
non-interactive and only applies pending migrations; the authz seed (idempotent)
creates the system roles + app-access catalog and, on first sign-in of
`BOOTSTRAP_ADMIN_EMAIL`, the first admin. Never edit an existing migration file.

---

## Phase 2 — Vercel frontends

**Project + domain creation is manual** (Vercel CLI can't create+assign domains
here); env-var sync + redeploy is automatable (`./infra/deploy.sh --vercel`).

1. **Create five projects** (dashboard → New Project → import this repo). For each,
   **Root Directory** = the app dir (`shell` / `estimai-ui` / `refund-ui` /
   `admin-ui` / `notify-ui`), framework **Vite**, default build (`pnpm build` →
   `dist`). Each app ships its own `vercel.json` (SPA rewrites + headers) picked
   up automatically.
2. **Assign domains:**

   | Project | Domain | Notes |
   |---|---|---|
   | `shell` | `operai.welld.io` | **Reassign** from the old `estimai-ui` project — the human entry point |
   | `estimai-ui` | `estimai.operai.welld.io` | remote-only; keeps a redirect for the old URL (below) |
   | `refund-ui` | `refund.operai.welld.io` | remote-only |
   | `admin-ui` | `admin.operai.welld.io` | remote-only (roles & permissions, specs/004) |
   | `notify-ui` | `notify.operai.welld.io` | remote-only (notification center, specs/005) |

3. **Env vars** (Settings → Environment Variables, Production **and** Preview;
   all build-time → **redeploy** after changing). See **§ Variable reference**.
4. **EstimAI old-URL redirect:** `estimai-ui/vercel.json` 302-redirects only
   top-level document nav (`sec-fetch-dest: document`) to `operai.welld.io/estimai`
   — so it never catches the shell's `remoteEntry.js` fetches. Smoke-test on first
   deploy (`check.sh` checks it).
5. **Runtime remote URLs (optional):** the shell bakes `*_REMOTE_URL` at build.
   With stable custom domains you need nothing more. To repoint a remote's origin
   without rebuilding the shell, publish `shell/public/runtime-config.json` (see
   `shell/public/runtime-config.example.json` — includes `admin`) — the shell
   reads it at every page load (`shell/src/lib/runtimeRemotes.ts`). **Note:**
   as of this task (T20), `shell/vite.config.ts` does not yet declare a
   `notify` remote (`NOTIFY_REMOTE_URL`) — that lands with specs/005's T13,
   mirroring `ADMIN_REMOTE_URL` exactly. `notify-ui` is deployable and
   reachable on its own domain today; the shell mounting it at `/notify` is a
   separate, not-yet-merged app-code change, not an infra gap.

---

## Phase 3 — Cross-wire origins + OAuth

- **`ALLOWED_ORIGINS`** on all FOUR backends (`auth`, `estimai-api`,
  `notify-api`, `refund-api`) must be the **shell's** origin
  (`https://operai.welld.io`) — that's what CORS + better-auth
  `trustedOrigins` validate. Only the shell's origin is needed: the remotes
  never call the backends directly (they delegate to `shell/session`, which
  runs under the shell's origin). This includes `notify-api`'s SSE stream
  endpoint — its `Access-Control-Allow-Origin` is pinned to the shell origin
  too (plan.md). Redeploy the affected service after a change.
- **`refund-api.ALLOWED_ORIGINS` gains admin-ui's OWN origin**
  (specs/009-mileage-rate, T8, plan.md Risk R8) — admin-ui's new Mileage
  Rates screen calls `refund-api`'s `/rates` endpoints directly (Bearer-authed,
  cross-origin, via `shell/session`'s `apiFetch`), the plan's chosen wiring
  (admin-ui hosts the screen; `refund-api` stays the sole data/logic owner —
  see ADR-0023). When admin-ui runs COMPOSED inside the shell (the normal
  path in production), the browser Origin is already the SHELL's — already
  covered by the entry above, no change needed there. The NEW origin this
  bullet adds is for admin-ui's OWN origin — its standalone dev server
  (`http://localhost:5177`) and any Vercel Preview deploy of the `admin-ui`
  project (`https://admin-ui-<hash>.vercel.app` — Vercel Preview URLs are
  per-deploy, so exact-match CORS can't pin one in advance; treat Preview
  verification of this specific flow as a manual step, same known gap noted
  for the shell CSP below) — add these to `refund-api`'s `ALLOWED_ORIGINS`
  per environment. Hono CORS layer ONLY; `refund-api` has no better-auth
  `trustedOrigins` to keep in sync (unlike the `auth` service).
- **OAuth redirect URIs** (better-auth mounts at `/auth`):
  - Google Cloud Console → your OAuth client → Authorized redirect URIs:
    `<AUTH_URL>/auth/callback/google`
  - GitHub → Developer settings → OAuth App → Authorization callback URL:
    `<AUTH_URL>/auth/callback/github`
- **Shell CSP** (`shell/vercel.json`, a static header) pins each remote origin +
  the auth/API origins in `script-src`/`connect-src`, and allows Google/GitHub
  avatar hosts in `img-src`. If domains change, edit that file.
  **`connect-src` MUST include the `notify-api` AND `refund-api` origins** —
  `EventSource` (SSE) is governed by `connect-src`, not `script-src`; this is
  the classic miss for a streaming feature (plan.md Risk R6). `notify.operai.
  welld.io` (the remote, in `script-src` **and** `connect-src`) and
  `notify-api.operai.welld.io` (the SSE origin, in `connect-src`) are already
  present in `shell/vercel.json`'s CSP string (specs/005 T19) — `check.sh`
  asserts this pin so a future edit that drops it fails loudly.
  `refund-api.operai.welld.io` was added to `connect-src` (T20,
  specs/007-refund-service) — `refund-api` never streams (no SSE), but it's an
  ordinary fetch target from `refund-ui`'s calls (via `shell/session`'s
  `apiFetch`) and `connect-src` governs `fetch`/`XHR` origins too, not just
  EventSource.
  *(Known gap: Vercel Preview deploys get `*.vercel.app` URLs the pinned CSP
  won't match — assign preview subdomains or relax CSP via Edge Middleware;
  not implemented.)*

---

## Phase 4 — Verify

```bash
./infra/check.sh
```
It checks backend `/health` for all FOUR backends (`auth`, `estimai-api`,
`notify-api`, `refund-api`), the **`/auth/jwks`** RS256 key set (the endpoint
every resource server verifies against — **not** `/.well-known/jwks.json`, an
orphaned env-key endpoint), each remote's `remoteEntry.js` + CORS header (five:
`estimai-ui`, `refund-ui`, `admin-ui`, `notify-ui`), the shell CSP pins
(including the `notify-api` SSE `connect-src` pin, R6, and the `refund-api`
`connect-src` pin, T20), and warns if `notify-api`'s health payload doesn't
look JWKS-ready. It also probes `POST
$NOTIFY_API_URL/system/emails` (specs/006, ADR-0011): a garbage
`X-Internal-Token` must get 401 (proves the internal-token gate is deployed
and live), and — only if you export `NOTIFY_INTERNAL_TOKEN` locally (the same
value configured on both services) — a deliberately-invalid body with the
*real* token must get 400, not 401 (proves the deployed value matches yours,
without ever printing or transmitting a real send). Then, in a browser at
`https://operai.welld.io/`: hit a guarded route → redirected to
`<AUTH_URL>/sign-in`; sign in with Google + GitHub; the `BOOTSTRAP_ADMIN_EMAIL`
account sees the **Admin** tool in the nav; create an estimate + reload
(persists); sign out (session ends suite-wide, no 403); as an admin, send a
test invitation from the **Invitations** page and confirm `EMAIL_ENABLED`'s
posture matches expectation (stubbed `sent` if `false`, an actual Resend send
if `true`).

---

## Variable reference

### Private networking & shared variables (the Layer-2 contract)

All four backends are services in ONE Railway project/environment, so they talk
to each other over Railway **private networking**. Getting these three buckets
right is what removes the recurring "localhost in prod / missing origin"
401·503·CORS class of bug. **Rule of thumb: a *call* between backends uses
internal DNS; a *claim* or a *browser-facing* URL stays public.**

**① Internal-DNS URLs** — one backend *calling* another. Use the target's
private domain over **plain `http://`** (the private net carries no TLS), on the
target's listen port. Each `src/index.ts` binds to IPv6 `::` when Railway's
`RAILWAY_PRIVATE_DOMAIN` is present (handled in code) — that's what makes
`*.railway.internal` reachable; without it Bun binds IPv4 `0.0.0.0` and internal
calls silently fail.

| Var | Owner(s) | Value |
|---|---|---|
| `AUTH_JWKS_URL` | estimai-api, notify-api, refund-api | `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}/auth/jwks` |
| `AUTH_BASE_URL` | refund-api (the `GET /authz/resolve` call) | `http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:${{auth.PORT}}` |
| `NOTIFY_INTERNAL_URL` | auth, refund-api | `http://${{notify-api.RAILWAY_PRIVATE_DOMAIN}}:${{notify-api.PORT}}` |

**Use the Railway reference-variable form above (`${{svc.PORT}}`) — do NOT
hardcode the port.** A service listens on exactly ONE port (its `PORT`), and it
is the SAME for public and private traffic. The literal numbers in
`src/lib/env.ts` (auth 3001, estimai-api 8080, notify-api 8081, refund-api 8082)
are only the **code defaults** that apply when `PORT` is unset — Railway may set
a different value (e.g. notify-api's public domain targets **8080**, so its
`PORT` is 8080, *not* the code default 8081; hardcoding `:8081` internally would
fail to connect). For `${{svc.PORT}}` to resolve, **set `PORT` explicitly as a
variable on each backend** (any consistent value), then reference it everywhere —
the port is then unambiguous and can never drift from what the service actually
binds.

**② Public — MUST stay the public URL (the trap).** These are identity *claims*
or *browser-facing* URLs, not backend calls — repoint them at internal DNS and
things break silently:

| Var | Owner(s) | Why it stays public |
|---|---|---|
| `AUTH_ISSUER` | estimai-api, notify-api, refund-api | The JWT **`iss` claim**, string-compared at verify time (`jwt.middleware.ts` `issuer: env.AUTH_ISSUER`) — must equal auth's public `BETTER_AUTH_URL`. Internal DNS here → **every token rejected 401**. |
| `UI_HOME_URL` | auth | Browser post-login redirect. |
| `REFUND_APP_BASE_URL` | refund-api | Deep-link base opened in the recipient's browser. |
| `ALLOWED_ORIGINS` | all | Browser Origins (the frontends' public URLs). |

**③ Shared variables — define ONCE at the Railway *project* level, reference
with `${{shared.NAME}}`.** These are byte-for-byte identical across services
today, copied by hand — the source of drift (a mismatched `AUTH_AUDIENCE` is a
suite-wide 401):

| Var | Shared by |
|---|---|
| `AUTH_AUDIENCE` | auth + all 3 resource servers (ADR-0010) |
| `AUTH_ISSUER` | all 3 resource servers (same public value) |
| `NOTIFY_INTERNAL_TOKEN` | auth + refund-api + notify-api (secret; ADR-0011/0017) |

Set each as a Railway **Shared Variable** once; each service then references
`${{shared.AUTH_AUDIENCE}}` etc. — one place to change, no hand-copying.

The per-service tables below reflect these conventions (a URL marked *internal*
follows bucket ①).

### `auth` service (Railway)

| Variable | Value / source | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/auth` | yes |
| `BETTER_AUTH_SECRET` | 1Password → `Employee / Paperclip - BETTER_AUTH_SECRET` (≥32 chars) | **yes** |
| `BETTER_AUTH_URL` | `<AUTH_URL>` — the JWT `iss`; must equal estimai-api `AUTH_ISSUER` | no |
| `GOOGLE_CLIENT_ID` / `_SECRET` | 1Password → `AIScream / OperAI - GOOGLE OAuth` | **yes** |
| `GITHUB_CLIENT_ID` / `_SECRET` | 1Password → `AIScream / OperAI - GITHUB OAuth` | **yes** |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | 1Password → `AIScream / OperAI Private Key` (RS256 PEM; `.pem` gitignored) | **yes** |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin; no wildcard/trailing slash) | no |
| `UI_HOME_URL` | `https://operai.welld.io/` (post-login fallback; origin ∈ ALLOWED_ORIGINS) | no |
| `AUTH_AUDIENCE` | **NEW (ADR-0010).** One suite-wide value (e.g. `operai-suite`), byte-for-byte identical to `estimai-api.AUTH_AUDIENCE` and `notify-api.AUTH_AUDIENCE`. Stamped as the JWT `audience` claim on every token `auth` mints; closes the cross-service token-replay gap now that `notify-api` is a second JWKS resource server. | no |
| `NOTIFY_INTERNAL_URL` | **NEW (specs/006, ADR-0011).** notify-api's Railway **private**-networking address, e.g. `http://notify-api.railway.internal:8081` — **not** `<NOTIFY_API_URL>` (the public domain). Base URL for the `POST /system/emails` call (`src/lib/notify.ts`). | no |
| `NOTIFY_INTERNAL_TOKEN` | **NEW (specs/006, ADR-0011).** Shared secret sent as `X-Internal-Token`; byte-for-byte identical to `notify-api.NOTIFY_INTERNAL_TOKEN`. 1Password → `AIScream / OperAI - NOTIFY_INTERNAL_TOKEN` (≥32 random chars). A leaked value = arbitrary email over wellD's Resend domain (Risk R2) — never logged, rotate + redeploy both services together if compromised. | **yes** |
| `BOOTSTRAP_ADMIN_EMAIL` | email of the first admin (specs/004 AC-6.1; gets `admin` on first sign-in). Set on Railway, not committed. | no |
| `NODE_ENV` | `production` | no |
| `PORT` | **set explicitly** (any consistent value, e.g. `8080`) so private-networking callers can reference `${{auth.PORT}}` (see § Private networking) — the service binds `env.PORT`, default 3001 if unset, but leaving it unset makes `${{auth.PORT}}` unresolvable | no |
| `ENABLE_TEST_AUTH` / `BETTER_AUTH_TRUSTED_ORIGINS` | **leave UNSET** (see Phase 1) | — |

### `estimai-api` service (Railway)

| Variable | Value | 
|---|---|
| `DATABASE_URL` | `…@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/estimai` |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`; **public** claim — bucket ②; use `${{shared.AUTH_ISSUER}}`) |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001/auth/jwks` (**not** the public `<AUTH_URL>`, **not** `/.well-known/jwks.json`) |
| `AUTH_AUDIENCE` | **ADR-0010.** `${{shared.AUTH_AUDIENCE}}` — same value as every service; `jwtVerify` pins `audience`; a token with a missing/wrong `aud` is rejected 401. | no |
| `NODE_ENV` | `production` · `MAX_ESTIMATE_BYTES`/`MAX_IMPORT_REQUEST_BYTES` optional (defaults) |

### `notify-api` service (Railway) — NEW (specs/005-notification-center)

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/notify` — **its own logical DB, `notify`, not `estimai`** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin) — also what the SSE stream's `Access-Control-Allow-Origin` echoes | no |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001/auth/jwks` (same endpoint every resource server uses — **not** the public `<AUTH_URL>`, **not** `/.well-known/jwks.json`) | no |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`; **public** claim — bucket ②; `${{shared.AUTH_ISSUER}}`) | no |
| `AUTH_AUDIENCE` | **ADR-0010.** `${{shared.AUTH_AUDIENCE}}` — byte-for-byte identical suite-wide; a drifted value here either rejects everything (401) or (worse, if unset elsewhere) allows cross-service token replay. | no |
| `MAX_STREAM_DURATION` | Seconds an SSE connection may stay open before the server forces a reconnect (ADR-0008). Default `1800` (~30 min). | no |
| `NOTIFY_INTERNAL_TOKEN` | **NEW (specs/006, ADR-0011).** Same 1Password item as `auth.NOTIFY_INTERNAL_TOKEN` — byte-for-byte identical. **Unconditionally required** (no default; `notify-api` refuses to start without it, min 32 chars) — unlike `EMAIL_ENABLED`/`RESEND_*` below, there is no "off" mode. Validated by `internalTokenMiddleware` against `X-Internal-Token` on `POST /system/emails` **only** — never accepted on any `jwtMiddleware` route. | **yes** |
| `EMAIL_ENABLED` | **NEW (specs/006).** `"true"` (exact string, case-insensitive) to make real Resend calls; any other value (including unset) stubs the send and still records an `EmailDelivery` row. Default `false` — safe for first deploys before the Resend domain is verified (see § Resend domain setup). | no |
| `RESEND_API_KEY` | **NEW (specs/006).** 1Password → `AIScream / OperAI - Resend API Key`. Required only when `EMAIL_ENABLED=true` (service refuses to start otherwise once enabled). | **yes** |
| `RESEND_FROM` | **NEW (specs/006).** Verified sending address on the SPF/DKIM-configured domain, e.g. `no-reply@operai.welld.io` (Risk R5). Required only when `EMAIL_ENABLED=true`. | no |
| `NODE_ENV` | `production` | no |

**`notify-api` deploy constraints (do not relax without reading plan.md Risk
R2):** `railway.json` pins **`numReplicas: 1`** — the in-process EventBus
fan-out and the in-process stream-ticket store are correct for exactly one
running instance; a second replica silently splits both. Region **must** be
`europe-west4` (data residency — notification title/body may name
clients/estimates) and the service must never log request/response bodies
(reuses `estimai-api`'s method+path+status-only `hono/logger` posture, enforced
in `notify-api/src/index.ts` and called out in `notify-api/Dockerfile`).

### `refund-api` service (Railway) — NEW (specs/007-refund-service, T19)

| Variable | Value | Secret |
|---|---|---|
| `DATABASE_URL` | `postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/refund` — **its own logical DB, `refund`** | yes |
| `ALLOWED_ORIGINS` | `https://operai.welld.io` (shell origin) **+ admin-ui's own origin** (specs/009-mileage-rate, T8: `https://admin.operai.welld.io` — or its Preview URL, see § Phase 3 — for the `/rates` Mileage Rates screen's direct cross-origin call; composed-shell traffic is already covered by the shell origin alone) | no |
| `AUTH_JWKS_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001/auth/jwks` (same endpoint every resource server uses — **not** the public `<AUTH_URL>`, **not** `/.well-known/jwks.json`) | no |
| `AUTH_ISSUER` | `<AUTH_URL>` (== auth `BETTER_AUTH_URL`; **public** claim — bucket ②, `${{shared.AUTH_ISSUER}}`). Pinned as the JWT `iss` in `jwt.middleware.ts`. NOTE: `refund-api`'s `GET /authz/resolve` call does **not** use this — it uses the separate `AUTH_BASE_URL` below (`resolveClient.ts`). | no |
| `AUTH_BASE_URL` | **internal** (bucket ①): `http://auth.railway.internal:3001` — the base `refund-api`'s `authzMiddleware`/`resolveClient.ts` builds `GET /authz/resolve` against (ADR-0014). A *call*, so internal DNS; distinct from `AUTH_ISSUER`. (This is the var that was `localhost` in prod → 503.) | no |
| `AUTH_AUDIENCE` | **ADR-0010.** `${{shared.AUTH_AUDIENCE}}` — byte-for-byte identical suite-wide; `refund-api` is the THIRD JWKS resource server on this shared value. | no |
| `NOTIFY_INTERNAL_URL` | notify-api's **private**-networking address (e.g. `http://notify-api.railway.internal:8081`) — for the decision→notification push (`POST /system/notifications`, T13, ADR-0017). **Not** `<NOTIFY_API_URL>` (the public domain). | no |
| `NOTIFY_INTERNAL_TOKEN` | Same 1Password item as `auth.NOTIFY_INTERNAL_TOKEN`/`notify-api.NOTIFY_INTERNAL_TOKEN` — byte-for-byte identical (ADR-0017: now a THIRD caller sharing this secret). Consumed starting T13, not this bootstrap. | **yes** |
| `REFUND_S3_ENDPOINT` / `REFUND_S3_REGION` / `REFUND_S3_BUCKET` / `REFUND_S3_ACCESS_KEY_ID` / `REFUND_S3_SECRET_ACCESS_KEY` | EU-region S3-compatible object storage for receipt attachments (ADR-0016) — `REFUND_S3_REGION` validated against an EU allowlist at startup once T9 lands. **NOT YET PROVISIONED as of T19** — no bucket exists, no 1Password item exists. See this task's final report / § "Object storage — provisioning" below before T9. | **yes** |
| `REFUND_APP_BASE_URL` | **NEW (T14, specs/008-refund-monthly-processing, ADR-0021).** Absolute base URL of the shell-hosted app — **the shell's own public origin**, e.g. `https://operai.welld.io`, same value as `refund-api.ALLOWED_ORIGINS`/every other backend's shell-origin row — **not** `<REFUND_API_URL>`. Used to build the compiled-batch email's in-app deep link `${REFUND_APP_BASE_URL}/refund/batches/:id`; the email never carries a raw presigned S3 URL. | no |
| `NODE_ENV` | `production` | no |

**`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` — REMOVED (specs/011-refund-settings,
AC-4.1).** Do **NOT** set this on the `refund-api` Railway service — the
running service does not read, require, or validate it at all anymore. The
accounting-distribution-email is now an admin-managed, append-only
`refund_setting` row (ADR-0027/0029), viewable/editable in Admin > Refund
(`settings:read`/`settings:manage`). See the cutover runbook immediately
below for moving the currently-deployed value across.

**`refund-api` deploy notes:** no `numReplicas` pin (unlike `notify-api`) —
its `authzMiddleware` in-process cache (T6, ADR-0014) is a per-replica
performance optimization with a 30s TTL backstop, not a correctness-dependent
shared store, so normal Railway autoscale is fine. Region **must** be
`europe-west4` (data residency — financial figures + receipt-attachment
metadata that may carry PII, ADR-0016) and the service must never log
request/response bodies (same `hono/logger` posture as every other backend,
enforced in `refund-api/src/index.ts`, called out in `refund-api/Dockerfile`).

**Cutover — accounting-distribution-email setting (T5, specs/011-refund-settings,
D7).** A one-time, OPERATOR-RUN step, run **once**, immediately after this
deploy lands (the migration that creates `refund_setting` — T2 — must already
be applied). It is deliberately **not** a schema migration carrying the value
and **not** a server startup env read (AC-4.1 stays strictly honored — the
*running* `refund-api` process never touches
`REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`) — it is an idempotent maintenance
script an operator invokes explicitly, passing the value themselves:

```bash
cd refund-api
DATABASE_URL=<refund-api's production DATABASE_URL> \
  bun run settings:seed <the value currently deployed as REFUND_ACCOUNTING_DISTRIBUTION_EMAIL>
```

1. **Before removing the env var from Railway**, read the current
   `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL` value off the `refund-api` service
   (Railway dashboard → Variables).
2. Run the command above against **production's** `DATABASE_URL` (the `refund`
   database), passing that value. The script (`refund-api/scripts/seed-setting.ts`)
   appends ONE `refund_setting` row for key `accounting-distribution-email`
   **only if the key has no rows yet** — `createdByUserId:"system:settings-cutover"`,
   `createdByEmail:"system-cutover@welld.ch"` (a documented, honest first audit
   row — never attributed to a real admin who didn't actually make the
   change). A second run (accidental re-run, redeploy, CI retry) is a
   guaranteed no-op — it never appends a duplicate or overwrites anything
   (the table is append-only at the DB level, ADR-0027).
3. Verify: `GET /settings/accounting-distribution-email` (as an admin/
   `refund-admin`, via Admin > Refund or the API directly) shows
   `configured:true` with the expected value and `updatedByEmail:"system-cutover@welld.ch"`.
4. **Only after verifying step 3**, remove `REFUND_ACCOUNTING_DISTRIBUTION_EMAIL`
   from the `refund-api` Railway service's variables (it is already unused by
   the running code — this step is housekeeping, not a functional dependency).

There is no cron/scheduled version of this script and none should ever be
added (ADR-0013 posture, mirrors the mileage-rate/settings "derived-on-read,
never scheduled" lineage) — it is a single deliberate command run by a human
at cutover time, never a recurring job.

**Object storage — provisioning (human action, before T9 lands).** ADR-0016
names AWS S3 `eu-south-1` (Milan) or Scaleway Object Storage `fr-par` as
primary candidates (Cloudflare R2 + EU jurisdiction restriction as fallback):
"the exact vendor is an implementation-time choice within this allowlist."
None of this is provisioned yet. Before `refund-api/src/lib/storage.ts` (T9)
lands: (1) create the bucket in one of those EU regions/vendors: (2) create a
1Password item for its access key/secret (mirror the `AIScream/OperAI - …`
naming convention used by every other secret in this doc — do not invent a
placeholder vault path); (3) wire that item into `refund-api/.envrc` following
`auth/.envrc`'s `.env.cached` + `op read` pattern; (4) set the five
`REFUND_S3_*` Railway vars above for production.

### Frontend build-time vars (Vercel) — `VITE_*` are client-side; `*_REMOTE_URL` are Vite-config-side

| Project | Variable | Value |
|---|---|---|
| **shell** | `VITE_AUTH_URL` / `VITE_API_URL` | `<AUTH_URL>` / `<API_URL>` |
| | `VITE_NOTIFY_API_URL` | `<NOTIFY_API_URL>` — feeds `shell/session`'s trusted-origin allowlist and `getNotifyBaseUrl()` (the raise-capability, `useUnreadCount` SSE manager); also the origin `notify-ui` itself calls (mirrors `VITE_API_URL`/`VITE_AUTH_URL`) |
| | `VITE_REFUND_API_URL` | **NEW (T20, specs/007-refund-service).** `<REFUND_API_URL>` — feeds `shell/session`'s trusted-origin allowlist ONLY (`getTrustedOrigins()`, `shell/src/lib/session.ts`); `refund-ui` calls refund-api using its OWN copy of this same var (own build, see the `refund-ui` row below) — both copies MUST carry the identical `<REFUND_API_URL>` value or `apiFetch` will not recognize refund-ui's request origin as trusted and every call 401s. |
| | `ESTIMAI_REMOTE_URL` / `REFUND_REMOTE_URL` / `ADMIN_REMOTE_URL` | `https://<estimai/refund/admin>.operai.welld.io/remoteEntry.js` |
| **estimai-ui** | `VITE_API_URL` | `<API_URL>` — **required**: estimai-ui builds `${VITE_API_URL}/estimates` from its *own* value (must match the shell's) |
| | `VITE_AUTH_URL` / `SHELL_REMOTE_URL` | standalone-only / `https://operai.welld.io/remoteEntry.js` |
| **refund-ui** | `VITE_REFUND_API_URL` | **NEW (T20).** `<REFUND_API_URL>` — **required**: `refund-ui/src/lib/refundApi.ts` builds every refund-api URL from its *own* value (must byte-for-byte match the shell's copy above — see that row's note) |
| | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` |
| **admin-ui**, **notify-ui** | `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` (no backend vars of their own — `notify-ui`'s calls to `notify-api` go through the shared `shell/session` module's `VITE_NOTIFY_API_URL`, same pattern `admin-ui` uses for the auth service's admin API) |

Cross-service wiring: `auth.BETTER_AUTH_URL == estimai-api.AUTH_ISSUER ==
notify-api.AUTH_ISSUER == refund-api.AUTH_ISSUER`; `estimai-api.AUTH_JWKS_URL
== notify-api.AUTH_JWKS_URL == refund-api.AUTH_JWKS_URL == <AUTH_URL>/auth/jwks`;
all four backends' `ALLOWED_ORIGINS == shell origin`;
**`auth.AUTH_AUDIENCE == estimai-api.AUTH_AUDIENCE == notify-api.AUTH_AUDIENCE
== refund-api.AUTH_AUDIENCE`** (ADR-0010 — extended to `refund-api` as of
specs/007); **`auth.NOTIFY_INTERNAL_TOKEN == notify-api.NOTIFY_INTERNAL_TOKEN
== refund-api.NOTIFY_INTERNAL_TOKEN`** (ADR-0011, extended by ADR-0017 as of
specs/007 — a THIRD caller on one secret); `auth.NOTIFY_INTERNAL_URL ==
refund-api.NOTIFY_INTERNAL_URL` is notify-api's **private**-networking
address, distinct from `<NOTIFY_API_URL>`/`VITE_NOTIFY_API_URL` (the public
address every other row above uses); **`shell.VITE_REFUND_API_URL ==
refund-ui.VITE_REFUND_API_URL == <REFUND_API_URL>`** (T20 — two independent
Vercel projects, one value; a drift here silently breaks the Bearer-attach
trusted-origins check even though both builds succeed); **`refund-api.REFUND_APP_BASE_URL ==
refund-api.ALLOWED_ORIGINS == <shell origin>`** (T14, specs/008-refund-monthly-processing,
ADR-0021 — the compiled-batch email's deep link must resolve inside the same shell origin
CORS/trustedOrigins already allow; a drift here doesn't break the build, it just mails a
dead or untrusted link).

---

## Rollback & operations

- **Rollback:** each Railway service and each Vercel project keeps its own
  deployment history — redeploy the last good one from the dashboard. Frontends
  are independent, so rolling back one remote doesn't touch the others. If a
  Railway rollback crosses a migration boundary (older code, newer schema),
  restore Postgres from a backup or down-migrate **before** redeploying the older
  image — Railway doesn't reverse migrations.
- **Update one var later:** `railway variables --service <svc> --set "K=$K"` then
  `railway redeploy --service <svc>` (run inside the direnv shell if `K` is a
  secret). Frontend var changes need a Vercel **redeploy** (build-time).
- **EU residency (operational):** request/response bodies are never logged
  (hono/logger emits method+path+status only; Prisma `query` logging off in prod)
  across `auth`, `estimai-api`, `notify-api`, **and `refund-api`** (the last
  two handle notification title/body and financial/receipt-PII data
  respectively — the same no-body-logging rule applies to both). Don't add a
  CDN/log-aggregator/backup target that routes EU data outside the EU — this
  now also covers `refund-api`'s EU object-storage bucket once provisioned
  (ADR-0016).
- **`notify-api` single-replica constraint (specs/005 Risk R2):** never scale
  `notify-api` past `numReplicas: 1` (Railway dashboard autoscale or a
  `railway.json` edit) without first moving its EventBus fan-out and
  stream-ticket store onto Postgres `LISTEN`/`NOTIFY` + a shared ticket table
  — both are designed behind an interface for that migration, but the current
  in-process implementation silently breaks (missed events, ticket
  mint↔connect mismatches) across two or more instances.
- **`NOTIFY_INTERNAL_TOKEN` rotation (specs/006 ADR-0011 Risk R2, extended by
  specs/007 ADR-0017):** if compromise is suspected, generate a new value
  (`openssl rand -hex 32`), update the single 1Password item, then `railway
  variables --set "NOTIFY_INTERNAL_TOKEN=$NEW" --service auth` **and**
  `--service notify-api` **and** `--service refund-api`, and redeploy **all
  three** services close together — there is no dual-key grace period (unlike
  the JWKS keypair), so a gap between redeploys is a short window where every
  `POST /system/emails` AND `POST /system/notifications` call 401s. Never log
  the value; `railway variables` output containing it should not be pasted
  into chat/tickets.
- **`/system/emails` and `/system/notifications` network exposure (specs/006
  Risk R2, specs/007 ADR-0017):** the shared token is the enforced access
  control regardless of network path, but reduce exposure further by keeping
  `auth`'s and `refund-api`'s `NOTIFY_INTERNAL_URL` on notify-api's Railway
  **private**-networking hostname (never the public `<NOTIFY_API_URL>`
  domain) — these calls should never traverse the public internet.
  `notify-api` still needs its public domain for the browser-facing
  SSE/notification routes; there is currently no per-route network-level
  isolation (Railway private networking is per-service, not per-route) —
  flagged here, not solved, since splitting these internal routes onto a
  network-isolated deployment would be a new infra topology decision (ADR
  territory), not something to adopt unilaterally.
- **`refund-api` object storage not yet provisioned (T19 follow-up, human
  action required):** no EU-region bucket exists and no 1Password item exists
  for `REFUND_S3_*` — see § Variable reference's `refund-api` section, "Object
  storage — provisioning". `refund-api/src/lib/storage.ts` (T9) will consume
  these vars; local dev's placeholder values in `.env.example` are non-
  functional until a real bucket is created. This is the primary blocker for
  a genuine end-to-end T9 deploy verification (mint→confirm→signed-GET against
  a real bucket) — `bun test` itself does not require one (storage is mocked).
- **Secrets** are only ever referenced from the direnv/1Password shell, never
  pasted literally or committed; `.pem` files are gitignored; the pre-commit
  gitleaks hook guards commits.
