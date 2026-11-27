# @operai/refund-api

## 0.8.1

### Patch Changes

- 8653331: A U+0000 in any input is a 400, never a 500. Postgres text (and the text inside jsonb) cannot hold it; every backend's global error handler now answers the database's refusal (Postgres 22021 / 22P05, Prisma P2039 / P2010) with a 400 `validation_failed` (hours-api: `invalid_request`) that names no value and none of the database's words, so a route nobody remembered is still not a 500. In auth a guard in front of the whole app refuses a NUL in the path, the query or a JSON body before any route runs (`GET /admin/users?q=%00`, `POST /admin/departments`, roles, invitations, legal entities, …). In projects-api the shared text helpers (`requiredText`, `optionalText`, a new `searchText`) refuse it, which covers `GET /projects?q=`, a project's name, a T&M position's profile, the Bexio order id and `GET /system/purchase-orders?dealIds=`.
- 8653331: The safety net that answers 400 when Postgres refuses a U+0000 now leaves one log line, `[nul] database refused U+0000 or invalid text` and the Prisma and SQLSTATE codes (`P2039/22021`), so a value built by the server with bad bytes is no longer blamed on the client without a trace (security review A09). The line carries only codes taken from the two closed sets the detector already knows: no message, value, argument, request or person. No wire contract changes.
- 8653331: A NUL (U+0000) in an id, query or text of any route is now a 400 `validation_failed` instead of a 500 (QE F1): ids and free text are refused at the schema, and a database error caused by a NUL that reaches Postgres anyway is answered 400 too (it was wrapped in a `DatabaseError` rendered as a plain 500 before the global handler could see it).
- 8653331: The log line of an unhandled error no longer writes the whole error and its `cause` chain, which can hold a Prisma or driver message with the query's arguments (an id, an email). It writes the error's own message and call frames and each cause by name and code only; a Prisma error itself has no message in it either.

## 0.8.0

### Minor Changes

