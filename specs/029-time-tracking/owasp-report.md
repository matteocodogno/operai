# OWASP Top 10 review — specs/029-time-tracking (T37)

Date 2026-11-13 · reviewer: owasp-reviewer · diff `8cc763d5..HEAD` on `feat/time-tracking` · stack: Bun + Hono + Prisma (hours-api and the touched backends), React (hours-ui, admin-ui, shell).

## Verdict: REVIEW REQUIRED

- One Medium is open: F1, the composition of D44 (ids kept) with the `dealId` / `projectId` / `meetingId` filters. It defeats ADR-0089 A1 and is demonstrated.
- Trace mapping: `verdicts.security: "FAIL"` until the D44 withhold (below) is built and re-checked. The verdict then becomes PASS if the re-check finds nothing new at medium or above.
- Everything else on the T37 surface list passes. The Low findings go to `security.notes[]` once the verdict is PASS.
- Counts: 0 critical · 0 high · 1 medium · 6 low (plus 5 informational notes).

### How this was checked
- I read plan.md, ADR-0088/0089/0090, spec.md, decisions.md and the diff of every surface named in T37. I also read `crm-api/src/activity-host/resolve.routes.ts`, `activities-api/src/activities/activities.routes.ts`, `meetings-api/src/{system,auth,meetings/list.routes.ts}`, the auth catalog, seed and service-client files, `hours-ui/src/lib/{hoursWorkbook,exportPages,names,searchers,activitiesRead}.ts`, the admin-ui time-lists code, and the shell session, router, CSP and runtime-remote files.
- hours-api `bun test` on `hours_test`: 1789 pass, 0 fail.
- `bun scripts/check-shared-copies.ts`: 7 groups in sync, including `systemAuth`, `serviceToken`, `problem` and `logger`.
- Scratch probe: `/private/tmp/claude-331608204/-Users-edoardo-paronzini-Work-Experiments-operai/e64faa20-c60e-4ef1-b693-704bd0bf97dc/scratchpad/d44.probe.test.ts` (not in the repo; run with `cd hours-api && bun test <that path>`). It reproduces F1.
- `bun audit` (hours-api) and `pnpm audit --prod` (hours-ui, inventory-ui) were run because `osv-scanner` is not set up in this shell.
- I did not run the crm-api, activities-api or meetings-api suites: they truncate databases and do not force a `_test` one. Those surfaces were reviewed by reading plus the shared-copy check.

## Findings

| # | Sev | OWASP | Where | One line |
|---|---|---|---|---|
| F1 | **Medium** | A01 | `hours-api/src/entries/view.ts:107,112,116,139`; pivot `src/entries/filters.ts:103-121` | The ids of hidden records are returned and are accepted back as filters, so a read-all holder without CRM access learns which hidden meetings are linked to which hidden deal. This is the alternative A1 rejected. |
| F2 | Low | A01 | `src/entries/filters.ts:103` | `dealId` link oracle (question 2). Accepted. |
| F3 | Low | A09 | `src/oversight/oversight.ts:62-84`, `src/lib/logger.ts` | Oversight reads leave no record of who read. Accepted by ADR-0088; cheap fix below. |
| F4 | Low | A04 | `src/index.ts` | No rate limit or quota; owner-call amplification on writes and lists. |
| F5 | Low | A04 | `src/targets/bookability.ts:103-116` | "Involved in a deal" is self-attestable by any CRM user. Not a defect, but specs/030 must know it. |
| F6 | Low | A03 | `hours-ui/src/lib/names.ts:21-22` | `suitePath` is weaker than the server's `isSuitePath`; unreachable today. |
| F7 | Low | A06 | `hours-api` deps, `exceljs` | Audit results are identical to the siblings' and not exploitable here. |

### F1 — MEDIUM — A01 Broken Access Control: ids of hidden records plus the filters defeat ADR-0089 A1

