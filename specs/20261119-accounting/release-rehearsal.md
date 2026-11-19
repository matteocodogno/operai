# Release rehearsal on scratch databases (T76, specs/20261119-accounting)

Date: 2026-11-19. Code: `feat/accounting-module` at `e84c4d65` (rehearsed from the worktree branch `feat/accounting-so-reh`, same commit).
Result: PASS. Every expectation of the task held; one cosmetic wording defect (D-1) and two environment notes (E-1, E-2) at the end.

## Set-up and what is real

- Databases: `accounting_reh` and `refund_reh`, created for this rehearsal on the isolated container `operai-accounting-test-pg`
  (127.0.0.1:5446). The `refund`, `auth` and `accounting` databases there, and :5435 and :5445, were not touched. Both
  scratch databases were dropped at the end, and the server then listed only `accounting`, `auth`, `postgres`, `refund`.
- Accounting side: the **real accounting-api** (`bun run src/index.ts`, `NODE_ENV=development`, port 18092, free before the start,
  stopped after) on `accounting_reh`, with `ACCOUNTING_FX_SOURCE=off` (no outbound call).
- Auth side: no `auth` service is reachable without network and secrets, so a **stand-in `auth`** (loopback, port 18091, free before
  the start, stopped after) served only what the contract needs: the JWKS and `POST /system/service-token` (RS256 service JWT,
  `sub=system:refund-api`, `aud=operai-service`, `scope=accounting.reference.read`, 5 minutes), with a placeholder client secret.
  So the path is the production one except that `auth` itself is a stand-in: the script mints a token, accounting-api verifies it
  against the JWKS with its real `systemAuth` middleware, and reads reference data and rates over HTTP. accounting-api's own
  log shows 6 `GET /system/v1/entities/welld_ch/reference-data` and 4 `.../rates` calls, all `caller=system:refund-api`, no
  verification failure, no 5xx. This is the realistic option short of the live `auth` (not the in-process `fakeAccounting` port,
  which `accounting-release.test.ts` already uses).
- Refund side: `bun run accounting:release` from `refund-api/` with `NODE_ENV=development`, `DATABASE_URL` on `refund_reh`,
  `AUTH_BASE_URL` on the stand-in, `ACCOUNTING_INTERNAL_URL` on accounting-api, placeholder `SERVICE_CLIENT_*`.
- Rate typed by hand (the FX source is off, so there is no fetched rate): one `corrected` EUR rate for 2026-03 = 0.940000 inserted in
  `accounting_reh`. EUR 2026-04 deliberately has none.
- The baseline file (`email,year,lastIssuedSeq`, one synthetic employee at 081) lives outside the repository, in the session scratchpad.

All names below are synthetic (`example.invalid` addresses, ids `u-reh-*`); the report is the script's default masked one
(`<initials> · <first 8 characters of the user id>`, no `--show-emails`).

## Steps

### 0. Migrate both

| Command (from the package directory) | Exit | Result |
| --- | --- | --- |
| `DATABASE_URL=…/accounting_reh bun run db:deploy` (accounting-api) | 0 | init migration applied, "All migrations have been successfully applied." |
| `DATABASE_URL=…/refund_reh bun run db:deploy` (refund-api) | 0 | 13 migrations applied, the last three being `20261119200000_expense_types_flight_taxi`, `20261119200100_receipt_number_baseline`, `20261119200200_vat_defaults_retired` |

### 1. `seed:welld-ch` on `accounting_reh`

| Command | Exit | Key lines |
| --- | --- | --- |
| `bun run seed:welld-ch --dry-run` | 0 | `ledger accounts: 19 in the seed, 19 added, 0 already there`; `vat codes: 6 in the seed, 6 added, 0 already there`; `dry run: nothing was written`. Rows after: 0 accounts, 0 VAT codes. |
| `bun run seed:welld-ch` | 0 | same counts, `done`. Rows after: 19 accounts, 6 VAT codes, 0 status changes. |
| `bun run seed:welld-ch` (rerun) | 0 | `19 in the seed, 0 added, 19 already there`; `6 in the seed, 0 added, 6 already there`; `added: none`. Rows after: 19 and 6, unchanged. |

