# EstimAI — Manual Test Book

End-to-end manual QA for the shipped features:
- **002 — UI auth integration** (login wall, Google/GitHub sign-in, session, sign-out)
- **001 — Estimate persistence** (save, list, reopen, delete, size guard, one-time import, privacy)

Automated tests (unit + Playwright e2e) already cover these; this book is for **manual
release verification** — real OAuth round trips and human-observable behaviour that
headless tests can't fully exercise. Record each item **PASS / FAIL / BLOCKED** with the
date and tester. A row's **Expected** is the pass condition.

> Legend: **PASS** = observed as expected · **FAIL** = deviated (file a defect) · **BLOCKED** = couldn't run (note why) · **N/A** = not applicable.

---

## 0. Environment setup (one-time, before testing)

The full stack is four processes. Ports: Postgres `5435`, auth `3001`, estimai-api `8080`, UI `5173`.

### 0.1 OAuth apps (real credentials — needed for §B live sign-in)
- **Google** — console.cloud.google.com/apis/credentials → *Create OAuth client ID* → *Web application*. Authorized redirect URI (exact): `http://localhost:3001/auth/callback/google`.
- **GitHub** — github.com/settings/developers → *New OAuth App*. Homepage `http://localhost:5173`; Authorization callback URL (exact): `http://localhost:3001/auth/callback/github`.
- Put the four values (`GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`) in `auth/.env`. The **Client ID** is the short one; the **secret** is the 40‑char one — do not swap them.

### 0.2 Bring up the stack
```bash
# 1. Database
docker compose up -d                    # Postgres 17 on :5435

# 2. Auth service (:3001)
cd auth
cp .env.example .env                     # fill: OAuth creds, BETTER_AUTH_SECRET (≥32 chars),
                                         # JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (openssl), 
                                         # ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
                                         # UI_HOME_URL=http://localhost:5173
bun install && bun run db:migrate && bun run dev

# 3. estimai-api (:8080) — new terminal
cd estimai-api
cp .env.example .env                     # fill: DATABASE_URL (estimai DB on :5435),
                                         # AUTH_JWKS_URL=http://localhost:3001/auth/jwks   ← NOTE: /auth/jwks
                                         # AUTH_ISSUER=http://localhost:3001
                                         # ALLOWED_ORIGINS=http://localhost:5173
bun install && bun run db:migrate && bun run dev

# 4. UI (:5173) — new terminal
cd estimai-ui
pnpm install
VITE_AUTH_URL=http://localhost:3001 VITE_API_URL=http://localhost:8080 pnpm dev
```

### 0.3 Health checks (must all pass before starting)
| # | Command | Expected | Result | Date | Tester |
|---|---------|----------|--------|------|--------|
| 0.a | `curl -s localhost:3001/health` | 200 `{"status":"ok",...}` | | | |
| 0.b | `curl -s localhost:3001/auth/jwks` | 200 with a `keys` array (this is the JWKS estimai-api verifies against) | | | |
| 0.c | `curl -s localhost:8080/health` | 200 `{"status":"ok","db":{"status":"ok"}}` | | | |
| 0.d | Open `http://localhost:5173/` | Redirects to the auth sign-in page (login wall) | | | |

> Tip: use a fresh **incognito window** for each sign-in test so the login wall actually fires. Have **two different Google/GitHub accounts** (or a second browser profile) available for the privacy test (§G).

---

## A. Access control — the login wall (002: US-1, US-4)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| A1 | While **signed out**, visit `http://localhost:5173/` | Redirected to the auth `/sign-in` page; **no** app content flashes first | | | |
| A2 | Signed out, visit a deep link `http://localhost:5173/estimates` | Redirected to `/sign-in`; the URL carries `?redirect=` pointing back to `/estimates` | | | |
| A3 | Signed out, visit `http://localhost:5173/share` | Also redirected to `/sign-in` (share is behind the wall too) | | | |
| A4 | On the sign-in page, inspect the buttons | Both **Continue with Google** and **Continue with GitHub** are shown, Operai-styled (dark ink, purple accent, DM Sans/Syne) | | | |

