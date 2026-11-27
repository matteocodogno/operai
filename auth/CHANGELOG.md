# @operai/auth

## 0.11.0

### Minor Changes

- 3e5d1b5: Teams, admin side (step 1): `GET/POST /admin/teams`, `GET/PATCH /admin/teams/{id}`, `POST /admin/teams/{id}/archive` and `/restore`, and `DELETE` answering 405 `not_deletable`. Admin-only (a department-conferred admin is refused). Writes of a team's own fields carry the version they were read at as `baseVersion` in the body (409 `version_conflict` + `currentVersion` when stale, since auth's CORS exposes no ETag). A name already taken, ignoring case and archived teams included, answers 409 `team_name_taken` with `existingName`. One audit row per successful change, no permission epoch bump: a team grants nothing.
- 3e5d1b5: Teams, service read (step 2): `GET /system/teams?ids=…` answers up to 50 teams with their members (name order, deactivated ones last with no name) and whether each holds the bound app's access, and `GET /system/teams?state=active[&q=…]` lists the active teams' names for the attach picker (name search, exact match first, 50 at most). It takes a service JWT with the new scope `teams:read` from a service bound in code (`TEAM_READERS`, projects-api only); the app is derived from the verified caller, never asked for; every credential failure is the same 401. Two allowances per service per 10 minutes, chosen by whether `ids` is present: 3 000 for ids and 1 500 for options. Grant `teams:read` to projects-api in `SERVICE_CLIENTS` only after this version is live (an unknown scope stops auth at startup).

### Patch Changes

- 8653331: A request body over 256 KiB is refused with a 413 `request_too_large` before anything reads it (security review A04/A05). The NUL guard decodes the whole JSON body of every request, signed in or not, and Bun's own ceiling is about 128 MiB, so an anonymous caller could make auth hold several copies of that. The limit sits in front of the guard and answers without reading a byte when the declared length is over it; the biggest body any auth route legitimately takes (a role holding every permission of the suite) is about 7 KiB. The legal-entity writes keep their own 16 KiB cap. No wire contract changes for a legitimate request.
- 8653331: A U+0000 in any input is a 400, never a 500. Postgres text (and the text inside jsonb) cannot hold it; every backend's global error handler now answers the database's refusal (Postgres 22021 / 22P05, Prisma P2039 / P2010) with a 400 `validation_failed` (hours-api: `invalid_request`) that names no value and none of the database's words, so a route nobody remembered is still not a 500. In auth a guard in front of the whole app refuses a NUL in the path, the query or a JSON body before any route runs (`GET /admin/users?q=%00`, `POST /admin/departments`, roles, invitations, legal entities, …). In projects-api the shared text helpers (`requiredText`, `optionalText`, a new `searchText`) refuse it, which covers `GET /projects?q=`, a project's name, a T&M position's profile, the Bexio order id and `GET /system/purchase-orders?dealIds=`.
- 8653331: The safety net that answers 400 when Postgres refuses a U+0000 now leaves one log line, `[nul] database refused U+0000 or invalid text` and the Prisma and SQLSTATE codes (`P2039/22021`), so a value built by the server with bad bytes is no longer blamed on the client without a trace (security review A09). The line carries only codes taken from the two closed sets the detector already knows: no message, value, argument, request or person. No wire contract changes.
- 3e5d1b5: A U+0000 in a text id or in a team's name or description is now a 400 `validation_failed` (no echo in `detail`) instead of a 500 from Postgres: auth's `/admin/teams` routes (name, description, team and user ids) and projects-api's shared `IdSchema` (`GET /projects?teamId=` and `?projectManagerId=`, `PUT /projects/{id}/teams`, every route taking an id). The host-resolve routes now use the same schema.

## 0.10.0

### Minor Changes

- 827e343: Receipt numbers now continue the accountant's paper register, and accounting sets each employee's receipt code (specs/20261124-receipt-numbers-from-the-register). auth gains the capability `receipt-code:manage` (resource `receipt-code`, no conditions), seeded to `accounting` and `admin` only and logged as `+ receipt-code grants`; it must be live before codes are set. refund-api stores one current receipt code per employee (2 or 3 ASCII letters, unique) with an append-only history, exposes it under `/accounting/receipt-codes` (list with last change, set, clear, history), and uses the code instead of the derived initials for new numbers only; numbers already issued never change. The one-off `bun run accounting:release` now runs as propose, check, run: `--register <xlsx>` with `--propose <csv>` writes a pairing file, `--pairing <csv>` checks or runs it, `--offsets` is optional, `--show-emails` is gone, and the exit statuses are 0, 1, 2, 4, 5, 6, 7, 8 and 9 (3 is retired). Paper numbers from the register are imported as written for the lines accounting pairs with them. refund-ui adds Refund Settings, Receipt codes (Set, Change, Clear and History, with a flag when two employees share a prefix) for holders of the capability, in English and Italian. The release is the owner's step: see infra/README.md, Accounting release runbook.

