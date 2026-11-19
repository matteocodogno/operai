---
spec: 20261118
generated: 2026-11-18
---

# Tasks: Refund accounting — ledger accounts, VAT, receipt numbers and the batch export

Derived from these committed files:

- `spec.md`: approved, with the 2026-11-18 amendments A1 and A2, 61 ACs.
- `plan.md`: approved, synced with the amendments and with design.md (G1–G13, UX-1..UX-14).
- `design.md`: screens, component inventory and copy keys.
- The five ADRs of 2026-11-18 written for this spec.

Reading the list:

- **Tracks.** Every task is on one of these tracks, which can run in parallel wherever the effective
  graph (deps ∪ `touch:` overlap) allows:
  - **backend** (refund-api, auth);
  - **frontend** (refund-ui, operai-ui), built against plan.md § API contracts with mocked
    responses, so it does not wait for the backend;
  - **e2e** (shell/e2e), which needs both;
  - **release** (changesets, docs, QE, review, closing).
- **`touch:` is binding.** A task changes only the paths it lists. A path found missing during work
  is added to the task (and to the overlap check) before it is changed.
- **One copy catalog.** All new copy is added to `refund-ui/src/strings.ts` by T22 at once, en and
  it, from design.md § Copy keys. No other task touches `strings.ts`, which is what lets the
  frontend tasks run in parallel. A key found missing later goes into a small follow-up commit on
  T22's file, serialized against whatever frontend task is open.
- **One migration.** All schema changes are in one Prisma migration (T1). Migrations are a numbered
  series and this feature's changes are one coherent DDL unit (plan § Data model).
- **Owner tasks** are marked **[OWNER]**. They need accounting's answers, production access or a
  release push, and are never run by an agent.
- **The ADR-suggested extra tests** are T19, a task of their own with its own files, so they can
  start only once the code they attack exists.

## Backend — foundations

- [x] T1: refund-api — schema and the single migration: catalog, defaults, line columns, counters, FX, export log, triggers, checks — refs: AC-1.5, AC-1.8, AC-2.1, AC-2.5, AC-3.7, AC-4.7, AC-5.3, AC-6.10 — deps: none
  - touch: `refund-api/prisma/schema.prisma`, `refund-api/prisma/migrations/*`, `refund-api/src/lib/db.accounting-*.test.ts`, `refund-api/src/test-support/dbCleanup.ts`
  - agent: backend-dev · backend
  - Details:
    - Models of plan § Data model: `LedgerAccount`, `VatCode`, `AccountingCatalogStatus`,
      `ExpenseTypeDefault`, `ReceiptCounter`, `ExchangeRateEntry` (+ enum `ExchangeRateOrigin`),
      `ExchangeRateFetchAttempt`, `RefundBatchExport`; the `RefundLine` classification and receipt
      columns with `@@unique([receiptOwnerUserId, receiptYear, receiptSeq])`; `AuditAction`
      + `line_classified`, `receipt_number_assigned`.
    - Hand-appended SQL in the same migration:
      - raising immutability triggers on the seven history tables;
      - the `receipt_counter` trigger (`lastSeq` only grows, `startAfter*` frozen, no DELETE);
      - `refund_line_accounting_guard`: receipt columns frozen once set, a numbered line cannot be
        deleted, classification frozen when the request is `paid`;
      - CHECKs: VAT rate 0..10000, the catalog-status one-of, FX currency ≠ CHF, rate > 0, month =
        first day;
      - partial unique index `exchange_rate_fetched_once`.
    - `dbCleanup.ts` TRUNCATEs the new tables (TRUNCATE does not fire row triggers).
  - done when: `bun run db:deploy` applies on compose; `bun test src/lib/db.accounting-*.test.ts`
    shows that raw UPDATE/DELETE on each of the seven tables raises, that `vat_code.rateBasisPoints`
    cannot be updated, that a numbered line's `receiptNumber` cannot change and the line cannot be
    deleted, that a paid request's line classification cannot change, and that the counter
    refuses to decrease; the whole refund-api suite (`bun test`) is green.

- [x] T2: auth — `request:reclassify` (entity condition) in the refund catalog, granted like `approve` — refs: AC-3.6 — deps: none
  - touch: `auth/src/authz/catalogs/refund.ts`, `auth/src/authz/catalogs/refund.test.ts`, `auth/src/authz/seed.ts`, `auth/src/authz/seed.test.ts`
  - agent: backend-dev · backend
  - Details: plan D5. Action `reclassify`, label "Reclassify approved line",
    `supportedConditions: ["entity"]`. Grants: `accounting` entity-conditioned, `refund-admin`
    unconditioned (`REFUND_ADMIN_REQUEST_ACTIONS`), `admin` per its existing pattern. Doc comment
    extended. Deploy note: auth goes out before refund-api (plan R13).
  - done when: `bun test src/authz` in `auth/` passes, with the catalog test asserting the action
    and its condition and the seed test asserting the three grants; `uniqueResourceKeys.test.ts`
    green.

- [x] T3: refund-api — pure `amounts.ts` (CHF, VAT; integer, half-up, once) and `receiptNumber.ts` (initials, format) — refs: AC-3.8, AC-4.2, AC-4.8, AC-6.3, AC-6.4, AC-6.12 — deps: none
  - touch: `refund-api/src/accounting/amounts.ts`, `refund-api/src/accounting/amounts.test.ts`, `refund-api/src/accounting/amounts-vectors.json`, `refund-api/src/accounting/receiptNumber.ts`, `refund-api/src/accounting/receiptNumber.test.ts`
  - agent: backend-dev · backend
  - Details:
    - `chfCents`, `vatCents` with BigInt; vectors include 1040 @ 924600 → 962, 2080 @ 810 → 156,
      0 → 0, half-up boundaries, 100 % and 0 %.
    - `initials(name, email)` and `formatReceiptNumber(initials, year, seq)` per plan "Receipt
      number rules" (NFD strip, first/last word, email fallback, `X` padding, ≥1000 unpadded).
  - done when: `bun test src/accounting/amounts.test.ts src/accounting/receiptNumber.test.ts` passes
    with every vector, including `Matteo Codogno` → `MC`, `matteo.codogno@…`/`mcodogno@…`/`m.c@…` →
    `MC`, `Cher` → email fallback, `x@…` → `XX`, `Élise Würth` → `EW`, and seq 1000 → `MC26/1000`.

- [x] T4: refund-api — pure `resolveClassification` (live defaults, foreign-currency VAT code, inactive = none, stored values kept) — refs: AC-1.3, AC-1.6, AC-2.7, AC-3.1, AC-3.2, AC-3.4, AC-3.9 — deps: none
  - touch: `refund-api/src/accounting/classification.ts`, `refund-api/src/accounting/classification.test.ts`
  - agent: backend-dev · backend
  - Details:
    - Input: line (entity, currency, type, stored ids and flags), the type defaults with their
      `active`, and the foreign-currency designation with its `active`.
    - Output: `{ account, accountIsDefault, vatCode, vatCodeIsDefault, missing[] }`, or `null` for
      WellD Italia and rejected lines.
    - Plan § Foreign-currency VAT code rules and G3: an inactive default account, type VAT default
      or designation is no default; a stored value on an inactive entry is returned with
      `active: false`.
  - done when: `bun test src/accounting/classification.test.ts` passes with vectors for:
    - CHF line → type defaults;
    - EUR/USD/GBP lines → type account + designation;
    - designation unset, cleared or inactive → `vatCode: null`, `missing: ["vatCode"]`;
    - type default account inactive → `account: null`;
    - override on an inactive account → kept, `active: false`;
    - IT line and rejected line → `null`.