- 9726f97: The Google Places client and an `AddressAutocomplete` field move into the component library, shared by every tool through the shell: the app passes its key and its texts, and chooses addresses only or any place (a company, a town). refund-api accepts and returns a mileage trip's start and end (`fromAddress`, `toAddress`, migration `20261125160000_mileage_trip_addresses`), prints the route in the request PDF and fills From and To in the register extract (format 4). The tools start using the field in the next release, once this shell is live (ADR 20261114, deploy rule).
- 531247d: A mileage expense states where the trip starts and ends: two required fields, From and To, with Google address suggestions (the library's `AddressAutocomplete`, which also suggests companies and towns; when suggestions are unavailable the fields stay plain text). The line shows its route, the request PDF prints it and the register extract fills From and To. refund-api requires both for a mileage line on create and edit, and a draft mileage line written before must get them before it is submitted. admin-ui's employee address uses the same shared field. Needs `VITE_GOOGLE_MAPS_API_KEY` on the refund-ui Vercel project (infra/README.md).

## 0.7.0

### Minor Changes

- d858910: After the accountant's first look at the two files. Journal (format 3): the Description has no square brackets, its parts are joined by `-` (`Cancelleria - MC26/001 - EUR 10.40 = CHF 9.62 - Matteo Codogno`). Register extract (format 2): Period is the competence month being booked, the same on every row, not the month of each expense; by default the month before the batch's cutoff (Europe/Zurich), and the card offers a "Competence month" choice (`?period=YYYY-MM`). The sheet is named after that month's year.
- 5bf3faa: A mileage expense can be marked as a round trip ("Andata e ritorno"). The flag is informative: the km typed are the whole trip and the amount is unchanged. It shows beside the km on the request and in review, in the request PDF ("15 km round trip × …"), in the accounting journal's Description (`Lugano-Milano - A/R - MC26/002 - …`, format 4) and in the register extract's Description (`Spese di viaggio (km) A/R`, format 3). Migration `20261125120000_mileage_round_trip` adds `refund_line.roundTrip` (false for existing lines; only a travel_km line may be a round trip).

## 0.6.0

### Minor Changes

- 8b282de: The accounting export card of a batch offers a second Excel file, the register extract: the same WellD CH lines laid out like the accountant's register (Worker, Period, No., Description, From, To, Reason, Date, Km / Monthly avg rate, Multiplier / Foreign Amount, Total, Account, Description, IVA, IVA2, Approved by), one sheet named after the year, ready to paste under the register's rows. It is built from the same lines, under the same blockers and rate copies as the journal, and every download is logged with its kind (`journal` or `register`; migration `20261124150000_register_extract`).

## 0.5.0

### Minor Changes

- 827e343: Receipt numbers now continue the accountant's paper register, and accounting sets each employee's receipt code (specs/20261124-receipt-numbers-from-the-register). auth gains the capability `receipt-code:manage` (resource `receipt-code`, no conditions), seeded to `accounting` and `admin` only and logged as `+ receipt-code grants`; it must be live before codes are set. refund-api stores one current receipt code per employee (2 or 3 ASCII letters, unique) with an append-only history, exposes it under `/accounting/receipt-codes` (list with last change, set, clear, history), and uses the code instead of the derived initials for new numbers only; numbers already issued never change. The one-off `bun run accounting:release` now runs as propose, check, run: `--register <xlsx>` with `--propose <csv>` writes a pairing file, `--pairing <csv>` checks or runs it, `--offsets` is optional, `--show-emails` is gone, and the exit statuses are 0, 1, 2, 4, 5, 6, 7, 8 and 9 (3 is retired). Paper numbers from the register are imported as written for the lines accounting pairs with them. refund-ui adds Refund Settings, Receipt codes (Set, Change, Clear and History, with a flag when two employees share a prefix) for holders of the capability, in English and Italian. The release is the owner's step: see infra/README.md, Accounting release runbook.

## 0.4.0

### Minor Changes

- d4cb290: A new Accounting module keeps the accounting reference data of each legal entity in one place: the ledger accounts, the VAT codes and the monthly average exchange rates, which are those the Swiss Federal Tax Administration (AFC/ESTV) publishes for VAT (read from its monthly average file, served by the BAZG, and named as the source on the exchange-rates view). People with Accounting read or manage see an Accounting entry in the menu, with three views (ledger accounts, VAT codes, exchange rates) for each entity they are granted. A manager adds, deactivates and reactivates accounts and VAT codes (an entry is never edited or deleted), fetches or corrects a month's rate, and a reader sees the same lists without the controls. Each entity holds at most 200 ledger accounts and 50 VAT codes, deactivated ones included; since entries are never deleted this is a lifetime limit, and an addition beyond it is refused with `catalog_full`. Refund no longer keeps these lists: it reads them from Accounting each time it needs them, offers only Accounting's active entries, and keeps on each line a copy of the account, VAT code and exchange rate it booked, so a later change in Accounting never alters an approved line or an export already given to the books. When Accounting cannot be read, Refund refuses the change or approval and says so rather than guess; an approved foreign-currency line whose month had no rate gets its rate at the first export. In Refund's Settings the "Accounts and VAT" and "Exchange rates" views are gone (only the default account of each expense type stays, under "Default classification", with a note that points to Accounting; no VAT code is set by default and foreign-currency lines have no VAT code of their own).

  Auth declares the `accounting` permissions (`accounting:read` and `accounting:manage`, each limited to an entity if wanted; no separate access permission), grants them to the `admin` role (all entities) and the `accounting` role (WellD CH), derives the Accounting app from them, and accepts the new service scope `accounting.reference.read`. The shell mounts the Accounting remote at `/accounting`. New apps, `accounting-api` (port 8089, own database `accounting`) and `accounting-ui` (port 5183), start at 0.1.0.

  Deploy (a person, never an agent; the full runbook is `infra/README.md` § Release runbook, and one push redeploys everything in no fixed order, so each pairing fails closed meanwhile): provision first with `./infra/provision-tool.sh accounting --port 8089`, then set the variables, which are `accounting-api` (`DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_*`, `SERVICE_AUDIENCE`, `ACCOUNTING_FX_SOURCE=bazg`), refund-api (`ACCOUNTING_INTERNAL_URL`, now required: without it refund-api does not start and Railway keeps the previous deployment) and the shell (`ACCOUNTING_REMOTE_URL`, `VITE_ACCOUNTING_API_URL`); remove `REFUND_FX_SOURCE` from refund-api, which no longer fetches rates. After the new auth is live, add `accounting.reference.read` to refund-api's entry in auth's `SERVICE_CLIENTS` (auth stops at startup on a scope it does not know, so never before). Until then Accounting answers refund-api 401 and Refund answers 503 `accounting_unavailable`, and approvals stay 409 `accounting_release_pending` until the release below. Then, in this order: `bun run seed:welld-ch --dry-run` and then without it in `accounting-api` (optional, when accounting prefers to type WellD CH's list in the app; it loads the list signed off by accounting, 19 ledger accounts and 6 VAT codes: `IPM81`, `IPM77`, `IP00`, `BZM81`, `IPM26`, `IPM38`; the script is in accounting-api's image, so it runs inside the service with `railway ssh`, or from a checkout), and then, from a checkout, `bun run accounting:release --dry-run` and then without it in `refund-api` (it reads Accounting first and exits 2, writing nothing, when it cannot; it requires `--offsets <file>`, the list of the last receipt numbers issued by hand in 2026, and exits 3 writing nothing without it; it takes `--defaults <json>`, and the old `--seed` option is gone). Run the release outside the monthly batch day. `seed:welld-ch` is in accounting-api's Docker image; `accounting:release` is not in refund-api's, which is why it runs from a checkout. refund-api's new migrations (additive, applied by its `preDeploy`) carry what the moved tables kept onto the lines and then drop them; a migration that has been applied is never edited. Before release, check the rates channel once from a networked machine with `ACCOUNTING_LIVE_RATES=1 bun test src/rates/afc.live.test.ts` in `accounting-api` (it is skipped otherwise and never runs in CI).

- d4cb290: Refund books WellD CH expenses for accounting. Every approved WellD CH line gets a ledger account (the expense type's default account, changeable line by line until the request is paid), an optional VAT code, a receipt number such as MC26/001 (the employee's initials, the year of the expense date, a running number), and a CHF amount from the AFC/ESTV monthly average exchange rate. The VAT code is never pre-set: accounting chooses it by hand, or leaves it empty, and a line without one is approved and exported like any other (the VAT amount is shown only when a code is set). There are 14 expense types, now including flights and taxi, and "Meals with clients" is the new English name of the client-meals type. An administrator sets the default account of each expense type in Settings, choosing among the entries kept in Accounting (the Accounting module, see `accounting-module.md`, holds the ledger accounts, the VAT codes and the monthly rates). Approval is refused, with the missing values listed, only for a line that has no account. The expense form tells employees to enter one line per VAT rate when a receipt mixes rates. Auth declares the new `request:reclassify` permission, granted like `request:approve`.

  Accounting downloads the journal of a compiled or paid batch from the batch page as an Excel workbook (`.xlsx`) in the accountant's template: one row per approved line with Date, Description, Debit, Credit, Amount, Currency, Tax and Note, the same bytes every time for the same lines, and text that a spreadsheet can never read as a formula. Receipt numbers for 2026 continue the paper register: the release takes the list of the last numbers each employee issued by hand, so the first number Refund issues follows the last one on paper (MC26/082 after MC26/081); 2027 starts again at 001.

  Deploy in this order: auth first (refund-api checks `request:reclassify`, and until auth declares it changing a classification after approval answers 403); the shell with `formatMonth` (the `@operai/ui` changeset) before refund-ui, which shows month names with it; then refund-api, with its migrations, together with accounting-api (refund-api needs `ACCOUNTING_INTERNAL_URL` and reads the lists from there; the order and the variables are in `accounting-module.md`). Approvals answer 409 `accounting_release_pending` until `bun run accounting:release` has run once against the refund database, which is after Accounting holds WellD CH's list, so run it right after refund-api is live and Accounting is seeded (`--dry-run` first). The run needs the list of last hand-issued 2026 receipt numbers (`--offsets <file>`, a file of `email,year,lastIssuedSeq` kept outside the repository; a file with only the header line says that no employee has one); without it the script writes nothing and exits 3. `bun run receipt-baseline:from-register --register <file>` derives the numbers from the accounting register. The script is not in refund-api's Docker image: run it from a checkout, as for `settings:seed` (infra/README.md).

  An old batch PDF that is generated again after the stored copy is gone now shows receipt numbers on its lines; the stored copy of a PDF that exists is served unchanged.

## 0.3.2

### Patch Changes

- 080a1fb: Migration logs on Railway no longer show as errors: `bun run` no longer echoes the command on stderr (`[run] silent = true`) and `db:deploy` sends Prisma's informational stderr to stdout. A failing migration still exits non-zero and fails the deploy.

## 0.3.1

### Patch Changes

- 8d5ed71: Pins `hono` to 4.13.16 in every backend (it was a `^4.6.16` range that had resolved to 4.12.12 through 4.13.16 depending on the service), closing the hono advisories reported by `bun audit`, among them the CORS wildcard-origin reflection with credentials (GHSA-88fw-hqm2-52qc), the `bodyLimit()` bypass for chunked bodies (GHSA-9vqf-7f2p-gf9v), the CORS preflight ReDoS (GHSA-8j4g-w8fx-2239), the `mount()` prefix bypass (GHSA-4m76-xfj5-7975) and the RegExpRouter wildcard-middleware skip (GHSA-h7mg-cq63-vhpq). `@hono/node-server`, which only reaches the services through `prisma > @prisma/dev` (pinned there to 1.19.11, used by `prisma dev` and never at runtime), is overridden to 2.1.6 in each `package.json`, closing four path-handling advisories (GHSA-92pp-h63x-v22m, GHSA-frvp-7c67-39w9, GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w). No route, status code or response changes.
- 7e6fd79: Moves refund-api to zod 4 (4.6.7) and `@hono/zod-openapi` 1.6.3, and `@scalar/hono-api-reference` to 0.12.17, closing the zod memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5, zod before 4.6.6, no 3.x fix); the Scalar bump is needed because the old one pulled a second, vulnerable zod. The routers that already had a validation hook keep their Problem JSON body; the two without one (submit/withdraw and the request export) keep `{ success: false, error: { issues, name: "ZodError" } }` through a `defaultHook`, with zod 4's issue codes and messages. The OpenAPI document is unchanged except that a nullable enum (`emailStatus` on the batch list) now lists `null` among its values, as OpenAPI 3.0 requires. A JSON body sent with another Content-Type now answers 415 instead of a validation error. A datetime without seconds (`2026-01-01T00:00Z`) and an integer of 2^53 or more are no longer accepted, and the `/docs` page loads Scalar through a different script.

