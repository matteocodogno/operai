---
spec: 20261118
task: T35
date: 2026-11-19
verdict: PASS
tested: 6094b486 after fix round 1 (first pass: FAIL at e7cf2ad9) (branch feat/refund-accounting-spec) plus the two test files this pass added
---

# QE report: refund accounting export

## QE verdict: PASS (after fix round 1; the first pass at e7cf2ad9 was FAIL, kept below)

See "Re-test after fix round 1" at the end. The live e2e journeys (T31, T32) remain an owner step.

All 61 acceptance criteria have executed evidence and every gate the repo has is green. The verdict is FAIL because
the code does not yet match the plan at the commit tested (security-review sync SR-1 and SR-2, confirmed by repro
below) and the release script prints a misleading line in `--dry-run`. None of these changes an AC outcome. The three
open defects are small and already have a fix list in plan.md § Security review sync; after that fix round, re-run
this pass on the delta (see "Re-test scope").

How this was run: unattended, in the worktree `repos/operai-expense-analysis`, against the isolated Postgres
container on :5445 only (databases `refund`, `auth`, and a scratch `refund_qe` for the from-zero migration check). No
dev/e2e stack, no Railway, no real secrets.

**What was NOT possible, and what that costs:**

- **Exploratory testing with Playwright against a running app was not possible** (it needs the e2e stack on the
  shared dev Postgres and 1Password secrets). Keyboard-only navigation, focus order, contrast and screen-reader
  behaviour were therefore verified only through the component tests (role, name, `aria-*` and focus assertions in
  React Testing Library), not in a real browser. No automated axe check exists in refund-ui.
- **The live e2e run (T31, T32) is an owner step.** `cd shell && pnpm e2e refund-` is PENDING. It is not counted as a
  failure (the caller pre-authorised this), but T35's own done-when lists it, so it must be run before T38.
  `playwright test --list` lists both journeys (222 tests in 51 files), and the e2e files type-check and lint clean.

## Verdict table

| Check | Threshold | Actual | Result |
|---|---|---|---|
| AC coverage | 61/61 with a named, executed test | 61/61 (matrix below) | ✓ |
| AC-4.7 through the real lifecycle | proven end to end | was only proven in pieces; test added (`receipt.lifecycle.test.ts`) | ✓ |
| refund-api `bun test` | 0 fail | 1390 pass, 0 fail, 67 files; same with `--randomize` (seed 950460847) | ✓ |
| refund-api `tsc --noEmit` | clean | clean (includes the new tests) | ✓ |
| refund-api line coverage (no threshold configured) | report | 96.89 % overall; every new `accounting/` and `fx/` module 93.5 % to 100 %; `scripts/accounting-release.ts` 91.85 % before the CLI test (the uncovered lines were `main`) | ✓ (advisory) |
| Migration from an empty database | applies, no drift | all 8 migrations applied on a fresh DB; `prisma migrate diff` against `schema.prisma`: "No difference detected"; the db-level tests (55) pass on that fresh DB | ✓ |
| auth `bun test` | 0 fail | 1412 pass, 36 skip, 0 fail (the 36 skips are legal-entities suites, untouched by this branch) | ✓ |
| auth `tsc --noEmit` | clean | clean | ✓ |
| refund-ui `tsc -b` | clean | clean | ✓ |
| refund-ui `eslint .` | clean | clean | ✓ |
| refund-ui `vitest run` | 0 fail | 1233 pass, 81 files | ✓ |
| refund-ui `vite build` | builds | builds | ✓ |
| operai-ui typecheck / lint / test | clean | clean / clean / 300 pass | ✓ |
| operai-ui Storybook build | builds | builds | ✓ |
| shell `vite build`, `eslint .`, vitest | green | build ✓, lint ✓, 653 pass (first run: one failure in `router.inventory.test.tsx`, a timing flake under load, unrelated: passes alone and on rerun; see Environment faults) | ✓ |
| meetings-ui build / lint / test (part of `ui:check`) | green | green, 1091 pass | ✓ |
| shell e2e `tsc -p tsconfig.e2e.json`, eslint on the e2e files | clean | clean | ✓ |
| `playwright test --list` | both journeys listed | `refund-accounting-settings.spec.ts` (T31) and `refund-accounting.spec.ts` (T32) listed | ✓ |
| Live e2e `pnpm e2e refund-` | green | not run (owner step) | PENDING |
| `mise run changeset:check` | OK | OK (both against local `main` and against `origin/main`) | ✓ |
| `shared:check`, `react:skew`, `env:doctor` | green | green | ✓ |
| Secret scan | none | gitleaks not installed; pattern scan of the 32,295 added lines vs origin/main (provider key shapes, JWTs, private-key headers, literal credential assignments, URLs with userinfo, long opaque tokens, added non-code files): no hit | ✓ |
| Dependency audit, critical CVEs | 0 | no lockfile changed on this branch (`refund-api/package.json` gained one script). `bun audit` refund-api and auth: none. `pnpm audit --audit-level=critical` refund-ui and operai-ui: exit 0 (no critical; pre-existing 17 high / 8 moderate / 1 low in refund-ui and 2 moderate in operai-ui, not introduced here) | ✓ |
| Wire contract UI vs API | identical field sets | 19 type/schema pairs compared by script: identical; the 20th (`lastFetch`, a nullable schema) read by eye: identical; every API path the UI calls exists in the API routes | ✓ |
| Test strength (mutation sample) | mutants killed | 20 of 20 killed (14 backend, 6 UI; table below) | ✓ |
| Design states (design.md) | every state present | loading, empty, error, denied, read-only, saving, success present on every card and dialog (per component tests); see "design.md audit" | ✓ |
| Accessibility (design.md) | keyboard and ARIA per design | holds in component tests; not verifiable in a browser here | ✓ (limited) |
| Component reuse (design.md inventory) | no new component where reuse was specified | 14 new components, each an N row of the inventory (plus the two Settings view hosts and the API modules, also listed there); 4 small helpers outside it (listed under the design.md audit) | ✓ |
| Plan fidelity at the commit tested | code = plan | SR-1, SR-2 not implemented (D-2, D-3); SR-3, SR-4, SR-5 not implemented (D-4, D-1) | ✗ |
| Operator output of `accounting:release --dry-run` | accurate | the last report line says "Release marker written: yes" in a dry run (D-1) | ✗ |