- [x] T5: refund-api — pure FX parser (BAZG XML) and the month window (fetchable months, display window) — refs: AC-5.1, AC-5.5 — deps: none
  - touch: `refund-api/src/fx/parse.ts`, `refund-api/src/fx/parse.test.ts`, `refund-api/src/fx/months.ts`, `refund-api/src/fx/months.test.ts`, `refund-api/src/fx/fixtures/*`
  - agent: backend-dev · backend
  - Details:
    - `parse.ts`: refuses `<!DOCTYPE`/`<!ENTITY`; requires the `<monat>` echo to equal the
      requested month; reads eur/usd/gbp; normalises the unit `1`/`100`; range-checks the rate
      (> 0, < 1000); returns micros.
    - Fixture: the real `xmlavgmonth?j=2026&m=03` answer as recorded on 2026-11-18.
    - `months.ts`: `fetchableMonths(now)` (Europe/Zurich, completed months, `FX_FETCH_GRACE_DAYS =
      5`) and `displayWindow(now, neededMonths)` from `FX_FIRST_MONTH = 2026-01`.
  - done when: `bun test src/fx/parse.test.ts src/fx/months.test.ts` passes:
    - the fixture gives EUR 924600, USD 780800, GBP 1063500;
    - a DOCTYPE document, a wrong `<monat>`, a missing `gbp` and a `kurs` of 0 are refused;
    - the current month is never fetchable;
    - the window lists completed months only, newest first.

- [x] T6: refund-api — catalog API: ledger accounts and VAT codes, add / deactivate / reactivate, history — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.7, AC-1.8, AC-1.9, AC-1.10, AC-1.11 — deps: T1
  - touch: `refund-api/src/accounting/catalog.repo.ts`, `refund-api/src/accounting/catalog.routes.ts`, `refund-api/src/accounting/catalog.schemas.ts`, `refund-api/src/accounting/catalog.routes.test.ts`, `refund-api/src/index.ts`
  - agent: backend-dev · backend
  - Details:
    - Plan § API contracts "Catalog: management".
    - `settings:read` for GET and `settings:manage` for writes, actor from the JWT; 4 KiB body
      limit.
    - 409 `ledger_account_duplicate` / `vat_code_duplicate` naming the value, also for a
      deactivated entry and on P2002.
    - 409 `already_active` / `already_inactive`, writing no status row.
    - No PUT/PATCH route (404).
    - `ratePercent` string → basis points exactly.
    - Registers the router in `src/index.ts`.
  - done when: `bun test src/accounting/catalog.routes.test.ts` passes, covering the plan's
    AC-1.1, 1.2, 1.4, 1.5 (PUT/PATCH 404), 1.7, 1.8 (history before→after), 1.9, 1.10 and 1.11
    (status-row count unchanged) rows; full refund-api suite green.

- [x] T7: refund-api — defaults API: the 12 type defaults and the foreign-currency VAT code (history, active only, no-op suppression) — refs: AC-1.9, AC-1.10, AC-2.1, AC-2.2, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-2.8 — deps: T1, T4, T6
  - touch: `refund-api/src/accounting/defaults.repo.ts`, `refund-api/src/accounting/defaults.routes.ts`, `refund-api/src/accounting/defaults.schemas.ts`, `refund-api/src/accounting/defaults.routes.test.ts`, `refund-api/src/index.ts`
  - agent: backend-dev · backend
  - Details:
    - `GET /accounting/expense-type-defaults` returns always 12 types, plus
      `foreignCurrencyVatCode`, `foreignCurrencyVatCodeUsable` and
      `foreignCurrencyVatCodeHistory`.
    - `PUT …/{type}` and `PUT /accounting/foreign-currency-vat-code` return 422 for an inactive or
      unknown entry, and suppress no-ops.
    - The designation is stored under the `refund_setting` key
      `accounting.welld_ch.foreign-currency-vat-code`, not in the generic registry.
    - The repo exposes `loadDefaultsSnapshot(tx)` for T8, T11, T12 and T13.
  - done when: `bun test src/accounting/defaults.routes.test.ts` passes:
    - history of both kinds with `byEmail`/`at`;
    - 12 rows with `null`;
    - 422 on inactive and unknown;
    - 403 without read or manage;
    - designation of a code that is later deactivated → `usable: false`, and after reactivation
      `usable: true`.

- [x] T8: refund-api — shared `classifyAndNumber(tx, …)`: freeze classification, lock counters in year order, number lines, write the two audit actions; the release gate check — refs: AC-3.5, AC-4.3, AC-4.4, AC-4.5, AC-4.7, AC-4.10 — deps: T1, T3, T4
  - touch: `refund-api/src/accounting/numbering.repo.ts`, `refund-api/src/accounting/numbering.repo.test.ts`, `refund-api/src/accounting/release.ts`, `refund-api/src/accounting/release.test.ts`, `refund-api/src/requests/audit.ts`
  - agent: backend-dev · backend
  - Details:
    - One function used by the approve transaction (T12) and the release script (T11), with
      `cause: "approval" | "release"`.
    - Order: expense date, then `createdAt`, then id.
    - Counter upsert: `INSERT … ON CONFLICT DO UPDATE … RETURNING` under `FOR UPDATE`, years
      ascending.
    - Writes `line_classified` / `receipt_number_assigned` with the plan's detail shapes.
    - `release.ts`: `isAccountingReleased(tx)` reads `accounting-release-completed-at`.
    - `audit.ts` gains the two actions.
  - done when: `bun test src/accounting/numbering.repo.test.ts src/accounting/release.test.ts`
    passes:
    - contiguous numbering across calls;
    - date/createdAt/id order;
    - two years in one call;
    - two employees with the same initials each start at 001;
    - `startAfter` honoured;
    - 20 concurrent calls for one employee → distinct contiguous numbers;
    - a rolled-back transaction consumes nothing.

- [x] T9: refund-api — FX source client, repo and service: rate in effect, fetch on demand (throttle, single-flight, parallel under the 10 s budget), attempt log, `REFUND_FX_SOURCE` — refs: AC-5.1, AC-5.4, AC-5.6 — deps: T1, T5
  - touch: `refund-api/src/fx/bazgSource.ts`, `refund-api/src/fx/bazgSource.test.ts`, `refund-api/src/fx/fx.repo.ts`, `refund-api/src/fx/fx.service.ts`, `refund-api/src/fx/fx.service.test.ts`, `refund-api/src/lib/env.ts`, `refund-api/src/lib/env.test.ts`
  - agent: backend-dev · backend
  - Details:
    - `bazgSource.ts`: constant host, `redirect: "error"`, 5 s per call, 512 KiB cap, injectable
      fetcher.
    - `fx.service.ts`:
      - `rateInEffect(currency, month)`: latest corrected, else fetched;
      - `fetchMonths(months, trigger, actor)`: parallel, `AbortSignal.any` of per-call and
        `FX_FETCH_BUDGET_MS = 10_000`, 15-min throttle per month, in-process single-flight, at
        most 6 months, `ON CONFLICT DO NOTHING`, discrepancies only in the attempt log;
      - `ensureRates(needed, trigger)` for the export (T18).
    - `REFUND_FX_SOURCE` = `bazg` | `off` (default `bazg`): `off` records `disabled`.
  - done when: `bun test src/fx/bazgSource.test.ts src/fx/fx.service.test.ts src/lib/env.test.ts`
    passes:
    - fake source records rows with `sourceUrl`, `fetchedAt` and actor `system:fx-fetch`;
    - a correction wins over a later fetch, and the discrepancy is logged;
    - throw, timeout and wrong month → no rate row, a `failed` attempt;
    - throttle and single-flight hold;
    - `off` → `disabled`;
    - an unknown `REFUND_FX_SOURCE` fails env validation.

