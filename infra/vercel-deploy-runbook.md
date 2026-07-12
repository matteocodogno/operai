# Operai — Vercel Deployment Runbook (suite shell)

Step-by-step guide to deploying the four frontend apps that make up the Operai
suite — **`shell`** (host), **`estimai-ui`** (remote), **`refund-ui`** (remote),
**`admin-ui`** (remote) — as four independent Vercel projects (specs/003-suite-shell,
T17, ADR-0006; `admin-ui` added by specs/004-auth-roles-permissions, T13/T25/T27).

This runbook **does not cover the backends** (`auth`, `estimai-api`) — see
`infra/README.md` (the Railway runbook) for those. It **replaces** the single
"point estimai-ui at the backends" step that runbook used to be the whole story
for; that runbook's Step 7 is now superseded by Step 5 below.

**Scope note (honesty):** this repo has no Vercel access. Nothing here has been
run against a real Vercel deployment — it is authored config + a documented
procedure, verified only insofar as `pnpm build` succeeds locally for all three
apps and the local e2e suite (`shell/e2e`) exercises the equivalent build-time
mechanism on `localhost`. Every step below that requires Vercel dashboard/CLI
access is a **pending human/deploy action**.

---

## Topology

```
Vercel (4 independent projects)                    Railway (europe-west4)
┌─────────────────────────────┐
│ shell            (host)      │──┐
│ https://operai.welld.io      │  │  loads remoteEntry.js cross-origin,
└─────────────────────────────┘  │  at runtime, in the browser
┌─────────────────────────────┐  │
│ estimai-ui       (remote)    │◄─┤                 ┌───────────────────────┐
│ https://estimai.operai.welld.io│ │                 │ auth (Railway)        │
└─────────────────────────────┘  │                 │ https://auth.operai.  │
┌─────────────────────────────┐  │                 │ welld.io              │
│ refund-ui        (remote)    │◄─┤                 ├───────────────────────┤
│ https://refund.operai.welld.io│  │                 │ estimai-api (Railway) │
└─────────────────────────────┘  │                 │ https://api.operai.   │
┌─────────────────────────────┐  │                 │ welld.io              │
│ admin-ui         (remote)    │◄─┘                 └───────────────────────┘
│ https://admin.operai.welld.io│
└─────────────────────────────┘
```

**PENDING DECISION — real hostnames.** The hostnames above
(`operai.welld.io`, `estimai.operai.welld.io`, `refund.operai.welld.io`,
`auth.operai.welld.io`, `estimai-api.operai.welld.io`) are the **proposed** scheme
this runbook and the committed `vercel.json` files use as placeholders — they
share the registrable parent domain `welld.io` on purpose (see "Shared parent
domain" below, plan.md Risk R7). They are not yet confirmed/provisioned. If
the real domains differ, **every reference below, and the literal strings in
`shell/vercel.json` / `estimai-ui/vercel.json`, must be updated to match** —
`vercel.json` headers/redirects are static JSON; Vercel does not interpolate
environment variables into them.

**Domain reassignment.** `https://operai.welld.io` is **currently** the
production Vercel domain for the `estimai-ui` project (see `infra/README.md`).
Per AC-4.3 the shell becomes the suite's single entry point, so this domain
must be **reassigned from the `estimai-ui` Vercel project to the `shell`
Vercel project** (Vercel dashboard → Domains → move/re-add), and `estimai-ui`
must be given a new, non-human-facing domain (`estimai.operai.welld.io`) used
only for serving `remoteEntry.js` to the shell. This is a manual Vercel
dashboard action — not something a `vercel.json` file can do.

---

## Shared parent domain (plan.md Risk R7 / ADR-0001 risk 2)

All five hostnames above share the registrable parent `welld.io`. This
matters for the credentialed, cookie-authenticated `GET /auth/token` call
`shell/session` makes (ADR-0001): browsers apply increasingly strict
third-party-cookie heuristics, and same-registrable-domain siblings fare
better under those heuristics (and are eligible for future mitigations like
the Storage Access API) than fully unrelated domains would. **This is the
mitigation plan.md commits to** — if the real production domains end up on a
different registrable parent, re-open Risk R7 before shipping: the fallback
is bearer-only mode with re-login required on every hard refresh (documented
in ADR-0001, degrades UX, not security).

---

## Step 1 — Create the four Vercel projects

For each of `shell`, `estimai-ui`, `refund-ui`, `admin-ui`:

1. Vercel dashboard → **New Project** → import this GitHub repo.
2. **Root Directory** = the app's directory (`shell`, `estimai-ui`,
   `refund-ui`, or `admin-ui`). Framework preset: **Vite**.
