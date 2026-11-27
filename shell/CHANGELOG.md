# @operai/shell

## 0.7.3

### Patch Changes

- 4f4d8c1: A drawer slides in from the right and its header lines up with the suite's header; a board's lanes are all as tall as the tallest, so a card can be dropped on any lane after scrolling.
- 8653331: The e2e legal-entities fixture no longer takes a connection URL for a local one when it carries a `host`, `hostaddr` or `service` parameter (libpq honours them over the URL's own host), and the import it runs now reads the CRM and auth database URLs the check actually looked at, passed after `direnv` has loaded the service's environment, so a value set there cannot replace them.

## 0.7.2

### Patch Changes

- 0b5863b: The sidebar's pin button sits centred on its tool's row.
- d5b9ad8: A `Board` (cards in lanes, moved by dragging or with the keyboard) in its own entry, `@operai/ui/board`; its styles ship with the shell.

## 0.7.1

### Patch Changes

- 9726f97: The Google Places client and an `AddressAutocomplete` field move into the component library, shared by every tool through the shell: the app passes its key and its texts, and chooses addresses only or any place (a company, a town). refund-api accepts and returns a mileage trip's start and end (`fromAddress`, `toAddress`, migration `20261125160000_mileage_trip_addresses`), prints the route in the request PDF and fills From and To in the register extract (format 4). The tools start using the field in the next release, once this shell is live (ADR 20261114, deploy rule).

## 0.7.0

### Minor Changes

- f5273af: The sidebar lists the tools in alphabetical order and each person can pin the tools they want at the top (remembered in the browser); the library gains a `pin` icon.

## 0.6.2

### Patch Changes

- c8984d9: The footer text (legal link, version, company) is readable: it uses the `soft` text colour (5.2:1 light, 5.4:1 dark) instead of `muted` (3.0:1 and 2.8:1, below WCAG 1.4.3), and the links turn to the text-safe accent on hover (A11Y-F2).

## 0.6.1

### Patch Changes

- 0699806: Below 640 px the tool navigation stays the icons-only rail whatever was chosen before, so a tool's content is no longer squeezed to a column a few words wide at 320 px (WCAG 1.4.10). There the toggle opens the expanded navigation as a panel over the content; Escape, a click outside it or a navigation closes it, and it is not remembered. Wider screens keep the stored collapse choice as before.

## 0.6.0

### Minor Changes

- ffa3235: The shell can now show hours-ui's Record hours button inside other tools' pages (specs/20261116-record-hours-in-place, ADR 20261116-record-hours-widget-through-the-host-extension-seam): a new host extension, `hours.recordHours`, takes six plain strings from the page that embeds it (what the hours are on, the project or deal and the task by id and name, and whether it sits in a page header or a task row), loads `hours/RecordHours` with the same 5 second timeout and error boundary as the other extensions, and shows the host's own fallback, a link to My hours, when hours-ui cannot be loaded or does not have the button yet. Nothing flows back to the host page.

## 0.5.0

### Minor Changes

- 2b3d2fe: Mount the new Hours remote (specs/20261112-time-tracking, ADR 20261112-hours-ui-ungated-remote) at `/hours` and `/hours/all`, and add a "My hours" / "Le mie ore" row to the user menu after "My meetings". The route is open to every signed-in user, including one with no tool grants: it has no app-access guard and is not a sidebar tool, so recording and reading your own hours never depends on a grant; with no session it still goes to sign-in, and a remote that fails to load shows the usual in-place error with Retry. The About dialog lists the Hours version, the Vercel CSP allows the remote and hours-api, `hours` joins the runtime remote overrides, and the shell's stylesheet scans the remote's source. The shell also reads the hours-api origin from `VITE_HOURS_API_URL` and trusts it for the Bearer token (T21). Copy is English and Italian.

## 0.4.0

### Minor Changes

- d4cb290: A new Accounting module keeps the accounting reference data of each legal entity in one place: the ledger accounts, the VAT codes and the monthly average exchange rates, which are those the Swiss Federal Tax Administration (AFC/ESTV) publishes for VAT (read from its monthly average file, served by the BAZG, and named as the source on the exchange-rates view). People with Accounting read or manage see an Accounting entry in the menu, with three views (ledger accounts, VAT codes, exchange rates) for each entity they are granted. A manager adds, deactivates and reactivates accounts and VAT codes (an entry is never edited or deleted), fetches or corrects a month's rate, and a reader sees the same lists without the controls. Each entity holds at most 200 ledger accounts and 50 VAT codes, deactivated ones included; since entries are never deleted this is a lifetime limit, and an addition beyond it is refused with `catalog_full`. Refund no longer keeps these lists: it reads them from Accounting each time it needs them, offers only Accounting's active entries, and keeps on each line a copy of the account, VAT code and exchange rate it booked, so a later change in Accounting never alters an approved line or an export already given to the books. When Accounting cannot be read, Refund refuses the change or approval and says so rather than guess; an approved foreign-currency line whose month had no rate gets its rate at the first export. In Refund's Settings the "Accounts and VAT" and "Exchange rates" views are gone (only the default account of each expense type stays, under "Default classification", with a note that points to Accounting; no VAT code is set by default and foreign-currency lines have no VAT code of their own).

  Auth declares the `accounting` permissions (`accounting:read` and `accounting:manage`, each limited to an entity if wanted; no separate access permission), grants them to the `admin` role (all entities) and the `accounting` role (WellD CH), derives the Accounting app from them, and accepts the new service scope `accounting.reference.read`. The shell mounts the Accounting remote at `/accounting`. New apps, `accounting-api` (port 8089, own database `accounting`) and `accounting-ui` (port 5183), start at 0.1.0.

  Deploy (a person, never an agent; the full runbook is `infra/README.md` § Release runbook, and one push redeploys everything in no fixed order, so each pairing fails closed meanwhile): provision first with `./infra/provision-tool.sh accounting --port 8089`, then set the variables, which are `accounting-api` (`DATABASE_URL`, `ALLOWED_ORIGINS`, `AUTH_*`, `SERVICE_AUDIENCE`, `ACCOUNTING_FX_SOURCE=bazg`), refund-api (`ACCOUNTING_INTERNAL_URL`, now required: without it refund-api does not start and Railway keeps the previous deployment) and the shell (`ACCOUNTING_REMOTE_URL`, `VITE_ACCOUNTING_API_URL`); remove `REFUND_FX_SOURCE` from refund-api, which no longer fetches rates. After the new auth is live, add `accounting.reference.read` to refund-api's entry in auth's `SERVICE_CLIENTS` (auth stops at startup on a scope it does not know, so never before). Until then Accounting answers refund-api 401 and Refund answers 503 `accounting_unavailable`, and approvals stay 409 `accounting_release_pending` until the release below. Then, in this order: `bun run seed:welld-ch --dry-run` and then without it in `accounting-api` (optional, when accounting prefers to type WellD CH's list in the app; it loads the list signed off by accounting, 19 ledger accounts and 6 VAT codes: `IPM81`, `IPM77`, `IP00`, `BZM81`, `IPM26`, `IPM38`; the script is in accounting-api's image, so it runs inside the service with `railway ssh`, or from a checkout), and then, from a checkout, `bun run accounting:release --dry-run` and then without it in `refund-api` (it reads Accounting first and exits 2, writing nothing, when it cannot; it requires `--offsets <file>`, the list of the last receipt numbers issued by hand in 2026, and exits 3 writing nothing without it; it takes `--defaults <json>`, and the old `--seed` option is gone). Run the release outside the monthly batch day. `seed:welld-ch` is in accounting-api's Docker image; `accounting:release` is not in refund-api's, which is why it runs from a checkout. refund-api's new migrations (additive, applied by its `preDeploy`) carry what the moved tables kept onto the lines and then drop them; a migration that has been applied is never edited. Before release, check the rates channel once from a networked machine with `ACCOUNTING_LIVE_RATES=1 bun test src/rates/afc.live.test.ts` in `accounting-api` (it is skipped otherwise and never runs in CI).

- 32db684: The sidebar groups rarely used tools under a "Settings" entry pinned at the bottom, above Admin: Letterheads moves there out of the tool list. The group opens and closes with its button, remembers the last choice, and opens by itself while you are in Letterheads; with the sidebar collapsed to icons, Settings shows its own icon, and a click expands the sidebar with the group open.

## 0.3.1

### Patch Changes

- a07f57d: The shell is released to ship the new `@operai/ui` components (`ErrorSummary`, `VersionTable`, `VersionBanner` and the `wrap` option of `Tabs` and `TabNav`), which the apps reach only through the live shell. Nothing changes in how the shell itself works.

## 0.3.0

### Minor Changes

- 4b6e43e: Register the Letterheads tool (specs/20261116-letterhead-service): a sidebar entry for holders of `letterheads:access`, the gated `/letterheads` route, the federated remote entry (build-time and runtime config) with its version in the About modal, the CSP origins for letterheads and letterhead-api in `vercel.json`, and `VITE_LETTERHEADS_API_URL` as a trusted origin, exposed to the remote as `getLetterheadsApiBaseUrl`. Playwright now serves letterheads-ui and runs the Letterheads e2e (configurator, access, versions, browser contract) and the CRM offer wizard e2e on the letterhead service.

### Patch Changes

- bc1bf94: Patch the `zod` and `undici` advisories in the frontends' lockfiles: `zod` (reached through better-auth and eslint-plugin-react-hooks) moves to 4.6.7 and `undici` (reached through jsdom, tests only) to 7.30.1. Lockfile-only, both within the parents' existing ranges; no package.json change.
- e58dc6e: The notification bell no longer goes silent after notify-api restarts. When the stream's ticket could not be minted during a reconnect (network failure, 408, 429, 5xx), the connection used to stop for good until the page remounted; it now retries with the reconnect backoff, and a refused mint (signed out, 4xx) still stops. The connection is one explicit state (idle, minting, open, waiting) with a generation bumped on close, so a mint answered after sign-out never opens a stream. The JWT cache is single-flight: concurrent calls share one `/auth/token` request, concurrent 401s share one refresh, and a token answered after `clearJwtCache()` is never cached.

## 0.2.1

### Patch Changes

- 33ebd92: CRM offer wizard (specs/20261115-crm-offer-wizard): an offer is now built step by step from a
  template that declares what it asks for, instead of editing a long contract text by hand.
  Pick a template for the deal's entity and language, fill in its fields, lists, tables and optional
  blocks, check the cost table and generate the PDF. The draft lives on the server, so it resumes
  after a reload or on another device; a missing or invalid answer blocks generation and says where.
  An unsent offer can be edited under the same reference and a sent one revised as the next `rN`; a
  legacy contract offer still opens the classic dialog. Administrators write wizard templates in
  Settings (self-describing markup with live problems) and try them on sample answers before
  saving; the seven standard templates are seeded per entity and language.

  - **crm-api:** a new migration (`20261115120000_offer_wizard`, apply it before the UI ships);
    template format `wizard` alongside the classic one, with supersession per entity and language;
    draft routes (create, resume, save with If-Match, discard) and generation from the stored draft;
    renderer support for several total rows and option lines in the cost table.
  - **crm-ui:** the offer wizard page, the deal page's offers card (draft row, Continue, Discard,
    Edit, New revision) and the template editor with its "Try the wizard" view.
  - **ui:** new paper tokens used by the offer document and wizard preview.
  - **shell:** patch only: it ships the library with the new tokens.

  The wizard's preview draws the entity's letterhead behind its first page (pdf.js in the browser, fetched
  from the CRM's own bucket), and the seeded templates name the issuer — legal name and address — from the
  entity profile instead of their text; seeds created earlier and never edited are upgraded once in place.

  The preview is laid out as real A4 pages inside the PDF's frame, with the letterhead behind every page and
  page breaks approximating the PDF's. Uploaded letterheads are bounded by decoded size before any parser
  runs, stored as the checked bytes, and refused (409 `letterhead_unusable`) when a stored one fails the bound.

- 66ef8fa: The design system `@operai/ui` is compiled once, by the shell, and shared with every remote as a Module Federation singleton: remotes declare it with `import: false` and no longer bundle it (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell). The rich-text entry is still compiled by crm-ui, meetings-ui and projects-ui.

## 0.2.0

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
- bc428e8: Add the CRM (specs/20261101-crm, ADR 20261101-crm-tool-shape-and-authorization/0053): companies, contacts, deals through a stage
  pipeline with per-currency weighted totals, activities and follow-up tasks. New services
  `crm-api` and `crm-ui`; `auth` registers the `crm` catalog and the `sales` role and lets
  `deal:manage` holders read the user directory; the shell mounts the tool at `/crm`.
- 28872b4: Every tool now shares one look for actions, text and page layout: buttons and
  dialogs come from the shared library with the same meaning-based styles
  (primary actions meet contrast everywhere, cancel is quiet, destructive is
  red), text uses one type scale with an 11px minimum, labels drop their "+"
  and arrow prefixes, each tool has the same title bar, tabs and page header on
  a common width scale, and every detail page has a "Back to …" link. EstimAI's
  shortcuts, health and About dialogs are now real modal dialogs.
- 28872b4: The whole suite now speaks Italian as well as English: every tool has a
  complete Italian translation and follows the browser's language, chosen once
  for all tools. Dates read the same everywhere (31.10.2026), amounts show their
  currency code with the language's separators, statuses use one shared set of
  icons and colours so the same symbol always means the same thing, emoji and
  text symbols are replaced by real icons that render on every system, headings
  are in sentence case, loading and empty screens look the same in every tool,
  detail pages are organised in cards, and EstimAI's views are proper tabs.
- c30a110: Add Meetings (specs/20261104-meetings, ADR 20261104-meetings-tool-shape-visibility-by-participation to ADR 20261104-default-employee-grant-meetings-access): record, transcribe, summarise and question meetings from anywhere in Operai. New services `meetings-api` and `meetings-ui`.
  - **Capture:** record in the browser (microphone, plus the audio of a shared tab where the browser allows it), upload a recording, or paste text. The person who records attests consent, and that attestation is stored on the meeting.
  - **Transcripts and summaries:** meetings are transcribed in Italian or English, summarised from shared or personal templates, and can be questioned one at a time, with answers citing transcript passages. Questions and answers are private to the asker. Audio is kept for 30 days; transcripts and summaries live until the meeting is deleted. AI providers run in the EU with zero retention.
  - **Visibility:** a meeting is visible to its creator and its Operai participants. The creator can optionally open it to everyone who can open the host record. A meeting whose creator is deactivated is frozen, not orphaned.
  - **auth:** new `meetings` catalog (`meetings:access`, `template:manage`, `meeting:erase`). `employee` now holds `meetings:access` by default, the first default grant on that role, and `admin` holds the other two. `meetings:access` also opens the user directory for the participant picker (ADR 20261104-user-directory-gate-meetings-access). New service client `meetings-api` and scope `host-notices.send`.
  - **shell:** the gated tool at `/meetings` and the ungated "My meetings" page at `/my-meetings`, so a participant without tool access can still read what was captured about them. Adds the host-extension seam that lets another remote embed a Meetings panel, and the meetings-api origin for the session.
  - **Operators:** `meetings-api` needs its own database, an EU bucket for audio and the env contract in `tools/env-doctor`.
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
- 1f14056: Push notifications: Operai now asks once, when it loads, whether to turn push notifications on (specs/20261111-push-notifications AC-1.9). The browser's own permission prompt still appears only after "Turn on". "No thanks", turning push off in My profile or removing this browser counts as an answer and the question is not shown again for that user on that browser. The setting in My profile is unchanged.
- 47ef6e2: While a meeting is being recorded you can move anywhere in Operai: a recorder widget stays visible above every page, with the elapsed time, live sound levels for the voice coming in (microphone) and going out (shared tab), Pause, Resume, Stop and a way back to the meeting. Drag it, or move it with the arrow keys, around the edge of the window. Leaving the meeting no longer asks for confirmation; closing or reloading the tab still does. New library component `FloatingPanel`.
- 23c2015: Add desktop push notifications (specs/20261111-push-notifications, ADR 20261111-web-push-encrypted-payloads-not-fcm/0085/0086/0087): `notify-api` gains a Web Push channel with encrypted payloads (no Firebase), a `push_device` table, the user-JWT routes `GET /push/config`, `PUT`/`GET /push/devices` and `DELETE /push/devices/{id}`, and the settings `PUSH_ENABLED` (off by default), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and `PUSH_EXCLUDED_ORIGINS`. It remembers a recipient's active answer for 30 s, shares one in-flight lookup per user and sends through a bounded pool. The shell serves the `/push-sw.js` service worker, releases the device on sign-out, and adds a push section to My profile to turn push on or off and to list and remove devices. Rotating the VAPID keys invalidates every subscription; see infra/README.md.

  `auth` limits `POST /system/service-token` and `POST /system/users/contact` per verified calling service instead of per address: new optional variables `SERVICE_TOKEN_SERVICE_LIMIT` (300), `USERS_CONTACT_SERVICE_LIMIT` (600), `SYSTEM_INVALID_CREDENTIAL_LIMIT` (20 invalid credentials per address) and `SYSTEM_RATE_WINDOW_MS` (600000), a 4 KiB body cap and a 4 096-character token cap, and one 429 with `Retry-After`. `SERVICE_TOKEN_RATE_LIMIT` and `SERVICE_TOKEN_RATE_WINDOW_MS` are retired: ignored with one startup warning, flagged by env-doctor; delete them from production once this `auth` is live. Deploy `auth` first and enable `PUSH_ENABLED` only after the live capacity re-measure (infra/README.md § Push notifications).

### Patch Changes

- 28872b4: The design system gains `Combobox` (suggestions while typing) and `Drawer` (a
  side panel for reference content). Admin's address and country fields and
  Inventory's holder and supplier pickers now share the one `Combobox`, which
  also keeps the highlighted suggestion in view in a long list. EstimAI's model
  reference opens in the library `Drawer`. Admin's user detail and mileage-rate
  pages read permissions from the shell instead of fetching them again. The
  suite's end-to-end tests look for the current Refund label instead of the old
  "Refund (Rimborsi)".
- 59e9b48: Dependency security update. better-auth moves to 1.7.18 everywhere, closing the advisory that let an OAuth state be used as a magic link to sign in as another user. The frontends move to vitest 4 and refreshed lockfiles, which clears the critical seroval and tinypool advisories. auth gains a migration adding three optional key columns that better-auth 1.7 expects on its signing-key table.
- 6e34649: The recorder widget no longer slides and resizes when it appears: `FloatingPanel` glides only when the person moves it (arrow keys or a drop), and a change of size is applied at once; the shell shows its loading fallback only when the widget takes longer than 400 ms to load.
- 28872b4: Tables, paging, forms and feedback now work the same in every tool: record
  lists are accessible data tables, long lists page the same way, every form
  marks required fields with an asterisk and explains errors next to the field
  (moving focus to the first one), amounts accept a comma or a dot, dates use
  the date picker, every save, invite and delete confirms where you acted,
  errors you can retry are orange and errors you must fix are red, EstimAI no
  longer uses browser alert boxes, and the page no longer scrolls behind an open
  dialog.
- 28872b4: One styling dialect across the suite (ADR 20261031-one-styling-dialect-token-utilities): colours and fonts are Tailwind
  utilities generated from the shared design tokens, never inline styles, and a
  lint rule keeps it that way. Hover and focus colours now apply where inline
  colours used to override them, date pickers follow the light theme, EstimAI's
  AI purple and tinted highlights follow the theme too, and each tool's
  standalone build uses the suite's real tokens instead of a stale copy.
- 28872b4: New shared design system `@operai/ui` (operai-ui/, ADR 20261031-shared-ui-library-consumed-as-source): the suite's tokens,
  themes and component classes move into it from the shell, together with React
  components (buttons, dialogs, banners, badges, fields, tables, page and tool
  layout, empty and loading states) and a Storybook. refund-ui is the first app
  built on it: its dialogs now share one focus and keyboard behaviour, its buttons
  follow the suite's variants, and its secondary text and status colours meet
  WCAG AA in both themes. Suite-wide, `font-mono` now renders DM Mono as intended,
  and the shell's Tailwind scan includes notify-ui.
- 9adfd4a: The refund tool's settings (mileage rates per entity and the accounting distribution email) move from Admin to a new Settings tab in Refund (`/refund/settings`), shown to whoever holds `rate:read` or `settings:read`. Admin no longer has a Refund section.
- 28872b4: The design system gains `Menu` (the header's logo and account menus, now with
  full keyboard support) and `CheckboxGroupField` (pick several options from a
  list), and `ConfirmDialog` can ask for an acknowledgement and hold fields.
  Refund's "Mark as paid" and Inventory's dispose, close-year and new-rule
  dialogs now share that confirmation; Admin's role and department checklists
  and Inventory's invoice linking share the checkbox group. Success messages
  dismiss themselves after the same time in every tool.
- bc428e8: The tool content area reserves the scrollbar's width, so switching between a short and a tall page no longer shifts the content sideways.
- 28a766f: Public `GET /version.json` on the shell answers `{"version":"<operai suite version>"}` without sign-in, so a release can be checked as online (RELEASING.md § After).
- 48de67f: Tasks have a rich description with pictures and attachments (ADR 20261113-task-description-files-in-activities-api-bucket). In the CRM and in Projects a task's text is now formatted (bold, lists, check lists…); pictures can be chosen, pasted or dropped into it, and files (PDF, Office, text, CSV, pictures) attached under it. Files are uploaded when the task is saved, live in activities-api's own EU bucket and are shown to whoever can read the task. A task's existing plain text becomes its description.
- c4ba4c3: Pages use more of a wide screen: the default tool column grows from 64rem to 80rem and the wide one (the CRM pipeline) fills the width beside the sidebar; single forms stay at 40rem.

## 0.1.0

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

## 0.0.1

### Patch Changes

- 6a13795: The shell footer/About dialog was showing `@operai/shell`'s own package
  version (`0.0.0`) instead of the Operai suite's umbrella version — the two
  are different numbers, and only the umbrella one is meaningful to a user.
  The footer now reads the umbrella version from a committed, generated file
  (`shell/src/lib/suiteVersion.generated.json`, kept in sync by
  `scripts/version.mjs` at release time) instead of `shell`'s own
  `package.json`.

  The About dialog additionally gains a "Components" section listing each
  mounted remote's own version (EstimAI, Refund, Admin, Notify), each exposed
  via a small new federated `./version` module. A remote whose version can't be
  resolved — unreachable, cold-starting, or (going forward, since every app
  deploys independently) simply predating this change — degrades to a muted
  "—" rather than blocking the dialog or throwing.

- 590047b: Add the receipt-bucket origin (`https://t3.storageapi.dev`) to the shell CSP's
  `connect-src`. Receipt uploads POST directly to the object-storage bucket
  (ADR 20260716-eu-object-storage-refund-attachments), so that request is governed by the shell's CSP even though no
  Operai service is involved — without this pin the browser blocks every upload
  before it leaves the page, regardless of the bucket's CORS rule.
- 09025ee: Serve the SPA document with `Cache-Control: no-store`. CSP rides on a response
  header and a `304 Not Modified` does not carry it, so a browser holding a
  cached copy kept enforcing a stale policy — which left receipt uploads blocked
  for two days after the CSP fix was live and correct. `max-age=0,
must-revalidate` is not sufficient; it still permits the 304.