## 0.9.0

### Minor Changes

- 2b3d2fe: Add the `hours` permission catalog for time tracking (specs/20261112-time-tracking, ADR 20261112-hours-api-time-entries-own-service-hours-catalog): `time-entry:read-all` (see everyone's hours) and `time-list:manage` (the categories and work types), both unconditioned, seeded to `admin` only and registered by the deploy-time seed. The catalog has no `access` resource, because every signed-in user records and sees their own hours, so `hours` is a declared catalog but not one of the apps `admin` is granted `access` to. An admin can grant either permission to another role through the roles screen.
- 2b3d2fe: Add the service scope `meetings.hosts.read` and document the `hours-api` service client (specs/20261112-time-tracking, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route). `hours-api` holds only this scope: it asks meetings-api which deal a meeting is linked to, and everything else it asks of the other services is asked as the caller. The scope is a deliberate addition to the allowlist, so in production the `hours-api` entry of `SERVICE_CLIENTS` must be added only after this version of auth is live; an unknown scope stops auth at startup.

## 0.8.0

### Minor Changes

- d4cb290: A new Accounting module keeps the accounting reference data of each legal entity in one place: the ledger accounts, the VAT codes and the monthly average exchange rates, which are those the Swiss Federal Tax Administration (AFC/ESTV) publishes for VAT (read from its monthly average file, served by the BAZG, and named as the source on the exchange-rates view). People with Accounting read or manage see an Accounting entry in the menu, with three views (ledger accounts, VAT codes, exchange rates) for each entity they are granted. A manager adds, deactivates and reactivates accounts and VAT codes (an entry is never edited or deleted), fetches or corrects a month's rate, and a reader sees the same lists without the controls. Each entity holds at most 200 ledger accounts and 50 VAT codes, deactivated ones included; since entries are never deleted this is a lifetime limit, and an addition beyond it is refused with `catalog_full`. Refund no longer keeps these lists: it reads them from Accounting each time it needs them, offers only Accounting's active entries, and keeps on each line a copy of the account, VAT code and exchange rate it booked, so a later change in Accounting never alters an approved line or an export already given to the books. When Accounting cannot be read, Refund refuses the change or approval and says so rather than guess; an approved foreign-currency line whose month had no rate gets its rate at the first export. In Refund's Settings the "Accounts and VAT" and "Exchange rates" views are gone (only the default account of each expense type stays, under "Default classification", with a note that points to Accounting; no VAT code is set by default and foreign-currency lines have no VAT code of their own).

  Auth declares the `accounting` permissions (`accounting:read` and `accounting:manage`, each limited to an entity if wanted; no separate access permission), grants them to the `admin` role (all entities) and the `accounting` role (WellD CH), derives the Accounting app from them, and accepts the new service scope `accounting.reference.read`. The shell mounts the Accounting remote at `/accounting`. New apps, `accounting-api` (port 8089, own database `accounting`) and `accounting-ui` (port 5183), start at 0.1.0.

  Deploy (a person, never an agent; the full runbook is `infra/README.md` § Release runbook, and one push redeploys everything in no fixed order, so each pairing fails closed meanwhile): provision first with `./infra/provision-tool.sh accounting --port 8089`, then set the variables, which are `accounting-api` (`DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_*`, `SERVICE_AUDIENCE`, `ACCOUNTING_FX_SOURCE=bazg`), refund-api (`ACCOUNTING_INTERNAL_URL`, now required: without it refund-api does not start and Railway keeps the previous deployment) and the shell (`ACCOUNTING_REMOTE_URL`, `VITE_ACCOUNTING_API_URL`); remove `REFUND_FX_SOURCE` from refund-api, which no longer fetches rates. After the new auth is live, add `accounting.reference.read` to refund-api's entry in auth's `SERVICE_CLIENTS` (auth stops at startup on a scope it does not know, so never before). Until then Accounting answers refund-api 401 and Refund answers 503 `accounting_unavailable`, and approvals stay 409 `accounting_release_pending` until the release below. Then, in this order: `bun run seed:welld-ch --dry-run` and then without it in `accounting-api` (optional, when accounting prefers to type WellD CH's list in the app; it loads the list signed off by accounting, 19 ledger accounts and 6 VAT codes: `IPM81`, `IPM77`, `IP00`, `BZM81`, `IPM26`, `IPM38`; the script is in accounting-api's image, so it runs inside the service with `railway ssh`, or from a checkout), and then, from a checkout, `bun run accounting:release --dry-run` and then without it in `refund-api` (it reads Accounting first and exits 2, writing nothing, when it cannot; it requires `--offsets <file>`, the list of the last receipt numbers issued by hand in 2026, and exits 3 writing nothing without it; it takes `--defaults <json>`, and the old `--seed` option is gone). Run the release outside the monthly batch day. `seed:welld-ch` is in accounting-api's Docker image; `accounting:release` is not in refund-api's, which is why it runs from a checkout. refund-api's new migrations (additive, applied by its `preDeploy`) carry what the moved tables kept onto the lines and then drop them; a migration that has been applied is never edited. Before release, check the rates channel once from a networked machine with `ACCOUNTING_LIVE_RATES=1 bun test src/rates/afc.live.test.ts` in `accounting-api` (it is skipped otherwise and never runs in CI).

- d4cb290: Refund books WellD CH expenses for accounting. Every approved WellD CH line gets a ledger account (the expense type's default account, changeable line by line until the request is paid), an optional VAT code, a receipt number such as MC26/001 (the employee's initials, the year of the expense date, a running number), and a CHF amount from the AFC/ESTV monthly average exchange rate. The VAT code is never pre-set: accounting chooses it by hand, or leaves it empty, and a line without one is approved and exported like any other (the VAT amount is shown only when a code is set). There are 14 expense types, now including flights and taxi, and "Meals with clients" is the new English name of the client-meals type. An administrator sets the default account of each expense type in Settings, choosing among the entries kept in Accounting (the Accounting module, see `accounting-module.md`, holds the ledger accounts, the VAT codes and the monthly rates). Approval is refused, with the missing values listed, only for a line that has no account. The expense form tells employees to enter one line per VAT rate when a receipt mixes rates. Auth declares the new `request:reclassify` permission, granted like `request:approve`.

  Accounting downloads the journal of a compiled or paid batch from the batch page as an Excel workbook (`.xlsx`) in the accountant's template: one row per approved line with Date, Description, Debit, Credit, Amount, Currency, Tax and Note, the same bytes every time for the same lines, and text that a spreadsheet can never read as a formula. Receipt numbers for 2026 continue the paper register: the release takes the list of the last numbers each employee issued by hand, so the first number Refund issues follows the last one on paper (MC26/082 after MC26/081); 2027 starts again at 001.

  Deploy in this order: auth first (refund-api checks `request:reclassify`, and until auth declares it changing a classification after approval answers 403); the shell with `formatMonth` (the `@operai/ui` changeset) before refund-ui, which shows month names with it; then refund-api, with its migrations, together with accounting-api (refund-api needs `ACCOUNTING_INTERNAL_URL` and reads the lists from there; the order and the variables are in `accounting-module.md`). Approvals answer 409 `accounting_release_pending` until `bun run accounting:release` has run once against the refund database, which is after Accounting holds WellD CH's list, so run it right after refund-api is live and Accounting is seeded (`--dry-run` first). The run needs the list of last hand-issued 2026 receipt numbers (`--offsets <file>`, a file of `email,year,lastIssuedSeq` kept outside the repository; a file with only the header line says that no employee has one); without it the script writes nothing and exits 3. `bun run receipt-baseline:from-register --register <file>` derives the numbers from the accounting register. The script is not in refund-api's Docker image: run it from a checkout, as for `settings:seed` (infra/README.md).

  An old batch PDF that is generated again after the stored copy is gone now shows receipt numbers on its lines; the stored copy of a PDF that exists is served unchanged.

## 0.7.0

### Minor Changes

- 8048f95: A change to a legal entity's name, VAT number or IBAN, by a save or a restore, now tells people. In the same step as the new version, auth records a notice for each active manager covering the entity, every effective administrator, the person who made the change, and an outside mailbox set by the new `LEGAL_ENTITY_NOTICE_EMAIL` (optional, email only, the address is read when sending and never stored); a change with nobody to tell is written to the audit log as `legal_entity.notice_no_recipients`. A dispatcher sends them right after the change and sweeps every 15 seconds on every replica: an in-app notification and the `legal_entity_change` email through notify-api (which must be released first), retried after 1, 3, 5, 10 and 20 minutes and then every 30, and given up 24 hours after the version was stored. The audit log shows the first failure, a later delivery and a give-up. A notice names the changed details and shows an IBAN by its last 4 characters only; the import never sends one. A notice identifies who made the change by the account email captured in the version's transaction and kept on the notice rows (a new `authorEmail` column on `legal_entity_notice`; the version table is untouched), never a display name: the in-app notification (en/it), the push and the email data (`actorEmail`) all carry it, and a null or malformed email reads "no email address on record". The email is cleared from a notice row once it reaches its terminal status (delivered or given up), enforced by the database (a trigger and a CHECK, migration `20261118120000_legal_entity_notice_author_email_clear`), so it is not kept after the notice is done. A holder cannot change their own account email (Better Auth refuses), so the address captured for a change stays the one on record for its author. The top-level error log carries only the error name and code. Release step 7: set `LEGAL_ENTITY_NOTICE_EMAIL`, confirm a notice arrives in production, and only then let anyone but the `admin` role manage a legal entity. The migration is additive.

## 0.6.0

### Minor Changes

- a07f57d: Auth now holds the legal-entity registry: the name, VAT number, IBAN, address and contact lines of each legal entity, kept as numbered versions. Any signed-in person can read the entities, and a service holding the new `legal-entities:read` scope can read them too, with a limit per service. Saving and restoring an earlier version are checked against the person's grant for that entity and recorded in the audit log in the same step, and a save that changes nothing creates no version. The admin area now shows in `/authz/me` for anyone who can manage at least one entity. Until the details are moved, both entities answer version 0. A script, `mise run legal-entities:import`, copies the CRM's legal details into version 1; it is a dry run unless given `--apply` and prints a report without any of the values.

### Patch Changes

- 512851c: Sign-in rate limiting reads the real client address: Railway's internal hops are trusted proxies, so a caller-written X-Forwarded-For can no longer land in the shared "no IP" bucket, and requests from Operai's own services on the private network get their own bucket instead of a warning.
- a07f57d: Hardening of the legal-entity registry. A person who has been deleted is refused everywhere in it: reads answer 401, history and version views answer 403, the list of entities they can manage is empty and they cannot save, even if their session is still open. Saving and restoring share a limit per person (10 in 10 minutes by default) that answers 429 `too_many_requests` with `Retry-After`, counted after the grant check; the history is paged (`limit` 1 to 100, default 50, and a `before` cursor, with `nextBefore` in the answer), and any other query parameter answers 422. New route `POST /legal-entities/{entity}/versions/check` shows what a save would change (the changed fields, and whether the legal name, VAT number or IBAN among them) without writing anything, with its own limit (60 in 10 minutes by default) and the same refusals as a save. The import report now shows each entity's IBAN by its last 4 characters (`IBAN …1234`, `IBAN set` for 8 characters or fewer, `IBAN none`) so it can be checked against the bank's letter, and its audit row names who last edited the CRM row (`updatedBy`). The tests that commit real transactions run only against a local database and say so when they skip. The `crm-api` service client is documented with the `letterhead:render` scope.
- 080a1fb: Migration logs on Railway no longer show as errors: `bun run` no longer echoes the command on stderr (`[run] silent = true`) and `db:deploy` sends Prisma's informational stderr to stdout. A failing migration still exits non-zero and fails the deploy.

## 0.5.0

### Minor Changes

- 4b6e43e: Add the `letterheads` permission catalog (specs/20261116-letterhead-service): `letterheads:access` and the entity-conditioned `letterhead:manage`, registered in the declared catalogs and the app list. The seed gives both to `admin` only, `letterhead:manage` unconditioned; every other role gets them by an administrator's grant. Add `letterhead:render` to the known service scopes, so a service client (crm-api first) can mint a token the letterhead service verifies.

### Patch Changes

- 1775bbc: Moves auth to zod 4 (4.6.7) and `@hono/zod-openapi` 1.6.3, and `@scalar/hono-api-reference` to 0.12.17, closing the zod memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5, zod before 4.6.6, no 3.x fix); better-auth already used zod 4, so the service now resolves one zod. Every validation failure keeps its Problem document (type, title, status, detail, instance); only the default wording inside `detail` changes to zod 4's (for example `Required` becomes `Invalid input: expected string, received undefined`). In the OpenAPI document, an enum that is also nullable now lists `null` among its values (six places: the invitation `emailDelivery` in five responses and the `entity` of a user patch); nothing else changes. A JSON body sent with another Content-Type, or none, now answers 415 as a Problem document instead of being read as an empty body; a body that is optional (approving an access request) still accepts no body at all. A malformed `ALLOWED_SIGNUP_DOMAINS` next to another invalid variable now exits with the listed errors instead of a TypeError. A page number above 2^53 and a datetime without seconds are no longer accepted, and the `/docs` page loads Scalar through a different script.
- 8d5ed71: Pins `hono` to 4.13.16 in every backend (it was a `^4.6.16` range that had resolved to 4.12.12 through 4.13.16 depending on the service), closing the hono advisories reported by `bun audit`, among them the CORS wildcard-origin reflection with credentials (GHSA-88fw-hqm2-52qc), the `bodyLimit()` bypass for chunked bodies (GHSA-9vqf-7f2p-gf9v), the CORS preflight ReDoS (GHSA-8j4g-w8fx-2239), the `mount()` prefix bypass (GHSA-4m76-xfj5-7975) and the RegExpRouter wildcard-middleware skip (GHSA-h7mg-cq63-vhpq). `@hono/node-server`, which only reaches the services through `prisma > @prisma/dev` (pinned there to 1.19.11, used by `prisma dev` and never at runtime), is overridden to 2.1.6 in each `package.json`, closing four path-handling advisories (GHSA-92pp-h63x-v22m, GHSA-frvp-7c67-39w9, GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w). No route, status code or response changes.
- 4cef202: Removes the stale `pnpm-lock.yaml` and `pnpm-workspace.yaml` from these Bun services. Their only lockfile is now `bun.lock`, which is what the Dockerfiles and CI install from; the leftover pnpm lockfiles still listed zod 3 and kept the zod advisory (GHSA-mrhx-c7xc-m3w5) showing in dependency scanners. No runtime change.