## 0.3.0

### Minor Changes

- 0b3b843: Second of three pushes that retire the shared notification token (specs/20261013-notify-service-credentials,
  ADR 20261013-auth-mints-own-service-credential-in-process/0049). Every notify-api caller now authenticates as itself with a scoped,
  short-lived service credential and no longer reads `NOTIFY_INTERNAL_TOKEN`: `auth`
  mints its own `emails.send` credential in process for invitation emails,
  `refund-api` uses `notifications.push` for decisions and `emails.send` for the batch
  email, and `estimai-api` uses `notifications.push` for collaborator changes. A caller
  whose credential is missing or refused fails soft exactly as before. `notify-api` still
  accepts the shared token until it is deleted from the deployed services.
- 0a96dd7: Accounting can reject a single expense line instead of the whole refund request, and must give a reason. The rejected line pays nothing, shows its reason to the employee once the request is approved (and in the archive PDF), and can be restored until the request is decided. A request whose every line is rejected can no longer be approved — it has to be rejected as a whole. New endpoints `POST`/`DELETE /review/requests/{id}/lines/{lineId}/reject` (gated on `request:reject`), audit actions `line_rejected`/`line_restored`, and a migration adding the rejection columns to `refund_line`.

### Patch Changes

- 27333e4: The compiled monthly batch PDF now uses the same template as the per-request PDF: wellD letterhead, title and
  reference, a two-column metadata grid (cutoff, contents, expense period, entities / compiled by, batch
  reference), a payout table per currency with one row per employee and a brand-ruled total, then each
  employee's requests (period, approved on, requested and approved amounts) with per-currency subtotals, and a
  "Page N of M" footer. Timestamps are in local time (`14.11.2026 09:20 (CET)`) and amounts use the suffix form
  (`1414,00 CHF`), as everywhere else. The shared drawing primitives moved to
  `refund-api/src/requests/documentLayout.ts`, so the two documents cannot drift apart again. Already stored batch PDFs keep their old
  look; a PDF regenerated after a storage miss uses the new one.