- [x] T10: refund-api — exchange-rates routes: list with origin/missing/last fetch/`fetchDue`, fetch now, correction — refs: AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-5.6, AC-5.7 — deps: T7, T9
  - touch: `refund-api/src/fx/fx.routes.ts`, `refund-api/src/fx/fx.schemas.ts`, `refund-api/src/fx/fx.routes.test.ts`, `refund-api/src/index.ts`
  - agent: backend-dev · backend
  - Details:
    - Plan § API contracts "Exchange rates". No `sourceDiscrepancy` field (G8).
    - `POST /exchange-rates/fetch` reports a source failure as 200 with outcome `failed`.
    - `PUT /exchange-rates/{month}/{currency}` returns 422 `invalid_rate` /
      `currency_not_convertible` / `month_not_completed`, and suppresses no-ops.
    - Registers the router (after T7 on `src/index.ts`).
  - done when: `bun test src/fx/fx.routes.test.ts` passes, covering the plan's AC-5.2, 5.3, 5.4,
    5.5, 5.6 (`lastFetch.outcome = "failed"` with `at`) and 5.7 (403 on PUT and POST) rows.

## Backend — approval, release, accounting view

- [x] T11: refund-api — release script `accounting:release` (seed, system-actor designation, offsets, backfill CH lines, marker, `--dry-run`) — refs: AC-2.5, AC-7.1, AC-7.2, AC-7.3 — deps: T6, T7, T8
  - touch: `refund-api/scripts/accounting-release.ts`, `refund-api/scripts/accounting-release.test.ts`, `refund-api/scripts/data/*`, `refund-api/package.json`
  - agent: backend-dev · backend
  - Details:
    - Plan § "refund-api: new script", steps 1–4, in one transaction:
      1. Seed from `scripts/data/accounting-seed.welld-ch.json` (the D1 table; `NOVAT` designated
         by `system:accounting-seed` only when the key is empty).
      2. `--offsets <csv>`, refused for an (employee, year) pair that already has numbers.
      3. `classifyAndNumber(cause: "release")` for WellD CH lines of approved/paid requests
         without a number. WellD Italia lines are untouched (AC-7.3).
      4. The marker.
    - Prints the report. `"accounting:release"` added to `package.json` scripts.
  - done when: `bun test scripts/accounting-release.test.ts` passes:
    - legacy CHF and EUR CH lines classified (type defaults / type account + designation) and
      numbered by date, with actor `system:accounting-release`;
    - a type without a default, and an EUR line released with an inactive designation, are left
      unclassified;
    - IT lines unnumbered;
    - the seed designation in the history with its system actor;
    - an admin's earlier designation untouched;
    - a second run changes nothing;
    - `--dry-run` writes nothing;
    - an offset on a numbered pair is refused.

- [x] T12: refund-api — approve: release gate, classification check and freeze, numbering, the two new 409 codes; test and e2e setup carry the release marker — refs: AC-2.3, AC-3.4, AC-3.5, AC-3.9, AC-4.1, AC-4.2, AC-4.3, AC-4.4, AC-4.5, AC-4.6, AC-4.10 — deps: T7, T8, T11
  - touch: `refund-api/src/review/decide.repo.ts`, `refund-api/src/review/decide.routes.ts`, `refund-api/src/review/decide.routes.test.ts`, `refund-api/src/review/approve-accounting.test.ts`, `refund-api/src/test-support/dbCleanup.ts`, `refund-api/src/test-support/accountingRelease.ts`, `shell/e2e/global-setup.ts`
  - agent: backend-dev · backend
  - Details:
    - `approveTransaction`:
      1. the gate (409 `accounting_release_pending`);
      2. resolve every non-rejected CH line (409 `classification_missing` with
         `lines[{lineId,date,type,missing}]`, rollback);
      3. `classifyAndNumber(cause: "approval")`, numbering IT lines too (AC-4.1).
    - `truncateRefundTables()` re-inserts the marker via `accountingRelease.ts`, so the existing
      approve tests stay green (plan R14).
    - `shell/e2e/global-setup.ts` runs `bun run accounting:release` against the e2e database, so
      existing refund journeys keep approving.
  - done when: `bun test src/review` passes:
    - every existing approve test unchanged;
    - `approve-accounting.test.ts` covers the plan's AC-2.3, 3.4 (incl. inactive default account,
      unset designation with the CHF line approving), 3.5, 3.9 (IT-only request with no defaults
      approves), 4.1, 4.2, 4.3 (a refused approval consumes nothing), 4.4, 4.5, 4.6 and 4.10 (two
      parallel approvals, 20 iterations);
    - gate → 409 before the marker;
    - full refund-api suite green;
    - `cd shell && pnpm e2e refund-headline` green.

- [x] T13: refund-api — accounting view `GET /review/requests/{id}/accounting` and `GET /accounting/options` — refs: AC-1.3, AC-1.6, AC-2.7, AC-3.1, AC-3.2, AC-3.8, AC-3.9, AC-3.10, AC-4.6 — deps: T4, T9, T10, T12
  - touch: `refund-api/src/accounting/classification.repo.ts`, `refund-api/src/accounting/classification.routes.ts`, `refund-api/src/accounting/classification.schemas.ts`, `refund-api/src/accounting/classification.routes.test.ts`, `refund-api/src/index.ts`
  - agent: backend-dev · backend
  - Details:
    - Plan § API contracts "Accounting".
    - `request:review` + `requestInScope`, else 403/404.
    - Lines carry `rejected`, `classification` (null for IT/rejected), `chf` from
      `rateInEffect`, `vatAmountCents`, and `amountCents = approved ?? requested` (D11).
    - `classificationState` per status/batch.
    - Options: active entries only.
  - done when: `bun test src/accounting/classification.routes.test.ts` passes:
    - the plan's AC-3.1, 3.2, 3.8 and 3.9 rows;
    - AC-1.3/1.6: deactivated entries absent from options; a line keeps its stored value with
      `active: false`;
    - AC-2.7: inactive designation → `vatCode: null`;
    - AC-3.10: owner without review → 404;
    - rejected line → `classification: null`.

- [x] T14: refund-api — `PUT …/lines/{lineId}/classification` (status-dependent gate, row lock, audit) and withdraw clearing overrides — refs: AC-1.3, AC-1.6, AC-1.9, AC-1.10, AC-3.3, AC-3.6, AC-3.7, AC-3.9 — deps: T13
  - touch: `refund-api/src/accounting/classification.repo.ts`, `refund-api/src/accounting/classification.routes.ts`, `refund-api/src/accounting/classification.schemas.ts`, `refund-api/src/accounting/classification.routes.test.ts`, `refund-api/src/requests/lifecycle.repo.ts`, `refund-api/src/requests/lifecycle.routes.test.ts`
  - agent: backend-dev · backend
  - Details:
    - Gate: `submitted` → `request:set-approved-total`; `approved` → `request:reclassify`;
      `paid` → 409 `classification_locked`.
    - `SELECT … FOR UPDATE` on the request, then decide on the locked status.
    - Body takes ids only, no `null` (G8).
    - 422 `line_not_welld_ch` / inactive / unknown; 409 `line_rejected` /
      `not_classifiable_status`.
    - `line_classified` cause `review` / `post_approval`.
    - Money fields and decision untouched.
    - Withdraw clears overrides with cause `withdrawn` (D12).
  - done when: `bun test src/accounting/classification.routes.test.ts src/requests/lifecycle.routes.test.ts`
    passes:
    - the plan's AC-3.3, 3.6 (with and without `reclassify`; approved total, status and
      `decided*` unchanged), 3.7 (409) and 3.9 (422) rows;
    - an inactive entry refused, and accepted again after reactivation (AC-1.9/1.10);
    - withdraw clears overrides and audits them.