## 0.4.0

### Minor Changes

- 0d8b9df: Projects hand-off (specs/20261103-projects-handoff, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials to 0094): a won deal reaches OPS "in series".
  Sales (and admins) see a to-start queue of the CRM's won deals that no project has taken, read live
  (a reopened deal leaves it, a re-won one returns), and turn one into a new project with its purchase
  order (PO): type, dates and terms, an optional referent among the company's CRM contacts, and the
  ops-manager the PO is assigned to. The project starts without a project manager; the ops-manager is
  notified and picks one (an admin may in their place), and `planned` to `active` is refused until then.
  A project has 0..1 terms and 0..1 purchase order: a PO is born only from a won deal, and a hand-made
  project may be of any type and carry terms but never a PO. A fixed-price PO from
  a deal with an estimate copies the estimate's man-days once, and they cannot be edited. The PO shows its
  deal, a "no longer won" notice, the estimate link and the referent's name, job title, email and phone,
  read live from the CRM and never stored; the CRM deal page shows its project and the PO's Bexio order id,
  read-only.
  - **auth:** the `projects` catalog gains `purchase-order:bexio` (held by `accounting`: the PO's Bexio
    order id), `purchase-order:receive` and `handoff:take`; new `ops-manager` system role; `sales` gains
    `handoff:take`. New `GET /authz/users/holders`, gated on `handoff:take`, lists the holders of
    `purchase-order:receive` for an entity as `{ id, name, unconditioned }` (ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047 amends ADR 20261006-user-directory-endpoint-capability-gated). New
    service scopes `crm.deals.read`, `crm.contacts.read`, `estimai.estimates.read` and
    `projects.purchase-orders.read`.
  - **estimai-api:** its first `/system/*` route, `GET /system/estimates/{id}/summary`, returns only
    `{ id, name, manDays }` to a service credential with `estimai.estimates.read`; new optional
    `SERVICE_AUDIENCE`.
  - **crm-api:** new `GET /system/deals` (`crm.deals.read`, no amounts) and `GET /system/contacts`
    (`crm.contacts.read`, minimal shape per mode) for projects-api; the deal read gains `delivery` and
    `deliveryKnown`, read from projects-api's `GET /system/purchase-orders`; `SERVICE_CLIENT_ID` /
    `SERVICE_CLIENT_SECRET` are now required with either `NOTIFY_INTERNAL_URL` or the new optional
    `PROJECTS_INTERNAL_URL`.
  - **crm-ui:** a read-only "Delivery" card on the deal page.
  - **notify-api:** `system:projects-api` may raise `projects` notifications.
  - **notify-ui:** the notification centre labels the `projects` origin "Projects" / "Progetti".
  - **projects-api:** one new migration on top of the Projects module's own; the take (`POST /queue/{dealId}/project`) behind
    `handoff:take`, with ops-manager candidates from auth, referent contacts from the CRM and a best-effort
    notification; `GET /queue`, the terms and purchase-order routes, the referent and the project-manager
    pick, hand-made projects with optional terms, and `GET /system/purchase-orders`; `GET /scope` gains
    `take` and `oversees`; new `ESTIMAI_INTERNAL_URL`, `NOTIFY_INTERNAL_URL` and `SERVICE_AUDIENCE`.
  - **projects-ui:** the queue (sales only), "New project" from a deal with the ops-manager and referent
    pickers, the purchase-order and terms cards, the awaiting notice with "Pick project manager", the
    list's "Awaiting project manager" state and filter, and hand-made creation with optional terms.

