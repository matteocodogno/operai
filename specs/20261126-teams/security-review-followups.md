# Security review — follow-ups after specs/20261126-teams closed

- Reviewer: `wellforge:owasp-reviewer` (OWASP Top 10), dispatched by the orchestrator on 2026-11-27.
- Scope: `git diff 3949d587..ae033cea`, code only — QE D2 NUL safety nets (8d131698, 35540273, f719119b), R12 single-replica check (ea420aa5), R13 deadline budgets (ae033cea), accounting seed message (81d77dbb).
- Verification: code reading of every changed file plus a local regex timing probe; DB-backed unit tests not re-run by the reviewer (QE ran them, `qe-followups.md`).

## Verdict

**PASS with notes** — 0 critical · 0 high · 0 medium · 2 low · 2 info.

## Findings and dispositions

| ID | Severity | Finding | Location | Disposition |
|---|---|---|---|---|
| FS-1 | low (A04/A05) | auth's `rejectNul` read and decoded the whole JSON body before authentication on every route, with no body limit (Bun's ~128 MiB default; the clone holds 2–3×): anonymous memory amplification against the identity service. | `auth/src/lib/nul.ts`, `auth/src/index.ts` | **Fixed** — 5ecabf0e: `requestBodyLimit` (hono `bodyLimit`, 256 KiB, 413 `request_too_large`) mounted before `rejectNul`; the largest legitimate body is ~7 KiB (a role with all 42 permissions) or ~36 KB (1 000 user ids). |
| FS-2 | low (A09) | The NUL branch of every service's `onError` returned before any logging, so a server-built value with bad bytes would be reported to the caller as their NUL with no trace. | each service's `onError` | **Fixed** — 313bcb45: `logNulRefusal` inside the shared `nulDatabaseError` copy logs the closed-set codes only (no message, value, request or sub), tested for leaks in all 11 services. |
| FS-3 | info (A06/A08) | The new `single-replica` CI job installed `bun-version: latest`. | `.github/workflows/railway-drift.yml` | **Fixed** — d56d5d18: pinned to `1.4.2`, as the other workflows. |
| FS-4 | info | crm-api's activity-host resolve wiring was not opened by the reviewer. | `crm-api/src/activity-host/resolve.routes.ts` | **Verified** — `[jwtMiddleware, hostAuthzMiddleware]` at lines 110/118, covered by `resolve.test.ts` ("a slow permission check (R13 a)"). |

## Surfaces checked

1. **Host authz middlewares (projects-api, crm-api)** — `next()` only on a live cache hit or a non-null context; wait expiry and any flight failure answer the existing 503; the flight never rejects (`resolveOnce` catches), the timer is cleared in `finally`. Single-flight key `${sub}\0${permEpoch}` from the verified JWT: a joiner can only share a flight with the same user at the same epoch. Only success is cached (expiry from send); a 503 or failure is never cached. Flight map entries live at most 5 s. Logs carry no sub, token or header. Page routes unchanged.
2. **meetings-api `GET /meetings` on `jwtOnly`** — not a regression: AC-10.1/10.6 make no capability the gate for the list; the WHERE clause stays creator-or-participant (ADR 20261104 visibility by participation); the old handler used only `userId` and `authorization`, so dropping the resolve removes nothing from the response; `ids=` narrows, never widens.
3. **auth `rejectNul` before authentication** — a 400 before a 401 depends only on the request bytes, not on credentials (not an oracle); the escaped-backslash regex is linear (2 M backslashes in 52 ms); non-JSON bodies fall to the database safety net; OAuth callbacks (GET) are checked only for `%00`; the original body stays readable (clone). Memory: FS-1.
4. **NUL safety nets** — `isNulDatabaseError` matches only SQLSTATE 22021/22P05 (direct, `cause`, or Prisma P2039/P2010 `meta.driverAdapterError`), reads codes only; the 400 detail is a constant; other faults are not mapped. Observability: FS-2.
5. **Bounded name waits (activities-api, meetings-api)** — a late lookup yields `{ name: null, status: "unknown" }` per id, never another person's name; a late answer cannot change a snapshot already returned; the bounded wait is passed only from the list paths; summaries and Q&A keep the full wait.

## Not covered here

QE of the follow-ups (`qe-followups.md`, 2026-11-27) then found the NUL net not reached on three services whose routes wrap the database error before `onError` (F1: refund-api, estimai-api, notify-api) and a forwarded NUL in two projects-api query params (F2). Their fixes get their own review.

## Round 2 — the QE F1/F2/E6 fix round (2026-11-27)

- Scope: f5fc62d3, 60c9fb93, 9af6d096, b748acba, ad9ed6ad, 5e702db4, af6eb6d1 (code only). Tests run on `*_test` DBs: refund-api NUL files 17/0, estimai-api 86/0, notify-api 54/1 (the known child-boot env fault E2).
- **Verdict: PASS** — 0 critical · 0 high · 0 medium · 1 low · 2 info.
- Checked: refund-api `runExit` re-throws only a NUL-recognised failure (closed code set) and leaves every other `DatabaseError` and every 401/403/404 decision in place; authorization middlewares still run before validation, so a NUL is never an existence oracle. estimai-api's collaborator path guard runs after authentication and validates parameters only; `nulRefusalIn` turns an error into a 400 only for the closed code set. notify-api `/system/*` still verify the service credential before the body schema; idempotency keys, template policy and closed `data` shapes unchanged. The e2e fixture passes database URLs through the child environment only, scrubs them from errors, and has no injection path.

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| FS-5 | low (A09) | estimai-api and notify-api now keep the database cause on wrapped failures, so the `onError` fallback logs the whole Prisma chain, whose messages can embed query arguments. | Being fixed: the fallback logs the cause by name and code only (follow-up commit after this round). |
| FS-6 | info | The fixture's localhost guard reads `URL.hostname` only; a `host=`/`hostaddr=` search parameter would be honoured by libpq; the import could resolve a `CRM_DATABASE_URL` other than the checked one. | Being fixed in the same follow-up. |
| FS-7 | info | refund-api: a NUL in server-built data (e.g. a JWT claim stored in a snapshot) is answered as the caller's 400; it leaves one `[nul]` warning with codes, so it is traceable. | Accepted. |