- **Where.** `view.ts` returns `on.id` for a project (107), deal (112) and meeting (116), and `activity.id` (139, via `labels/resolve.ts:192`), whatever `visibility` says. `filters.ts` (`dealCondition` 103, `entryWhere` 119) accepts those ids back as `dealId`, `meetingId` and `projectId`. `dealId` expands to the meetings currently linked to the deal, read with hours-api's own credential.
- **Exploit** (holder of `time-entry:read-all` with no `crm:access`, e.g. a custom controller role, the R4 audience; the default admin has CRM access).
  - Step 1: `GET /time-entries?whose=all&from=…&to=…` returns Bob's entry `on:{type:"deal", id:"deal-secret", visibility:"hidden", label:null, href:null}`. Alice's and Carol's meeting entries show `deal:{state:"linked", visibility:"hidden"}`.
  - Step 2: `GET /time-entries?whose=all&dealId=deal-secret&…` returns Bob's entry and exactly the entries on `mtg-alice` and `mtg-carol`, with their ids. It excludes `mtg-other`.
  - Result: the holder now knows that hidden meetings `mtg-alice` and `mtg-carol` are linked to hidden deal `deal-secret`, and who booked how long on each. A1 says a viewer who cannot read the deal must not learn "which deal a meeting they may not read is linked to", and rejected "the deal's id with a null name". This reproduces that as an opaque-id pair.
  - Step 3: `GET /time-entries/totals?…&groupBy=deal&dealId=…` returns `{"totalMinutes":270,"groups":[{"kind":"hidden","minutes":270}]}`. The same pivot with `projectId=` gives per-hidden-project totals, which `groupBy=project` deliberately merges into one `hidden` group (design gap 3, D40).
  - Probe output is as above; names stay hidden, ids do not.
- **Fix.** The D44 withhold below. After it, the holder has no hidden id to feed back; the residual is F2 (a deal id obtained outside hours-api).
- **Re-check:** the probe's step 1 must show `on.id: null` for Bob's deal entry and for both meeting entries, and no pivot is possible.

### F2 — LOW — A01/A04: `dealId` link oracle (question 2) — accepted
- `GET /time-entries?dealId=X` and `/totals?dealId=X` return the caller's, or for a holder everyone's, entries on meetings currently linked to X, with the deal's id and name still withheld in `on.deal`. A caller who already knows X can test "is this entry's meeting linked to X".
- Why Low:
  - X is a cuid or UUID, and after the D44 fix hours-api no longer hands one out for a hidden deal.
  - For `whose=mine`, meetings-api's own list already returns `host:{app,entityType,entityId,state,…}` with the deal id (label withheld) to any current creator or participant (`meetings-api/src/meetings/rows.ts:84-91`). The only new case is an author who has since left the meeting.
  - The fact is "my/their entry sits on a meeting linked to X". It carries no name or content.
- Not closing it fully: that needs a viewer-as-caller crm read of X on every deal-filtered read. That is a new dependency and a new refusal on top of D45's fail-closed 503, for a marginal gain.
- Optional hardening: expand to linked meetings only if the viewer can read X.

### F3 — LOW — A09: oversight reads are not attributable — accepted by ADR-0088
- The logger drops the query string by design and never logs the subject, so "who looked at everyone's hours, when" cannot be answered. For employee monitoring data with GDPR impact "high" in the ADR, a one-line fix is cheap: when `holdsReadAll` returns true (`oversight.ts:76-84`), `console.log("[oversight] read-all granted sub=<sub> path=<path>")`, with no query or body. A 401 log line also carries no source address; the Railway edge keeps it. Not required for PASS; it belongs with the O3 go-live sign-off.

### F4 — LOW — A04: no rate limiting or quota in hours-api
- This is the suite's posture; only auth limits. Amplification:
  - A `POST` on a deal the caller is not involved in costs one crm resolve plus up to 10 activities pages.
  - A 500-row list asks up to six owners in batches (4 in flight).
- Authenticated employees only, bounded by their own data, and no cap on entries per day or per user. Accept; a per-`sub` limiter on `POST` is the next step if the 800 ms p95 of R2 slips.