VAT codes added: `IPM81, IPM77, IP00, BZM81, IPM26, IPM38`. A query for `IMP81` or `NOVAT` in `vat_code` returns 0 rows.

### 2. Pre-release state of `refund_reh` (synthetic legacy lines)

Written with Prisma, in the shape of the CLI test's `legacyRequest` helper: 5 requests, 12 lines, 3 synthetic employees.

| Employee | Request | Lines |
| --- | --- | --- |
| Alpha (the one with the baseline) | approved | telephone CHF 03-10, train CHF 03-02, flight EUR 03-05, taxi EUR 04-07 |
| Alpha | paid | office material CHF 02-11 |
| Beta (no baseline) | approved | representation gifts CHF 03-03 (no default account), train EUR 03-03, postal CHF 03-03, one rejected line (stationery 03-04) |
| Gamma | paid | postal CHF 01-20, one WellD Italia line (train CHF 01-21) |
| Gamma | submitted | train CHF 05-02 (not a legacy line) |

Before step (a): 0 numbered lines, 0 baseline rows, 0 defaults, 0 marker, 0 counters. 9 legacy WellD CH lines are eligible
(11 WellD CH lines, less the rejected one and the one of the submitted request).

### (a) Without `--offsets`: exit 3, nothing written

```
$ bun run accounting:release
exit=3
accounting:release stopped: the list of last hand-issued 2026 numbers is missing: nothing was numbered (AC-7.4). Run it again with --offsets <csv> (a file with only the header line `email,year,lastIssuedSeq` states that there are none)
```

State before and after: identical (0 numbered lines, 0 baseline rows, 0 defaults, 0 marker, 0 counters, 0 accounts, 0 rates copied).

Also, `bun run accounting:release --dry-run` without the list: **exit 3**, report says `BLOCKED: list missing`, `Legacy WellD CH lines the
real run would number once the list is given: 9`, `Release marker written: no (blocked: the list is missing)`; nothing written.

### (b) `--dry-run` with a synthetic baseline (Alpha at 081): report, nothing written

```
$ bun run accounting:release --dry-run --offsets <list: one employee, 2026, 81>
exit=0
DRY RUN: nothing was written. This is what the real run would do.
  ledger accounts: 19 active of 19 / VAT codes: 6 active of 6 / exchange rates asked for 2 (currency, month) pairs
  type defaults set (13): travel_highway, travel_km, travel_parking, travel_train, travel_other_public_transport, travel_flight, travel_taxi, company_manuals, stationery, representation_meals, office_material, postal, telephone
Baseline: last hand-issued 2026 numbers (1)
  AA · u-reh-al 2026: numbering continues after 81 (applied)
Numbered legacy WellD CH lines (9)
  AA · u-reh-al 2026: 5 lines, AA26/082 to AA26/086
  BB · u-reh-be 2026: 3 lines, BB26/001 to BB26/003
  CG · u-reh-ga 2026: 1 lines, CG26/001 to CG26/001
Rate pending: 1 lines
  AA26/086 AA · u-reh-al 2026-04-07 travel_taxi EUR
Left without an account (1)
  BB26/001 BB · u-reh-be 2026-03-03 representation_gifts CHF: missing account
WellD Italia lines of approved or paid requests left without a number: 1
Release marker written: no (dry run: the real run would write it)
```

The per-line table of the dry run (number, date, type, currency, account, rate): AA26/082 2026-02-11 office_material CHF 6101 ·
AA26/083 03-02 travel_train CHF 5901 · AA26/084 03-05 travel_flight EUR 5902 rate 0.9400 · AA26/085 03-10 telephone CHF 6102 ·
AA26/086 04-07 travel_taxi EUR 5903 rate pending · BB26/001 03-03 representation_gifts CHF no account · BB26/002 03-03 travel_train
EUR 5901 rate 0.9400 · BB26/003 03-03 postal CHF 6104 · CG26/001 01-20 postal CHF 6104. Alpha's order is by expense date (the paid
February line comes first), then continues after 081.