## 0.3.0

### Minor Changes

- 4f8e70f: Add activities-api (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host/0082/0083): one backend-only service for the activities, tasks and
  task blockers of the CRM and of Projects, with no permission catalog of its own, so every access decision is
  asked of the host (`crm-api`, `projects-api`) as the caller and fails closed. `crm-api` moves its activities,
  participants, blockers and meeting host state out (they are copied in once by
  `activities-api/scripts/import-crm-activities.ts`, a later push drops the old tables) and calls
  `activities-api` with the new service scope `activities.write`; `projects-api` becomes a host. `auth`
  registers the scope and the `activities-api` service client; `notify-api` accepts the `projects` origin and
  binds `system:activities-api` to `crm` and `projects`; `notify-ui` tags it. The shell trusts the
  activities-api origin; `crm-ui` reads activities from it; `projects-ui` gains a Tasks card on a project and a
  My tasks page.
- bc428e8: CRM notifications (specs/20261101-crm-notifications, ADR 20261101-notify-api-resolves-email-notice-address-from-auth):
  - **Notifications:** the CRM notifies people in the app when work is handed to them or concerns them: estimate requests and hand-backs, a new deal owner, an assigned task, a gate override, won and lost deals, a generated offer.
  - **Email notices:** estimate requested, ready or reopened, a new deal owner and an assigned task also send an email, in English. None of them contains any money.
  - **notify-api:** `POST /system/notifications` accepts `email: true`. The caller then needs the `emails.send` scope as well. notify-api looks up the recipient's address in auth and sends the new `notification_notice` email.
  - **auth:** new service endpoint `POST /system/users/contact` and new scope `users.contact`.
  - **Notification center:** `crm` is a new origin, shown in the bell and the notification center.