### F5 — LOW — A04 (design note for specs/030/031)
- Bookability asks the owner as the caller, but "involved in a deal" includes being a task assignee or participant. Any `crm:access` holder may write activities on any deal (crm-api resolve returns `writable:true`), and any employee may create a meeting. So an entry on a deal or meeting proves nothing about involvement.
- AC-2.3 defines it this way, so it is not a defect. Do not build billing or approval rules on it.

### F6 — LOW — A03: `hours-ui/src/lib/names.ts:21-22` `suitePath`
- The regex `^\/(?![/\\])` accepts `"/\t/evil.example"`, which `new URL` resolves to `https://evil.example/`. The server's `isSuitePath` (`clients/owner.ts`) rejects whitespace and control characters, and the meeting href is `encodeURIComponent`-built, so the client cannot receive such a value today. Defense in depth: reuse `^/(?!/)[^\u0000-\u001f\s\\]*$`.

### F7 — LOW — A06
- hours-api `bun audit`: 9 (3 high, 6 moderate), the same set as every Bun sibling (same `package.json` as activities-api).
- All but one are transitive through the dev-time Prisma CLI: `@hono/node-server`, `deepmerge-ts`, `mysql2`, `valibot`.
- The exception is `zod@3.25.76` (GHSA-mrhx-c7xc-m3w5, oversized collections). No request schema takes a user-sized array: strict scalar objects, a 64 KiB body cap, bounded query strings.
- hours-ui: one moderate (`exceljs > uuid`, GHSA-w5hq-g745-h8pq, only with a caller-supplied `buf`). inventory-ui shows 12, so hours-ui is cleaner.
- The osv-scanner gate remains the enforcement point.

### Informational (no action needed)
- **I1 (A01)**: `holdsReadAll` and `timeListManage` count any grant of the pair and ignore `conditions`. This is safe today: the catalog declares none and `roles.routes` refuses conditions on a pair with `supportedConditions: []`. A cheap hardening is to count only a grant whose `conditions` is null or empty.
- **I2 (activities-api `ids` side channel, plan § Security asks for a decision): ACCEPT.** A guessed id held by a down host answers 503 where an unknown id answers 200. That is existence only, never content, and it needs a 41-bit-plus (cuid) or 122-bit (UUID v4) guess plus an outage. Asking every host would make CRM-activity lookups fail while projects-api is down, and the extra host call already shows in timing without an outage.
- **I3**: `on.deal = {state:"linked", visibility:"hidden"}` versus `{state:"none"}` tells a holder that a meeting is linked to some deal they cannot read. This is plan § Views and needed for correct `hidden`/`none` totals; no id or name travels.
- **I4 (A05)**: `NODE_ENV` defaults to `development` in `env.ts`, which returns `err.message` on a 500. The production template, Dockerfile and compose set `production`, and env-doctor lists it; the pattern is the siblings'.
- **I5**: the CORS preflight is answered 204 without a credential, for every path, with `Access-Control-Allow-Origin` only for an allowed origin. It reveals no route or data, and the matrix test pins it (`src/matrix.test.ts:188`). OK. `ALLOWED_ORIGINS` refuses `*` at startup.

## Answers to the four questions

### 1. A1 on `src/labels/` and `src/totals/` — CONFIRMED on the direct channel
- `labels/resolve.ts:208-227` `meetingDealOf` returns an id and label only in the branch `label.visibility === "visible"` (222). A viewer who cannot read the deal gets `{linked, hidden|unavailable}` with no id. A stored deal id outside the id rule is `linked/hidden` and never sent to crm-api (116, 220).
- The deal is resolved with the viewer's own JWT (`resolveDeals(authorization,…)`). The service credential is used only by `callAsService`, in `clients/meetings.ts`, for `/system/meetings/hosts`.
- `totals/totals.ts:50-54` `placeEntity` and `:97-99` `byDeal` key a group by deal id only when visible. Everything else goes to one merged bucket (`hidden`, `unavailable`, `deal-unknown`, `none`).
- No special case exists for the author, and A1 applies to every viewer. The probe agrees: `on.deal` carries no id.
- The rule is bypassed only through D44's ids plus the filters (F1).