Defects: D-1 to D-4 below.

## Defects

| id | AC | severity | evidence | suspected owner |
|---|---|---|---|---|
| D-1 | AC-7.1 (operator surface of the release); plan D6, R5 | low | `bun run accounting:release --dry-run` against a DB with two legacy CH lines prints `DRY RUN: nothing was written` and then, as its last line, `Release marker written: yes`. The database confirms nothing was written (no marker, no seed, no number: asserted in `scripts/accounting-release.cli.test.ts`). `report.markerWritten` means "would be written" and `formatReport` prints it unqualified. An operator who reads it as done skips the real run and every approval answers 409 `accounting_release_pending`. Plan SR-4 rewrites this report, so fix both together (label the line "would be written" in a dry run). The new CLI test deliberately does not assert the label. | dev |
| D-2 | AC-3.3, AC-3.6, AC-3.8 (access, not behaviour); security S-01; plan SR-1 | medium | Entity scope is checked per request ("any line matches"), not per line. Repro (details in the appendix): a reviewer scoped to `welld_it` with `set-approved-total` on a mixed submitted request: `PUT …/lines/{chLine}/classification` answers **200** (plan SR-1: 404), and `GET …/accounting` returns the CH line's account, VAT code and CHF figures (plan: `inScope:false`, nulls). Also `GET /accounting/options` has no `welld_ch` scope requirement yet. The existing test `classification.routes.test.ts` "a reviewer scoped to welld_it sees a request that has at least one welld_it line, WellD CH lines included (whole request)" asserts today's behaviour and must change with the fix. | dev (plan already updated) |
| D-3 | AC-3.6; security S-02; plan SR-2 | medium | `classifyLine` never compares `request.ownerUserId` with the caller, and `request:reclassify` has `supportedConditions: ["entity"]` only. Repro: a caller whose `approve` grant carries `self-approval: deny`, on their own approved request: `PUT …/classification` answers **200** (plan SR-2: 403 `self_approval_forbidden`). Needs the auth catalog change (`reclassify` gains `self-approval`, seeded like `approve`), the route check, `selfRestricted` in the view, and the UI note. | dev (plan and auth contract already updated) |
| D-4 | none (release hygiene); security S-03, S-06; plan SR-3, SR-5 | low | Not yet in the code: `git check-ignore refund-api/offsets.csv` finds no rule (the offsets file holds employee emails); the export summary 200 and the `accounting_export_blocked` 409 set no `Cache-Control: private, no-store` (only the CSV does, `export.routes.ts:233`). | dev |
| D-5 | none (task text) | info | T35's done-when lists refund-ui `pnpm typecheck`, but refund-ui has no such script (`tsc -b` runs inside `pnpm build`; T21's notes say the same). Done here with `tsc -b`. | plan/tasks owner |
| D-6 | none (process) | info | `design.md` front matter still says `status: draft`, while plan and tasks treat it as the approved source. | design |

Environment faults (not defects, no dev round consumed):

- **Missing `node_modules` in the worktree.** `shell`'s `remoteVersionExposes.integration.test.ts` builds every remote and first failed with "Cannot find type definition file for 'node'" because `estimai-ui`, `admin-ui` and others were not installed in this worktree. Checked: `git diff` shows no change under those apps; after `pnpm install --frozen-lockfile --ignore-scripts` in each (ignored by git), it passes. The same applies to `operai-ui` and `refund-ui`, which were installed the same way before their gates.
- **Timing flake in the shell suite.** On the run right after that fix, `src/router.inventory.test.tsx` ("shows RemoteMount's error state…") failed once while the 60 s integration build was running. Alone it passes (11/11), and the full suite then passed 653/653. The branch changes nothing under `shell/src`.
- `mise run env:doctor` and `shared:check` need `bun` on PATH: they pass under `mise exec bun@latest`. T34's note says the same.

## Tests added by this pass