3. Build command / output directory: leave the Vite defaults (`pnpm build` /
   `dist`) — each app's `package.json` already defines `build: "tsc -b && vite
   build"`.
4. Each app ships its own `vercel.json` (committed in this task, or — for
   `admin-ui` — in T27, specs/004-auth-roles-permissions) with SPA rewrites +
   headers — Vercel picks it up automatically from the project root.

---

## Step 2 — Assign domains

| Project | Domain | Notes |
|---|---|---|
| `shell` | `https://operai.welld.io` | **Reassign** from `estimai-ui` (see above) — this is the human-facing entry point (AC-4.3) |
| `estimai-ui` | `https://estimai.operai.welld.io` | Remote-only; not linked from anywhere in the product, but see Step 4's redirect for defense-in-depth |
| `refund-ui` | `https://refund.operai.welld.io` | Remote-only; never had a standalone production URL (no redirect needed, unlike estimai-ui) |
| `admin-ui` | `https://admin.operai.welld.io` | Remote-only; never had a standalone production URL (no redirect needed, same as refund-ui). specs/004-auth-roles-permissions (T13/T27). |

If the confirmed real hostnames differ from this proposal, update them here
**and** in `shell/vercel.json`'s CSP header and `estimai-ui/vercel.json`'s
redirect destination (both are static, not env-parameterized — see the
scope note in each file's context below).

---

## Step 3 — Environment variables (build-time)

Each project's Vercel dashboard → **Settings → Environment Variables**. Set
per-environment (Production vs. Preview) since preview remotes usually don't
share the production hostnames.

> The canonical variable reference (both platforms, with the `VITE_*` vs
> unprefixed distinction and the standalone-only caveats) is
> **`infra/variables.md` → "Frontend build-time variables (Vercel)"**. The
> tables below are the procedural per-project view; keep the two in sync.

### `shell`

| Variable | Production value | Notes |
|---|---|---|
| `VITE_AUTH_URL` | `https://auth.operai.welld.io` | `<AUTH_URL>` from `infra/README.md` |
| `VITE_API_URL` | `https://estimai-api.operai.welld.io` | `<API_URL>` from `infra/README.md` |
| `ESTIMAI_REMOTE_URL` | `https://estimai.operai.welld.io/remoteEntry.js` | Build-time default (see Step 5 for the runtime override layer) |
| `REFUND_REMOTE_URL` | `https://refund.operai.welld.io/remoteEntry.js` | Build-time default |
| `ADMIN_REMOTE_URL` | `https://admin.operai.welld.io/remoteEntry.js` | Build-time default for the Admin (Roles & Permissions) remote (specs/004-auth-roles-permissions, T25) — same runtime-override layer as the two above (Step 5, `shell/src/lib/runtimeRemotes.ts`) |

### `estimai-ui`

| Variable | Production value | Notes |
|---|---|---|
| `VITE_API_URL` | same as shell's (`https://estimai-api.operai.welld.io`) | **REQUIRED in production** — estimai-ui's `src/lib/estimatesApi.ts` builds `${VITE_API_URL}/estimates` from **its own** baked value, so this sets **where** EstimAI's data calls go. Must match the shell's `VITE_API_URL` (shell decides *whether* the JWT is attached to that origin; this sets the origin). Redeploy after setting. |
| `VITE_AUTH_URL` | same as shell's | **Standalone-only** — auth/session is owned by the shell (`shell/session`); estimai-ui's `authClient.ts` isn't imported by prod code. Only the dev/test standalone bootstrap reads it. No production effect on the remote. |
| `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` | **REQUIRED in production** — baked into estimai-ui's bundle; when mounted in the shell, estimai-ui imports `shell/session`/`shell/tokens.css` from **this** `remoteEntry.js`. Unset ⇒ dev-default `http://localhost:5173/remoteEntry.js` is baked ⇒ the shell's CSP blocks it ⇒ `[RemoteMount] failed to load remote module "EstimAI"`. **Redeploy** after setting. NOT the same as the `VITE_*` standalone-only caveat above. |

### `refund-ui`

| Variable | Production value | Notes |
|---|---|---|
| `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` | **REQUIRED in production** — same as estimai-ui's `SHELL_REMOTE_URL` (refund-ui imports `shell/session`/`shell/tokens.css` from the shell when mounted). Unset ⇒ dev-default `localhost:5173` baked ⇒ CSP-blocked ⇒ Refund fails to mount. |

refund-ui has no direct backend vars of its own today (see `refund-ui/.env.example`).

### `admin-ui`

| Variable | Production value | Notes |
|---|---|---|
| `SHELL_REMOTE_URL` | `https://operai.welld.io/remoteEntry.js` | **REQUIRED in production** — same as estimai-ui's/refund-ui's `SHELL_REMOTE_URL` (admin-ui imports `shell/session`/`shell/tokens.css` from the shell when mounted; T13, specs/004-auth-roles-permissions). Unset ⇒ dev-default `localhost:5173` baked ⇒ CSP-blocked ⇒ Admin fails to mount. |

admin-ui has no direct backend vars of its own today (see `admin-ui/.env.example`) — like
refund-ui, it has no direct calls to `auth`'s Admin API; those go through the shared
`shell/session` `apiFetch`.

After setting/changing these, **redeploy the affected project** — they are
build-time (`process.env` read in each `vite.config.ts`), same as
`infra/README.md`'s existing Vite-env-vars-need-a-redeploy note.

---

## Step 4 — The EstimAI → shell redirect (AC-4.3)

`estimai-ui/vercel.json` ships a redirect:

```json
{
  "source": "/(.*)",
  "has": [{ "type": "header", "key": "sec-fetch-dest", "value": "document" }],
  "destination": "https://operai.welld.io/estimai",
  "permanent": false
}
```

**Why gated on `sec-fetch-dest: document`, not a blanket redirect:**
`estimai-ui`'s domain must keep serving `remoteEntry.js` and its JS chunks to
the shell — a blanket `/(.*)` redirect would redirect *those* fetches too and
break federation entirely. Browsers tag top-level navigations (typing the
URL, following a link/bookmark) with `Sec-Fetch-Dest: document`; the
federation runtime's dynamic `import()` of `remoteEntry.js`/chunks is tagged
`script` (or `empty` for plain `fetch()`), never `document`. The redirect
therefore only fires for a human actually landing on the old URL, never for
the shell fetching the remote — this was reasoned through, not verified
against a live Vercel deploy (no Vercel access in this environment); **treat
it as needing a real smoke test on first production deploy** (visit
`https://estimai.operai.welld.io/` in a browser → expect a redirect to
`https://operai.welld.io/estimai`; then confirm the shell still loads EstimAI
normally, proving `remoteEntry.js` wasn't caught by the same rule).

`302`/temporary (`permanent: false`) is deliberate — if the domain topology
changes again later, a `301` would be cached by browsers past its usefulness.

---

## Step 5 — Runtime remote-URL resolution (AC-5.3, plan.md Risk R6)

**The problem:** `shell/vite.config.ts` reads `ESTIMAI_REMOTE_URL` /
`REFUND_REMOTE_URL` from `process.env` at **Vite config-evaluation time**
(i.e. `vite build`) and bakes the resulting URL as a literal string into the
shell's compiled bundle. Changing a remote's URL therefore used to require
rebuilding the shell — even though the shell's own code hadn't changed.

**The fix (implemented, T17):** `shell/src/main.tsx` now calls
`@module-federation/runtime`'s `registerRemotes(remotes, { force: true })`
**before** the router mounts (see `shell/src/lib/runtimeRemotes.ts`), with
URLs resolved **in the browser, at every page load**, in priority order:

1. `window.__OPERAI_RUNTIME_CONFIG__` (not set by anything in this repo
   today — an escape hatch for a future injection mechanism).
2. A same-origin `GET /runtime-config.json` fetched with `cache: 'no-store'`.

If neither yields a value, `registerRemotes` is skipped entirely and the
build-time `ESTIMAI_REMOTE_URL`/`REFUND_REMOTE_URL` values from Step 3 govern
— this is the state of local dev and the T16 e2e suite today, and it remains
a perfectly valid production state (see next paragraph).

**When you actually need `runtime-config.json`:** if `estimai-ui`/`refund-ui`
keep **stable custom domains** across their own redeploys (Step 2's scheme),
a remote redeploy never changes the URL the shell already has baked in — so
most of the time you need **do nothing** for AC-5.3; the new content is just
served at the same URL on the shell's next `import()`. `runtime-config.json`
matters only when a remote's **origin itself** changes (domain migration, or
temporarily pointing production at a hotfix preview deploy) — in that case:

1. Copy `shell/public/runtime-config.example.json` to a new
   `runtime-config.json` (same shape) with the new URL(s).
2. Add it as a static file to the `shell` Vercel project's deploy output (or
   push it as a static-file-only redeploy) — Vercel will serve it fresh
   (`Cache-Control: must-revalidate`, set in `shell/vercel.json`) to every
   subsequent page load, no shell **code** rebuild required.

**Honest limitation:** publishing a new `runtime-config.json` is still a
*deployment* of the `shell` Vercel project (a static site's assets ship
together) — it is not literally zero-touch. What this layer buys is that the
shell's **JS bundle is byte-identical**; only a small JSON data file changes,
decoupling "the shell's code" from "which origin a remote currently lives
at." This was a deliberate scope decision (see the T17 report) over a full
dynamic-remote rewrite of every app, specifically to avoid destabilizing the
18/18-green T16 e2e suite, which continues to rely on the pre-existing
build-time env-var mechanism unchanged.

---

## Step 6 — `auth` ALLOWED_ORIGINS (REQUIRED, pending human action)

`auth/.env` is a protected file this task cannot edit. **A human must**
update the deployed `auth` Railway service's `ALLOWED_ORIGINS` env var (see
`infra/README.md` Step 3, or `railway variables --service auth --set
"ALLOWED_ORIGINS=..."`) to include the shell's production origin:

```
ALLOWED_ORIGINS=https://operai.welld.io
```

Per ADR-0002/ADR-0006, only the **shell**'s origin needs to be listed —
`estimai-ui`/`refund-ui`/`admin-ui` never call `auth` directly in production
(they delegate to `shell/session`, which runs under the shell's origin
regardless of which remote is mounted, since federated modules execute in
the host document). `auth/.env.example` has been updated with this note (not
a real secret, template only). See `infra/README.md` Step 3 for the full
variable list and the direnv/1Password mechanics.

**admin-ui note (T27, specs/004-auth-roles-permissions):** the new Admin
remote follows the exact same delegation as estimai-ui/refund-ui (see
`admin-ui/vite.config.ts` — it consumes `shell`, exposing only `./App`, and
`admin-ui/src/main.tsx`/`adminApi.ts` import `apiFetch` from `shell/session`,
never holding their own copy). So `https://admin.operai.welld.io` does **not**
need its own entry in `auth`'s `ALLOWED_ORIGINS` either — only the shell's
origin above. This is a documentation note, not a code change: no `admin-ui`
origin was added to `ALLOWED_ORIGINS` because none is required by the
existing pattern.

**Redeploy `auth`** after changing this (`railway redeploy --service auth`)
for the CORS/trustedOrigins change to take effect.

