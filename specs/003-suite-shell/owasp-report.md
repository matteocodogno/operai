# OWASP review — 003-suite-shell (T19)

**Verdict: PASS** — `0 critical · 0 high · 0 medium · 2 low`. No medium-or-above findings.
Reviewer: `wellforge:owasp-reviewer`. Date: 2026-07-10.

Scope: the Module-Federation shell + two remotes + deploy wiring introduced by
specs/003 — federation config, session/token handling, routing/guard, the three
`vercel.json`, and the `auth` test-auth gating (read-only).

## Findings

### L1 (low) — missing baseline CSP on the two remote `vercel.json` — **FIXED in T19**
`estimai-ui/vercel.json` and `refund-ui/vercel.json` set security headers but no
Content-Security-Policy on their own document responses. Remote documents are
normally unreachable (estimai-ui redirects `sec-fetch-dest: document` navigations to
the shell; refund-ui has no standalone prod URL), and remote code executing *inside*
the shell is governed by the shell's CSP regardless — so exposure was narrow. Added a
baseline CSP to both files' `/(.*)` header block (mirrors the shell's non-remote
directives) for defense-in-depth against a proxy/older client that omits
`Sec-Fetch-Dest` or a future regression of the redirect rule.

### L2 (low / advisory, accepted) — `auth/.env.example` ships `ENABLE_TEST_AUTH=true`
The committed example uncomments `ENABLE_TEST_AUTH=true` (with a loud warning banner).
Production gating is defense-in-depth solid — double-gated (`auth/src/index.ts`
module-load gate + `test-auth.routes.ts` request-time gate), `NODE_ENV` defaults to
`development` but Railway explicitly sets `NODE_ENV=production` and `bootstrap.sh`
omits `ENABLE_TEST_AUTH` — so a prod deploy cannot enable the test-auth session-mint
via the example default. Residual risk is only a developer copying `.env.example`
without reading the banner. **Accepted as-is** (the file is the local-dev/CI default
the e2e suite legitimately needs; no production exposure). No fix.

## Confirmed-safe (no action)
- **CSP pinning (R5):** shell `script-src` pinned to self + the two remote origins; no
  wildcard / `unsafe-eval` / `unsafe-inline` in `script-src`. `connect-src` includes
  auth/api/both remotes. `object-src 'none'`, `frame-ancestors 'none'`, `base-uri
  'self'`, `form-action 'self'`. `style-src 'unsafe-inline'` scoped to inline style
  attributes only (theme script extracted to `public/theme-init.js`) — accepted.
- **Runtime remote injection:** `registerRemotes` overrides are same-origin-only; a
  tampered `runtime-config.json` pointing at a hostile origin is **blocked by the
  pinned `script-src` CSP** at load — a verified functioning backstop.
- **Token-origin allowlist (ADR-0001):** Bearer JWT attached only to same-origin /
  `VITE_AUTH_URL` / `VITE_API_URL`; remote origins are NOT in the allowlist (remotes
  run in the shell's origin, share the module not the origin). In-memory JWT invariant
  holds (no storage write of the token).
- **Open-redirect on the guard:** shell sends raw `window.location.href` as `redirect`;
  validated **server-side** in `auth/src/signin/signin.routes.ts` against
  `ALLOWED_ORIGINS` with regression tests (evil.com, subdomain confusion, non-URL).
- **Root-landing localStorage:** `resolveLastToolPath` validates `operai_last_tool`
  against the fixed `TOOLS` union; a tampered value falls back to the default, never
  echoed into a URL.
- **Single sign-out (AC-2.4):** clears the in-memory JWT before `authClient.signOut()`;
  e2e proves the **server-side** session row is gone, then the guard blocks the next nav.
- **CORS on `remoteEntry.js`:** `ACAO: *` scoped to `/remoteEntry.js` only — a public,
  non-credentialed static module; acceptable.
- **Backends (auth, estimai-api):** unchanged by this feature; `ALLOWED_ORIGINS`
  guidance now correctly scopes to the shell origin (remotes make no own token calls).

## Known documented follow-up (not a security exposure)
- **Preview-URL CSP gap:** Vercel `*.vercel.app` preview deploys would be CSP-blocked
  (fails **closed**, not open). Documented in `infra/vercel-deploy-runbook.md` Step 7;
  needs custom preview subdomains or Edge Middleware (ADR-worthy). No action for T19.