- bc428e8: CRM sales flow (specs/20261101-crm-sales-flow, ADR 20261101-crm-financial-visibility-permission/0055):

  - **Technical role:** a new `crm-technical` role that sees the CRM without the money. The new
    `deal:financials` permission is held by `admin` and `sales`.
  - **Estimates:** technical estimates are requested from a deal and created in EstimAI with the
    technician as editor. A deal reaches Proposal only once its estimate is marked ready; an
    admin can override that.
  - **Offers and attachments:** offer PDFs are generated and versioned, and files can be
    attached to a deal. Both live in the CRM's own EU bucket.
  - **Pipeline:** a card shows a badge while the deal waits for its technical estimate.
  - **CRM users only:** owners and task assignees must be users who can open the CRM.

  `auth`'s app-access check also answers by user id, and the user directory can be filtered by
  app.

  The `proposal` and `negotiation` stages are now shown as "Offer in preparation" and "Offer sent", and the newest offer has a "Mark as sent" action that moves the deal to "Offer sent".

- bc428e8: Add the CRM (specs/20261101-crm, ADR 20261101-crm-tool-shape-and-authorization/0053): companies, contacts, deals through a stage
  pipeline with per-currency weighted totals, activities and follow-up tasks. New services
  `crm-api` and `crm-ui`; `auth` registers the `crm` catalog and the `sales` role and lets
  `deal:manage` holders read the user directory; the shell mounts the tool at `/crm`.