---

## Step 7 — Shell CSP (R5, security-sensitive — owasp-reviewer pass at T19)

`shell/vercel.json` ships a `Content-Security-Policy` HTTP header (not a
`<meta>` tag — meta-tag CSP cannot carry `frame-ancestors`, and putting it in
`vercel.json` means it is **never evaluated by `vite preview`**, so it cannot
affect the T16 e2e suite, which was a deliberate risk-avoidance choice):

```
default-src 'self';
script-src 'self' https://estimai.operai.welld.io https://refund.operai.welld.io https://admin.operai.welld.io;
connect-src 'self' https://auth.operai.welld.io https://estimai-api.operai.welld.io
            https://estimai.operai.welld.io https://refund.operai.welld.io https://admin.operai.welld.io;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com data:;
img-src 'self' data: https://*.googleusercontent.com https://avatars.githubusercontent.com;
object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
```

**admin-ui origin — verified present (T27):** `https://admin.operai.welld.io`
was added to both `script-src` and `connect-src` by T25 (specs/004-auth-roles-permissions)
ahead of this task; re-checked here against the committed `shell/vercel.json` — both
directives include it, so no further shell CSP change was needed for T27.

Notes:
- **Pinned, not wildcarded** (plan.md Security / R5 requirement) — each
  remote origin and the auth/API origins are listed explicitly.