Both files pass (the full suite is 1390 green, also randomized). Neither is red, and nothing production was touched.

1. `refund-api/src/accounting/receipt.lifecycle.test.ts` (2 tests). **AC-4.7.** The plan's row says "Reclassify, discard the batch, recompile → number unchanged", but no test walked it: the pieces were proven (trigger refuses raw UPDATE; a hand-built discarded batch shows its numbers), not the sequence. This one goes through the real routers: approve (CH, CH, IT line) → reclassify after approval → compile → discard → compile again → approve a second request of the same employee → mark paid. Numbers, owner, year, sequence and the counter are read back from the database after every step; the second request must get `MC26/004` and the final set must be exactly 001 to 004. Second test: both batches' detail views show `MC26/001` for the same request.
2. `refund-api/scripts/accounting-release.cli.test.ts` (7 tests). **AC-7.1, AC-7.2, AC-7.3 at the operator's entry point.** `main`, the argument parsing and the exit code were the only uncovered lines of the release script, and they are what the owner types in T40. Runs the script as a child process: unknown flag and `--offsets` without a value exit 1 with "nothing was changed"; `--dry-run` writes nothing (marker, seed, numbers read back); the real run releases and numbers by expense date, leaves the WellD Italia line alone and a second run changes nothing; `--offsets <csv>` continues after 81 (`MC26/082`); an offset for a pair that already has numbers, and a malformed CSV, exit 1 and roll back.

Scratch (not committed): `qe/mut.sh`, `qe/mutui.sh` (mutation runners on copies, never on the worktree), `qe/contract.ts` (wire-contract diff), a repro copy of the classification test file.

## Mutation sample (are the tests vacuous?)

Each mutant was applied to a **copy** of the code, the covering test files run, and the copy restored. A control run of the unmutated copy was green.

| id | Mutation | AC | Result |
|---|---|---|---|
| M1 | half-up rounding → floor | 6.3, 6.4 | killed (40 failures) |
| M2 | export includes WellD Italia lines | 6.6 | killed (7) |
| M3 | export includes rejected lines | 6.1 | killed (4) |
| M4 | fetched rate wins over a correction | 5.3, 5.4 | killed (6) |
| M5 | classification PUT allowed on a paid request | 3.7 | killed (3) |
| M6 | numbering ignores the expense date | 4.4 | killed (2) |
| M7 | foreign line uses the type's own VAT default | 3.2 | killed (13) |
| M9 | CSV formula guard removed | 6.2 (ADR 6) | killed (9) |
| M10 | export scope check removed | 6.11 | killed (3) |
| M12 | approve no longer refuses a missing classification | 3.4 | killed (11) |
| M13 | owner JSON leaks `ledgerAccountId` | 3.10 | killed (7) |
| M14 | discarded batch exports | 6.9 | killed (1) |
| M15 | reactivating an active entry accepted | 1.11 | killed (3) |
| M16 | initials without NFD normalisation | 4.8 | killed (3) |
| U1 | UI states "0 left out" for WellD Italia | 6.6 | killed |
| U2 | Default / Set by hand markers swapped | 3.3 | killed |
| U3 | receipt number hidden outside edit mode | 4.9 | killed (6) |
| U4 | rate-missing branch inverted | 3.8 | killed |
| U5 | Settings link shown without `settings:read` | 6.5 | killed |
| U6 | read-only branch of the panel removed | 3.6, 3.7 | killed |

M8 and M11 (duplicate pre-check removal) were not run: the unique index and the P2002 mapping make them equivalent mutants by design (AC-1.2 has the concurrent-add test).

## AC matrix

Legend. Files are under `refund-api/src` unless shown. CAT = `accounting/catalog.routes.test.ts`, DEF = `accounting/defaults.routes.test.ts`,
CLS = `accounting/classification.test.ts` (unit), CRT = `accounting/classification.routes.test.ts`, APP = `review/approve-accounting.test.ts`,
NUM = `accounting/numbering.repo.test.ts`, REL = `scripts/accounting-release.test.ts` (+ the new `.cli.test.ts`), XRT = `accounting/export.routes.test.ts`,
XCS = `accounting/export.test.ts` (golden file), XFL = `accounting/export.failures.test.ts`, FXR/FXS/FXP = `fx/fx.routes|service|parse.test.ts`,
DBI/DBG/DBF = `lib/db.accounting-immutability|accounting-receipt-guard|fx-fetched-once.test.ts`, LIF = new `accounting/receipt.lifecycle.test.ts`,
RQ = `requests/requests.routes.test.ts`. UI files are under `refund-ui/src`. **e2e** = the T31 or T32 journey, **pending (owner)**.
"Sufficient" says whether the non-e2e evidence alone proves the AC.