- 041cf92: Mark the service-token client's shared region in `src/lib/serviceToken.ts` with
  `shared-copy` begin/end comments so a CI check can fail when the three copies drift.
  Comment-only: no behaviour change.

## 0.2.0

### Minor Changes

- 6338f88: Filing the same trip twice no longer means typing it twice: while composing a
  "Travel by car" line, the Motivo field now suggests trips the employee has
  already claimed in the last 24 months, and picking one (by mouse or keyboard)
  fills in the motivo, the distance and the entity in a single step, with the
  amount recomputed from the current rate. Suggestions are drawn only from the
  employee's own past lines, served by a new self-scoped `GET /line-suggestions`
  on refund-api; if that call fails, Motivo quietly stays an ordinary text field.
- ceb22d1: An approve/reject decision on an expense request now also reaches the employee
  by email, alongside the in-app notification they already received.

  Two new notify-api templates — `refund_decision_approved` and
  `refund_decision_rejected` — rather than one with an outcome flag: only the
  approved variant carries money, so a split keeps each template's `data` shape
  closed and fixed, and a rejection can never carry a figure. The approved mail
  states the approved total per currency inline; the rejected mail carries no
  amount and, deliberately, not the rejection motivation — that stays behind
  sign-in in the app. Both link into the request rather than restating it, the
  same posture the compiled-batch email already takes.

  refund-api sends it from the decision path as a second, independent
  best-effort channel: an email outage cannot suppress the in-app notification,
  an in-app outage cannot suppress the email, and neither can fail or roll back
  the decision itself. No new environment variable and no new secret — the
  existing notify-api internal token and app base URL cover it.