- 3172659: EstimAI list (specs/20261108-estimate-list-oversight): an admin can list and open every estimate read-only (new `estimate:read-all` permission, seeded to `admin`; ADR 20261108-estimai-oversight-permission-amends-0036); closed estimates move from the default Open list to a Closed filter; an estimate linked to a CRM deal shows a Deal badge, kept up to date by crm-api's new deal-link notices (scope `deal-link-notices.send`, ADR 20261108-crm-pushes-deal-links-to-estimai). Deploy auth first, then add the scope to crm-api's `SERVICE_CLIENTS` entry, set `SERVICE_AUDIENCE` on estimai-api and `ESTIMAI_INTERNAL_URL` on crm-api, deploy both, and run `crm-api/scripts/backfill-estimate-links.ts --apply` once.
- d549baf: A technical estimate is finished when it is closed in EstimAI. The owner or an editor closes it from the estimate page, after which it is read-only until someone reopens it. The CRM follows on its own: the deal's estimate turns ready, its task is completed, and the requester and the deal owner are told; reopening it in EstimAI reverses that. The CRM no longer has its own "Mark ready" and "Reopen" buttons. Needs `estimate-notices.send` on estimai-api's service client in auth, `CRM_INTERNAL_URL` on estimai-api and `SERVICE_AUDIENCE` on crm-api.
- 800aec6: Operai is now invitation-only. Signing in creates a user only for an email in an allowed domain (`ALLOWED_SIGNUP_DOMAINS`) that holds a valid invitation; an allowed-domain email without one sees a page explaining this and joins a waiting list, and an outside-domain email is refused with nothing recorded. Admins review these requests in a new waiting list in the Admin tool and approve one into an invitation or dismiss it, and are notified of new requests.
- c30a110: Add Meetings (specs/20261104-meetings, ADR 20261104-meetings-tool-shape-visibility-by-participation to ADR 20261104-default-employee-grant-meetings-access): record, transcribe, summarise and question meetings from anywhere in Operai. New services `meetings-api` and `meetings-ui`.
  - **Capture:** record in the browser (microphone, plus the audio of a shared tab where the browser allows it), upload a recording, or paste text. The person who records attests consent, and that attestation is stored on the meeting.
  - **Transcripts and summaries:** meetings are transcribed in Italian or English, summarised from shared or personal templates, and can be questioned one at a time, with answers citing transcript passages. Questions and answers are private to the asker. Audio is kept for 30 days; transcripts and summaries live until the meeting is deleted. AI providers run in the EU with zero retention.
  - **Visibility:** a meeting is visible to its creator and its Operai participants. The creator can optionally open it to everyone who can open the host record. A meeting whose creator is deactivated is frozen, not orphaned.
  - **auth:** new `meetings` catalog (`meetings:access`, `template:manage`, `meeting:erase`). `employee` now holds `meetings:access` by default, the first default grant on that role, and `admin` holds the other two. `meetings:access` also opens the user directory for the participant picker (ADR 20261104-user-directory-gate-meetings-access). New service client `meetings-api` and scope `host-notices.send`.
  - **shell:** the gated tool at `/meetings` and the ungated "My meetings" page at `/my-meetings`, so a participant without tool access can still read what was captured about them. Adds the host-extension seam that lets another remote embed a Meetings panel, and the meetings-api origin for the session.
  - **Operators:** `meetings-api` needs its own database, an EU bucket for audio and the env contract in `tools/env-doctor`.