| AC | Evidence (all executed and green) | e2e | Sufficient without e2e |
|---|---|---|---|
| 1.1 | CAT "adds an account…"; DEF/CRT choose it; UI `settings/LedgerAccountsCard` "Add account" | T31 | yes |
| 1.2 | CAT duplicate naming the number, also deactivated, and two concurrent adds; DBI unique per entity; UI duplicate on the field | - | yes |
| 1.3 | CAT; CRT options active only and "inactive account refused"; `accounting/classification.inactive-default.test.ts`; DBI; UI panel inactive value | - | yes |
| 1.4 | CAT VAT add, 0 and 100 accepted, -1 / 100.01 / 8.123 refused, duplicate also deactivated, concurrent; UI `VatCodesCard` | - | yes |
| 1.5 | CAT PUT/PATCH/DELETE 404; DBI `rateBasisPoints` cannot be updated (SQL and client); UI no edit control | - | yes |
| 1.6 | CRT options and PUT 422 inactive VAT; CLS stored value kept `active:false`; UI | - | yes |
| 1.7 | CAT gates (401, 403 read, 403 write before body); DEF; UI `pages/settings/SettingsViews` and the cards' read-only tests | - | yes |
| 1.8 | CAT history before→after with actors; DBI raw UPDATE/DELETE raise on `ledger_account`, `vat_code`, `accounting_catalog_status` | - | yes |
| 1.9 | CAT deactivate→reactivate, line keeps its account; DEF; CRT accepted again; UI reactivate | T31 | yes |
| 1.10 | CAT VAT reactivate; DEF designation `usable` again; CRT; UI | - | yes |
| 1.11 | CAT 409, no row, concurrent reactivations; UI stale-list alert (`already_active`) | - | yes |
| 2.1 | DEF PUT twice, history with `byEmail`/`at`; DBI `expense_type_default` immutable; UI history drawer | T31 | yes |
| 2.2 | DEF always 12 types, `null` where unset; UI twelve rows with "None" | - | yes |
| 2.3 | APP "defaults changed after approval do not move the frozen line, and the designation neither"; CRT approved line shows stored; inactive-default test | - | yes |
| 2.4 | DEF 422 inactive/unknown; UI `DefaultClassificationDialog` lists active only | - | yes |
| 2.5 | DEF designation + history; REL seed designation with `system:accounting-seed`, admin's earlier choice kept; DEF row immutable; UI card shows code or "None designated" | T31 | yes |
| 2.6 | DEF 422 `vat_code_inactive`/`unknown_vat_code`, no row; UI `ForeignCurrencyVatDialog` | - | yes |
| 2.7 | CLS vectors (unset, cleared, inactive); CRT; APP refuse and reactivate; UI warning | - | yes |
| 2.8 | DEF gates; UI read-only and hidden tab | - | yes |
| 3.1 | CLS; CRT; APP; UI `LineClassificationPanel`, `pages/ReviewDetailPage` markers | T32 | yes |
| 3.2 | CLS EUR/USD/GBP; CRT; APP; NUM; UI foreign line | - | yes |
| 3.3 | CRT PUT while submitted, audit from→to, `line_classified` cause `review`; UI change and marker | T32 | yes |
| 3.4 | APP `classification_missing` suite (type without default, inactive account, unset/inactive designation, refusal consumes no number); NUM; inactive-default; UI `ErrorSummary`, focus, `ApproveDialog` | T32 | yes |
| 3.5 | APP, NUM, CRT "approved line shows what is stored" | - | yes |
| 3.6 | CRT with and without `reclassify`, total/status/decision unchanged, compiled batch; `classification.race.test.ts`; UI editable | - | yes |
| 3.7 | CRT 409 `classification_locked`; DBG paid lock; race with mark-paid (20 rounds); UI locked | - | yes |
| 3.8 | `accounting/amounts.test.ts` vectors; CRT view; UI panel figures, "—" when no rate | - | yes |
| 3.9 | CLS; CRT PUT 422 `line_not_welld_ch`; APP IT-only approves with no defaults; UI no panel | - | yes |
| 3.10 | RQ key set of the owner's line JSON in every status, and with `request:review` held; CRT owner 404; UI `RequestDetailPage` no accounting text, endpoint never called; security S-11 agrees | - | yes |
| 4.1 | APP rejected not numbered, IT numbered; NUM | - | yes |
| 4.2 | `accounting/receiptNumber.test.ts` (`Matteo Codogno` → `MC26/…`); APP `MC26/001` | - | yes |
| 4.3 | APP three approvals contiguous, refusal consumes nothing; NUM rollback; DBG counter only grows, unique index | - | yes |
| 4.4 | APP and NUM date, then createdAt, then id | - | yes |
| 4.5 | APP and NUM `25/001` and `26/001` | - | yes |
| 4.6 | APP and NUM two employees `MC` each from 001; CRT, XRT name next to number; UI batch rows | - | yes |
| 4.7 | DBG raw UPDATE/DELETE raise, unique index; NUM "a number issued stays"; **LIF (added): reclassify → discard → recompile → next approval, no change, no reuse** | - | yes (was partial) |
| 4.8 | receiptNumber.test (name and email vectors, `x@` → `XX`, `Élise Würth` → `EW`); APP e-mail fallback | - | yes |
| 4.9 | RQ, `batches/batches.routes.test.ts`, `batches/pdf.test.ts`, `requests/exportPdf.test.ts`; UI `ExpenseLineRow`, `BatchEmployeeGroupList`, `ReceiptNumber`, `ReviewDetailPage` | T32 | yes |
| 4.10 | APP 20 rounds of two parallel approvals; NUM 20 concurrent calls, two-year case without deadlock; DBG unique backstop | - | yes |
| 5.1 | FXP the recorded 2026-03 answer (924600 / 780800 / 1063500); FXS records source URL, time, actor `system:fx-fetch`; DBF | - | yes |
| 5.2 | FXR GET with origin; UI `ExchangeRatesCard` badges and month rows | T31 | yes |
| 5.3 | FXR correction in effect, history keeps the fetched value; DBI immutable; UI `RateCorrectionDialog` | T31 | yes |
| 5.4 | FXR/FXS fetch after a correction leaves it; DBF | - | yes |
| 5.5 | FXR missing months; `fx/months.test.ts` window; UI "Missing" badge | - | yes |
| 5.6 | FXR `lastFetch.outcome = "failed"` with `at`; FXS throw, timeout, wrong month change no rate; UI persistent banner | - | yes |
| 5.7 | FXR PUT and POST 403; UI Fetch now / Correct hidden | - | yes |
| 6.1 | XRT compiled and paid batches; UI card; XFL | T32 | yes |
| 6.2 | XCS golden file byte for byte (BOM, CRLF, `;`, 16 columns, order); XRT through the route | T32 | yes |
| 6.3 | `amounts.test.ts` 1040 @ 924600 → 962; XCS `10.40;0.9246;9.62`; XRT | T32 | yes |
| 6.4 | `amounts.test.ts` 2080 @ 810 → 156; XCS `8.10;1.56`; XRT | T32 | yes |
| 6.5 | XRT summary and CSV 409 list `{EUR, 2026-03}`; compile, mark-paid, discard still 2xx; XFL budget; UI Blocked card | - | yes |
| 6.6 | XRT IT lines absent, `excludedLineCount`; UI states the count only when above zero | - | yes |
| 6.7 | XRT header-only (all rejected, and IT-only); XCS; UI copy | - | yes |
| 6.8 | XRT identical bytes and hashes, changes with a correction or a reclassification, order independent; XCS | - | yes |
| 6.9 | XRT 409 `batch_discarded` on both routes; UI no card | - | yes |
| 6.10 | XRT one log row per download, none for the summary or a blocked call; XFL failed log write is a 500 with no file; DBI immutable | - | yes |
| 6.11 | XRT 401 / 403 / `accounting_export_out_of_scope`, checked before the batch lookup | - | yes |
| 6.12 | `amounts.test.ts`; XCS; XRT row `0.00`/`0.00` | - | yes |
| 7.1 | REL backfill (CHF defaults, EUR type account + designation, by date, actor `system:accounting-release`, paid request IS-1, second run no change); **CLI test (added): the real run and its exit code** | - | yes |
| 7.2 | REL numbers but leaves unclassified; inactive-default "release and export agree"; XRT blockers with `date` and `type`, cleared by PUT | - | yes |
| 7.3 | REL IT lines: no number, no classification, no audit row, no counter; XRT left out and counted; CLI test | - | yes |