## B. Sign-in — live OAuth (002: US-2, AC-2.2)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| B1 | From the deep-link redirect (A2 flow), click **Continue with Google**, complete consent | Returned to EstimAI and landed on the **originally-requested page** (`/estimates`) | | | |
| B2 | Open `/sign-in` directly (no prior deep link) and complete Google sign-in | Landed on the EstimAI **home** (estimates list) | | | |
| B3 | Reload the page (F5) after signing in | Still signed in — no bounce to sign-in | | | |
| B4 | Open a new tab to `http://localhost:5173/` | Session shared (cookie) — lands in the app, not the wall | | | |
| B5 | Sign out, then sign in via **Continue with GitHub** | GitHub consent → returned signed in | | | |
| B6 | (AC-2.3 failure path) Start **Continue with Google**, then **cancel/deny** at Google's consent screen | Returned to `/sign-in` with a **human-readable error banner** (not a raw code / crash); **both** provider buttons still clickable | | | |
| B7 | Immediately retry with the other provider after B6 | Sign-in succeeds — the earlier cancel didn't lock the flow | | | |

## C. Identity & sign-out (002: US-5)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| C1 | While signed in, look at the header | The UserMenu shows your name and/or **avatar** (avatar image actually renders — Google avatars need no-referrer, already handled) | | | |
| C2 | Click **Sign out** | Session ends; you're returned to `/sign-in` | | | |
| C3 | After sign-out, try to visit `/estimates` | Redirected to `/sign-in` (session terminated **server-side**, not just the browser cookie) | | | |

---

## D. Save an estimate to my account (001: US-1)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| D1 | Signed in, click **+ New estimate** | A new estimate opens in the editor (created server-side; no error/alert) | | | |
| D2 | Set the estimate **name** and **author**, add an **activity** (epic/name/O/ML/P), add a **release** | Edits apply; after ~1.5 s the save indicator shows "Saving…" then "✓ Saved" | | | |
| D3 | Confirm auto-save persisted (open DevTools → Network) | A `PUT /estimates/{id}` fires to `:8080` and returns 200 after edits settle | | | |
| D4 | Edit again after the first save | Updates in place — a `PUT` (not a new `POST`); **no duplicate** estimate is created | | | |
| D5 | (AC-1.3 failure path) Stop the estimai-api service (`Ctrl-C` its terminal), then make an edit | A **ToastBanner** error appears AND your in-editor work is **not lost** (name/activities intact). Restart estimai-api → next save clears the error | | | |

## E. List & reopen (001: US-2)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| E1 | Go to the estimates list | While loading, a **skeleton** shows; then every saved estimate appears with at least its **name** and **last-modified** date | | | |
| E2 | Reopen the estimate saved in §D | Editor loads the **exact** content you saved — same name, author, the activity/release you added | | | |
| E3 | Check the computed metrics on reopen (MetricsBar: Total Man/Days, Elapsed, etc.) | Values render and match the estimation model for that content (not stale/blank) | | | |
| E4 | (Fresh account) Sign in as a brand-new user with no estimates | The list shows an **empty state** (no error) | | | |

## F. Delete (001: US-3)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| F1 | In the list, click an estimate's delete (×) | An accessible **confirm modal** opens; keyboard focus lands on **Cancel** (not Delete) | | | |
| F2 | Press **Escape** (or click Cancel) | Modal closes, estimate **still present** (no delete) | | | |
| F3 | Delete again and click **Delete** to confirm | Estimate disappears from the list and is no longer reachable | | | |
| F4 | (a11y) Tab through a list row's delete control with a screen reader / inspect | The delete control has an `aria-label` naming the estimate (e.g. `Delete "<name>"`) | | | |

