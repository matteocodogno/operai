---
spec: 20261118
status: approved
approved: 2026-11-18
approved_note: "approved under the user's pre-authorisation of 2026-11-18 (unattended run: 'procedi con le altre fasi … riguardo tutto domani mattina'); review on the user's return"
---

# Plan: Refund accounting — ledger accounts, VAT, receipt numbers and the batch export

Planned unattended on 2026-11-18 against the approved spec. Every open decision took the safest
option. Each one is listed with its reason under **Decisions taken unattended** at the end of this
plan, and each is kept in one place so it is cheap to change after accounting answers.

**Synced 2026-11-18 with the spec amendments of commit 6e074318** (spec § Amendments: A1
reactivation, A2 foreign-currency VAT code, two clarifications). The affected sections are the
defaults module, the release script, the data model's settings keys, the API contracts, the test
table, D4/D7/D9/D13 and the former "Spec amendments proposed" section, now "Spec amendments
applied".

**Post-approval sync with design.md (2026-11-18)**: the designer's gaps G1–G13 and decisions
UX-1..UX-14 are folded in below. The full record is the section "Post-approval sync with design.md
(2026-11-18)" near the end. Where it changes earlier wording, the earlier wording has been edited in
place.

## Architecture

### Shape in one paragraph

Everything lives in **refund-api** and **refund-ui**. The only change outside them is one new
catalog action in **auth**. refund-api gains two modules:

- `src/accounting/`: the ledger account and VAT code catalog, the default classification per expense
  type, line classification, receipt numbering, CHF/VAT amounts and the CSV export.
- `src/fx/`: monthly average exchange rates, fetched on demand from the federal source and
  correctable by an admin.

The existing approve transaction becomes the one place where a line's classification is frozen and
its receipt number assigned. The CHF amount and the VAT amount are **never stored**: they are
computed on read from the frozen classification and the rate in effect. refund-ui gains:

- three Settings cards: accounts and VAT codes, default classification, exchange rates;
- a classification panel on the review page;
- an accounting-export card on the batch page.

### Components touched / added

**refund-api: new `src/accounting/`**