**Summary: 61 of 61 ACs have executed evidence; 14 of them also have a journey pending in e2e (T31: 1.1, 1.9, 2.1, 2.5, 5.2, 5.3; T32: 3.1, 3.3, 3.4, 4.9, 6.1, 6.2, 6.3, 6.4), and for all 14 the integration plus component evidence is sufficient on its own.** What the e2e adds is
the assembled system, which no unit or integration test shows: the shell mounting the new Settings tabs and their
`?section=` search validation, the bearer token and CORS on the download in a real browser, and the global-setup
release step (`direnv exec . bun run accounting:release`) against a live database. The static cross-check above
(identical field sets and paths between refund-ui and refund-api) removes the most likely cause of a journey failing,
which is wire drift, but does not replace the run.

## design.md audit (static, by component tests)

- **Screens and states.** S2/S3/S4 (loading, empty, loaded, load failed, denied, read-only, saving, action refused,
  success), S5 (auto-fetch, failure banner persists until a success, `disabled`, `not_fetchable`, deep link focus), S6
  (every dialog beside its card, `form form` asserted empty in four cards, busy and not dismissible, focus returns to the
  opener), S7 (every panel state including inactive value, rate missing, locked), S8 (`classification_missing` as
  `ErrorSummary` with focus; `accounting_release_pending` stays in the dialog; other 409s keep "already decided"),
  S9, S10 (ready, header only, blocked, load failed, out of scope, downloading, became blocked, no file produced, not
  rendered when discarded): each has a named test. None missing.
- **Component reuse.** The N rows of the inventory exist as designed (14 components, the two view hosts, the API modules and `useLoadedResource`); the Deactivate confirm reuses
  `ConfirmDeleteModal`, the download follows the `RequestExportLink` Blob pattern. Four helpers exist outside the
  inventory, all reported in tasks.md § Implementation notes and none a UI component: `lib/catalogLabels.ts`,
  `lib/monthLabel.ts`, `components/settings/useCatalogToggle.ts`, `components/settings/useActiveCatalogOptions.ts`.