- [x] T15: refund-api — receipt numbers on the API: `RefundLineResponse.receiptNumber`, `BatchDetail…requests[].receiptNumbers`; owner key-set test — refs: AC-3.10, AC-4.6, AC-4.9 — deps: T12
  - touch: `refund-api/src/requests/requests.schemas.ts`, `refund-api/src/requests/requests.service.ts`, `refund-api/src/requests/requests.routes.test.ts`, `refund-api/src/batches/batches.schemas.ts`, `refund-api/src/batches/batches.service.ts`, `refund-api/src/batches/batches.repo.ts`, `refund-api/src/batches/batches.routes.test.ts`
  - agent: backend-dev · backend
  - done when: `bun test src/requests/requests.routes.test.ts src/batches/batches.routes.test.ts`
    passes:
    - numbers present after approval, `null` before, `null` on rejected lines;
    - the owner's line JSON key set has no `ledgerAccount*`/`vat*`/`chf` key in any status
      (AC-3.10);
    - batch requests carry `receiptNumbers` next to the employee.

- [x] T16: refund-api — receipt numbers in the batch PDF (compressed runs) and in the per-request archive PDF — refs: AC-4.9 — deps: T15
  - touch: `refund-api/src/batches/pdf.ts`, `refund-api/src/batches/pdf.test.ts`, `refund-api/src/batches/batches.service.ts`, `refund-api/src/requests/exportPdf.ts`, `refund-api/src/requests/exportPdf.test.ts`
  - agent: backend-dev · backend
  - Details:
    - `BatchPdfRequest` gains numbers; a "Receipt numbers" cell with `MC26/014–016` compression;
      still a pure function.
    - Archive: one number per line.
  - done when: `bun test src/batches/pdf.test.ts src/requests/exportPdf.test.ts` passes:
    - PDF text (`test-support/pdfText.ts`) contains the numbers;
    - consecutive runs compressed;
    - the same input renders identical bytes twice.

## Backend — export

- [ ] T17: refund-api — pure CSV: `exportFormat.ts` (dialect constants, `FORMAT_VERSION = 1`) and `export.ts` (ordering, quoting, formula guard, number formats) with a golden file — refs: AC-6.2, AC-6.3, AC-6.4, AC-6.8, AC-6.12 — deps: T3
  - touch: `refund-api/src/accounting/exportFormat.ts`, `refund-api/src/accounting/export.ts`, `refund-api/src/accounting/export.test.ts`, `refund-api/src/accounting/fixtures/*`
  - agent: backend-dev · backend
  - Details:
    - Plan § "CSV contract": BOM, CRLF, `;`, `.`, 16 columns in AC-6.2 order, English headers,
      document labels for the type.
    - Sorting by code point.
    - `'` prefix on `= + - @ TAB CR` text.
  - done when: `bun test src/accounting/export.test.ts` passes:
    - byte comparison with `fixtures/accounting-export.golden.csv` (rows of AC-6.3 `10.40;0.9246;9.62`,
      AC-6.4 `8.10;1.56`, AC-6.12 `0.00`);
    - a motivo with `;`, `"`, a newline and a leading `=` is quoted and guarded;
    - shuffled input → identical bytes.

- [ ] T18: refund-api — export routes: summary, CSV, blockers (shared schema), on-demand FX, WellD CH scope, export log, CORS exposed headers — refs: AC-4.6, AC-6.1, AC-6.5, AC-6.6, AC-6.7, AC-6.8, AC-6.9, AC-6.10, AC-6.11, AC-6.12, AC-7.2 — deps: T9, T13, T15, T17
  - touch: `refund-api/src/accounting/export.repo.ts`, `refund-api/src/accounting/export.routes.ts`, `refund-api/src/accounting/export.schemas.ts`, `refund-api/src/accounting/export.routes.test.ts`, `refund-api/src/index.ts`
  - agent: backend-dev · backend
  - Details:
    - Rows come from `RefundBatchItem`.
    - `ensureRates` runs before the blockers.
    - The 409 `accounting_export_blocked` body is the summary schema (G10).
    - `unclassifiedLines` items carry `date` and `type` (G11).
    - 403 `accounting_export_out_of_scope` unless the review scope covers `welld_ch` (D8); 409
      `batch_discarded`.
    - The log row is written before the body (500, no file, on failure).
    - Headers: `Content-Disposition`, `X-Export-*`. The CORS `exposeHeaders` change goes in
      `src/index.ts` (G9).
  - done when: `bun test src/accounting/export.routes.test.ts` passes, covering the plan's AC-6.1,
    6.5 (compile, pay and discard of the blocked batch still 2xx), 6.6, 6.7, 6.8 (equal hashes; a
    correction changes it), 6.9, 6.10 (summary writes no row), 6.11 (no review, IT scope), 6.12
    and 7.2 rows; full refund-api suite green.

- [ ] T19: refund-api — the extra tests suggested by the ADRs and the design sync — refs: AC-1.3, AC-3.6, AC-3.7, AC-5.1, AC-5.4, AC-6.5, AC-6.10 — deps: T1, T5, T9, T14, T18
  - touch: `refund-api/src/fx/months.zurich.test.ts`, `refund-api/src/lib/db.fx-fetched-once.test.ts`, `refund-api/src/accounting/classification.race.test.ts`, `refund-api/src/accounting/export.failures.test.ts`, `refund-api/src/accounting/classification.inactive-default.test.ts`
  - agent: backend-dev · backend
  - Details: plan § Test strategy "Extra tests":
    - Europe/Zurich month boundary, including the CET/CEST switches.
    - A second `fetched` row refused by the partial unique index; a second `corrected` row
      accepted.
    - Classification PUT racing approve and mark-paid (20 iterations each).
    - Failed export-log insert → 500 Problem, no CSV body, no row.
    - CORS exposes `Content-Disposition`.
    - FX budget: 3 months × 30 s delay → summary in under 11 s, three `timeout` attempts.
    - Inactive default account → `account: null`.
  - done when: `bun test src/fx/months.zurich.test.ts src/lib/db.fx-fetched-once.test.ts src/accounting/classification.race.test.ts src/accounting/export.failures.test.ts src/accounting/classification.inactive-default.test.ts`
    passes, and the full refund-api suite (`bun test`, `bun run typecheck`) is green.

## Frontend

- [ ] T20: operai-ui — `formatMonth` ("March 2026" / "marzo 2026") with test, story and changeset — refs: AC-5.2 — deps: none
  - touch: `operai-ui/src/lib/format.ts`, `operai-ui/src/lib/i18n-format.test.tsx`, `operai-ui/src/index.ts`, `operai-ui/src/foundations/Formatting.stories.tsx`, `.changeset/ui-format-month.md`
  - agent: frontend-dev · frontend
  - Details:
    - UX-10 and G7. It ships with the shell, so the shell must be live with it before refund-ui
      uses it in production (AGENTS.md rule).
    - Fallback: refund-ui shows ISO `YYYY-MM` if the export is absent.
  - done when: `mise run ui:check` passes, and the `formatMonth` cases (en/it, `2026-03`, a Date)
    pass in `i18n-format.test.tsx`.