- 81f700e: The archive PDF is now laid out as a document rather than a list of sentences.

  A letterhead with the issuing entity and a brand rule; a title block with the
  status as a chip instead of a "Status:" row; the nine stacked label-value lines
  replaced by two grouped columns (Request / Processing); and the expense lines
  set as a real table — numbered, dated, with the rate breakdown demoted to a
  grey Detail column and both money columns right-aligned so a reader can run
  their eye down them and check the sum.

  The total is now the most prominent figure on the page rather than the least:
  bold, under a brand rule, aligned in the same columns as the lines it totals,
  with the kilometre total beside it as a cross-check. It is summed from the
  lines actually printed, so it can never disagree with them. Multi-currency
  requests repeat that whole block per currency with its own subtotal and no
  grand total across them.

  Receipts are listed in a framed note under the table by filename and the page
  they appear on. The table header repeats on continuation pages, the footer is
  ruled, and margins are ~20mm.

  Colour is an accent only — the status chip carries its own word, the total is
  distinguished by weight and a rule — so nothing is lost when these are printed
  or photocopied in monochrome, which is how they will be archived.

- a1f78cd: The archive PDF now names its people, carries a letterhead, and handles
  requests that are not uniform.

  Employee, decider and exporter render as "Luigi Gambardella
  (luigi.gambardella@welld.ch)" rather than a bare address — a document a human
  files should lead with the human. The decider's name is captured at decision
  time, so an archived PDF never changes because that person's record later did.

  The page identifies its issuer: legal name, registered seat and tax identifier
  for the entity the request belongs to.

  A request whose lines straddle entities, currencies or months no longer gets a
  header that quietly implies uniformity. The period widens to "August to
  September 2026", the entity says "Multiple — see each line", and the totals are
  one row per currency under a "Totals per currency" heading, never summed across
  them.

  Rejected requests are exportable, and their document carries the rejection
  motivation above the figures — it is the whole content of that document and the
  one a disputing employee needs. It also shows no approved figure anywhere: a
  reviewer can set per-line approved totals before rejecting, and those leftovers
  were rendering as approved amounts on a refused claim.

  The settlement line no longer repeats the status word directly above it.