- **Accessibility.** Verified by assertion only: tab list label and arrow/Home/End keys; icon buttons named after their
  cell; twelve "Change" buttons each named after their type; `aria-disabled` Download with its reason as description;
  polite live regions and no focus theft on the auto-fetch; `aria-invalid` and `role="alert"` on missing values; focus
  to the first missing select; `aria-haspopup="dialog"` on openers. **Not verified:** contrast, real keyboard order,
  screen-reader output, axe (no automated a11y check exists in refund-ui).
- **Copy.** en/it parity and `noHardcodedStrings` tests run inside the green refund-ui suite.

## Notes for the caller

- **OWASP pass:** already done as T36 (`security-review.md`, 0 critical, 0 high, 2 medium). Its S-01 and S-02 are
  confirmed here (D-2, D-3). A second pass is only worth it on the SR-1 to SR-5 delta, and only if the fix touches
  more than the plan's fix list.
- **Re-test scope after the fix round.** `refund-api`: `accounting/classification.routes.test.ts` (it asserts the old
  "whole request" scope and must be changed with SR-1), `classification.race.test.ts`, `export.routes.test.ts`
  (options and scope), `scripts/accounting-release.cli.test.ts` and `accounting-release.test.ts` (report format). `auth`:
  `catalogs/refund.test.ts` and `seed.test.ts` (new `self-approval` condition on `reclassify`). `refund-ui`:
  `LineClassificationPanel`, `ReviewDetailPage`, `AccountingExportCard` tests. Then the full gate list once more, and
  the owner's live e2e.
- **Stray file:** an empty `specs/20261118-refund-accounting-export/.md` appeared during this pass (01:48, same minute as
  `security-review.md`). It is not mine and is not committed; it can be deleted.
- **Scratch database:** `refund_qe` was created in the isolated container for the from-zero migration check and left
  there (a hook blocks `DROP DATABASE` from an agent). It holds no data of value.
- **Open questions in spec.md** (six, owner: accounting/product) are accepted risk by the user's pre-authorisation and
  gate only T40, via T39. They do not affect this verdict.

## Appendix: repro of D-2 and D-3 (hand to the dev agent as the failing tests)

Run against a copy of `classification.routes.test.ts` (same file helpers: `createRequest`, `put`, `view`, `grants`),
at commit e7cf2ad9. All three failed with the status shown.

```ts
// D-2a: SR-1 wants 404, the code answers 200
it("welld_it-scoped caller cannot classify the CH line of a mixed submitted request", async () => {
  const r = await createRequest([{ entity: "welld_ch" }, { entity: "welld_it", currency: "EUR" }]);
  const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountTrain.id }, grants(["review", "set-approved-total"], "welld_it"));
  expect(res.status).toBe(404);
});
// D-2b: SR-1 wants the CH line out of scope in the view; today it carries account, VAT and CHF figures
it("welld_it-scoped view hides the CH line's accounting data", async () => {
  const r = await createRequest([{ entity: "welld_ch" }, { entity: "welld_it", currency: "EUR" }]);
  harness.setResolve(async () => grants(["review"], "welld_it"));
  __resetAuthzCacheForTests();
  const ch = ((await view(r.id)).body["lines"] as any[]).find((l) => l.entity === "welld_ch");
  expect(ch.classification).toBeNull(); // and ch.inScope === false
});
// D-3: SR-2 wants 403 self_approval_forbidden, the code answers 200
const restricted: ResolveResponse = { sub: "", epoch: 1, entity: null, jobTitle: null, permissions: [
  { resource: "refund", action: "access", conditions: null },
  { resource: "request", action: "review", conditions: null },
  { resource: "request", action: "approve", conditions: { attributes: [{ key: "self-approval", match: "deny" }] } },
  { resource: "request", action: "reclassify", conditions: null } ] };
it("an owner barred from approving cannot reclassify their own approved request", async () => {
  const r = await createRequest([{ entity: "welld_ch", stored: { ledgerAccountId: accountTrain.id, vatCodeId: imp81.id } }], { owner: "acct-1", status: "approved" });
  const res = await put(r.id, r.lineIds[0]!, { ledgerAccountId: accountOffice.id }, restricted, "acct-1");
  expect(res.status).toBe(403);
});
```

## Re-test after fix round 1 (T41, T42; commit 6094b486)

Verdict: **PASS**. D-1 to D-4 are closed, no AC regressed, every gate is green. Live e2e (T31, T32) still PENDING (owner), as pre-authorised.

| Check | Actual | Result |
|---|---|---|
| refund-api `bun test` | 1426 pass, 0 fail, 67 files; also `--randomize` (seed 2975139277) | ✓ |
| refund-api `tsc` | clean | ✓ |
| auth `bun test` / `tsc` | 1416 pass, 36 skip (legal-entities, unchanged), 0 fail / clean | ✓ |
| refund-ui `tsc -b`, lint, vitest, build | clean, clean, 1252 pass (81 files), builds | ✓ |
| operai-ui typecheck, lint, test | clean, clean, 300 pass | ✓ |
| shell e2e tsc, shell lint, `playwright test --list` | clean, clean, 222 tests in 51 files | ✓ |
| `changeset:check` (local main and origin/main), `env:doctor` | OK | ✓ |
| Lockfiles / dependencies | none changed since the first pass (only `refund-api/package.json`, one script); audit result unchanged | ✓ |
| Shell vitest, storybook, meetings-ui | not re-run: nothing under those apps changed in the fix round | n/a |
| Live e2e `pnpm e2e refund-` | not run (owner step) | PENDING |