State after: 0 numbered lines, 0 baseline rows, 0 defaults, 0 marker, 0 counters. Nothing written.

### (c) Real run: numbers continue from N+1, copies, marker

```
$ bun run accounting:release --offsets <same list>
exit=0
Accounting release completed.
Baseline: ... AA · u-reh-al 2026: numbering continues after 81 (applied)
Numbered legacy WellD CH lines (9): AA26/082 to AA26/086 (5), BB26/001 to BB26/003 (3), CG26/001 (1)
Rate pending: 1 lines (AA26/086)
Left without an account (1): BB26/001 representation_gifts
WellD Italia lines of approved or paid requests left without a number: 1
Release marker written: yes
```

The report is identical to the dry run's (R1), apart from the header and the marker line. Database after:

- 9 numbered lines; 1 baseline row (value 81); 13 type defaults; marker `accounting-release-completed-at` written by `system:accounting-release`; 3 receipt counters
  (Alpha: `lastSeq 86, startAfter 81, set by baseline`; Beta: 3; Gamma: 1).
- Account-only classification copies: 8 lines carry account number and name (`ledgerAccountIsDefault = true`); the gift line has none and
  is listed; **0 lines carry a VAT code copy**.
- Rate copies: AA26/084 and BB26/002 (EUR, March) carry `fxRateMicros = 940000`; AA26/086 (EUR, April) has none = rate pending; CHF lines have none.
- Untouched: the rejected line, the line of the submitted request and the WellD Italia line (no number, no account).

### (d) Rerun: no-op

```
$ bun run accounting:release --offsets <same list>
exit=0
The release marker was already set: this run only completed what was left.
exchange rates asked for 0 (currency, month) pairs of the legacy lines
type defaults set (0): none
Baseline: ... AA · u-reh-al 2026: numbering continues after 81 (already-applied)
Numbered legacy WellD CH lines (0) / Rate pending: 0 lines / Left without an account (0)
Release marker written: no (already set)
```

`--dry-run` rerun: exit 0, same "already set" report. An md5 over every row of `refund_line`, `refund_setting`,
`receipt_number_baseline`, `receipt_counter`, `expense_type_accounting_default` and `refund_audit_entry` (18 rows) taken before and after
both reruns is **identical**: nothing changed, not even a second marker.

### Extra: Accounting unreadable (not asked, cheap)

`ACCOUNTING_INTERNAL_URL` on a closed port, with the list: exit **2**,
`accounting:release stopped: Accounting cannot be read: nothing was numbered or classified; run again later. (network)`;
the row checksums are unchanged.

## Clean-up

- Stopped: the stand-in `auth` (18091) and accounting-api (18092); both ports verified free after, no leftover process.
- Dropped: `accounting_reh` and `refund_reh` only (by a script file restricted to those two names on :5446, because the Bash hook
  blocks the SQL text); the server then listed `accounting`, `auth`, `postgres`, `refund`.
- Nothing committed but this file. The baseline file, the stand-in and the helper scripts stayed in the session scratchpad.

## Findings

- **D-1 (cosmetic, wording)**: the report prints `1 lines` for a group of one (`CG · u-reh-ga 2026: 1 lines, CG26/001 to CG26/001`,
  and `Rate pending: 1 lines`). Repro: any employee with exactly one numbered legacy line. No effect on numbers or data; it is
  `formatReport` in `refund-api/scripts/accounting-release.ts` (`${n.count} lines`). Not fixed here (script source is out of scope).
- **E-1 (environment)**: the `src/lib/generated/prisma` client of the sibling checkout `operai-accounting` was STALE (no
  `travel_flight` in `enums.ts`), although the commit and lockfile are identical. A worktree set up by copying its `node_modules` and
  `generated` fails the first insert of a flight line with `Invalid value for argument type`. Run `bun run db:generate` in a fresh
  worktree before any script. This is not a code defect (the directory is gitignored).
- **E-2 (environment)**: `bun` is not on the shell `PATH` and `mise exec -- bun` fails here (`couldn't exec process`); the rehearsal
  used the mise install directly (`~/.local/share/mise/installs/bun/1.4.4/bin`).