- [ ] T21: refund-ui — typed API modules and `useLoadedResource` — refs: AC-1.1, AC-2.1, AC-3.3, AC-5.2, AC-6.1 — deps: none
  - touch: `refund-ui/src/lib/accountingApi.ts`, `refund-ui/src/lib/accountingApi.test.ts`, `refund-ui/src/lib/exchangeRatesApi.ts`, `refund-ui/src/lib/exchangeRatesApi.test.ts`, `refund-ui/src/lib/accountingExportApi.ts`, `refund-ui/src/lib/accountingExportApi.test.ts`, `refund-ui/src/lib/useLoadedResource.ts`, `refund-ui/src/lib/useLoadedResource.test.ts`, `refund-ui/src/lib/requestsApi.ts`, `refund-ui/src/lib/batchesApi.ts`, `refund-ui/src/lib/reviewApi.ts`
  - agent: frontend-dev · frontend
  - Details:
    - Shapes exactly as plan § API contracts, on `getJson`/`sendJson`. `ApiError` exposes `code`
      and the problem's extra members (`lines`, the blocked summary).
    - `downloadAccountingCsv` returns `response.blob()`, never `.text()`.
    - `receiptNumber` / `receiptNumbers` added to the existing types.
  - done when: `pnpm vitest run src/lib/accountingApi.test.ts src/lib/exchangeRatesApi.test.ts src/lib/accountingExportApi.test.ts src/lib/useLoadedResource.test.ts`
    passes (URLs, bodies, error `code` passthrough, Blob with BOM kept); `pnpm typecheck` green.

- [ ] T22: refund-ui — the whole copy catalog (en + it), status meanings, and the shared components `CatalogSelect`, `ChangeHistoryDrawer`, `ReceiptNumber` — refs: AC-1.3, AC-1.6, AC-2.1, AC-4.9 — deps: T21
  - touch: `refund-ui/src/strings.ts`, `refund-ui/src/lib/statusMeaning.ts`, `refund-ui/src/components/CatalogSelect.tsx`, `refund-ui/src/components/CatalogSelect.test.tsx`, `refund-ui/src/components/ChangeHistoryDrawer.tsx`, `refund-ui/src/components/ChangeHistoryDrawer.test.tsx`, `refund-ui/src/components/ReceiptNumber.tsx`, `refund-ui/src/components/ReceiptNumber.test.tsx`
  - agent: frontend-dev · frontend
  - Details:
    - Every key of design.md § Copy keys, in both catalogs. This is the only task that touches
      `strings.ts` (see "One copy catalog").
    - `CatalogSelect`: number-first labels; "None"/placeholder option; an inactive current value
      as a disabled selected option.
    - Status map entries `active`/`inactive`/missing rate.
  - done when: `pnpm vitest run src/components/CatalogSelect.test.tsx src/components/ChangeHistoryDrawer.test.tsx src/components/ReceiptNumber.test.tsx src/lib/noHardcodedStrings.test.ts`
    and the catalog parity test pass.

- [ ] T23: refund-ui — Settings views (General / Accounts and VAT / Exchange rates) with `?section=`/`&month=` and the two empty view hosts — refs: AC-1.7, AC-2.8, AC-5.7 — deps: T22
  - touch: `refund-ui/src/pages/SettingsPage.tsx`, `refund-ui/src/pages/SettingsPage.test.tsx`, `refund-ui/src/router.tsx`, `refund-ui/src/pages/settings/AccountingSettingsView.tsx`, `refund-ui/src/pages/settings/ExchangeRatesView.tsx`, `refund-ui/src/pages/settings/SettingsViews.test.tsx`
  - agent: frontend-dev · frontend
  - Details:
    - UX-1 and UX-9: `Tabs`; only the active view mounted; views the user cannot open left out;
      no tab list with a single view.
    - `validateSearch` for `section`/`month` on `settingsRoute`.
    - General = today's content, unchanged.
  - done when: `pnpm vitest run src/pages/SettingsPage.test.tsx src/pages/settings/SettingsViews.test.tsx`
    passes:
    - existing Settings tests unchanged;
    - without `settings:read`, no accounting or rates tab (AC-1.7/2.8/5.7 UI side);
    - `?section=exchange-rates` mounts only that view.

- [ ] T24: refund-ui — `LedgerAccountsCard`, `VatCodesCard`, add dialogs, deactivate confirm, reactivate — refs: AC-1.1, AC-1.2, AC-1.4, AC-1.5, AC-1.7, AC-1.9, AC-1.10, AC-1.11 — deps: T23
  - touch: `refund-ui/src/pages/settings/AccountingSettingsView.tsx`, `refund-ui/src/components/settings/LedgerAccountsCard*`, `refund-ui/src/components/settings/VatCodesCard*`, `refund-ui/src/components/settings/AddLedgerAccountDialog*`, `refund-ui/src/components/settings/AddVatCodeDialog*`
  - agent: frontend-dev · frontend
  - Details:
    - Design F1–F3, S2, S3, S6a, S6b, UX-3.
    - Dialogs mounted beside the card (ADR 20261118 dialog-beside-form); assert
      `form form` is empty.
    - No edit control on VAT codes.
    - Read-only without manage.
  - done when: `pnpm vitest run src/components/settings/LedgerAccountsCard.test.tsx src/components/settings/VatCodesCard.test.tsx src/components/settings/AddLedgerAccountDialog.test.tsx src/components/settings/AddVatCodeDialog.test.tsx`
    passes:
    - add → row;
    - duplicate 409 as a field error naming the number, with the "deactivated, reactivate it"
      variant;
    - no rate edit control;
    - deactivate confirm and reactivate;
    - `already_active` alert and reload;
    - write controls hidden without manage.

- [ ] T25: refund-ui — `ExpenseTypeDefaultsCard`, `DefaultClassificationDialog`, `ForeignCurrencyVatDialog`, history — refs: AC-2.1, AC-2.2, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-2.8 — deps: T24
  - touch: `refund-ui/src/pages/settings/AccountingSettingsView.tsx`, `refund-ui/src/components/settings/ExpenseTypeDefaultsCard*`, `refund-ui/src/components/settings/DefaultClassificationDialog*`, `refund-ui/src/components/settings/ForeignCurrencyVatDialog*`
  - agent: frontend-dev · frontend
  - Details:
    - Design F4, S4, S6c, S6d, UX-2.
    - Inactive saved value → "Choose…" with Save disabled.
    - The inactive-designation warning (AC-2.7).
  - done when: `pnpm vitest run src/components/settings/ExpenseTypeDefaultsCard.test.tsx src/components/settings/DefaultClassificationDialog.test.tsx src/components/settings/ForeignCurrencyVatDialog.test.tsx`
    passes:
    - 12 rows with "None";
    - only active options;
    - 422 inactive as a field error with an options reload;
    - history drawer newest first;
    - designation shown or "none";
    - the inactive warning.

- [ ] T26: refund-ui — `ExchangeRatesCard` and `RateCorrectionDialog` (auto-fetch once per visit, persistent failure banner, deep link) — refs: AC-5.2, AC-5.3, AC-5.5, AC-5.6, AC-5.7 — deps: T20, T23
  - touch: `refund-ui/src/pages/settings/ExchangeRatesView.tsx`, `refund-ui/src/components/settings/ExchangeRatesCard*`, `refund-ui/src/components/settings/RateCorrectionDialog*`
  - agent: frontend-dev · frontend
  - Details: design F8, S5, S6f, UX-10, UX-11.
  - done when: `pnpm vitest run src/components/settings/ExchangeRatesCard.test.tsx src/components/settings/RateCorrectionDialog.test.tsx`
    passes:
    - origin badges and Missing;
    - `fetchDue` triggers exactly one fetch, also after a failure, and never moves focus;
    - the failure banner persists until a success;
    - correction updates the cell;
    - Fetch now and Correct hidden without manage;
    - `&month=` focuses the row header.