Defects:

| id | Status | Evidence |
|---|---|---|
| D-1 | closed | CLI test now asserts `Release marker written: no (dry run: the real run would write it)`; real run says yes. |
| D-2 (S-01) | closed | `lineInScope` on view and PUT; `inScope:false` with null figures; old "whole request" test replaced. |
| D-3 (S-02) | closed | `classificationSelfRestricted` (403 `self_approval_forbidden`); auth `reclassify` declares `self-approval`, seeded like each role's `approve`. |
| D-4 (S-03, S-06) | closed | `git check-ignore refund-api/offsets.csv` matches `.gitignore:23`; summary and blocked 409 carry `Cache-Control: private, no-store` and `nosniff`. |

The committed repros are non-vacuous: on a copy of the code, each mutant below fails the covering tests (control run green): N1 `lineInScope` always true; N2 self-restriction check removed; N3 `approve` restriction no longer counted after approval (the recorded drift: either grant refusing); N4 `Cache-Control` removed. All four killed.

Recorded drift accepted as consistent with the code and tests: after approval a self-restriction on either `reclassify` or `approve` refuses; a `welld_ch` caller on a WellD Italia line of a mixed request gets 404 (was 422). Both are asserted by tests in `classification.routes.test.ts`. No AC text is affected; AC-3.9 still holds (no classification for Italian lines).

Regression: the AC matrix above stands; every test it names ran green in the suites above. D-5 and D-6 (info) are unchanged and do not block.

## Sign-off round (2026-11-19)

Task T77, verdict **PASS** (first pass FAIL on one low defect, D-9; PASS after T82). The full evidence, defect list, mutation tables and gate tables are in `specs/20261119-accounting/qe-report.md`, section "Sign-off round (T77; HEAD a88a23b1)" and "Re-test after T82 (HEAD 7a92703c)". This section lists what concerns this spec. Database: the isolated container on 127.0.0.1:5446 only.

### ACs of this spec changed by the amendment of 2026-11-19 (accounting sign-off), with executed evidence

Files are under `refund-api/src/accounting/` unless shown. Every group was also mutated (the 20261119 report has the table: 14 mutants in the first pass, 5 more for N-01 and 1 for D-10, all killed).

