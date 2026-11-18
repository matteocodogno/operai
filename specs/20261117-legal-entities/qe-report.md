# QE report: legal-entities (T45)

Feature `specs/20261117-legal-entities` · QE of 2026-11-18 · branch `le/T45` (head `95ebd129`, plus the four test fixes listed in § 11) ·
agent: quality-engineer. Everything below was executed on this machine against the compose Postgres (`localhost:5435`) and the local
MinIO; nothing remote, nothing production, no real email (notify-api with `EMAIL_ENABLED=false`, or a local fake Resend that only records
what it is sent), throwaway secrets for `SERVICE_CLIENTS`. No product code was changed.

## 1. Verdict

## QE verdict: PASS

| Check | Threshold | Actual | Result |
|---|---|---|---|
| AC coverage (§ 9) | 52/52 ACs, each with an executed check | 52/52 | ✓ |
| auth `bun test` (with `CRM_TEST_DATABASE_URL`, so `import.test.ts` runs) | 0 fail | 1401 pass, 0 fail, 0 skip (81 files) | ✓ |
| crm-api `bun test` + `tsc` | 0 fail | 2275 pass, 4 skip, 0 fail (113 files); 2 of the 4 skips are the real-service contract tests, run in § 3.2 and green (the other 2: `v1Digests` has no history to compare, and the golden's one-off capture mode) | ✓ |
| notify-api `bun test` + `tsc` | 0 fail | 637 pass, 0 fail (37 files) | ✓ |
| letterhead-api: fmt, clippy `-D warnings`, `cargo test --workspace` with DB required, pool, conformance, `cargo audit` with the CI ignores | all green | all green: 707 pass + 38 pool + 2 conformance; audit exit 0 | ✓ |
| admin-ui, crm-ui, letterheads-ui, operai-ui (+ `build-storybook`), shell, refund-ui, meetings-ui: lint, tests, build | 0 fail | 61/85/25/28/42/59/56 files, 1100/1691/539/298/645/789/1052 tests, all pass | ✓ |
| `react:skew`, `shared:check`, `env:doctor` (production templates) | pass | pass (11 frontends one React; 33 shared groups in sync; "all checks passed") | ✓ |
| env-doctor unit tests | 0 fail | 254 pass, 1 fail: `push.test.ts` "production template ships push off" (pre-existing: file and template identical on `origin/main`; recorded, not counted, as instructed) | ✓ |
| MIG rehearsal on compose, through the copy role of runbook step 3a (§ 4) | steps of T45 done-when | all done; FU-11 SQL works; 5 rounds, 10 fixture cases | ✓ |
| e2e of this feature on a FRESH stack (§ 5) | green | T42 15/15 · T68 13/13 · T43 classic 23 pass + 1 skip · T43 service 20 pass + 4 skip (D2 wrap and D3 Confirm journeys pass) | ✓ (after 4 test-code fixes, § 11) |
| US-9 notice rehearsal on compose (§ 6) | done-when of T45 | all steps observed | ✓ |
| Skew pairings R5 and G15 (§ 7) | as the plan says | 6 pairings run; 0 not run | ✓ |
| Design states / a11y (design.md S1–S12, N1) (§ 8) | all present | loading, error, incomplete, needs-correction, read-only, history, dialogs, notice: present; 320 px no horizontal scroll; page text contrast ≥ 5.01:1 in both themes | ✓ |
| F2–F7, FU-1–FU-13, D1–D3 (§ 10) | closed or routed | closed or routed, none open in code | ✓ |
| Coverage / dependency audit | no threshold defined in CI or `.forge` | auth `legalEntities/` 94–100 % lines per file (informational); `cargo audit` green; JS: only manifest change is the devDependency `axe-core` in admin-ui, in no advisory (§ 9 note) | ✓ (informational) |

Defects (product): **none**. Defects in test code, found because the stack was fresh, fixed and listed in § 11: 4. Findings that are not
defects of an AC but need a person: § 12 (O-1 the actor's name is editable, confirmed live; O-2 a transient Settings 422 in the push-2
window; O-3 FU-12 decision; O-4 the shell footer's contrast).

## 2. Environment and method

- Fresh local databases for everything (the old ones hold hundreds of versions): `auth_qe_unit`, `crm_qe_unit`, `crm_qe_scratch`
  (the import test's scratch CRM), `notify_qe_unit`, `letterhead_qe_unit` (unit suites); `operai_auth_qe` + `crm_qe` + `notify_qe_mig` +
  `activities_qe_mig` (MIG and US-9 rehearsal); `auth_qe_e2e`, `crm_qe_e2e`, `notify_qe_e2e`, `activities_qe_e2e`, `letterhead_qe_e2e`
  (e2e); `auth_qe_tpl`/`crm_qe_tpl` and `auth_qe_r{b,c,d,e}`/`crm_qe_r{b,c,d,e}` (MIG rounds, each created from the migrated templates);
  `letterhead_qe_old`, `letterhead_qe_fu12_{1..4}` (skew, FU-12). MinIO buckets `letterhead-qe-e2e`, `letterhead-qe-old`,
  `letterhead-test-qe45`, `letterhead-fu12-{1..4}`. They are left in place for inspection (safe to drop).
- Frontends built and served with `vite preview` exactly as `shell/playwright.config.ts` does (so Playwright reused them);
  Playwright ran with a scratch config pointing at the installed chromium 1208 (deleted); auth's environment exported to the
  Playwright process; `mise` was not trusted (commands run directly). The old services for the skew pairings were `origin/main`
  (`56fbbfa3`) in a temporary worktree, built and run locally, removed afterwards with its build output.
- The old-version stack, scratch scripts and logs are not committed; the commands are in each section.
- Every server I started was stopped (auth, notify-api, crm-api, activities-api, letterhead-api, the ten previews, the fake Resend);
  `ps` shows none.

## 3. Suites on the branch head

### 3.1 Unit and integration

| Suite | Command (cwd) | Result |
|---|---|---|
| auth | `bun test` (auth; `DATABASE_URL` migrated+seeded, `CRM_TEST_DATABASE_URL=crm_qe_scratch`) | 1401 pass / 0 fail / 0 skip, 81 files, 34 s; `bun run typecheck` 0 |
| crm-api | `bun test`, `bun run typecheck` | 2275 pass / 4 skip / 0 fail, 113 files, 59 s; tsc 0. The skips: the two real-service contract tests (env-gated, § 3.2), `offer-templates/wizardSeeds/v1Digests.test.ts` (`skipIf`: no history to digest) and `offers/issuerGolden.capture.test.ts` (`skipIf(!CAPTURE)`: the one-off recording of the golden, never re-run) |
| notify-api | `bun test`, `bun run typecheck` (the suite needs `ALLOWED_ORIGINS`, `AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `SERVICE_AUDIENCE` exported; without them it exits at env validation) | 637 pass / 0 fail, 37 files; tsc 0 |
| letterhead-api | `cargo fmt --all --check` · `cargo clippy --workspace --all-targets --locked -- -D warnings` · `cargo test --workspace --locked -- --skip conformance::` with `LETTERHEAD_TEST_DATABASE_URL`, `LETTERHEAD_REQUIRE_DB_TESTS=1`, MinIO, `LETTERHEAD_REQUIRE_PDFIUM=1`, a real `pg_dump` 17 (the compose container's, through a wrapper) with `LETTERHEAD_RESIDUE_REQUIRE_PG_DUMP=1` | fmt 0 · clippy 0 · 707 pass / 0 fail / 1 ignored (api unit 152, preview 21, read 15, registry 47, render 40, render_migrate 5, residue 4 (+1 `#[ignore]`), write 23, engine 376, corpus 24) |
| letterhead-api, the rest of the CI job | `cargo test -p letterhead-engine --test corpus conformance::` (pdfium 8125, pinned) · `cargo test -p letterhead-api --test pool` · `cargo audit --file Cargo.lock --deny unsound --deny yanked --ignore RUSTSEC-2026-0194 --ignore RUSTSEC-2026-0195 --ignore RUSTSEC-2026-0459` | conformance 2 pass (64 s) · pool 38 pass (the CI test step's `--skip` filter leaves these to the release-build step; run here in debug) · audit exit 0, 7 allowed warnings (unmaintained notices). Not run: the CI's release-build "worst case" step (T41/T46 machinery, untouched by this feature) |
| admin-ui | `pnpm lint` · `pnpm test` · `pnpm build` | all 0; 61 files, 1100 tests |
| crm-ui | same | all 0; 85 files, 1691 tests |
| letterheads-ui | same | all 0; 25 files, 539 tests |
| operai-ui | `pnpm typecheck` · `lint` · `test` · `build-storybook --quiet` | all 0; 28 files, 298 tests; Storybook "build completed successfully" |
| shell, refund-ui, meetings-ui (the `ui:check` steps) | `pnpm build` · `lint` · `test` | all 0; 645 / 789 / 1052 tests |
| repo guards | `node scripts/check-react-skew.mjs` · `bun scripts/check-shared-copies.ts` · `bun tools/env-doctor/index.ts` | OK · 33 groups in sync · "all checks passed" |
| env-doctor tests | `bun test tools/env-doctor` | 254 pass / 1 fail (the known `push.test.ts`, § 1) |

### 3.2 The real-service contract tests (two of the four crm-api skips of a plain `bun test`)

Run against real processes on compose: `src/lib/legalEntities.contract.test.ts` against the real auth, with the `crm-api` client and, as
the no-scope client, `activities-api`: **6 pass**. `src/offers/letterheadContract.test.ts` against the real letterhead-api with a token
from the real auth: **7 pass, 0 fail** (page text equal x3 for every case, the pre-switch offer's stored bytes identical, AC-6.4).
Note for whoever runs it on a debug-build service: with bun's 5 s default timeout 3 of the 7 time out (a 19-page preview takes 8 s in a
debug build); `--timeout 120000` makes all 7 pass. Not a defect.

## 4. MIG rehearsal (T9's fixture set, compose, copy role)

Fixture: `specs/20261117-legal-entities/fixtures/crm-entity-profiles.json` (10 cases, one entity each, so two per round). Seeded straight
into `entity_profile` of a fresh CRM database, copied into a fresh registry database, always as the role of runbook step 3a.

### 4.1 Step 3a, the copy role: the SQL was never run before (FU-11)

Run as written on the compose Postgres (`docker exec ... psql -U postgres`), with two local substitutions: `ALTER ROLE ... PASSWORD`
for `\password` (the latter needs a terminal; the literal is throwaway) and `crm_qe` for `crm`. Result: `CREATE ROLE`, the grants succeed.
The proof block, **as the runbook asks, read not assumed**: `SELECT count(*) FROM entity_profile` works; `SELECT "offerTermsEn"`,
`SELECT "letterheadKey"`, `UPDATE ... WHERE false` and `SELECT 1 FROM deal_offer` each answer `ERROR: permission denied`. More than the
runbook asks: a **login** session as `legal_copy_ro` has `default_transaction_read_only = on`, and even after `SET
default_transaction_read_only = off` an `UPDATE` and an `INSERT` into `entity_profile` are `permission denied`, `SELECT` of `letterheadBy`
and of `company` are refused, and the seven granted columns read. The import script's own reads (`entity`, the four values, `updatedAt`,
`updatedBy`) need nothing else: every run below went through that role. Step 3b (`DROP OWNED BY`, `DROP ROLE`) ran in every database
the role was granted in; `SELECT count(*) FROM pg_roles WHERE rolname = 'legal_copy_ro'` = 0.
**FU-11: confirmed, the SQL works as written** (the two substitutions above are the only changes).

### 4.2 Round A: the whole flow, `welld_it` = `iban-spaces-lower-case`, `welld_ch` = `missing-vat`

| Step | Report line | Registry afterwards |
|---|---|---|
| dry run 1 | `found 2 \| would insert 2 \| present 0 \| resolved 0 \| mismatched 0` · `flags: incomplete 1 \| invalid 0 \| ibanPrintChanged 2` · `IBAN …3456` / `IBAN …2957` · `welld_ch: incomplete, missing: vatNumber` · `ACCOUNTED FOR`, exit 0 | no version |
| `--apply` | `inserted 2`, same flags and IBAN lines | 2 versions (`action import`, `createdByUserId` NULL, contacts empty, IBAN in electronic form, address in both languages, equal to the fixture's `expect`), 2 `legal_entity.import` audit rows (actor NULL; `source` carries table, `updatedAt` and `updatedBy` "fixture"), **0 notice rows** (AC-9.16) |
| dry run 2 | `would insert 0 \| present 2`, flags and both IBAN lines identical to run 1, exit 0 | unchanged |
| `--apply` again | `inserted 0 \| present 2`, exit 0 | still 2 versions, 2 audit rows, 0 notices (AC-7.4, AC-9.16) |
| CRM edited after the copy (`legalName` of `welld_it`) | dry run: `present 1 \| mismatched 1`, `welld_it: mismatched, differs from version 1: legalName`, `NOT ACCOUNTED FOR: mismatched above 0, nothing was overwritten`, **exit 1**; `--apply` the same, exit 1 | unchanged (2 versions, 2 audit rows) |
| an administrator carries the edit into the registry (API, 201) | dry run: `present 1 \| resolved 1 \| mismatched 0`, `welld_it: resolved`, `ACCOUNTED FOR`, exit 0; `--apply`: `inserted 0` | version 2 of `welld_it` (action save); its notice: the actor only (receipt), delivered |
| pre-switch dry run (step 4) | identical to the line above | |
| the switch: crm-api (branch) running; the CRM's `PUT /entity-profiles/welld_ch` sent `legalName`, `addressLines`, `vatNumber`, `iban`, `offerTermsEn`, `placeOfIssue` | `200`, the answer and `GET` carry no legal key; the CRM row's legal columns unchanged, `offerTermsEn` saved | |
| post-switch dry run (step 5b) | `present 1 \| resolved 1 \| mismatched 0`, `IBAN …3456` / `…2957` unchanged, exit 0 | |
| moved-incomplete through crm-api (AC-7.3, AC-6.3) | a deal, an issuer template and a draft of `welld_ch` (VAT missing in version 1): generate answers **409 `legal_entity_incomplete`, `missing: ["vatNumber"]`**, no offer; after one registry save adding the VAT, 62 s later (cache), generate answers 201 and the PDF carries `Plugh Fixture Lugano SA` and the address | |

No full IBAN, name, address or VAT value appears in the output of any import run (30 report logs of all five rounds and the image run, scanned for the 36 fixture values: 0 hits); only `…3456`, `…2957` and the like. (The one log that shows fixture rows is my own `SELECT` as the copy role in § 4.1, which prints synthetic rows on purpose.)

### 4.3 Rounds B to E: the other nine cases, each in a fresh database pair, same four runs

For each round the registry's versions were compared, value by value, with the fixture's hand-written `expect` (legal name, address lines
into both `it` and `en`, VAT, IBAN electronic form, contacts empty, `version 1`, `action import`, no author): all equal. Then dry-run
equals apply, and the re-run inserts nothing.

| Round | `welld_it` / `welld_ch` | Dry-run flags (`incomplete / invalid / ibanPrintChanged`) | Result |
|---|---|---|---|
| B | `no-row` / `five-address-lines` | 1 / 1 / 0: `welld_it` "no CRM row: empty values", missing legalName, address.it, address.en, vatNumber; `welld_ch` invalid address.it and address.en `too_many_lines (limit 4)`; `found 1`, `would insert 2` | matches `expect`; apply 2, re-run present 2 |
| C | `line-break` / `iban-bad-check-digits` | 0 / 1 / 0: `iban iban_check_digits` | matches; moved as it is |
| D | `special-characters` / `line-separator` | 0 / 1 / 0: `vatNumber line_break` | matches |
| E | `complete-it` / `complete-ch` (the golden's cases) | 0 / 0 / 0 | matches; `IBAN …3456` / `…2957` |

Each round: 2 audit rows, 0 notice rows. Round A's `iban-spaces-lower-case` and `missing-vat` are the two cases with `ibanPrintChanged`
(`expect.ibanPrintChanged = true`): both flagged, none other.

### 4.4 The golden comparison (AC-7.5), and the production image

`crm-api/src/offers/issuerGolden.test.ts` (52 tests): every complete fixture case, seeded in the registry fake as the move writes it,
generated through the classic renderer and through the service-path stub, compared with the golden captured before the switch
(`fixtures/issuer-lines.golden.json`): equal except the IBAN grouping exactly where `ibanPrintChanged` says. Green.
The runbook's image check: `docker build -t ... auth`, then the script in that image against the compose databases: report and exit 0
(not `crm_not_read_only`), and `--help` exits 64 (the script is in the image).

## 5. End-to-end on a fresh stack

All journeys ran on `auth_qe_e2e`, `crm_qe_e2e` and friends (registry imported from the E-round fixture, so version 1 "moved from the CRM"),
shell and nine remotes built from the branch, auth/notify-api/crm-api/activities-api/letterhead-api as real processes. Nothing stubbed.

| Spec | Stack | Result |
|---|---|---|
| `shell/e2e/legal-entities.spec.ts` + `legal-entities-access.spec.ts` (T42) | classic | **15 pass** (10 + 5) |
| `shell/e2e/protected-legal-details.spec.ts` (T68) | classic | **13 pass**, including the D3 journeys "keyboard only: Confirm saves", "a newer version saved while the dialog is open", and the D-T68-2 accessible-description checks |
| `shell/e2e/crm-legal-entities.spec.ts` + `letterheads.spec.ts` (T43) | classic (crm-api switch off) | **23 pass, 1 skipped** (the overflow journey, service-only) |
| same | service (`LETTERHEAD_SERVICE_ENABLED=true`, real letterhead-api) | **20 pass, 4 skipped** (the four classic-only journeys); includes the FU-1 overflow journey and the D2 wrap journey "a missing label that wraps onto a second line keeps its brackets in English too" |
| `crm-offer-wizard.spec.ts`, `-revise.spec.ts`, `-pages.spec.ts` (regression of the CRM wizard on the registry issuer; touched by T43) | classic | wizard 9 pass; revise 4 pass + 1 skip; pages 12 pass + 1 fail: `:380 "each page prints its own N/M ..."` = **FU-13** (the control step "without the cover the letterhead's own number shows" reads 0 ink in the letterhead fixture's corner; fixture `letterhead-a4.pdf`, no registry involved; pre-existing, not counted) |

The first fresh-database runs failed four journeys for reasons in the tests themselves; they are in § 11 with the fix. Run 1 logs are
kept in my scratch (`pw-t42-run1-fresh-db-failure.log`, `pw-t43-classic-run1-letterheads-fixture-race.log`,
`pw-t43-classic-run2-d2-margin.log`, `pw-t43-service-run1.log`).

## 6. US-9 notice rehearsal on compose (AC-9.7 to AC-9.17)

Stack: auth (dispatcher started) + notify-api (+ activities-api, crm-api) on `operai_auth_qe` / `notify_qe_mig`;
`LEGAL_ENTITY_NOTICE_EMAIL=qe-outside@example.test`; five people made through the admin API: two administrators, a `welld_ch`-conditioned
manager, a `welld_it`-conditioned manager, a person with no grant (plus an earlier administrator from the MIG step). Email: notify-api with
`EMAIL_ENABLED=false` for the first part (a `sent` row is recorded, nothing leaves), then with a **local fake Resend** (`RESEND_BASE_URL`
→ a Python server on 127.0.0.1 that records the request and answers an id) so the rendered emails could be read.

| Step | Observed |
|---|---|
| Baseline, notify-api up: IBAN change of `welld_ch` (v3) | 201, `["version","created","entity"]`, 30 ms. Rows: 4 persons x in_app + 4 persons x email + 1 outside x email = **9 rows**, all `delivered` at attempt 1: the actor (receipt, AC-9.9), the second administrator, the earlier administrator, the `welld_ch` manager, the outside address (email only, AC-9.10); **not** the `welld_it` manager nor the no-grant person (AC-9.8). Notification centre: one notice per recipient, `en` title "Legal details of WellD CH changed: IBAN" and `it` "Dati legali di WellD CH modificati: IBAN", link `/admin/legal-entities?entity=welld_ch&view=history`. notify-api `email_delivery`: exactly one row per address for the version (AC-9.13) |
| **notify-api stopped**, protected save (v5) | **201 in 23 ms, the same body shape as with notify-api up**; no error to the person (AC-9.14). 9 rows `pending`, `attempts 1`, `lastReason notify_unreachable`; audit: **9 `legal_entity.notice_failed`** (the first failure of each row, one per recipient and channel, with entity, version, person/outside, channel, reason, time; AC-9.15) |
| first retry, notify-api still down | at +1 min (`attempts 2`, next at +3 min); the audit still has exactly 9 `notice_failed` (first failure only) |
| notify-api started, next retry (+3 min) | all 9 `delivered` at attempt 3; **9 `legal_entity.notice_delivered`**; notify-api holds one notification per person (4) and one email per address (5) for the version: no duplicate through three attempts |
| **give-up**: notify-api stopped, protected save (v6), then the real dispatcher over the real database with its clock moved **+25 h** (`createNoticeDispatcher({ now })`, the option the code offers; it also tried the send once more, as designed) | all 9 rows `given_up` (reason `notify_unreachable`), **9 `legal_entity.notice_given_up`**; log lines carry id, entity, version, channel, reason |
| **crash durability**: notify-api down, protected save (v9), **`kill -9` auth**, notify-api and auth restarted | rows were mid-send or pending at the kill; after the restart's sweep and the 60 s lease, all 9 `delivered` (attempt 2); 5 emails recorded at the provider for the version (one per address) |
| change of the three protected details at once plus address and contacts (v7, sentinel values), then a restore of version 5 (v8) | in-app and email (read from the fake provider): subject "Legal details of WellD CH changed: legal name, VAT number and IBAN"; entity, "Change saved by …" / "Version 5 restored by …", "When: 18 November 2026, 02:52 CET (Europe/Zurich)", "New version: 7", "Details changed: legal name, VAT number and IBAN", "Old IBAN: …7001. New IBAN: …1001", "Also changed: address (Italian), address (English), contacts line (Italian) and contacts line (English)", a link (relative in the centre, `http://localhost:5173/admin/legal-entities?entity=welld_ch&view=history` in the email); the email in English for every recipient, the outside address included; the centre has the Italian twin ("Dati modificati: ragione sociale, partita IVA e IBAN", "IBAN precedente", "Nuovo IBAN") (AC-9.11, AC-9.13) |
| **no value in any notice or record** (AC-9.12) | scan of 27 forbidden values (every legal name, VAT number, IBAN in electronic and grouped form, address line and contacts line of every version, sentinels included) over: all `legal_entity_notice` rows (60), all notice audit rows (36), all notify-api notification rows (23) and `email_delivery` rows (28), the 10 emails the provider received, and the whole logs of auth, notify-api, crm-api and activities-api: **0 hits**. Positive control: the same scan finds the sentinel in the `legal_entity.save` and `restore` audit rows (2 hits), which legitimately hold before/after (AC-2.5) |
| the import | 0 notice rows, first and repeated (AC-9.16), see § 4 |

Push (AC-9.13's third part): **not rehearsed on compose** (`PUSH_ENABLED` is off locally and a push subscription needs VAPID keys and a
browser); it is proved at integration level by `notify-api/src/system/notifications.idempotency.test.ts` (an idempotent in-app call
dispatches push once, a repeat dispatches none; both pass in § 3.1).
`notice_no_recipients` (AC-9.15, "a protected change with no recipient at all") needs an injected empty recipient set: covered by
`auth/src/legalEntities/notices/duty.test.ts`/`dispatcher.test.ts`, not rehearsed.

## 7. Skew pairings (plan R5, G15)

"Old" = `origin/main` (`56fbbfa3`) of the service, built and run next to the branch's others; the databases are the branch's (the
branch adds one additive migration to crm-api and one to notify-api, which the old code ignores).

| Pairing | What I ran | Result |
|---|---|---|
| old letterhead-api + **new crm-api** (R5) | new crm-api, `LETTERHEAD_SERVICE_ENABLED=true`, pointed at the old service; draft, preview and generate through the API | the old service answers `unsupported_content_version` (422); crm-api answers **503 `layout_service_unavailable`** for preview and generate, **0 offers stored**, no document without an issuer (AC-5.5) ✓ |
| **old crm-api** + new letterhead-api | old crm-api (switch on): generate | 201; the service logs `entity_data_ignored=true` for the `entityData` the old crm-api sent; the PDF's letterhead prints the **registry's** name and grouped IBAN; the body's `[EMITTENTE]` still prints the CRM's own name (the old crm-api's field), as the plan expects during the window (AC-5.2) ✓ |
| old crm-ui + **new crm-api** (R5), in a browser through the branch shell | main's crm-ui build served in place of the branch's: Settings loads (legal fields shown empty, "Legal name*"); an edit typed in them and Save: `PUT` carries `legalName`, `addressLines`, `vatNumber`, `iban`, `offerTermsEn` and gets **200**; the CRM's legal columns and the registry are unchanged (v80), `offerTermsEn` saved; the wizard previews and generates (201) | crm-api tolerates the old body ✓ (the values typed in the old fields are dropped silently, by design) |
| new crm-ui + **old crm-api** (R5) | branch crm-ui against main's crm-api: Settings shows the note and "Open Legal entities"; the wizard preview and Generate work (201), the old context answer is tolerated; **Save profile answers 422** with the raw message `legalName: Invalid input: expected string, received undefined` (the old crm-api still requires the legal keys) | wizard ✓; Settings save: see **O-2**. Nothing is stored, nothing is lost |
| new admin-ui + auth **without the check route** (G15) | in the browser, an IBAN changed and Save, with `POST /legal-entities/welld_ch/versions/check` answered by the 404 problem body the real auth gives an unknown route, then by a 500, then a dropped connection | in all three: **no confirmation, no `POST .../versions`**, the alert "The changes could not be checked. Nothing was saved ... Your changes are still here. Try again. Retry", the form keeps what was typed, the registry unchanged: **fails closed** ✓. (Simulated at the browser: the check route is removed from what the page sees; a real old auth would give this very 404.) |
| **new auth + old notify-api** (G15) | old notify-api in place of notify-api; protected save (v81); then the branch notify-api | save 201; in_app rows `delivered` (the old service accepts them), the 8 email rows `pending`, `attempts 1`, `lastReason notify_refused` (the old service answers 400 to the new template), 8 `notice_failed`; after the branch notify-api is up, the +1 min retry: 8 email rows `delivered` (attempt 2), 8 `notice_delivered`; one email per address ✓ **retried, not lost, no duplicate** |

Not run: none. (The one simulated item is the check route, as written.)

## 8. Exploratory pass and design.md

**API contract edges** (probe against the running auth, 48 of 49 checks pass; the 49th is my probe's own assertion bug: `GET
/legal-entities/manageable` for a person with no grant answers `{"entities":[]}`, which is correct):
no cookie 401; a person with no role reads both entities in the fixed order, `Cache-Control: no-store`; unknown entity, `%00` and a 300-char
name each 404 `unknown_legal_entity`, name not echoed, same body for the service route; a service token with the scope reads, **byte-equal
to the person's body** (list and one entity); a service without the scope, a person JWT on the service route, a service JWT on the person
route and no token all 401 with the one frozen body; 19 validation refusals (every required value empty, blank, NBSP and U+3000; every
limit at +1; line break in each one-line value; tab, U+0085, NUL; 35-char IBAN; wrong check digits; hyphen) each 422 naming the field with
nothing saved; a lower-case spaced IBAN is stored upper case without spaces; a save of the same IBAN regrouped creates no version
(`created: false`); a stale `baseVersion` 409 with the current version; **20 parallel saves on one base: one 201, nineteen 409**, history
newest first and contiguous; no grant 403 on save and restore, the `welld_ch` manager 403 on `welld_it`; `PUT`/`PATCH`/`DELETE`
on a version 404.
**Database immutability (AC-2.7)**: raw `UPDATE`, `DELETE` and `TRUNCATE ... CASCADE` of `legal_entity_version` each raise
`legal_entity_version_immutable` (a bare `TRUNCATE` is refused earlier by the foreign key of the notice table); a third entity name is
refused by the CHECK; versions 1..N intact.
**Registry outage (AC-5.5, AC-3.3), live**: auth stopped; the letterhead service renders from its held entry at +0, +20 and +45 s and
answers **503 `legal_entities_unavailable` with `Retry-After: 5` at +75 s**, no document.
**Design states** (admin-ui): loading ("Loading…"), error ("The legal entities could not be loaded" with Retry, registry read answered
500), a moved entity incomplete (tab "Incomplete", banner "These details are incomplete. Missing: Legal name, Address (Italian), Address
(English), VAT number. Offers and contracts for WellD Italia are refused until they are filled in and saved.") and one out of limits
(tab "Needs correction", banner title "Some values need correcting", the five address lines kept: the FU-4 copy), read-only entity for
the manager (T42), history, version view, restore dialog, confirmation (T68), notices in the centre in both languages (§ 6).
**FU-3, real browser, 320 px**: the Legal entities page (details and history views) in both themes: `scrollWidth` 320 = `clientWidth`
320, no element overflows its box; same at 1280 px. **Contrast spot-check, both themes**: the page's 47 text elements measure >= **5.01:1**
(light and dark); `axe` (WCAG 2.1 A/AA, including color-contrast) is 0 violations in T42 and T68 on every screen and both dialogs.
Outside the feature, the shell's footer text (11 px: "Legal information", "Operai v0.5.0") measures 3.01:1 (light) and 2.79:1 (dark): **O-4**.
**Component reuse (design.md inventory)**: read against the code: the three lifted components are exported by `@operai/ui` and admin-ui imports
`ErrorSummary` (`LegalEntityForm.tsx`) and `VersionTable` (`LegalEntityHistory.tsx`) from it, with no local copy; `ConfirmDialog` is the base of
`RestoreDialog` and `ProtectedChangeDialog`. The new admin-ui files are the inventory's NEW rows (`LegalEntitiesPage`, `LegalEntityPanel`,
`LegalEntityForm`, `AddressLinesField`, `LegalEntityFacts`, `LegalEntityHistory`, `LegalEntityVersionView`, `RestoreDialog`,
`ProtectedChangeDialog`, `ProtectedChangeList`, `ConflictBanner`, the `lib/` mappings, merge, model, API and `useEntityDrafts`) plus four
internal splits of those (`LegalEntityFormBar`, `LegalEntityPanelBadges`, `LegalEntityHistoryModel`, `ProtectedChangeModel`); no NEW
component where the inventory says reuse.

## 9. AC to evidence

Legend. Paths are relative to the repository; `le/` = `auth/src/legalEntities/`; `lh/` = `letterhead-api/`; "(n)" = tests in the file that name the AC.
Every file listed ran green in the suite of § 3 (auth 1401, crm-api 2275, notify-api 637, cargo 707, admin-ui 1100, crm-ui 1691,
letterheads-ui 539) or in the e2e run of § 5; "QE live" = executed by me against the running stack (§ 4, 6, 7, 8).

| AC | Unit / integration (suite result) | E2E (run result) | QE live |
|---|---|---|---|
| 1.1 | `le/serialize.test.ts` (2), `le/read.routes.test.ts`, `le/immutability.contract.test.ts` (CHECK refuses a third entity), `admin-ui/src/pages/LegalEntitiesPage.test.tsx` | `legal-entities.spec.ts` both entities as tabs, every value (pass) | probe: list = welld_it, welld_ch; SQL: `welld_de` refused by CHECK |
| 1.2 | `le/rules.test.ts`, `le/write.routes.test.ts`, `admin-ui/src/components/LegalEntityForm.test.tsx` | `legal-entities.spec.ts` refusal next to the control (pass) | probe: 6 required-value refusals, 422, field named, nothing saved |
| 1.3 | `le/rules.test.ts` (2), `le/write.routes.test.ts`, `admin-ui/src/lib/legalEntityMappings.test.ts`, `crm-api/src/offers/letterheadContract.test.ts` (2) | `legal-entities.spec.ts` (pass) | probe: 12 limit / line-break / control-character refusals |
| 1.4 | `le/rules.test.ts`, `le/write.routes.test.ts` (2), `admin-ui/.../LegalEntityFormModel.test.ts`, `LegalEntityForm.test.tsx` | `legal-entities.spec.ts` (2) (pass) | probe: stored upper case no spaces; wrong check digits and hyphen refused |
| 1.5 | `le/write.routes.test.ts`, `crm-api/src/lib/legalEntities.test.ts`, `crm-api/src/offers/offers.test.ts`, `contractPdf.test.ts`, `lh/api/tests/registry.rs` (47 pass), `lh/api/tests/render.rs` | `crm-legal-entities.spec.ts` stages A and B on both stacks: the next offers print the saved details (pass) | contract test vs real auth (6 pass); outage probe |
| 2.1 | `le/write.routes.test.ts` (2), `le/rules.test.ts`, `le/check.routes.test.ts`, `admin-ui/src/lib/legalEntityModel.test.ts` | `legal-entities.spec.ts` (pass) | probe: +1 version by the person; regrouped IBAN `created:false` |
| 2.2 | `le/history.routes.test.ts`, `admin-ui/.../LegalEntityHistory.test.tsx`, `LegalEntityHistory.paging.test.tsx` | `legal-entities.spec.ts` history (pass) | probe: newest first, contiguous |
| 2.3 | `le/history.routes.test.ts`, `LegalEntityHistory.test.tsx`, `admin-ui/src/router.test.tsx` | `legal-entities.spec.ts` version view read-only (pass) | |
| 2.4 | `le/write.routes.test.ts`, `le/history.routes.test.ts` (`restorable`), `admin-ui/.../RestoreDialog.test.tsx` (2) | `legal-entities.spec.ts`, `protected-legal-details.spec.ts` restore journeys (pass) | restore of v5 -> v8 (§ 6); restore of the current version creates nothing |
| 2.5 | `le/write.routes.test.ts` (audit in the same transaction), `auth/src/authz/audit-immutability.contract.test.ts`, `admin-ui/src/pages/AuditPage.test.tsx` | `protected-legal-details.spec.ts` (audit count) (pass) | audit rows read in § 4 (`import`) and § 6 (`save`, `restore` with before/after: the sentinel found there, positive control) |
| 2.6 | `le/write.routes.test.ts`, `admin-ui/.../LegalEntityForm.conflict.test.tsx`, `lib/legalEntitiesApi.test.ts` | `legal-entities.spec.ts` two sessions, conflict, reapply (pass); `protected-legal-details.spec.ts` | probe: 409 with `currentVersion`; **20 parallel saves: 1x201, 19x409** |
| 2.7 | `le/immutability.contract.test.ts`, `le/routerTable.test.ts` (2) | | SQL `UPDATE`/`DELETE`/`TRUNCATE` all raise `legal_entity_version_immutable`; `PUT/PATCH/DELETE` 404 |
| 3.1 | `le/read.routes.test.ts` (2) | `legal-entities-access.spec.ts` a person with no grant reads through `GET /legal-entities` (pass) | probe: 401 without cookie, 200 with no role |
| 3.2 | `le/system.routes.test.ts` (3), `crm-api/src/lib/legalEntities.contract.test.ts` | | contract test vs real auth (6 pass); probe: byte-equal bodies, three 401s identical |
| 3.3 | `crm-api/src/lib/legalEntities.test.ts` (2), `crm-api/src/offers/offers.test.ts` (2), `lh/api/tests/registry.rs`, `lh/api/tests/render.rs` (fake clock), `auth/src/authz/authz.routes.test.ts` | `crm-legal-entities.spec.ts` (waits 31 s, then the new details; pass) | outage probe: held entry served up to 45 s, refused at 75 s; answer `no-store` |
| 3.4 | `le/read.routes.test.ts`, `le/system.routes.test.ts`, `le/history.routes.test.ts`, `auth/src/authz/seed.test.ts` | `legal-entities-access.spec.ts` | probe: unknown, `%00`, 300 chars: same 404, not echoed |
| 4.1 | `auth/src/authz/seed.test.ts` (6: catalog, condition, seed idempotent, `SUITE_APPS`), `authz.routes.test.ts` | `legal-entities-access.spec.ts` (3): role editor conditioned then unconditioned; the stored grant does what it says (pass) | |
| 4.2 | `le/write.routes.test.ts`, `le/check.routes.test.ts`, `le/history.routes.test.ts`, `admin-ui/src/pages/LegalEntitiesPage.test.tsx` | `legal-entities-access.spec.ts` (2), `legal-entities.spec.ts` (2) (pass) | probe: 403 no grant (save, restore), 403 `welld_ch` manager on `welld_it` |
| 4.3 | `authz.routes.test.ts` (`apps` derived), `le/read.routes.test.ts` (`manageable`), `le/history.routes.test.ts` (2), `admin-ui/src/pages/LegalEntitiesPage.test.tsx`, `router.test.tsx` | `legal-entities-access.spec.ts` (4): manager sees Admin with only Legal entities, welld_ch editable, welld_it read-only, `/admin/roles` redirects; no-grant person sees no Admin (pass) | probe: `manageable` = `["welld_ch"]` / `[]` |
| 5.1 | `lh/api/tests/render.rs` (v2 per entity x language), `lh/engine/src/layout/frame/tests.rs`, `crm-api/src/offers/letterheadContract.test.ts` | `crm-legal-entities.spec.ts` service path: footer name, address in the offer's language, grouped IBAN (pass); `letterheads.spec.ts` | contract test vs real service (7 pass); skew A2 PDF text |
| 5.2 | `lh/api/tests/render.rs` `issuer::render_entity_data_of_the_request_is_ignored_in_v1_and_v2_and_the_log_says_so`, `crm-api/src/offers/issuerGolden.test.ts`, `letterheadContract.test.ts` | | skew A2: old crm-api's `entityData` ignored (`entity_data_ignored=true`), registry printed |
| 5.3 | `lh/api/tests/render.rs` `issuer::render_an_empty_iban_or_contacts_is_missing_and_prints_nothing`, `lh/api/tests/preview.rs`, `lh/engine/src/resolve/tests.rs` | `letterheads.spec.ts` missing look and kept segment (pass) | |
| 5.4 | `lh/api/tests/preview.rs` (21 pass), `lh/engine/src/layout/frame/tests.rs`, `letterheads-ui/src/components/PreviewPane.test.tsx` | `letterheads.spec.ts` (4): real details in the preview language, `⟦label⟧` marks, source line, **D2 wrap journey** (pass, both stacks) | |
| 5.5 | `lh/api/tests/render.rs` `issuer::render_registry_down_and_no_entry_is_503_with_retry_after_and_no_document`, `lh/api/tests/registry.rs`, `crm-api/src/lib/legalEntities.test.ts`, `crm-ui/src/pages/OfferWizardPage.legalEntity.test.tsx` | | **outage probe: 503 + `Retry-After` after 60 s**; skew A: old service -> 503, no offer |
| 6.1 | `crm-api/src/entity-profiles/entityProfiles.settings.test.ts`, `entityProfiles.retired.test.ts`, `crm-ui/src/pages/SettingsPage.service.test.tsx`, `components/LegalEntitySettingsNote.test.tsx` | `crm-legal-entities.spec.ts` (3): note, link for a manager, sentence for others (pass, both stacks) | MIG: PUT ignores legal keys; skew B, C |
| 6.2 | `crm-api/src/offers/issuerGolden.test.ts` (52 pass), `contractPdf.test.ts`, `letterheadContract.test.ts` | `crm-legal-entities.spec.ts` (3): classic and service, English address, grouped IBAN (pass) | MIG: PDF carries the registry's name and address |
| 6.3 | `crm-api/src/offers/offers.test.ts`, `crm-ui/src/components/GenerateOfferDialog.legalEntity.test.tsx`, `components/offerWizard/LegalEntityNotice.test.tsx`, `pages/OfferWizardPage.legalEntity.test.tsx` | `crm-legal-entities.spec.ts` (3): refusal, notice with link / sentence, classic dialog (FU-2), saved complete again generates (pass) | MIG: a moved-incomplete entity -> 409 `legal_entity_incomplete`, `missing: ["vatNumber"]` |
| 6.4 | `crm-api/src/offers/offers.test.ts` (hash), `letterheadContract.test.ts` | `crm-legal-entities.spec.ts` "an offer made before the change keeps what it printed" (pass) | contract test: pre-switch offer sha256 identical after a revision and an edit |
| 7.1 | `le/import.test.ts` (runs with `CRM_TEST_DATABASE_URL`) | | § 4: round A to E registry equals the fixture's `expect` (10 cases) |
| 7.2 | `le/import.test.ts`, `le/history.routes.test.ts` ("system"), `admin-ui/.../LegalEntityHistory.test.tsx` | `legal-entities.spec.ts` | `action import`, author NULL, 2 `legal_entity.import` audit rows with actor NULL |
| 7.3 | `le/import.test.ts`, `admin-ui/.../LegalEntityPanel.test.tsx`, `pages/LegalEntitiesPage.test.tsx`, `crm-api/src/offers/offers.test.ts` | | moved incomplete / invalid entities: report flags (§ 4.3), page tabs and banners (§ 8), crm refusal (§ 4.2) |
| 7.4 | `le/import.test.ts` | | second `--apply`: `inserted 0`, no new version or audit row; `mismatched` -> `resolved`; exit codes 0/1 |
| 7.5 | `crm-api/src/offers/issuerGolden.test.ts` (52 pass), `issuerGolden.capture.test.ts`, `le/import.test.ts` | | `ibanPrintChanged` per fixture (2 cases flagged, 8 not); golden comparison § 4.4 |
| 8.1 | `admin-ui/src/pages/LegalEntitiesPage.a11y.test.tsx`, `LegalEntityForm.test.tsx`, `ProtectedChangeDialog.test.tsx`, `RestoreDialog.test.tsx` | `legal-entities.spec.ts` (6: axe on every screen, keyboard only, focus on the first refused control), `protected-legal-details.spec.ts` (axe on both dialogs) (pass) | 320 px no horizontal scroll; contrast >= 5.01:1 both themes |
| 8.2 | `admin-ui/src/strings.test.tsx` (parity, no hard-coded strings), `crm-ui/src/strings.test.ts`, `letterheads-ui/src/strings.test.ts` | `legal-entities.spec.ts` Italian page, `protected-legal-details.spec.ts` Italian dialog and notice (pass) | Italian twin of the notice in the centre (§ 6) |
| 9.1 | `le/check.routes.test.ts`, `admin-ui/.../LegalEntityForm.protected.test.tsx`, `ProtectedChangeDialog.test.tsx`, `lib/legalEntitiesApi.test.ts` | `protected-legal-details.spec.ts` (3) (pass) | skew D: the check is asked first |
| 9.2 | `LegalEntityForm.protected.test.tsx` | `protected-legal-details.spec.ts` (2): Cancel, Escape, close store nothing (pass) | |
| 9.3 | `LegalEntityForm.protected.test.tsx` (2) | `protected-legal-details.spec.ts` (4): **Confirm saves** (D3), refusal before the dialog, conflict after it (pass) | |
| 9.4 | `admin-ui/.../RestoreDialog.test.tsx` (2), `ProtectedChangeModel.test.ts` | `protected-legal-details.spec.ts` (3) (pass) | |
| 9.5 | `le/check.routes.test.ts` (2), `le/rules.test.ts`, `LegalEntityForm.protected.test.tsx` | `protected-legal-details.spec.ts` (pass) | |
| 9.6 | `ProtectedChangeDialog.test.tsx`, `RestoreDialog.test.tsx`, `ProtectedChange.it.test.tsx`, `LegalEntitiesPage.a11y.test.tsx` | `protected-legal-details.spec.ts` (6): focus in and back, announced (accessible description holds Old and New: D-T68-2), axe, Italian (pass) | |
| 9.7 | `le/notices/duty.test.ts` (2), `le/notices/dispatcher.test.ts` | `protected-legal-details.spec.ts` (6): within 60 s, page / direct call / restore | all 9 rows `delivered` at attempt 1 when read 12 s after the save (the e2e asserts the 60 s bound); rows are written in the version's transaction (`le/notices/duty.test.ts`) |
| 9.8 | `le/notices/recipients.test.ts`, `dispatcher.test.ts` | `protected-legal-details.spec.ts` "who is not told" (pass) | managers + administrators, not the other entity's manager, not the no-grant person (§ 6) |
| 9.9 | `le/notices/duty.test.ts` | `protected-legal-details.spec.ts` (2) | the actor has rows and the notice |
| 9.10 | `le/notices/duty.test.ts`, `recipients.test.ts`, `dispatcher.test.ts` | | outside address: one email row, no in_app; delivered |
| 9.11 | `le/notices/content.test.ts` (2), `le/ibanTail.test.ts`, `copy.test.ts`, `notify-api/src/system/emailTemplates.test.ts`, `emails.routes.test.ts` | `protected-legal-details.spec.ts` | the facts read from the real in-app and email notices (§ 6) |
| 9.12 | `le/notices/content.test.ts`, `duty.test.ts`, `dispatcher.test.ts`, `copy.test.ts`, `le/ibanTail.test.ts` | `protected-legal-details.spec.ts` (4 value-free assertions) | **0 hits** of 27 forbidden values over every record and log (§ 6), positive control found |
| 9.13 | `le/notices/copy.test.ts`, `dispatcher.test.ts`, `notify-api/src/system/emails.idempotency.test.ts`, `notifications.idempotency.test.ts` (push) | `protected-legal-details.spec.ts` (centre, Italian when the shell is Italian) | in_app `it` + `en`, email in English incl. outside; push: not on compose (§ 6) |
| 9.14 | `le/notices/dispatcher.test.ts` (5), `duty.test.ts`, `notify-api/.../emails.idempotency.test.ts`, `notifications.repo.idempotency.test.ts`, `le/write.routes.test.ts` | | notify-api down: 201 same shape; retries +1, +3 min; give-up at +25 h (injected clock); `kill -9` durability; no duplicate through 3 attempts |
| 9.15 | `le/notices/duty.test.ts`, `dispatcher.test.ts` | | 9 `notice_failed` (first failure only), 9 `notice_delivered`, 9 `notice_given_up`, each without a value |
| 9.16 | `le/notices/duty.test.ts` (2), `dispatcher.test.ts` | | the import, first and repeated, 5 rounds: 0 notice rows |
| 9.17 | `le/check.routes.test.ts`, `le/write.routes.test.ts`, `le/notices/duty.test.ts`, `admin-ui/.../LegalEntityForm.protected.test.tsx` | `protected-legal-details.spec.ts` (3) (pass) | the no-op save created no version and no row |

Dependency audit note (the gate "dependency audit"): the diff changes one JS manifest, admin-ui's `package.json`/lockfile, adding the
devDependency `axe-core ^4.14.1`; it appears in no advisory. `pnpm audit` of admin-ui reports 25 (16 high) advisories in the unchanged
transitive tree (`brace-expansion`, `vite`, `js-yaml`, ...), and crm-ui 2; neither is introduced by this feature and the CI runs no JS audit.
Cargo: `Cargo.lock` unchanged by the feature.

## 10. F2 to F7, FU-1 to FU-13, D1 to D3, the orchestrator's decisions

| Item | Status | Evidence |
|---|---|---|
| F2 deleted person loses the registry at once | closed | `le/write.routes.test.ts` "a soft-deleted holder with a live session is 403 ..." (auth suite green) |
| F3 throttle and paging | closed | `write.routes.test.ts` (429 + `Retry-After`), `history.routes.test.ts` (pages of 50, `before`), admin-ui `LegalEntityHistory.paging.test.tsx`; probe `?limit=50`. The 11th-save-in-10-minutes limit is raised to 1000 on my stack (as `auth/.env.example`'s e2e value); proved by unit test only |
| F4 committed test groups guarded by host | closed | `testDb.ts` `isLocalDatabaseHost` / `committedTransactionsSkipReason`, applied in `write.routes.test.ts`, `notices/dispatcher.test.ts`, `notices/duty.test.ts`: the groups ran here on `localhost` (auth suite, 0 skips) and skip with one line elsewhere. Not exercised against a remote host (never touch one) |
| F5 copy role, `updatedBy`, IBAN tail line | closed | § 4: role limits proven; audit `source.updatedBy`; `IBAN …1234` lines; no full IBAN in any log |
| F6 pin-mismatch refresh coalesced | closed (with T76) | `lh/api/tests/registry.rs` `registry_forced_refreshes_are_budgeted_per_ten_minutes_and_the_window_slides` and the 1 s test; 47 pass |
| F7 AuditPage shows before/after | closed | `admin-ui/src/pages/AuditPage.test.tsx` |
| FU-1 crm-ui overflow copy | closed | strings say "Legal entities page"; e2e FU-1 journey passes on the service stack |
| FU-2 classic dialog link | closed | e2e `the classic Generate dialog shows the notice, with the link for a manager` (classic stack, pass) |
| FU-3 320 px | closed | § 8 |
| FU-4 `toCorrect.title` | closed | design.md amended; the page shows "Some values need correcting" (§ 8) |
| FU-5 ADR candidate (how a layout draws the missing mark) | **routed, no code** | not written yet: architect / adr-writer |
| FU-6 `DOCUMENTED_CLIENT_SCOPES["crm-api"]` | closed | `auth/src/system/serviceClients.ts` lists `letterhead:render` |
| FU-7 admin-ui string gaps | closed | `strings/legalEntities.ts` has the moved suffix and the conflict phrases; admin-ui suite and the Italian e2e green |
| FU-8 `LegalEntitiesPage.test.tsx` | closed | admin-ui suite green |
| FU-9 sample intro | closed | the page snapshot's intro: "The company's details in it are the real ones; a detail that is not filled in yet is marked."; no "(SAMPLE)" claim left |
| FU-10 `getAuthBaseUrl` cast | closed | declared in `letterheads-ui/src/federation/remotes.d.ts`, stub exported |
| FU-11 copy-role SQL untested | **closed by this QE** | § 4.1 |
| FU-12 flaky server start | decision in § 11 | |
| FU-13 `crm-offer-wizard-pages.spec.ts:380` | confirmed unrelated | § 5: the failing control reads the letterhead fixture alone |
| D1 TrieRouter | closed | `auth/src/auth/auth.mount.test.ts` green; every e2e journey goes through the assembled app |
| D2 wrapped missing label | closed | engine test green; e2e wrap journey passes on both stacks |
| D3 Confirm must save | closed | e2e journeys pass; no nested `<form>` unit test green |
| Design decisions DR-13..DR-18, ConfirmDialog busy | as recorded | no QE action; `axe` clean on both dialogs |
| T70's N2 | closed (T76) | see F6 |
| T70's N1 (display name editable) | **open, owner decision**, confirmed exploitable | **O-1** |

## 11. FU-12 decision, defects in tests, tests changed

### FU-12 (flaky `render.rs:680`): reproduced; the cause is not the one the follow-up guesses

- Line 680 is `panic!("letterhead-api exited at start ...")`, i.e. the spawned server **exits** before `/health`; waiting longer cannot help.
- Reproduced under load: with two instances of the `render` test binary at once (each its own database) 24 of 40 tests fail every time
  (3 of 3 rounds, with and without CPU burners), and the panic text is `letterhead-api exited at start (exit status: 1): ["letterhead-api:
  the database did not answer in time"]` (or `migrate: Execute(PoolTimedOut)` one step earlier). One instance, even with 8 CPU burners
  (4 of 4 rounds), passes 40/40.
- Cause: **Postgres connection exhaustion**, not a start-up timeout and not a port race. Sampling `pg_stat_activity` during one single
  instance shows **100 client backends = `max_connections`** (compose's default), because ~40 tests start a server (own pool) at once; the
  server's pool gives up after `acquire_timeout(5 s)` (`api/src/db/repo.rs:116`) and exits. A few other clients on the shared
  compose Postgres (another session's suite, an e2e stack) tip it over, which is what "failed once under parallel load in two runs"
  looks like. CI has a Postgres per job, so it is green, but one instance peaks at the cap there too (little margin).
- The port-race hypothesis: simulated (`free_port` = bind 0, read, drop, bind later; 32 threads, 0.3 s and 1.5 s start-up) **0 failed
  binds in 13 200 starts** on macOS.
- **Recommendation** (test code and compose, no product change; owner: dev for the test, devops for compose): (1) do **not** widen the
  `/health` wait; (2) in the `render.rs`/`preview.rs`/`read.rs`/`write.rs`/`residue.rs` helpers that spawn the binary, bound the number
  of servers starting at once (a process-wide semaphore of about 4) or give the spawned server a smaller pool through its environment;
  (3) for machines where several sessions share the compose Postgres, set `max_connections` to 200 in `compose.yaml`
  (`command: postgres -c max_connections=200`). Not a defect of the feature; not blocking.

### Defects in test code found because the stack was fresh (all fixed by QE, `shell/e2e` only)

| # | Test | Symptom on a fresh stack | Root cause | Fix |
|---|---|---|---|---|
| T-1 | `legal-entities.spec.ts` "an administrator reaches the page ..." | fails at `Version 1 · saved by`; the page says "Version 1 · moved from the CRM by the system" | asserted that the current version was a save by a person; on a registry nobody has saved since the move it is the move's version 1 (AC-7.2 says exactly that) | the line must match `Version N · (saved by\|moved from the CRM by the system)` |
| T-2 | `fixtures/letterheads.ts` `recordPreviewCalls`, hit by `letterheads.spec.ts` "Italian when the browser asks for it" | 6 of 6 runs fail: `request.response: Target page, context or browser has been closed` | the response promise of the last preview rejects when the journey ends and closes its context, an unhandled rejection charged to the test | `.catch()` the promise to `status: 0`, which every journey that checks a status still fails on |
| T-3 | `letterheads.spec.ts` D2 "a missing label that wraps ..." | the preview is refused 422 `footer_overflow` ("does not fit the bottom margin, checked with every placeholder replaced by 40 characters"), the journey never sees its text | it relied on a bottom margin of 45 mm left by `crm-legal-entities.spec.ts` on the **service** stack; a letterhead nothing has changed yet has a margin too small for `{iban} {contacts}` | the journey sets the Bottom margin to 45 itself; with it the engine's D2 fix is shown to work on both stacks |
| T-4 | `crm-legal-entities.spec.ts` overflow journey `afterAll`, hit by the next file's first journey (`letterheads.spec.ts` "sample document") | the configurator preview shows "footer does not fit" for the first 30 s after the overflow journey, test times out | `afterAll` saves the normal legal name back and does not wait out the services' registry caches (AC-3.3: up to 60 s), so the next file starts while the service still holds the 200-character name. Inferred, not caught in the act: the letterhead-api log shows renders pinned to version 63 refused `header_overflow`, the same journey passes when re-run 100 s later, and the full sequence passes with the fix | `settle()` at the end of `afterAll` (with `test.setTimeout(120_000)`) |

T-3 and T-4 are the same class: a journey depending on state left by another spec or stack. None of the four is a product defect.

### Files changed by QE (committed)

`shell/e2e/legal-entities.spec.ts`, `shell/e2e/fixtures/letterheads.ts`, `shell/e2e/letterheads.spec.ts`,
`shell/e2e/crm-legal-entities.spec.ts`. After the edits: `pnpm lint` and `tsc -p tsconfig.e2e.json --noEmit` in `shell` are clean, and
the specs ran green (§ 5). No test was skipped, weakened or deleted; no threshold touched; no production code changed.

## 12. Findings that are not defects of an AC

- **O-1 (T70's N1, owner decision, confirmed live).** A signed-in person can change their own display name through Better Auth's
  `POST /auth/update-user`: with a plain session cookie it answered `200 {"status":true}` and `get-session` returned the new name
  ("IT Security (verified)"). The notice names the actor by that name (AC-9.11 "the person's name, as the history shows it"), so a holder
  of a stolen manager or administrator session can make the notice say another person's name. The review left the choice to the owner
  (make the name read-only to its owner, or add the actor's email to the notice). This is not a failure of any AC as written, but it
  weakens the control US-9 exists for, so it must be decided **before release step 7 (T71)**, when managers other than `admin` may be
  granted. (I restored the test user's name.) Owner: owner, then backend-dev.
- **O-2 (R5, new crm-ui + old crm-api).** While push 2's services come up in no order, a person who saves CRM **Settings** with the new
  crm-ui against the old crm-api gets the raw message `legalName: Invalid input: expected string, received undefined` (the old crm-api
  requires keys the new form no longer has). Nothing is stored or lost, and it is the safe outcome: do **not** "fix" it by sending blank
  legal keys from crm-ui, which an old crm-api would write over the CRM's real values and break the freeze gate. R5 promises only the
  old context answer, which works. Suggest one line in the runbook's Step 5 ("for a few minutes saving CRM Settings may answer 422") or
  deploying crm-api first. Owner: architect/devops (docs).
- **O-3 FU-12**: § 11.
- **O-4 (outside the feature, shell footer).** The 11 px footer text of the shell measures 3.01:1 (light) and 2.79:1 (dark) against its
  background, under 4.5:1. Pre-existing chrome, not on the Legal entities page; for the designer.
- Documentation nits seen on the way, none blocking: notify-api's `bun test` needs five environment variables that nothing lists;
  the letterhead contract test needs `--timeout` against a debug-build service; runbook step 3a's `\password` cannot be scripted (fine for
  an operator at a terminal).
- An old (`origin/main`) notify-api accepts the new in-app notification without idempotency; in the one pairing where that matters
  (new auth + old notify-api) the in-app rows were delivered once and are final, so no duplicate follows the notify-api upgrade.

## 13. Recommendations

- `owasp-reviewer` pass: **not needed again** for this feature (T70 stands and I changed no product code). Re-check only if O-1 is
  fixed by configuration or code (a small diff). The release order of G15 and the Constraint "no `legal-entity:manage` to anyone but
  `admin` before step 7" stand, with O-1 decided first.
- Routing: O-1 owner then backend-dev; O-2 architect/devops (runbook); FU-12 dev (test helpers) and devops (compose); FU-5 architect
  (ADR); O-4 designer.

## 14. How this was run (to reproduce)

Unit: the commands of § 3. Stack: `db:release` of auth, `db:deploy` of crm-api, notify-api, activities-api, letterhead-api `migrate`;
`bun run src/index.ts` for the four TypeScript services with a local env (a throwaway RSA pair, `SERVICE_CLIENTS` with `crm-api`
(`activities.write letterhead:render legal-entities:read`), `letterhead-api` (`legal-entities:read`), `notify-api` (`users.contact`),
`activities-api`), letterhead-api's binary, `vite preview` of the shell and nine remotes as `playwright.config.ts` builds them;
Playwright `-c` a scratch config with `executablePath` of the installed chromium (deleted afterwards). The import for the e2e registry
was run once by hand because `mise` is not trusted in worktrees (`bun run scripts/import-crm-legal-details.ts --apply` with both URLs).

## 15. QE delta 2026-11-18 (T77)

Scope: the one product-code change after § 1: `da0b000c` (T77, `letterhead-api/api/src/registry/cache.rs`: a pin-forced refresh keeps the
held entry as the fallback of that refresh; `PIN_REFRESH_BUDGET` 100 -> 30 per 10 min per process), at branch head `b682c810` (`le/QD`).
Everything ran locally (compose Postgres :5435, local MinIO, throwaway secrets); the stack I started was stopped afterwards. No product code
was changed and no test was added (T77 came with its own: `registry.rs` +5, `render.rs` +1).

### 15.1 Delta verdict

## QE delta verdict: PASS (T77); one CI red triaged as a pre-existing test race, outside this feature

| Check | Threshold | Actual | Result |
|---|---|---|---|
| letterhead-api `cargo fmt --all --check` | exit 0 | exit 0 | ✓ |
| letterhead-api clippy `--workspace --all-targets --locked -D warnings` | exit 0 | exit 0 | ✓ |
| letterhead-api `cargo test --workspace --locked -- --skip conformance:: --test-threads=4`, DB required, MinIO, real `pg_dump` for the residue test | 0 fail | **713 pass** / 0 fail / 1 ignored (api unit 152, preview 21, read 15, **registry 52** (was 47), **render 41** (was 40), render_migrate 5, residue 4 (+1 `#[ignore]`), write 23, engine 376, corpus 24); was 707 at T45: +6 = T77's tests | ✓ |
| CI "Worst-case table" step, locally: `cargo test --release -p letterhead-api --test pool --test render -- --test-threads=1` | 0 fail | pool **38 pass**, render **41 pass** (82.7 s) on an idle machine | ✓ |
| Live AC-5.5 / AC-6.2 rehearsal of the fallback (§ 15.2) | per the T77 rule | as specified at every probe; 60 s boundary, recovery and hung-auth variant included | ✓ |
| crm-api pin path: `issuerGolden.test.ts`, `generation.letterhead.test.ts` (+ `legalEntities.test.ts`, `letterheadClient.test.ts`) | 0 fail | 52 + 44 + 29 + 29 = **154 pass** / 0 fail | ✓ |
| CI run 44231760303 red (`pool_replaces_a_worker_killed_while_idle`) | explained | reproduced; pre-existing, identical on `origin/main` (§ 15.3); not a defect of this feature | ✓ (triaged) |

Not run (as in T45): the conformance suite (needs the pinned pdfium, so `LETTERHEAD_REQUIRE_PDFIUM` was not set; CI runs it) and `cargo audit` (no
dependency or lockfile change since T45).

### 15.2 Live rehearsal of the T77 fallback (AC-5.5, AC-6.2)

Stack: auth (`bun`, `ENABLE_TEST_AUTH`, a copy of the T45 e2e database as `auth_qd_t` with `welld_it` at version 32, migrated and seeded at this head),
letterhead-api **release build** of the head (`letterhead_qd_live`, bucket `letterhead-qd-live`, default letterhead v1 for `welld_it`),
crm-api with `LETTERHEAD_SERVICE_ENABLED=true` (`crm_qd_t`, a copy of the T45 database) and activities-api (the estimate override needs it);
`SERVICE_CLIENTS` throwaway (`crm-api`: `letterhead:render legal-entities:read activities.write`; `letterhead-api`: `legal-entities:read`).
Probes of the service called it directly with `crm-api`'s service token (`POST /v1/render/pdf`, a v2 body, optional `legalEntityVersion` pin);
the crm-api leg is `POST /deals/{id}/offer-draft/preview` (it goes through `withIssuerPin`). Sequence (clock `+t` from the held entry's send):

1. 32 s idle so that no cache holds a fresh entry; **+0** direct render: the service reads auth, holds **version 32** (the auth log shows the read at that instant).
2. +0.03 s an admin saves **version 33** (201). +1.3 s crm-api restarted (empty cache); it reads the registry through `GET .../offer-wizard/context`
   (200: crm-api now holds 33, fresh). +1.6 s **auth stopped** (SIGTERM; health: connection refused).
3. +2.0 s crm-api preview (pin 33, newer than the 32 held): the service answers **409 `legal_entity_version_mismatch`**
   (crm-api log: `[letterhead] ... answered HTTP 409`), crm-api drops its cache, waits, and reads the registry again (auth down):
   **503 `legal_entities_unavailable`, `Retry-After: 5`, 1130 ms in all** (crm-api log: the 409 at `...007.170`, the failed second read at `...008.276`: **1.106 s** between).

| Held entry's age | direct unpinned | direct pin 32 (matching) | direct pin 33 (newer) |
|---|---|---|---|
| +3 s | 200, v32, 18 ms | 200, v32, 13 ms | **409, `currentVersion` 32**, 1 ms |
| +20 s | 200 v32 | 200 v32 | 409, `currentVersion` 32 |
| +45 s | 200 v32 | 200 v32 | 409, `currentVersion` 32 |
| +57 s | 200 v32 (service log `registry_stale_used age_ms=57000`) | 200 v32 | 409, `currentVersion` 32 |
| **+63 s** | **503 `legal_entities_unavailable`, `Retry-After: 5`** | **503** | **503** |
| +73 s | 503 | 503 | 503 |

4. +73.3 s **auth started** (healthy at once; down 71.7 s in all). +73.9 s: direct unpinned **200, v33** (42 ms), pin 33 200, pin 34 (newer than any) 409
   `currentVersion` 33, crm-api preview **200** (27 ms). Recovery needed nothing but auth coming back.

Notes on what the rehearsal showed:

- **Expectation corrected.** The brief expected crm-api's retry to end in `layout_service_unavailable`. With auth fully down it ends in
  **`legal_entities_unavailable`** (503 with `Retry-After: 5`): `withIssuerPin` drops crm-api's own registry cache before its one retry
  (by design, so the document is rebuilt from fresh details), and the second read of the registry fails first. The safety is the same
  (a 503, nothing printed, no offer number used); `layout_service_unavailable` is what the retry yields only when crm-api can read the
  registry and the service still prints another version. Both are "try again later" answers; nothing to fix.
- crm-api's own calls after +57 s answered 503 in 1 ms from its authorization (it asks auth for the caller's grants and that cache had
  expired): crm-api's existing fail-closed behaviour with auth down, not the registry path; it says nothing about T77.
- **Hung auth (SIGSTOP) variant**, auth accepts connections and never answers: the forced refresh waits the 5 s `REFRESH_TIMEOUT`, then the
  caller that forced it gets **409, `currentVersion` 33, after 5004 ms**, and the unpinned and matching-pin calls that arrived meanwhile are
  **200 (4735 ms and 4415 ms: they wait for the same flight, then use the held entry)**; later calls each cost one 5 s timeout and are 200 up to
  the entry's 60th second (5015 ms at +52 s), **503 `legal_entities_unavailable` at +66 s (5005 ms)**; after SIGCONT 200 in 25 ms. Each call
  through a failing auth costs 5 s: unchanged by T77 (it is the stale-entry rule of AC-3.3), noted so nobody is surprised by it.
- A first attempt of the SIGSTOP run sent the pin within 1 s of the entry's send; the service answered 409 in 0 ms without calling auth: the
  "entry sent less than 1 s ago" guard, working as designed (so the real run waited 1.2 s).
- Budget (30 per 10 min): covered by T77's test `registry_a_failed_forced_refresh_still_counts_for_the_second` and the registry suite
  (52 pass); not exercised live (30 forced refreshes would only repeat it).

### 15.3 CI run 44231760303: `pool_replaces_a_worker_killed_while_idle` (`api/tests/pool.rs:1084`, `served: WorkerFailed`)

**Verdict: a pre-existing race in the test (and in what it assumes of `kill -9`), not caused by T77 and not by this feature. It is not a defect of an AC.**

- The run: workflow_dispatch of `feat/legal-entities` at `f2912337` (contains T77); the debug "Test" step green, the release "Worst-case table"
  step red with 37 pass / 1 fail: exactly this test. Of the last 12 runs of the workflow it is the only one red in that step (the other red
  one, 44151961530, failed in the "Test" step, another cause).
- **Untouched by this feature**: `git diff origin/main -- letterhead-api/api/src/pool letterhead-api/api/tests/pool.rs` is only 30 added lines in `pool/job.rs`
  (job fields); `Lease::ensure_worker`, the test and the harness are identical to `origin/main` (`56fbbfa3`). The test came with `f2b83fd6`.
- **Reproduced, release mode, this machine (24 cores, macOS arm64):**

| Binary | Condition | Runs | Failed | Panic |
|---|---|---|---|---|
| branch head (release `--test pool`) | idle | 200 | **0** | |
| branch head | 30 busy-loop processes on 24 cores | 50 (a first batch: 100) | **18 of 50** (first batch 44 of 100) | `api/tests/pool.rs:1084:65: served: WorkerFailed`, every time |
| `origin/main` (temporary worktree `../le-QD-qdmain`, own target dir; both removed) | 30 busy loops | 50 | **23 of 50** | the same panic, the same line |
| `origin/main` | idle | 100 | **0** | |
| branch head | idle | 100 more | **0** | |

  Same test, same panic, same rate on `origin/main` and on the branch; it needs CPU contention (a shared CI runner).
- **Root-cause hypothesis (supported by a measurement, not proven on the CI runner itself).** The test does `kill -9 <idle worker pid>` and, as soon as
  the `kill` command returns, renders. `kill` returns when the signal is *queued*; the target dies when it is next scheduled. `Lease::ensure_worker`
  (`api/src/pool/mod.rs:447`) decides "the worker died between jobs" with `child.try_wait()`, which says "still running" until the process is
  really dead; the pool then hands the job to the dying worker, the exchange breaks (`Exchange::Broken`) and the job is answered
  `PoolError::WorkerFailed` (a job is not retried on another worker). Independent measurement (a 20-line Rust program with the same sequence: spawn,
  external `kill -9`, immediate `try_wait`; 2000 tries, machine idle): the child was still reported alive **1046 times on macOS and 734 times on Linux
  (rust:1.100 container, aarch64)**. On an idle machine the test usually survives because the tokio hops between the `kill` and `ensure_worker`
  take longer than the target's exit; under contention the exit is delayed past them (0 of 400 idle, 36-46 % under load).
- **What it is, and who owns it.** The comment in the test ("The dead worker is reaped when the pool next looks at it") describes the product's
  design correctly; the *test* is what is wrong: it does not wait for the death it provoked (it should wait on the condition, e.g. poll until
  `kill -0` fails or the process is a zombie, before it renders; not a sleep). What the product should do for a job lost to a worker that dies
  between the liveness check and the write (today `worker_failed`, no retry) is a design question, not a defect of this test.
  **Owner: backend-dev (test helper in `api/tests/pool.rs`, wait on the condition); architect only if the product should retry such a job on a fresh worker.**
  Not to be "fixed" by a retry of the test, a skip or a longer sleep. Priority: low (CI-only flake; the job is re-runnable).
- It does not change the T77 verdict: the same two targets, run again on an idle machine, pass (pool 38, render 41).

### 15.4 What this run left behind (local, safe to drop)

Postgres databases on the compose container: `auth_qd`, `crm_qd`, `auth_qd_live`, `crm_qd_live` (created by mistaken first attempts, migrated, otherwise empty),
`auth_qd_t`, `crm_qd_t`, `activities_qd`, `letterhead_qd_live`; MinIO bucket `letterhead-qd-live`; the database `letterhead_le_qd` and bucket `letterhead-le-qd` of the
test run. (A hook of this environment blocks destructive SQL, so they are left.) `node_modules` and generated Prisma clients of `auth`, `crm-api`, `activities-api` in
this worktree (gitignored). No server of mine is running and no busy-loop process remains; the `origin/main` worktree and its build directory are removed.

### 15.5 Defects, environment faults, recommendations

Defects: none against T77 or an AC.
Environment faults: none (the red CI test is a race that reproduces on `origin/main`; § 15.3 gives it under its owner, not as a defect of this change).
`owasp-reviewer`: not needed again for T77 (no input, auth or dependency change; the budget change tightens a limit reviewed in T70).
Routing: pool test race, backend-dev (test), with an architect question on retrying a job lost to a dying worker (§ 15.3).
