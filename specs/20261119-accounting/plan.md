---
spec: 20261119
status: approved
approved: 2026-11-19
approved_note: "approved under the owner's choice of autonomous execution at spec approval (2026-11-19: 'In autonomia', no plan gate); review on the owner's return"
---

# Plan: Accounting — one module for ledger accounts, VAT codes and monthly exchange rates

Planned unattended on 2026-11-19 against the approved spec (owner's request for autonomous execution).
Every decision the spec does not fix took the safest option that fits the code as it is. Each one is
listed with its reason in **Decisions taken unattended** (D1–D34), and each is kept in one place so it
is cheap to change. The four open questions still unanswered have a fallback in **Open questions
accepted as risk**.

Read before this plan: spec.md (this folder); specs/20261118-refund-accounting-export/{spec.md
(Amendments 2026-11-19), plan.md (with Implementation sync, Security review sync, Fix round 1),
design.md, tasks.md, qe-report.md, security-review.md}; the five 20261118 ADRs; AGENTS.md.

## Architecture

### Shape in one paragraph

Accounting is a **new Bun + Hono + Prisma service, `accounting-api`** (port 8089, its own database
`accounting`), plus a **new federated remote, `accounting-ui`** (port 5183), mounted by the shell at
`/accounting` as a `TOOLS` entry. The catalog code (ledger accounts, VAT codes, their status history)
and the exchange-rate code (BAZG client, parser, months, rates service and routes) **move** from
refund-api to accounting-api with `git mv` and gain an `entity` dimension. The catalog and rate screens
**move** from refund-ui to accounting-ui the same way. auth gains an `accounting` catalog (`read` and
`manage`, entity condition), the seed grants, a derived `accounting` entry in `/authz/me` `apps`, and a
read-only service scope. refund-api **no longer stores reference data**. It reads Accounting live as
`system:refund-api` (scope `accounting.reference.read`, 10 s deadline, no cache across requests). It
**copies onto each line**, at classification and at approval, what it books: account number and name,
VAT code and rate, and the exchange rate with its month. A rate that is missing at approval is
copied at the first successful export. Every reference from Refund to Accounting is the entity's
**natural key**: a ledger account's number, a VAT code's code. The spec defines both as the identity
of an entry within its entity. Refund never stores Accounting's surrogate ids.

### Components touched / added

**accounting-api (new).** Modelled on projects-api and inventory-api: JWKS resource server,
authorization-enforcing through `auth GET /authz/resolve`, failing closed. Its own logical DB.

| Path | Role | Origin |
|---|---|---|
| `src/index.ts`, `src/lib/{env,db,problem,logger}.ts`, `src/openapi/`, `src/health/` | App, Problem JSON (`problem` shared copy), CORS = shell only, `bodyLimit` 4 KiB, Scalar | copied from projects-api |
| `src/auth/jwt.middleware.ts`, `src/authz/{resolveClient,authz.middleware}.ts` | User JWT (RS256, issuer, `AUTH_AUDIENCE`); live permissions cached by `(sub, perm_epoch)`, 30 s backstop; 503 on an auth outage | copied from inventory-api |
| `src/auth/systemAuth.middleware.ts` | Service JWT (`aud = SERVICE_AUDIENCE`, `system:` sub, scope). Joins the existing `systemAuth` group of `scripts/check-shared-copies.ts` | shared copy |
| `src/authz/coverage.ts` | `coveredEntities(permissions, user, "read" or "manage")`: the same rule as auth's `entityGrantFor`. An unconditioned grant covers both entities. `{key:"entity",match:"user"}` covers the holder's own entity. Any other condition covers nothing (fail closed). `read` = read ∪ manage (AC-3.2). Shared vectors with auth (R12) | new |
| `src/entities.ts` | `ENTITIES = ["welld_ch","welld_it"]`, `OWN_CURRENCY` (CHF, EUR), `RATE_SOURCE` (welld_ch: BAZG, EUR/USD/GBP; welld_it: none, no currencies) (D19) | new |
| `src/catalog/{ledgerAccounts,vatCodes}.{repo,routes,schemas}.ts`, `src/catalog/limits.ts` | Add, deactivate, reactivate, list per entity. Keyed by number or code in the URL (D24). The limits of AC-1.2 and AC-1.5 live in one module (D31) | `git mv` of refund-api `src/accounting/catalog.*` + entity |
| `src/rates/{bazgSource,parse,months}.ts` | Hardened BAZG client and strict parser, unchanged; month window and fetchability | `git mv` of refund-api `src/fx/*` |
| `src/rates/{rates.repo,rates.service,rates.routes,rates.schemas}.ts` | Rate in effect per entity, correction, manager fetch, consumer-triggered fetch with a 6 s budget (D4), attempt log with a server-derived trigger | `git mv` of `fx.repo/fx.service/fx.routes/fx.schemas` + entity |
| `src/me/me.routes.ts` | `GET /v1/me`: covered entities with `canManage`, for the UI | new |
| `src/system/{referenceData,rates}.routes.ts`, `src/system/accountingWire.ts` | The consumer read (AC-3.8, AC-2.10). The wire schema is a shared copy `accountingWire`, byte-identical in refund-api (D23) | new |
| `scripts/seed-welld-ch.ts`, `scripts/data/seed.welld-ch.json` | Operator-run, idempotent seed of the WellD CH accounts and VAT codes, with `--dry-run` (D20) | catalog half of refund-api's `accounting-seed.welld-ch.json` |
| `prisma/schema.prisma`, `prisma/migrations/<ts>_init` | Schema and triggers (§ Data model) | new |
| `src/test-support/{dbCleanup,testAuth,fakeResolve,fakeSource}.ts` | TRUNCATE cleanup, test JWT mint, fake resolver, fake BAZG | adapted copies |
| `Dockerfile`, `.env.example`, `.envrc`, `package.json` (`db:migrate`, `db:deploy`, `db:generate`, `dev`, `test`, `typecheck`, `seed:welld-ch`) | | copied from projects-api |

**accounting-ui (new).** Modelled on the letterheads-ui scaffold (commit a8448b6f): `./App` and
`./version`, an inner router basepathed at `/accounting`, `AccountingShell` (loads `GET /v1/me`,
then Loading, PermissionDenied or a retry banner), strings `en` and `it` with the parity and
no-hard-coded-copy tests, `api.ts` through `shell/session`'s `apiFetch`, `getAccountingApiBaseUrl()`.
It moves these from refund-ui with `git mv`: `LedgerAccountsCard`, `VatCodesCard`,
`AddLedgerAccountDialog`, `AddVatCodeDialog`, `useCatalogToggle`, `ExchangeRatesCard` (without its
history drawer, D18), `RateCorrectionDialog`, and the matching strings. It gets its own small copies
of the formatting helpers `catalogLabels` and `monthLabel`, which are not components (D29). § UI
has the details.

**auth.**
- `src/authz/catalogs/accounting.ts` (new): appId `accounting`, one resource `accounting` with the
  actions `read` and `manage`, both `supportedConditions: ["entity"]`, and **no `access` action** (D6,
  D7). It is added to `DECLARED_CATALOGS`, so the unique-resource-key test covers it.
- `src/authz/seed.ts`: `seedAccountingCatalog` + `seedAccountingGrants`. `admin` gets both actions
  unconditioned. The `accounting` role gets both with `REFUND_ENTITY_CONDITION`
  (`{attributes:[{key:"entity",match:"user"}]}`), the same object as its Refund grants. Grants go
  through `ensureGrant`, which never rewrites an existing rule (FR-4 posture). No other role gets
  either (AC-3.3).
- `src/authz/authz.routes.ts` and `src/legalEntities/coverage.ts`: `adminAreaReachable` becomes one
  case of a small table `DERIVED_APPS`:
  - `admin` ← `legal-entity:manage`;
  - `accounting` ← `accounting:read` or `accounting:manage`.

  Each covers at least one entity through `entityGrantFor`, and each appended app is presentation only
  (ADR 20261117-an-app-is-reachable-through-a-capability-it-administers). `/authz/resolve`,
  `/authz/app-access-check` and the directory filter do not derive it, the same as for `admin`.
- `src/system/serviceClients.ts`: `KNOWN_SERVICE_SCOPES` gains `accounting.reference.read`.
  refund-api's `SERVICE_CLIENTS` entry gains the scope. This is a variable edit, made only after the
  new auth is live, because auth refuses to start on an unknown scope (R13).

**shell.** Following commit a8448b6f:
- `ToolId` and `TOOLS` gain `{ id: 'accounting', label: strings.tools.accounting, to: '/accounting' }`,
  in the main list, not `SETTINGS_TOOL_IDS` (D32);
- an access-gated `/accounting/$` route (`createToolAccessBeforeLoad('accounting')`);
- the remote entry (`ACCOUNTING_REMOTE_URL`, build-time and runtime config, `RuntimeRemoteEntry`), and
  the ambient module types and stubs;
- `getAccountingApiBaseUrl()` and its trusted origin (`VITE_ACCOUNTING_API_URL`);
- the tool name in both languages, and `useRemoteVersions`;
- CSP in `shell/vercel.json`: `script-src` gains `https://accounting.operai.welld.io`; `connect-src`
  gains it and `https://accounting-api.operai.welld.io`.

**refund-api.**
- **Removed** (moved to accounting-api, or replaced):
  - `src/accounting/catalog.{repo,routes,schemas}.ts` (+ tests) and all of `src/fx/` (+ tests,
    fixtures). `dateToMonth` moves to `src/lib/months.ts`.
  - The routes `/accounting/ledger-accounts*`, `/accounting/vat-codes*` and `/exchange-rates*`. Each
    now answers 404 (AC-3.7, AC-4.6).
  - `REFUND_FX_SOURCE`.
- **New:**
  - `src/accounting/accountingClient.ts`: the `AccountingPort` (§ How Refund reads Accounting).
  - `src/accounting/accountingWire.ts` (shared copy).
  - `src/accounting/referenceSnapshot.ts` (pure): looks up natural keys in one snapshot and gives each
    entry a state: `active`, `deactivated`, `not_found` or `unverified`.
  - `src/accounting/rateCopy.repo.ts`: the export-time copy of pending rates.
- **Changed:**
  - `classification.ts`: the resolver takes copies and a snapshot instead of FK rows. Its rules are
    unchanged: a stored copy wins; otherwise the live default applies, and is usable only when its
    entry is active in the snapshot.
  - `defaults.repo.ts` and `defaults.routes.ts`: new tables storing copies (AC-4.7); writes validated
    live against Accounting.
  - `classification.repo.ts` and `classification.routes.ts`: options from Accounting; the PUT takes
    natural keys and writes copies.
  - `numbering.repo.ts` (`classifyAndNumber`): writes copies and the rate copy (or leaves the rate
    pending).
  - `review/decide.repo.ts` and `review/review.routes`: a pre-read before the transaction.
  - `export.repo.ts` and `export.routes.ts`: built from copies; the pending-rate copy inside the
    export transaction; the Accounting-unavailable blocker; the viewer flag of AC-7.3.
  - `scripts/accounting-release.ts`: no catalog seeding; it reads Accounting.
  - `src/lib/env.ts`: `ACCOUNTING_INTERNAL_URL`.
  - `src/requests/audit.ts`: a new action `line_rate_copied`, and the `line_classified` detail v2.
- One additive migration (§ Data model).

**refund-ui.** Settings loses the "Accounts and VAT" and "Exchange rates" views and keeps General plus
a "Default classification" view. It gains the Accounting link or note. The review panel and the
defaults dialogs take their options from refund-api by number or code, and show the new states
(deactivated, not found, rate pending, Accounting unavailable). The export card gains the
Accounting-unavailable blocker and the AC-7.3 link. The moved components are deleted with `git mv`
(§ UI).

**shell/e2e.**
- `global-setup.ts` seeds Accounting, then releases Refund.
- New: `accounting.spec.ts` and `accounting-access.spec.ts`.
- Adapted: `refund-accounting-settings.spec.ts` (T31) and `refund-accounting.spec.ts` (T32).
- `helpers/accountingFixtures.ts` is new; `refundFixtures.ts` loses the catalog and rate helpers
  (§ Release, e2e).

**Repo plumbing.**
- `lerna.json`; `mise.toml` (`dev`, `dev:web`, `dev:preview`, `db:migrate`; port 8089 and 5183;
  `VITE_ACCOUNTING_API_URL` default); `compose.yaml` (`accounting-api` service, DB `accounting`).
- `scripts/check-shared-copies.ts` (the `accountingWire` group, accounting-api in `systemAuth`).
- `tools/env-doctor` (manifest + `templates/production/accounting-api.env`; refund-api gains
  `ACCOUNTING_INTERNAL_URL` and retires `REFUND_FX_SOURCE`).
- `.railway/railway.ts`: an `accounting-api` block **without `source`** (D30).
- `infra/README.md`, `infra/check.sh`, AGENTS.md, README.md, changesets.

Railway and Vercel are documented, never deployed, by any agent.

### How Refund reads Accounting

| Aspect | Rule |
|---|---|
| **Who** | refund-api as itself: `system:refund-api`, a 5-minute service JWT from `auth POST /system/service-token` (the existing `serviceTokens` shared copy and `SERVICE_CLIENT_ID`/`SECRET`), scope `accounting.reference.read`. The user's JWT is never forwarded, because a Refund reviewer or admin holds no Accounting capability (AC-3.9). This is the narrow-channel rule of ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential. |
| **What** | Two read-only routes (§ API contracts): reference data of an entity (accounts and VAT codes, each with `active`), and the rates in effect for a list of (currency, month) pairs. No write route exists for a service principal (AC-3.8). |
| **Where** | `ACCOUNTING_INTERNAL_URL` (Railway private networking, `http://${{accounting-api.RAILWAY_PRIVATE_DOMAIN}}:${{accounting-api.PORT}}`). Required at startup: refund-api exits 1 without it. |
| **Freshness** | **No cache across requests (D2).** Every Refund operation that needs Accounting reads it live: one view, one options list, one approval, one classification, one settings write, one export, one release run. Within one operation the answer is memoised (one snapshot), so the operation is consistent with itself. A change saved in Accounting at T is therefore used by anything Refund starts after T, which is well inside AC-4.8's T + 60 s. A future cache must stamp entries at send time, stay at or under 60 s, and never serve an entry after a failed refresh (non-goal "approving from last-known data"). |
| **Deadline** | **10 s per operation** (`ACCOUNTING_DEADLINE_MS = 10_000`, AC-6.8). One `AbortSignal` covers the token mint and every call of the operation; the calls run in parallel. One 401 drops the token and retries once inside the same deadline. There is no other retry. |
| **Unreachable** | Any of these: deadline passed; network error; any non-2xx after the one 401 retry; a redirect (`redirect: "error"`); a non-JSON body or a body over 256 KiB; a body that fails the shared zod schema; an entity echo that differs; a rates answer that does not answer each asked pair exactly once; a token mint failure (auth down). All raise `AccountingUnavailableError(kind)`. The kind is logged at warn with the operation name, never a body, a URL with credentials, or a token. |
| **Behaviour when unreachable** | Never a stale value and never a guess. Approval → 503 `accounting_unavailable` (AC-6.1). Classification → 503 (AC-6.5). Settings write → 503, and the read shows the recorded values with `accounting: "unavailable"` (AC-6.9). Review view → 200 with what the lines hold and no options (AC-6.5). Export with pending rates → blocked with `accountingUnavailable` (AC-6.6). Release script → exits non-zero with nothing written (AC-7.4). Requests with no non-rejected WellD CH line never call Accounting (AC-6.4). Exports whose lines all hold their copies never call Accounting (AC-5.4). |
| **Order inside a route** | Cheap refusals first: capability, scope, self-approval, status pre-check, release gate. Then the Accounting read, **outside any DB transaction**, so no row lock is held across an HTTP call. Then the transaction, which re-checks the status under its lock and uses the snapshot (D11). |

### What a WellD CH line holds (the copy model)

| Phase | Account | VAT | Exchange rate (non-CHF only) |
|---|---|---|---|
| Submitted, on defaults | nothing stored: the live default (Refund default + Accounting active state) is shown, `isDefault: true` | same; the foreign-currency VAT code for a non-CHF line | none: the live rate in effect is shown for information |
| Submitted, classified by hand | copy `number` + `name`, `isDefault: false`, written at the PUT (AC-5.2) | copy `code` + `rateBasisPoints` | none |
| Approved | copy (hand copy kept; a default taken from Accounting during the approval, AC-5.1) | copy | copy `rateMicros` + `month` if a rate is in effect, else **rate pending** (no CHF and no VAT amount, AC-5.6) |
| Approved, unpaid, reclassified | the changed half's copy only (AC-5.7) | same | unchanged (write-once) |
| First successful export | — | — | a pending rate is copied in the export transaction (AC-5.6) |
| Paid | locked (app 409 + trigger, numbered lines) | locked | write-once: may go from null to set at the first export, never change |

The CHF amount and the VAT amount stay **derived on read**, now from the copies: `chfCents =
round(amountCents × fxRateMicros / 1e6)`, `vatCents = round(chfCents × bp / (10000 + bp))`, half up,
once each. This is the rule of ADR
20261118-chf-and-vat-amounts-are-derived-on-read-from-integer-micros-and-basis-points-rounded-once-half-up-and-never-stored,
with the input changed from "rate in effect" to "copied rate" (ADR amendment A2, § ADRs).

### Authorization model

- **Accounting capabilities** (AC-3.1 to AC-3.6). In accounting-api, every user route resolves the
  caller's permissions and computes `read(entity)` (read ∪ manage) and `manage(entity)` through
  `coverage.ts`:
  - **no** `read` for any entity → 403 `accounting_forbidden` on every route, with no data
    (AC-3.6);
  - an entity outside `read` coverage → **404** `not_found`, for the entity's lists and for any entry
    of it, so it is refused "as if the entry did not exist" (AC-3.5);
  - a write without `manage(entity)` while `read(entity)` holds → 403 `accounting_manage_required`.
    Nothing is written and nothing is audited (AC-3.4).
- **Reachability.** `/authz/me` derives `accounting` into `apps` when `read` or `manage` covers at
  least one entity (D6). The shell guard and Sidebar read `apps` as for every tool (AC-8.1). That is
  presentation only: accounting-api enforces every route.
- **Service read.** `/system/v1/*` accepts only a service JWT:
  - verified RS256 against auth's JWKS, `aud = SERVICE_AUDIENCE`, `sub` starting with `system:`;
  - the scope contains `accounting.reference.read`;
  - the `sub` is in `SYSTEM_READERS = ["system:refund-api"]` (D8).

  Every failure gets the same 401 body. A user JWT is never accepted. GET is the only method.
- **Refund.** Reading accounts, VAT codes or rates through Refund's settings capabilities is gone:
  the routes are removed (AC-3.7). Refund's own gates are unchanged: `settings:read` and
  `settings:manage` for defaults and the designation; `request:review`, `set-approved-total`,
  `reclassify` and the line-level scope and segregation-of-duties rules of SR-1, SR-2 and FR-1 for
  classification. `GET /accounting/options` accepts a `request:review` scope covering `welld_ch`
  **or** `settings:manage` (D16).

### Interaction flows

1. **Manager adds an account** (AC-1.1).
   - accounting-ui calls `POST /v1/entities/welld_ch/ledger-accounts` with `{number, name}`.
   - accounting-api checks `manage(welld_ch)`, trims and validates (AC-1.2), and inserts. Unique
     `(entity, number)` → P2002 → 409 (AC-1.3).
   - The entry's row is its own audit record of the addition (actor, time, entity).
2. **Consumer reads the reference data** (AC-3.8, AC-4.1).
   - refund-api mints or reuses its token and calls `GET /system/v1/entities/welld_ch/reference-data`.
   - accounting-api answers every entry with `active`, `Cache-Control: no-store`.
   - Refund filters to active entries for options.
3. **Consumer asks for rates** (AC-2.10).
   - refund-api calls `GET /system/v1/entities/welld_ch/rates?pairs=EUR:2026-03,USD:2026-11`.
   - For pairs with no recorded rate whose month is fetchable (completed + 5 grace days, D27),
     accounting-api fetches from BAZG under the consumer budget. That means at most 6 months,
     parallel, 5 s per call and **6 s in total** (D4), with the 15-minute throttle and single flight
     per (entity, month). The attempts are logged with trigger `consumer`.
   - It then answers each pair `in_effect` (`rateMicros`, `origin`) or `missing` (`reason`). Its
     answer comes within about 6.5 s, inside Refund's 10 s.
4. **Review.**
   - `GET /review/requests/{id}/accounting` loads the request and reads Accounting: the reference data,
     plus rates for the pre-approval CHF display of non-CHF CH lines.
   - It resolves each line: a copy, or the live default from Refund's defaults matched by natural key
     in the snapshot.
   - When Accounting is unreachable it still answers 200: lines show what they hold, defaults show
     Refund's recorded copy with state `unverified`, and `accounting: "unavailable"`.
   - `GET /accounting/options` gives the active entries (503 when unreachable).
5. **Classify** (AC-5.2, AC-4.3).
   - `PUT …/classification {accountNumber?, vatCode?}`: authorization first, then a live reference read
     (503 if unreachable).
   - Unknown, deactivated, or not in WellD CH's list → 422.
   - Then the transaction: lock the request `FOR UPDATE`, decide on the locked status, write the copy,
     audit `line_classified` v2 with from→to copies. Never the money fields or the rate copy.
6. **Approve** (AC-5.1, AC-5.6, AC-6.1 to AC-6.4).
   1. Authorization, self-approval, status pre-check, release gate.
   2. If the request has at least one non-rejected WellD CH line: read the reference data and the rates
      for **every** non-CHF WellD CH line of the request, rejected or not (a superset, because the line
      set is fixed while submitted, so the snapshot always covers the locked state, D11). Unreachable
      → 503, nothing written (AC-6.1, AC-6.2).
   3. Transaction (the existing CAS): resolve each non-rejected CH line against the snapshot. Any
      missing half → 409 `classification_missing` (AC-6.3), rolled back. Otherwise write the copies
      (a default's values taken from the snapshot), copy the rate if in effect or leave it pending,
      number, and audit (`line_classified` cause `approval` with the copies and
      `fxRate: {rateMicros, month}` or `"pending"`; `receipt_number_assigned`).
7. **Export** (AC-5.4, AC-5.6, AC-6.6, AC-6.7).
   - Summary: no pending lines → no Accounting call. Pending lines → rates read. Unreachable →
     `accountingUnavailable: true`. Still missing → `missingRates`.
   - CSV: the same evaluation. If anything blocks → 409 `accounting_export_blocked` (summary schema,
     G10). Otherwise one transaction:
     1. lock the pending lines `FOR UPDATE`;
     2. `UPDATE … SET fx* WHERE "fxRateMicros" IS NULL` (a concurrent export may have won; first writer
        wins);
     3. audit `line_rate_copied` per line with the exporter;
     4. re-read the lines;
     5. build the CSV from the copies;
     6. write the export-log row;
     7. commit, then send.

     A failed commit → 500, no file, no copy (AC-5.6 "a refused export copies nothing").
8. **Settings default change** (AC-4.4, AC-4.7).
   - `PUT /accounting/expense-type-defaults/{type} {accountNumber|null, vatCode|null}`: a live reference
     read (503 if unreachable).
   - Only active WellD CH entries are accepted (422 otherwise).
   - Append a row holding the **copies** (number, name, code, label, rate) and the actor. A no-op is
     suppressed. The history reads from these rows only.
9. **Release** (AC-7.4, AC-7.5): § Release.

### Existing ADRs this plan builds on

| ADR | What this plan takes from it |
|---|---|
| 20260703-jwt-resource-server-remote-jwks, 20260713-jwt-audience-claim-enforcement | accounting-api's user JWT verification |
| 20260709-suite-frontend-module-federation, 20261114-operai-ui-shared-singleton-provided-by-the-shell, 20260803-suite-version-generated-file-federated-export | accounting-ui as a remote, `./version`, the library as a shared singleton |
| 20260713-authz-hand-rolled-rbac-abac-epoch-claims, 20260716-refund-api-authorization-enforcing-resource-server | Live resolution, fail closed, 403 capability vs 404 record |
| 20260716-entity-scoped-abac-refund-api, 20261117-an-app-is-reachable-through-a-capability-it-administers | The one entity condition; derived app reachability |
| 20261006-scoped-service-jwt-fourth-notify-caller, 20261013-all-notify-callers-scoped-credentials-shared-token-retired, 20261103-projects-api-reads-crm-companies-with-scoped-service-credential, 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials | One scope per capability, sub allowlist, identical 401, live reads; "could not find out" is never "nothing there" |
| 20261117-the-letterhead-service-reads-the-issuers-details-itself-and-consumers-use-them-for-at-most-60-seconds | Staleness counted from send; here strengthened to "no cache, no stale on failure" |
| 20260716-immutable-financial-audit-trail-refund, 20260722-refund-settings-append-only-self-auditing-store | Self-auditing append-only tables with raising triggers, in both services |
| 20260720-mileage-rate-model-snapshot-admin-ui-composition | Snapshot at a lifecycle transition, here across a service boundary |
| 20260720-mileage-rate-money-precision-integer-micros | Micros and basis points, one rounding |
| The five 20261118 ADRs | Reused, and each amended on 2026-11-19 (§ ADRs, A1 to A5) |
| 20261113-railway-infrastructure-as-code | Service block in `.railway/railway.ts`, applied by a person |
| 20261119-accounting-reference-data-belongs-to-accounting-api-…, 20261119-data-that-moves-from-one-service-…, 20261119-on-demand-outbound-work-that-a-provider-does-…  | Written from this plan (§ ADRs) |

### Trade-offs: chosen vs rejected

- **Natural keys across the boundary** (chosen) vs Accounting's cuids. The spec makes number and code
  the identity within an entity, and immutable (AC-1.3, AC-1.6, AC-1.12). References survive
  re-entering an environment's data (non-goal "carrying test data"). Defaults and the release seed are
  written in the same words people use. Rejected: surrogate ids, which break on every re-entry and make
  Refund's stored defaults point at nothing.
- **Live reads with no cross-request cache** (chosen) vs a 30 s or 60 s TTL cache. Volume is tiny
  (hundreds of lines a year). AC-6.1, AC-6.5 and the "no last-known data" non-goal hold strictly. AC-4.8
  holds by construction, and there is nothing to invalidate. Cost: one internal hop per page view, and
  Accounting availability gates WellD CH approvals, which the spec asks for. Rejected: a TTL cache,
  which would let an approval succeed for up to the TTL after Accounting went down and needs clock
  tests for every AC of US-6.
- **Copies on the line** (chosen, the spec's rule) vs live references to Accounting. The CHF and VAT
  amounts are still derived, but from frozen inputs, so an export is reproducible (AC-5.4).
- **The rate copy at the first successful export, inside the export transaction** (chosen) vs a
  separate "re-rate" step or copying at the summary. Only a delivered file freezes a pending rate; a
  refused export or a summary freezes nothing (AC-5.6).
- **One additive refund-api migration that carries Refund's own data and drops what moved** (chosen,
  D5) vs editing `20261119090000_accounting_export` (rejected: developers' and the e2e databases have
  applied it, Prisma would report a checksum drift, and AGENTS.md forbids it) vs leaving the moved
  tables dead (rejected: two sources that look current, and FKs that still constrain).
- **A derived `apps` entry** (chosen) vs an `accounting:access` grant (rejected: a third capability
  that can drift from the two the spec names, breaking AC-8.1 for a holder of read without access).
- **Moving code with `git mv`** (chosen) vs a rewrite. The BAZG client, parser, month rules, catalog
  repos and cards are verified (QE PASS, security review); history and blame follow the files.
- **accounting-api as a separate service** (the spec's constraint 1) vs a module inside refund-api;
  not reopened.

## Data model

### accounting-api — `prisma/schema.prisma` (one initial migration)

```prisma
enum Entity     { welld_it welld_ch }
enum Currency   { CHF EUR USD GBP }
enum RateOrigin { fetched corrected }

// Immutable once inserted. Identity = (entity, number) (spec domain language).
model LedgerAccount {
  id              String   @id @default(cuid())   // internal only, never on the wire
  entity          Entity
  number          String                          // ^[0-9]+(\.[0-9]+)*$, 1..20, trimmed (AC-1.2)
  name            String                          // 1..120, trimmed, not blank
  createdByUserId String                          // AC-1.13: who added (system:accounting-seed for the seed)
  createdByEmail  String
  createdAt       DateTime @default(now())
  statusChanges   CatalogStatusChange[]
  @@unique([entity, number])                      // AC-1.3 backstop
  @@map("ledger_account")
}

// Immutable once inserted: the rate never changes (AC-1.7).
model VatCode {
  id              String   @id @default(cuid())
  entity          Entity
  code            String                          // ^[A-Z0-9_-]{1,16}$, upper-cased before the check (AC-1.5)
  label           String                          // 1..80
  rateBasisPoints Int                             // 8.1 % = 810; CHECK 0..10000
  createdByUserId String
  createdByEmail  String
  createdAt       DateTime @default(now())
  statusChanges   CatalogStatusChange[]
  @@unique([entity, code])                        // AC-1.6 backstop (case-insensitive by upper-casing)
  @@map("vat_code")
}

// Append-only. No row = active since creation. Current = latest row.
// CHECK num_nonnulls("ledgerAccountId","vatCodeId") = 1. `entity` is a copy of the entry's
// entity, so each audit row names the entity on its own (AC-1.13); a trigger checks it matches.
model CatalogStatusChange {
  id              String         @id @default(cuid())
  entity          Entity
  ledgerAccountId String?
  ledgerAccount   LedgerAccount? @relation(fields: [ledgerAccountId], references: [id], onDelete: Restrict)
  vatCodeId       String?
  vatCode         VatCode?       @relation(fields: [vatCodeId], references: [id], onDelete: Restrict)
  active          Boolean                         // after-state; before-state = the opposite (a no-op is refused, AC-1.11)
  createdByUserId String
  createdByEmail  String
  createdAt       DateTime       @default(now())
  @@index([ledgerAccountId, createdAt])
  @@index([vatCodeId, createdAt])
  @@map("catalog_status_change")
}

// Append-only. In effect = latest `corrected`, else the `fetched` row.
model ExchangeRateEntry {
  id                 String     @id @default(cuid())
  entity             Entity
  currency           Currency
  month              DateTime   @db.Date        // first day of month
  rateMicros         Int                         // own currency per 1 unit × 1e6; CHECK 0 < x < 1e9 (AC-2.5)
  origin             RateOrigin
  replacesRateMicros Int?                        // corrected: the value in effect before (AC-2.4 "from which value")
  sourceUrl          String?                     // fetched (AC-2.1 source)
  sourceMonth        String?                     // fetched: the <monat> echo
  fetchedAt          DateTime?                   // fetched (AC-2.1 moment)
  createdByUserId    String                      // "system:rates-fetch" or the manager's sub
  createdByEmail     String
  createdAt          DateTime   @default(now())
  @@index([entity, currency, month, createdAt])
  @@map("exchange_rate_entry")
}

// Append-only log of every fetch attempt (AC-2.8 "last fetch failed, and when"; AC-2.3 "asked for").
model ExchangeRateFetchAttempt {
  id            String   @id @default(cuid())
  entity        Entity
  month         DateTime @db.Date
  trigger       String                          // manager | consumer — derived server-side (closes FU-S5)
  outcome       String                          // ok | failed | disabled
  errorCode     String?                         // timeout | http_<status> | parse | month_mismatch | currency_missing
  recorded      Json?
  discrepancies Json?
  actorUserId   String                          // manager sub, or the consumer's service sub
  createdAt     DateTime @default(now())
  @@index([entity, month, createdAt])
  @@index([entity, createdAt])
  @@map("exchange_rate_fetch_attempt")
}
```

**Raw SQL in the init migration**, under a "Hand-written SQL" block, guarded by
`src/lib/db.*.test.ts` (R11 of 20261118):

- `accounting_history_immutable()`, the function shape copied from refund-api, raising
  `BEFORE UPDATE` and `BEFORE DELETE` on all five tables. Neither an entry nor an audit row can be
  edited or deleted (AC-1.12, AC-1.13).
- CHECKs:
  - `vat_code."rateBasisPoints" BETWEEN 0 AND 10000`;
  - `vat_code.code ~ '^[A-Z0-9_-]{1,16}$'`;
  - `ledger_account.number ~ '^[0-9]+(\.[0-9]+)*$' AND length(number) <= 20`;
  - `length(btrim(name)) BETWEEN 1 AND 120`, `length(btrim(label)) BETWEEN 1 AND 80`;
  - the status one-of;
  - `exchange_rate_entry`: `"rateMicros" > 0 AND "rateMicros" < 1000000000`;
    `EXTRACT(DAY FROM month) = 1`; and
    `(entity = 'welld_ch' AND currency <> 'CHF') OR (entity = 'welld_it' AND currency <> 'EUR')`, so
    the own currency has no rate (AC-2.5);
  - `origin = 'corrected'` ⇔ `"replacesRateMicros"` may be set, and `origin = 'fetched'` ⇔
    `"sourceUrl"` and `"fetchedAt"` set.
- Trigger `catalog_status_entity_matches` (BEFORE INSERT): the row's `entity` equals its entry's.
- `CREATE UNIQUE INDEX exchange_rate_fetched_once ON exchange_rate_entry (entity, currency, month)
  WHERE origin = 'fetched'`: fetched once, never replaced (AC-2.2).

### refund-api — one additive migration `<ts>_accounting_reference_moves_to_accounting`

`20261119090000_accounting_export` is **not edited** (D5). The new migration, in this order:

1. **Add the copy columns** to `refund_line`:
   - `"accountNumber" TEXT`, `"accountName" TEXT`;
   - `"vatCode" TEXT`, `"vatRateBasisPoints" INTEGER`;
   - `"fxRateMicros" INTEGER`, `"fxRateMonth" DATE`, `"fxRateCopiedAt" TIMESTAMP(3)`.

   `"ledgerAccountIsDefault"` and `"vatCodeIsDefault"` stay, with the same meaning.
2. **Create** two append-only tables, each holding copies:

   ```prisma
   model ExpenseTypeAccountingDefault {          // @@map("expense_type_accounting_default")
     id String @id @default(cuid())
     entity Entity                                // welld_ch only (CHECK)
     type ExpenseType
     accountNumber String?  accountName String?   // both or neither (CHECK); null = no default
     vatCode String?  vatLabel String?  vatRateBasisPoints Int?   // all or none (CHECK)
     createdByUserId String  createdByEmail String  createdAt DateTime @default(now())
     @@index([entity, type, createdAt])
   }
   model ForeignCurrencyVatDesignation {         // @@map("foreign_currency_vat_designation")
     id String @id @default(cuid())
     entity Entity                                // welld_ch only
     vatCode String?  vatLabel String?  vatRateBasisPoints Int?   // all or none; null = cleared
     createdByUserId String  createdByEmail String  createdAt DateTime @default(now())
     @@index([entity, createdAt])
   }
   ```

   Both get `accounting_history_immutable()` triggers (the function already exists).
3. **Carry Refund's own data** (a no-op in production, where 20261118 never ran; it matters for
   developer and e2e databases):
   - the line copies, from `ledger_account` and `vat_code` joined on the old FK columns;
   - the history of `expense_type_default` into `expense_type_accounting_default`, joined to the old
     catalog, with the same ids, actors and `createdAt`;
   - the designation rows of the `refund_setting` key `accounting.welld_ch.foreign-currency-vat-code`
     into `foreign_currency_vat_designation`, the same way;
   - for every numbered, non-rejected, non-CHF WellD CH line of an `approved` or `paid` request: the
     rate in effect from the old `exchange_rate_entry` (`DISTINCT ON (currency, month) ORDER BY
     (origin = 'corrected') DESC, "createdAt" DESC, id DESC`) as its fx copy. Without one, the line
     stays rate pending.

   These writes touch only the new columns. The current guard watches the old ones, so no trigger has
   to be disabled.
4. **Replace `refund_line_accounting_guard()`** (CREATE OR REPLACE, before any column is dropped,
   because the old body names `"ledgerAccountId"`):
   - (a) the receipt immutability, unchanged;
   - (b) once `OLD."receiptNumber" IS NOT NULL` and the parent request is `paid`, any change to
     `accountNumber`, `accountName`, `ledgerAccountIsDefault`, `vatCode`, `vatRateBasisPoints` or
     `vatCodeIsDefault` raises (IS-1 condition kept; AC-5.7, AC-3.7 of 20261118);
   - (c) **fx write-once**: once `OLD."fxRateMicros" IS NOT NULL`, any change to the three fx columns
     raises, whatever the status. Null → set is allowed, which is the pending copy at export, also for
     a paid batch (AC-5.3, AC-5.6, AC-5.7).
5. **CHECKs on `refund_line`:**
   - `(accountNumber IS NULL) = (accountName IS NULL)`;
   - `(vatCode IS NULL) = (vatRateBasisPoints IS NULL)`;
   - `vatRateBasisPoints BETWEEN 0 AND 10000`;
   - `num_nonnulls(fxRateMicros, fxRateMonth, fxRateCopiedAt) IN (0,3)`;
   - `fxRateMicros > 0 AND < 1e9`;
   - `fxRateMonth = date_trunc('month', "date")::date`: the rate is the expense month's;
   - fx only when `currency <> 'CHF' AND entity = 'welld_ch'`;
   - `refund_line_classification_ch_only`: every copy column is null unless `entity = 'welld_ch'`.
     This closes follow-up FU-S4 of 20261118.

   Each CHECK is added `NOT VALID` and then `VALIDATE`d, so a developer database with odd hand-made
   rows fails loudly with the constraint's name.
6. **Drop what moved:**
   - the FKs and indexes on `"ledgerAccountId"`/`"vatCodeId"`, then those two columns;
   - the tables `expense_type_default`, `accounting_catalog_status`, `ledger_account`, `vat_code`,
     `exchange_rate_entry` and `exchange_rate_fetch_attempt`;
   - the type `"ExchangeRateOrigin"`.

   `refund_batch_export`, `receipt_counter` and the release marker stay. The old `refund_setting` rows
   of the designation key cannot be deleted (immutable) and are left unread (D33).
7. `ALTER TYPE "AuditAction" ADD VALUE 'line_rate_copied'`. It is not used inside the migration.

**Audit detail v2** (`RefundAuditEntry.detail`, `v: 2`; readers accept v1 rows):

- `line_classified`: `{ v: 2, cause: "review" | "post_approval" | "approval" | "release" | "withdrawn",
  account: { from: {number,name} | null, to: …, fromDefault, toDefault },
  vatCode: { from: {code,rateBasisPoints} | null, to: …, fromDefault, toDefault },
  fxRate?: {rateMicros, month} | "pending" }`. `fxRate` is present for `approval` and `release` only.
- `line_rate_copied` (new): `{ v: 2, cause: "export", batchId, rateMicros, month, currency }`. The
  actor is the exporter, from the JWT (AC-5.6).

### Data migration strategy (decision D5)

20261118 is unreleased, so production holds none of its data: on the deploy, the 20261119090000
migration and this one run back to back on empty tables. Developer databases and the e2e database
have applied 20261119090000, and may hold classified lines, defaults and rates.

- **Additive, never a rewrite.** Editing an applied migration makes `prisma migrate` report a checksum
  drift and ask to reset those databases. AGENTS.md forbids it for every service.
- **Carry what stays in Refund** (line copies, defaults history, designation history, legacy rate
  copies), because it is Refund's data and the spec keeps it in Refund. With natural keys it stays
  valid once the same numbers exist in Accounting.
- **Drop what moved** (catalog, rates, attempts). The spec's non-goal: environments re-enter their
  reference data in Accounting. In development the e2e global setup and `seed:welld-ch` do it in one
  command.
- **Proved** by a migration test (§ Test strategy, "mig") on a scratch database brought to
  20261119090000 with fixture rows, then migrated.

### Seed data split

`refund-api/scripts/data/accounting-seed.welld-ch.json` is split, so each service owns its half:

- `accounting-api/scripts/data/seed.welld-ch.json`: the 15 ledger accounts and 3 VAT codes, unchanged
  (`git mv` + trim).
- `refund-api/scripts/data/accounting-defaults.welld-ch.json`: the 12 `typeDefaults` (by number and
  code) and `foreignCurrencyVatCode: "NOVAT"`, unchanged.
- A refund-api unit test reads both files from the repo and checks that every number and code the
  defaults name exists in the Accounting seed (R2).

## API contracts

All errors are RFC 7807 with a stable `code`. Bodies are capped at 4 KiB. Months are `YYYY-MM`.
Actors come from the verified JWT only. No `detail` names a host, URL, id or internal error (AC-6.10).

### accounting-api — user routes (user JWT; § Authorization model)

```
GET  /v1/me
  200 { entities: [ { entity: "welld_ch", ownCurrency: "CHF", canManage: boolean,
                      rateSource: "bazg" | null } ] }                       // covered entities, welld_ch first
  403 { code: "accounting_forbidden" }                                      // no read for any entity (AC-3.6)

GET  /v1/entities/{entity}/ledger-accounts
  200 { entity, items: [ { number, name, active } ] }                      // ordered by number segments
                                                                           // empty list = nothing entered yet (AC-8.3)
POST /v1/entities/{entity}/ledger-accounts            { number, name }     // manage
  201 { number, name, active: true }
  409 { code: "ledger_account_duplicate", number }                         // active OR deactivated, also from P2002 (AC-1.3)
  422 { code: "invalid_ledger_account", fields: [ { field: "number"|"name", reason: "empty"|"format"|"too_long" } ] }  // AC-1.2
POST /v1/entities/{entity}/ledger-accounts/{number}/deactivate              // manage; 200 item | 409 already_inactive
POST /v1/entities/{entity}/ledger-accounts/{number}/reactivate              // manage; 200 item | 409 already_active
                                                                           // a 409 writes nothing (AC-1.11)

GET  /v1/entities/{entity}/vat-codes
  200 { entity, items: [ { code, label, ratePercent: "8.1", rateBasisPoints: 810, active } ] }
POST /v1/entities/{entity}/vat-codes                  { code, label, ratePercent }   // ^\d{1,3}(\.\d{1,2})?$, 0..100
  201 item
  409 { code: "vat_code_duplicate", vatCode, reactivate: true }            // case-insensitive (AC-1.6)
  422 { code: "invalid_vat_code", fields: [ { field: "code"|"label"|"ratePercent", reason } ] }
POST /v1/entities/{entity}/vat-codes/{code}/deactivate | /reactivate       // {code} upper-cased before lookup

// No PUT, PATCH or DELETE on any entry: 404 (AC-1.7, AC-1.12).
// Every route: entity outside read coverage → 404 not_found; write without manage → 403
// accounting_manage_required; unknown number or code → 404.

GET  /v1/entities/{entity}/exchange-rates?from=YYYY-MM&to=YYYY-MM
  200 { entity, ownCurrency, currencies: ["EUR","USD","GBP"],              // [] for welld_it (D19)
        source: { name: "bazg" } | null,                                   // null → "no official source" (AC-2.11)
        months: [ { month, rates: { EUR: Rate, USD: Rate, GBP: Rate } } ], // newest first; window 2026-01 … last
                                                                           // completed month, plus earlier months with
                                                                           // an entry or an attempt (AC-2.3)
        lastFetch: { at, outcome, errorCode | null, month } | null,        // AC-2.8, readers included
        fetchDue: boolean }                                                // managers' view auto-fetch (D26)
  Rate = { status: "missing" } | { status: "fetched" | "corrected", rateMicros, rate: "0.9246" }
POST /v1/entities/{entity}/exchange-rates/fetch       { months?: ["2026-10"] }   // manage (AC-2.9)
  200 { attempts: [ { month, outcome, errorCode | null } ], lastFetch }    // a source failure is 200 with outcome failed
  422 { code: "no_rate_source" }                                           // welld_it: nothing attempted (AC-2.11)
PUT  /v1/entities/{entity}/exchange-rates/{month}/{currency}   { rate: "0.9300" }   // manage
  200 the month row
  422 { code: "invalid_rate" | "month_not_completed" | "currency_not_convertible" }  // AC-2.5; nothing recorded
  // no-op (same as in effect) → 200, no row
```

### accounting-api — system routes (service JWT; scope `accounting.reference.read`; sub allowlist)

```
GET /system/v1/entities/{entity}/reference-data
  200 { entity, ownCurrency,
        ledgerAccounts: [ { number, name, active } ],
        vatCodes: [ { code, label, rateBasisPoints, active } ] }           // the reader's projection (AC-3.8)
  Cache-Control: no-store

GET /system/v1/entities/{entity}/rates?pairs=EUR:2026-03,USD:2026-11       // 1..36 distinct pairs, months ≥ 2000-01
  200 { entity, rates: [ { currency, month, status: "in_effect", rateMicros, origin }
                       | { currency, month, status: "missing",
                           reason: "not_published" | "fetch_failed" | "no_source" } ] }   // each pair once, in asked order
  // Missing + fetchable → consumer fetch first (≤ 6 months, 6 s budget, throttle), then answer (AC-2.10)
  400 malformed pairs   422 { code: "currency_not_convertible" }
401 (identical body) for: no token, user JWT, wrong aud, expired, bad signature, scope missing,
    sub not in SYSTEM_READERS. Any other method → 404.
```

`src/system/accountingWire.ts` holds the zod schemas of both 200 bodies. It is a shared copy
(`// shared-copy:begin accountingWire`) in `accounting-api/src/system/` and
`refund-api/src/accounting/`, checked by `mise run shared:check` (D23).

### refund-api — changed routes

```
GET  /accounting/options                    // request:review covering welld_ch OR settings:manage (D16); else 403 accounting_out_of_scope
  200 { ledgerAccounts: [ { number, name } ], vatCodes: [ { code, label, ratePercent, rateBasisPoints } ] }   // active WellD CH only (AC-4.1, AC-4.4)
  503 { code: "accounting_unavailable" }  Retry-After: 30

GET  /review/requests/{id}/accounting       // gate unchanged (request:review + request and line scope)
  200 { …as 20261118…, accounting: "available" | "unavailable",
        lines: [ { …,
          classification: null | {
            account: { number, name, state } | null, accountIsDefault,
            vatCode: { code, label | null, ratePercent, state } | null, vatCodeIsDefault },
              // state: active | deactivated | not_found | unverified (Accounting unavailable)
          chf: null | { amountCents | null, rate | null, rateMicros | null, rateMonth | null,
                        rateStatus: "copied" | "in_effect" | "missing" | "pending" | "unavailable" | "not_applicable" },
          vatAmountCents | null } ] }
          // approved + pending → rateStatus "pending", amountCents and vatAmountCents null (AC-5.6)

PUT  /review/requests/{id}/lines/{lineId}/classification
  body { accountNumber?: string, vatCode?: string }                        // at least one; natural keys (D1)
  200 the line object above
  422 { code: "ledger_account_inactive" | "ledger_account_not_found" | "vat_code_inactive" | "vat_code_not_found" }   // AC-4.3
  503 { code: "accounting_unavailable" }                                   // AC-6.5; line unchanged
  // 403 / 404 / 409 / self_approval_forbidden exactly as 20261118 (SR-1, SR-2, FR-1, FR-2)

POST /review/requests/{id}/approve
  + 503 { code: "accounting_unavailable" }  Retry-After: 30                // AC-6.1; nothing changed (AC-6.2)
  409 classification_missing, accounting_release_pending: unchanged

GET  /accounting/expense-type-defaults      // settings:read
  200 { entity: "welld_ch", accounting: "available" | "unavailable",
        foreignCurrencyVatCode: { code, label, ratePercent, state } | null, foreignCurrencyVatCodeUsable,
        foreignCurrencyVatCodeHistory: [ { vatCode: { code, label, ratePercent } | null, at, byEmail } ],
        types: [ { type, account: { number, name, state } | null, vatCode: { code, label, ratePercent, state } | null,
                   updatedAt | null, updatedByEmail | null,
                   history: [ { account: {number,name}|null, vatCode: {code,label,ratePercent}|null, at, byEmail } ] } ] }
        // state as above; deactivated, not_found and unverified are each "no usable default" (AC-4.5, AC-6.9)
PUT  /accounting/expense-type-defaults/{type}   { accountNumber: string | null, vatCode: string | null }   // settings:manage
PUT  /accounting/foreign-currency-vat-code      { vatCode: string | null }                                  // settings:manage
  200 as before; 422 inactive / not_found; 503 accounting_unavailable; no-op → 200, no row

GET  /batches/{id}/accounting-export        // gate unchanged (request:review covering welld_ch)
  200 { …as 20261118…,
        ratePendingLineCount,
        blockers: { missingRates, unclassifiedLines, unnumberedLines,
                    accountingUnavailable: boolean },                      // AC-6.6: true, missingRates []
        viewer: { canOpenAccountingRates: boolean } }                      // accounting:read|manage covering welld_ch (AC-7.3, D17)
GET  /batches/{id}/accounting-export/csv
  409 { code: "accounting_export_blocked", ...summary }                    // also for accountingUnavailable (D14)
  200 text/csv                                                             // copies pending rates in the export transaction

Removed (404): /accounting/ledger-accounts*, /accounting/vat-codes*, /exchange-rates*        // AC-3.7, AC-4.6
Unchanged: GET /requests/{id} (receiptNumber only; AC-3.10, AC-7.2), GET /batches/{id}
```

### Refusal messages (AC-6.10)

refund-ui maps each `code` to `en` and `it` copy in `strings.ts`. The message names the cause and the
remedy, and contains no address, identifier or internal text:

- `accounting_unavailable`: "Accounting's reference data cannot be read right now. Nothing was saved.
  Try again in a few minutes." / "I dati di riferimento della contabilità non sono leggibili in
  questo momento. Non è stato salvato nulla. Riprova tra qualche minuto."
- `classification_missing`: unchanged, it lists the lines.
- `accountingUnavailable` export blocker: "Accounting cannot be read, so the exchange rates of lines
  with a pending rate cannot be fetched. You can still pay or discard this batch."
- `missingRates` with `viewer.canOpenAccountingRates`: a link per (currency, month) to
  `/accounting/exchange-rates?entity=welld_ch&month=YYYY-MM`. Without it: "Ask an accounting manager
  to enter or fetch it" (AC-7.3).

The designer finalises the wording.

## UI

### accounting-ui (`/accounting`)

- **Routes.**
  - `/accounting` redirects to `/accounting/ledger-accounts`.
  - `/accounting/ledger-accounts`, `/accounting/vat-codes` and `/accounting/exchange-rates`, each with
    `validateSearch` `{ entity?: "welld_ch" | "welld_it", month?: "YYYY-MM" }`.
  - The three views are `Tabs` (UX-1 lineage), and only the active one is mounted.
  - An entity outside `/v1/me` falls back to the first covered entity.
- **Entity** (AC-8.2).
  - With two or more covered entities, a labelled `Select` "Entity" sits above the tabs; the choice
    is kept in `?entity=`.
  - Every card title names the entity ("Ledger accounts — WellD CH").
  - With one entity there is no switcher, but the titles still name it.
- **Ledger accounts and VAT codes.** The moved cards: list with an active or deactivated badge, an
  add dialog (`FormDialog`), **Deactivate** as a `ConfirmDialog` and **Reactivate** acting at once
  (UX-3). There is no edit control (AC-1.7, AC-1.12). Who-added and history are not shown (D18). Write
  controls only when `canManage`. Empty: `StatePanel` "Nothing entered yet for WellD Italia" (AC-8.3).
  The duplicate message names the number or code. For a VAT code it offers "Reactivate" when the
  duplicate is deactivated (AC-1.6).
- **Exchange rates.** The moved card: months by EUR, USD and GBP, an origin badge (fetched, corrected
  or missing), the persistent last-fetch-failed banner (AC-2.8), **Fetch now** and the correction
  dialog for managers. The auto-fetch runs once per visit for managers (UX-11). `&month=` scrolls to
  and focuses the month (the AC-7.3 deep link). For WellD Italia a `StatePanel` says there is no
  official source yet (AC-2.11).
- **Forms and a11y** (AC-8.4).
  - Each control has a visible `Field` label.
  - On a 422 the dialog shows an `ErrorSummary`, moves focus to the first refused field and marks each
    with `aria-invalid` and its message. The server's `fields[]` drives this, as does the client
    check.
  - Keyboard: everything is reachable, dialogs trap focus and return it.
  - Axe: a test helper (`src/test-support/axe.ts`, test-only, same API as refund-ui's T44 helper)
    runs on every state of every card and dialog.
- **Copy.** All strings in `strings.ts` `en` and `it` (parity test, no-hard-coded-copy scan).
  Months through `@operai/ui` `formatMonth`, amounts and rates through `formatNumber`. The implementer
  loads `operai-ui/docs/building-pages.md` and `design-system.md` first (AGENTS.md rule).

### refund-ui

- **`SettingsPage`.**
  - Views **General** and **Default classification** (`?section=general|defaults`). Any other value,
    including the 20261118 `accounting` and `exchange-rates`, falls back to `general` (AC-4.6).
  - `ExchangeRatesView.tsx` and the catalog half of `AccountingSettingsView.tsx` are removed. The rest
    becomes `DefaultsSettingsView.tsx`.
  - An `AccountingLinkNote` heads the defaults view. With `apps ∋ "accounting"` (from
    `usePermissions()`): "Accounts, VAT codes and exchange rates are kept in the Accounting app" plus
    a link to `/accounting`. Otherwise: "…are kept by accounting managers in the Accounting app",
    with no link (AC-4.6).
- **`ExpenseTypeDefaultsCard`.**
  - Each type shows its account as number and name, and its VAT code, or "None" (AC-4.5).
  - State `deactivated` or `not_found` → a warning badge "Deactivated in Accounting — choose a new
    default" (or "No longer in Accounting"), which counts as no default (AC-4.5).
  - `accounting: "unavailable"` → a `Banner` "Accounting cannot be read now; defaults are shown as
    recorded", and **Change** is disabled with its reason (AC-6.9).
  - The history drawer shows the recorded copies (AC-4.7).
- **`DefaultClassificationDialog`, `ForeignCurrencyVatDialog`, `useActiveCatalogOptions`.**
  - Options come from `GET /accounting/options`, keyed by number or code.
  - A 503 → the dialog shows the AC-6.10 message and no options.
  - A 422 → a field error.
- **`LineClassificationPanel`.**
  - `CatalogSelect` values are numbers and codes.
  - A stored value not among the options (deactivated, not found) stays shown as the selected option,
    marked "deactivated".
  - `accounting: "unavailable"` → no selects, the line's values as text, and the note (AC-6.5).
  - `rateStatus: "pending"` → "Rate pending: copied at the first export" and no CHF or VAT amount
    (AC-5.6).
  - A 503 on a change → the note, and the value reverts.
- **`ReviewDetailPage`.** The approve 409/503 switch on `error.code` (G2) gains
  `accounting_unavailable`: a message inside the dialog, with Approve still available (like
  `accounting_release_pending`).
- **`AccountingExportCard`.**
  - The blocker `accountingUnavailable` gets its own warning text.
  - A missing rate links per AC-7.3 using `viewer.canOpenAccountingRates`.
  - A pending count shows "N lines get their exchange rate at this export".
- **Removed with `git mv` to accounting-ui:** the components listed in § Components, their tests and
  strings, `lib/exchangeRatesApi.ts`, and the catalog half of `lib/accountingApi.ts`.
  `RateInEffectBadge` stays: the mileage rates use it. `ChangeHistoryDrawer` stays: the defaults use
  it. A grep before deleting confirms each file has no other consumer.
- **Kept:** the axe checks (T44) on every changed state, with the new states added.

### shell

The `TOOLS` entry, the gated route, the remote, the getter, the CSP and the copy are listed in
§ Components. `router.accounting.test.tsx` covers access by `apps` (AC-8.1).

## Release, deploy order and environments

### Release scripts

1. **Accounting seed** (accounting-api, `bun run seed:welld-ch [--dry-run]`, operator-run, D20).
   - It adds each account and VAT code of `seed.welld-ch.json` that does not exist yet (by number or
     code), as `system:accounting-seed` / `system-accounting-seed@welld.ch`.
   - One transaction; idempotent. It never deactivates, never reactivates, never touches an existing
     entry.
   - The report gives counts and the numbers and codes added; there is no personal data in it.
   - It is optional: when accounting prefers to type the list in the app, skip it (open question 3).
2. **Refund release** (refund-api, `bun run accounting:release [--dry-run] [--offsets <csv>]
   [--show-emails]`, operator-run, rewritten from 20261118 T11).
   1. **Read Accounting first.** The WellD CH reference data, plus the rates for the distinct
      (currency, month) pairs of the legacy non-CHF CH lines, asked in chunks of 6 months. If the read
      fails, it **exits 2 with "Accounting cannot be read: nothing was numbered or classified;
      run again later"** and writes nothing (AC-7.4).
   2. One transaction:
      - seed Refund's defaults and designation from `accounting-defaults.welld-ch.json`, only where no
        row exists, and only for entries active in the snapshot (else skipped and reported), as
        `system:accounting-seed`;
      - apply `--offsets` (D2 of 20261118, unchanged);
      - backfill with `classifyAndNumber(cause: "release")`: copies from the snapshot, a rate copy
        when in effect, else pending; numbering unchanged (AC-7.4, AC-7.1/7.2/7.3 of 20261118);
      - write the release marker.
   3. The report adds "rate pending: N lines" and "left unclassified" (AC-7.5). It is masked as in
      SR-4.

   `--dry-run` rolls back, as today. A rerun finds nothing to do.
3. **e2e and local:** `shell/e2e/global-setup.ts` runs 1, then 2 (§ e2e).

### Deploy order (runbook in `infra/README.md`, run by a person, never by an agent)

One push to `main` redeploys every changed service in no fixed order (ADR
20261013-all-notify-callers-scoped-credentials-shared-token-retired). Every pairing therefore fails
closed during the window:

- the new refund-api before the release script → 409 `accounting_release_pending` (the D6 gate of
  20261118);
- the new refund-api before Accounting answers → 503;
- accounting-api before auth's catalog → 403 for everyone;
- the shell before accounting-ui → the remote's error panel, and only for holders of the derived app.

Steps:

0. **Before:** accounting signs off the seed lists and the defaults (T39 of 20261118 plus open
   question 3 here); `mise run env:doctor -- --env production`.
1. **Provision, without a source** (`./infra/provision-tool.sh accounting --port 8089` → plan →
   `--apply`). This creates the database `accounting`, the service declared in `.railway/railway.ts`,
   the domain `accounting-api.operai.welld.io`, DNS, and the Vercel project `accounting-ui` with the
   host `accounting.operai.welld.io`.
2. **Set the variables:**
   - accounting-api: `DATABASE_URL` by reference, `ALLOWED_ORIGINS`, `AUTH_*`, `SERVICE_AUDIENCE`,
     `ACCOUNTING_FX_SOURCE=bazg`, `PORT=8089`;
   - refund-api: `ACCOUNTING_INTERNAL_URL` (private domain). Required: a refund-api without it keeps
     its previous deployment (healthcheck);
   - shell: `ACCOUNTING_REMOTE_URL` and `VITE_ACCOUNTING_API_URL`;
   - remove `REFUND_FX_SOURCE` from refund-api.
3. **Release per RELEASING.md** (version, tag, push). Connect accounting-api's source
   (`--connect --redeploy-shell --apply`). Its `preDeploy` runs `bun run db:deploy`.
4. **After the new auth is live:** edit auth's `SERVICE_CLIENTS` so refund-api's entry gains
   `accounting.reference.read`. auth restarts, and a scope it does not know would stop it (R13).
5. **Verify:**
   - `./infra/check.sh` (accounting-api `/health`; 401 on `/v1/me` without a token; 401 on
     `/system/v1/…` without a credential);
   - the auth seed log shows the accounting grants;
   - an accounting user sees **Accounting** in the menu.
6. **Seed Accounting:** `seed:welld-ch --dry-run`, then the real run, from a checkout through `railway
   run` with the **public** database URL override (the letterhead runbook precedent). Or accounting
   enters the list by hand.
7. **Release Refund:** `accounting:release --dry-run`, read by accounting, then the real run, with
   `ACCOUNTING_INTERNAL_URL` overridden to `https://accounting-api.operai.welld.io` and the public
   database. The refund-api credentials are injected by `railway run`, never typed on a command line.
   It runs from an operator shell only (SR-4).
8. **Check:** the first production approval of a WellD CH request succeeds.

Approvals are refused between step 3 and step 7. Run the release outside the monthly batch day; the
window is minutes when steps 0–2 are done beforehand (R1).

### Test environment (agents)

- Every service's tests run on the **isolated Postgres container `operai-expense-analysis-pg` on
  :5445**, never on the shared dev Postgres (:5435) and never on Railway:
  - accounting-api: database **`accounting`** (`docker exec operai-expense-analysis-pg createdb -U
    postgres accounting`, then `DATABASE_URL=postgresql://postgres:postgres@localhost:5445/accounting
    bun run db:deploy`; use the container's actual credentials);
  - refund-api: `refund`; auth: `auth`;
  - migration checks on scratch databases: `accounting_qe`, `refund_mig`, dropped after.
- Agents never start, stop or reconfigure the container. They only create and drop their own
  databases.
- refund-api tests never need a running accounting-api. Every int test injects a fake
  `AccountingPort` (`src/test-support/fakeAccounting.ts`) that can answer data, delay, fail with each
  kind, or count calls. The shared wire schema keeps it honest (contract tests, R5).
- accounting-api tests inject a fake BAZG source (`fakeSource.ts`) and a fake resolver. The recorded
  2026-03 BAZG fixture moves with the parser test.
- The e2e stack (shared dev Postgres, 1Password secrets) stays an **owner step**, as T31/T32 of
  20261118 were.

### Local development and e2e

- `mise run dev` starts accounting-api on :8089 (`direnv exec`) and accounting-ui on :5183;
  `db:migrate` includes accounting-api. The stack runs with `ACCOUNTING_FX_SOURCE=off` for e2e. Local
  auth's `SERVICE_CLIENTS` gives refund-api's entry `accounting.reference.read` (`.env.example` and
  AGENTS.md "Running locally").
- **`shell/e2e/global-setup.ts`:**
  1. check that `ACCOUNTING_API_URL` (default `http://localhost:8089`) answers `/health`, and otherwise
     fail naming the command;
  2. run `direnv exec . bun run seed:welld-ch` in `accounting-api/`, unless
     `E2E_SKIP_ACCOUNTING_SEED=1`;
  3. run Refund's `accounting:release`, as today, unless `E2E_SKIP_REFUND_ACCOUNTING_RELEASE=1`.
- **Journeys:**
  - `accounting.spec.ts` (new, from T31's catalog half): an admin opens `/accounting` from the menu,
    adds an account and a VAT code (keyboard only for one dialog), deactivates and reactivates, sees
    the duplicate message, corrects a rate, and sees the origin badge.
  - `accounting-access.spec.ts` (new):
    - a reader: lists shown, no write controls, a direct POST → 403;
    - a WellD CH-only manager: no switcher, a WellD Italia URL → 404 view;
    - a person without either capability: no menu entry, `/accounting` denied;
    - an admin: the switcher, and WellD Italia empty states.
  - `refund-accounting-settings.spec.ts` (adapted T31): a Refund admin without an Accounting
    capability sets a default and the designation among Accounting's entries, sees no Accounts/VAT or
    Rates view, and sees the "kept by accounting managers" note. A default deactivated in Accounting
    shows "choose a new default".
  - `refund-accounting.spec.ts` (adapted T32):
    1. a submitted CHF line and an EUR 2026-03 line, defaults shown;
    2. change a VAT code, approve, the employee sees the numbers;
    3. **correct the 2026-03 EUR rate in Accounting to 0.9300**;
    4. compile and export: the CSV reads `10.40;0.9246;9.62` (AC-5.5);
    5. plus a **rate-pending** line in a past month with no rate (`unusedPastMonth()`): approved,
       shown pending, export blocked with a missing rate; then a manager enters the rate in
       Accounting, the export succeeds, and the line carries it (AC-5.6).
- **Helpers:** `helpers/accountingFixtures.ts` (new; accounting-api with an admin token:
  `createLedgerAccount`, `createVatCode`, `setRate`, `uniqueAccountNumber`, `uniqueVatCode`,
  `unusedPastMonth`). `refundFixtures.ts` keeps the defaults and designation helpers, now by number
  and code. `parseAccountingCsv` stays.

### Docs, env contract, changesets (implementation tasks; nothing is deployed)

- `infra/README.md`:
  - a new section "`accounting-api` service (Railway) — NEW (specs/20261119-accounting)" with the
    variable table and provisioning;
  - the release runbook above;
  - outbound HTTPS to `www.backend-rates.bazg.admin.ch` moves from refund-api to accounting-api;
  - the `SERVICE_CLIENTS` edit.

  `infra/check.sh` gains the accounting-api checks.
- `.railway/railway.ts`: the `accounting-api` block (builder DOCKERFILE, `start: "bun run
  src/index.ts"`, `/health`, `preDeploy: "bun run db:deploy"`, 1 replica in `europe-west4-drams3a`,
  domain port 8089), **without `source`**. The operator applies it (D30).
- env-doctor manifest and templates (accounting-api; refund-api `ACCOUNTING_INTERNAL_URL` +
  `REFUND_FX_SOURCE` retired). `mise run env:doctor` stays green.
- AGENTS.md: the tool table (`/accounting`, nine tools), project structure, resource backends,
  domain language (an Accounting section; the Refund terms ledger account, VAT code and monthly
  average rate now say "kept in Accounting"; new terms copy and rate pending), ports, Running locally
  (e2e seed), and the ADR index. README.md rows.
- Changesets:
  - one cross-app changeset `accounting-module.md`: `@operai/accounting-api` and
    `@operai/accounting-ui` minor (new packages at 0.0.0), `auth`, `shell`, `refund-api` and
    `refund-ui` minor;
  - the pending `refund-accounting-export.md` is edited so it no longer announces Settings tabs that
    never ship (both unreleased).

  `mise run changeset:check` stays green.

## Test strategy

Levels:

| Level | What |
|---|---|
| **unit** | pure modules, `bun test` or Vitest |
| **int-A** | accounting-api routes against the `accounting` DB on :5445, with a fake resolver and a fake BAZG source |
| **int-R** | refund-api routes against `refund` on :5445, with a fake `AccountingPort` |
| **db** | direct-SQL adversarial tests (triggers, CHECKs, indexes) |
| **mig** | migration tests on scratch databases |
| **auth** | auth `bun test` |
| **ui-A** | accounting-ui Vitest + RTL + axe |
| **ui-R** | refund-ui Vitest + RTL + axe |
| **shell** | shell Vitest |
| **script** | release and seed scripts against a DB |
| **e2e** | Playwright through the shell (owner step) |

| AC | Level | What proves it |
|---|---|---|
| AC-1.1 | int-A, ui-A, e2e | Manager POST → 201; the item is `active: true` in `GET …/ledger-accounts` **and** in `GET /system/v1/…/reference-data` for that entity only. UI: the add dialog adds a row. e2e `accounting.spec.ts`. |
| AC-1.2 | unit, int-A, ui-A | `limits.ts` vectors: `5905`, `2620.1`, `1.2.3` ok; `""`, `"  "`, `5905.`, `.5`, `59..05`, `59a`, 21 characters → refused; `" 5905 "` trimmed to `5905`; name of 120 ok, 121 or blanks refused. Int: 422 `fields` names `number` or `name`, and the row count is unchanged. UI: field error, focus on the first refused field. |
| AC-1.3 | int-A | Same number in the same entity → 409 naming it, both when active and when deactivated; the same number in the other entity → 201. `Promise.all` of 2 POSTs, 20 iterations → exactly one 201 and one 409 (P2002 mapped). |
| AC-1.4 | int-A, int-R | Deactivate → listed `active: false`, and `active: false` in the system read. int-R: the fake answers it deactivated → absent from `/accounting/options`. |
| AC-1.5 | unit, int-A, ui-A | `"8.1"` → 810; `"0"` and `"100"` ok; `"-1"`, `"100.01"`, `"8.123"` → 422; `imp81` → `IMP81`; `IMP 81`, 17 characters, label 0 or 81 characters → 422 naming the field; nothing saved. |
| AC-1.6 | int-A | `imp81` when `IMP81` exists, active or deactivated → 409 `vat_code_duplicate` with `vatCode` and `reactivate: true`; the other entity → 201; concurrent 2 × 20 → one 201. |
| AC-1.7 | int-A, db, ui-A | PUT and PATCH on `…/vat-codes/IMP81` → 404; raw `UPDATE vat_code SET "rateBasisPoints"` raises; the card renders no edit control. |
| AC-1.8 | int-A, int-R | Deactivated code → `active: false` in the system read; int-R: absent from options and refused by PUT classification and PUT defaults (422). |
| AC-1.9 | int-A | Deactivate then reactivate an account → `active: true`, same number and name; active again in the system read; two status rows with actor, time and entity. |
| AC-1.10 | int-A, int-R | Same for a VAT code (code, label and rate unchanged). int-R: a designation that pointed at it is usable again. |
| AC-1.11 | int-A | Reactivate an active entry, or deactivate an inactive one → 409 `already_active` / `already_inactive` with the message; the status-row count is unchanged. Two concurrent deactivations, 20 iterations → one 200, one 409, one row. |
| AC-1.12 | int-A, db | Route matrix: PUT, PATCH and DELETE on accounts and VAT codes → 404. Raw UPDATE or DELETE on `ledger_account` and `vat_code` raises, including a change of `entity`. |
| AC-1.13 | int-A, db | After add, deactivate and reactivate: the rows carry the actor (JWT `sub` and email), time, entity and active state; the before state is the opposite. Raw UPDATE or DELETE on `catalog_status_change` raises; a status row whose entity differs from its entry's is refused. No route edits or deletes them. |
| AC-2.1 | unit, int-A | Parser on the recorded 2026-03 fixture → EUR 924600, USD 780800, GBP 1063500. Manager fetch with the fake source → three `fetched` rows for `welld_ch` with `sourceUrl`, `fetchedAt` and the actor `system:rates-fetch`. |
| AC-2.2 | int-A, db | Fetch again with the fake returning another value → the recorded rate is unchanged, and the discrepancy is in the attempt log only. Raw second `fetched` insert for the same (entity, currency, month) → unique violation. |
| AC-2.3 | unit, int-A, ui-A | `months` window vectors. A reader GET → months from 2026-01 to the last completed month, newest first, the origin per currency. After a system rates call for 2025-06, that month is listed too. The UI badge shows fetched or corrected. |
| AC-2.4 | int-A, db | PUT a correction → in effect, `corrected` row with actor, entity and `replacesRateMicros` = the fetched value; the fetched row is still there; immutability. |
| AC-2.5 | int-A | `0`, `-1`, `1000` and `1.1234567` → 422 `invalid_rate`; `999.999999` ok; the current month → `month_not_completed`; CHF for welld_ch → `currency_not_convertible`. Row and attempt counts unchanged. |
| AC-2.6 | int-A | Correct, then fetch with the fake returning another value → the correction stays in effect. |
| AC-2.7 | int-A, ui-A | A month and currency with no row → `{status:"missing"}` even when neighbouring months have rates; the UI shows "missing". |
| AC-2.8 | int-A, ui-A | The fake throws, times out, or returns the wrong `<monat>` → no rate row; `lastFetch.outcome = "failed"` with `at`, visible to a reader; a persistent banner. |
| AC-2.9 | int-A | Manager POST fetch → attempts only for months without a recorded rate; a reader → 403 with no attempt row. |
| AC-2.10 | int-A | System rates call for a fetchable month with no row → the fake source is called, a row is recorded (trigger `consumer`, actor `system:refund-api`), answer `in_effect`. The fake failing → `missing`, `fetch_failed`. The fake hanging 30 s → answer `missing` in under 7 s. The token carries no user, so no Accounting capability is involved. A not-yet-fetchable month → `not_published` with no outbound call. |
| AC-2.11 | int-A, ui-A | A WellD CH fetch or correction leaves the WellD Italia row and attempt counts unchanged. WellD Italia GET → `source: null`, `currencies: []`. WellD Italia POST fetch → 422 `no_rate_source`, no attempt. The UI shows the "no official source" panel. |
| AC-3.1 | auth, e2e | Catalog test: `accounting` declares `read` and `manage` with `["entity"]` and is in `DECLARED_CATALOGS`; the unique-key test passes. A role rule with the entity condition passes `findRuleViolations`. e2e: the access journey grants through the admin API like any capability. |
| AC-3.2 | unit, int-A | `coverage.ts` vectors: manage covers read. A manage-only grant → GETs 200. |
| AC-3.3 | auth | Seed test: `admin` holds both unconditioned; `accounting` holds both with `{entity: user}`; no other system role holds either; a re-seed leaves an admin-edited grant unchanged. |
| AC-3.4 | int-A | A reader (read only): POST account, VAT code, deactivate, reactivate, PUT correction and POST fetch → 403 `accounting_manage_required`; entry, status, rate and attempt counts unchanged. No token → 401. |
| AC-3.5 | int-A, ui-A, e2e | A user attributed to `welld_ch` with conditioned grants: `/v1/me` lists only welld_ch; any `/v1/entities/welld_it/...` route (list, add, deactivate an existing IT entry, rates) → 404, the same body as an unknown entry. UI: no switcher. |
| AC-3.6 | int-A, shell, e2e | No grant: a matrix over every `/v1/*` route → 403 with no reference data in the body. Shell: no Sidebar entry, and `/accounting` is refused by the guard. |
| AC-3.7 | int-R, int-A | `settings:manage` holder: refund-api `/accounting/ledger-accounts`, `/accounting/vat-codes` and `/exchange-rates` → 404; the same user at accounting-api → 403. An Accounting-manage holder without `settings:manage`: PUT defaults and PUT designation → 403. |
| AC-3.8 | int-A, unit | A service JWT (scope, `system:refund-api`) → 200, equal to the reader projection of the same entity (same entries, values, `active`, rates in effect). 401 with one identical body for: no token, a user JWT, wrong `aud`, expired, missing scope, `system:crm-api`. POST, PUT and DELETE on `/system/v1/*` → 404. Contract test: both bodies parse with `accountingWire`; `shared:check` passes. |
| AC-3.9 | int-R, int-A, shell | A Refund reviewer and a Refund admin with no Accounting grant get `/accounting/options` from refund-api (200); their own token at accounting-api → 403; no menu entry. |
| AC-4.1 | int-R, ui-R | The fake holds active and deactivated entries → options carry only active WellD CH ones, with the exact key sets `{number,name}` and `{code,label,ratePercent,rateBasisPoints}` (no `active`, history or creator, no rates). Holds with and without an Accounting grant. The UI selects list them. |
| AC-4.2 | int-R | A `welld_it`-scoped reviewer → options 403 `accounting_out_of_scope`; the view's CH lines `inScope: false` with no classification. |
| AC-4.3 | int-R | PUT classification with a deactivated number, an unknown number, and a number that exists only in the fake's WellD Italia data → 422; the line's columns and the audit count are unchanged. Same for VAT codes. |
| AC-4.4 | int-R, ui-R | `settings:manage` holder without an Accounting grant → options 200; PUT defaults and designation with a deactivated or unknown entry → 422, no new row. The dialogs list only options. |
| AC-4.5 | unit, int-R, ui-R | `referenceSnapshot` vectors: a default's number active / deactivated / absent → `active` / `deactivated` / `not_found`, and the resolver gives `null` for the last two. GET defaults returns the 12 types with copies and states. UI: the warning badge, and "None" for unset. |
| AC-4.6 | ui-R, int-R, e2e | SettingsPage renders General and Default classification only; `?section=exchange-rates` → General. `AccountingLinkNote` shows a link with `apps ∋ accounting` and the text without it. The removed routes → 404 (as AC-3.7). |
| AC-4.7 | int-R, db | Set a default, then the fake answers that entry deactivated, then a different name for the same number, then unreachable → `history` still shows the number, name and code as saved, with `byEmail` and `at`. The two new tables are immutable. |
| AC-4.8 | int-R, unit | The client keeps no state between operations: two consecutive options calls with the fake changed between them → the second reflects the change, and the fake counts two reads. A test asserts each listed operation performs a fresh read (call counter), so no cache exists to outlive 60 s. |
| AC-4.9 | int-R, ui-R | A WellD Italia line has `classification: null` and no panel. An IT-only request approves with the fake unreachable, and the fake is never called. |
| AC-5.1 | int-R | Approve a request with a CH CHF line on defaults, a CH CHF line classified by hand earlier, an EUR line (rate in the fake) and a rejected line → copies: defaults from the fake, the hand copy unchanged, `fxRateMicros`/`fxRateMonth` on the EUR line, nothing on the rejected line; `line_classified` cause `approval` carries the copied values and `fxRate`. |
| AC-5.2 | int-R | PUT classification while submitted, and while approved and unpaid → the copy is written at that moment; `line_classified` v2 from→to with numbers and names, or codes and rates. |
| AC-5.3 | int-R, db | After approval the fake deactivates the account, reactivates it, changes the rate in effect and later fetches → the view's number, name, code, rate, exchange rate, CHF and VAT, and the CSV bytes, are unchanged. db: a raw UPDATE of `accountNumber` on a paid numbered line raises; an UPDATE of a set `fxRateMicros` raises on any status. |
| AC-5.4 | int-R | A compiled batch whose CH lines all hold copies, with the fake unreachable → summary 200 `exportable: true`, CSV 200, and **0 fake calls**. Export twice with the fake's data changed in between → identical bytes and SHA-256. |
| AC-5.5 | unit, int-R, e2e | `amounts` vector 1040 × 924600 → 962. int-R: a line copied at 924600, the fake now answering 930000, export → the row reads `10.40;0.9246;9.62`. e2e adapted T32. |
| AC-5.6 | int-R, db, e2e | EUR line with no rate in effect → approve 200, `fx*` null, the view `rateStatus: "pending"`, `amountCents` and `vatAmountCents` null. Export with the rate now in the fake → copied, `line_rate_copied` with the exporter's actor and time, CSV from the copy. A refused export (missing, or unreachable) → no column change, no audit row, no log row. Two concurrent exports → one copy; both files are equal. |
| AC-5.7 | int-R, db | Post-approval PUT of the account → only `accountNumber`/`accountName`/`ledgerAccountIsDefault` change; `fx*`, `approvedTotalCents`, `status` and `decided*` unchanged. Paid → 409 `classification_locked`; the db trigger holds. |
| AC-6.1 | int-R, ui-R | Fake unreachable (each kind) + a non-rejected CH line, including one already classified by hand (D10) → 503 `accounting_unavailable`, `Retry-After`. UI: the message inside the approve dialog, in en and it. |
| AC-6.2 | int-R | After each refusal (unreachable; `classification_missing`; the classification 503): status `submitted`, no receipt number, no `receipt_counter` row, no copy, `decided*` null, audit count unchanged; a later approval succeeds. |
| AC-6.3 | int-R | Reachable: a type without a default; a default deactivated in Accounting; a default not found; a non-CHF line whose designation is unset or deactivated → 409 `classification_missing` naming the lines and halves. Unreachable + missing default → 503 (AC-6.1 first). |
| AC-6.4 | int-R | An IT-only request, and a request whose CH lines are all rejected, approve with the fake unreachable; the fake has 0 calls. |
| AC-6.5 | int-R, ui-R | Unreachable: the view is 200, `accounting: "unavailable"`, lines show their copies or the recorded defaults (`unverified`); options 503; PUT 503 and the line unchanged. UI: no selects, the note. |
| AC-6.6 | int-R | A pending line + unreachable → summary `blockers.accountingUnavailable: true`, `missingRates: []`; CSV 409 with the same; no `refund_batch_export` row; compile, mark-paid and discard of the batch are 2xx. |
| AC-6.7 | int-R | Reachable, the fake answers `missing` for EUR 2026-10 → blocked, listing `{EUR, 2026-10}`; compile, pay and discard unaffected. |
| AC-6.8 | unit, int-R | Client: `ACCOUNTING_DEADLINE_MS === 10_000`; with an injected 200 ms deadline, a 250 ms answer → unavailable and a 150 ms answer → ok. Each of these → unavailable: 500, 503, 403, 401 twice (one re-mint), redirect, non-JSON, body over 256 KiB, schema mismatch, wrong entity echo, a missing pair, a token mint failure. A parameterised int-R test runs one failure kind through approve, classify, view, options, settings write, export and release. |
| AC-6.9 | int-R, ui-R | Unreachable: GET defaults 200 with the recorded copies, states `unverified`, `accounting: "unavailable"`; PUT → 503. UI: the banner, Change disabled with its reason. |
| AC-6.10 | int-R, ui-R | Every refusal body (503, 422, 409) matches no `http`, `localhost`, private-domain, cuid or stack pattern. Strings: each code's message exists in `en` and `it` (parity test) and names cause and remedy (snapshot of keys). |
| AC-7.1 | int-R | Regression: the 20261118 suites for its US-2, US-3, US-4, US-6 and US-7 stay green, adapted to the fake (classification, numbering, export, release, receipt lifecycle, race). Each changed assertion is listed in the task. |
| AC-7.2 | unit, int-R | The 20261118 golden CSV is compared byte for byte, unchanged (header, column order, values); the receipt-numbering suites are unchanged; the owner key-set test of `GET /requests/{id}` is unchanged. |
| AC-7.3 | int-R, ui-R | Summary `viewer.canOpenAccountingRates` is true for `accounting:read` (or manage) covering `welld_ch`, false for none or IT-only. The card links to `/accounting/exchange-rates?entity=welld_ch&month=2026-03`, or shows the "ask an accounting manager" copy. |
| AC-7.4 | script | Legacy approved and paid CH lines, CHF and EUR (a month with a rate in the fake and one without) → copies from the defaults, the rate copied, or pending; numbered as in 20261118. The fake unreachable → exit 2, the message, and no number, copy, default row or marker; a rerun with the fake back works. IT lines untouched. `--dry-run` writes nothing. |
| AC-7.5 | script, int-R | The fake holds no WellD CH entries → the release numbers the legacy lines and the report lists them as unclassified; a later approval of a CH request → 409 `classification_missing`. |
| AC-8.1 | auth, shell, e2e | `/authz/me` `apps` contains `accounting` for read-only, manage-only and both, and not for: no grant, a conditioned grant with the user's entity null, an unknown condition. Shell: the Sidebar shows it only with `apps ∋ accounting`; the route mounts the remote; it is denied otherwise. |
| AC-8.2 | ui-A, e2e | `/v1/me` with two entities → the switcher; the URL `?entity=` changes the lists; every title names the entity. One entity → no switcher, and the titles still name it. |
| AC-8.3 | int-A, ui-A | WellD Italia lists → 200 `items: []`; the UI shows the "nothing entered yet" `StatePanel`, not an error. |
| AC-8.4 | ui-A, e2e | Strings parity + no-hard-coded-copy; axe with zero violations on every state of every card and dialog; every control has a visible label; a 422 moves focus to the first refused field and announces it; keyboard-only add, deactivate and correct (RTL `userEvent.keyboard`, and e2e for one dialog). |

**Extra tests** (properties no single AC states):

| Property | Level | What proves it |
|---|---|---|
| Migration from 20261118 data | mig | Scratch `refund_mig` at 20261119090000 with classified, paid, EUR and defaults fixture rows → after the new migration: copies equal the old joins, defaults and designation history are carried with the same ids and actors, EUR lines get the in-effect rate, the dropped tables are gone, every CHECK is validated. A fresh DB → all migrations apply; `prisma migrate diff` shows no difference, for both services. |
| The guard works after the columns are gone | db | An UPDATE of any non-accounting column of a paid numbered line succeeds (no reference to a dropped column in the new function). |
| CHF/VAT from the copy, not live | int-R | The view of an approved line after the fake's rate changes → the same CHF. |
| A classification PUT racing approve or mark-paid | int-R | The 20261118 race test (20 iterations), with the fake injected. |
| The consumer budget sits under the consumer deadline | int-A + unit | Constants: `CONSUMER_FETCH_BUDGET_MS (6000) + margin < ACCOUNTING_DEADLINE_MS (10000)`, asserted across the two packages by a repo-level test reading both constants. |
| Consumer-triggered fetch is bounded | int-A | 36 pairs over 12 months → at most 6 months attempted; a second call within 15 min → throttled, no outbound call. |
| Natural keys survive re-entry | int-R | Defaults saved; the fake's entries get new internal ids (not on the wire) → defaults still resolve. |
| Seeds agree | unit | Every number and code in `accounting-defaults.welld-ch.json` exists in `seed.welld-ch.json`. |
| Seed script idempotent | script | Two runs → the second adds nothing; an existing deactivated entry is left deactivated. |
| `apps` derivation agrees with accounting-api coverage | unit | One vectors file read by both `auth` and `accounting-api` tests. |
| No accounting-api user route accepts a service JWT, and no system route a user JWT | int-A | A matrix. |

**Mapping result: total.** All 68 ACs (13 + 11 + 9 + 9 + 7 + 10 + 5 + 4) map to at least one
automated test. The live e2e runs are owner steps. No AC needed a spec change to be testable; the
readings used are D10, D17, D18 and D27.

**Gates** (QE `done when`):
- accounting-api `bun test` + `typecheck`; refund-api `bun test` + `typecheck`; auth `bun test`;
- accounting-ui and refund-ui `pnpm test`, `pnpm lint`, `pnpm build` (refund-ui has no `typecheck`
  script, qe-report D-5);
- shell build, lint, test;
- `mise run ui:check`, `shared:check`, `changeset:check`, `env:doctor`;
- the migration checks;
- `cd shell && pnpm e2e accounting refund-` (owner).

## Risks

| # | Risk | Mitigation / early check |
|---|---|---|
| R1 | **Approvals are blocked between the deploy and the Refund release** (minutes, or longer if Accounting is not yet seeded). | Steps 0–2 of the runbook happen before the push; the seed is one command; the release runs outside the batch day; the 409 `accounting_release_pending` message already explains it in the UI. |
| R2 | **Accounting's initial data is not entered** before the Refund release (open question 3), or the defaults name numbers Accounting lacks. | The seed fallback; the "seeds agree" test; the release `--dry-run` lists skipped defaults and unclassified lines; IS-1's consequence (a paid legacy line left unclassified stays locked) applies as in 20261118, so the runbook requires a clean dry run. |
| R3 | **Accounting availability now gates WellD CH approvals** (by spec). | Healthcheck + `check.sh`; one replica like its peers; refusals are clear and change nothing; IT approvals and exports of copied lines are independent (AC-6.4, AC-5.4). |
| R4 | **A consumer can trigger outbound fetches.** | Only `system:refund-api` is allowed; at most 36 pairs; at most 6 months fetched per call; a 15-min throttle and single flight per (entity, month); only completed months; a fixed host. |
| R5 | **Contract drift** between accounting-api's answers and refund-api's parser, since both are tested against fakes. | The shared-copy `accountingWire` (CI `shared-copies.yml`); contract tests on both sides; the e2e on the real path. |
| R6 | **Timeouts compose badly**: Accounting's fetch outlasts Refund's deadline, so a reachable Accounting looks unreachable. | Consumer budget 6 s < 10 s, with a cross-package constant test. |
| R7 | **The migration fails on a developer database** with hand-made odd rows, or the old guard function fires during the backfill. | The backfill writes only new columns; the function is replaced before the drop; CHECKs are `NOT VALID` then `VALIDATE` with named errors; the mig test runs on fixture data. |
| R8 | **Natural keys stop being identities** if a later spec allows editing a number or code. | The spec forbids it (AC-1.12); ADR 20261119-accounting-reference-data-belongs-to-accounting-api names it as an escalation trigger; the DB triggers forbid UPDATE. |
| R9 | **Accounting changes between the pre-read and the commit** of an approval. | Allowed by AC-4.8 (the read is live, seconds old); the line records what was read; the audit holds the copied values. |
| R10 | **A rate-pending line in a paid batch** whose rate never appears blocks that batch's export forever. | A manager can enter a rate for any completed month (AC-2.4 applies to a missing month); the blocker names the currency and month and links to it (AC-7.3). |
| R11 | **The e2e stack gains a service**, so the global setup can fail for environmental reasons. | The health pre-check with a message naming the command; separate skip flags; AGENTS.md "Running locally" updated. |
| R12 | **Two derivations of "covers an entity"** (auth's `/authz/me` and accounting-api's coverage) drift. | One shared vectors file tested in both packages; both fail closed on unknown conditions. |
| R13 | **`SERVICE_CLIENTS` edited before the new auth is live** → auth refuses to start. | Runbook step 4 comes after step 3's verification; the same rule as activities-api. |
| R14 | **20261118's owner items are still open** (T31/T32 live e2e, T39 answers, T40 release). | Carried here: the adapted journeys replace T31/T32; T39's answers include open question 3; one release covers both specs. |
| R15 | **Removing refund routes breaks a consumer not in the repo.** | None exists (unreleased); the 404s are tested; refund-ui and the e2e helpers change in the same push. |
| R16 | **Old audit rows (dev) use detail v1** with catalog ids. | Readers accept v1 and v2; production has no v1 rows. |
| R17 | **Dead `refund_setting` rows of the old designation key.** | Not in the generic registry, so no read path; documented (D33). |
| R18 | **Railway drift job fails** between the merge and the operator's apply (the block has no source). | Expected and loud; the runbook applies on the release day. |
| R19 | **A user attributed to welld_it with the `accounting` role gets Accounting manage for WellD Italia** (AC-3.3 as specified), before any Italian data or source exists. | Harmless (empty lists, no source); stated under open question 4. |

## Security

**Security-sensitive: YES.** Schedule the `owasp-reviewer` pass in parallel with QE, **standard
tier**. Escalate to frontier only if the review finds a system route reachable by a principal outside
`SYSTEM_READERS`, or a user route that reads or writes another entity's data. The feature adds a
service that holds financial reference data and an authorization surface (new capabilities, entity
coverage, a new service scope, a derived app entry). It also moves an outbound fetch of a third-party
document to a path that a service can trigger, and changes immutability rules on financial records.
The data is not personal beyond actor emails, and not regulated.

Surfaces to review:

1. **accounting-api user routes** (`/v1/me`, `/v1/entities/{entity}/…`):
   - capability and entity coverage on every route;
   - 404 for uncovered entities vs 403 for a missing manage (no existence leak across entities);
   - the actor only from the JWT;
   - input regexes, trimming and upper-casing, the 4 KiB body limit;
   - no PUT, PATCH or DELETE;
   - CORS limited to the shell (A01, A03, A04).
2. **accounting-api system routes** (`/system/v1/…`):
   - `systemAuth` (RS256, issuer, `aud = SERVICE_AUDIENCE`, expiry, scope, sub allowlist);
   - an identical 401 for every failure, a user JWT never accepted, GET only;
   - `no-store`; the projection carries no emails or history; the pair limits (A01, A07).
3. **Outbound BAZG client and parser**, moved unchanged:
   - a constant host, `redirect: "error"`, a 512 KiB cap, a DOCTYPE/ENTITY refusal, a rate range;
   - now also reachable from the consumer path, so check the throttle, the 6-month cap and the
     6 s budget (A10, A05, A04).
4. **refund-api `accountingClient`**:
   - the base URL from the environment only, no redirects, a 256 KiB cap, a strict schema;
   - the token never logged, refreshed on a 401 once;
   - failures refuse (fail closed) and never fall back to stale or default values (A08, A09).
5. **auth**:
   - the new catalog and seed grants, which must never rewrite an admin's edit;
   - `DERIVED_APPS`, presentation only, which must not open other routes;
   - `KNOWN_SERVICE_SCOPES` (A01).
6. **refund-api authorization changes**:
   - the options gate widened to `settings:manage`, which exposes only the active WellD CH entries;
   - `viewer.canOpenAccountingRates` computed server-side;
   - SR-1, SR-2 and FR-1 preserved on the classification PUT (A01).
7. **Data integrity**:
   - the refund-api migration (backfill, function replacement before the column drop, CHECKs, the
     table drops);
   - the new guard: copies locked when paid and numbered, the fx columns write-once;
   - accounting-api immutability triggers and CHECKs; the export transaction's ordering (copy, log,
     then deliver) (A08).
8. **Scripts**:
   - `seed:welld-ch` (system actor, no personal data in output);
   - `accounting:release` (reads Accounting with refund-api's credential from an operator shell
     through `railway run`; SR-3 and SR-4 still hold) (A05, A09).
9. **Shell**: the CSP additions; the trusted origin for Bearer attachment (`VITE_ACCOUNTING_API_URL`
   only) (A05).
10. **Error bodies** (AC-6.10): no host, URL, id or internal text in refund-api or accounting-api
    problems (A04, A09).

## Decisions taken unattended

Each is the safest option available on 2026-11-19. "Change" says what reversing it takes.

| # | Decision | Why | Change |
|---|---|---|---|
| D1 | Refund references Accounting entries by **natural key** (number or code, within WellD CH); Accounting's ids never leave accounting-api. | The spec defines number and code as identity and makes them immutable; the keys survive re-entry; they are the words people use. | A code-wide refactor plus an ADR; R8 trigger. |
| D2 | **No cache across requests**; one snapshot per operation. | AC-6.1, AC-6.5 and the "last-known data" non-goal hold strictly; AC-4.8 holds with margin; tiny volume. | Add a send-stamped cache ≤ 60 s that never serves after a failed refresh, in `accountingClient.ts`. |
| D3 | **One 10 s deadline per operation**, covering token and calls; parallel calls; one 401 re-mint; every failure kind = unreachable. | AC-6.8 literally; no hidden retries stretching past 10 s. | The constant `ACCOUNTING_DEADLINE_MS`. |
| D4 | The consumer-triggered fetch has a **6 s budget** (5 s per call, ≤ 6 months, 15-min throttle); the triggers `manager` and `consumer` are derived server-side. | Keeps a reachable Accounting answering inside Refund's 10 s; closes FU-S5 of 20261118. | `CONSUMER_FETCH_BUDGET_MS`. |
| D5 | **An additive refund-api migration** carries Refund's data (copies, defaults and designation history, legacy rate copies) and drops the moved tables; `20261119090000` untouched. | Developer and e2e databases applied it; AGENTS.md forbids editing migrations; one source of truth after the move. | — (one-way; production unaffected). |
| D6 | The Accounting tool is reachable through a **derived `apps` entry** (`read` or `manage` covering ≥ 1 entity); no `accounting:access` action. | AC-8.1 ties the menu to the two capabilities; the 20261117 precedent. | Add an `access` action and drop the derivation. |
| D7 | Catalog: appId and resource `accounting`, actions `read`/`manage`, `["entity"]`; the seed gives `admin` unconditioned grants and the `accounting` role conditioned ones, via `ensureGrant`. | AC-3.1, AC-3.3; never rewrite an admin's edit (FR-4). | admin-ui role edits. |
| D8 | Service scope `accounting.reference.read`; `SYSTEM_READERS = ["system:refund-api"]`; one identical 401. | The narrow-channel rule (ADR 20261103); a second consumer is a deliberate code + scope change. | Add a sub and the scope to its client. |
| D9 | Coverage: read = read ∪ manage; an uncovered entity → 404; covered without manage → 403 on writes; no coverage at all → 403. | AC-3.2, AC-3.4, AC-3.5, AC-3.6. | `coverage.ts`. |
| D10 | AC-6.1 is read **literally**: any request with ≥ 1 non-rejected WellD CH line reads Accounting at approval, even if every line is hand-classified CHF. | The spec's text; one rule, no special case to get wrong. | One condition in the approve pre-read. |
| D11 | Accounting is read **before** the transaction, as a superset of the request's non-CHF CH pairs; the transaction resolves against that snapshot. | No lock held across HTTP; the superset always covers the locked state (lines are fixed while submitted). | — |
| D12 | The rate is copied at approval when in effect, else at the **first successful export, inside the export transaction**; the fx columns are write-once (trigger). | AC-5.1, AC-5.6, AC-5.3, AC-5.7; a refused export copies nothing. | — (specified). |
| D13 | Line copies hold number + name and code + rate (no label); the default and designation rows also keep the VAT label for display. | The spec's "copy"; AC-6.9 shows the recorded values when Accounting is down. | Add a column. |
| D14 | An export blocked because Accounting is unreachable is the existing 409 `accounting_export_blocked` with `blockers.accountingUnavailable`, not a 503. | One blocked schema (G10); AC-6.6 "not as a missing rate" is a distinct blocker. | `export.routes.ts`. |
| D15 | Approve, classify and settings writes refused because Accounting is unreachable → **503 `accounting_unavailable`** with `Retry-After: 30`. | A dependency outage, not a conflict; the UI branches on `code`. | Status mapping. |
| D16 | `GET /accounting/options` accepts `request:review` covering welld_ch **or** `settings:manage`. | AC-4.4: Refund admins choose defaults without an Accounting grant; the data is only the active WellD CH entries. | Gate in `classification.routes.ts`. |
| D17 | AC-7.3's link is decided by refund-api from the caller's resolved permissions (`accounting:read`/`manage` covering welld_ch), as `viewer.canOpenAccountingRates`; AC-4.6's link uses the shell's `apps`. | The browser never evaluates conditions (ADR 20261117); AC-7.3 is about WellD CH's month, AC-4.6 about the app. | — |
| D18 | The Accounting app shows no who-added and no history (only the active state and the rate origin); the user and system APIs return the same minimal projection. | Non-goal "no history screen"; data minimisation; makes AC-3.8's "same data" literal. | Add fields; the data is recorded already. |
| D19 | WellD Italia is in the model with **no foreign currencies and no source** in v1; the rates screen says so; fetch → 422 `no_rate_source`. | AC-2.11; Italy is a configuration change in `entities.ts` plus a source, with no schema migration. | `entities.ts` + a source module (later spec). |
| D20 | The seed is split: accounting-api `seed:welld-ch` (accounts and VAT codes, operator-run, optional) and Refund's release (defaults and designation by natural key, validated live). | Each service owns its data; a fallback for open question 3 (see the amendment SA-1). | Skip the seed; enter by hand. |
| D21 | **One push** plus operator steps; approvals refused between the deploy and the Refund release (the 20261118 D6 gate). | Splitting the stacked branches into two releases would require reordering 20261118; every pairing fails closed. | Two pushes if the branch is restructured. |
| D22 | Port 8089 (api), 5183 (ui), DB `accounting`, hosts `accounting-api.operai.welld.io` / `accounting.operai.welld.io`, Vercel project `accounting-ui`. | The next free values; `provision-tool.sh` defaults. | Config. |
| D23 | The producer/consumer wire schema is one **shared-copy** file `accountingWire`. | Both sides test against fakes; `shared:check` keeps them byte-identical. | — |
| D24 | Accounting's routes are keyed by number or code in the URL. | One identity everywhere (D1); no ids to leak. | Routes. |
| D25 | Accounting's audit is the **self-auditing tables** (entry rows, status rows with entity, corrected rows with `replacesRateMicros`), with no separate audit table. | ADR 20260722 pattern; AC-1.13 and AC-2.4 fields are on the rows; triggers make them immutable. | — |
| D26 | The managers' auto-fetch once per visit (UX-11) is kept. | Existing, tested behaviour; nobody else would trigger missing months before a consumer asks. | Remove the call in the card. |
| D27 | "Published" (AC-2.1, AC-2.10) means **completed + 5 grace days** (Europe/Zurich), as R2 of 20261118 found the source answering for unfinished months. | A wrong early value would be recorded once and never replaced. | `FX_FETCH_GRACE_DAYS`; see the amendment SA-2. |
| D28 | refund-api tests inject a **fake `AccountingPort`**; the real path is proved by contract tests and the e2e. | Isolated databases per service; deterministic failure kinds. | — |
| D29 | Code moves by **`git mv`** then edit, and is removed from refund-api and refund-ui in the same change; pure formatting helpers get small copies in accounting-ui (not components). | Keeps history; the library rule is about components. | Lift the helpers into `@operai/ui` if a third app needs them. |
| D30 | `.railway/railway.ts` gains the accounting-api block **without `source`**; the operator applies and connects it. | The IaC is the one place (ADR 20261113); agents never deploy. | — |
| D31 | Limits live in one module per side: accounting-api `catalog/limits.ts` (20 / 120 / 16 / 80 characters, 2 decimals), `rates` (0 < r < 1000, 6 decimals); refund-api `ACCOUNTING_DEADLINE_MS`. | Open question "limits": one-line changes when accounting answers. | Constants + their tests. |
| D32 | Accounting is in the main `TOOLS` list, not the settings group. | Constraint 1: "in the tool menu, like the other tools". | `SETTINGS_TOOL_IDS`. |
| D33 | The old `refund_setting` designation rows are left in place (immutable) and never read. | Deleting would need disabling the trigger; they are dev-only. | — |
| D34 | New `AuditAction` `line_rate_copied`; `line_classified` detail v2 with copies; readers accept v1. | AC-5.6 audits the export-time copy with the exporter; natural keys in audit. | — |

## Open questions accepted as risk: fallbacks

| Open question (spec) | Fallback the plan proceeds on | Where it lives |
|---|---|---|
| **A wrong rate found after approval** (re-rate approved lines of an unpaid batch?) | **No re-rating.** A copied rate never changes (fx write-once trigger); the rate is corrected in Accounting before approval, or the line is handled in the books. A yes later needs a spec, a privileged action and a trigger exception. | Trigger (c); an escalation trigger of ADR 20261119-accounting-reference-data-belongs-to-accounting-api |
| **Limits** (20 characters, 2 decimals, 0 < rate < 1000 with 6 decimals, 60 s, 10 s) | As proposed. Each value is a named constant with its own test (D31); freshness is effectively 0 s (D2), within 60 s. | `limits.ts`, `rates.schemas.ts`, `accountingClient.ts` |
| **Who enters WellD CH's initial accounts and VAT codes** | The operator runs `seed:welld-ch` from the list accounting signs off (the 20261118 seed draft, D1/D13 there) on the release day, before the Refund release; or accounting types them in the app. AC-7.5's outcome applies if neither happens. | Runbook steps 0, 6; amendment SA-1 |
| **WellD Italia** (source, chart, VAT, managers) | Modelled, empty, no source, no currencies (D19). Per AC-3.3, members of the `accounting` role attributed to welld_it hold Accounting manage for WellD Italia, and admins hold it for both (R19). | `entities.ts` |
| Carried from 20261118 (its open questions 1, 4, 6; owner accounting) | Q1 source: BAZG, now in Accounting (D10 there, D27 here). Q4 initial list and defaults: the two seed files. Q6 designation: `NOVAT` in Refund's defaults seed (D13 there). Q2, Q3 and Q5 are unchanged in Refund. | Seed files; `exportFormat.ts` |

## Spec amendments proposed (not applied)

Wording only, no AC id changes, for the owner or the product-owner agent:

- **SA-1 (Non-goals, "Bulk import").** Today it says "The initial WellD CH list is entered in the
  app." Proposed: "…entered in the app, or loaded once on the release day by an operator-run seed of
  the list accounting signed off; no import feature is offered to users." Reason: the fallback for
  open question 3 is a one-off seed, which a literal reading of the non-goal would forbid.
- **SA-2 (AC-2.1, AC-2.10, "published").** Proposed addition to the Domain language: "A month's rate
  counts as published from the 5th day of the following month (Swiss time), because the source
  answers provisional values before that." Reason: D27, which is visible to users (a rate appears on
  the 5th, not on the 1st).
- **SA-3 (AC-4.5, "deactivated").** Proposed: "…whose entry has since been deactivated in Accounting,
  **or is no longer found there**, is shown…". Reason: an environment whose Accounting data was
  re-entered can lack a number Refund recorded. The plan already treats it like deactivated (state
  `not_found`).

Readings the plan takes without asking for an amendment:

- D10: AC-6.1 applied literally;
- D17: the AC-7.3 link is limited to holders covering WellD CH;
- D18: AC-3.8's "same data" means the reader's projection, which shows no audit metadata;
- AC-8.2: "several entities" can only arise from an unconditioned grant, because the suite's entity
  condition covers the holder's own entity (ADR 20261117 point 4).

## ADRs

Written on 2026-11-19 under the owner's autonomous-run choice (status Accepted, review on the owner's
return). Three new records and six amendments; each amendment is a dated "Amendment (2026-11-19)"
section, and history is not rewritten.

New ADRs (each file is `docs/adr/<id>.md`):

1. **ADR candidate 1, now `20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it`.**
   Accounting reference data is owned by its own service. A consumer:
   - reads it live over a read-only, purpose-scoped service credential (a sub allowlist);
   - keeps no copy of the lists across requests;
   - records on its own records, by the entity's natural key, a copy of exactly what it books at the
     moment it books it;
   - when it cannot read, refuses rather than use stale data.

   The producer and the consumer share one wire-schema file. This constrains Inventory, CRM, Projects
   and supplier invoices as future consumers. Escalation triggers: an edit of a number or code, a
   consumer needing writes, a volume that justifies a cache, a second consumer, a re-rating request.
2. **ADR candidate 2, now `20261119-data-that-moves-from-one-service-to-another-before-the-release-moves-by-an-additive-migration-that-carries-what-the-source-keeps-and-drops-what-moved-and-an-applied-migration-is-never-edited`.**
   Moving a feature's data to another service before release is an additive migration that carries the
   data the source service keeps and drops what moved. An unreleased, applied migration is still never
   edited.
3. **ADR candidate 3, now `20261119-on-demand-outbound-work-that-a-provider-does-for-a-consumer-runs-on-a-budget-strictly-inside-the-deadline-of-the-consumer-and-what-triggered-it-is-derived-by-the-provider-never-claimed-by-the-caller`.**
   A provider's on-demand outbound work runs on a budget strictly inside its consumer's deadline
   (6 s inside 10 s), and fetch triggers are derived server-side, never claimed by the caller. **Kept as
   its own record, not folded into A1.** Reason: the rule is about how deadlines nest between any
   consumer and any provider and about who may name a trigger, and the rates are its first case only; an
   amendment to a rates ADR would be found by someone changing rates, not by someone writing the next
   provider that fetches on demand. Its failure shape (a working provider judged dead; a caller-claimed
   label) differs from ADR candidate 1's, so folding it there would blur both. A1 records what changed
   for the rates and points to it.

Amendments to existing ADRs (each file is `docs/adr/<id>.md`, section "Amendment (2026-11-19)"):

- **A1** — `20261118-monthly-exchange-rates-are-fetched-on-demand-…`: it now lives in accounting-api,
  per entity; "admin" → accounting manager; the triggers are `manager` and `consumer`, the consumer
  budget is 6 s, and the settings-view trigger is subsumed.
- **A2** — `20261118-chf-and-vat-amounts-are-derived-on-read-…`: the inputs are the line's copied rate
  and VAT rate, not the rate in effect; a rate-pending line has no amount; Option B's "stale after a
  correction" no longer applies, because the rate is frozen by the spec.
- **A3** — `20261118-accounting-classification-is-live-until-approval-…`: copies by natural key replace
  the FKs; options come from Accounting; an Accounting outage refuses approval and classification;
  the guard locks copies and makes the rate write-once.
- **A4** — `20261118-the-accounting-export-is-generated-on-request-…`: the first successful export copies
  pending rates inside the export transaction, before the log row; the `accountingUnavailable` blocker
  is added; exports of fully copied batches never call Accounting.
- **A5** — `20261118-receipt-numbers-come-from-a-row-locked-…`: the release script reads Accounting
  first and writes nothing if it cannot.
- **A6** — `20261117-an-app-is-reachable-through-a-capability-it-administers-…`: a second derived entry
  (`accounting`), built from a `DERIVED_APPS` table.

References elsewhere in this plan to "the ADR candidate" or "ADR candidate 1" mean the first record above.