| AC | Status | Evidence (executed, green) |
|---|---|---|
| AC-2.2, 2.3, 2.4, 2.8 | adjusted (defaults are accounts only) | `defaults.routes.test.ts` (14 types, account-only GET and PUT, a `vatCode` body is 422, history), `migration.accounting-signoff.test.ts` (defaults keep ids, actors, times and accounts), refund-ui `ExpenseTypeDefaultsCard`, `DefaultClassificationDialog` |
| AC-2.5, 2.6, 2.7 | retired (foreign-currency VAT code) | `removed-routes.test.ts` (the designation route is 404), `migration.accounting-signoff.test.ts` (the designation table and its triggers are gone), `accounting-release.test.ts` and `.cli.test.ts` (a defaults file with `vatCode` or `foreignCurrencyVatCode` is refused), the e2e asserts the UI has no such block (pending T81) |
| AC-3.2 | retired (no foreign-currency VAT code) | `classification.test.ts`, `approve-accounting.test.ts` (a foreign line is classified like any other) |
| AC-3.1, 3.3, 3.4, 3.5, 3.8 | adjusted (account only, VAT optional) | `classification.test.ts`, `classification.routes.test.ts`, `approve-accounting.test.ts`, refund-ui `LineClassificationPanel`, `ReviewDetailPage` |
| AC-3.11 | new (no VAT code never blocks approval or export) | `classification.test.ts`, `approve-accounting.test.ts`, `export.test.ts`, `export.routes.test.ts`, refund-ui panel and review page tests |
| AC-3.12 | new (at most one VAT code per line) | strict one-field `classification.schemas.ts`, refund-ui `ExpenseLineComposer.test.tsx` (one VAT field and the split-receipt hint) |
| AC-3.13 | new (foreign line: nothing pre-set, any active code, `BZM81` included) | `classification.test.ts`, `classification.routes.test.ts`, `approve-accounting.test.ts`, refund-ui `CatalogSelect`, `LineClassificationPanel` |
| AC-4.3 | adjusted | `numbering.repo.test.ts`, `approve-accounting.test.ts` |
| AC-4.11, 4.12, 4.13 | new (2026 baseline N + 1; none gives 001; other years ignore it; 2027 restarts) | `receipt.baseline.test.ts` (incl. the six N-01 tests added by T82: an email changed before the first numbering still continues from the baseline), `numbering.repo.test.ts`, `db.accounting-signoff.test.ts` (CHECKs, immutability), `receipt-baseline-from-register.test.ts` (the operator helper), `accounting-release.test.ts` |
| AC-6.1, 6.2, 6.3, 6.12 | adjusted (XLSX journal workbook, eight columns, Credit 5832, Currency CHF, Amount the CHF amount) | `exportFormat.test.ts`, `export.test.ts` (byte for byte against `fixtures/accounting-export.golden.xlsx` and its cell list), `xlsx.test.ts`, `export.routes.test.ts` through the route (headers, `.xlsx` name, no-store) |
| AC-6.4 | retired (the import file carries no VAT) | `export.routes.test.ts` "(AC-6.4, retired) the file carries no VAT at all"; the `/csv` route is 404 |
| AC-6.5 | adjusted (wording) | `export.routes.test.ts` blockers |
| AC-6.13 | adjusted (Description pattern) | `exportFormat.test.ts`, `export.test.ts` |
| AC-6.14 | adjusted (Tax and Note present and empty) | `export.test.ts` (cell types `empty`) |
| AC-6.15 | adjusted (text, never a formula) | `exportFormat.test.ts`, `xlsx.test.ts`, `export.test.ts`; no formula element in any part (re-checked on the golden workbook). The space collapsing (D-12) is accepted and settled on the spec side by the product owner |
| AC-6.16 | new (latest first, fixed tie-breaks) | `exportFormat.test.ts`, `export.test.ts`, `export.routes.test.ts` (two downloads identical, same SHA-256) |
| AC-6.17 | new (`2620.10` as text, `5905` and `2620.1` as numbers) | `export.test.ts`, `exportFormat.test.ts`; verified in the golden workbook |
| AC-7.1, 7.2 | adjusted (the account only; no VAT code) | `accounting-release.test.ts`, `accounting-release.cli.test.ts`, `classification.inactive-default.test.ts` |
| AC-7.4 | new and adjusted (the list of last numbers required; exit 3 and nothing written; a header-only list is available) | `accounting-release.test.ts`, `accounting-release.cli.test.ts`; `release-rehearsal.md` read against the code; the report prints "1 line" in the singular (D-10, fixed by T82) |
| AC-8.1, 8.2 | new (14 expense types; meals renamed, existing lines keep the type) | `requests/labels.test.ts`, `requests/suggestions.*`, `requests/lines.routes.test.ts`, `requests/exportPdf.test.ts`, `batches/pdf.test.ts`, `migration.accounting-signoff.test.ts` (enum order), refund-ui `expenseTypes.test.ts` and its parity test with `document-labels.json` |
| AC-8.3 | new (14 default accounts; gifts none) | `accounting-release.test.ts`, `defaults.routes.test.ts`, the defaults file |
| AC-8.4 | new (a gifts line is refused until an account is chosen) | `classification.test.ts`, `approve-accounting.test.ts` |
| AC-8.5 | new (7122 and 2620.1 choosable, never a default) | the defaults file is compared exactly (a mutant that makes 7122 a default is caught), the seed test holds both accounts, the classification PUT accepts any active account |

Unchanged ACs keep the evidence of the first pass and of the re-test after fix round 1; the suites that carry them ran green again in this round (refund-api 1924 tests, refund-ui 1331).

### Gates run in this round (details in the 20261119 report)

refund-api default order 1924 pass and `tsc` clean; `--randomize` seeds 424242 and 77, full suite, 1924 pass each; `migration.accounting-signoff.test.ts` alone with seeds 1, 2, 3 and 424242, 15 pass each; refund-ui 1331 pass, lint, `tsc -b` and build clean; accounting-api 658 pass, accounting-ui 564, operai-ui 300, shell 685, auth `tsc` clean (auth tests: 2 legal-entities throttle tests fail only because of an untracked dotenv file in the checkout, an environment fault; they pass in a copy without it); shell e2e `tsc` clean and `playwright test --list` 239 tests in 53 files; `shared:check`, `react:skew`, `env:doctor`, `changeset:check` green; both services' migrations apply from zero with no prisma drift; secret scan of the delta clean; no critical CVE and no lockfile change; the live AFC test passes once. The golden workbook matches the structure of the accountant's template (read-only, no row copied).

### D-9 and its fix

The first pass failed on `migration.accounting-signoff.test.ts`: its tests shared one scratch database, some wrote to it and others compared it with digests taken before, so a shuffled order (`--randomize --seed 424242`) failed 2 tests. T82 gave each writing test its own scratch database; the re-test is green on the whole suite for both required seeds and on the file for four seeds. T82 also closed the N-01 finding (a baseline looked up under every email of the same user id; six new tests, five mutants killed), D-10 and D-11.

### Pending for the owner

- **T80:** the trial import of the golden workbook (and one real-batch dry export) into Accrio; confirm the Description pattern, the type labels, the VAT code names and labels (`IPM26`, `IPM38`), the remaining default accounts and the 2026 baseline list. Whether Accrio needs the Excel table of the template (D-13) is decided there.
- **T81:** the live e2e (`cd shell && pnpm e2e accounting refund-`), the manual browser accessibility check, and the downloaded workbook opened in Excel or Numbers (LibreOffice is not installed here).

For every AC listed above, unit, integration and component evidence is sufficient on its own; what the live run adds is the assembled path.

Verdict for the sign-off round: **PASS**.