- `style-src 'unsafe-inline'` is a deliberate, narrower trade-off (inline
  `style` attributes only, not `script-src`) — the shell's theme-flash-avoidance
  script was moved to an external file (`public/theme-init.js`) specifically
  so `script-src` does **not** need `'unsafe-inline'`. Flagging for the T19
  owasp-reviewer pass rather than resolving unilaterally: removing it would
  require auditing every inline `style={{...}}` React prop in the shell and
  its remotes for a nonce/hash strategy.
- **Preview deployments are a known gap.** This CSP is a single static file
  applied to every deployment of the `shell` project. Vercel Preview
  deployments default to `*.vercel.app` URLs that do **not** match these
  pinned origins, so cross-origin remote loading (and thus the whole app)
  would be CSP-blocked on Preview unless: (a) Preview deployments are also
  assigned matching custom subdomains under `welld.io`, or (b) an Edge
  Middleware function relaxes the CSP conditionally on `VERCEL_ENV=preview`.
  Neither is implemented here — introducing Vercel Edge Middleware is new
  infra tooling and, per this project's conventions, an ADR-worthy decision
  to make deliberately, not something to adopt unilaterally inside a deploy-
  wiring task. **Flagging as a pending follow-up**, not a silent gap.
- `shell/vercel.json` also sets `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`
  as universal (non-origin-specific) hardening, plus CORS (`Access-Control-Allow-Origin:
  *`) and revalidate-on-every-request caching for `/remoteEntry.js`, and
  long-lived immutable caching for hashed `/assets/*` chunks — `estimai-ui`,
  `refund-ui`, and `admin-ui`'s `vercel.json` mirror the same
  `remoteEntry.js`/`assets` headers, since they are remotes too.

---

## Step 8 — `apiFetch` trusted-origin allowlist (ADR-0001) — verified, no change needed

`shell/src/lib/session.ts`'s `getTrustedOrigins()` already covers: same-origin
(the current page — i.e. wherever the shell's document is served from,
regardless of which remote is mounted inside it), `VITE_AUTH_URL`, and
`VITE_API_URL` (set in Step 3). Because `estimai-ui`/`refund-ui` (T13/T15,
specs/003-suite-shell) and, as of specs/004-auth-roles-permissions, `admin-ui`
(T13) all delegate to `shell/session` rather than holding their own
`apiFetch`, **the code that actually runs is the shell's own compiled
`getTrustedOrigins()`, reading the shell's own build-time env vars** —
confirmed by reading `estimai-ui/src/lib/api.ts` (`export { apiFetch,
clearJwtCache } from 'shell/session'`), `admin-ui/src/lib/adminApi.ts`
(imports `apiFetch` the same way), and `playwright.config.ts`'s own comment
to the same effect. No remote ever needs its own entry in this allowlist,
and no code change was required for this task (or for T27).

---

## Step 9 — Verify (post-deploy, pending — cannot be run from this environment)

```bash
# Health/reachability
curl -fsSI https://operai.welld.io/                       | head -1   # 200
curl -fsSI https://estimai.operai.welld.io/remoteEntry.js  | head -1   # 200, check CORS header
curl -fsSI https://refund.operai.welld.io/remoteEntry.js   | head -1   # 200, check CORS header
curl -fsSI https://admin.operai.welld.io/remoteEntry.js    | head -1   # 200, check CORS header

# AC-4.3 — old EstimAI URL redirects into the shell
curl -fsSI https://estimai.operai.welld.io/                | grep -i '^location:'
# expect: location: https://operai.welld.io/estimai

# CSP present, and includes the admin-ui origin (T25/T27)
curl -fsSI https://operai.welld.io/ | grep -i content-security-policy
```

Then in a browser: visit `https://operai.welld.io/`, sign in, confirm EstimAI,
Refund, and Admin all load inside the shell chrome (open DevTools → Network
→ confirm `remoteEntry.js` requests to all three remote origins succeed with
no CSP console errors), sign out, confirm the session is gone suite-wide.

---

## Rollback

Same model as `infra/README.md`: each Vercel project keeps its own deployment
history; roll back the affected project's deployment via the dashboard.
Because the four apps are independently deployed, rolling back `refund-ui`
or `admin-ui` alone (for example) has no effect on `shell` or the other
remotes — this independence is the whole point of AC-5.3.