- [ ] T27: refund-ui — receipt numbers on line rows, the request page and batch request rows; `ExpenseLineRow` footer slot — refs: AC-3.10, AC-4.6, AC-4.9 — deps: T22
  - touch: `refund-ui/src/components/ExpenseLineRow.tsx`, `refund-ui/src/components/ExpenseLineRow.test.tsx`, `refund-ui/src/pages/RequestDetailPage.tsx`, `refund-ui/src/pages/RequestDetailPage.test.tsx`, `refund-ui/src/components/BatchEmployeeGroupList.tsx`, `refund-ui/src/components/BatchEmployeeGroupList.test.tsx`
  - agent: frontend-dev · frontend
  - Details: design S9, UX-8: numbers in full, nothing for an unnumbered line. The footer slot is
    used by T28. The request page shows no accounting copy.
  - done when: `pnpm vitest run src/components/ExpenseLineRow.test.tsx src/pages/RequestDetailPage.test.tsx src/components/BatchEmployeeGroupList.test.tsx`
    passes:
    - number shown in each non-edit mode;
    - nothing when null;
    - batch row lists numbers and its accessible name includes them;
    - `RequestDetailPage` renders no account/VAT text.

- [ ] T28: refund-ui — `LineClassificationPanel` on the review page (selects on change, markers, amounts, states, guardrails) — refs: AC-3.1, AC-3.2, AC-3.3, AC-3.6, AC-3.7, AC-3.8, AC-3.9, AC-3.10 — deps: T27
  - touch: `refund-ui/src/components/LineClassificationPanel.tsx`, `refund-ui/src/components/LineClassificationPanel.test.tsx`, `refund-ui/src/pages/ReviewDetailPage.tsx`, `refund-ui/src/pages/ReviewDetailPage.test.tsx`
  - agent: frontend-dev · frontend
  - Details:
    - Design F5, F6, S7, UX-4, UX-13, UX-14.
    - Amounts only from the server.
    - Reload the accounting view after approved-total, reject or restore.
    - Options loaded once per page.
  - done when: `pnpm vitest run src/components/LineClassificationPanel.test.tsx src/pages/ReviewDetailPage.test.tsx`
    passes:
    - Default / Set by hand markers;
    - foreign line with the designation;
    - Rate missing → "—";
    - read-only without the capability, and locked when paid;
    - 409 `classification_locked` guardrail;
    - no panel for IT or rejected lines;
    - existing review tests green.

- [ ] T29: refund-ui — approve refusals branch on `error.code`: page-level `ErrorSummary` for `classification_missing`, in-dialog message for `accounting_release_pending` — refs: AC-3.4 — deps: T28
  - touch: `refund-ui/src/pages/ReviewDetailPage.tsx`, `refund-ui/src/pages/ReviewDetailPage.test.tsx`, `refund-ui/src/components/ApproveDialog.tsx`, `refund-ui/src/components/ApproveDialog.test.tsx`
  - agent: frontend-dev · frontend
  - Details: design S8, UX-5, G1, G2. Do not reuse `runReviewMutation`'s 409 branch.
  - done when: `pnpm vitest run src/pages/ReviewDetailPage.test.tsx src/components/ApproveDialog.test.tsx`
    passes:
    - `classification_missing`: the dialog closes, `ErrorSummary` with one link per missing value,
      focus on the first missing select, per-panel errors;
    - `accounting_release_pending` stays in the dialog;
    - `all_lines_rejected` unchanged;
    - any other 409 still shows "already decided".

- [ ] T30: refund-ui — `AccountingExportCard` on the batch page (summary, blockers as warning, download as Blob, out-of-scope note, hidden when discarded) — refs: AC-6.1, AC-6.5, AC-6.6, AC-6.7, AC-6.9, AC-6.11, AC-7.2 — deps: T22
  - touch: `refund-ui/src/components/AccountingExportCard.tsx`, `refund-ui/src/components/AccountingExportCard.test.tsx`, `refund-ui/src/pages/BatchDetailPage.tsx`, `refund-ui/src/pages/BatchDetailPage.test.tsx`
  - agent: frontend-dev · frontend
  - Details: design F9, S10, UX-6, UX-7, UX-9, UX-12, G5, G10, G12.
  - done when: `pnpm vitest run src/components/AccountingExportCard.test.tsx src/pages/BatchDetailPage.test.tsx`
    passes:
    - ready with row count and the IT count when above zero;
    - header-only copy;
    - blocked lists with a Settings link only with `settings:read`, "ask an administrator"
      otherwise;
    - Download `aria-disabled` with its reason;
    - a 409 during download switches to Blocked from the body;
    - 500 → "No file was produced";
    - out-of-scope note;
    - no card for a discarded batch;
    - filename `refund-accounting-<cutoff>-<id>.csv`.

## End-to-end

- [ ] T31: shell/e2e — settings journey: admin adds an account and a VAT code, sets a default and the foreign-currency VAT code, corrects a rate — refs: AC-1.1, AC-1.9, AC-2.1, AC-2.5, AC-5.2, AC-5.3 — deps: T2, T6, T7, T10, T11, T24, T25, T26
  - touch: `shell/e2e/refund-accounting-settings.spec.ts`, `shell/e2e/helpers/refundFixtures.ts`
  - agent: qe · e2e
  - Details:
    - Real browser, keyboard included, for one dialog confirm (ADR 20261118 dialog-beside-form).
    - Fixtures: the release marker comes from global setup (T12); `REFUND_FX_SOURCE=off` in e2e,
      rates typed by hand.
  - done when: `cd shell && pnpm e2e refund-accounting-settings` passes.

- [ ] T32: shell/e2e — accounting journey: submit CHF + EUR CH lines → review shows defaults → change a VAT code → approve → employee sees numbers → compile → export CSV parsed — refs: AC-3.1, AC-3.3, AC-3.4, AC-4.9, AC-6.1, AC-6.2, AC-6.3, AC-6.4 — deps: T12, T14, T15, T18, T27, T28, T29, T30, T31
  - touch: `shell/e2e/refund-accounting.spec.ts`, `shell/e2e/helpers/refundFixtures.ts`
  - agent: qe · e2e
  - Details: plan § Test strategy "e2e journey", plus one refused approval (a type without a
    default) showing the `ErrorSummary`. The downloaded file is read and parsed in the test
    (columns, `9.62`, `1.56`).
  - done when: `cd shell && pnpm e2e refund-accounting` passes, together with every existing
    `refund-*.spec.ts`.

## Release plumbing and docs

- [ ] T33: Changeset for refund-api, refund-ui and auth (one cross-app changeset, minor each) — refs: none (release plumbing) — deps: T18, T30
  - touch: `.changeset/refund-accounting-export.md`
  - agent: orchestrator · release
  - Details:
    - `.changeset/README.md`: one changeset selecting `@operai/refund-api`, `@operai/refund-ui`
      and `@operai/auth`.
    - The summary names the deploy order: auth first; the shell (with `formatMonth`, T20's
      changeset) before refund-ui; then `bun run accounting:release` once after refund-api is
      deployed.
    - It notes that old batch PDFs regenerate with numbers (R12).
  - done when: `pnpm exec changeset status --verbose` lists refund-api, refund-ui, auth (minor) and
    ui (from T20).