- 7f29ff7: The request archive PDF now reads like a document rather than a data dump.

  Raw database values no longer reach the page: expense types, entities and the
  status render as the same words the UI shows ("Travel — mileage (km)",
  "WellD CH", "Approved"), sourced from a canonical label table both packages
  assert against so the PDF and the screen can never disagree.

  One locale throughout. Amounts, the mileage rate and every date now share a
  single convention (206,50 CHF · 0,70 CHF/km · 31.01.2021) instead of mixing
  comma decimals, dot decimals and ISO dates on one page, and the currency now
  follows the amount as it does on screen. Timestamps are civil time in the
  document's timezone with the zone named — 08.09.2026 08:45 (CEST) — rather
  than raw ISO with milliseconds in UTC, which could file an evening export
  under the wrong day.

  The document also answers the first question a recipient asks: whether it
  represents a liability or a settled one. A settlement line states "not yet
  included in a monthly batch", "included in batch 2026-09 — compiled, not yet
  paid", or "Paid on … — batch 2026-09". The header names the period and legal
  entity, every page carries the reference and a page number, and receipts are
  stated once rather than per line and again at the end.

  Downloads are named refund*2026-08_camerini_CHF-206.50*<id>.pdf instead of
  refund-request-<cuid>.pdf — sortable in a folder and quotable over the phone.

- fb42218: An approved expense request can now be exported as a single archive PDF —
  every expense line with its mileage-rate provenance, plus every receipt
  embedded in full. A PDF receipt is copied page-for-page; a JPEG or PNG is
  embedded as an image. An "Export PDF" button appears on an approved request
  for its owner and for accounting reviewers.

  This is the first time refund-api reads attachment bytes at all (ADR 20260908-request-archive-export-refund-api-reads-attachment-bytes).
  Receipts were previously reachable only through presigned URLs the browser
  followed itself, which is still how receipt downloads work — but an archive
  cannot embed a file it may not read. The exposure is bounded: a request whose
  receipts exceed the export budget is refused with a clear message rather than
  archived incompletely, and a receipt that cannot be embedded fails the whole
  export instead of producing a PDF with a silent gap in it. An archive that
  looks complete but isn't is worse than one that refuses to build.

  Drafts, submitted and rejected requests are not exportable — their figures are
  not yet final. Paid requests are, since paying one does not make it less
  worth archiving.

### Patch Changes

- 34cce3b: The refund review queue now lists requests newest-submitted-first.

  It was ordered oldest-first (FIFO), which pushed the most recent submissions
  to the bottom, under every already-approved request still waiting to be
  batched. Accounting works the queue from the newest end, so that ordering is
  now reversed. Submitted and approved-not-yet-batched rows remain interleaved
  by submission date rather than grouped, as before — the per-row status badge
  distinguishes them.

## 0.1.1

### Patch Changes

- bdf998c: Bind backends to IPv6 (::) on Railway (when RAILWAY_PRIVATE_DOMAIN is set) so private networking (\*.railway.internal) can reach them. Enables moving cross-service call URLs (AUTH_JWKS_URL / AUTH_BASE_URL / NOTIFY_INTERNAL_URL) to internal DNS and shared/reference variables (Layer 2), reducing the env-var sprawl. Local dev unchanged (keeps Bun default IPv4).