## G. Privacy — estimates are mine only (001: US-4)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| G1 | As **User A**, create + save an estimate; note its ID (from the URL `/estimates/<id>`) | Estimate saved under A | | | |
| G2 | Sign out; sign in as a **different User B** (second account/profile). Open the estimates list | B does **not** see A's estimate | | | |
| G3 | As B, manually visit `http://localhost:5173/estimates/<A's-id>` | Not shown A's data — bounced to the list / not-found (never A's content) | | | |
| G4 | (API-level, optional) With B's Bearer token, `curl -H "Authorization: Bearer <B-jwt>" localhost:8080/estimates/<A-id>` | **404** (not 403, not 200) — no cross-user leak | | | |
| G5 | (API-level) `curl localhost:8080/estimates` with **no** token | **401** RFC 7807 Problem JSON; no data returned | | | |

## H. One-time import of local estimates (001: US-5)

> Setup: to have "legacy" localStorage estimates, use a browser profile where EstimAI was used **before accounts** (or seed `estimai_projects` + `estimai_project_*` keys via DevTools → Application → Local Storage before signing in).

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| H1 | With legacy localStorage estimates present, sign in (first authenticated load) | An **import offer** appears: "You have N estimates saved locally — import them?" with **Accept** and **Decline** | | | |
| H2 | Click **Accept** | Import runs; a **per-estimate results table** shows each as *imported*; the imported estimates then appear in your account list with matching content | | | |
| H3 | Confirm local data survived the import (DevTools → Local Storage) | The `estimai_project_*` keys are **still present** (nothing deleted locally) | | | |
| H4 | (Partial failure) Seed a batch where one estimate is oversized (>1 MB content) among valid ones, then Accept | Results table shows the good ones *imported* and the oversized one **failed** with a clear reason; the good ones appear in the account; **no** local key removed | | | |
| H5 | (Decline) In a fresh session with legacy estimates, click **Decline / Skip for now** | Offer dismissed; **not re-shown** on navigation within the session; localStorage untouched | | | |

## I. Size limit (001: AC-1.4)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| I1 | Build an estimate whose content exceeds ~1 MB (add many large activities / long notes) and let it auto-save | A clear **"too large"** ToastBanner message appears (naming the size limit); **nothing is lost** — your in-editor estimate is intact | | | |
| I2 | Confirm nothing partial was persisted | Reopening the last **saved** version shows the pre-oversize content (the oversize save did not overwrite it) | | | |
| I3 | Verify no count cap | Create many estimates (e.g. 10+) — all save successfully (no per-user limit) | | | |

## J. Cross-cutting spot checks (data residency, logging)

| # | Step | Expected | Result | Date | Tester |
|---|------|----------|--------|------|--------|
| J1 | Watch the estimai-api terminal while saving/importing estimates | Log lines show **only** method/path/status (e.g. `--> PUT /estimates/{id} 200`). **No** estimate `content`/body/PII in the logs (data-residency rule) | | | |
| J2 | Inspect `estimai-api/railway.json` | The deploy region is an **EU** region (`europe-west4`) | | | |
| J3 | (Deploy, when applicable) Confirm estimai-api + its Postgres are deployed to an EU region | Both in EU; no estimate data in provider logs beyond standard access logs | | | |

---

## Result summary

- **Executed on:** _<date>_ by _<tester>_
- **Build under test:** _<git short SHA>_ (e.g. `git rev-parse --short HEAD`)
- **Environment:** local (auth :3001, estimai-api :8080, UI :5173, Postgres :5435), real Google + GitHub OAuth apps
- **Sections passed:** ___ / 10  (A B C D E F G H I J)
- **Overall:** _PASS / FAIL_
- **Defects filed:** _<links / IDs>_
- **Notes:** _<anything observed; screenshots welcome under docs/evidence/>_

> Any FAIL → file a defect and route the fix through `/wellforge:implement <feature> <task>` before re-testing that section. Known accepted limitations (not defects): the ADR‑0005 deferred hardening items — 7‑day JWT lifetime, the unused `/.well-known/jwks.json` endpoint, and `aud` verification (revisit before a second Operai resource service / production launch).
