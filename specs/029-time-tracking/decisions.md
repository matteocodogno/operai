# Decisions — Time tracking

Choices the agents made that the spec, plan and tasks did not dictate. Disagree with one?
It is drift: amend the spec/plan and re-sync tasks — do not quietly edit the code.

## T21 · frontend-dev · 2026-11-13
- default: dev default `VITE_HOURS_API_URL=http://localhost:8088` in `shell/.env.example`, with a comment in the style of the meetings entry — why: plan.md fixes hours-api on port 8088 and the file's neighbours use localhost defaults — where: `shell/.env.example`
- scope: added two tests beyond the two the `done when:` names (exact-origin match, malformed env value) — why: the trust list is the security-relevant part of this task, and the siblings' tests cover neither — where: `shell/src/lib/session.test.ts`
- scope: did not add the `.changeset/shell-hours.md` — why: T23 lists it in its `touch:` and owns the shell's feature changeset — where: none

## T7 · backend-dev · 2026-11-13
- default: `involved` lists a person once when the owner is also the technical contact (`[...new Set(...)]`) — why: plan.md says "owner + technical"; a duplicated id carries no meaning and hours-api only tests membership — where: `crm-api/src/activity-host/resolve.routes.ts`, pinned by a test.
- assumption: a deal item's `writable:true` and `may:{write:true, manage:true}` are constants, as for companies, copied literally from the plan's contract — why: in the CRM every `crm:access` holder may write activities on any deal; hours-api ignores both fields. Risk: a later consumer that reads `may.manage` as "may manage this deal" (the entity-scoped `deal:manage`) would be misled — where: `resolve.routes.ts`, `ResolvedDealItem`.
- scope: the technical-contact rule is a local copy of `estimateId !== ""` from `deals.routes.ts`, not an extracted shared helper — why: `deals.routes.ts` is outside the `touch:` list, and the pairing is pinned by tests that compare `involved` with the live deal view and with the override and unlink rows — where: `resolve.routes.ts`, `resolve.test.ts`.
- reinterpretation: a deal request with `ids: []` is allowed and answers `{reader, items: []}`, mirroring the company branch — why: the task does not say, and consistency with `company` avoids a special case — where: `resolve.routes.ts`.
- default: changeset level is `minor` for `@operai/crm-api` — why: it is an additive contract capability, and 14 of 20 existing crm-api changesets are minor — where: `.changeset/crm-api-resolve-deal.md`.

