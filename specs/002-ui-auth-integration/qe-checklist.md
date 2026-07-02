# T12 — Manual QE: live OAuth round trips

Covers the acceptance criteria that **cannot run headlessly** (real provider OAuth):
**AC-2.2** (OAuth completes with Google/GitHub, session persists across reload) and
**AC-2.3** (abandoned/denied OAuth → human-readable error banner, both providers stay
retry-able). The automated e2e (T9–T11) uses a seeded test session and explicitly defers
the live provider round trip to this checklist.

> Execute against the **locally running stack**. Record each item pass/fail with the date
> and tester. Do not check the T12 task box until every item has a recorded result.

---

## Prerequisites (one-time setup)

### 1. Register OAuth apps (real credentials)

**Google** — https://console.cloud.google.com/apis/credentials → *Create OAuth client ID*
→ type *Web application*.
- Authorized redirect URI: `http://localhost:3001/auth/callback/google`
- Copy the **Client ID** and **Client secret**.

**GitHub** — https://github.com/settings/developers → *New OAuth App*.
- Homepage URL: `http://localhost:5173`
- Authorization callback URL: `http://localhost:3001/auth/callback/github`
- Copy the **Client ID** and generate a **Client secret**.

### 2. Put the credentials in `auth/.env` (gitignored — never commit)

```
GOOGLE_CLIENT_ID=<real>
GOOGLE_CLIENT_SECRET=<real>
GITHUB_CLIENT_ID=<real>
GITHUB_CLIENT_SECRET=<real>
```
Leave the rest of `auth/.env` as-is (DB URL, `BETTER_AUTH_SECRET`, JWT keypair,
`ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000`, `UI_HOME_URL`).
Do **not** set `ENABLE_TEST_AUTH` for this run — this is the real OAuth path.

### 3. Bring up the stack

```bash
docker compose up -d                       # Postgres on :5435
cd auth && bun run db:migrate              # if not already migrated
cd auth && NODE_ENV=development bun run dev # auth service on :3001
cd estimai-ui && VITE_AUTH_URL=http://localhost:3001 pnpm dev  # UI on :5173
```
Health check: `curl http://localhost:3001/health` → `200`.

> **Session cleanliness:** these tests must start signed-out. Before each sign-in item,
> clear the EstimAI site cookies (or use a fresh private/incognito window) so the login
> wall actually fires.

---

## Checklist

Legend: **Result** = PASS / FAIL / BLOCKED · fill **Date** and **Tester** on execution.

### AC-2.1 — both providers offered (live smoke)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| 1 | Visit `http://localhost:5173/estimates` while signed out | Redirected to the auth `/sign-in` page; **both** "Continue with Google" and "Continue with GitHub" buttons visible, Operai-styled | **PASS** | 2026-07-02 | Matteo |

### AC-2.2 — Google sign-in completes, session persists

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| 2 | Click "Continue with Google", complete the Google consent | Redirected back to EstimAI; you land on the originally-requested page (`/estimates`) — the deep-link `redirect` is honored | **PASS** | 2026-07-02 | Matteo |
| 3 | Confirm identity in the header | The UserMenu shows your Google name/avatar | **PASS** | 2026-07-02 | Matteo |
| 4 | Full page reload (F5) | Still signed in — no bounce to `/sign-in`; app content stays | **PASS** | 2026-07-02 | Matteo |
| 5 | Open a new tab to `http://localhost:5173/` | Session shared (cookie) — lands in the app, not the wall | **PASS** | 2026-07-02 | Matteo |

> Note on #3: the Google avatar initially did not render (provider 403/429 on cross-origin
> `Referer`); fixed by adding `referrerPolicy="no-referrer"` to the UserMenu `<img>`
> (commit `e755e95`). Re-verified rendering after the fix.

### AC-2.2 — GitHub sign-in completes, session persists

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| 6 | Sign out (UserMenu → Sign out), then sign in via "Continue with GitHub" | GitHub consent → redirected back signed in | **PASS** | 2026-07-02 | Matteo |
| 7 | Header identity + reload persistence | UserMenu shows GitHub name/avatar; reload keeps the session | **PASS** | 2026-07-02 | Matteo |

> Note on #6: an initial GitHub 404 was a setup issue (client ID/secret swapped in
> `auth/.env`), not a product defect — corrected and re-run.

### AC-2.3 — abandoned / denied OAuth → error banner + retry

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| 8 | Start "Continue with Google", then **cancel/deny** at Google's consent screen | Returned to the EstimAI `/sign-in` page with a **human-readable error banner** (not a raw code / not a crash); **both** provider buttons remain present and clickable | _pending_ | | |
| 9 | Immediately retry — click "Continue with GitHub" and complete it | Sign-in succeeds on retry (the earlier failure did not lock the flow) | _pending_ | | |
| 10 | (Optional) Repeat step 8 for GitHub (deny authorization) | Same: error banner + retry-able buttons | _pending_ | | |

### Sign-out (real session termination, live)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| 11 | While signed in, click Sign out | Redirected to `/sign-in`; navigating back to `/estimates` bounces to the wall (session ended server-side, not just client cookie) | **PASS** | 2026-07-02 | Matteo |

---

## Result summary

- **Executed on:** _<date>_ by _<tester>_
- **Environment:** local (auth :3001, UI :5173, Postgres :5435), real Google + GitHub OAuth apps
- **Overall:** _PASS / FAIL_
- **Notes / defects:** _<anything observed — screenshots welcome under specs/002-ui-auth-integration/evidence/>_

> When all items are PASS, check the **T12** box in `tasks.md`. Any FAIL → file it as a
> defect and route the fix through `/wellforge:implement` before closing T12.