### 2. The `dealId` link oracle
- Low, accepted (F2). It is real, but the deal id has to be known, and for `whose=mine` it adds nothing meetings-api does not already show a current participant.
- It disappears for holders once D44 is withheld. Optional hardening is listed.

### 3. Preflight and the refusal-only caches — OK
- **Preflight:** see I5.
- **Caches:** `oversight.ts` and `authz/timeListManage.ts` use separate maps, so a refusal of one permission never refuses the other.
  - Key `(sub, perm_epoch)` comes from the verified JWT, so another user's entry cannot be poisoned.
  - TTL is 30 s. A grant is never remembered, so a revocation holds on the next request even with a stale token. A refused token is re-asked live after at most 30 s.
  - An outage is cached as neither. The map is swept at 1000 entries.
  - The `auth` call has a 2 s timeout, `redirect:"error"`, and a strict body read; any failure is 503 `authz_unavailable`.
  - On a write to someone else's entry, an `auth` failure, a missing permission and a missing entry all answer the same 404, and `auth` is asked before the database, so existence cannot be timed by a non-holder.

### 4. D44 decision — WITHHOLD, for entries that are not the viewer's own

**Rule.** In a `TimeEntryView`, `on.id` (project, deal, meeting) and `activity.id` are returned only when `visibility === "visible"` or the entry belongs to the viewer (`row.userId === viewer sub`). Otherwise they are `null`.
- Visible records keep their id for everyone: the viewer can read the record and `href` already contains it.
- The author's own entries keep the ids, whatever the visibility, including `unavailable`.
- Unchanged: `on.deal`, totals, the export (it never carried ids), the `none` target (category ids are hours-api's own list), and the author's `POST`/`PATCH` responses.

**Reasons.**
1. F1 is demonstrated: the ids are what turn the filters into a probe, and A1 forbids exactly that disclosure.
2. The list would otherwise hand out the per-id breakdown that totals refuse to give (`hidden` is one merged group by design).
3. No product cost. Everyone's hours and the export never use ids (`hours-ui/src/lib/names.ts`: "No function here returns an id"; `hoursWorkbook.ts`). The only consumer is the author's edit dialog (`hours-ui/src/components/EntryDialogModel.ts:242-251` `valuesOf` / `sameTarget`), which keeps working because own ids stay.
4. Least invasive of the options.

**Alternatives considered and rejected.**
- Keep the ids and close the oracle with a viewer crm read on every `dealId` filter: a new call and a new refusal, and it does not fix the `projectId`/`meetingId` pivots.
- Null for everyone who cannot see the record, the author included: uniform with D43 but changes the author's edit dialog (`sameTarget`, the pre-filled picker) for no gain, since own ids are the author's own knowledge.

**The [BE] task (blocks T40).**
- `hours-api/src/entries/view.ts`: wire schema `entityParts.id` and `activity.id` become `z.string().nullable()`. `toView(row, labels, viewerId)` and `viewEntries(authorization, rows, viewerId)` set `id: own || visibility === "visible" ? id : null`.
- Call sites pass the viewer: `entries/entries.routes.ts:329,368` (`userId`), `entries/list.routes.ts:159` (`c.get("userId")`).
- `src/labels/**` and `src/totals/**` stay unchanged: the labels layer does not know authorship, and totals never carried ids. (T37's text said `labels/**`; the strip belongs in `view.ts`.)
- Tests:
  - Another person's hidden project, deal and meeting entry: `on.id === null`; its `activity.id === null` when the target is hidden or unavailable.
  - The author's own hidden entry keeps both ids, including in `POST`/`PATCH` responses and when a holder lists their own entry with `whose=all`.
  - A visible entity keeps its id for others.
  - `unavailable` (owner down) on someone else's entry is `null`; on the author's own it keeps the id.
  - Contract pin updated in `openapi.contract.test.ts`.
  - `entries/activityPointer.test.ts:417` ("still keeps the id") is split into own versus other.
  - New composition test from the probe: a holder without crm access cannot obtain a hidden deal id from the list.
- Small [FE] companion: `hours-ui/src/lib/hoursApi.types.ts` (`Named.id` and `activity.id` become `string | null`), a guard in `EntryDialogModel.valuesOf` (own entries only; `null` is treated as not re-pickable), and fixtures plus `fakeApi`. No screen change in Everyone's hours or the export.
- Docs: plan § Views (`id: string | null`), replace the § Security bullet on `on.id`/`activity.id`, close the "Open item (D44)" in ADR-0089 A1, and add to spec AC-4.10 "… and, for anyone but its author, without its id" (owner approves the spec text). Record D44 in `ledger.md`.

## Surface coverage

| Surface | Result |
|---|---|
| hours-api JWT guard, default deny, body limit, CORS, Problem JSON, logging | PASS. RS256, issuer and audience pinned; one global guard after /health and the docs; 64 KiB cap before parsing; method, path and status only in logs; no raw SQL beyond `SELECT 1`. |
| Entries POST / PATCH / DELETE | PASS. `userId` is never client input; statements scoped by `{id, userId}`; 404 before any 422; strict bodies; id, NUL and surrogate rules; owners asked as the caller and failing closed. |
| List and totals | PASS except F1. Scope comes from `readScope`; invalid input is decided before any call; the cursor is validated against what hours-api mints. |
| Lists (admin) | PASS. Live `time-list:manage` before validation, refusal-only cache, no DELETE route. |
| Oversight | PASS (question 3). |
| Labels / totals A1 | PASS on the direct channel, F1 by composition. |
| crm-api resolve `deal` | PASS. JWT plus live authz; `reader:false` returns no items; `related` refused; no wider than `GET /deals/{id}`. |
| activities-api `ids` | PASS. Caller-readable only, one page, unreadable and missing are identical, 503 on a host outage; side channel accepted (I2). |
| meetings-api `ids` and `/system/meetings/hosts` | PASS. `ids` is ANDed with the caller's own set; the system route is checked before the query for `aud=SERVICE_AUDIENCE`, scope and `sub system:hours-api`; one 401; unset audience means closed; `{id, host}` only. |
| auth catalog, seed, scope, `hours-api` client | PASS. No conditions, admin only, not in the directory or holders gates; scope `meetings.hosts.read` only, issued from the client entry. |
| hours-ui export | PASS. `exceljs` string cells, so `=`, `+`, `-`, `@` stay text (tested); no ids; names only when `visible`; file name from validated days. |
| hours-ui, admin-ui, shell | PASS. React text rendering, no storage use, links guarded (F6), CSP and trusted origins name exactly the two hours origins, `/hours/$` sits under `_authed`, and the server stays the authority. |

## SELF-CRITIQUE
I read, ran and probed hours-api, but I did not execute the crm-api, activities-api and meetings-api suites, the hours-ui or shell Vitest suites, or any browser flow, so those verdicts rest on reading plus the shared-copy check. The Medium relies on one scratch probe that I did not commit, and I rated F1 Medium rather than Low because it breaks a stated ADR rule by composition for a narrow audience (opaque ids, no names). I could not exercise Prisma 7's error-log content, Railway network exposure, or meetings-api's real `HostView` for a non-reader beyond the code, and `osv-scanner` itself was not run.

## Re-check 2026-11-13 (after T41)

Reviewer: owasp-reviewer. Commit 37e8897a (T41, D44) on `feat/time-tracking`. Since the first review only docs commits and T41 touched the tree; T41's 8 files are all under `hours-api/src` (`git diff 66495600~1..HEAD -- . ':!specs'`).

### Verdict: PASS

- F1 is closed. The list no longer hands out the id of a hidden record, so the `dealId` / `meetingId` / `projectId` filters have nothing to be fed.
- Nothing new at medium or above.
- Trace mapping: `verdicts.security: "PASS"`; `security.notes[]` = F2 (with the refinement below) through F7 verbatim from the first review.
- Counts: 0 critical · 0 high · 0 medium · 6 low (F2-F7, unchanged and accepted), plus informational notes.

### What was run

- **Probe, as asked:** the repointed original, with its import paths changed to the main checkout `/Users/edoardo.paronzini/Work/Experiments/operai/hours-api/`. Copy: `/private/tmp/claude-331608204/-Users-edoardo-paronzini-Work-Experiments-operai/e64faa20-c60e-4ef1-b693-704bd0bf97dc/scratchpad/t41/d44.probe.main.test.ts`.
- **Extended probe:** `/private/tmp/claude-331608204/-Users-edoardo-paronzini-Work-Experiments-operai/e64faa20-c60e-4ef1-b693-704bd0bf97dc/scratchpad/t41/d44.recheck.test.ts`. Both ran with `cd hours-api && DATABASE_URL=postgresql://postgres:postgres@localhost:5435/hours_test bun test <path>`.
- **Full suite:** `bun test` in `hours-api` on `hours_test`: **1812 pass, 0 fail, 43 files** (was 1789; T41 added tests).
- **Typecheck:** `bunx tsc --noEmit` in `hours-api`: clean.
- **Diff:** read `git show 37e8897a` in full (code and tests), plus `labels/resolve.ts`, `totals/totals.ts`, `filters.ts`, the cursor code and `entries.routes.ts`.

### Probe output (the original, step by step)

Same world as before: a holder with `time-entry:read-all` and no CRM access. Bob's entry is on the hidden deal; Alice and Carol have entries on three meetings, two of them linked to the deal.

Step 1, `GET /time-entries?...&whose=all`:

| Entry | `on` |
|---|---|
| carol, meeting linked to none | `{type: meeting, id: null, visibility: hidden, label: null, href: null, deal: {state: none}}` |
| carol, meeting linked to the deal | `{type: meeting, id: null, visibility: hidden, label: null, href: null, deal: {state: linked, visibility: hidden}}` |
| alice, meeting linked to the deal | same as the row above |
| bob, hidden deal | `{type: deal, id: null, visibility: hidden, label: null, href: null}` |

This is the re-check line the first report asked for: `on.id: null` for Bob's deal entry and for both meeting entries.

Step 2 and 3:
- The probe interpolates the id the list handed out, and that id is now `null`, so the request is `dealId=null`.
- Step 2 returns `[]` and step 3 (totals, `groupBy=deal&dealId=null`) returns `{"totalMinutes":0,"groups":[],"unavailable":[]}`.
- No pivot is possible.

### Extended probe (5 tests, 35 expects, all pass)

- **No hidden id or name anywhere in any read surface.**
  - 18 requests as the holder: `whose=all` with and without `userId` (bob, alice, carol), a 5-page `limit=1` walk, and totals for all six groupings with `whose=all` plus `person`/`project`/`deal` with `whose=mine`.
  - The concatenated bodies contain none of `deal-secret`, `p-secret`, `mtg-alice`, `mtg-carol`, `mtg-other`, `t-secret`, "Acquisition of ACME", "Apollo", "ACME board call" or "Rotate the keys".
  - The decoded cursors carry only `day|createdAt|<entry id>` (hours-api's own entry ids).
- **The author exception is exactly "own".**
  - The holder's own entry on the hidden deal keeps `id: "deal-secret"`.
  - The other five entries (Bob's deal and project, the three meetings) all have `id: null`.
  - Bob's `whose=mine` list keeps all of his ids, and Bob with `whose=all` gets 403.
- **Residual F2, confirmed accepted.** A holder who already knows `deal-secret` gets 200 with 3 entries (Bob's deal entry and the two linked-meeting entries). All three have `on.id: null`, and no hidden id or name is in the body. The response no longer yields anything that was not already known.
- **Mixed visibility.**
  - The holder can read the deal but not the meetings: every meeting has `id: null`.
  - `on.deal` is `{linked, visible, id: deal-secret, label, href}`, which is ADR-0089 A1 by design (the deal's visibility is the viewer's access to the deal), and the holder can read that deal already.
  - The holder never sees a meeting id.
- **Participant case.** The holder is a participant of `mtg-alice` but cannot read its deal: the meeting id is kept (the holder can read the meeting) and `on.deal` is `{linked, hidden}` with no deal id.

The developer's own `withheldIds.test.ts` covers `unavailable`, activity pointers, POST/PATCH and the schema/OpenAPI pin. It passes in the full run, and no assertion was weakened. The existing assertions that changed (`view.test.ts`, `oversight/read.test.ts`, `activityPointer.test.ts`) were narrowed to the D44 rule (author keeps, anyone else null), not removed.

### Diff review of 37e8897a

- **Call sites.** Every `viewEntries` caller passes the viewer: `list.routes.ts:162` (`c.get("userId")`), `entries.routes.ts:329` (POST) and `:368` (PATCH), both with the `userId` from the verified JWT.
  - `viewerId` is a required parameter of `viewEntries` and `toView`, so a forgotten call site does not compile; `tsc` is clean.
  - `toView` and `viewEntries` have no other non-test caller. The labels layer is reached from `view.ts` and `totals.ts` only.
- **Viewer identity.** `userId` is set only in `auth/jwt.middleware.ts:145` from the verified `sub`. `own` is strict equality `row.userId === viewerId`.
  - It cannot be widened by a query parameter, a header, or `whose=all` with `userId=<other>`; another person's row is never own.
  - A holder who edits an entry gets 403/404 before any view, so `own` also covers every write response.
- **No id through another member.**
  - `on.id` for project, deal and meeting and `activity.id` go through `idFor` (visible or own).
  - `href` and `label` exist only when visible. `on.deal` is the existing union with an id only on `visible`.
  - The remaining ids are not records the viewer is kept from: `person.id`, `workType.id`, the `none` category id, and `id` (the entry id).
  - `unavailable` is withheld like `hidden` (fails closed).
  - `activity.id` follows the activity's own visibility, which already follows the target's.
  - Totals still key a group by id only when visible; the shape of `totals.ts` is unchanged, and the six-grouping scan above found no hidden id.
- **No other new surface.** No new route, dependency, env var or log line. `c.json` sites: list, POST, PATCH, totals, lists, health.

### New findings

None at medium or above. One refinement of an existing Low, no new entry:

- **F2 refinement (Low, accepted).** The author keeps own ids even on a record they can no longer read.
  - A holder who once booked on deal D (bookability needed involvement at that time) and has since lost read access still has D's id from their own entry.
  - With `whose=all&dealId=D` they see which other people's meeting entries sit on meetings currently linked to D, with days and minutes but no ids or names.
  - Why Low: it needs prior knowledge of D, the same precondition as F2, and the holder can already read everyone's hours. It exposes the link and nothing else.
  - If ever tightened, the one fix F2 already names (expand to linked meetings only if the viewer can read the deal) covers it.

### Informational (T42, not a security finding)

`hours-ui` has not been adapted yet. `EntryDialogModel.valuesOf` (lines 239-251) reads `on.id` and `activity.id` without a null guard and builds picker values from them.
- It is safe today because only the author's own entry opens in the dialog and own ids are always kept.
- Everyone's hours and the export never use ids.
- T42's guard should treat `null` as "not re-pickable", as planned.

### SELF-CRITIQUE
The fix was checked mainly by reading the diff and running a probe that scans response text for chosen ids, so a leak under a derived or re-encoded form of an id would not be caught by the scan; none was found by reading. The host fakes (CRM, projects, activities, meetings) stand in for the real owners, so real crm-api and meetings-api answers for a non-reader are exercised only as the first review described, by reading. The hours-api suite and typecheck were run once each, not lint; the hours-ui, shell and other backend suites and the T42 UI companion were not run. New Mediums were ruled out by reading `view.ts`, the labels and totals layers and the three call sites, not by an exhaustive search of every service.