- 8c55bad: First of three pushes that retire the shared notification token (specs/20261013-notify-service-credentials,
  ADR 20261013-auth-mints-own-service-credential-in-process/0049). `notify-api` now accepts a scoped service credential on both
  internal routes (`/system/notifications` with `notifications.push`,
  `/system/emails` with `emails.send`), logs which caller made each accepted call,
  and treats `NOTIFY_INTERNAL_TOKEN` as optional. `auth` knows the `emails.send`
  scope, reserves the client id `auth` and can mint its own credential in process.
  `SERVICE_AUDIENCE` is now required in both services. No caller changes yet: every
  caller still sends the shared token and it still works.
- 0b3b843: Second of three pushes that retire the shared notification token (specs/20261013-notify-service-credentials,
  ADR 20261013-auth-mints-own-service-credential-in-process/0049). Every notify-api caller now authenticates as itself with a scoped,
  short-lived service credential and no longer reads `NOTIFY_INTERNAL_TOKEN`: `auth`
  mints its own `emails.send` credential in process for invitation emails,
  `refund-api` uses `notifications.push` for decisions and `emails.send` for the batch
  email, and `estimai-api` uses `notifications.push` for collaborator changes. A caller
  whose credential is missing or refused fails soft exactly as before. `notify-api` still
  accepts the shared token until it is deleted from the deployed services.
- 4f8e70f: Add the Projects module (specs/20261103-projects, ADR 20261103-projects-tool-shape-and-authorization/0080): the delivery work wellD runs. A
  project has a type (T&M, fixed price, maintenance, SaaS, internal), a state, a project manager and
  a team; its contracts record what each client bought as structured delivery terms (deadline and
  max effort, SLA, hour package, T&M positions, licence period), and `accounting` records the Bexio
  order id on each contract. No money anywhere in the module. New services `projects-api` and
  `projects-ui`; the shell mounts the tool at `/projects`.
  - **auth:** registers the `projects` catalog (`projects:access`, entity-scoped `project:manage`,
    `contract:bexio`) and the `project-manager` role; `sales` gains access and entity-scoped manage,
    `accounting` gains access and the Bexio order capability; `project:manage` holders can read the
    user directory; new service scope `crm.companies.read`.
  - **crm-api:** new `GET /system/companies`, readable only with a service credential carrying
    `crm.companies.read` (the first `/system/*` route on the CRM).