| File | Role |
|---|---|
| `catalog.repo.ts` / `catalog.routes.ts` / `catalog.schemas.ts` | Ledger accounts and VAT codes. Each is an insert-only row whose identity and rate never change, with an append-only status history (deactivate/reactivate). Management routes are gated by `settings:read`/`settings:manage`. |
| `defaults.repo.ts` / `defaults.routes.ts` | The default account and VAT code per expense type for WellD CH: an append-only history, with the current value derived as the latest row (refund_setting lineage, ADR 20260722-refund-settings-append-only-self-auditing-store). Also the designated **foreign-currency VAT code** (domain term added by amendment A2; see "Foreign-currency VAT code rules" below and D4). |
| `classification.ts` (pure) | `resolveClassification(line, overrides, defaults, foreignVatCodeId)` → `{ account, accountIsDefault, vatCode, vatCodeIsDefault }`. It is the one function shared by the review view, the approve freeze, the release backfill and the export blockers, so these four places cannot disagree (the lesson of ADR 20260714-invitation-lifecycle-derived-expiry-state's "one shared helper" risk). |
| `classification.repo.ts` / `classification.routes.ts` | Accounting's line view (`GET /review/requests/{id}/accounting`), line classification change (`PUT …/lines/{lineId}/classification`) and the active-options read (`GET /accounting/options`). |
| `receiptNumber.ts` (pure) | Initials from the name or email (AC-4.2/4.8) and the number format. |
| `numbering.repo.ts` | `assignReceiptNumbers(tx, request)`: locks a per-(employee, year) counter row and numbers the lines inside the caller's transaction. |
| `amounts.ts` (pure) + `amounts-vectors.json` | `chfCents(amountCents, currency, rateMicros)` and `vatCents(chfCents, rateBasisPoints)`. Integer arithmetic (BigInt), rounded once, half-up. Golden vectors include AC-6.3 and AC-6.4. |
| `exportFormat.ts` | **Every CSV format choice in one module**: separator, decimal mark, encoding/BOM, line ending, date format, header labels, `FORMAT_VERSION`. This is the single place to change once accounting answers open question 3 (D3). |
| `export.ts` (pure) | Rows → CSV bytes: deterministic ordering, RFC 4180 quoting, formula-injection guard. |
| `export.repo.ts` / `export.routes.ts` | The export summary and the CSV download for a batch, plus the append-only export log (AC-6.10). |
| `release.ts` | The release gate: approvals are refused until the one-time release script has run (D6). |

**refund-api: new `src/fx/`**

| File | Role |
|---|---|
| `bazgSource.ts` | The outbound client. One fixed HTTPS host, no redirects, 5 s timeout per call, 512 KiB body cap, `?j=YYYY&m=MM`. The calls of one trigger run in parallel under a 10 s total budget (G6). |
| `parse.ts` (pure) | Strict extraction of `<monat>` and the `eur`/`usd`/`gbp` `<devise>` → `<waehrung>`/`<kurs>`. A document carrying `<!DOCTYPE`/`<!ENTITY` is refused. The `<monat>` echo must equal the requested month. Unit `1` or `100` is normalised to "per 1 unit". |
| `fx.repo.ts` / `fx.service.ts` | Rate in effect = the latest *corrected* entry, else the *fetched* entry. Also: which months are fetchable, the throttle, single-flight per month, and the fetch-attempt log. |
| `fx.routes.ts` | `GET /exchange-rates`, `POST /exchange-rates/fetch`, `PUT /exchange-rates/{month}/{currency}`. |

**refund-api: modified**

- `review/decide.repo.ts`, approve, inside the existing transaction:
  1. check the release gate;
  2. lock the request row (already the case through the `updateMany` CAS);
  3. resolve the classification of every non-rejected WellD CH line; if any lacks an account or a
     VAT code, throw `classification_missing` (409, the whole transaction rolls back, so no number
     is consumed);
  4. write the frozen classification (`*IsDefault` kept);
  5. number every non-rejected line, both entities (AC-4.1);
  6. write audit rows `line_classified` (cause `approval`) and `receipt_number_assigned`.
- `requests/lifecycle.repo.ts`, withdraw-to-draft: clears accounting's classification overrides of
  the lines, as it already clears rejections and mileage snapshots. One `line_classified` row is
  written per cleared line (cause `withdrawn`). An employee can then change the expense type of a
  draft line without dragging along a stale override.
- `requests/requests.schemas.ts` / `requests.service.ts`: `RefundLineResponse` gains
  `receiptNumber: string | null`, and nothing else. Accounting fields never travel on
  `GET /requests/{id}` (AC-3.10 by construction, see "Visibility" below).
- `requests/audit.ts`: two new actions, `line_classified` and `receipt_number_assigned`.
- `batches/pdf.ts`: the per-request detail table gains a "Receipt numbers" cell. It lists the
  request's numbers, with consecutive runs compressed (`MC26/014–016`). Its input
  (`BatchPdfRequest`) gains the numbers, so the renderer stays a pure function (ADR
  20260719-refund-batch-pdf-generation-pdf-lib).
- `batches/batches.service.ts` (`mapBatchDetail`): each request carries `receiptNumbers`, next to
  the employee name that is already there (AC-4.6/4.9).
- `requests/exportPdf.ts` (per-request archive): one receipt-number column per line (AC-4.9).
- `lib/env.ts`: optional `REFUND_FX_SOURCE` = `bazg` (default) | `off`. With `off`, the attempt is
  recorded as `disabled`. Used in local dev offline and in tests, where a fake source is injected.
  This is not a cross-service variable, so no env-doctor entry is needed.
- `src/index.ts`: register the routers. The export route is registered next to `batchesRouter`, and
  its paths (`/batches/{id}/accounting-export…`) do not collide with existing ones. The CORS layer
  gains `exposeHeaders: ["Content-Disposition", "X-Export-Row-Count",
  "X-Export-Excluded-Line-Count"]` (G9), so a browser on the UI's origin can read them. The UI still
  builds the filename from data on the page (UX-12) and does not depend on these headers.

**refund-api: new script** `scripts/accounting-release.ts` (`bun run accounting:release`). It is
idempotent, run once by an operator after the deploy (the D7 precedent of
specs/20260722-refund-settings), and has `--dry-run`. It runs in one transaction:

1. Seed the catalog, the 12 defaults and the foreign-currency VAT code from
   `scripts/data/accounting-seed.welld-ch.json`, only where nothing exists yet. The actor is
   `system:accounting-seed`. The designation of the foreign-currency VAT code is a
   **system-actor designation**: it is written as an ordinary `refund_setting` row (actor
   `system:accounting-seed`, email `system-accounting-seed@welld.ch`), so it appears in the
   designation history like any admin change (AC-2.5) and is protected by the same immutability
   trigger. It is written only when the key has no row yet, so a designation an admin already made
   is never overridden.
2. Optionally apply per-employee starting offsets from `--offsets <csv>`
   (`email,year,lastIssuedSeq`), only for (employee, year) pairs with no number issued yet (D2). The
   file is passed at run time and never committed, because it names employees.
3. Classify (current defaults, through the same `resolveClassification` as approval: the type's
   default account, plus the type's default VAT code for a CHF line or the foreign-currency VAT
   code for any other currency) and number (by expense date, then line `createdAt`, then `id`)
   every non-rejected WellD CH line of `approved`/`paid` requests that has no number yet. The audit
   actor is `system:accounting-release` (AC-7.1). A line left without an account or a usable VAT
   code stays unclassified, which is AC-7.2. WellD Italia lines are not touched: no number, no
   classification (AC-7.3).
4. Write the release marker: the `refund_setting` key `accounting-release-completed-at`. From that
   moment approvals are accepted again.

It prints a report: counts per employee and year, lines left unclassified, offsets applied.

**auth**

`catalogs/refund.ts` gains `request:reclassify` with `supportedConditions: ["entity",
"self-approval"]`. The self-approval condition was added by the security review sync (SR-2). `seed.ts`
grants it like `approve`, **with the same conditions object as that role's `approve` grant**:
`accounting` entity-conditioned (plus `self-approval: deny` wherever `approve` carries it),
`refund-admin` unconditioned, `admin` per its existing pattern. This is the fallback for open
question 5 (D5): accounting holds it today, and restricting it later is a role edit in admin-ui,
with no deploy.

**refund-ui**

- `pages/SettingsPage.tsx` gets **three same-page views** through `Tabs` (UX-1): **General**
  (today's mileage-rate cards and the distribution email, unchanged), **Accounts and VAT**, and
  **Exchange rates**. The active view is in the URL (`?section=general|accounting|exchange-rates`,
  plus `&month=YYYY-MM`), validated with `validateSearch` on `settingsRoute`. Only the active view is
  mounted. A view the user cannot open is left out, and with a single view no tab list is shown. Each
  card is its own component, with an API module per resource:
  - `LedgerAccountsCard` and `VatCodesCard`: list with active/inactive and who added each entry,
    an add dialog, **Deactivate** as a `ConfirmDialog` with `tone="primary"` stating the
    consequences, and **Reactivate** acting at once (UX-3). There is no edit control for a VAT rate
    (AC-1.5). No change-history view for catalog entries (AC-1.8 is audit recording; the API keeps
    `history`).
  - `ExpenseTypeDefaultsCard`: 12 rows with the default or **None**, who/when, **Change** (one
    `FormDialog` per type, two selects offering only active entries and "None", UX-2) and
    **History** (one shared history `Drawer`). The foreign-currency VAT code sits at the top of the
    card, with the same Change/History pair and the inactive warning (AC-2.7).
  - `ExchangeRatesCard`: months × EUR/USD/GBP, origin badge (fetched/corrected/missing), correction
    dialog, **Fetch now**, persistent last-fetch-failed banner (AC-5.6). When the GET says
    `fetchDue` and the user holds `settings:manage`, the view fetches **once per visit**, never
    loops, never moves focus, and reports in a polite live region (UX-11). `&month=` scrolls to the
    row and focuses its header.
  - Months are shown through a new `formatMonth` in `@operai/ui` ("March 2026" / "marzo 2026",
    UX-10), with story, test and changeset. It must be live in the shell before refund-ui uses it
    (AGENTS.md: a remote runs on the live shell's library). Fallback: ISO `YYYY-MM`.
  - Visibility follows the existing pattern: the tabs show with `settings:read`; the write controls
    need `settings:manage`; a 403 that arrives anyway hides the card (UX-9). The UI hides controls
    only; the server enforces.
- `pages/ReviewDetailPage.tsx`: a `LineClassificationPanel` per WellD CH line that is not rejected
  (no panel and no "not applicable" text for WellD Italia or rejected lines, UX-13). It has:
  - account and VAT **native `<select>`s**, labelled number first, **committed on change** (UX-4);
  - a **Default** / **Set by hand** marker in the field hint;
  - the CHF amount, the rate used or **Rate missing**, and the VAT amount, always as returned by the
    server (the browser never computes them).

  The panel is editable when the request is `submitted` (with `request:set-approved-total`) or
  `approved` and not in a paid batch (with `request:reclassify`); no confirmation dialog after
  approval (UX-14). It is read-only otherwise. The accounting view is reloaded after any
  approved-total change, reject or restore.

  **Approve refusals branch on `error.code`** (G2). The existing handler shows every 409 other than
  `all_lines_rejected` as "already decided"; that is replaced by an explicit switch:
  - `classification_missing` → the approve dialog **closes** and a **page-level `ErrorSummary`**
    lists one jump link per missing value. Focus moves to the first missing select, and each
    panel's select carries its own error (UX-5, G1). If the 409 names a line the page no longer
    has, the request and the accounting view reload first.
  - `accounting_release_pending` → a plain message **inside** the dialog, with Approve still
    available.
  - `all_lines_rejected` → unchanged.
  - any other 409 → the existing "already decided" guardrail.
- `pages/RequestDetailPage.tsx`, `ExpenseLineRow` and the batch page show receipt numbers **in
  full** on screen (UX-8); only the batch PDF compresses runs.
- `pages/RequestDetailPage.tsx` and the line rows: show `receiptNumber` only (AC-4.9, AC-3.10).
- `pages/BatchDetailPage.tsx`: receipt numbers under each request row, plus an
  `AccountingExportCard` that loads on its own without delaying the page and shows:
  - the summary: rows, and WellD Italia lines left out when above zero (AC-6.6, G12);
  - the blockers as a **warning**, not an error, with "you can still pay or discard this batch"
    (UX-6). A missing rate links to Settings at that month for holders of `settings:read`, and
    otherwise says "Ask an administrator to enter or fetch it" (G5);
  - **Download CSV** as a `secondary` button, `aria-disabled` with the reason while blocked
    (UX-7). The download uses `apiFetch` → `response.blob()` (never `.text()`, which drops the BOM)
    with a client-built filename `refund-accounting-<cutoff>-<batchId>.csv` (UX-12). A 409
    `accounting_export_blocked` switches the card to Blocked from the response body alone (G10);
  - an info note for `accounting_export_out_of_scope` (UX-9);
  - nothing at all for a `discarded` batch (AC-6.9).
- `strings.ts`: every new string in `en` and `it` (parity test); formatting through the library's
  `formatMoney`/`formatDate`/`formatNumber`.
- Before building any screen, the implementer loads `operai-ui/docs/building-pages.md` and
  `design-system.md` (AGENTS.md rule).

**shell/e2e**: `refund-accounting.spec.ts`, one end-to-end journey (see Test strategy).

### Foreign-currency VAT code rules (amendment A2: AC-2.5 to AC-2.8, AC-3.2, AC-3.4, AC-7.1, AC-7.2)

- **Storage:** the `refund_setting` key `accounting.welld_ch.foreign-currency-vat-code`, whose value
  is a VAT code id or `null` (cleared). Append-only: every designation is a row with actor and
  time, so the current designation and its history come from the same table (AC-2.5).
- **Who:** read with `settings:read`, written with `settings:manage` (AC-2.8). Only through
  `PUT /accounting/foreign-currency-vat-code`; the key is not in the generic `/settings/{key}`
  registry, so there is no second write path.
- **Only active codes:** the route refuses an unknown or inactive code with 422, and the select
  offers active codes only (AC-2.6).
- **The same rule for type defaults (G3):** a type's default **account** or default **VAT code**
  that points at a deactivated entry counts as **no default**. `resolveClassification` returns
  `account: null` (or `vatCode: null`) for that half, so AC-3.4 refuses the approval and the
  panel shows its Missing state. This is the reading of AC-1.3 ("can no longer be chosen for a new
  classification"): freezing a default at approval is a new classification. A value already
  **stored** on a line (an override, or a frozen classification) is kept even if its entry is
  later deactivated, and is returned with `active: false` (AC-1.3, AC-1.6).
- **Usable or nothing:** `resolveClassification` treats the designation as **usable** only when it
  is set **and** the code is currently active. A missing designation, a cleared one, or one that
  points at a code deactivated since is **no default VAT code** for every non-CHF WellD CH line
  (AC-2.7). Such a line shows its type's default account and no VAT code, approval is refused for
  it unless accounting classifies it (AC-3.4), and the release script leaves it unclassified
  (AC-7.2). The same "inactive = none" rule already applies to a type default pointing at an
  inactive entry. A reactivated code (AC-1.10) becomes usable again with no further step.
- **No retroactive effect:** a change of designation never touches a line already approved: its
  frozen `vatCodeId` stays (AC-2.3).
- **Visible:** the defaults card shows the code currently designated or "none", warns when the
  designated code is inactive, and lists the history (AC-2.5).

### Interaction flows

1. **Review (submitted).** Accounting opens a request. refund-ui calls `GET /requests/{id}` (same as
   today) and `GET /review/requests/{id}/accounting`. For a WellD CH line with no override, the
   server resolves the live default: the type's default account, plus the type's default VAT code
   for a CHF line or the foreign-currency VAT code for any other currency. These come back with
   `isDefault: true`. A change goes through `PUT …/classification`, which stores an override
   (`isDefault: false`) and audits it.
2. **Approve.** The existing CAS `submitted → approved` locks the request row. In the same
   transaction: classification check and freeze, numbering, audit. A missing classification rolls
   everything back with 409 and the list of lines.
3. **After approval.** `PUT …/classification` with `request:reclassify` is accepted while the request
   is `approved` (not in a batch, or in a `compiled` batch). It is refused on `paid`, at the
   application layer and by a database trigger. The approved total, the status and the decision are
   never touched by this route (AC-3.6).
4. **Export.** `GET /batches/{id}/accounting-export` (summary) collects the batch's approved,
   non-rejected WellD CH lines through `RefundBatchItem`. For any (currency, month) without a rate in
   effect, it first tries an on-demand fetch (bounded, throttled, see FX), then computes the
   blockers. `GET …/accounting-export/csv` recomputes the same, refuses with 409 if anything blocks,
   and otherwise writes the export-log row (actor, batch, row count, SHA-256, format version) and
   returns the file.
5. **FX.** There is no scheduler. A month is fetched when someone needs it: the admin's "Fetch now",
   the Settings card's `fetchDue` auto-call, or an export that finds a rate missing. ADR
   20260714-invitation-lifecycle-derived-expiry-state applies directly: a rate is only ever needed at
   the moment someone reads it. ADR 20261118-assignment-reminders-in-process-scheduler-claimed-by-cas
   does not apply, because no action toward a person has to happen while nobody reads anything. See
   ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-outbound-fetch-is-hardened.

### Visibility (AC-3.10)

Accounting data reaches the browser through **one separate endpoint**,
`GET /review/requests/{id}/accounting`. It is gated by `request:review` and the entity scope; for
anyone else it answers 404, the existing "not yours = not found" posture. `GET /requests/{id}`, which
serves both the employee and the reviewer today, gains only `receiptNumber`. So an employee who also
holds accounting capabilities still sees no account or VAT on their own request page. The rule is
enforced by the shape of the response, not by a condition that could be forgotten. An accountant
reviewing their own request is a self-approval question, already handled by ADR
20260721-self-approval-condition-and-403-exception; this plan does not change it.

### Entity scope

- Classification routes and the accounting view first use the existing request-level predicate
  (`requestInScope`, ADR 20260716-entity-scoped-abac-refund-api), the same as approve and
  set-approved-total.
- **Then a line-level rule (security review sync, SR-1).** A line's accounting data is read or
  written only when the caller's scope for the action covers **that line's** entity: global, or
  equal to `line.entity`, which in practice means `welld_ch`. The scope comes from `request:review`
  for the view, `request:set-approved-total` for a classification change while submitted, and
  `request:reclassify` once approved.
  - In the view, an uncovered line keeps its non-accounting fields but has `inScope: false`,
    `classification: null`, `chf: null` and `vatAmountCents: null`.
  - A PUT on an uncovered line answers **404**, as for a stranger.
  - `GET /accounting/options` requires a `request:review` scope covering `welld_ch`.
- The **export** additionally requires that the caller's `request:review` scope covers `welld_ch`
  (global, or entity = `welld_ch`). Otherwise it answers 403 `accounting_export_out_of_scope`. Batch
  reads stay unscoped (D1 of specs/20260719-refund-monthly-processing), but the export is WellD CH's
  books, so it is narrowed (D8).

### Existing ADRs this plan builds on

| ADR | What this plan takes from it |
|---|---|
| 20260716-immutable-financial-audit-trail-refund | DB-level immutability triggers on every new history table; the new `AuditAction` values ride the existing trigger |
| 20260719-refund-batch-audit-trail-extension | Extend `RefundAuditEntry` in place: no new mechanism for request-scoped events |
| 20260720-mileage-rate-history-self-auditing-table, 20260722-refund-settings-append-only-self-auditing-store | Config tables that are their own audit trail |
| 20260720-mileage-rate-model-snapshot-admin-ui-composition | Snapshot at a lifecycle transition (here: approval) |
| 20260720-mileage-rate-money-precision-integer-micros | Integer micros, one rounding |
| 20260714-invitation-lifecycle-derived-expiry-state | Derived on read, no cron |
| 20260719-refund-batch-pdf-generation-pdf-lib | Pure, deterministic PDF |
| 20260722-settings-catalog-permission-config-not-rate | `settings` gates refund configuration |
| 20260721-self-approval-condition-and-403-exception | Unchanged |
| 20260811-derived-projection-reuses-existing-gate-reconstructibility-test | `GET /accounting/options` reuses `request:review` |

### Trade-offs: chosen vs rejected

- **Classification is live before approval and frozen at approval** (chosen), rather than written at
  submit. The rejected option froze at submit, which would make a default changed during review
  invisible to the reviewer. AC-3.5 says "at that moment" = approval.
- **CHF and VAT amounts are derived on read** (chosen), rather than stored at approval. Stored values
  would go stale when an admin corrects a rate (AC-5.3) and would need a recompute path. Derived
  values plus AC-6.8 ("identical when nothing changed") are consistent, and the export log's
  SHA-256 makes every change visible.
- **A counter row per (employee, year), locked in the approval transaction** (chosen). Rejected:
  - `MAX(seq)+1` with an advisory lock: correct, but a hidden lock and no place for the starting
    offset;
  - a Postgres `SEQUENCE` per employee: sequences are non-transactional, so gaps on rollback would
    violate AC-4.3.
- **The export is generated on request, not stored.** Rejected: storing the CSV in the bucket. The
  file is small; generating it on demand keeps it consistent with corrections; the log keeps the
  hash.
- **FX on demand** (chosen), rather than an in-process tick (rejected: a second scheduler in the
  suite for data needed only at read time) or a Railway cron (rejected for the same reasons ADR
  20261118 gives).
- **Catalog rows are immutable with an append-only status history** (chosen). Rejected: a mutable
  `active` column plus a separate audit table, the two-write-paths shape that D1 of
  specs/20260722-refund-settings rejected.
- **A new `request:reclassify` action** (chosen), rather than reusing `set-approved-total`. It costs
  one catalog entry and an auth-first deploy order, and it buys a no-deploy answer to open
  question 5.

## Data model

One additive Prisma migration, `<ts>_accounting_export`. Never edit an existing migration. All new
history tables get the same `BEFORE UPDATE/DELETE … RAISE EXCEPTION` trigger function shape as
`mileage_rate`/`refund_setting`.

```prisma
enum AuditAction {            // + two values (ALTER TYPE … ADD VALUE)
  // …existing…
  line_classified             // lineId set; detail below
  receipt_number_assigned     // lineId set; detail below
}

enum ExchangeRateOrigin { fetched corrected }

// Immutable once inserted (trigger blocks UPDATE/DELETE). Number never reused per entity.
model LedgerAccount {
  id              String   @id @default(cuid())
  entity          Entity                    // only welld_ch accepted at the API in this spec
  number          String                    // ^[0-9]{3,6}(\.[0-9]{1,3})?$ (allows "2620.1")
  name            String                    // 1..120 chars, trimmed
  createdByUserId String
  createdByEmail  String
  createdAt       DateTime @default(now())
  statusChanges   AccountingCatalogStatus[]
  lines           RefundLine[]
  defaults        ExpenseTypeDefault[]
  @@unique([entity, number])                // AC-1.2 backstop (P2002 → 409)
  @@map("ledger_account")
}

// Immutable once inserted: the rate can never change (AC-1.5) — enforced by the trigger.
model VatCode {
  id              String   @id @default(cuid())
  entity          Entity
  code            String                    // ^[A-Z0-9_-]{1,16}$, upper-cased on input
  label           String                    // 1..80 chars
  rateBasisPoints Int                       // hundredths of a percent: 8.1 % = 810; CHECK 0..10000
  createdByUserId String
  createdByEmail  String
  createdAt       DateTime @default(now())
  statusChanges   AccountingCatalogStatus[]
  lines           RefundLine[]
  defaults        ExpenseTypeDefault[]
  @@unique([entity, code])                  // AC-1.4 backstop
  @@map("vat_code")
}

// Append-only activation history. No row = active since creation.
// Current state = latest row. CHECK (num_nonnulls("ledgerAccountId","vatCodeId") = 1).
model AccountingCatalogStatus {
  id              String         @id @default(cuid())
  ledgerAccountId String?
  ledgerAccount   LedgerAccount? @relation(fields: [ledgerAccountId], references: [id], onDelete: Restrict)
  vatCodeId       String?
  vatCode         VatCode?       @relation(fields: [vatCodeId], references: [id], onDelete: Restrict)
  active          Boolean
  createdByUserId String
  createdByEmail  String
  createdAt       DateTime       @default(now())
  @@index([ledgerAccountId, createdAt])
  @@index([vatCodeId, createdAt])
  @@map("accounting_catalog_status")
}

// Append-only default classification per (entity, type); current = latest row (AC-2.1 history).
// null = "no default" for that half.
model ExpenseTypeDefault {
  id              String         @id @default(cuid())
  entity          Entity
  type            ExpenseType
  ledgerAccountId String?
  ledgerAccount   LedgerAccount? @relation(fields: [ledgerAccountId], references: [id], onDelete: Restrict)
  vatCodeId       String?
  vatCode         VatCode?       @relation(fields: [vatCodeId], references: [id], onDelete: Restrict)
  createdByUserId String
  createdByEmail  String
  createdAt       DateTime       @default(now())
  @@index([entity, type, createdAt])
  @@map("expense_type_default")
}

// Per (employee, year-of-expense-date) counter, row-locked by the approval transaction.
// Trigger: "lastSeq" may only grow; "startAfter"/"startAfterSetBy" are immutable after insert;
// DELETE refused.
model ReceiptCounter {
  ownerUserId     String
  year            Int
  lastSeq         Int                       // highest number issued (= startAfter before the first)
  startAfter      Int      @default(0)      // D2 offset; 0 = start at 001 (spec text)
  startAfterSetBy String?                   // "system:accounting-release" when an offset was loaded
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@id([ownerUserId, year])
  @@map("receipt_counter")
}

model RefundLine {
  // …existing columns…
  // Classification — WellD CH only. Before approval: null = follow the live default; non-null =
  // accounting override. Frozen (both set) at approval for every non-rejected WellD CH line.
  ledgerAccountId        String?
  ledgerAccount          LedgerAccount? @relation(fields: [ledgerAccountId], references: [id], onDelete: Restrict)
  ledgerAccountIsDefault Boolean?
  vatCodeId              String?
  vatCode                VatCode?       @relation(fields: [vatCodeId], references: [id], onDelete: Restrict)
  vatCodeIsDefault       Boolean?
  // Receipt number — set once at approval (or by the release script), never changed (trigger).
  receiptNumber          String?        // "MC26/014"
  receiptOwnerUserId     String?        // denormalised request.ownerUserId, for the unique index
  receiptYear            Int?           // year of `date`
  receiptSeq             Int?
  numberedAt             DateTime?
  @@unique([receiptOwnerUserId, receiptYear, receiptSeq])   // AC-4.3/4.10 backstop
  @@index([ledgerAccountId])
  @@index([vatCodeId])
}

// Append-only. Effective = latest `corrected` row, else the `fetched` row.
// CHECK currency <> 'CHF'; CHECK "rateMicros" > 0; month = first day of month.
// Partial unique: CREATE UNIQUE INDEX exchange_rate_fetched_once ON exchange_rate_entry
//   (currency, month) WHERE origin = 'fetched';    -- fetched once, never overwritten
model ExchangeRateEntry {
  id              String             @id @default(cuid())
  currency        Currency                       // EUR | USD | GBP
  month           DateTime           @db.Date
  rateMicros      Int                            // CHF per 1 unit × 1e6 (0.9246 → 924600)
  origin          ExchangeRateOrigin
  sourceUrl       String?                        // fetched: the exact URL read
  sourceMonth     String?                        // fetched: the <monat> echo, e.g. "2026-03"
  fetchedAt       DateTime?                      // fetched
  createdByUserId String                         // "system:fx-fetch" | admin sub
  createdByEmail  String
  createdAt       DateTime           @default(now())
  @@index([currency, month, createdAt])
  @@map("exchange_rate_entry")
}

// Append-only log of every fetch attempt (AC-5.6 "last fetch failed, and when").
model ExchangeRateFetchAttempt {
  id              String   @id @default(cuid())
  month           DateTime @db.Date
  trigger         String                         // admin | settings_view | export
  outcome         String                         // ok | failed | not_fetchable | disabled
  errorCode       String?                        // timeout | http_<status> | parse | month_mismatch | currency_missing
  recorded        Json?                          // { EUR: 924600, … } newly recorded
  discrepancies   Json?                          // { EUR: { inEffect, sourceNow } } source differs from fetched row
  actorUserId     String
  createdAt       DateTime @default(now())
  @@index([month, createdAt])
  @@index([createdAt])
  @@map("exchange_rate_fetch_attempt")
}

// Append-only export log (AC-6.10).
model RefundBatchExport {
  id                  String      @id @default(cuid())
  batchId             String
  batch               RefundBatch @relation(fields: [batchId], references: [id], onDelete: Restrict)
  actorUserId         String
  actorEmail          String
  rowCount            Int
  excludedLineCount   Int                         // WellD Italia lines left out
  contentSha256       String
  formatVersion       Int
  createdAt           DateTime    @default(now())
  @@index([batchId, createdAt])
  @@map("refund_batch_export")
}
```

**Raw SQL in the migration, beyond the Prisma-generated DDL**

- Immutability triggers (raise) on `ledger_account`, `vat_code`, `accounting_catalog_status`,
  `expense_type_default`, `exchange_rate_entry`, `exchange_rate_fetch_attempt`, `refund_batch_export`.
- `receipt_counter` trigger: `NEW."lastSeq" > OLD."lastSeq"` on update, `startAfter*` unchanged,
  DELETE raises.
- `refund_line` trigger `refund_line_accounting_guard`, BEFORE UPDATE OR DELETE:
  - (a) once `OLD."receiptNumber"` is non-null, any change to the five receipt columns raises, and
    DELETE raises (AC-4.7);
  - (b) a change to `ledgerAccountId`/`vatCodeId`/`*IsDefault` raises when the parent
    `refund_request.status = 'paid'` **and the line already has a receipt number**
    (`OLD."receiptNumber" IS NOT NULL`). This is AC-3.7's defense in depth behind the route's 409,
    and the reason for the condition is in § Implementation sync, IS-1.
- CHECK `refund_line_receipt_all_or_none`: the five receipt columns are all set or all null.
- One shared trigger function `accounting_history_immutable()` (raises with `TG_TABLE_NAME`),
  attached by per-table UPDATE and DELETE triggers to the seven history tables.
- `receipt_counter_guard()` also freezes the key (`ownerUserId`, `year`) and lets a no-op update
  through (`lastSeq` may stay equal).
- CHECK constraints: `vat_code."rateBasisPoints" BETWEEN 0 AND 10000`; the
  `accounting_catalog_status` one-of; `exchange_rate_entry` currency ≠ CHF, rate > 0, and
  `EXTRACT(DAY FROM month) = 1`.
- The partial unique index on fetched rates.

**Settings keys (`refund_setting`, no DDL).** Both keys are written by dedicated routes or the
script, are deliberately **not** in the generic `/settings/{key}` registry, and get no second write
path:

- `accounting.welld_ch.foreign-currency-vat-code`: the VAT code id applied by default to non-CHF
  WellD CH lines (D4). Each row is one designation with its actor and time, the history of AC-2.5.
  The release seed's row has the system actor `system:accounting-seed`. A value pointing at an
  inactive code counts as no designation when resolved (AC-2.7); the row itself is never changed.
- `accounting-release-completed-at`: the release marker (D6).

**Audit `detail` shapes (RefundAuditEntry)**

- `line_classified` (`lineId` set):
  `{ cause: "review" | "post_approval" | "approval" | "release" | "withdrawn", account: { from: {id,number}|null, to: {id,number}|null, fromDefault, toDefault }, vatCode: { from: {id,code,rateBasisPoints}|null, to: …, fromDefault, toDefault } }`
- `receipt_number_assigned` (`lineId` set):
  `{ cause: "approval" | "release", receiptNumber, year, seq }`
- The actor is the verified JWT, or `system:accounting-release` / `system-accounting-release@welld.ch`
  for the script.

**Migration approach and data**

- The migration adds no data. New enum values are added by the migration but used only by
  application code and the release script, so there is no "unsafe use of new enum value" inside one
  migration transaction.
- The release script (above) is the backfill (AC-7.1).
- The seed file `scripts/data/accounting-seed.welld-ch.json` holds the draft read off the register
  (D1):

| Expense type | Default account | Default VAT code |
|---|---|---|
| `travel_km` | 5905 Spese rimborsi chilometrici (viaggi) | `NOVAT` |
| `travel_train` | 5901 Spese viaggi in treno | `IMP81` |
| `travel_other_public_transport` | 5904 Spese viaggi altri mezzi pubblici | `IMP81` |
| `travel_highway` | 5906 Spese autostrade (viaggi) | `IMP81` |
| `travel_parking` | 5907 Spese parcheggio (viaggi) | `IMP81` |
| `representation_meals` | 6701 Spese pranzi e cene con clienti | `IMP81` |
| `representation_gifts` | — (no matching account in the register) | `IMP81` |
| `office_material` | 6101 Spese materiale ufficio | `IMP81` |
| `stationery` | 6101 Spese materiale ufficio | `IMP81` |
| `company_manuals` | 6101 Spese materiale ufficio | — (books carry a reduced rate that is not in the list) |
| `postal` | 6104 Spese postali | `NOVAT` (stamps are exempt; to confirm) |
| `telephone` | 6102 Spese telefoniche, fax, internet | `IMP81` |

All 15 accounts the register uses are seeded active: 5901, 5904, 5905, 5906, 5907, 5909, 5999, 5808,
6101, 6102, 6104, 6405, 6701, 6720, 7122.

VAT codes seeded:

- `IMP81` "IVA 8.1%", 810 bp;
- `IMP77` "IVA 7.7%", 770 bp;
- `NOVAT` "Senza IVA", 0 bp. The real name of the "no VAT" code is not known (D1).

The foreign-currency VAT code is designated as `NOVAT` by the seed, as a system-actor designation
(see the release script). The code's real name is the spec's new open question; D13 gives the
fallback. A "—" in the table seeds no default, so approval of that
type is refused until accounting classifies the line (AC-3.4). That is the safe outcome where the
register gives no answer.

## API contracts

All errors are RFC 7807 with a stable `code` member. Dates are ISO 8601; months are `YYYY-MM`.
Amounts are integer cents; rates travel both as `rateMicros` (integer) and as a display string.
Every write takes the actor from the verified JWT, never the body. Bodies are capped at 4 KiB
(`bodyLimit`).

### Catalog: management (`settings:read` for GET, `settings:manage` for writes; 403 otherwise, AC-1.7)

```
GET  /accounting/ledger-accounts
  200 { items: [ { id, number, name, active,
                   createdAt, createdByEmail,
                   history: [ { active: boolean, at, byEmail } ] } ] }  // oldest → newest; first = creation (AC-1.8)
POST /accounting/ledger-accounts        { number: string, name: string }
  201 item
  409 { code:"ledger_account_duplicate", detail:"Account 5905 already exists" }   // AC-1.2, active OR deactivated (also on P2002)
  422 { code:"invalid_ledger_account", detail }
POST /accounting/ledger-accounts/{id}/deactivate    200 item | 404 | 409 { code:"already_inactive" }
POST /accounting/ledger-accounts/{id}/reactivate    200 item | 404 | 409 { code:"already_active", detail:"Account 5905 is already active" }
                                                    // AC-1.9 / AC-1.11: the 409 writes no status row (nothing audited)

GET  /accounting/vat-codes
  200 { items: [ { id, code, label, rateBasisPoints, ratePercent:"8.1", active, createdAt, createdByEmail, history } ] }
POST /accounting/vat-codes              { code: string, label: string, ratePercent: string }  // ^\d{1,3}(\.\d{1,2})?$, 0 ≤ x ≤ 100
  201 item
  409 { code:"vat_code_duplicate", detail:"VAT code IMP81 already exists" }        // AC-1.4, active OR deactivated; reactivate instead
  422 { code:"invalid_vat_code" }
POST /accounting/vat-codes/{id}/deactivate | /reactivate   (as accounts; AC-1.10 / AC-1.11)
// No PUT/PATCH on either resource exists (AC-1.5): the router answers 404 for those methods.
```

### Defaults (`settings:read` / `settings:manage`)

```
GET /accounting/expense-type-defaults
  200 { entity:"welld_ch",
        foreignCurrencyVatCode: { id, code, label, ratePercent, active } | null,   // the designation, even if inactive
        foreignCurrencyVatCodeUsable: boolean,                                       // false when null or inactive (AC-2.7)
        foreignCurrencyVatCodeHistory: [ { vatCode: {id,code}|null, at, byEmail } ], // oldest → newest (AC-2.5)
        types: [ {                                                              // always 12, enum order (AC-2.2)
          type,
          account: { id, number, name, active } | null,
          vatCode: { id, code, label, ratePercent, active } | null,
          updatedAt | null, updatedByEmail | null,
          history: [ { account|null, vatCode|null, at, byEmail } ] } ] }
PUT /accounting/expense-type-defaults/{type}     { ledgerAccountId: string|null, vatCodeId: string|null }
  200 the type row
  422 { code:"ledger_account_inactive" | "vat_code_inactive" | "unknown_ledger_account" | "unknown_vat_code" }  // AC-2.4
  // no-op (same as current) → 200, no new row
PUT /accounting/foreign-currency-vat-code        { vatCodeId: string|null }      // settings:manage (AC-2.8)
  200 { foreignCurrencyVatCode, foreignCurrencyVatCodeUsable, foreignCurrencyVatCodeHistory }
  422 { code:"vat_code_inactive" | "unknown_vat_code" }                          // AC-2.6
  // no-op (same as current) → 200, no new row
```

### Accounting (classification)

```
GET /accounting/options                          // request:review with a scope covering welld_ch (SR-1), else 403
                                                 // { code:"accounting_out_of_scope" }; active entries only (AC-1.3/1.6/2.4)
  200 { ledgerAccounts: [ { id, number, name } ], vatCodes: [ { id, code, label, ratePercent } ] }

GET /review/requests/{id}/accounting             // request:review + requestInScope; else 403 / 404
                                                 // + line-level scope (SR-1): uncovered lines carry no accounting data
  200 { requestId, status,
        batch: { id, status } | null,
        classificationState: "review" | "post_approval" | "locked" | "none",   // none = draft/rejected
        selfRestricted: boolean,         // SR-2: the caller owns the request and may not classify it
        lines: [ {
          lineId, entity, date, type, currency,
          amountCents,                     // approvedTotalCents ?? requestedAmountCents (provisional before approval)
          receiptNumber | null,
          employee: { name, email },       // AC-4.6
          rejected: boolean,               // rejected lines are returned, with classification null (G4)
          inScope: boolean,                // SR-1: false → classification, chf and vatAmountCents are null
          classification: null | {         // null for WellD Italia (AC-3.9) and for rejected lines
            account: { id, number, name, active } | null,  accountIsDefault: boolean,
            vatCode: { id, code, label, ratePercent, active } | null,  vatCodeIsDefault: boolean },
          chf: null | { amountCents: number | null, rateMicros: number | null, rate: "0.9246" | null,
                 rateMonth: "2026-03" | null, rateMissing: boolean },               // null when !inScope
          vatAmountCents: number | null   // null when CHF amount unknown or no VAT code (AC-3.8)
        } ] }

PUT /review/requests/{id}/lines/{lineId}/classification
  body { ledgerAccountId?: string, vatCodeId?: string }   // at least one key; ids only, no "back to default" (G8)
  gate: status submitted → request:set-approved-total; approved → request:reclassify (D5); both + requestInScope
        + the line-level scope of that same grant (SR-1) + segregation of duties (SR-2)
  200 the line object above (same shape)
  403 capability
  403 { code:"self_approval_forbidden" }   // SR-2: caller owns the request and is self-restricted;
                                           // checked before the 404s, as approve does
  404 out of scope (request OR line, SR-1) / unknown line
  409 { code:"classification_locked" }            // paid (AC-3.7)
  409 { code:"not_classifiable_status" }          // draft / rejected
  409 { code:"line_rejected" }
  422 { code:"line_not_welld_ch" }                // AC-3.9
  422 { code:"ledger_account_inactive" | "vat_code_inactive" | "unknown_…" }      // AC-1.3/1.6
  // Inside one transaction: SELECT … FOR UPDATE on the request row, decide on the LOCKED status,
  // write the line, write `line_classified`. Never touches approvedTotalCents/status/decided* (AC-3.6).

POST /review/requests/{id}/approve               // existing route, two new 409s
  409 { code:"classification_missing",
        lines: [ { lineId, date, type, missing: ["account"|"vatCode"] } ] }   // AC-3.4 — nothing changes; line id, date and type always present
  409 { code:"accounting_release_pending" }       // D6 gate, until the release script has run
```

### Employee-facing (unchanged except one field)

```
GET /requests/{id}   RefundLineResponse += { receiptNumber: string | null }   // nothing else (AC-3.10)
GET /batches/{id}    BatchDetail.employees[].requests[] += { receiptNumbers: string[] }
```

### Exchange rates (`settings:read` for GET, `settings:manage` for writes, AC-5.7)

```
GET /exchange-rates?from=YYYY-MM&to=YYYY-MM
  // default window: 2026-01 (FX_FIRST_MONTH) … the last COMPLETED month (Europe/Zurich),
  // plus any earlier month a non-CHF WellD CH approved/paid line needs
  200 { months: [ { month:"2026-03",
                    rates: { EUR: Rate, USD: Rate, GBP: Rate } } ],              // newest first
        lastFetch: { at, outcome, errorCode | null, month } | null,                 // AC-5.6
        fetchDue: boolean }
  Rate = { status:"missing" }                                                       // AC-5.5
       | { status:"fetched"|"corrected", rateMicros, rate:"0.9246",
           fetchedAt?, sourceUrl?, correctedAt?, correctedByEmail?,
           history: [ { origin, rate, at, byEmail } ] }                             // AC-5.2/5.3
POST /exchange-rates/fetch         { months?: ["2026-10"] }       // default: every fetchable month missing a rate
  200 { attempts: [ { month, outcome, errorCode|null, recorded } ], lastFetch }
  // a source failure is NOT an HTTP error here: 200 with outcome "failed", the attempt logged, rates untouched (AC-5.6)
PUT /exchange-rates/{month}/{currency}   { rate: string }        // ^\d{1,3}(\.\d{1,6})?$ and 0 < rate < 1000
  200 the month row
  422 { code:"invalid_rate" | "currency_not_convertible" (CHF) | "month_not_completed" }
  // 0 < rate < 1000 is binding: rateMicros is a Postgres INTEGER, which overflows above
  // 2147.483647; 1000 is also the parser's bound for a fetched rate (IS-6)
  // no-op (same as in effect) → 200, no row
```

### Export (`request:review` + scope covering `welld_ch`, AC-6.11)

```
GET /batches/{id}/accounting-export
  200 { batchId, batchStatus, exportable: boolean,
        rowCount, excludedLineCount,                                     // WellD Italia lines left out (AC-6.6)
        blockers: {
          missingRates: [ { currency, month } ],                         // AC-6.5
          unclassifiedLines: [ { lineId, requestId, date, type, employee, receiptNumber, missing:[…] } ],   // AC-7.2; date+type (G11)
          unnumberedLines:   [ { lineId, requestId, employee } ] },      // should never happen after release
        fetchAttempted: boolean }
  403 { code:"accounting_export_out_of_scope" }
  404 unknown batch
  409 { code:"batch_discarded" }                                         // AC-6.9
GET /batches/{id}/accounting-export/csv
  200 text/csv; charset=utf-8
      Content-Disposition: attachment; filename="refund-accounting-<cutoff YYYY-MM-DD>-<batchId>.csv"
      X-Export-Row-Count, X-Export-Excluded-Line-Count
      body: the CSV
  409 { code:"accounting_export_blocked", ...ExportSummary }    // the SAME schema as the summary's 200 body (G10)
  409 { code:"batch_discarded" }   403 / 404 as above
  // CORS exposes Content-Disposition and X-Export-* (G9).
  // The export-log row is written before the body is returned; if that write fails → 500, no file.
```

**CSV contract** (`exportFormat.ts`, `FORMAT_VERSION = 1`, D3)

- UTF-8 with BOM, CRLF line endings, separator `;`, decimal mark `.`, no thousands separator.
- RFC 4180 quoting: a field is quoted when it contains `;`, `"`, CR or LF, or starts/ends with a
  space; `"` is doubled.
- Text fields beginning with `= + - @ TAB CR` are prefixed with `'` (formula-injection guard).
- Header, then columns in AC-6.2 order:

| # | Header | Content |
|---|---|---|
| 1 | `Employee` | `ownerName ?? ownerEmail` |
| 2 | `Receipt number` | |
| 3 | `Expense date` | `YYYY-MM-DD` |
| 4 | `Expense type` | the document label (`document-labels.json`) |
| 5 | `Reason` | `motivo` |
| 6 | `Km` | empty unless `travel_km` |
| 7 | `Currency` | |
| 8 | `Approved total` | 2 decimals |
| 9 | `Exchange rate` | empty for CHF; up to 6 decimals, trailing zeros trimmed to at least 4: `0.9246` |
| 10 | `CHF amount` | 2 decimals |
| 11 | `Account number` | |
| 12 | `Account name` | |
| 13 | `VAT code` | |
| 14 | `VAT rate (%)` | 2 decimals: `8.10` |
| 15 | `VAT amount (CHF)` | 2 decimals |
| 16 | `Batch` | the batch id: the reference Refund shows on the batch page and in the batch PDF (AC-6.2 clarification) |

- Rows are sorted by employee name (code-point order, not locale), then `ownerUserId`, then
  `receiptYear`, then `receiptSeq`, then line id.
- There is no timestamp anywhere in the file (AC-6.8).

**Amount rules** (`amounts.ts`, one rounding each, half-up on non-negative integers)

- `chfCents = round(amountCents × rateMicros / 1_000_000)`. For CHF it is `amountCents` itself.
  Example: 1040 × 924600 / 1e6 = 961.584 → **962** (AC-6.3).
- `vatCents = round(chfCents × bp / (10_000 + bp))`. This equals `amount − amount/(1+rate)` before
  rounding. Example: 2080 × 810 / 10810 = 155.86 → **156** (AC-6.4).
- The rate used for a line is the rate in effect for (line currency, month of `line.date`).

**Receipt number rules** (`receiptNumber.ts`)

- Initials are computed from `ownerName` at numbering time:
  1. NFD-normalise and strip combining marks;
  2. split on whitespace;
  3. take the first A–Z letter of the first word and of the last word, upper-cased.
  "Matteo Codogno" → `MC`.
- If the name is null, has one word, or yields fewer than 2 letters (AC-4.8), use the email local
  part:
  - split on `.` and skip the parts with no A–Z letter; when at least two parts remain, take the
    first A–Z letter of each of the first two (`123.matteo.codogno` → `MC`, `1m.2c` → `MC`);
  - otherwise take the first two A–Z letters of the whole local part (`mcodogno` → `MC`);
  - pad with `X` if fewer than 2 letters remain (`x` → `XX`, `123` → `XX`).
- A name whose first or last word has no A–Z letter (`Matteo 123`) counts as giving no initials,
  so the email is used (IS-7).
- Number = initials + `YY` (year of the expense date) + `/` + seq padded to 3 digits. 1000 and above
  print in full.

**FX source rules** (`bazgSource.ts` / `fx.service.ts`, D10)

- URL: `https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=<YYYY>&m=<MM>`. A constant, not an
  env var (SSRF guard).
- A month is **fetchable** only from day `FX_FETCH_GRACE_DAYS = 5` of the following month
  (Europe/Zurich). See Risk R2 for why.
- One HTTP call covers EUR, USD and GBP of one month.
- Throttle: no new attempt for a month within 15 min of the previous one. Single-flight per month in
  the process. At most 6 months per trigger.
- **Parallel, with a total budget (G6):** the months of one trigger (export, admin fetch, settings
  view) are fetched in parallel. Each call has its own 5 s timeout, and the whole trigger has a
  `FX_FETCH_BUDGET_MS = 10_000` deadline (one `AbortSignal.any` of the per-call and budget
  signals). When the budget expires, unfinished calls are aborted and recorded as `failed` /
  `timeout`, while rates already received are kept. The export summary is then computed from the
  database as usual, so a slow source becomes a clean "missing rate" blocker, never a 5xx and never
  a wait above about 10 s.
- A fetched (currency, month) is recorded once and never overwritten (partial unique index,
  `ON CONFLICT DO NOTHING`). If a later fetch sees a different value, it is logged as a discrepancy
  in the fetch-attempt log only. No API field or screen shows it (G8: no AC asks for it).

## Test strategy

Levels:

- **unit**: pure modules under `bun test`.
- **int**: refund-api integration against Postgres (the existing `bun test` setup with
  `test-support/dbCleanup.ts` and `testAuth.ts`).
- **db**: direct-SQL adversarial tests in `src/lib/db.*.test.ts`.
- **ui**: refund-ui Vitest component tests.
- **e2e**: one journey in `shell/e2e/refund-accounting.spec.ts`.

The FX source is injected (fake) in every int test. A recorded fixture of the real 2026-03 response
backs the parser unit test.

| AC | Level | What proves it |
|---|---|---|
| AC-1.1 | int, ui, e2e | POST account → appears in `GET /accounting/ledger-accounts` and `/accounting/options`; usable in PUT default and PUT classification. UI: the add dialog adds a row. |
| AC-1.2 | int | Second POST with the same number → 409 `ledger_account_duplicate`, detail contains the number; same when the existing account is deactivated. Two concurrent POSTs → one 201, one 409 (P2002 mapped). |
| AC-1.3 | int, db | Deactivate → absent from options; PUT default/classification with it → 422; a line classified with it before keeps `ledgerAccountId` (read back, and still exported). |
| AC-1.4 | int | POST `IMP81` `"8.1"` → `rateBasisPoints` 810. `"-1"`, `"100.01"`, `"8.123"` → 422. `"100"` and `"0"` accepted. Duplicate code → 409, also when the existing code is deactivated. |
| AC-1.5 | int, db, ui | PUT/PATCH `/accounting/vat-codes/{id}` → 404. Raw `UPDATE vat_code SET "rateBasisPoints"` raises. The VAT card renders no edit control. |
| AC-1.6 | int | Deactivated code absent from options; PUT classification with it → 422; lines carrying it unchanged. |
| AC-1.7 | int, ui | No `settings:read` → GET 403 on accounts/VAT/defaults. No `settings:manage` → POST, deactivate, **reactivate** and PUT 403. UI: write controls hidden without manage. |
| AC-1.8 | int, db | Add/deactivate/**reactivate** rows carry actor and time; `history` shows before→after for each. Raw UPDATE/DELETE on `ledger_account`, `vat_code`, `accounting_catalog_status` raise. |
| AC-1.9 | int, ui | Deactivate an account used by a classified line, then reactivate → listed active with the same number and name, back in `/accounting/options`, accepted again by PUT default and PUT classification; the line's `ledgerAccountId` unchanged throughout. UI: the reactivate button on an inactive row. |
| AC-1.10 | int, ui | Same for a VAT code: same code, label and `rateBasisPoints`; usable again as type default, as foreign-currency VAT code (a designation pointing at it becomes `usable: true` again) and on a line; existing lines unchanged. |
| AC-1.11 | int | Reactivate an active account and an active VAT code → 409 `already_active` with the message; the count of `accounting_catalog_status` rows is unchanged. |
| AC-2.1 | int, db | PUT default twice → `history` holds both with `byEmail`/`at`; immutability of `expense_type_default`. |
| AC-2.2 | int, ui | GET returns exactly 12 types, with `null` for unset; the card shows "none". |
| AC-2.3 | int | Approve, then change the type default → the line's frozen ids unchanged. Approve a non-CHF line, then change or clear the foreign-currency VAT code → its frozen `vatCodeId` unchanged. |
| AC-2.4 | int, ui | PUT default with an inactive id → 422; the selects list only active entries. |
| AC-2.5 | int, script, ui | PUT designation twice → `foreignCurrencyVatCodeHistory` holds both with `byEmail`/`at`, the current one shown. After `accounting-release`, the history's first entry is the seed designation with actor `system:accounting-seed`; a raw UPDATE of that `refund_setting` row raises. A second release run, after an admin designated another code, leaves the admin's designation in effect. The card shows the designated code or "none". |
| AC-2.6 | int, ui | PUT with an inactive or unknown code → 422 `vat_code_inactive` / `unknown_vat_code`, no new row; the select lists only active codes. |
| AC-2.7 | unit, int | `resolveClassification` vectors: designation unset, cleared, or pointing at a deactivated code → VAT `null` for non-CHF lines, CHF lines unaffected. Int: deactivate the designated code → the accounting view of a submitted EUR line shows the default account and `vatCode: null`; approve → 409 (AC-3.4); reactivate → the default comes back. |
| AC-2.8 | int, ui | No `settings:read` → GET defaults 403; no `settings:manage` → PUT designation 403; the select is hidden without manage. |
| AC-3.1 | int, ui | Submitted CH CHF line → accounting view shows the type defaults, `*IsDefault: true`; the panel shows the "default" marker. |
| AC-3.2 | int | Submitted CH EUR line (and USD, GBP) → type default account and the designated foreign-currency VAT code, both `*IsDefault: true`; the type's own default VAT code is not used. |
| AC-3.3 | int | PUT another active account → `accountIsDefault: false`; a `line_classified` row with actor, from→to and cause `review`. |
| AC-3.4 | int, ui | Type without a default and no override → approve 409 `classification_missing` listing that line with `lineId`, `date` and `type`; request still `submitted`, no number assigned, no counter row. Same for a type whose default **account** was deactivated (G3), and for a non-CHF line when the foreign-currency VAT code is unset or inactive (`missing: ["vatCode"]`), while a CHF line of the same type approves. UI: the dialog closes, a page-level `ErrorSummary` lists the missing values, focus lands on the first missing select; `accounting_release_pending` stays in the dialog; an unrelated 409 still shows the "already decided" guardrail (branching on `error.code`, G2). |
| AC-3.5 | int | Approve → change defaults → line keeps the ids it had at approval; the `line_classified` row has cause `approval`. |
| AC-3.6 | int | Approved line (no batch, then compiled batch) + `request:reclassify` → 200 and audit `post_approval`; `approvedTotalCents`, `status`, `decided*` unchanged. Without `reclassify` → 403. |
| AC-3.7 | int, db | Request `paid` → 409 `classification_locked`; raw `UPDATE refund_line SET "vatCodeId"` on a paid request's line raises. |
| AC-3.8 | unit, int | `amounts-vectors.json` (VAT rows). Accounting view: CHF line `vatAmountCents` set; EUR line without a rate → `chf.rateMissing: true`, `vatAmountCents: null`. |
| AC-3.9 | int, ui | IT line → `classification: null`; PUT → 422 `line_not_welld_ch`; an IT-only request approves with no defaults configured (the existing approve tests stay green). |
| AC-3.10 | int, ui | For each status, the owner's `GET /requests/{id}` line JSON has no `ledgerAccount*`/`vat*`/`chf` keys (asserted on the key set); owner without review → `GET …/accounting` 404. `RequestDetailPage` renders no accounting copy. |
| AC-4.1 | int | Approve a request with one rejected line → the others numbered, the rejected one `receiptNumber: null`; IT lines numbered too. |
| AC-4.2 | unit, int | `initials("Matteo Codogno")` = `MC`; a line dated 2026 → `MC26/001`. |
| AC-4.3 | int | Three successive approvals → 001…n, contiguous. A refused approval (AC-3.4) consumes nothing. Counter `lastSeq` equals the max. |
| AC-4.4 | int | Lines created in order (03-10, 03-02, 03-02′) → 03-02, 03-02′, 03-10. Equal `createdAt` tie broken by id. |
| AC-4.5 | int | Lines dated 2025-12-30 and 2026-01-02 in one request → `XX25/001` and `XX26/001`; counters locked in year order. |
| AC-4.6 | int | Two owners both "MC" → both get `MC26/001`; accounting view, batch detail and CSV carry the employee name. |
| AC-4.7 | int, db | Reclassify, discard the batch, recompile → number unchanged. Raw UPDATE of `receiptNumber` raises; DELETE of a numbered line raises; the unique index refuses a duplicate. |
| AC-4.8 | unit | `matteo.codogno@…` → MC; `mcodogno@…` → MC; `m.c@…` → MC; name `"Cher"` → falls back to email; `x@…` → XX; diacritics `"Élise Würth"` → EW. |
| AC-4.9 | int, unit, ui | `GET /requests/{id}` and `GET /batches/{id}` carry numbers; batch PDF text (`test-support/pdfText.ts`) contains them; the archive PDF contains them; Request and Review pages render them. |
| AC-4.10 | int | Two approvals of the same owner fired with `Promise.all` → distinct, contiguous numbers; repeated 20× in a loop to shake out the race. |
| AC-5.1 | unit, int | `parse.ts` on the recorded 2026-03 fixture → EUR 924600, USD 780800, GBP 1063500, `<monat>` 2026-03. Fake source → `POST /exchange-rates/fetch` records rows with `sourceUrl`, `fetchedAt`, actor `system:fx-fetch`. |
| AC-5.2 | int, ui | GET shows the rate and `status` fetched/corrected per currency; the card shows the origin badge. |
| AC-5.3 | int, db | PUT correction → in effect; `history` keeps the fetched value; the row carries actor and time; immutability of `exchange_rate_entry`. |
| AC-5.4 | int | Correct, then fetch again with the fake source returning another value → the correction stays in effect; the discrepancy is in the fetch-attempt log, and no API field carries it. |
| AC-5.5 | int, ui | A month with no row → `{status:"missing"}`; the card shows "missing". |
| AC-5.6 | int, ui | Fake source throws / times out / returns a wrong `<monat>` → no rate row changes; `lastFetch.outcome = "failed"` with `at`; banner shown. |
| AC-5.7 | int | No `settings:manage` → PUT and POST fetch 403. |
| AC-6.1 | int | Compiled and paid batches → CSV: header plus one row per approved non-rejected CH line. |
| AC-6.2 | int, unit | Golden CSV file compared byte for byte (header, column order, quoting, BOM, CRLF). |
| AC-6.3 | unit, int | Vector 1040 EUR @ 924600 → 962; the golden CSV row reads `10.40;0.9246;9.62`. |
| AC-6.4 | unit, int | Vector 2080 @ 810 bp → 156; the golden row reads `8.10;1.56`. |
| AC-6.5 | int | Missing EUR 2026-03 → summary and CSV 409 list `{EUR, 2026-03}`; compile, mark-paid and discard of that batch still 2xx. |
| AC-6.6 | int, ui | A batch with IT lines → they are absent from the CSV; `excludedLineCount` correct; the card states the count. |
| AC-6.7 | int | Batch whose CH lines are all rejected (or that has none) → 200, header row only. |
| AC-6.8 | int | Export twice → identical bytes and SHA-256 in both log rows; after a rate correction → different hash. |
| AC-6.9 | int, ui | Discarded batch → 409 `batch_discarded` on both routes; the card is absent. |
| AC-6.10 | int, db | Download → a `refund_batch_export` row with actor, batch and time; immutability test. A summary call writes no row. |
| AC-6.11 | int | No `request:review` → 403; review scoped to `welld_it` → 403 `accounting_export_out_of_scope`. |
| AC-6.12 | int | A line approved at 0, not rejected → a row with `0.00` CHF and `0.00` VAT. |
| AC-7.1 | int (script) | Seed legacy approved/paid CH lines (no numbers), CHF and EUR → run `accounting-release` → CHF lines get the type defaults, EUR lines the type's default account and the foreign-currency VAT code; all numbered by expense date per owner and year; audit actor `system:accounting-release`. A second run changes nothing. Before the marker, approve → 409 `accounting_release_pending`. `--offsets` makes numbering start after N; an offset for an (owner, year) that already has numbers is refused. |
| AC-7.2 | int (script + export) | Legacy line whose type has no default, and a legacy EUR line released while the foreign-currency VAT code is inactive → both unclassified after release; export 409 lists them under `unclassifiedLines` with `date` and `type`; the 409 body validates against the summary schema; after PUT classification (`reclassify`) → export 200. |
| AC-7.3 | int (script + export) | Legacy approved WellD Italia lines → after `accounting-release` (and a second run): `receiptNumber` null, no classification, no audit row for them; no counter row created for them; an export of their batch leaves them out and counts them in `excludedLineCount`. An IT line approved after release is numbered (AC-4.1). |

**Extra tests (ADR writer and design sync).** These prove properties that no single AC states:

| Property | Level | What proves it |
|---|---|---|
| Month boundary in Europe/Zurich (ADR on FX fetching) | unit | `fetchableMonths(now)`: at 2026-11-04T23:30Z (= 2026-11-05 00:30 Zurich) October is fetchable, at 2026-11-04T22:30Z (= 23:30 Zurich, day 4) it is not; same around the CET/CEST switch (2026-03-29/2026-10-25). The current month is never fetchable. |
| A second fetched row for the same (currency, month) is refused | db | Raw `INSERT` of a second `origin='fetched'` row → unique violation on `exchange_rate_fetched_once`; a second `corrected` row is accepted. |
| Classification PUT racing approve / mark-paid | int | `Promise.all` of PUT classification and approve (20 iterations): either the PUT lands before the freeze (and the frozen value is the override, cause `approval`) or after it (409, or 403 without `reclassify`). Never an override written on an approved line under `set-approved-total`. Same with mark-paid: either saved before, or 409 `classification_locked`. |
| Failed export-log write → 500 and no file | int | Inject a failing `refund_batch_export` insert → the CSV route answers 500 Problem JSON, with no `text/csv` body and no log row. |
| CORS exposes the export headers (G9) | int | Preflight and GET from an allowed origin carry `Access-Control-Expose-Headers` with `Content-Disposition`. |
| FX budget (G6) | int | Fake source delaying 30 s for 3 months → the summary answers in under 11 s, with the three months as `missingRates` and three `failed`/`timeout` attempts logged. |
| Inactive default account counts as missing (G3) | unit | `resolveClassification` vector: type default pointing at an inactive account → `account: null`; a stored override on an inactive account → kept with `active: false`. |

**Mapping result: total.** Every AC of the amended spec (61: the 53 approved ones plus AC-1.9,
AC-1.10, AC-1.11, AC-2.5 to AC-2.8 and AC-7.3) maps to at least one automated test, and the rows
of the ACs the amendments reworded (AC-1.2, 1.4, 1.7, 1.8, 2.3, 3.2, 3.4, 7.1, 7.2) cover the new
wording. No AC needed a spec change to be testable.

**e2e journey** (`shell/e2e/refund-accounting.spec.ts`):

1. An admin adds an account and sets a default.
2. An employee submits a CH CHF line and a CH EUR line.
3. Accounting sees the defaults, changes one VAT code, and approves.
4. The employee sees the receipt numbers.
5. Accounting compiles a batch, downloads the export, and the test parses the CSV, checking columns
   and amounts.

Fixtures: the release marker and an EUR rate seeded through refund-api test-support.

## Risks

| # | Risk | Mitigation / early check |
|---|---|---|
| R1 | **Seed data is a draft** (open question 4). A wrong default gets frozen into legacy lines at release, and into paid ones irreversibly. | Seed lives in one JSON file. The release script has `--dry-run` printing every line's would-be classification. Running the script is a **release gate**: run only after accounting signs off the seed. Unpaid lines can still be reclassified (AC-3.6). |
| R2 | **The FX source answers for months that are not finished.** Checked 2026-11-18: `j=2026&m=03` → EUR **0.9246**, matching the register. But `m=11` (current month) and `m=12` (future) also returned values, `m=05` of 2027 returned none, and `?d=` is ignored (it returns the current month). | Only completed months plus 5 grace days are fetchable. The `<monat>` echo must equal the request. Fetched once, never overwritten; discrepancies logged. Admin correction always available. Accounting confirms the source before release (Q1 stays open on the meaning of early values). |
| R3 | **Collision with paper-era numbers** (open question 2). Numbering starts at 001 per the spec while the register already issued `MC26/081`. | `startAfter` offsets loaded by the release script before any number exists; the approval gate (D6) guarantees nothing is numbered before that. Once a number exists for (employee, year), the offset is immutable. |
| R4 | **CSV dialect wrong for the accounting system** (open question 3). | All choices in `exportFormat.ts`; `formatVersion` in the export log; a golden-file test, so a format change is one deliberate diff. |
| R5 | **Approvals blocked if the operator forgets the release script.** | Clear 409 `accounting_release_pending` message in the UI; runbook step in `infra/README.md`; the script is idempotent and safe to run again. |
| R6 | **Concurrency on numbering**: deadlock between two approvals touching two years. | Counter rows locked in ascending year order; unique index as backstop; the AC-4.10 loop test. |
| R7 | **A classification PUT racing approve or mark-paid** could store an override after the freeze, under the wrong permission. | The PUT locks the request row `FOR UPDATE` and decides on the locked status; mark-paid and approve already update that row, so they serialise. DB trigger for paid. |
| R8 | **AC-3.10 leak** through a future change that adds accounting fields to `RefundLineResponse`. | A test asserting the exact key set of the owner's line JSON. |
| R9 | **Re-export after a correction differs** from a file already imported. | Allowed by AC-6.8. The export log keeps the hash and actor per download, so accounting can see that a batch was exported twice with different content. |
| R10 | **Outbound call in the export request path** adds latency, or fails. | Only for missing rates; calls in parallel, 5 s each, 10 s total budget; at most 6 months; 15-min throttle. A failure or a budget timeout turns into an ordinary "missing rate" blocker, never a 5xx. |
| R11 | **Triggers in raw SQL** drift from `schema.prisma` (ADR 20260716 risk). | `db.*.test.ts` for every new trigger; migrations only via `migrate deploy`. |
| R12 | **Batch PDF of an old batch regenerated after a cache miss** now shows receipt numbers. | Accepted: same inputs + same code stays deterministic; the stored object is used when present. Noted in the changeset. |
| R13 | **Deploy order**: refund-api checks `request:reclassify` before auth declares it. | Deploy auth first. Until then, post-approval reclassification is 403 (fail closed); everything else works. |
| R14 | **Existing approve tests break** because of the release gate. | `test-support` helper `markAccountingReleased()` in the shared setup; done in the same task as the gate. |
| R15 | **Initials of surname-first names** (`"Codogno Matteo"` → `CM`). | Accepted (spec gives no rule). The number is still unique per employee; the name always goes with it. |

## Security

**Security-sensitive: YES.** Run the `owasp-reviewer` pass in parallel with QE, standard tier. The
data is personal and financial (employee names, expense reasons, amounts) but not a regulated
category. Escalate to the frontier tier only if the reviewer finds the export reachable by a
non-accounting principal.

Why: the feature adds:

- a bulk export of personal and financial data;
- a new authorization action and a narrowed scope;
- an outbound call to an external host whose response is parsed;
- new DB-level immutability for financial records;
- user-controlled text (motivo, names) written into a spreadsheet format.

Surfaces to review:

1. **`GET /batches/{id}/accounting-export` and `/csv`**: capability plus the `welld_ch` scope check
   (A01); no data in logs (the request logger already logs path only); filename without PII; the
   Content-Type/Disposition headers; the export log written before the body.
2. **CSV injection** in `export.ts`: the formula guard on every text cell (motivo, name, account
   name, type label), quoting of `;`/`"`/CR/LF (A03).
3. **`bazgSource.ts` / `parse.ts`**:
   - SSRF: constant host and https only, `redirect: "error"`, no user input in the URL beyond a
     validated year and month;
   - XXE and entity expansion: DOCTYPE refused, no XML library resolving entities;
   - body size cap and timeout (A10, A05, A04);
   - the parsed rate range checked (> 0, < 1000).
4. **`PUT …/classification`**: the status-dependent gate (`set-approved-total` vs `reclassify`),
   `FOR UPDATE` on the request, the IT-line refusal, no change to money fields (A01, A04); since
   the security review sync also the line-level scope (SR-1) and segregation of duties (SR-2).
5. **`GET /review/requests/{id}/accounting` vs `GET /requests/{id}`**: confirm the owner path never
   carries accounting fields (A01, AC-3.10).
6. **Management routes** (`/accounting/*`, `/exchange-rates*`): `settings:read`/`settings:manage`
   enforced server-side, actor from the JWT only, body limits, input regexes (A01, A08).
7. **Immutability**: triggers on the seven new tables, `refund_line_accounting_guard`,
   `receipt_counter` monotonicity; the direct-SQL tests (A08).
8. **`scripts/accounting-release.ts`**: the offsets CSV is read from a local path and never
   committed; the script refuses offsets for pairs that already have numbers; its system actor is
   documented.

## Decisions taken unattended

Each decision is the safest option available on 2026-11-18. "Change" says what it takes to reverse
it.

| # | Decision | Why | Change |
|---|---|---|---|
| **D1** | **Seed** (open question 4): 15 accounts, `IMP81`/`IMP77`/`NOVAT`, and the type mapping in § Data model. `representation_gifts` gets no default account and `company_manuals` no default VAT code. | Where the register gives no answer, approval asks a human (AC-3.4) instead of booking silently. `NOVAT` is a placeholder name for the register's unnamed "no VAT" code. | Edit `scripts/data/accounting-seed.welld-ch.json` before release, or change in Settings afterwards. |
| **D2** | **Sequence offset** (open question 2): numbering starts at **001** as the spec says. Per-(employee, year) offsets can be loaded once, before any number exists, by `accounting:release --offsets file.csv`. | Follows the spec text, keeps the paper-era fix available, and never renumbers anything. | Supply the CSV at release; no code change. |
| **D3** | **CSV dialect** (open question 3): UTF-8 with BOM, `;`, `.` decimal, CRLF, ISO dates, English headers and expense-type labels, `formatVersion 1`. | `;` + BOM opens correctly in Excel/Numbers under CH and IT locales; `.` is the Swiss decimal mark and cannot clash with `;`; English matches the 2026-09-08 documents decision (`labels.ts`). | Constants in `exportFormat.ts`; bump `FORMAT_VERSION`. |
| **D4** | **Foreign-currency VAT code** (now spec domain term, amendment A2) is stored as an append-only `refund_setting` key with its own route, history and admin-only gate. Unset, cleared or inactive → no default VAT code for non-CHF lines → approval asks (AC-2.7). | The spec names one code for all foreign currencies; the self-auditing store gives AC-2.5's history for free; "inactive = none" is the safe reading and matches how type defaults are resolved. | Settings UI. |
| **D5** | **Post-approval reclassification** (open question 5): a new `request:reclassify` action, granted to the same holders as `approve` **with the same conditions, `self-approval` included** (amended by SR-2). | Behaviour equals the spec today; restricting it later is a role edit with no deploy; segregation of duties follows approve's. | admin-ui role grants. |
| **D6** | **Release gate**: approvals are refused (409 `accounting_release_pending`) until `accounting:release` has run. | Guarantees legacy lines are numbered first and in expense-date order, and that offsets can still be applied. No ordering hazard between deploy and backfill. | Remove the gate check once released (it is one `refund_setting` read). |
| **D7** | **IT legacy lines are not numbered** by the release script; IT lines approved after release are (AC-4.1 applies to every line). Now spec text: AC-7.3 and a Non-goal. | AC-7.1 scopes the backfill to WellD CH. | — (specified) |
| **D8** | **Export needs WellD CH review scope**, not just the capability. | The file is WellD CH's books; a WellD Italia-scoped accountant has no business exporting it. | One check in `export.routes.ts`. |
| **D9** | **Reactivation** of an account or VAT code (amendment A1, now AC-1.9 to AC-1.11): an append-only status row `active: true`; reactivating an active entry is a 409 that writes nothing. | Without it, deactivating `IMP81` by mistake is unrecoverable, because AC-1.4 refuses re-adding the same code. | — (specified) |
| **D10** | **FX source**: the federal monthly averages of the BAZG (the Federal Office for Customs and Border Security, which publishes the monthly averages the ESTV/AFC refers to). Its XML endpoint returned the register's EUR 0.9246 for March 2026. Fetched **on demand** (admin, settings view, export), never by a scheduler; completed months + 5 days only; fetched once, never overwritten; corrections win. | Verified against the register value; no new scheduler (ADR 20260714 posture); a rate cannot change under a file already exported without a visible admin action. | `bazgSource.ts` URL constant and `FX_FETCH_GRACE_DAYS`. |
| **D11** | **Pre-approval VAT/CHF display** uses `approvedTotal ?? requestedAmount`. | Approve defaults untouched lines to the requested amount, so that is the figure that will be booked. | `classification.repo.ts`. |
| **D12** | **Withdraw-to-draft clears classification overrides** (audited, cause `withdrawn`). | The employee may change the line's type in draft; a stale override would survive silently otherwise. | `lifecycle.repo.ts`. |
| **D13** | **Real name of the foreign-currency VAT code** (the spec's new open question). Fallback: the seed creates `NOVAT` "Senza IVA" at 0 % and designates it as a system-actor designation. Before release, accounting's answer is one edit of the code string in `accounting-seed.welld-ch.json`; `--dry-run` prints the code that will be designated. After release, an admin adds the real code, designates it (AC-2.5) and deactivates `NOVAT`; lines already approved keep `NOVAT` (AC-2.3) and unpaid ones can be reclassified (AC-3.6). | The rate (0 %) is known, only the name is not; a designated placeholder keeps foreign-currency lines approvable and exportable, while every step to the real code is audited and needs no deploy. The stricter alternative, seeding no designation, would block every non-CHF approval and the release backfill of EUR lines until accounting answers. | Seed JSON before release; Settings after. |

## Spec amendments applied

Applied by the product owner on 2026-11-18 in commit 6e074318 (spec § Amendments). The plan
above is synced with them:

- **A1, reactivation:** AC-1.9 to AC-1.11; AC-1.2, AC-1.4, AC-1.7 and AC-1.8 adjusted; Non-goal
  "editing or deleting a ledger account or VAT code". Planned as D9 (routes, status rows, UI
  button, tests).
- **A2, foreign-currency VAT code:** domain term; AC-2.5 to AC-2.8; AC-2.3, AC-3.2, AC-3.4,
  AC-7.1 and AC-7.2 adjusted; Non-goal "a different VAT code per foreign currency"; new open
  question on the code designated at release. Planned as D4 and D13, with the rules in
  § Architecture "Foreign-currency VAT code rules".
- **Clarification, batch identifier:** AC-6.2's batch identifier is the batch id, which is the
  reference Refund shows on the batch page and in the batch PDF (CSV column 16).
- **Clarification, pre-release WellD Italia lines:** AC-7.3 and a Non-goal. Planned as D7.

Still a plan-level reading, not spec text: AC-6.11's capability is `request:review` (the compile
gate), narrowed to WellD CH scope (D8). No further amendment is proposed.

## Security review sync (2026-11-19)

`security-review.md` (T36, commit b81b1eb8) reports 0 critical, 0 high, 2 medium, 6 low and 3 info
findings. The recommended option is taken for each, unattended. Status stays `approved`: no AC
changes. The two mediums tighten access within what the spec already asks (AC-3.3, AC-3.6, D8).

| # | Finding | Decision |
|---|---|---|
| SR-1 | **S-01 (medium)**: entity scope is checked per request ("any line matches"), so a `welld_it`-scoped reviewer can read and change the WellD CH line of a mixed request. | **Line-level scope** (§ Entity scope, API contracts). Accounting data of a line is read or written only when the caller's scope for that action is global or equal to the line's entity. A PUT on an uncovered line → 404. In the view, an uncovered line has `inScope: false` and no accounting data. `GET /accounting/options` needs a scope covering `welld_ch`. Approval stays request-level (ADR 20260716-entity-scoped-abac-refund-api, unchanged). A `welld_it`-scoped approver who gets `classification_missing` for a CH line needs a WellD CH colleague to classify it; the 409 shows only line id, date and type, which `GET /requests/{id}` already shows them. |
| SR-2 | **S-02 (medium)**: `request:reclassify` has no self-approval condition, so an accountant can change the booking of their own request after a colleague approves it, and before that through `set-approved-total`. | **Segregation of duties, the same as approve.** <br>• **auth (T2 contract amended):** `reclassify` declares `supportedConditions: ["entity", "self-approval"]`, and the seed grants it with the same conditions object as the role's `approve` grant. <br>• **refund-api, after approval:** when the caller's `reclassify` grant carries `self-approval: deny` (`approveSelfRestricted`) and the caller owns the request → 403 `self_approval_forbidden`. <br>• **refund-api, while submitted:** the same 403 when the caller's **`approve`** grant is self-restricted and the caller owns the request. Whoever may not approve their own request may not shape its booking. `set-approved-total` itself stays unconditioned (specs/20260721-self-approval-control D3). <br>• **Order:** the check runs before the scope 404s, as approve does. It is logged at info level (actor id, request id, no personal data). <br>• **View:** `selfRestricted: true`, so the panel is read-only with its own copy. <br>• **Seed:** if a deployment has no `self-approval` condition on `approve`, there is none on `reclassify` either. The policy is the same knob. |
| SR-3 | S-03 (low): nothing stops the offsets CSV (employee emails) from being committed. | **Fix.** `.gitignore` gains `**/*offsets*.csv` and `**/accounting-offsets*`. `accounting-release` prints a warning when the `--offsets` path resolves inside a git worktree. The runbook says the file lives outside the repository. |
| SR-4 | S-04 (low): the release script prints employee emails, and in `--dry-run` per-line financial data, to stdout. | **Fix.** The report identifies an employee as `<initials> · <first 8 chars of the user id>`. Full emails only with an explicit `--show-emails` flag. Error messages mask the email (`m***@welld.ch`). Runbook: run only from an operator shell, never from CI or a job whose output is shipped to a log service. |
| SR-5 | S-06 (low): the summary and the 409 blocked body set no cache header. | **Fix.** `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff` on the summary 200 and on the `accounting_export_blocked` 409, as the CSV already has. |
| SR-6 | S-05 (low): the summary is not logged, and the export-log row has no request id or IP. | **Accepted.** AC-6.10 logs downloads, and the summary shows nothing the batch page does not. **Follow-up FU-S1:** a request id (and optionally the client IP) on `refund_batch_export`; this needs a migration. |
| SR-7 | S-07 (low): a plausible but wrong fetched rate stays in effect until an admin notices. | **Accepted for this release.** The source was verified against the register (D10), the parser is strict, and corrections always win. **Follow-up FU-S2:** a plausibility band against the previous month (for example ±25 %, failing as `implausible`), which changes what AC-5.1 records and so needs accounting's agreement; and showing discrepancies in Settings (design follow-up F3). |
| SR-8 | S-08 (low): immutability is by row triggers only (TRUNCATE and DISABLE TRIGGER remain to the table owner); no DB rule keeps classification off `welld_it` lines. | **Accepted, follow-up.** <br>• This is the suite-wide posture of every Tier 1 table (ADR 20260716-immutable-financial-audit-trail-refund): the service connects as the owner today. <br>• **FU-S3 (infra, all services):** a non-owner runtime role without TRUNCATE/ALTER, owner credentials for migrations only. <br>• **FU-S4:** a CHECK that `ledgerAccountId`/`vatCodeId` are NULL when `entity <> 'welld_ch'`, in the next refund-api migration. The route already refuses it (422 `line_not_welld_ch`), and IS-1 shows such a write books nothing. |
| SR-9 | S-09 (info): the fetch-attempt `trigger` is client-supplied. | **Accepted, follow-up FU-S5:** derive it server-side. The permission (`settings:manage`) and the actor (JWT) are already server-side, so only the label is the caller's claim. |
| SR-10 | S-10 (info): the formula guard does not cover a leading LF or a trigger after leading whitespace. | **Accepted, follow-up FU-S6:** add `\n` and a whitespace-trimmed check to `FORMULA_TRIGGERS`, with a golden-file case. Excel does not evaluate those today. |
| — | S-11 (info): AC-3.10 verified OK. | Nothing to do. |

**Fix list for development** (the S-01, S-02, S-03, S-04 and S-06 fixes, each with its test):

1. **refund-api `src/accounting/classification.repo.ts` / `classification.routes.ts` (SR-1):**
   - add the line-level check `scope === GLOBAL_ENTITY_SCOPE || scope === line.entity` after the
     line lookup in `classifyLine` (404 otherwise), using the scope of the grant that gates the
     status;
   - in the view, `inScope` plus nulling of the accounting fields for uncovered lines;
   - `GET /accounting/options` requires a `welld_ch`-covering review scope (403
     `accounting_out_of_scope`).

   Tests: a `welld_it`-scoped caller on a mixed request → PUT on the CH line 404 (submitted and
   approved); the view shows the CH line with `inScope: false` and no account/VAT/CHF; options →
   403; a global caller is unchanged.
2. **auth `catalogs/refund.ts`, `seed.ts` + tests (SR-2):** `reclassify` with
   `supportedConditions: ["entity","self-approval"]`, seeded with the role's `approve` conditions.
3. **refund-api `classification.repo.ts` / `classification.routes.ts` (SR-2):**
   - the self-restriction check, run before the scope checks: `reclassify` grant for an approved
     request, `approve` grant for a submitted one; owner → 403 `self_approval_forbidden` with an
     info log;
   - `selfRestricted` in the view.

   Tests: owner with a self-restricted grant → 403 in both states; owner without the restriction
   → 200; a non-owner → 200.
4. **refund-ui `LineClassificationPanel` / `ReviewDetailPage` (SR-1, SR-2):**
   - read-only with a short note when `selfRestricted`;
   - no panel content for `inScope: false` lines (same as a WellD Italia line);
   - map 403 `self_approval_forbidden` to that note;
   - new copy in `strings.ts` (en + it).
5. **`.gitignore` + `scripts/accounting-release.ts` (SR-3, SR-4):**
   - the ignore patterns;
   - the warning for an offsets path inside the worktree;
   - masked employee references, `--show-emails`, masked emails in errors.

   Tests: the report contains no `@` without `--show-emails`; a path inside the repo prints the
   warning.
6. **refund-api `export.routes.ts` (SR-5):** `no-store` + `nosniff` on the summary and the blocked
   409. Test: both headers on both responses.
7. **`infra/README.md` runbook (SR-3, SR-4):** the offsets file stays outside the repository; the
   script runs from an operator shell only.

Follow-ups not planned (FU-S1 to FU-S6) are listed in the table above.

## Implementation sync (2026-11-19)

T1 (commit 352c6747, `refund-api/prisma/migrations/20261119090000_accounting_export/migration.sql`)
and T3 differ from the plan's wording in seven points. All seven are accepted; the plan text above
is edited in place, and the receipt-numbers and classification ADRs of 20261118 are amended to
match. Status stays `approved`.

| # | Drift | Decision |
|---|---|---|
| IS-1 | `refund_line_accounting_guard` locks a paid request's line classification **only when the line has a receipt number**. | **Accepted.** Reason: the release backfill (T11, AC-7.1) has to classify legacy lines of requests that were already paid. After the release, every non-rejected line is numbered in the same approval transaction that freezes its classification, so every post-release paid line is locked. No hole was found; see the details after this table. |
| IS-2 | CHECK `refund_line_receipt_all_or_none` (five receipt columns all set or all null). | Accepted; added to § Data model. It closes a partial write that the trigger alone would not catch. |
| IS-3 | `receipt_counter_guard()` also freezes `ownerUserId`/`year`, and allows a no-op update. | Accepted. A key change would move a sequence to another person or year. A no-op update is harmless and keeps upserts simple. |
| IS-4 | One shared function `accounting_history_immutable()`, with per-table triggers. | Accepted. The behaviour is the same as one function per table. The error names the table through `TG_TABLE_NAME`. |
| IS-5 | Month CHECK as `EXTRACT(DAY FROM month) = 1`. | Accepted. It is equivalent for a `date` column, and is IMMUTABLE-safe. |
| IS-6 | Rate correction input must be `0 < rate < 1000`. | **Binding for T10.** `rateMicros` is an INTEGER, which overflows above 2147.483647. 1000 matches the parser's range for fetched rates (T5). Contract updated (`PUT /exchange-rates/{month}/{currency}`): the regex allows up to 3 integer digits, and the bound is checked as well, so `999.999999` is accepted and `1000` is refused with 422 `invalid_rate`. T10's tests must include both. |
| IS-7 | Email initials skip local-part segments with no letter; a name word with no letter sends the rule to the email. | Accepted, and stated in "Receipt number rules". It is the reading of AC-4.8 that never yields a non-letter initial. |

IS-1 in detail:

- **Required order of writes.** `classifyAndNumber` (T8) writes the classification **before or in
  the same statement as** the receipt number, so on a paid legacy line the guard sees
  `OLD."receiptNumber" IS NULL`. Writing the number first, and classifying afterwards in a second
  statement, would be refused. T8 and T11 keep the order, and T11's test classifies a legacy line
  of a paid request.
- **What remains unlocked at the database.** Two kinds of line on a paid request:
  - pre-release WellD Italia lines, which are never numbered (AC-7.3);
  - rejected lines.

  Neither is ever classified by the application (422 `line_not_welld_ch`, 409 `line_rejected`),
  and the export excludes both. A raw-SQL write to them changes nothing that is booked.
- **A consequence that is not caused by the drift.** A legacy WellD CH line of an already paid
  request that the release leaves **unclassified** (its type had no usable default, AC-7.2) is
  numbered by the release and is then locked by AC-3.7 for good. Its old paid batch can never be
  exported. This follows from the spec (AC-3.6 allows reclassification only while unpaid) and
  would hold with the original guard too.
  - Mitigation: T39's `--dry-run` lists these lines. Accounting either sets defaults for every
    type before the release run, or accepts it: those batches predate the feature and are already
    in the hand register.
  - Opening paid legacy lines to classification would need a spec amendment, so it is not planned.

## Post-approval sync with design.md (2026-11-18)

design.md (same folder) found 13 gaps and took 14 UX decisions. The recommended option was taken
for each one, unattended. The plan's status stays `approved`, because nothing here adds scope:
gaps that would need a new AC are listed as follow-ups.

| Gap | Taken | Where in this plan |
|---|---|---|
| G1 | The `classification_missing` refusal is a **page-level `ErrorSummary`** (the dialog closes), not a list inside the approve dialog. This deviates from the plan's earlier wording, which has been aligned. `accounting_release_pending` stays in the dialog. | refund-ui § ReviewDetailPage |
| G2 | Approve 409s **branch on `error.code`**; tested. | refund-ui § ReviewDetailPage; AC-3.4 row |
| G3 | A **deactivated default account counts as missing** (like an inactive VAT code); stored values keep `active: false`. | § Foreign-currency VAT code rules; extra tests |
| G4 | Rejected lines are returned by the accounting view with `rejected: true` and `classification: null`; no panel. | API § Accounting |
| G5 | Exchange rates stay behind `settings:read`/`settings:manage`. The export blocker tells non-admin accounting users to ask an administrator. Giving accounting the rates is a role grant in admin-ui, no deploy; a product follow-up (F2), not decided here. | refund-ui § BatchDetailPage |
| G6 | Fetches of one trigger run **in parallel** under a **10 s total budget**; a timeout ends as a clean missing-rate blocker. | FX source rules; R10; extra tests |
| G7 | `formatMonth` added to `@operai/ui` (fallback `YYYY-MM`); shell first. | refund-ui § Settings |
| G8 | The `null` ("back to default") branch of the classification PUT and the `sourceDiscrepancy` API field are **dropped**: no AC asks for them. Discrepancies stay in the fetch-attempt log. | API; FX rules; AC-5.4 row |
| G9 | refund-api **exposes** `Content-Disposition` and `X-Export-*` through CORS; the UI does not depend on them. | refund-api § index.ts; extra tests |
| G10 | The `accounting_export_blocked` 409 body **is** the summary schema (one shared zod schema). | API § Export; AC-7.2 row |
| G11 | `unclassifiedLines` items carry `date` and `type`; the approve 409 items already carry line id, date and type. | API |
| G12 | The WellD Italia count is stated **only when above zero**. The API always returns it, and AC-6.6's test covers a non-zero count. Showing "0 left out" is one copy line if the user wants it. | refund-ui § BatchDetailPage |
| G13 | `BatchPdfLink`'s emoji icon is untouched: out of scope (follow-up F6). | — |

| UX | Taken as designed |
|---|---|
| UX-1 | Settings tabs General / Accounts and VAT / Exchange rates, view in the URL, only the active view mounted |
| UX-2 | One `FormDialog` per expense type for defaults |
| UX-3 | Deactivate = primary-tone confirm; Reactivate at once |
| UX-4 | Native selects, number first, commit on change |
| UX-5 | `ErrorSummary` for `classification_missing` (G1) |
| UX-6 | Missing rate is a warning blocker, not an error |
| UX-7 | Download is `secondary`, `aria-disabled` with its reason while blocked |
| UX-8 | Receipt numbers in full on screen; compressed only in the PDF |
| UX-9 | Sections without a capability are left out; the export's out-of-scope note is the exception |
| UX-10 | `formatMonth` (G7) |
| UX-11 | Auto-fetch once per visit, no loop, no focus move, persistent failure banner |
| UX-12 | CSV via `response.blob()`, client-built filename |
| UX-13 | No panel for WellD Italia or rejected lines |
| UX-14 | No confirmation for post-approval reclassification |

**Not-in-scope follow-ups.** Each would need a new AC, so none is planned:

- **F1:** "back to default" on a classified line.
- **F2:** exchange rates readable and correctable by accounting users who are not admins (the role
  grant `settings:read`/`settings:manage`, or a narrower permission). This is a product question,
  alongside open question 5.
- **F3:** showing the source discrepancy of a fetched rate to the admin.
- **F4:** a "N lines still need an account" notice before Approve is pressed.
- **F5:** a re-export hint on a compiled batch after a post-approval change (R9).
- **F6:** replacing `BatchPdfLink`'s emoji icon (INC-31).
- **F7:** a change-history view for accounts and VAT codes (the API already returns `history`).
- **F8:** an AC of its own for **Fetch now** and the `fetchDue` auto-fetch. They are planned and
  designed anyway, because without them no admin could reach AC-5.1 and AC-5.6.

## ADRs written

Written 2026-11-18 from the former candidates (status Accepted under the same pre-authorisation
as this plan; review on the owner's return). Each carries a `## Failure shape` section.

1. **20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-outbound-fetch-is-hardened**: external reference data is fetched on
   demand by the service that needs it, never by a scheduler (monthly FX rates from BAZG, recorded
   once, corrections win). It extends ADR 20260714-invitation-lifecycle-derived-expiry-state to
   external data and draws the line against ADR
   20261118-assignment-reminders-in-process-scheduler-claimed-by-cas: a schedule only for actions
   toward people. It also sets the outbound-fetch hardening rules (fixed host, no redirects, size
   cap, no entity resolution).
2. **20261118-receipt-numbers-come-from-a-row-locked-per-employee-and-year-counter-inside-the-approval-transaction-and-are-immutable-in-the-database**: covers the trigger on `refund_line`, the
   monotonic counter, the one-time starting offset and the release gate. It constrains every future
   numbering in the suite (offers already use `NNNN/YYYY`; this is the per-person variant).
3. **20261118-accounting-classification-is-live-until-approval-then-frozen-and-changing-it-afterwards-needs-request-reclassify-and-is-refused-by-the-database-once-paid**: extends the
   snapshot-at-transition pattern of ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition.
4. **20261118-chf-and-vat-amounts-are-derived-on-read-from-integer-micros-and-basis-points-rounded-once-half-up-and-never-stored**: extends ADR
   20260720-mileage-rate-money-precision-integer-micros to FX and VAT.
5. **20261118-the-accounting-export-is-generated-on-request-never-stored-and-logged-append-only-with-its-content-hash-and-format-version**: also covers the CSV
   dialect and injection guard as the suite's CSV convention. The dialect values stay provisional
   until accounting answers open question 3 (D3).

The catalog tables, the defaults history and the export log reuse the self-auditing and
immutability pattern unchanged (ADR 20260716/0024/0028). That reuse needs no ADR of its own.