- [ ] T34: Docs — AGENTS.md, README.md, infra/README.md runbook, refund-api/.env.example — refs: none (docs) — deps: T9, T11, T18, T26
  - touch: `AGENTS.md`, `README.md`, `infra/README.md`, `refund-api/.env.example`
  - agent: orchestrator · release
  - Details:
    - AGENTS.md:
      - the `refund-api` lines (accounting/fx modules, the release script);
      - Refund domain terms (ledger account, VAT code, foreign-currency VAT code, receipt number,
        monthly average rate, accounting export);
      - the refund-ui Settings tabs.
      The 20261118 ADR entries are already listed.
    - README.md: refund-api and refund-ui rows.
    - infra/README.md:
      - the release runbook (deploy order, `accounting:release --dry-run`, then the run,
        `--offsets`);
      - outbound HTTPS to `www.backend-rates.bazg.admin.ch`;
      - `REFUND_FX_SOURCE`.
    - `.env.example`: `REFUND_FX_SOURCE`.
  - done when: `mise run env:doctor` is green and every path and command named in the new text
    exists (checked by hand in review).

## QE, security, eval

- [ ] T35: QE pass over all 61 ACs — refs: all ACs (nominal) — deps: T16, T19, T32, T33, T34
  - touch: `specs/20261118-refund-accounting-export/qe-report.md`
  - agent: qe · release
  - done when: `qe-report.md` has verdict PASS. Every AC has evidence (a named test). Green:
    refund-api `bun test` + `typecheck`, refund-ui `pnpm test` + `typecheck` + `lint`, auth
    `bun test`, `mise run ui:check`, `cd shell && pnpm e2e refund-`.

- [ ] T36: OWASP review (plan § Security, standard tier), in parallel with QE — refs: all ACs (nominal) — deps: T16, T19, T32, T33, T34
  - touch: `specs/20261118-refund-accounting-export/security-review.md`
  - agent: owasp-reviewer · release
  - Details: the eight surfaces of plan § Security. Escalate to the frontier tier only if the
    export turns out to be reachable by a non-accounting principal.
  - done when: `security-review.md` lists no open high or critical finding; any fix is a new task,
    appended to this file, with an overlap check.

- [ ] T37: Eval — refs: all ACs (nominal) — deps: T35, T36
  - touch: `specs/20261118-refund-accounting-export/eval-report.md`
  - agent: orchestrator · release
  - done when: `/wellforge:eval` produces a passing `eval-report.md`.

## Closing

- [ ] T38: All gates green; QE, security review and eval pass; spec status → done — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-1.9, AC-1.10, AC-1.11, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-2.8, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.5, AC-3.6, AC-3.7, AC-3.8, AC-3.9, AC-3.10, AC-4.1, AC-4.2, AC-4.3, AC-4.4, AC-4.5, AC-4.6, AC-4.7, AC-4.8, AC-4.9, AC-4.10, AC-5.1, AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-5.6, AC-5.7, AC-6.1, AC-6.2, AC-6.3, AC-6.4, AC-6.5, AC-6.6, AC-6.7, AC-6.8, AC-6.9, AC-6.10, AC-6.11, AC-6.12, AC-7.1, AC-7.2, AC-7.3 — deps: T37
  - touch: `specs/20261118-refund-accounting-export/spec.md`
  - agent: orchestrator · release
  - done when: `/wellforge:done 20261118-refund-accounting-export` accepts:
    - every task T1–T37 checked;
    - QE PASS;
    - no open high in the security review;
    - a fresh passing eval;
    - changesets present for refund-api, refund-ui, auth and ui.

## Owner steps (not run by an agent)

- [ ] T39: [OWNER] Accounting answers the spec's open questions and signs off the release inputs — refs: none (no AC; release prerequisite) — deps: none
  - touch: `refund-api/scripts/data/accounting-seed.welld-ch.json`, `refund-api/src/accounting/exportFormat.ts`
  - agent: owner (accounting, product)
  - Details: the questions, each with the plan decision that answers it in the meantime:
    - FX source (D10);
    - sequence offsets (D2, CSV prepared, never committed);
    - CSV dialect (D3; a change bumps `FORMAT_VERSION` and the golden file of T17);
    - seed accounts and defaults (D1);
    - post-approval capability (D5: a role edit);
    - the real foreign-currency VAT code name (D13).

    `touch:` applies only if an answer changes the seed or the dialect. Such a change is made after
    T17/T11 are merged and reruns their tests.
  - done when: each open question in `spec.md` has its answer recorded, and
    `bun run accounting:release --dry-run` against a copy of production data shows a report
    accounting accepts.

- [ ] T40: [OWNER] Release: auth, then the shell, then refund-api and refund-ui; run `accounting:release` (with `--offsets` if T39 says so) — refs: none (no AC; release) — deps: T38, T39
  - touch: `CHANGELOG.md`, `*/CHANGELOG.md`, `*/package.json`, `shell/src/lib/suiteVersion.generated.json`, `.changeset/*`
  - agent: owner
  - done when: RELEASING.md "Before" checks pass; `operai@<X.Y.Z>` is tagged; production
    `/health` reports the new refund-api version; the release script report is filed; the first
    production approval succeeds.

## Coverage

Implementing and verifying tasks per AC. Nominal references (T35, T36, T37, T38) and tasks that
serve no AC (T33, T34, T39, T40) are left out of the table.

| AC | Tasks |
| --- | --- |
| AC-1.1 | T6, T21, T24, T31 |
| AC-1.2 | T6, T24 |
| AC-1.3 | T4, T6, T13, T14, T19, T22 |
| AC-1.4 | T6, T24 |
| AC-1.5 | T1, T6, T24 |
| AC-1.6 | T4, T13, T14, T22 |
| AC-1.7 | T6, T23, T24 |
| AC-1.8 | T1, T6 |
| AC-1.9 | T6, T7, T14, T24, T31 |
| AC-1.10 | T6, T7, T14, T24 |
| AC-1.11 | T6, T24 |
| AC-2.1 | T1, T7, T21, T22, T25, T31 |
| AC-2.2 | T7, T25 |
| AC-2.3 | T12 |
| AC-2.4 | T7, T25 |
| AC-2.5 | T1, T7, T11, T25, T31 |
| AC-2.6 | T7, T25 |
| AC-2.7 | T4, T7, T13, T25 |
| AC-2.8 | T7, T23, T25 |
| AC-3.1 | T4, T13, T28, T32 |
| AC-3.2 | T4, T13, T28 |
| AC-3.3 | T14, T21, T28, T32 |
| AC-3.4 | T4, T12, T29, T32 |
| AC-3.5 | T8, T12 |
| AC-3.6 | T2, T14, T19, T28 |
| AC-3.7 | T1, T14, T19, T28 |
| AC-3.8 | T3, T13, T28 |
| AC-3.9 | T4, T12, T13, T14, T28 |
| AC-3.10 | T13, T15, T27, T28 |
| AC-4.1 | T12 |
| AC-4.2 | T3, T12 |
| AC-4.3 | T8, T12 |
| AC-4.4 | T8, T12 |
| AC-4.5 | T8, T12 |
| AC-4.6 | T12, T13, T15, T18, T27 |
| AC-4.7 | T1, T8 |
| AC-4.8 | T3 |
| AC-4.9 | T15, T16, T22, T27, T32 |
| AC-4.10 | T8, T12 |
| AC-5.1 | T5, T9, T19 |
| AC-5.2 | T10, T20, T21, T26, T31 |
| AC-5.3 | T1, T10, T26, T31 |
| AC-5.4 | T9, T10, T19 |
| AC-5.5 | T5, T10, T26 |
| AC-5.6 | T9, T10, T26 |
| AC-5.7 | T10, T23, T26 |
| AC-6.1 | T18, T21, T30, T32 |
| AC-6.2 | T17, T32 |
| AC-6.3 | T3, T17, T32 |
| AC-6.4 | T3, T17, T32 |
| AC-6.5 | T18, T19, T30 |
| AC-6.6 | T18, T30 |
| AC-6.7 | T18, T30 |
| AC-6.8 | T17, T18 |
| AC-6.9 | T18, T30 |
| AC-6.10 | T1, T18, T19 |
| AC-6.11 | T18, T30 |
| AC-6.12 | T3, T17, T18 |
| AC-7.1 | T11 |
| AC-7.2 | T11, T18, T30 |
| AC-7.3 | T11 |