- 23c2015: Add desktop push notifications (specs/20261111-push-notifications, ADR 20261111-web-push-encrypted-payloads-not-fcm/0085/0086/0087): `notify-api` gains a Web Push channel with encrypted payloads (no Firebase), a `push_device` table, the user-JWT routes `GET /push/config`, `PUT`/`GET /push/devices` and `DELETE /push/devices/{id}`, and the settings `PUSH_ENABLED` (off by default), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `PUSH_EXCLUDED_ORIGINS`. It remembers a recipient's active answer for 30 s, shares one in-flight lookup per user and sends through a bounded pool. The shell serves the `/push-sw.js` service worker, releases the device on sign-out, and adds a push section to My profile to turn push on or off and to list and remove devices. Rotating the VAPID keys invalidates every subscription; see infra/README.md.

  `auth` limits `POST /system/service-token` and `POST /system/users/contact` per verified calling service instead of per address: new optional variables `SERVICE_TOKEN_SERVICE_LIMIT` (300), `USERS_CONTACT_SERVICE_LIMIT` (600), `SYSTEM_INVALID_CREDENTIAL_LIMIT` (20 invalid credentials per address) and `SYSTEM_RATE_WINDOW_MS` (600000), a 4 KiB body cap and a 4 096-character token cap, and one 429 with `Retry-After`. `SERVICE_TOKEN_RATE_LIMIT` and `SERVICE_TOKEN_RATE_WINDOW_MS` are retired: ignored with one startup warning, flagged by env-doctor; delete them from production once this `auth` is live. Deploy `auth` first and enable `PUSH_ENABLED` only after the live capacity re-measure (infra/README.md § Push notifications).

### Patch Changes

- 0648a4e: Invitation emails now retry once with a fresh service credential when notify-api answers 401, instead of reporting the send as failed straight away. A second 401 or any other failure is still the best-effort outcome; the invitation is never rolled back.
- 59e9b48: Dependency security update. better-auth moves to 1.7.18 everywhere, closing the advisory that let an OAuth state be used as a magic link to sign in as another user. The frontends move to vitest 4 and refreshed lockfiles, which clears the critical seroval and tinypool advisories. auth gains a migration adding three optional key columns that better-auth 1.7 expects on its signing-key table.
- 94f89d9: Access requests follow-ups: an invitation conflict (409) now names its cause in a `code` field (`active_user_exists` / `pending_invitation_exists`); in the Admin tool, deciding the last request on a page returns to the previous page instead of an empty list, and the list shows a focus ring when it takes keyboard focus after a decision.

## 0.2.0

### Minor Changes

- 621604b: Admins can now record and update an employee's home address from the Admin
  tool's Users section — with live, suggestion-assisted entry (Google Places,
  biased toward Switzerland and Italy) or fully manual typing, either way. Every
  change is captured in the existing audit trail. Employees gain a new "My
  profile" page (reachable from the account menu) where they can see their own
  address, read-only.
- 2b11a53: New Inventory tool (specs/20261006-hardware-inventory): a hardware register with assets, employee-confirmed
  assignment, a depreciation ledger with fiscal-year close, and invoice files.

  `inventory-api` and `inventory-ui` are new. The shell mounts the gated `/inventory` route
  and an ungated `/devices` route (a "My devices" screen for every signed-in user). `auth`
  gains the inventory permission catalog, a scoped service-token endpoint and a capability-gated
  user directory. `notify-api` accepts the scoped service JWT on `/system/notifications` and a new
  `inventory` origin app, which `notify-ui` renders. New environment variables must be set before
  deploying: see `infra/README.md` § `inventory-api` service.

  `auth GET /authz/resolve` now returns no permissions for a soft-deleted user, so a removed
  user loses access to `refund-api` and `inventory-api` within 30 seconds instead of keeping it
  until their token expires.

### Patch Changes

- cc1e678: A refused Google sign-in now says what went wrong instead of showing a 404.

  Better Auth's default OAuth error destination redirects to the service's origin
  root, and `auth` registers no `GET /` — so a user whose session was refused
  landed on the RFC 7807 handler and saw raw Problem JSON
  (`{"status":404,"detail":"GET / does not exist"}`), with the real reason only in
  a query string. OAuth failures are now routed to the hosted sign-in page, which
  renders the reason as a sentence next to the provider buttons. The
  `unable_to_create_session` code — a deactivated account — is spelled out as such
  rather than falling through to a generic "please try again", which could never
  have worked.

  Refusals are also logged now: `session.create.before` emits a structured
  `auth.session_denied` event carrying a distinct reason per branch
  (`soft_deleted_no_pending_invitation`, `soft_deleted_email_unverified`,
  `user_row_missing`) and the user id. Previously every branch produced the same
  opaque client-side code and no server-side trace at all, making a deliberately
  refused user indistinguishable from a broken OAuth configuration. The user id is
  logged rather than the email, to keep personal data out of log retention.

## 0.1.1

### Patch Changes

- bdf998c: Bind backends to IPv6 (::) on Railway (when RAILWAY_PRIVATE_DOMAIN is set) so private networking (\*.railway.internal) can reach them. Enables moving cross-service call URLs (AUTH_JWKS_URL / AUTH_BASE_URL / NOTIFY_INTERNAL_URL) to internal DNS and shared/reference variables (Layer 2), reducing the env-var sprawl. Local dev unchanged (keeps Bun default IPv4).