## T8 · backend-dev · 2026-11-13
- assumption: `ids` combines with the other filters as an intersection (AND) rather than being a 422 when mixed — why: T8 and the plan say only "still the caller's own meetings", every existing filter already intersects, and hours-api uses `ids` alone (activities-api's "exactly one filter" rule has no counterpart here) — where: `meetings-api/src/meetings/list.routes.ts`, tested in `list.test.ts`.
- default: an empty or malformed `ids` (empty list or member, over 64 characters, repeated parameter, more than 25) is a 422, not "no filter" — why: returning the caller's whole list to a caller that built its ids from nothing is the dangerous failure; follows crm-api's `IdsSchema` convention (1–64 characters per id, comma list, raw cap) — where: `list.routes.ts`.
- reinterpretation: a NUL-bearing id is treated as an unknown id (absent, 200), not a 422 — why: AC-2.10 wants an id that cannot name a meeting to answer like a nonexistent one; hours-api forwards user-supplied `on.id`, and a 422 would read as `unavailable` (503) instead of a 404. The cause was a 500 from Postgres — where: `list.routes.ts`.
- default: the `ids` schema is a local copy of crm-api's `IdsSchema` shape rather than a new shared helper in `lib/http.ts` — why: `lib/http.ts` is outside T8's `touch:` list — where: `list.routes.ts`.
- default: the cap counts raw members, so a duplicated id still counts toward 25 — why: same as crm-api's `IdsSchema`, strictest reading of "26 ids → 422" — where: `list.routes.ts`, `list.test.ts`.
- assumption: no meetings-api README or doc change — why: the `touch:` list names none, and the OpenAPI document already carries the parameter — where: n/a.

## T6 · backend-dev · 2026-11-13
- reinterpretation: with `ids`, `page` and `pageSize` are ignored and the answer is always one page (`page: 1, pageSize: 50`, `total` = items returned) — why: the default `pageSize` of 25 would silently drop half of 50 asked ids, and hours-api reads an omitted id as "deleted or not yours"; the plan's response shape is unchanged — where: `activities.routes.ts` `listByIds`, test "the whole answer, in one page".
- assumption: only the hosts that own at least one matching row are asked, so a CRM-only lookup does not fail when Projects is down. Cost: a 503 reveals only that a matching activity exists on the failing host, which needs a guessed cuid/uuid plus a host outage — where: `listByIds`, test "does not ask the other".
- assumption: the 50-id cap counts elements as sent, so 51 duplicates are a 422 — why: stricter and predictable — where: `parseIds`.
- assumption: ids are opaque and exact, with no trimming; an empty element, over 64 characters, or a NUL is a 422 with `field: "ids"`, as for every other id input — where: `parseIds`.
- scope: `ids` combines with the existing `type` and `open` narrowing filters, which are not target filters; hours-api does not use them — where: `listByIds`, test "can be narrowed by `type`".
- assumption: a `404` ProblemError from `HostSession.load` means "caller is no reader" and is swallowed per host; every other error, including the 503, is rethrown — where: `listByIds`.

## T1, T2 · backend-dev · 2026-11-13
- default: resource keys `time-entry` and `time-list` and the labels "Time entry" / "See everyone's hours" / "Time lists" / "Manage categories and work types" — why: plan and ACs name only `time-entry:read-all` and `time-list:manage`; labels are English-only catalog text as in the other catalogs — where: `auth/src/authz/catalogs/hours.ts`
- default: `seedHoursCatalog` runs right after `seedProjectsCatalog` and `seedHoursGrants` right after `seedProjectsGrants` in `seed()` — why: follows the existing per-app ordering; grants are order-independent because `admin` is upserted defensively — where: `auth/src/authz/seed.ts`
- scope: added a test pinning that neither permission joins `DIRECTORY_GATE_PERMISSIONS` or `HOLDERS_GATE_PERMISSIONS` — why: plan § auth states it (ADR-0066); a future edit would widen the user directory silently — where: `auth/src/authz/catalogs/hours.test.ts`
- scope: added `.env.example` pin tests that parse the example with the startup parser — why: "the example carries `hours-api`" is a done-when item and nothing checked the file before — where: `auth/src/system/serviceClients.meetingsHostsRead.test.ts`
- reinterpretation: the "documented clients match" check in the example covers only clients the example lists, not all of `DOCUMENTED_CLIENT_SCOPES` — why: the example has never listed `meetings-api`, and widening the example is not T2 — where: same file
- default: both changesets are `@operai/auth` `minor` — why: a new permission catalog and a new allowlisted scope are additions to auth's contract — where: `.changeset/auth-hours-catalog.md`, `.changeset/auth-meetings-hosts-read.md`
- default: `hours-api`'s documented scope set is `meetings.hosts.read` only — why: tasks.md says so, and ADR-0089 asks every other owner as the caller — where: `auth/src/system/serviceClients.ts`
- assumption: the `.env*` hook did not block the `auth/.env.example` edit through the Edit tool, so it was made — where: `auth/.env.example`

## T3, T4, T5 · frontend-dev · 2026-11-13
- default: `short` pads the minutes after hours ("2 h 05", never "2 h 5") and drops sub-minute seconds; hours go through `formatNumber` (en "1,234 h", it "1234 h"); plain spaces, no NBSP, as the money formatters do — why: "2 h 5" reads as 2.5 — where: `operai-ui/src/lib/format.ts`
- default: `formatMonth` is strict: only `YYYY-MM` with month 01–12, or a valid Date; otherwise `TypeError` — why: a wrong group key must not render as "Invalid Date" — where: `format.ts`
- scope: edited `operai-ui/docs/design-system.md` outside the T3/T5 touch lists (§ Formatting rows for `formatMonth`/`short`/`spoken`/`clock`; Buttons rule 7 "a download is `ExportButton`") — why: otherwise the "never format by hand" table omits the new formatters — where: `design-system.md`
- scope: edited `Combobox.tsx` and `Combobox.test.tsx` outside the T4 touch list: `Combobox` now stops propagation of an Escape it consumes, so the first Escape closes the list and the next closes the dialog — why: `useDialogBehavior` listens on `window` and ignores `defaultPrevented`, so Escape in a picker inside a dialog closed the dialog too; design.md S2 puts the pickers in the entry dialog — where: `operai-ui/src/components/Combobox.tsx` (consumer suites shell, refund-ui, meetings-ui, inventory-ui, admin-ui, crm-ui green)
- default: `SearchPicker` gets an optional `disabled` (closes the list, aborts the request, takes no input) — why: T27's dialog is "not dismissible while saving" — where: `SearchPicker.tsx`
- default: `SearchPicker` asks again every time the list opens and shows "Searching…" until the answer (the `CompanyPicker` copies reuse a cached list) — why: a cached list can be a permission or a booking out of date — where: `SearchPicker.tsx`, D-65
- default: `SearchPicker` field text is derived from `value` unless the person is typing; a set value replaces half-typed text. It cannot see a "Clear filters" press when `value` was already `null`, so T24 and T27 must give the picker a new `key` on Clear filters — where: `SearchPicker.tsx`, `design-system.md`
- default: `SearchPicker` announces every state politely (design.md § Picker states); a count of 0 announces `noMatch`; the live region is empty while closed — where: `SearchPicker.tsx`
- default: `search` is called with the trimmed text, and with `''` when the list opens on an empty field; a rejection or a synchronous throw is `unavailable`; the latest `search` is read through a ref — where: `SearchPicker.tsx`
- default: `ExportButton` runs one export at a time; a build that finishes after `resetKey` changed still downloads but shows no status and does not block the next click — where: `ExportButton.tsx`
- default: `ExportButton` attaches the anchor for the click and revokes the object URL after 30 s (the inventory original does neither) — why: some browsers ignore a detached anchor; revoking at once can cancel the download — where: `ExportButton.tsx`, D-66
- default: `ExportButton` uses the library `Button busy` and `text-xs text-soft` / `text-org-text`; test ids `<testId>`, `<testId>-status`, `<testId>-error` — where: `ExportButton.tsx`
- assumption: D-65 and D-66 are the next free numbers in `operai-ui/docs/decisions.md` — where: `operai-ui/docs/decisions.md`

## T10 · backend-dev · 2026-11-13
- reinterpretation: a schema violation (body, query, path, malformed JSON) answers 400 `invalid_request` through `src/lib/errors.ts`, kept outside the shared `problem` copy — why: plan § Errors says 400, while the shared copy's hook answers 422 and its region must stay byte-identical — where: `hours-api/src/lib/errors.ts`, `src/index.ts`.
- default: the session guard is one global `app.use("*", jwtMiddleware)` placed after /health, /openapi.json and /docs, not per-route `middleware: [jwtMiddleware]` as the siblings do — why: T10's done-when requires "any other path without a credential → 401" before any feature route exists, and AC-5.3 then holds by construction; `app.routes` entries for the wildcard have method `ALL`, so a T20 matrix written like activities-api's still works — where: `src/index.ts`.
- assumption: identity resolution has no cache (activities-api caches 60 s) and a 2 s timeout — why: AC-4.8 and the rename-between-two-calls tests need the second read to show the new name; 2 s is plan R2 — where: `src/lib/identities.ts`.
- assumption: the four owner URLs, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` and `SERVICE_AUDIENCE` are all required at start (activities-api makes its notify and system groups optional) — why: without its own credential hours-api cannot read a meeting's current deal, so it stops at start instead of degrading at read — where: `src/lib/env.ts`.
- default: the test preload points `AUTH_BASE_URL` and the four owner URLs at dead placeholders `127.0.0.1:1`–`:6` — why: the developer's stack runs on the real ports; a call a test forgot to fake must be refused — where: `src/test-support/env.ts`.
- scope: `src/test-support/world.test.ts` is outside the `touch:` list; `world.ts` carries an `onReset(hook)` seam so T11's `hosts.ts` can register its own reset without editing it — where: `src/test-support/world.test.ts`, `world.ts`.
- default: the wired `serviceTokens` reads `env` through getters at each call — why: a test can point `env.AUTH_BASE_URL` at T11's fake auth with no injection plumbing — where: `src/lib/serviceToken.ts`, outside the shared region.
- assumption: the seed test builds "a fresh installation" by applying every migration inside an always-rolled-back transaction in a scratch schema — why: `hours_test` is shared and other tasks' tests mutate it — where: `src/migration.seed.test.ts`.
- default: removed Prisma 7's `CREATE SCHEMA IF NOT EXISTS "public"` header from the generated init DDL — why: siblings' migrations don't carry it — where: `prisma/migrations/20261113090000_init/migration.sql`.
- default: `world.call()` parses a body as JSON only when the content type is JSON — where: `src/test-support/world.ts`.
- hand-off (T11–T20): take `app`, `MAX_REQUEST_BODY_BYTES`, `db`, `env` from `world`, never from `../index` above it; routers need not repeat `jwtMiddleware` (type them `OpenAPIHono<{ Variables: JwtVariables }>`); map any P2002 on a category/work-type write to 409 `name_taken` (expression index names `time_category_name_lower_key`, `work_type_list_name_lower_key`); note/name schemas must refuse `\u0000` as 400 (Postgres text cannot hold NUL; activities-api has a `noNul` helper); register fake hosts' reset with `onReset(...)`.

## T9 · backend-dev · 2026-11-13
- default: `host` reports whatever host the meeting stores (`app`, `entityType`, `entityId`), not a hardcoded `crm`/`deal` — why: ADR-0059 says a host is data, never a branch; returning `null` for a meeting linked to another host would say "unlinked" when it is not; production has only `crm/deal` (AC-11.1) and hours-api reads only `{app:"crm", entityType:"deal"}` — where: `meetings-api/src/system/hosts.routes.ts`.
- assumption: `?dealId=` is unpaged and uncapped — why: the plan's shape has no paging, and a capped answer would be the "answered low" failure of AC-4.11; a row is an id plus a link and the `[hostApp, hostEntityType, hostEntityId]` index covers the filter. Risk: a deal with thousands of meetings gives a large body — where: `hosts.routes.ts`, test "is not paged and not capped" (130 meetings).
- default: `SERVICE_AUDIENCE` is optional in `env.ts`, not in `PRODUCTION_REQUIRED_KEYS` — why: unset means 401 on every system call; making it required would stop meetings-api if it deployed before the variable is set. T33's env-doctor makes it required, as for crm-api and activities-api — where: `meetings-api/src/lib/env.ts`.
- reinterpretation: "exactly one of `ids` / `dealId`" is a `superRefine` on the query schema, so the shared `validationHook` renders the 422 (`field: "ids"`) — why: a thrown `ProblemError` would depend on `app.onError`, which a bare test app lacks — where: `hosts.routes.ts`.
- default: ids are trimmed per member, 1–64 characters, counted as sent (duplicates count toward 100); an empty or malformed list is 422; an id with a NUL is an unknown id (absent for `ids`, `[]` for `dealId`), never a 500 — copies T8's convention — where: `hosts.routes.ts`.
- default: the route is tagged "System", whose description in `src/openapi/registry.ts` still reads "Health checks" — why: the registry is outside T9's `touch:` — where: n/a.
- default: the system-credential tests live in `src/system/hosts.routes.test.ts` with their own key pair and the middleware's `jwks`/`audience` injection; the assembled-app block sets `env.SERVICE_AUDIENCE` temporarily — why: the shared test-auth harness and `testEnv.ts` preload are outside `touch:` — where: `hosts.routes.test.ts`.
- scope: a `SYSTEM_ROUTES` set in `matrixKit.ts` next to `PUBLIC_ROUTES`; a system route has no persona cells (every user token gets the one 401) — where: `matrixKit.ts`, `matrix.test.ts`.
- default: changeset `@operai/meetings-api` `minor` — where: `.changeset/meetings-api-system-hosts.md`.

## T31 · frontend-dev · 2026-11-13
- scope: added an optional `title` to the `ErrorBanner` adapter (for "Authorization service unavailable") and to `PermissionDenied`, with tests — why: `ErrorBanner` had no title, and `PermissionDenied`'s fixed heading "You no longer have admin access." is false for someone lacking one permission; T32 needs the same banner — where: `admin-ui/src/components/ErrorBanner.tsx`, `PermissionDenied.tsx` and tests (outside `touch:`; backward compatible, defaults unchanged).
- reinterpretation: the page decides "denied" from `usePermissions()` and fetches only when `time-list:manage` is held — why: `GET /time-lists` needs only a JWT, so the read can never 403 for a missing permission; the done-when's "without the permission → `PermissionDenied`" can only come from the permission list. An empty result (unresolved, or `/authz/me` failed) counts as no grant (fail closed), as the nav link does; a 403 from the API gives the same state — where: `TimeListsPage.tsx`.
- default: failure copy is the catalog's en/it text; the server's `detail` is not shown (the sibling `MileageRatesPage` shows it) — why: copy must be bilingual — where: `TimeListsPage.tsx`, `strings/timeLists.ts`.
- default: a 503 is the authorization banner only when `code === 'authz_unavailable'`; any other 503 is the plain load failure — where: `failureState`.
- default: after Retry, focus moves to the page heading (`PageHeader focusableHeading`) — why: found by rendering, focus fell to `<body>`; `MileageRatesPage` has the same gap and was not touched — where: `TimeListsPage.tsx`.
- default: `listTimeLists` refuses a 200 whose body lacks `categories`, `workTypes.project` or `workTypes.deal` (`ApiError` status 200, "Unexpected response") — why: contract drift becomes the ordinary load banner instead of a white screen — where: `timeListsApi.ts`.
- default: test ids use design.md's `time-lists-` prefix (`time-lists-page`, `time-lists-loaded`) — where: `TimeListsPage.tsx`.
- scope: the loaded state renders an empty `time-lists-loaded` region and keeps `state.lists` for T32's cards; the loading state already shows the three card titles — where: `TimeListsPage.tsx`.
- assumption: Italian wording chosen without a source — nav and heading "Elenchi ore", cards "Categorie", "Tipi di lavoro per progetto", "Tipi di lavoro per opportunità" ("opportunità" is the CRM's word for deal); for the owner to review — where: `strings/nav.ts`, `strings/timeLists.ts`.
- default: changeset `@operai/admin-ui` `minor`, worded for the whole screen including T32 (T32's `touch:` lists no changeset) — where: `.changeset/admin-ui-time-lists.md`.
- default: `hasCapability` is a local copy in `SectionNav.tsx` (`MileageRatesPage.tsx` already has its own) — why: a shared helper would touch files outside the list — where: `SectionNav.tsx`, `TimeListsPage.tsx`.
- scope: added `TimeListsPage.it.test.tsx` to prove the Italian render — where: `admin-ui/src/pages/`.

## T22 · frontend-dev · 2026-11-13
- scope: ported projects-ui's per-mount router (`ownRouterMount`) into `App.tsx` and its back-navigation test as `src/App.backNavigation.test.tsx` (outside the named globs) — why: a module-level router (the meetings-ui shape) failed 4 of the 9 back-navigation cases — where: `hours-ui/src/App.tsx`, `src/App.backNavigation.test.tsx`
- scope: added `src/federation/exposes.test.ts` and `src/federation/reactVersion.test.ts` — why: the done-when requires name `hours`, the two exposes and port 5184, and one React across the suite; hours-ui is not in `lerna.json` until T34, so `mise run react:skew` cannot list it yet — where: `hours-ui/src/federation/`
- default: `react`, `react-dom` and `@tanstack/react-router` pinned exactly (19.2.7, 19.2.7, 1.170.17); `better-auth` `^1.7.18` with the lockfile held at 1.7.18; vitest `^4.1.12` — why: meetings-ui/crm-ui pattern; a fresh lockfile first resolved better-auth 1.7.22, which as a federation singleton could become the suite's copy — where: `hours-ui/package.json`, `pnpm-lock.yaml`
- default: wire types in `lib/hoursApi.types.ts`, error model in `lib/errors.ts`, transport and query building in `lib/hoursApi.ts` — where: `hours-ui/src/lib/`
- default: `EntryFilters.whose` is required and always sent (`mine` or `all`) — why: T29's "every call carries `whose=all`" and an unambiguous URL; T24 must pass `mine` — where: `hoursApi.ts`, `hoursApi.types.ts`
- default: `HOURS_ERROR_CODES` includes `time_list_manage_required` and `name_taken`, which hours-ui never calls — where: `lib/errors.ts`
- default: `getTimeLists` always sends `includeRetired=true|false` explicitly — where: `hoursApi.ts`
- reinterpretation: "permissions resolved" is read from the answer (epoch > 0, or any app, role, department or permission) — why: `usePermissions()` has no loaded flag. A person whose answer is empty in every field cannot be told from "not resolved yet", so T29 must not wait on `resolved` without a bound — where: `lib/permissions.ts`
- reinterpretation: `strings/export.ts` exports `exportStrings` (`export` is reserved); the aggregate key stays `strings.export` — where: `strings/export.ts`, `strings.ts`
- default: `MyHoursPage` and `EveryoneHoursPage` are frame stubs; `EveryoneHoursPage` has no holder gate yet (T29's) — where: `hours-ui/src/pages/`
- default: `PermissionDenied` takes optional `title`, `message`, `action`, `headingLevel`; test ids are `hours-…` — where: `components/PermissionDenied.tsx`
- assumption: Italian copy "Le ore di tutti" and "Sezioni delle ore" chosen by the agent (design gives only "Ore" and "Le mie ore") — where: `strings/common.ts`, `strings/everyone.ts`
- default: the fake API answers a route only on its own service's origin; an unrouted request is a 404 Problem naming the request; owner row shapes are test-support-local copies, not compile-checked against the production types T24/T26 define — where: `test-support/fakeApi.ts`, `fakeSession.ts`
- scope: no `.changeset/*` and no `lerna.json` entry — why: T34 owns both — where: none

## T33 · devops · 2026-11-13
- reinterpretation: "hours-api is in `ORIGINS`" read as hours-ui — why: `ORIGINS` holds frontend public origins; hours-ui went into `SERVICES` and `ORIGINS` (production `https://hours.operai.welld.io` assumed from `provision-tool.sh`, local `:5184` from the plan) — where: `tools/env-doctor/manifest.ts`
- default: meetings-api's `SERVICE_AUDIENCE` is required through `PRODUCTION_REQUIRED_KEYS`, not `REQUIRED_KEYS` — why: meetings-api's `env.ts` keeps it optional on purpose; a local `--env local` run is therefore not flagged — where: `manifest.ts`
- default: hours-api's keys are all in `REQUIRED_KEYS` (every environment) — why: its `env.ts` requires every variable at start — where: `manifest.ts`
- scope: meetings-api added to the shared `SERVICE_AUDIENCE` list and to the `SERVICE_AUDIENCE` ≠ `AUTH_AUDIENCE` check — why: it verifies the same token; a drift would silently 401 hours-api — where: `manifest.ts`, `check.test.ts`
- scope: hours-api added to the `NOTIFY_INTERNAL_TOKEN` forbidden-var entry — why: `retiredToken.test.ts` requires that entry to equal `BACKENDS` — where: `manifest.ts`
- scope: edited `live.test.ts` (outside `touch:`, one expected-list line) — why: adding hours-api to `BACKENDS` breaks "loads every backend from the runner" otherwise — where: `tools/env-doctor/live.test.ts`
- default: new internal-URL, public-URL and CORS entries added as new blocks; `SHARED_VARS` and `ISSUER.resourceServers` extended in place — why: R3 asks for additive edits, but `SHARED_VARS` compares services within one entry — where: `manifest.ts`
- default: shared-variable name `HOURS_SERVICE_CLIENT_SECRET` (`<TOOL>_SERVICE_CLIENT_SECRET` pattern) — where: `hours-api.env`, `auth.env`
- default: hours-api's production `ALLOWED_ORIGINS` = shell origin + admin-ui origin (refund-api's pattern); no `NOTIFY_INTERNAL_URL` — why: the Time lists page calls hours-api directly; hours-api sends no notification — where: `hours-api.env`
- assumption: the Railway project variable `shared.SERVICE_AUDIENCE` already exists; only `HOURS_SERVICE_CLIENT_SECRET` is new (a person creates it) — where: `hours-api.env`, `meetings-api.env`

## T34 · devops · 2026-11-13
- scope: added the three CSP pins for hours-api and hours-ui (`connect-src` for the API, `script-src` and `connect-src` for the remote) to `infra/check.sh`, beyond the four probes the done-when names — why: every other tool has them, and they match what T23 asserts; they fail until the shell is redeployed, which is when the runbook runs the check — where: `infra/check.sh`.
- default: the 401 probe on meetings-api `/system/meetings/hosts` uses the bare URL with no query — why: the route checks the credential before the query; matches the crm-api `/system/companies` probe — where: `infra/check.sh`.
- default: hours-api and hours-ui changesets are `minor`, written at feature level — why: the other new packages carry pending `minor` changesets over 0.1.0 — where: `.changeset/hours-api.md`, `.changeset/hours-ui.md`.
- assumption: `HOURS_REMOTE_URL` is the shell build's env name for the hours remote — why: follows `PROJECTS_REMOTE_URL`; T23 owns `shell/vite.config.ts` in parallel (verify at T23 integration) — where: `shell/playwright.config.ts`.
- default: hours-api and hours-ui placed after activities-api and projects-ui in `lerna.json`, hours-ui last in `ui:check` — where: `lerna.json`, `mise.toml`.
- default: `db:migrate` runs hours-api last, with no `set -e`, as the siblings do — why: without its direnv file the failure leaves the other nine databases migrated — where: `mise.toml`.

## T11 · backend-dev · 2026-11-13
- reinterpretation: "drop items whose id was not asked for" is kept with one addition — if an owner hands back an item nobody asked for AND an asked id is missing, the answer is `unavailable` (`filter_ignored`), not "absent"; applies to activities `ids`, meetings `ids` and the system route's `?ids=` — why: an owner that ignored the filter (a meetings-api before T8 returning the caller's latest page) proves nothing about what is absent; reading the rest as "not yours" would turn the creator's own older meeting into a false 404 — where: `owner.ts` `keepAsked`, `activities.ts`, `meetings.ts`.
- reinterpretation: a system-route `?dealId=` answer drops items whose host is not exactly `{crm, deal, <dealId>}` instead of answering `unavailable` (plan amendment 2) — where: `meetings.ts` `readMeetingsLinkedToDeal`.
- default: in the deal scan, an activity not about the deal, or pages that do not add up to the owner's `total`, make the whole answer `unavailable` — why: "absent" means "not involved" (a 403); a scan that cannot account for every activity must not pass for the whole list — where: `activities.ts` `listDealActivities`.
- default: any one batch that does not answer, or answers `not_reader`, makes the whole call `unavailable` / `not_reader`; at most 4 batches in flight, no new batch after a stop — where: `owner.ts` `inBatches`.
- default: only a clean 200 with a JSON body is an answer; every other status, a redirect, a timeout, a network error and a contract-breaking body are `unavailable` — why: task text and R7 — where: `owner.ts` `callOwner`.
- default: an owner `href` that is not a suite path (`/…`, not `//`, no scheme, backslash or whitespace) makes the call `unavailable` — where: `owner.ts` `isSuitePath`.
- default: an open project without `assignees`, an open deal without `involved`, or a resolve that leaves an asked id unanswered is `unavailable` — why: fail closed — where: `projects.ts`, `crm.ts`, `owner.ts`.
- default: `listMeetingsByIds` keeps only rows with role `creator` or `participant`; a `host_reader` row is absent — why: plan "On a meeting" — where: `meetings.ts`.
- default: the service-token client retries ONCE with a fresh token after a 401, then `unavailable`; a token that cannot be minted is `unavailable` and meetings-api is not called. Cost: a persistently refused credential makes two mints per read — where: `meetings.ts` `callAsService`.
- assumption: the clients trust the id rule to be enforced upstream (T14–T16) and do not re-check it; query values are built with `URLSearchParams` — where: `owner.ts` header.
- default: `ActivityFact` exposes flat ids (`projectId`, `dealId`, `assigneeId`, `participantIds`) plus `subject` and `type`; `MeetingFact` is `{id, title, role}`; `MeetingHost` is `{dealId|null}` — a host that is not exactly `crm`/`deal` (case or padding variants included) reads as no deal; a `crm`/`deal` host with an empty `entityId` reads as no deal; a host of the wrong shape fails its batch — where: `activities.ts`, `meetings.ts` `dealOf`.
- scope: `src/clients/hosts.test.ts` and `contract.test.ts` pin the fake's strictness, recording and reset — where: `hours-api/src/clients/`.
- default: `hosts.ts` imports `./world` for `onReset`; one fake instance per test file; `stop()` restores the env it found; `FailureMode` adds `withStatus` and `after` — where: `hours-api/src/test-support/hosts.ts`.
- default: the fake meetings-api mirrors T9's route rules (trim, empty/blank members 422, raw caps 6500/128, NUL `dealId` → `[]`, id ascending, exact `{crm, deal, dealId}` match) — where: `hosts.ts`.

## T23 · frontend-dev · 2026-11-13
- scope: also edited `shell/src/italian.test.tsx` (outside `touch:`) to assert the Italian "Le mie ore" row after "Le mie riunioni" — why: the UI language is fixed when the strings module loads, so `UserMenu.test.tsx` cannot switch to Italian (AC-5.5) — where: `shell/src/italian.test.tsx`
- default: `strings.tools.hours` is "Hours" / "Ore", used for the `RemoteMount` label and the About row (Italian load error "Impossibile caricare Ore.") — where: `shell/src/strings.ts`, `router.tsx`
- default: the changeset `@operai/shell` minor also describes the `VITE_HOURS_API_URL` trust from T21 — why: T21 deferred the shell changeset to T23 — where: `.changeset/shell-hours.md`
- default: dev default `HOURS_REMOTE_URL` is `http://localhost:5184/remoteEntry.js` (same env name T34 used in `shell/playwright.config.ts`) — where: `shell/vite.config.ts`
- assumption: production hostnames `hours.operai.welld.io` and `hours-api.operai.welld.io` in the CSP and `runtime-config.example.json` — where: `shell/vercel.json`, `shell/public/runtime-config.example.json`
- scope: `/hours` and `/hours/$` added to the route-path allowlist of the hardcoded-copy scan — where: `shell/src/lib/noHardcodedStrings.test.ts`
- scope: tests beyond the done-when (CSP names exactly the two hours origins, no wildcard; `remotes.d.ts` declares both modules; the shell's remote name/exposes/port agree with `hours-ui/vite.config.ts`; `@source` line; runtime override; `TOOLS` guards; About degrade cases) — where: `remoteVersionSpecifiers.test.ts`, `runtimeRemotes.test.ts`, `tools.test.ts`, `AboutModal.test.tsx`
- reinterpretation: "no session → the `_authed` sign-in redirect" is tested as "not mounted, `getSession` consulted, and the route sits under `_authed`" rather than by asserting the redirect URL — why: jsdom cannot follow the document redirect; `router.test.tsx` pins the guard's URL — where: `shell/src/router.hours.test.tsx`

## T26 · frontend-dev · 2026-11-13
- scope: optional props `current` (the edited entry's activity, typed as the view's `activity`), `error` and `disabled` beyond the task text — why: T27/T28 wire this component but their `touch:` excluded `ActivityField*`; `current` is "the current activity stays an option", `error` carries `activity_not_allowed` onto the field (design S2), `disabled` covers the dialog while saving — where: `ActivityField.tsx`
- reinterpretation: while the field is `aria-disabled` (idle, loading, failed) a pick is ignored and the select keeps what it had — why: design-system rule 5 (an `aria-disabled` control ignores its action); clearing an existing activity is possible once Try again succeeds — where: `ActivityField.tsx`
- assumption: Try again moves focus to the select before the read starts — why: the button unmounts as loading begins and focus would fall to `<body>` — where: `ActivityField.tsx`
- default: the status text is both the visible Field hint (`aria-describedby`) and a persistent `VisuallyHidden role="status"` — why: a live region that already exists is announced reliably (`Combobox` does the same) — where: `ActivityField.tsx`
- default: Try again sits after the Field as a sibling (`Button ghost sm`, `strings.common.tryAgain`) — where: `ActivityField.tsx`
- default: the current activity goes right after "No activity", reads as the page words it when present (no duplicate), else "Name unavailable" / "Not visible to you" — why: never invents a name — where: `ActivityField.tsx`, `strings/activity.ts`
- default: an unknown activity type shows its subject alone; a malformed item is skipped; a body that is not a page is a failed read, never an empty one — where: `lib/activitiesRead.ts`
- default: the read's failure is `errorFromResponse`'s `HoursApiError`; the field has one UI state for 404, 503 and network — where: `lib/activitiesRead.ts`
- default: the select gets `aria-disabled:opacity-60 aria-disabled:cursor-not-allowed` (the `Combobox` inert look) — why: tokens.css draws no `select[aria-disabled]` state; relies on T23's `@source` — where: `ActivityField.tsx`
- assumption: Italian wording ("Scegli prima un'opportunità.", "Nessuna attività", "Non visibile a te", "Nome non disponibile", `task` → "Attività") chosen by the agent; "Non visibile a te" may want harmonising with T25's `names.ts` — where: `strings/activity.ts`
- default: test ids `hours-activity`, `-field`, `-select`, `-retry`, `-error`; status is `role="status"` — where: `ActivityField.tsx`

## T24 · frontend-dev · 2026-11-13
- assumption: presets are whole calendar spans (Monday–Sunday, the month, the year), not "up to today" — why: no entry can be dated after today, so the data is the same; Custom and the export name show the period chosen — where: `lib/period.ts`
- assumption: the 366-day span counts both end days (sent to the architect as batch-3 item) — why: stricter reading; the client never sends what the server could refuse under either reading — where: `lib/period.ts`
- scope: new `lib/useHoursQuery.ts` (+ test) outside `touch:` — why: three reads need the same key, stale-discard, abort and reload logic; T29 reuses it — where: `lib/useHoursQuery*`
- default: URL read with `useSearch({ strict: false })`, written with a replacing `navigate` (inventory-ui `AssetsPage` way), not `validateSearch` on the route — why: `router.tsx` is outside T24's `touch:` — where: `pages/MyHoursPage.tsx`
- default: a category or work type in the URL counts only once the lists hold it; a link naming one waits for the lists before the first request; if the lists fail it is not applied — why: the card must show exactly what is applied — where: `MyHoursPage.tsx`
- default: Group by is a view choice — "Clear filters" keeps it and it does not make the button appear — where: `HoursFiltersState.ts`
- default: choosing Custom opens on the range being looked at; "required" date errors appear after the field is left, "To before From" and "over 366 days" at once — where: `MyHoursPage.tsx`, `HoursFilters.tsx`
- reinterpretation: the failed-totals message comes from the catalog, not the server's English `detail` — why: AC-5.5 — where: `MyHoursPage.tsx`
- reinterpretation: "Clear filters" sits in the Card `action` slot, so Tab reaches it before Period (design's keyboard path lists it last, its placement says `action`); DOM order = visual order — where: `HoursFilters.tsx`
- scope: `HoursFiltersState.ts` and `TotalsCardRows.ts` split out — why: a component file may export only components (`react-refresh`) — where: `components/`
- default: an unknown group kind shows as "Other hours", a keyed group with no name "Name unavailable" (never an id), a malformed month key as sent — where: `TotalsCardRows.ts`
- assumption: Italian copy chosen by the agent ("Totali", "Raggruppa per", "archiviata/archiviato", "Tipi di lavoro dei progetti/delle opportunità", "Intervallo personalizzato") — where: `strings/{filters,totals,myHours}.ts`
- default: the "(retired)" suffix is defined in both `filters` and `totals` strings (area ownership; `names` is T25's) — where: `strings/`
- default: entries and day totals are fetched now but drawn by T25 — where: `MyHoursPage.tsx`
- default: filter grid `minmax(160px, 1fr)`; pickers show the company as a secondary label; an empty field asks without `q` — where: `HoursFilters.tsx`, `lib/searchers.ts`
- glossary candidates (not yet accepted): "merged group" (the one row for hidden, unavailable, deal-unknown or none), "day total".

## T32 · frontend-dev · 2026-11-13
- reinterpretation: success wording names the item (`Category “X” added.`, `Renamed to “X”.`, `“X” updated: entries now need a note.`); Retire/Restore text is design.md's verbatim — why: design gave only "Category added" / "Renamed", and the banner sits above all three cards — where: `strings/timeLists.ts`
- default: the dialog sends only members that changed and closes with no request when nothing changed — why: an empty PATCH is 400; an unchanged `requiresNote` could overwrite another admin's change — where: `TimeListsPage.tsx` `submitItem`
- default: the dialog owns form state and validation; the page owns the request via `onSubmit(values) => Promise<failure|null>` — where: `TimeListItemDialog.tsx`
- default: Name counts `[...trimmed].length` (code points, not grapheme clusters), refuses NUL client-side, validates on blur once typed — where: `TimeListItemDialog.tsx`
- default: 403 on Add/Rename is an inline dialog line; 403 on Retire/Restore switches the page to `PermissionDenied` (design S5); 404 on Retire/Restore/Rename closes any dialog, reloads and shows an info banner (`Banner tone="info"`); 404 on create is a generic failure — where: `TimeListsPage.tsx`
- default: the row-failure banner has a dismiss ×, clears when that item is asked again; a new error removes an older success banner; rows act concurrently with busy per row, latest failure wins — where: `TimeListsPage.tsx`
- default: after Add/Rename focus returns to the opener (library behaviour) — where: n/a
- assumption: a newly added item is appended before the retired ones without a refetch (T12 orders `createdAt asc, name asc, id asc`, consistent) — where: `TimeListsPage.tsx` `withItem`
- default: work-type cards side by side from `lg` (1024px); success banner `wrap-anywhere`; table name cells scroll inside the table's focusable region (at 360px the Categories table scrolls sideways to reach its actions) — where: `TimeListsPage.tsx`, `TimeListCard.tsx`
- default: both work-type cards read "Add work type" (design), no extra `aria-label` (WCAG 2.5.3); dialog titles name the list — where: `TimeListCard.tsx`
- default: work-type cards also get the "retired, not deleted" footnote; a busy toggle's name becomes "Retiring X" / "Restoring X" — where: `strings/timeLists.ts`, `TimeListCard.tsx`
- assumption: Italian copy chosen by the agent (Attivo, Ritirato, Rinomina, Ritira, Ripristina, "Richiede una nota", "Aggiungi categoria", "Aggiungi tipo di lavoro", feminine/masculine banner sentences, "Nome cambiato in “X”.") — where: `strings/timeLists.ts`, `strings/badges.ts`
- scope: `TimeListStatusBadge.tsx`, `TimeListsPage.cards.test.tsx` added; `TimeListsPage.it.test.tsx` mock extended — where: as named

## T12 · backend-dev · 2026-11-13
- default: `GET /time-lists` orders by `createdAt asc, name asc, id asc` — why: plan silent; seeded rows share one `createdAt` so they come out alphabetical, a new item lands last (design S5 mock-up) — where: `src/lists/lists.routes.ts` `inListOrder`
- reinterpretation: only a refusal is cached (30 s per `(sub, perm_epoch)`), a grant never; an outage is cached as neither — why: § Sequences says "resolved live on every list write"; the projects-api shape caches grants too, which would let a revoked holder write for 30 s — where: `src/authz/timeListManage.ts`
- default: the `auth` resolve call has a 2 s timeout and `redirect:"error"` (projects-api uses 5 s) — why: plan R2; a redirect would replay the Bearer — where: `src/authz/resolveClient.ts`
- default: the resolve answer is read strictly (every entry an object with string `resource`/`action`, else 503) — where: `resolveClient.ts`
- default: any grant of `(time-list, manage)` counts; `conditions` not read — why: the catalog declares none — where: `timeListManage.ts`
- scope: the id rule and name rule live in `src/lists/idRule.ts` and `nameRule.ts` (`src/lib/` outside `touch:`) — note: T13 built a second copy of the id rule in `src/labels/idRule.ts`; consolidated by T14 (re-sync) — where: `src/lists/`
- reinterpretation: `PATCH {}` is 400 (`field` empty); a PATCH whose members all equal the stored values is 200 and writes nothing, `updatedAt` included; retire keeps the first `retiredAt` — where: `lists.routes.ts`
- default: Rename allowed on a retired item, which stays retired; a case-only self-rename is allowed — where: `changesTo`
- assumption: any P2002 on a list write is `name_taken`; non-ASCII case-insensitivity is Postgres `lower()` under the DB locale — where: `lists.routes.ts`, `lists.test.ts`
- default: 403/503/409 bodies are `problem()` responses returned (not thrown) from the middleware; `__resetTimeListManageCacheForTests` exported; the OpenAPI problem schema is not a named component — where: `timeListManage.ts`, `errorDocs.ts`
- hand-off: `fetchResolvedPermissions` in `src/authz/resolveClient.ts` is reusable by T19; to simulate a revocation use `hosts.fail("auth.resolve", { body: { …, permissions: [] } })`

## T13 · backend-dev · 2026-11-13
- default: a person `auth` answers `unknown` is named as `identities` in `unavailable`, like an outage — why: `resolveIdentities` cannot tell the two apart; `auth` answers `unknown` only for an id with no row — where: `labels/resolve.ts`
- default: an activity whose project or deal did not answer shows `{ id, subject: null, visibility: "unavailable" }` even if activities-api answered, and `activities` is not named — why: AC-4.10 forbids the subject unless the viewer is known to read the target — where: `labels/resolve.ts` `activity()`
- default: a hidden target hides its activity (`visibility: "hidden"`, no subject) whatever activities-api said; `activities` is still named if its call failed — where: `labels/resolve.ts`
- default: `TimeEntryViewSchema` is strict zod with `.openapi("TimeEntryView")`, `TimeEntryView` inferred from it, for T14/T17 to reuse — where: `entries/view.ts`
- default: `satisfiesIdRule` exported from `src/labels/idRule.ts` (UTF-16 units, `trim() === id`, no NUL, no comma) — a second copy of T12's rule; see T12 — where: `labels/idRule.ts`
- default: a meeting `href` is `/my-meetings/m/` + `encodeURIComponent(id)`; a stored blank note reads as `note: null` — where: `labels/resolve.ts`, `entries/view.ts`
- assumption: the parallel-sources test uses 300 ms delays and a 1200 ms ceiling — timing-based, could flake under heavy load — where: `labels/resolve.test.ts`
- hand-off: T14/T17 call `viewEntries(authorization, rows)` after `findMany({ include: ENTRY_INCLUDE })`; T18 calls `resolveLabels` with only the ids its grouping needs; a label asked for an unlisted id throws

## T25 · frontend-dev · 2026-11-13
- default: Edit/Delete render only when the page passes `onEdit`/`onDelete` (none in T25; T27/T28 add one prop each) — where: `components/EntryDayList.tsx`, `pages/MyHoursPage.tsx`
- default: Edit/Delete `aria-label`s use the short duration ("Edit 4 h on Project Alpha, 12.11.2026", design S1), not the spoken form — where: `strings/entries.ts`, `lib/names.ts`
- default: focus on the Totals heading via a `display: contents` wrapper, the card's `aria-labelledby` lookup and `tabIndex=-1` (`TotalsCard.focusHeading()`); no library change — where: `components/TotalsCard.tsx`
- default: "Clear the deal filter" finds the Deal input through T24's test id `hours-filter-deal-input` (coupling) — where: `pages/MyHoursPage.tsx`
- default: banners keep their last settled content while reads load, none while blocked; the deal-grouping warning shows only when Group by is Deal and totals name `meeting-deals`; Retry in the AC-4.11 state re-asks all three reads — where: `pages/MyHoursPage.tsx`
- default: a day appears once at its first entry (server order); Other-work rows show the category, no name; Load more announces "N more entries loaded, M shown" — where: `EntryDayList.tsx`, `strings/entries.ts`
- default: paging hook `useHoursPages` added to `lib/useHoursQuery.ts` for T29 to reuse — where: `lib/useHoursQuery.ts`
- assumption: Italian copy chosen by the agent ("Registrazioni", "Totale del giorno", "Altro lavoro", "Carica altre", banner and AC-4.11 sentences); "Non visibile a te" / "Nome non disponibile" harmonised with T26 — where: `strings/entries.ts`, `strings/names.ts`
- scope: own fixtures `ENTRY_DAY_TOTALS`, `totalsWithDays`; `entries.invalidPeriod` string; T24's `MyHoursPage.test.tsx` and `.it.test.tsx` adjusted for the Entries card and AC-4.11 — where: as named

## T29 · frontend-dev · 2026-11-13
- default: after 3 s with permissions still unresolved (all-empty `/authz/me`, or a failed one) the page shows the denial and asks nothing; fail closed, the server stays the gate for a revoked grant (403 → same denial) — why: T22 says never wait on `resolved` without a bound — where: `pages/EveryoneHoursPage.tsx` (`PERMISSIONS_WAIT_MS`)
- reinterpretation: a deactivated person with no name reads "Unknown user (deactivated)" (design "<name> (deactivated)", task "label:null → Unknown user") — why: auth returns `name: null` for `deleted` — where: `components/PersonFilterOptions.ts` `personName`, shared by filter, column and totals
- default: a `?person=` the people read never names shows as "Unknown user"; one the page saw keeps its last name; `?person=` is applied only if it passes the id rule, else it is nobody and never reaches the API — where: `PersonFilter.tsx`, `HoursFiltersState.ts`
- default: Clear filters drops `person`; `FilterView` (`'mine' | 'everyone'`) decides the default Group by (person vs project) and whether `person` is read — where: `HoursFiltersState.ts`
- default: outage = 503 `authz_unavailable` on entries or totals (the people alone failing this way is soft); denial = 403 on any of the three reads; denial beats outage beats the deal-filter state; Filters card stays under the outage banner; Retry re-asks all three with My hours' focus rules — where: `EveryoneHoursPage.tsx`
- default: the Person select sits after Period (and From/To), before Project; `aria-disabled` while loading or failed; its hint is not an alert — where: `HoursFilters.tsx`, `PersonFilter.tsx`
- default: floor errors show after the field is left (typing passes through 0002, 0020, 0202); "To before From" and "over 366 days" stay immediate; years 0000–0099 count as too early; the message formats the floor through `formatDate` — where: `lib/period.ts` (`MIN_DAY`, `rangeErrors`), `HoursFilters.tsx`
- default: the entries table has no row header (all `td`); Details is the activity line then the full note — where: `EntriesTable.tsx`
- scope: outside `touch:` — `components/HoursBanners.tsx` (+test) gains an optional `hiddenCopy` (S4's wording); `components/HoursShell.tsx` (+test) sets `includeSearch: false` on both tab links, fixing a T22 defect: with any filter in the URL neither tab was marked current (`aria-current="page"` missing, My hours too) — where: as named
- scope: `PersonFilterOptions.ts` holds `personName`/`personOptions`; the Person words live in `strings/everyone.ts` (T30's export "Unknown user" can reuse `strings.everyone.person.unknown`) — where: as named
- scope: the banner-state block (`NO_BANNERS`, `sameBanners`, `totalsFailure`) is duplicated from `MyHoursPage` (T27's file in this batch) — where: `EveryoneHoursPage.tsx`
- known gap: a 403 or `authz_unavailable` on a later "Load more" page stays the generic "More entries could not be loaded" with a Retry that will fail again — where: `EveryoneHoursPage.tsx`
- assumption: Italian copy chosen by the agent ("Le ore di tutti", "Utente sconosciuto (disattivato)", "Tutti", "Persona", "Giorno/Su/Dettagli", the denial/outage sentences, "La data non può essere precedente al 01.01.2000.") — note design's floor copy differs ("La data di inizio/fine non può precedere il 01.01.2000.") — where: `strings/*.ts`

## T27 · frontend-dev · 2026-11-13
- default: Duration and Category use a hidden, disabled placeholder option, so nothing is preselected and exactly 48 durations are offered — where: `EntryDialog.tsx`
- reinterpretation: the dialog owns form state, client rules and the words for each refusal; the page owns the request (`onSubmit` resolves or rejects with the server's error; no state set after success) — why: design "initial values in, one submit out", reusable by specs/030 and 031 — where: `EntryDialog.tsx`, `MyHoursPage.tsx`
- default: Save validates everything; Day and Note also on blur; a showing error is re-judged live for day, duration, kind, category and note, cleared on edit for entity, work type and activity — where: `EntryDialog.tsx`
- default: the over-limit note error appears on blur or Save; the counter always shows "n of 1000" — where: `EntryDialog.tsx`
- default: required-note error "Add a note: this category needs one" vs hint "This category needs a note" (never one text for both) — where: `strings/entry.ts`
- default: optional members are omitted from the POST body, never `null`; a blank note is not sent; any other note sent exactly as typed — where: `EntryDialogModel.ts` `toInput`
- default: a refusal code whose field is not in the dialog for the chosen kind becomes the generic alert; `host_unavailable` on other work is generic too — where: `EntryDialogModel.ts` `failureOf`
- default: a retired or unavailable category/work type reads as "not chosen" and is not sent (derived from the lists) — where: `EntryDialog.tsx`
- default: after a failed Save focus goes to the first invalid control; the pickers go quiet for one frame so focusing them does not open the list over their own error (found by rendering) — where: `EntryDialog.tsx` (`quiet`, `askFocus`)
- default: Save disabled only for Other work with no non-retired category (design S2); every activity-field state keeps it enabled — where: `EntryDialog.tsx`
- default: while the lists load or fail, category/work-type selects are `aria-disabled` with a hint and a Try again (`onReloadLists`, not in design); a category or work-type refusal also reloads the lists — where: `EntryDialog.tsx`
- default: success banner `SuccessBanner` remounted per save: "Entry saved." or "Entry saved. 20.10.2026 is outside the period you are viewing." — where: `MyHoursPage.tsx`, `strings/entry.ts`
- default: the meeting picker shows the title with `formatDate(startsAt)` as secondary label (`startsAt` may be null); `searchMeetings`/`MeetingChoice` beside the other searchers — where: `searchers.ts`, `EntryDialog.tsx`
- default: Record hours is the `PageHeader` primary; the deal-filter-unavailable state does not hide it; the Day input carries `min="2000-01-01"`; client rule order: required, real calendar day, 2000 floor, future day — where: `MyHoursPage.tsx`, `EntryDialogModel.ts`
- scope: `isRealDay` is a private copy of `period.ts`'s round trip (`dayOf` not exported, `period.ts` outside `touch:`) — where: `EntryDialogModel.ts`
- assumption: Italian copy chosen by the agent ("Registra ore", "Salva registrazione", "Su cosa hai lavorato", the refusal sentences) — where: `strings/entry.ts`
- library follow-up (not done, see end of T27) — continued below.

## T14 · backend-dev · 2026-11-13
- reinterpretation: bodies accept all four `on` types, but a write that still needs an owner (create or move onto a project, deal or meeting; a new or carried activity pointer) answers 501 `not_implemented`, nothing written, no owner called, until T15/T16 fill `askOwners` — why: accepting such a target unchecked would let anyone book on any project (fail closed) — where: `entries.routes.ts` `askOwners`, TRANSITIONAL block in `write.test.ts`
- reinterpretation: a `PATCH` is validated against the entry as it will be stored; a stored work type or activity is CARRIED across a move and must fit the new target (422 `work_type_not_allowed` / `activity_not_allowed`), never dropped silently; a client changing the kind of target must send `workTypeId: null` / `activityId: null` — why: plan silent on moves; silent clearing would lose data — where: `validateWrite`
- assumption (amendment 4 asked for a choice): a `PATCH` re-sending the stored retired `workTypeId` with the target unchanged is accepted; a different retired one is 422 `work_type_retired` — why: consistent with D46 and AC-3.4 — where: `validateWrite`
- default: `PATCH {}` is 400 `invalid_request` (`field: ""`) — where: `schemas.ts` `UpdateEntrySchema`
- default: 422 bodies carry a `field` member next to `code` — why: design S2 lands codes on fields — where: `rules.ts` `refusal`
- default: a `PATCH` looks the entry up (404) before any rule (422) — where: `entries.routes.ts`
- default: 422 order — duration, day, note length, work type (no-list / not found / wrong list / retired), activity, category, `note_required`, then owners — where: `validateWrite`
- default: an unchanged `activityId` is never re-asked of activities-api (D47); a new one, or one carried across a move, is — where: `OwnerChecks.activity`
- default: the id rule's single home is `src/lists/idRule.ts`; `src/labels/idRule.ts` re-exports it as `satisfiesIdRule`, pinned by a test; the date rule's single home is `src/entries/rules.ts` (`isCalendarDay`, `FIRST_DAY`; `DaySchema` in `schemas.ts`) for T17/T18 — where: as named
- default: the clock is a seam in `today.ts` (`__setClockForTests`) — where: `today.ts`
- default: `minutes` must be a JSON number (else 400); a number that is not a whole half-hour (45.5, Infinity) is 422 `invalid_minutes` — where: `schemas.ts`
- assumption: "404 byte-identical" is asserted with the requested id normalised out of `instance` (the shared `problem()` echoes the path) — where: `write.test.ts` `sameAnswer`
- default: `DELETE` is `deleteMany({id, userId})`, `PATCH` is `update({where:{id,userId}})`, Prisma `P2025` mapped to the same 404; one test creates and drops a temporary trigger on `hours_test` to produce a real `P2025` — where: `entries.routes.ts`, `write.test.ts`

## T15 · backend-dev · 2026-11-13
- default: the target's 404 carries `code: "not_found"` and one generic detail with no id or kind (project, meeting, missing and unreadable byte-identical) — why: plan § Errors, AC-2.10; hours-ui `failureOf` switches on `not_found` — where: `src/targets/errors.ts`
- assumption: T14's entry 404 (`entryNotFound()`, entry not the caller's or gone) keeps NO `code` — why: hours-ui reads `not_found` on a save as "that project, deal or meeting is gone", which would be wrong for a vanished entry; told to T28 — where: `entries.routes.ts`
- default: bookability runs before the activity pointer, so a 403/404 is never hidden behind the pointer's answer — where: `entries.routes.ts` `askOwners`
- default: a project resolved without usable `assignees`, or an answered map with the asked id undefined, is 503 (fail closed) — where: `targets/bookability.ts`
- default: 403 `not_on_project` carries no `field` — where: `targets/errors.ts`
- scope: POST/PATCH OpenAPI docs gained 403 and 503; 404 also covers the target; DELETE keeps the entry-only 404 — where: `entries.routes.ts`
- default: the deal branch of `assertBookable` and the activity branch in `askOwners` still answer the transitional 501 for T16 to replace — where: `targets/bookability.ts`, `entries.routes.ts`

## T17 · backend-dev · 2026-11-13
- reinterpretation: `whose=all` answers 501 `not_implemented` after validation and before any owner, `auth` or database call, until T19 puts the live `time-entry:read-all` check there — where: `list.routes.ts` (TRANSITIONAL block)
- default: the query is strict — an unknown member (`projectID=`, `groupBy=` on the list) is 400 `invalid_request` with empty `field` — why: a mistyped filter would silently widen a view — where: `list.routes.ts` `ListQuerySchema`
- default: `userId` next to `whose=mine` is 400 `field: "userId"` — where: `filters.ts` `readFilters`
- default: `limit` is plain digits 1–500 (no sign, exponent or leading zero); empty or repeated → 400 `field: "limit"`; default 100 — where: `list.routes.ts` `isLimit`
- default: the cursor's instant is zero-padded to 13 digits when minted and any 13 digits accepted when read — why: rows before 2001-09-09 have a 12-digit epoch ms — where: `mintCursor`, `readCursor`
- default: `nextCursor` is `null` on the last page (fetch `limit + 1`); the cursor codec lives in `list.routes.ts` — where: `list.routes.ts`
- default: the `target` filter is the entry's own stored target (a meeting entry is `meeting` even under `dealId`); filters AND together — where: `filters.ts` `entryWhere`
- default: meeting ids from the system route's `?dealId=` answer that fail the id rule are dropped from the SQL `IN` list — why: a NUL would otherwise reach Postgres — where: `filters.ts` `dealCondition`
- default: `hostUnavailable` (503) and `invalidRequest` (400 in `invalidRequestHook`'s shape) are local helpers in `filters.ts` (T15's was not in the tree yet) — to unify with `src/targets/errors.ts` in T19 (re-sync) — where: `filters.ts`
- default: check order — shape, then `userId`/`whose`/span, then cursor, then 501, then the `dealId` call, then the database — where: `filters.ts`, `list.routes.ts`
- default: response `unavailable` documented as an enum of the six source names (`UnavailableSchema`); the 503 documented on the route — where: `list.routes.ts`
- hand-off: `filters.ts` exports `filterShape`, `readFilters`, `assertPeriod`, `spanDays`, `invalidRequest`, `entryWhere` (always `userId: sub`; T19 adds the everyone scope); `list.routes.ts` exports `UnavailableSchema`, `mintCursor`, `DEFAULT_LIMIT`, `MAX_LIMIT`
- note for T37: `GET /time-entries?dealId=D` is a link oracle for a caller who knows a deal id (prescribed by D45/AC-2.6; `on.deal` still withholds id and name)

## T28 · frontend-dev · 2026-11-13
- default: Save with nothing changed closes the dialog and sends no request, no banner — why: `PATCH {}` is 400 and the spec is silent — where: `EntryDialog.tsx` `submit`
- default: the PATCH is a diff of the form against the stored values — `on` only when another target was picked, `null` for what a move cleared (never omitted); a note-only edit on a retired work type sends exactly `{note}` — where: `EntryDialogModel.ts` `toPatch`
- default: typing in an entity picker drops its value; a hidden target cannot be re-picked, and switching the radio away and back loses it (Cancel and reopen recovers it) — why: design "changing the radio clears the entity" — where: `EntryDialog.tsx`
- reinterpretation: a 404 on an edit is the target's only when the save moved the entry AND the answer carries `not_found`; any other 404 is "entry gone" (list reloaded on close); a delete treats any 404 as already gone — shared `entryIsGone(error, moved)` — where: `EntryDialogModel.ts`, `MyHoursPage.tsx`
- default: focus after a successful edit → Record hours (F2 "as F1"); after a delete or an entry-gone close → the page heading (`PageHeader focusableHeading`) — where: `MyHoursPage.tsx`
- reinterpretation: the S3 body is "<duration> on <name or 'a project that is not visible to you'>, <date>. This can't be undone." in every variant (design shows the last sentence only for the visible case) — where: `DeleteEntryDialog.tsx`, `strings/entry.ts`
- default: banners "Entry deleted." (`hours-entry-deleted`) and dismissible info "That entry no longer exists. The list has been refreshed." (`hours-entry-gone`); delete dialog test ids `hours-entry-delete-dialog-*` — where: `MyHoursPage.tsx`, `strings/entry.ts`
- default: the entry's own retired category/work type is shown as "Name (retired)" and, when lists have not loaded, appended from the entry's view with `requiresNote: false` (the server decides); a retired work type is offered only for the entry's own list — where: `EntryDialogModel.ts` `offered*`
- default: dialog props are a union (record vs edit); T27's test helper type narrowed — where: `EntryDialog.tsx`, `EntryDialog.test.tsx`
- default: `ActivityField` gains `locked` for the "not visible" variant (nothing read, the field says why); a withheld pointer's `<option value>` is an opaque token, so its id never reaches the DOM — where: `ActivityField.tsx`
- scope: T25's `MyHoursPage.entries.test.tsx` — "offers neither Edit nor Delete yet" replaced by its positive counterpart; two row selectors tightened — where: as named
- default: `host_unavailable` on an edit uses design's wording ("could not check that you may record hours on this <target>") even when only a new activity was checked; the "outside the period" note after an edit only when the day changed — where: `strings/entry.ts`, `MyHoursPage.tsx`
- assumption: Italian copy chosen by the agent ("Modifica registrazione", the delete dialog, "not visible" hints, entry-gone and locked-activity sentences) — where: `strings/entry.ts`, `strings/activity.ts`

## T16 · backend-dev · 2026-11-13
- default: a deal scan that finds nobody is 403 `not_involved_in_deal` even when `truncated` (R9); one log line `[bookability] deal activity scan stopped at the 10-page bound (R9) and found nobody` (no id, deal or person) so R9's "revisit" signal can be measured — where: `src/targets/bookability.ts`
- default: 403 `not_involved_in_deal` carries no `field`; its detail names the rule, no id — where: `src/targets/errors.ts`
- default: `assertActivityOf` in its own module compares `activity.projectId` (project target) or `activity.dealId` (deal target) with the target's id, no check of the activity's type (a project's activities are tasks only; any pre-sales activity of a deal counts, AC-2.7) — where: `src/targets/activity.ts`
- default: the "ask only when new or carried" rule stays in T14's `validateWrite` unchanged (D47) — where: `entries.routes.ts`
- default: won and lost deals accepted — hours-api reads no stage; proved by scripting crm bodies with a `stage` member — where: `deals.test.ts`
- assumption: the scan counts an activity's `task.assignee` and `participants` only, never its author (AC-2.3) — where: `bookability.ts`
- glossary candidate (not yet accepted): "involved (in a deal)" — owner, technical contact, or the assignee or a participant of one of its activities (AC-2.3)

## T18 · backend-dev · 2026-11-13
- default: `totalMinutes` is the sum of the tallied group rows, not a second aggregate — why: `Σ groups === totalMinutes` by construction, from one snapshot — where: `src/totals/groups.ts` `Tally`
- default: the totals query is strict — `cursor`, `limit` or any unknown member is 400 with empty `field` — where: `totals.routes.ts` `TotalsQuerySchema`
- default: project, deal and category groups tie-break on label with the same `Intl.Collator("en",{sensitivity:"base"})` as person, then key — where: `groups.ts`
- scope: the `whose=all` TRANSITIONAL 501 duplicated in `totals.routes.ts` for T19 to replace — where: `totals.routes.ts`
- default: `groupBy=deal&dealId=D` makes two system-route calls (`?dealId=` for the filter, `?ids=` for the grouping); the second can fail alone (meeting entries to `deal-unknown`, total whole); a relink between them could show a meeting under another deal — a millisecond window, accepted — where: `totals.ts` `byDeal`
- default: a person `auth` returns as `deleted` is `label: null, status: "deleted"`, not an outage; only `unknown` names `identities` — where: `totals.ts` `byPerson`
- default: a stored category missing from `time_category` throws (500) — why: the FK forbids it — where: `totals.ts` `byCategory`
- scope: extra tests — `groups.test.ts` (pure comparators, `Tally`), viewer-not-author via `totalsOf` with everyone's `where` (T19's shape), 130-person/130-meeting batches, OpenAPI wire shape — where: `src/totals/*.test.ts`
- assumption: `unavailable` follows T13's `SOURCE_ORDER` — where: `totals.test.ts`
- hand-off: `totalsOf(groupBy, where, authorization)` is where-agnostic; T19 adds the everyone scope where `where` is built
- note for T37: `GET /time-entries/totals?dealId=D` is the same link oracle as the list's (minutes of the caller's own meeting entries linked to D; no id or name)

## T30 · frontend-dev · 2026-11-13
- reinterpretation: the Person column uses T29's `personName` rule (resolved name, else "Unknown user", "(deactivated)" suffix for a deleted account), not the plan row's plain `person.name` — why: the file must not disagree with the table it exports — where: `lib/hoursWorkbook.ts` `personOf` (plan row to amend)
- default: the Category or work type column writes the name as typed, no "(retired)" suffix — why: plan "the name as typed (AC-3.8)"; summing by name must not split one item — where: `categoryOrWorkTypeCell`
- default: Name, Counts for deal and Activity apply the screen's rule with injected words — a name only for `visibility: "visible"`; a visible one with no label is "Name unavailable", never an id — where: `nameOf`, `meetingDealCell`
- default: `buildHoursWorkbook` throws `RangeError` on non-integer minutes (the button shows its failed alert) — where: `hoursOf`
- default: the walk stops with an error if the server repeats a cursor; no page cap (a cap would silently shorten the file) — where: `lib/exportPages.ts`
- default: a walk is not aborted when the button unmounts; it finishes and downloads (library behaviour) — where: `components/HoursExport.tsx`
- default: file name `hours-<from>_<to>.xlsx` is code, validated as two ISO days — where: `hoursFileName`
- default: the AC-4.11 export refusal applies only with a deal filter set, remembered as the first-page object it happened over (cleared by Retry, "Clear the deal filter", any filter change); the banner takes focus only if focus was lost — where: `MyHoursPage.tsx`, `EveryoneHoursPage.tsx`
- default: any other export refusal (403, 503 `authz_unavailable`, 500, network) is the button's generic alert, view unchanged — where: `HoursExport.tsx`
- default: bold header, frozen header row, column widths, wrap-text on Note cells; `exceljs` in its own lazy chunk (931 kB), the App chunk grew 104 → 108 kB — where: `lib/hoursWorkbook.ts`
- assumption: Italian copy chosen by the agent ("Esporta", "Preparazione del file…", "File pronto", sheet "Ore", the nine headers incl. "Conta per l'opportunità") — where: `strings/export.ts`
- scope: `workbookCopyOf(catalog)` builds the file's words from the screen's catalogs — where: `lib/hoursWorkbook.ts`
- library follow-up (not done): the status line under `ExportButton` grows the card header 36 → 52 px and shifts the heading ~8 px (`.card-header` is `align-items: center`)

## T19 · backend-dev · 2026-11-13
- scope: `src/targets/errors.ts` `hostUnavailable` gained an optional `detail` (outside `touch:`, backward compatible) — why: one 503 helper, but its fixed text "…nothing was saved" is false for a GET; `filters.ts`'s local copy removed — where: `src/targets/errors.ts`
- scope: replaced the tests pinning the TRANSITIONAL 501 and updated the OpenAPI "documented statuses" assertions in `list.test.ts` (outside `touch:`) and `totals/request.test.ts` — where: as named
- default: the oversight refusal cache is its own `Map`, not shared with `timeListManage.ts` — why: a refusal of one permission must not refuse the other (tested) — where: `src/oversight/oversight.ts`
- default: cache key epoch is `c.get("permEpoch")` from the JWT middleware (as T12) — where: `oversight.ts`
- default: shape and cursor 400s are decided before the oversight check (no `auth` call); then 403/503; then the `dealId` call; then the database — a non-holder never makes hours-api ask meetings-api anything — where: `list.routes.ts`, `totals.routes.ts`
- default: a holder's `PATCH`/`DELETE` of a nonexistent id is 404 (not `owner_only`); `auth` failure, missing permission and missing entry are all 404; a database error stays 500 — where: `oversight.ts` `isHolderOfSomeoneElsesEntry`
- default: `EntryScope` is a tagged union (`person` | `everyone`) passed to `entryWhere`; only the oversight check hands out `everyone` — why: an omitted `userId` can't silently mean everyone's rows — where: `scope.ts`, `filters.ts`
- assumption: any grant of `(time-entry, read-all)` counts; `conditions` not read (the catalog declares none) — where: `oversight.ts`
- glossary candidate (not yet accepted): "oversight (hours)" — reading everyone's hours through `time-entry:read-all` with no write right

## T38 · devops (docs) · 2026-11-13
- scope: clauses added to the crm-api, meetings-api, activities-api and projects-api bullets in AGENTS.md (resolve `deal`, `ids`, meetings-api's first `/system/*` route) — why: they would otherwise contradict the code — where: AGENTS.md
- scope: a "The `hours` catalog" table in auth/README.md beside the scope table — where: auth/README.md
- default: AGENTS.md counts — "Nine tools" (table rows + notify-ui), "ten Bun services"; README's counted phrases made count-free ("Every backend", "every frontend") — where: AGENTS.md, README.md
- reinterpretation: "Six are implemented; `meetings-api` is in progress (specs/021)" replaced by "`hours-api` is in progress (specs/029)"; the specs tree line reads "001–032; 015, 017 and 029 are in progress" (021 and 024 are done) — where: AGENTS.md
- default: "Shipped today" gained Projects (was missing) and Hours — where: AGENTS.md
- default: the hours-api bullet describes the final design (oversight, `owner_only`) — T19 is now integrated, so it holds — where: AGENTS.md
- default: the Time tracking table carries `time entry`, `category`, `work type` plus `retired` and `see everyone's hours` (glossary candidates) — where: AGENTS.md
- default: no Data residency bullet (Railway EU, no new processor); O3 sign-off as one sentence in the hours-api bullet — where: AGENTS.md
- pre-existing doc gaps left untouched (follow-up chore): README lacks crm/meetings rows, ports 5180/8085, meetings in direnv/DB lists, refers to a missing `CLAUDE.md`; AGENTS.md service-client row omits `crm.deals.read`, `crm.contacts.read`, `estimai.estimates.read`, `projects.purchase-orders.read`; auth/README scope table omits `estimate-notices.send`, `host-notices.send`, `deal-link-notices.send`, `activities.write`; "all six frontends"; the ADR-0034 convention line predates ADR-0045/0058/0090; the `### Backend services` heading lists five; README projects-ui row says "contracts"

## T39 · devops (runbook) · 2026-11-13
- default: `check.sh`'s 401 probe on `/system/meetings/hosts` runs as a single `curl` at steps 0/3/4, the whole `infra/check.sh` only at step 5 — why: a lookup before the hours DNS exists is cached as "no such host" for 30 min — where: `infra/README.md`
- reinterpretation: `env:doctor --live` is the gate; `--dir ./resolved` the offline alternative (T39 text had them the other way round) — why: `./resolved` writes resolved per-service files to disk — where: step 4
- reinterpretation: the 401 probe is not proof that meetings-api's `SERVICE_AUDIENCE` is set (unset gives the same 401); the proofs are a variable-name check and a read-only "Deal filter" check on My hours — where: steps 3 and 5
- default: provisioning split as `provision-tool.sh hours --port 8088 --no-ui` (step 4), then the full script with `--redeploy-shell --apply` (step 5) — why: `--no-api` does not set `VITE_HOURS_API_URL`; the two-pass run sets both shell variables, service first, frontends last — where: steps 4–5
- default: the two shell variables are set only at step 5, after the hours DNS record exists — why: otherwise the merged shell would query a nonexistent host and cache NXDOMAIN — where: "Order of the release"
- assumption: O3 (labour-law check) must be answered before the merge, or the owner explicitly chooses to merge with an entry that does not open; step 5 not run until it is — why: no per-user grant to withhold (AC-5.1); the menu entry ships with the merged shell — where: step 0
- scope: R2's read-only SQL early check (most meetings linked to one deal, ~1000 threshold) added as a step 3 gate; one row added to the Vercel build-time variable table — where: `infra/README.md`
- assumption: `shared.SERVICE_AUDIENCE` exists in production; checked by name at step 0 — where: step 0
- default: production smoke tests — a record-and-delete employee entry, a read-only admin Time lists view, a read-only Deal-filter check, one booking per owner on things the tester already owns — where: step 5
- rollback trap recorded: never roll `auth` back while its `SERVICE_CLIENTS` still names `meetings.hosts.read`; never delete hours-api or the `hours` DB to roll back — where: "Rollback"

## T20 · backend-dev · 2026-11-13
- default: the matrix runs against the harness's mock of the JWT middleware (same RS256, issuer and audience rules); the real middleware stays proved in `auth/jwt.middleware.test.ts` — why: `mock.module` is process-global — where: `hours-api/src/matrix.test.ts`
- scope: a fifth caller `adminGranted` (admin with both default grants) beside the four named — why: AC-1.6/AC-5.2 "admin included" — where: `matrix.test.ts`
- default: method `ALL` entries are accepted only on `/*`, so no handler can hide behind `app.all`/`app.use("/x")`/`mount` — where: `matrix.test.ts` `audit`
- default: the tests never write the literal `not_implemented` (status 501 only; a regex for the document) so the R11 grep keeps printing nothing — where: both files
- assumption: the contract test also drives the app (extra body keys, 64 vs 65-character ids, path ids); `TimeEntryView` pinned to an exact member list (AC-1.8) — where: `openapi.contract.test.ts`
- scope: extra document checks — every JWT operation documents 401, every read documents 400, document equals route table, no 501/"transitional" text, `limit` 1..500, `from`/`to` pattern, totals without `cursor`/`limit` — where: `openapi.contract.test.ts`
- defect found and fixed (touch widened by re-sync): the `cursor` query parameter lacked `maxLength: 200` in the OpenAPI document (the code already enforced it) — `fix(hours-api)` commit — where: `src/entries/list.routes.ts`
- env note: a mutation briefly deleted the seeded `tc-training` row from `hours_test`; restored with the migration's values
- note for T37: an unauthenticated CORS preflight answers 204, allow-origin only for allowed origins — the only other credential-less answer, pinned by the matrix

## T41 · backend-dev · 2026-11-13
- default: `viewerId` is a required argument of `toView` and `viewEntries`, never defaulted — why: a forgotten call site fails `tsc` instead of handing out ids — where: `hours-api/src/entries/view.ts`
- reinterpretation: `activity.id` follows the activity's own `visibility` (already derived from the target's and from activities-api's answer), so with a visible project and activities-api down another person's `activity.id` is `null`, the author's kept — why: "returned only when the record is visible", fail closed — where: `view.ts` `toView`
- default: `unavailable` is withheld like `hidden` on another person's entry; the author's own keeps the id — where: `view.ts` `idFor`
- default: the nullable id keeps the member (`string | null`, never absent); the schema test refuses a view without it — where: `view.ts`, `view.test.ts`
- default: "own" is `row.userId === viewerId`, `viewerId` the route's verified `sub` (`c.get("userId")`), never parsed inside `view.ts` — where: `entries.routes.ts`, `list.routes.ts`
- scope: edited `src/oversight/read.test.ts` (outside `touch:`): the holder test asserted the hidden project's id `p1` on Bob's entry, now `null` — the contract T41 changes — where: as named
- scope: two sentences in the `GET /time-entries` OpenAPI description on when `id` is `null` — where: `list.routes.ts`
- default: the "unreadable vs missing" view test compares both entries through the same viewer — where: `view.test.ts`
- verified: the review's probe re-run against the branch — `on.id: null` on the hidden deal entry and all hidden meeting entries; the pivot returns `[]` / `{"totalMinutes":0,"groups":[]}` (copy at scratchpad `t41/d44.probe.worktree.test.ts`); 13 mutants killed

## T42 · frontend-dev · 2026-11-13
- default: an own entry whose target id is `null` (unreachable under T41) opens with the target empty and the ordinary hint; Save asks for the target again; it does not open the locked "not visible" variant — why: no id may be invented or sent — where: `EntryDialogModel.valuesOf`
- default: `ActivityField`'s `current` typing fixed by narrowing in the dialog with `keptActivity(activity)`; `ActivityField`'s prop type unchanged — why: plan § Views names the dialog as the boundary — where: `EntryDialog.tsx`, `EntryDialogModel.ts`
- assumption: an activity pointer with an unknown id on an own entry is not handled specially — after a move the client cannot send `activityId: null` for it; unreachable under T41 — where: `toPatch`, `valuesOf`
- scope: edited `EntriesTable.test.tsx`, `hoursWorkbook.test.ts` (forced by the type change), `EntryDialog.edit.test.tsx`, `EntryDialogModel.edit.test.ts`, `fakeApi.test.ts` (outside the literal `touch:`) — where: as named
- default: `fixtures/everyone.ts` and `fixtures/export.ts` entries go through `seenByOthers` (others' entries); My hours/edit fixtures keep ids (own); the export's "no id" test runs over `EXPORT_ENTRIES.map(withIds)` — where: `fixtures/*`, `hoursWorkbook.test.ts`
- default: three `fakeApi.ts` helpers (`seenByOthers`, `withoutIds`, `withIds`) encode the D44 rule instead of on-builders accepting a `null` id — where: `fakeApi.ts`

## T27 (continued)
- library follow-ups (not done): `SearchPicker` builds its `Field` without `errorRole="alert"`, so a picker error is not an alert (design S2 says it is; it is linked by `aria-describedby`, the input is `aria-invalid` and focus moves to it); `SearchPicker` opens its list on any focus, programmatic included — worked around in the dialog.