**Both directions.** All 61 ACs have at least one implementing task. Four tasks serve no AC and
are flagged:

- T33 (changeset) and T34 (docs): repo convention;
- T39 [OWNER] (the open questions, a release prerequisite);
- T40 [OWNER] (the release).

T35–T38 refer to every AC nominally. Every other task has at least one AC.

## Overlap check

Effective graph = `deps:` ∪ `touch:` overlap. Globs (`*` does not cross `/`) were expanded against
each other and against the tracked files. "A → B" means A comes before B. Every overlap found, and
what was done:

**Ordered by an explicit dep (genuinely ordered):**

- `refund-api/src/index.ts` (route registry): T6, T7, T10, T13, T18. Chain T6 → T7 → T10 → T13 →
  T18, declared by deps (T10 → T13 was added for this reason only). **Registry overlap: these five
  serialize.** T18 also adds the CORS `exposeHeaders` there.
- `refund-api/src/test-support/dbCleanup.ts`: T1 (new tables), T12 (re-insert the release marker).
  T1 → T12 (via T7/T8).
- `refund-api/src/accounting/classification.repo.ts`, `classification.routes.ts`,
  `classification.schemas.ts`, `classification.routes.test.ts`: T13 creates, T14 extends. T13 → T14.
  T4's `classification.ts`/`classification.test.ts` are distinct files. T19's
  `classification.race.test.ts` and `classification.inactive-default.test.ts` are distinct files
  (no task uses a `classification.*` glob).
- `refund-api/src/batches/batches.service.ts`: T15 (detail numbers), T16 (PDF input). T15 → T16.
- `refund-api/src/lib/db.accounting-*.test.ts` (T1's glob) vs T19's `db.fx-fetched-once.test.ts`:
  the glob does not match it, because T19's file was named apart on purpose. T1 → T19 anyway.
- `refund-api/src/accounting/export*`: T17 (`export.ts`, `export.test.ts`, `exportFormat.ts`), T18
  (`export.repo.ts`, `export.routes.ts`, `export.schemas.ts`, `export.routes.test.ts`), T19
  (`export.failures.test.ts`): distinct names. T17 → T18 → T19 by dep.
- `refund-api/src/accounting/exportFormat.ts`: T17, T39 [OWNER]. T39 changes it only after T17
  is merged (stated in T39).
- `refund-api/scripts/data/*` / `accounting-seed.welld-ch.json`: T11 creates, T39 [OWNER] may edit
  afterwards. Same rule.
- `refund-ui/src/pages/ReviewDetailPage.tsx` and its test: T28, T29. T28 → T29.
- `refund-ui/src/components/ExpenseLineRow.tsx` and its test: T27 adds the number and the footer
  slot, T28 only fills the slot from `ReviewDetailPage` (it does not list `ExpenseLineRow`). T27 →
  T28 because T28 needs the slot.
- `refund-ui/src/pages/settings/AccountingSettingsView.tsx`: T23 creates the host, T24 and T25
  mount their cards in it. T23 → T24 → T25 (**mount-point overlap, serializes T24 and T25**).
- `refund-ui/src/pages/settings/ExchangeRatesView.tsx`: T23 creates, T26 fills. T23 → T26.
- `refund-ui/src/router.tsx` (router registry): T23 only. No overlap.
- `shell/e2e/helpers/refundFixtures.ts`: T31, T32. T31 → T32 (declared).
- `shell/e2e/global-setup.ts`: T12 only. No overlap. T31/T32 rely on it by dep.
- `.changeset/*` (T40's glob) vs `.changeset/ui-format-month.md` (T20) and
  `.changeset/refund-accounting-export.md` (T33): T40 consumes both. T20 → T40 and T33 → T40 hold
  through T38.
- Release-cut globs (`CHANGELOG.md`, `*/CHANGELOG.md`, `*/package.json`, the generated suite
  version) in T40 vs `refund-api/package.json` (T11): T11 → T40 through T38.
- `specs/20261118-refund-accounting-export/*` reports (T35, T36, T37) and `spec.md` (T38):
  distinct files.

**Registry overlaps removed by design:**

- `refund-ui/src/strings.ts`: only T22 touches it (all copy keys at once, from design.md § Copy
  keys). Without that, T23–T30 would all serialize on it.
- `refund-ui/src/lib/statusMeaning.ts`: T22 only.
- The OpenAPI registry `refund-api/src/openapi/registry.ts` is not touched: `OpenAPIHono` routes
  register their own schemas. A task that finds it must touch it adds the path and serializes with
  the `index.ts` chain.

**No overlap (checked):**

- auth (T2) vs everything else.
- operai-ui (T20) vs refund-ui.
- The backend and frontend tracks share no path.
- The `refund-api/src/fx/*` files of T5, T9, T10 and T19 are distinct names, and the fixtures glob
  `refund-api/src/fx/fixtures/*` belongs to T5 only.
- `refund-api/src/requests/audit.ts` belongs to T8 only. T12 and T14 call it without editing it.
- `refund-api/src/requests/lifecycle.repo.ts` belongs to T14 only.
- `refund-api/src/lib/env.ts` belongs to T9 only. T34's `.env.example` is a different file.

## Parallel batches (effective graph)

Computed on deps ∪ `touch:` overlap, earliest start, ties broken by task number. Within a batch,
no two tasks share an edge or a path.

| Batch | Backend | Frontend | E2E / release | Note |
| --- | --- | --- | --- | --- |
| B1 | T1, T2, T3, T4, T5 | T20, T21 | T39 [OWNER] | No prerequisites. T39 runs alongside and gates only T40. |
| B2 | T6, T8, T9, T17 | T22 | | |
| B3 | T7 | T23, T27, T30 | | T30 needs only the API types and copy. |
| B4 | T10, T11 | T24, T26, T28 | | T10 waits for T7 on `src/index.ts`. |
| B5 | T12 | T25, T29 | | T25 waits for T24 (mount point). |
| B6 | T13, T15 | | T31 | |
| B7 | T14, T16, T18 | | | T18 waits for T13 on `src/index.ts`. |
| B8 | T19 | | T32, T33, T34 | |
| B9 | | | T35, T36 | Security runs in parallel with QE. |
| B10 | | | T37 | |
| B11 | | | T38 | |
| B12 | | | T40 [OWNER] | |

The critical path is the backend chain T1 → T6 → T7 → T11 → T12 → T13 → T18 → T19 → T35 → T37 →
T38. The frontend finishes by B5, so it has slack and can absorb review rework.
