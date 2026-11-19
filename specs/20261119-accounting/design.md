---
spec: 20261119
status: draft
---

# Design: Accounting — the /accounting app and the Refund changes that follow from it

Designed unattended on 2026-11-19 from `spec.md` and `plan.md` (both approved, read in full), `specs/20261118-refund-accounting-export/design.md` (including its Implementation sync and Browser accessibility pass), and a static read of `refund-ui/src`, `letterheads-ui/src`, `inventory-ui`, `meetings-ui/src/lib/hostLinks.ts`, `shell/src/lib/{tools,session}.ts`, `shell/src/components/Sidebar.tsx`, `operai-ui` (`docs/design-system.md`, `docs/building-pages.md`, the component list) and `refund-ui/src/test-support/axe.ts`. The app was not run (no dev server, no credentials in this run) and the visual companion was not enabled, so there are no mockups: layouts are words and small text wireframes.

The suite already has a design system (`@operai/ui`) and Accounting is a new tool **inside** it, not a new product surface, so there is **no Visual direction section**: tokens, type scale, icons and components are the system's, and nothing is added to `tokens.css`.

Decisions are numbered `UX-n`, each with its reason and the cost of reversing it. Everything the plan or spec has to answer is under **Gaps found** at the end.

## Decisions

| # | Decision | Why | Cost to change |
|---|---|---|---|
| UX-1 | The three views of accounting-ui (Ledger accounts, VAT codes, Exchange rates) are **routes**, so they are a **`TabNav`** of links in `ToolLayout`'s `nav` slot, with `wrap`, not `Tabs`. The plan says `Tabs`; this corrects it. `?entity=` is carried from tab to tab; `?month=` is dropped when leaving Exchange rates. | design-system § Tool frame: "`TabNav` is navigation: each tab is a page with its own URL. `Tabs` switches views of the SAME page". The plan gives each view its own path (`/accounting/ledger-accounts` …) and the AC-7.3 deep link is one of them, so they are pages. `TabNav` also gives `aria-current="page"` for free and the browser Back button walks views. The 20261118 `Tabs` choice (UX-1 there) was about same-page views of Settings, which no longer exist in Accounting. | Low: swap the component and the route `search` handling. |
| UX-2 | The **entity switch** is one labelled native `<select>` ("Entity"), shown only when `/v1/me` lists two or more entities, in each page header's `actions` slot (one shared `EntitySwitch` component). The choice is written to `?entity=` with `replace`. With one entity there is no switch. | AC-8.2. The tool already has a tab row (UX-1); a second row of entity tabs (the letterheads-ui precedent) would put two tablists on one screen. A select also scales when WellD Italia is not the last entity. A select in `actions` is a small stretch of "page-level actions" and costs no new library piece. Focus stays on the select; a polite status says "Showing WellD Italia". | Low. |
| UX-3 | **Every list names its entity**, in three places that serve three readers: the card title ("Ledger accounts — WellD CH", the plan's wording), the table caption ("WellD CH ledger accounts", for screen-reader table navigation) and the title of each dialog ("Add ledger account — WellD CH"). A person with one entity sees the same titles. | AC-8.2 ("every list names its entity"). A manager who switches entity and then adds an account must be able to see, in the dialog, which books it goes to. The page's h2 stays the generic view name so the heading outline is tool h1, view h2, card h3. | Low. |
| UX-4 | **Write controls come from `GET /v1/me`'s `canManage` for the displayed entity**, never from `usePermissions()`. A reader (read, no manage) sees the lists with no Add button and no row actions and one quiet sentence in the card: "You can view this list. Accounting managers add and deactivate accounts." | The browser never evaluates entity conditions (ADR 20261117 point 4, plan D17). `usePermissions()` only says whether a grant exists, not for which entity. The sentence answers "where is the Add button?" for a reader without adding a state. | Low. |
| UX-5 | Rows, toggles and URLs are keyed by the **natural key** (ledger account number, VAT code), never an id. `useCatalogToggle` takes `keyOf(item)`; `getRowKey` is the key; a key is `encodeURIComponent`-ed in a path. | The plan's wire has no ids (D1, D24, D18). Moving the 20261118 components with `git mv` leaves `id` everywhere; this names the change so it is not missed. | None (forced). |
| UX-6 | Dialog validation **mirrors the server limits from one client module** (`lib/limits.ts`, the same numbers as `accounting-api/src/catalog/limits.ts`: 20, 120, 16, 80, 2 decimals; rate 0 < r < 1000 with 6 decimals). A refused field says **which** value and **why** (empty / wrong format / too long). The server's `fields[]` drives the same messages when the client check passed but the server refused. **No `ErrorSummary` inside the two add dialogs and the correction dialog.** Focus goes to the first refused field, whose own `role="alert"` error carries the sentence. | AC-1.2, AC-1.5, AC-2.5, AC-8.4 ("refused values are announced with focus moved to the first one"). The plan's wording ("ErrorSummary") is the page-level pattern of design-system § Refused save, written for a long form; in a dialog of two or three fields a summary would announce the same sentence twice and add a tab stop. The AC is met by focus plus the field's own alert. | Low: add `ErrorSummary` to a dialog. |
| UX-7 | **Deactivate** is a `ConfirmDialog tone="primary"` with neutral wording that does not name a consumer; **Reactivate** acts at once. Body: "No module can choose it any more. What was already booked with it keeps it. A module that uses it as a default needs another one. You can reactivate it at any time." | Reversible, so not `danger` (design-system § Dialogs; UX-3 of 20261118). Accounting does not know its consumers (open question 3: no warning in v1), so the sentence is general, not a list. | Low. |
| UX-8 | **No who-added, no history, no per-cell history drawer** in the Accounting app. A list row shows only what the minimal projection carries: number or code, name or label, rate, active state. A rate cell shows the rate and its origin only. | Plan D18 and the spec's non-goal "no screen for the audit trail or an entry's history". It also removes the 20261118 "Added" column and the rate history drawer (`ChangeHistoryDrawer` stays in refund-ui for the defaults, AC-4.7). | Low (the data is recorded). |
| UX-9 | Exchange rates, managers: the **auto-fetch once per visit stays** (plan D26, UX-11 of 20261118), but the UI no longer sends a `trigger` (the server derives it, D4). Last fetch states its **outcome in words**, not only a time (closes A-7 of 20261118). A "Source" fact says where rates come from. | A-7: a time alone reads as success. AC-2.1 and AC-2.11 are about the source, so naming it is cheap and symmetrical to "no official source". The source fact is a small addition no AC asks for (reported below). | Low. |
| UX-10 | **The correction dialog's copy is rewritten.** The 20261118 sentence "A batch exported before this correction will export differently if it is exported again" is now false (AC-5.3, AC-5.5: an approved line keeps its copied rate). New: "Anything booked from now on uses this rate. What was already booked with the previous rate keeps it. The previous value is kept in the audit trail." The client limit becomes "greater than 0 and below 1000, up to 6 decimals" (AC-2.5); the 20261118 check accepted up to 9999. | A user who reads the old sentence would re-export expecting a change. The limit must match AC-2.5 or a value of 1000 or more is refused only by the server. | Low. |
| UX-11 | **A deep link to a month** (`?entity=welld_ch&month=2026-03`, AC-7.3) scrolls to and focuses that row's header once, when the table first appears. A month that is **not in the table** (not ended yet, or older than 2026-01 with no rate recorded or asked for) shows a status note: "2026-11 is not in the list. A month is listed once it has ended; its rate is published a few days later." | The 20261118 card ignored an unlisted month silently. Now the link comes from Refund's export blocker, and a pending line approved in the current month blocks the export with a month that the table cannot show (it lists up to the last completed month). Silence there is a dead end. | Low. |
| UX-12 | **Entity in the URL.** A value that is not an entity id falls back (with `replace`) to the first covered entity. A known entity the person does not cover (`?entity=welld_it` for a CH-only manager) shows the not-found panel with a link back, never the other entity's data and never a silent substitution. A `404 not_found` from a list (a grant narrowed during the session) re-reads `/v1/me`, falls back, and says so once in an info note. | AC-3.5 ("refused as if it did not exist") and the plan's own e2e ("a WellD Italia URL → 404 view"). The plan's UI paragraph says "falls back to the first covered entity" for any outside value; the two contradict (Gaps G3). Showing CH data when the URL said Italia would be a misattribution, which matters more in accounting than anywhere. | Low. |
| UX-13 | **WellD Italia has two different "nothing" states.** Ledger accounts and VAT codes: `StatePanel` "Nothing entered yet for WellD Italia" (AC-8.3, an empty list, not an error). Exchange rates: `StatePanel` "No official source for WellD Italia yet", no table, no Fetch now, no last-fetch line (AC-2.11). | They mean different things: one invites entry, the other says nothing can be fetched or kept yet. Same panel for both would let a manager hunt for a missing button. | Low. |
| UX-14 | In the shell: the tool is **"Accounting" / "Contabilità"**, appended at the **end of the main list** (after Projects, before the pinned Admin), icon **`list-ordered`**. | `shell/src/components/Sidebar.tsx` has `TOOL_ICONS: Record<ToolId, ReactNode>`, so a new `ToolId` does not compile without an icon, which the plan does not list (G1). The library has no ledger or book icon; adding one is a library change (story, test, changeset) this feature does not need. A numbered list is what a chart of accounts is. Appending leaves everyone's existing order alone. | Low (an icon name). |
| UX-15 | **One failure ladder for every card and for the shell frame**: 403 `accounting_forbidden` → `PermissionDenied` (alert, focus, no retry); 503 → warning `Banner` titled "Authorization service unavailable" with Retry (the library pattern, ADR 20260716-refund-api-authorization-enforcing-resource-server); any other failure → warning `Banner` with the card's own sentence and Retry. A write refused with 403 `accounting_manage_required` says "You don't have permission to do this." **and** re-reads `/v1/me` so the controls that should not be there disappear. | design-system § States, plus AC-3.4: a grant removed mid-session must not leave a button that always fails. | Low. |
| UX-16 | **Refund Settings** has two views, **General** and **Default classification** (`?section=general\|defaults`), as `Tabs` (same-page views, unchanged from UX-1 of 20261118). An unknown or legacy value (`accounting`, `exchange-rates`) shows General, as the plan says: 20261118 is unreleased, so no bookmark exists to honour. The **Accounting link note** heads the Default classification view as one sentence of secondary text, not a banner. | AC-4.6. A permanent explanation is not a notification, so no `Banner`. Users without `settings:read` see only General and never an accounting setting, so they need no note. | Low. |
| UX-17 | The cross-app link (Refund → Accounting, both the Settings note and the export blocker) is a plain **`<a className="link" href="/accounting…">`**, the precedent of `projects-ui` → CRM links, **not** the `suiteLinkProps`/`navigateSuite` helper of meetings-ui. | Zero new code and no `shell/session` stub change; a real `href` works with open-in-new-tab and middle-click. The cost is a full document load, acceptable for a link that leaves the tool. | Low: copy `suiteLinkProps` later. |
| UX-18 | **One vocabulary for the state of an Accounting entry in Refund**, in every place a number or code is shown: `active` (no mark), `deactivated` (`StatusBadge` `voided`, "Deactivated in Accounting"), `not_found` (`StatusBadge` `attention`, "Not found in Accounting"), `unverified` (Accounting cannot be read: **no badge**, the value as recorded, and the page-level note says why). | AC-4.5 and SA-3 (an entry "no longer found" is treated like a deactivated one). `attention` is the dictionary's "needs someone, nothing failed"; `voided` is the reversible "no longer offered". An `unverified` value is not wrong, it is unchecked, so a badge would cry wolf. | Low. |
| UX-19 | **Accounting unreachable is a state of the screen, not an error of a control.** Settings Default classification and the review page each show **one** warning `Banner` (polite, not dismissible, with Retry) and everything below it reads "as recorded" and cannot be changed: Change and the selects are `aria-disabled`/read-only with their reason beside them. **History still opens** (it reads Refund's own rows). | AC-6.5, AC-6.9. A disabled button with no reason is a dead end (design-system § Buttons rule 5); one banner per page beats one error per row. | Low. |
| UX-20 | **Rate pending is not a failure.** An approved WellD CH line in a foreign currency with no copied rate shows a neutral-to-attention `StatusBadge` "Rate pending", "—" for CHF and VAT amounts (never 0), and one sentence that the rate is copied at the first export. Before approval, the same absence reads "No rate yet … you can still approve". | AC-5.6 and the owner's answer to open question 1: approval is not refused for a missing rate. The 20261118 panel said "The CHF and VAT amounts need it", which now reads as a blocker where there is none. | Low. |
| UX-21 | **`accounting_unavailable` on Approve stays inside the approve dialog** (plan), as `accounting_release_pending` does: a `role="alert"` sentence naming the cause and the remedy, Approve still available. Each refusal has its own "what stayed" sentence (approve: "Nothing was approved"; classify: "The classification was not changed"; settings: "Nothing was saved"). | AC-6.1, AC-6.2, AC-6.10. A dependency outage has nothing to fix on the page, unlike `classification_missing` (UX-5 of 20261118), so the dialog is the right place. | Low. |
| UX-22 | **Export card.** A new blocker "Accounting cannot be read" is a separate heading inside the same warning blocked banner (not a missing-rate item). A "N lines get their exchange rate at this export" sentence shows in the Ready and Blocked states. After a successful download the summary is **read again quietly**, so the sentence disappears once the rates are frozen. A missing-rate item links to Accounting only when `viewer.canOpenAccountingRates`; otherwise "Ask an accounting manager to enter or fetch it." | AC-6.6, AC-5.6, AC-7.3. | Low. |
| UX-23 | **A Retry that removes its own banner returns focus to a stable anchor and announces the result.** The anchor is the card heading (Settings) or the "Lines" heading (review page). A polite line says "Accounting can be read again." or "Accounting still cannot be read." | Finding A-3 of 20261118 (focus dropped to `<body>` when the banner and its button unmounted) would otherwise be copied into two new places. | Low. |

## Flows

Ids: **FA** = Accounting app, **FR** = Refund. Each flow names its story and acceptance criteria. "Screen" ids (AS, RS) are in the next section.

### Accounting app

**FA1 — Reach Accounting** (US-8: AC-8.1, AC-3.6, AC-3.9)
1. A person with Accounting read or manage for at least one entity sees **Accounting** in the sidebar (the shell derives it into `apps`, plan D6). The entry opens `/accounting`, which redirects to `/accounting/ledger-accounts`.
2. `AccountingShell` (AS1) reads `GET /v1/me`: loading, then the first view of the first covered entity (WellD CH first).
3. Exits: 403 `accounting_forbidden` (or an empty entity list, treated the same) → `PermissionDenied` in the page area, title still on screen (AC-3.6). 503 → authorization banner with Retry. Anything else → warning banner with Retry. A Refund reviewer or admin with no Accounting capability never sees the entry and, with the address typed, is denied by the shell guard or by this state (AC-3.9).

**FA2 — Switch entity** (AC-8.2, AC-3.5)
1. With two or more covered entities the page header has the **Entity** select (AS2). Choosing one replaces `?entity=`, remounts the cards (keyed by entity, so a row of one entity is never shown under another's title), and announces "Showing WellD Italia".
2. One covered entity: no select; the titles still name it.
3. A known entity the person does not cover (typed URL) → not-found panel (UX-12). A grant narrowed during the session → `404 not_found` from a list → `/v1/me` is re-read, the first covered entity is shown, one info note says "You no longer have access to WellD Italia. Showing WellD CH."

**FA3 — Add a ledger account** (US-1: AC-1.1, AC-1.2, AC-1.3, AC-1.12)
1. Manager only. **Add account** in the card action → dialog "Add ledger account — WellD CH" (AS6a): number, name. On blur a client pre-check compares the number with the loaded list of **this entity** (the same number in another entity is allowed, AC-1.3).
2. Save → the row appears, active; a success banner says "Account 5905 added"; focus returns to Add.
3. Refusals: empty / wrong format / too long (number) and empty / too long (name) name the field and the reason; 409 duplicate names the number, and, when the loaded list shows it deactivated, adds "Reactivate it from the list." (two managers adding the same number at once: the loser gets the same 409 message). 403 → "You don't have permission to do this." and `/v1/me` is re-read. Network/5xx → generic error above the buttons, every typed value kept.
4. There is no edit control anywhere and no delete (AC-1.12): the row has only Deactivate or Reactivate.

**FA4 — Add a VAT code** (AC-1.5, AC-1.6, AC-1.7)
Same shape as FA3. Fields: code (upper-cased when the field loses focus), label, rate in percent (`MoneyInput`, dot or comma, 0 to 100, 2 decimals). The dialog says the rate cannot be changed later. A duplicate is case-insensitive (`imp81` when `IMP81` exists) and names the code; if the existing one is deactivated the message points to Reactivate (AC-1.6). The list has no edit control: the rate is read-only text.

**FA5 — Deactivate or reactivate** (AC-1.4, AC-1.8, AC-1.9, AC-1.10, AC-1.11)
1. **Deactivate** → `ConfirmDialog` (UX-7), default focus Cancel. Confirm → the badge turns *Inactive*, the action turns into **Reactivate**, a success banner confirms, focus moves to the row header (the pressed button is gone).
2. **Reactivate** → at once, same confirmation and focus.
3. 409 `already_active` / `already_inactive` (a stale list, or a second manager acted first, AC-1.11) → danger banner "Account 5905 is already active." and the list reloads; nothing else changes.
4. Other consumers' use of the entry is not Accounting's business here (open question 3): no warning, no usage list.

**FA6 — A reader** (AC-3.2, AC-3.4, AC-2.3)
A reader sees all three views fully, with no Add, Deactivate, Reactivate, Fetch now or Correct (UX-4), plus the quiet read-only sentence. A manager sees everything a reader sees (AC-3.2). A direct request a reader cannot make is refused by the API (AC-3.4); the UI never offers it.

**FA7 — Browse exchange rates and fetch** (US-2: AC-2.3, AC-2.7, AC-2.8, AC-2.9, AC-2.10, AC-2.11)
1. **Exchange rates** view (AS5): months newest first from January 2026 to the last completed month (plus an older month once it has a rate or was asked for), by EUR, USD and GBP. A cell is the rate, **Fetched** or **Corrected**, or **Missing** (no value estimated from another month, AC-2.7).
2. The last fetch and its outcome are always stated; a failed one is a persistent warning that outlives any toast (AC-2.8), visible to readers too.
3. Managers: when the GET says `fetchDue` the view fetches once, quietly (UX-9). **Fetch now** runs the fetch for months with no recorded rate (AC-2.9) and reports: "Recorded the rates for N months", "No new rates", a month not published yet, throttled, more months to fetch, or the failure.
4. A consumer's own on-demand fetch (AC-2.10) is invisible here except that its result may appear as new rates or as the last fetch.
5. WellD Italia: no table, the no-source panel (UX-13).

**FA8 — Correct a rate** (AC-2.4, AC-2.5, AC-2.6)
Manager → **Correct** on a cell (also on a Missing cell: a manager may type a rate for a completed month the source never published) → dialog (AS6c) → Save → the cell shows the new value with *Corrected*. Refused: not greater than 0, 1000 or more, more than 6 decimals (client and server), month not ended (`month_not_completed`, a general error). A later fetch never replaces a correction (AC-2.6): the UI just keeps showing it.

**FA9 — Arrive from Refund** (AC-7.3)
`/accounting/exchange-rates?entity=welld_ch&month=2026-03` opens the Exchange rates view of WellD CH with the row focused (UX-11). The person must hold Accounting read for WellD CH, which is exactly what Refund checked before showing the link; if the grant changed since, FA1 or FA2's refusals apply.

**FA10 — Access changes under the person** (AC-3.4, AC-3.5, AC-3.6)
A write that returns 403 `accounting_manage_required` re-reads `/v1/me`; the write controls vanish and an info note says "Your access to Accounting changed. The page was updated." A list that returns 403 `accounting_forbidden` replaces the view with `PermissionDenied`.

### Refund

**FR1 — Open Settings** (AC-4.5, AC-4.6, AC-6.9)
Settings has **General** (mileage rates and the distribution email, untouched) and, with `settings:read`, **Default classification**. No Accounts and VAT, no Exchange rates. The Default classification view starts with the Accounting link note: with Accounting in the person's `apps` a link "Open Accounting"; without, the name of the app and "kept … by accounting managers". Each of the twelve types shows its default account (number and name) and VAT code, or **None**; the foreign-currency VAT code is shown above them.

**FR2 — A default points to something that changed** (AC-4.5)
A default whose account or VAT code was deactivated in Accounting, or is no longer there, carries a badge in its cell (UX-18) and counts in one card-level note: "N defaults need a new choice …". It counts as no default for new classifications. **Change** opens the dialog with that half on "Choose…" and the sentence that lines of the type get no default until a new one is chosen.

**FR3 — Change a default or the designation** (AC-4.3, AC-4.4, AC-4.7)
Dialog with the two selects of **active WellD CH** entries (options read live from Accounting through Refund, whether or not the admin holds an Accounting capability), plus "None". Save disabled until something differs. 422 (the entry was deactivated, or is not found, while the dialog was open) → field error and the options reload. 503 → the AC-6.10 message and no options. History drawer: who, when, and the number and name or code **as they were at the time**, so it reads the same whatever happens in Accounting (AC-4.7).

**FR4 — Accounting cannot be read while Settings is open** (AC-6.9)
Default classification opens: each default and the designation are shown as recorded, one warning banner says Accounting cannot be read, Change is `aria-disabled` with its reason, History still works. Retry reads again; on success the banner goes, focus returns to the card heading and "Accounting can be read again." is announced (UX-23).

**FR5 — Review and classify** (AC-4.1, AC-4.2, AC-4.3, AC-4.9, AC-5.2, AC-6.5)
As in F5 and F6 of 20261118, with these differences: options are Accounting's active WellD CH entries; a stored copy whose entry has since been deactivated or is gone stays selected, marked, and the line keeps it; a default that is no longer usable reads as missing **with the reason**; when Accounting cannot be read there are no selects, the line's values read as recorded and one page banner says why; a WellD Italia line has no panel and no copy (AC-4.9). A refused change (422 deactivated / not found, 503) reverts the select and says why under it.

**FR6 — Approve** (AC-5.1, AC-5.6, AC-6.1 to AC-6.4, AC-6.10)
`classification_missing` is unchanged (page-level `ErrorSummary`, UX-5 of 20261118). **New:** 503 `accounting_unavailable` stays in the approve dialog (UX-21), nothing changes (AC-6.2). A request with no non-rejected WellD CH line approves with Accounting down (AC-6.4), so no new state appears for it. A foreign-currency line approved with no rate in effect is accepted and shows **Rate pending** afterwards (UX-20).

**FR7 — Export** (AC-5.4, AC-5.6, AC-6.6, AC-6.7, AC-7.3)
As F9 of 20261118, plus: Ready and Blocked show "N lines get their exchange rate at this export" when above zero; a batch whose lines all hold copies exports with Accounting down and shows nothing about Accounting (AC-5.4); a pending line with Accounting unreachable is blocked with its own heading, not as a missing rate (AC-6.6); a missing rate links to the month in Accounting for a person who holds Accounting read for WellD CH, and otherwise says to ask an accounting manager (AC-7.3).

**FR8 — Release** (AC-7.4, AC-7.5) has no screen. Its result reaches the user only as `accounting_release_pending` (unchanged) and as `classification_missing` refusals naming lines (AC-7.5).

### Acceptance criteria with no UI surface of their own

Proven by the plan's tests and only visible through the flows above; they need no extra design: AC-1.12 (the absence of an edit control is a test, not a screen), AC-1.13, AC-2.1, AC-2.2, AC-2.6 (effect only), AC-2.10, AC-3.1 (existing admin GUI, see Gaps G12 for the catalog labels), AC-3.2, AC-3.3, AC-3.7, AC-3.8, AC-4.8, AC-5.3, AC-5.4, AC-5.5, AC-5.7 (effects on the panel), AC-6.2, AC-6.8, AC-7.1, AC-7.2, AC-7.4, AC-7.5.

### UI added that no acceptance criterion asks for (reported)

| Item | Designed? | Note |
|---|---|---|
| Read-only sentence in each card (UX-4) | Yes | Costs one string per card; remove if it feels redundant. |
| "Source" fact on the rates card (UX-9) | Yes | AC-2.1 records the source; nothing says to show it. |
| Auto-fetch once per visit for managers | Yes (carried from 20261118) | No AC; plan D26. Without it nobody triggers missing months before a consumer asks. |
| "Month is not in the list" note (UX-11) | Yes | Needed so AC-7.3's link is never a dead end. |
| Quiet summary re-read after a download (UX-22) | Yes | Keeps "N lines get their rate at this export" truthful. |
| "Fixed as booked" sentence in an approved panel (UX-20) | Yes | Explains why a correction in Accounting did not change a line (AC-5.3). |
| `ErrorSummary` in add/correct dialogs | **No** (UX-6) | The plan asks for it; the AC does not. |
| History, who-added, per-cell rate history | **No** | Plan D18, spec non-goal. |
| Warning before deactivating a used entry | **No** | Open question 3 answered "no warning in v1". |
| Back to default on a classification | **No** | Still unasked, as in 20261118. |

## Screens & states

For every screen the building-pages rule holds: **exactly one state at a time**, in the order denied, loading, failed, empty, loaded. "Saving" and "Refused" are states of a dialog or a control, not of a page. Each card announces loading once through a polite `VisuallyHidden` line.

### AS1 — AccountingShell (root layout of accounting-ui)

`ToolLayout` (`title` "Accounting", `width` default) + `TabNav` (UX-1) + the routed page. It reads `GET /v1/me` once and hands the covered entities and each one's `canManage` to the pages through a context. The title stays on screen in every state.

| State | What the user sees |
|---|---|
| Loading | Polite "Loading Accounting…" + `SkeletonRows`, in the page area (the nav is already there). |
| Denied (403, or an empty entity list) | `PermissionDenied` (`StatePanel role="alert" focusOnMount`, no retry): "No access to Accounting. Ask an administrator to give you access." |
| Authorization unavailable (503) | Warning `Banner` titled "Authorization service unavailable", body "We cannot verify your access right now. Nothing was changed.", Retry. |
| Other failure | Warning `Banner` with the Problem detail and Retry. |
| Loaded | The page. `TabNav` shows all three views to every reader and manager (none is gated differently). |
| Unknown path | `NotFoundPage`: "This page does not exist / The link may be wrong." and a link "Back to Accounting" (letterheads-ui S11 pattern). |

```
Accounting                                         <- h1, from ToolLayout
[ Ledger accounts ] [ VAT codes ] [ Exchange rates ]   <- TabNav, aria-current on the open one

Ledger accounts                         Entity: [ WellD CH  v ]   <- h2, select only with 2+ entities
+----------------------------------------------------------------------------+
| Ledger accounts — WellD CH                                    [ Add account ] |  <- h3, manager only
| The chart of accounts of WellD CH. Other modules book to these accounts.    |
| Number    Name                                   Status      Actions        |
| 1000      Cassa                                  [Active]    [Deactivate]   |
| 2620.1    Debitori diversi                       [Inactive]  [Reactivate]   |
+----------------------------------------------------------------------------+
```

### AS2 — Entity switch and entity resolution

| State | Behaviour |
|---|---|
| One covered entity | No switch. The entity is the covered one; `?entity=` is not required. |
| Two or more | A `Field` "Entity" with a native `<select>` of the covered entities (WellD CH first). The value is `?entity=`, written with `replace`. Changing it remounts the cards (key = entity) and announces "Showing {entity}" in a polite status. Focus stays on the select. |
| `?entity=` missing or not an entity id | Falls back to the first covered entity (`replace`). |
| `?entity=` is an entity the person does not cover | Not-found panel with a link "Back to ledger accounts" (UX-12). |
| A list answers 404 `not_found` (grant narrowed) | `/v1/me` is re-read; the first covered entity is shown; one dismissible info `Banner` "You no longer have access to {entity}. Showing {other}." |
| Slow keyboard use on a closed select | On Windows and Firefox each arrow key fires `change` at once; each change is a cheap replace-and-reload and a late answer of an earlier entity is dropped (the cards are keyed), so no extra guard is needed. |

### AS3 — Ledger accounts view (`/accounting/ledger-accounts`)

Card "Ledger accounts — {entity}". Columns: **Number** (mono, row header), **Name**, **Status** (`StatusBadge` Active / Inactive), **Actions** (manager only). No "Added" column (UX-8).

| State | What the user sees |
|---|---|
| Loading | `SkeletonRows` + polite "Loading ledger accounts…". |
| Failed | Warning `Banner` with Retry (UX-15). |
| Denied | `PermissionDenied` replaces the view (UX-15; the old cards left themselves out, but here the card **is** the page, so an empty page would say nothing). |
| Empty | `StatePanel` "Nothing entered yet for {entity}" (WellD CH too, until someone enters or seeds it) with a body that depends on the person: manager "Add the entity's ledger accounts with Add account."; reader "Accounting managers enter them." This is the whole of AC-8.3: a state, never an error. |
| Loaded, manager | The table; **Add account** in the card action; per row **Deactivate** (confirm) or **Reactivate** (at once). |
| Loaded, reader | The table with no actions and the read-only sentence under the card description. |
| Saving | Dialog or confirm is `busy` and cannot be dismissed; the table changes only on success. While one row action runs every row action is disabled. |
| Action refused | Dialog: inline `role="alert"` above the buttons (duplicate, field errors, 403, generic). Row action: danger `Banner` above the table; a 409 also reloads the list. |
| Success | Compact auto-dismissing success `Banner` above the table ("Account 5905 added / deactivated / reactivated"); focus goes to the row header after a toggle and back to Add after an add. |

### AS4 — VAT codes view (`/accounting/vat-codes`)

Same structure as AS3. Columns: **Code** (mono, row header), **Label**, **VAT rate** (numeric, `8.1%` / `8,1%` through `formatNumber`), **Status**, **Actions**. The rate is plain text: there is no edit control anywhere (AC-1.7). The duplicate message offers the reactivation pointer when the existing code is deactivated (AC-1.6). Empty: "Nothing entered yet for {entity}".

### AS5 — Exchange rates view (`/accounting/exchange-rates`)

Card "Exchange rates — {entity}": a description naming the base currency ("CHF for 1 unit of the foreign currency, monthly average"), a `FactList` with **Source** and **Last fetch**, **Fetch now** (manager) in the card action, then the table. Columns **Month** (row header, `formatMonth`) and one per currency the API lists (`currencies`: EUR, USD, GBP for WellD CH).

```
Exchange rates — WellD CH                                       [ Fetch now ]
CHF for 1 unit of the foreign currency, monthly average. Other modules convert at these rates.
Source: Official monthly average of the Swiss Federal Office for Customs and Border Security (BAZG)
Last fetch: 19.11.2026 09:14 — succeeded

 Month           EUR                     USD                    GBP
 October 2026    0.9301 [Fetched] (✎)    0.8102 [Fetched] (✎)   1.0750 [Fetched] (✎)
 September 2026  0.9340 [Corrected] (✎)  0.8130 [Fetched] (✎)   [! Missing] (✎)
```
(The pencil is the icon-only **Correct** button, managers only; there is no per-cell history button, UX-8.)

| State | What the user sees |
|---|---|
| Loading / Failed / Denied | As AS3. |
| No official source (`source: null`, AC-2.11) | `StatePanel` "No official source for WellD Italia yet" with "Exchange rates are not fetched or kept for this entity yet. They will be added when its source is chosen." No table, no Fetch now, no last-fetch fact, no auto-fetch. Identical for reader and manager. |
| Empty (a source, no completed month yet) | `StatePanel` "No months to show yet". |
| Loaded | The table. A Missing cell is a `StatusBadge status="attention"` plus the word; for managers also **Correct**. |
| Auto-fetch running (manager, once per visit) | Polite "Checking for new rates…" in the card; the table stays usable; focus never moves. |
| Fetch succeeded | Compact success banner "Recorded the rates for 2 months." or "No new rates to record." |
| Month not published yet | Dismissible info banner "The rates for October 2026 are not published yet." |
| Throttled / more months to fetch | Dismissible info banners (as built in 20261118: S5a): "The rates were checked a moment ago. Try again in a few minutes." / "2 more months are still to fetch. Fetch again to continue." |
| **Last fetch failed** (AC-2.8) | **Persistent** warning banner (not dismissible, `live="polite"`): "The last fetch failed", the time, a plain reason, "The rates already recorded are unchanged." Visible to readers. Gone only when a later fetch succeeds. The Last fetch fact also says "— failed". |
| Fetching switched off in this environment | Info banner "Automatic fetching is turned off in this environment. Enter the rates by hand." (managers); readers see the same sentence without the instruction. |
| Fetch request failed | Dismissible danger banner "Could not fetch the rates. Try again." (403: the permission sentence and a re-read of `/v1/me`). |
| Read-only (reader) | The table with no Fetch now and no Correct, and the read-only sentence. |
| Deep link, month listed | The row is scrolled into view and its header takes focus once. |
| Deep link, month not listed | Polite status note (UX-11); the table shows from the top. |

### AS6 — Dialogs (all mounted beside the card, never inside a `<form>`, ADR 20261118 dialog-beside-form)

All are `FormDialog` (focus on the first field, Enter submits, Escape and × cancel except while busy, typed values kept on failure, error inline above the footer) except the deactivate confirm. Buttons that open them carry `aria-haspopup="dialog"`.

- **AS6a Add ledger account — {entity}.** Fields: *Account number* (required; hint "Digits separated by single dots, up to 20 characters. For example 5905 or 2620.1."), *Account name* (required, up to 120). Blanks around a value are removed before the check (AC-1.2); the field is checked on blur and on submit.
- **AS6b Add VAT code — {entity}.** *Code* (required; capitals, digits, `_`, `-`; up to 16; upper-cased on blur), *Label* (required, up to 80), *VAT rate (%)* (required, 0 to 100, up to 2 decimals).
- **AS6c Correct rate — {currency} · {month}.** *Rate ({own currency} per 1 {currency})*, `MoneyInput` with `parseDecimal(text, 6)`; the hint states the limit and shows the rate in effect and its origin; the description is UX-10's sentence.
- **AS6d Deactivate account / VAT code** (`ConfirmDialog`, `tone="primary"`, default focus Cancel): title "Deactivate account 5905?", the UX-7 body, confirm "Deactivate".

| Dialog state | What the user sees |
|---|---|
| Idle | Fields empty (or the correction's current value as hint, never prefilled: typing over a value invites a stray digit), Save enabled once every required field has text. |
| Field refused | Error under the field with the reason, `aria-invalid`, focus on the first refused field; the client check and the server's `fields[]` give the same sentences. |
| Duplicate (409) | An alert naming the number or code (and the reactivation pointer when the existing entry is deactivated). |
| Busy | The submit button `busy`, "Adding…" / "Saving…"; not dismissible. |
| General error | `role="alert"` above the buttons: 403 "You don't have permission to do this.", else "Could not save. Try again." |
| Success | The dialog closes; focus returns to the opener (Add, Correct); the banner on the card confirms. |

### AS7 — Not found

`StatePanel` (focus on the heading): "This page does not exist", "The link may be wrong.", link "Back to ledger accounts". Used for an unknown path and for an entity the person does not cover (UX-12).

### RS1 — Refund Settings frame

`PageHeader` "Settings" (description updated), `Tabs` "Settings sections" with **General** and **Default classification** only when the person holds `settings:read`; with only General there is no tab list and the page is today's. `?section=general|defaults`; any other value shows General. Only the active view is mounted.

### RS2 — Default classification view (`ExpenseTypeDefaultsCard`)

Head: the Accounting link note. Then the card of 20261118 S4 (foreign-currency VAT code as one fact with Change and History, then the twelve-row table), with these changes. Entries are shown as **number — name** and **code — label (rate)**, from Refund's recorded copies; Accounting's current state is added on top (UX-18).

| State | What the user sees |
|---|---|
| Link note, with Accounting in `apps` | "Ledger accounts, VAT codes and exchange rates are kept in the Accounting app." and a link **Open Accounting**. |
| Link note, without | "Ledger accounts, VAT codes and exchange rates are kept in the Accounting app by accounting managers. Ask one of them if an entry is missing." No link. |
| Loading / failed / denied | As 20261118 S4 (the card leaves itself out on 403: Settings has other views). |
| Loaded, all usable | Twelve rows; **None** is real text where no default exists. |
| An entry deactivated | Its half shows the value plus a `StatusBadge voided` "Deactivated in Accounting". |
| An entry not found | The value plus `StatusBadge attention` "Not found in Accounting". |
| At least one unusable default or designation | A static warning note (`live="off"`, with an `aria-label`) above the table: "N defaults need a new choice: their entry is deactivated or no longer in Accounting. Lines of those types get no default until you choose another." N counts types with an unusable half plus the designation if it is unusable. The foreign-currency fact says the same for itself ("{code} is deactivated … " or "… is no longer in Accounting, so foreign-currency lines get no VAT code until you designate another."). |
| **Accounting unavailable** (AC-6.9) | One warning `Banner` (`live="polite"`, not dismissible, with Retry): "Accounting cannot be read now. The defaults are shown as recorded. You cannot change them until Accounting can be read." Entries show as recorded with **no** state badge (`unverified`). **Change** (types and designation) is `aria-disabled` and described by "Accounting cannot be read now, so defaults cannot be changed."; **History** works. |
| Recovered | Banner gone, focus on the card heading, "Accounting can be read again." announced (UX-23); still failing: "Accounting still cannot be read." |

### RS3 — Default dialogs (deltas to 20261118 S6c, S6d)

- Options come from `GET /accounting/options`, keyed by number or code.
- A saved half that is deactivated or not found makes its select start on "Choose…" with the sentence "The current account is deactivated (or: is no longer in Accounting). Choose another, or none." Save stays disabled until a real choice is made, so a default is never cleared by accident.
- **Options unavailable (503):** inside the dialog, an alert with the settings sentence (cause and remedy), no options, Save disabled, and a ghost **Try again** that reads the options again.
- 422 `ledger_account_inactive` / `vat_code_inactive` → "That account has been deactivated. Choose another."; 422 `…_not_found` → "That account is no longer in Accounting. Choose another."; the options reload.

### RS4 — Review page: page note and classification panel (deltas to 20261118 S7)

Page level: when the view says `accounting: "unavailable"`, one warning `Banner` above the lines (`live="polite"`, with Retry): "Accounting cannot be read now. Each line is shown as recorded. Classification cannot be changed until Accounting can be read." Slow Accounting means the per-line skeletons can stay up to the 10-second deadline, then resolve to this state; the rest of the page never waits.

Panel states, **new or changed only** (everything else of S7 stands, including S7a self-restricted and S7b out of scope):

| State | What the user sees |
|---|---|
| Editable, a stored copy whose entry was deactivated | Select shows "{number — name} (deactivated)" as a disabled selected option and the hint "This account is deactivated in Accounting. The line keeps it; choose an active one to change it." (VAT code likewise). |
| Editable, a stored copy whose entry is not found | "(not in Accounting)" and "This account is no longer in Accounting. The line keeps it; choose another to change it." |
| **A default that is no longer usable** (the type's default deactivated or not found; no hand copy) | The select reads as **Missing** (placeholder "Choose an account", `Required to approve.` replaced by the reason): "The default account for this type is deactivated in Accounting. Choose one." / "… is no longer in Accounting. Choose one." Approving without it is refused as `classification_missing` (AC-6.3), as today. |
| **Accounting unavailable** (AC-6.5) | The read-only group (no selects) with the values as recorded, each marked **Default (as recorded)** or **Set by hand**, a "—" where nothing is recorded, and the sentence "Accounting cannot be read now, so this classification cannot be changed." (`role="status"`, `tabIndex=-1`). |
| Selects while options load | Disabled with the existing "Loading classification…" line; if the options call answers 503 the panel turns into the unavailable state above and the page banner appears. |
| Change refused: 503 | The select reverts, an alert under it says "Accounting's reference data cannot be read right now. The classification was not changed. Try again in a few minutes." and the page reloads the accounting view. |
| Change refused: 422 not found | The select reverts; "That account is no longer in Accounting. Choose another."; options reload. |
| Foreign line, **before approval**, no rate in effect | Exchange-rate fact: `StatusBadge attention` "No rate yet" + "No EUR rate for March 2026 yet. You can still approve: the rate is copied at the first export."; CHF and VAT amounts "—". (Replaces "The CHF and VAT amounts need it".) |
| Foreign line, **approved**, no copied rate | `StatusBadge attention` **"Rate pending"** + "No EUR rate for March 2026 yet. It is copied at the first accounting export of the batch." CHF and VAT amounts "—" (never 0). |
| Foreign line, rate known | "0.9246 · March 2026", CHF and VAT amounts as built. Before approval a hint says the amounts follow the approved total and the rate as they stand now and are fixed at approval; **after** approval: "Account, VAT code and rate are kept as booked. Later changes in Accounting do not change this line." (AC-5.3, UX-20.) |
| Rate help link | With Accounting read for WellD CH (the server's `viewer.canOpenAccountingRates`, Gaps G8) the help ends in "Open exchange rates" (a plain link to `/accounting/exchange-rates?entity=welld_ch&month=…`); otherwise "Ask an accounting manager to enter or fetch it." (closes A-8 of 20261118 and replaces "administrator"). |
| Paid batch | Unchanged: read-only, lock icon, "Locked: its batch has been paid." A line whose rate is still pending in a paid batch shows "Rate pending" read-only; it is resolved at export, not here. |

### RS5 — Approve dialog and refusals (deltas to 20261118 S8)

| State | What the user sees |
|---|---|
| `accounting_unavailable` (503) | The dialog stays open with `role="alert"`: "Accounting's reference data cannot be read right now. Nothing was approved. Try again in a few minutes." Approve stays available. Nothing else changes on the page (AC-6.2). Focus returns to the confirm button when the busy state ends (A-4 of 20261118, still open). |
| `classification_missing` | Unchanged: page-level `ErrorSummary`, focus on the first missing select. A line whose default became unusable is one of the items; the panel's own hint says why. |
| `accounting_release_pending` | Unchanged. |
| Request with no non-rejected WellD CH line | Unchanged: no Accounting, no new state (AC-6.4). |

### RS6 — Accounting export card (deltas to 20261118 S10)

| State | What the user sees |
|---|---|
| Ready | The row count, the Italia-lines sentence only above zero, and **new:** "N lines get their exchange rate at this export." when `ratePendingLineCount` is above zero (singular written inside the function). |
| Ready, all lines copied, Accounting down | Exactly as Ready. The card makes no mention of Accounting (AC-5.4). |
| Blocked: **Accounting cannot be read** (AC-6.6) | Inside the same warning blocked banner: heading "Accounting cannot be read" and "The exchange rates of lines with a pending rate cannot be fetched. You can still pay or discard this batch. Check again in a few minutes." No missing-rate list. **Check again** retries; Download is `aria-disabled` with the blocked reason. Never shown as a missing rate. |
| Blocked: missing rates (AC-6.7) | As built: each currency and month, plus the reason when the summary carries one ("not published yet" / "the official source did not answer" / "no official source", Gaps G7). With `viewer.canOpenAccountingRates` each item has **Open exchange rates** (plain link to Accounting at that month); otherwise one sentence "Ask an accounting manager to enter or fetch it." |
| Blocked: sentence about a fetch | "Accounting just tried to fetch the missing rates from the official source." (was "Refund"; only when the summary says it tried, Gaps G10). |
| Blocked, unclassified lines / unnumbered lines | Unchanged. |
| Downloaded | Success banner "Export downloaded: 12 rows." then the summary is read again quietly; the "N lines get their rate" sentence is gone once the rates are copied. |
| Became blocked while downloading (409 `accounting_export_blocked`) | As built, now also for `accountingUnavailable`. |
| Out of scope / discarded / loading / load failed / no file | Unchanged. |

### RS7 — Everything else in Refund

The employee's own request pages show no account, VAT code, VAT amount or exchange-rate state (AC-3.10 of 20261118, AC-7.2). WellD Italia lines have no panel and no accounting copy (AC-4.9). Receipt numbers, the batch page and the review queue are unchanged. The mileage-rate cards and the distribution email are untouched.

## Component inventory

Library in use: **`@operai/ui`** (the suite's shared library, `operai-ui/`, ADR 20261031-shared-ui-library-consumed-as-source), consumed by both remotes with Tailwind token utilities for layout (per `AGENTS.md` and `operai-ui/docs/design-system.md`). No Mantine, no MUI. Components were read in `operai-ui/src/components` and `operai-ui/src/index.ts`; none needs a library change. `R` = reuse from the library, `M` = moved with `git mv` from refund-ui (changes listed), `C` = small copy of a helper that is not a component (plan D29), `N` = NEW with its reason.

### accounting-ui

| # | Element | Component | R/M/C/N |
|---|---|---|---|
| 1 | Tool frame, h1 | `ToolLayout` | R |
| 2 | Section tabs | `TabNav` + `tabLinkClassName`, TanStack `Link` with `search` carry-over, `wrap` | R |
| 3 | Page header (h2) | `PageHeader` with `actions` for the entity switch | R |
| 4 | Entity switch | `Field` + native `<select>` | R (composition) |
| 5 | Cards | `Card` (title h3, `action`) | R |
| 6 | Loading | `SkeletonRows` + `VisuallyHidden live` | R |
| 7 | Load failure, auth outage, persistent notices, confirmations | `Banner` (`warning`, `info`, `success` compact autoDismiss, `live`) | R |
| 8 | Denied, empty, no source, not found | `StatePanel` (`role="alert" focusOnMount` for denied and not found) | R |
| 9 | Lists | `DataTable` (caption, `rowHeader`, `focusRowKey`, `numeric`) | R |
| 10 | Active / Inactive, Missing | `StatusBadge` (`active`, `voided`, `attention`) | R |
| 11 | Rate origin | `Badge` (neutral Fetched, accent Corrected) | R |
| 12 | Last fetch, source | `FactList` | R |
| 13 | Dialogs | `FormDialog`, `ConfirmDialog` | R |
| 14 | Fields | `Field`, `MoneyInput` + `parseDecimal` | R |
| 15 | Row actions | `Button` (`sm`; icon-only Correct with `aria-label`) | R |
| 16 | Formatting | `formatMonth`, `formatNumber`, `formatDateTime` | R |
| 17 | Copy | `selectStrings`, `catalogGaps` | R |
| 18 | Sidebar icon | `Icon name="list-ordered"` (in the shell) | R |
| 19 | `LedgerAccountsCard` | refund-ui `components/settings/LedgerAccountsCard.tsx` → `accounting-ui/src/components/` | M: props `entity`, `canManage` from `/v1/me`; list from `/v1/entities/{entity}/ledger-accounts`; rows keyed by number; **drop the Added column**; title/caption/empty name the entity; read-only sentence; test ids `settings-account*` → `accounting-ledger*`. |
| 20 | `VatCodesCard` | same | M: same changes; the rate is text only; case-insensitive duplicate. |
| 21 | `AddLedgerAccountDialog` | → accounting-ui | M: `entity` in the title; client check rewritten to AC-1.2 (the 20261118 pattern `^[0-9]{3,6}(\.[0-9]{1,3})?$` is wrong now: digits separated by single dots, up to 20); one error per reason; server `fields[]` mapping; pre-check against this entity's list. |
| 22 | `AddVatCodeDialog` | → accounting-ui | M: `entity` in the title; code 1 to 16 of `A-Z0-9_-`; label up to 80; reasons per field; `fields[]`. |
| 23 | `useCatalogToggle` | → accounting-ui `hooks/` | M: `id` → `keyOf(item)`; calls take `(entity, key)`. |
| 24 | `ExchangeRatesCard` | → accounting-ui | M: props `entity`, `ownCurrency`, `currencies`, `source`, `canManage`, `month`; **no history drawer or per-cell history button**; no `trigger`; no `fetchedAt` or `history` fields; the no-source panel; Source and Last fetch facts with outcome words; the deep-link note. |
| 25 | `RateCorrectionDialog` | → accounting-ui | M: own-currency label; UX-10 copy and limit. |
| 26 | `lib/exchangeRatesApi.ts`, catalog half of `lib/accountingApi.ts` | → accounting-ui `lib/` | M: paths under `/v1/entities/{entity}/…`, `{ entity, items }` unwrapped, no ids, `GET /v1/me`. |
| 27 | `AccountingShell` | root layout: ToolLayout + TabNav + `/v1/me` frame + context | **N** — each remote has its own shell (`RefundShell`, `LetterheadsShell`); this one also owns the entity context. |
| 28 | `EntitySwitch` + `useEntity` (search param → covered entity / not found / fallback) | | **N** — no library piece decides between "garbage", "known but not covered" and "covered"; used by three pages. |
| 29 | Three thin pages (`LedgerAccountsPage`, `VatCodesPage`, `ExchangeRatesPage`) | `PageHeader` + the card, keyed by entity | **N** — the plan's three routes; composition only. |
| 30 | `LoadState` (`Loading`, `LoadFailure`), `PermissionDenied`, `NotFoundPage`, `Saved` | letterheads-ui `components/{LoadState,PermissionDenied}.tsx`, `pages/NotFoundPage.tsx` (the scaffold the plan names) | C |
| 31 | `useLoadedResource` | refund-ui `lib/useLoadedResource.ts`, with its `ApiError` import pointed at accounting-ui's `lib/api.ts` | C — a hook, not a component (D29); see Gaps G4. |
| 32 | `monthLabel`, `formatVatRate` | refund-ui `lib/monthLabel.ts`, the `formatVatRate` part of `lib/catalogLabels.ts` | C (D29). |
| 33 | `statusMeaning.ts` | `active`→`active`, `inactive`→`voided`, missing→`attention` | C (3 lines). |
| 34 | `lib/limits.ts` | client mirror of `accounting-api` `catalog/limits.ts` and the rate bounds | **N** — one place for the numbers the dialogs check (D31). |
| 35 | `test-support/axe.ts` (+ `axe.test.tsx`) | refund-ui's helper | C — see Accessibility. |

**Not moved, and why:** `ExpenseTypeDefaultsCard`, `DefaultClassificationDialog`, `ForeignCurrencyVatDialog`, `useActiveCatalogOptions` are Refund's own rules (defaults and designation stay in Refund, spec Relationship). `ChangeHistoryDrawer` stays: the defaults and the designation use it (AC-4.7); its exchange-rate use disappears with UX-8. `CatalogSelect` stays: the line panel and the defaults dialogs use it, now keyed by number and code. `RateInEffectBadge` stays (mileage rates). `ErrorBanner`, `SuccessBanner`, `ConfirmDeleteModal` stay: other refund-ui screens use them. accounting-ui does **not** copy these three adapters; it uses `Banner` and `ConfirmDialog` directly through `LoadState` and `Saved`, as letterheads-ui does.

**Reuse ratio, accounting-ui: 18 library : 8 moved : 5 small copies : 4 NEW** (the shell, the entity switch with its hook, the three thin pages counted as one, `limits.ts`). Every NEW piece is composition or one constant module; no NEW visual component, token or icon.

### refund-ui

| Element | Component | R/N |
|---|---|---|
| Settings views | `SettingsPage` (two `Tabs`), `AccountingSettingsView` renamed `DefaultsSettingsView` (the plan's name) without the two catalog cards; `ExchangeRatesView` deleted | R (change) |
| Link note | `AccountingLinkNote`: a `<p className="text-sm text-soft">` and an `<a className="link">`, reading `apps` from `usePermissions()` | **N** — one sentence, two variants; nothing in the library is a "see elsewhere" note. |
| Defaults card | `ExpenseTypeDefaultsCard`: state `StatusBadge`s, the needs-a-new-choice note (`Banner live="off"`), the unavailable `Banner` with Retry, `aria-disabled` Change with a description | R (change) |
| Default dialogs | `DefaultClassificationDialog`, `ForeignCurrencyVatDialog`, `useActiveCatalogOptions`: number/code values, 503 state with Try again, not-found sentences | R (change) |
| Select | `CatalogSelect`: `value` is a number or code; `current` carries `state` | R (change) |
| Line panel | `LineClassificationPanel`: the new states of RS4 | R (change) |
| Review page | `ReviewDetailPage`: the page note (`Banner`) and the 503 branch of the approve error switch; carries FU-S7 (A-1 of 20261118) unchanged | R (change) |
| Approve dialog | `ApproveDialog`: no change (message comes from the page) | R |
| Export card | `AccountingExportCard`: the new blocker, the pending sentence, the AC-7.3 link, the quiet re-read | R (change) |
| History drawer | `ChangeHistoryDrawer`: unchanged, rate use removed | R |
| Removed | the six moved components, `lib/exchangeRatesApi.ts`, the catalog half of `lib/accountingApi.ts`, `settings.accounts`, `settings.vatCodes`, `settings.fx` strings | — |

**Reuse ratio, refund-ui: 9 reuse (7 changed in place, 2 untouched) : 1 NEW** (`AccountingLinkNote`).

**Whole feature: 40 reuse, moved or copied : 5 NEW**, none of them visual.

### Copy keys

Convention (the `strings.ts` rule of `operai-ui/docs/design-system.md` § Copy and refund-ui's file header): one catalog per language, `en` first and `it: typeof en`, `strings = selectStrings({ en, it })`; a sentence with a value in it is a **function**; sentence case; Italian in the impersonal form the file already uses ("Impossibile…", "Inserire…", "Riprovare."); `n === 1` plurals written inside the function; `catalogGaps(en, it)` must be `[]`; every `.tsx` is scanned for hard-coded copy. accounting-ui starts with one `src/strings.ts` (the user's wording); split it into a `strings/` folder as letterheads-ui does if it passes about 500 lines. Months come from `formatMonth`, rates and VAT percentages from `formatNumber`, dates from `formatDateTime`, never by hand.

Entity names are the same in both languages (proper names, as `refund-ui` `badges.entity`): `WellD CH`, `WellD Italia`.

#### accounting-ui `strings.ts`

| Key | EN | IT |
|---|---|---|
| `appTitle` | Accounting | Contabilità |
| `nav.landmarkLabel` | Accounting sections | Sezioni di Contabilità |
| `nav.ledgerAccounts` / `vatCodes` / `exchangeRates` | Ledger accounts / VAT codes / Exchange rates | Conti contabili / Codici IVA / Tassi di cambio |
| `nav.loading` | Loading Accounting… | Caricamento di Contabilità… |
| `entity.welld_ch` / `welld_it` | WellD CH / WellD Italia | WellD CH / WellD Italia |
| `entity.label` | Entity | Entità |
| `entity.showing(entity)` | `Showing ${entity}` | `Visualizzazione di ${entity}` |
| `entity.lost(was, now)` | `You no longer have access to ${was}. Showing ${now}.` | `Non si ha più accesso a ${was}. Visualizzazione di ${now}.` |
| `common.dismiss` / `retry` / `cancel` / `close` | Dismiss / Retry / Cancel / Close | Chiudi / Riprova / Annulla / Chiudi |
| `common.permissionDenied.heading` / `body` | No access to Accounting / Ask an administrator to give you access. | Nessun accesso a Contabilità / Rivolgersi a un amministratore per ottenere l’accesso. |
| `common.authUnavailable.heading` / `body` | Authorization service unavailable / We cannot verify your access right now. Nothing was changed. | Servizio di autorizzazione non disponibile / Al momento non è possibile verificare gli accessi. Non è stato modificato nulla. |
| `common.forbidden` | You don't have permission to do this. | Non si dispone dei permessi per questa operazione. |
| `common.genericError` | Could not save. Try again. | Impossibile salvare. Riprovare. |
| `common.accessChanged` | Your access to Accounting changed. The page was updated. | L’accesso a Contabilità è cambiato. La pagina è stata aggiornata. |
| `common.readOnly(what)` | `You can view this list. Accounting managers ${what}.` with `what` = add and deactivate accounts / add and deactivate VAT codes / fetch and correct rates | `È possibile vedere questo elenco. Spetta ai responsabili della contabilità ${what}.` with aggiungere e disattivare i conti / aggiungere e disattivare i codici IVA / recuperare e correggere i tassi |
| `common.notFound.heading` / `body` / `back` | This page does not exist / The link may be wrong. / Back to ledger accounts | Questa pagina non esiste / Il link potrebbe essere errato. / Torna ai conti contabili |
| `status.active` / `inactive` | Active / Inactive | Attivo / Disattivato |
| `accounts.title(entity)` | `Ledger accounts — ${entity}` | `Conti contabili — ${entity}` |
| `accounts.description(entity)` | `The chart of accounts of ${entity}. Other modules book to these accounts.` | `Il piano dei conti di ${entity}. Gli altri moduli registrano su questi conti.` |
| `accounts.caption(entity)` | `${entity} ledger accounts` | `Conti contabili di ${entity}` |
| `accounts.loading` / `loadError` | Loading ledger accounts… / Could not load the ledger accounts. | Caricamento dei conti contabili… / Impossibile caricare i conti contabili. |
| `accounts.empty.title(entity)` | `Nothing entered yet for ${entity}` | `Ancora nulla inserito per ${entity}` |
| `accounts.empty.bodyManage` / `bodyRead` | Add the entity's ledger accounts with Add account. / Accounting managers enter them. | Aggiungere i conti contabili dell’entità con Aggiungi conto. / Li inseriscono i responsabili della contabilità. |
| `accounts.columns.number` / `name` / `status` / `actions` | Number / Name / Status / Actions | Numero / Nome / Stato / Azioni |
| `accounts.add` | Add account | Aggiungi conto |
| `accounts.addDialog.title(entity)` | `Add ledger account — ${entity}` | `Aggiungi conto contabile — ${entity}` |
| `accounts.addDialog.description` | The number and name cannot be edited later. An account can be deactivated and reactivated. | Numero e nome non possono essere modificati in seguito. Un conto può essere disattivato e riattivato. |
| `accounts.addDialog.number` / `numberHint` | Account number / Digits separated by single dots, up to 20 characters. For example 5905 or 2620.1. | Numero del conto / Cifre separate da un solo punto, fino a 20 caratteri. Per esempio 5905 o 2620.1. |
| `accounts.addDialog.name` / `busy` | Account name / Adding… | Nome del conto / Aggiunta… |
| `accounts.errors.numberEmpty` | Enter an account number. | Inserire un numero di conto. |
| `accounts.errors.numberFormat` | Use digits separated by single dots, such as 5905 or 2620.1. | Usare cifre separate da un solo punto, come 5905 o 2620.1. |
| `accounts.errors.numberTooLong` | The number can have up to 20 characters. | Il numero può avere al massimo 20 caratteri. |
| `accounts.errors.nameEmpty` / `nameTooLong` | Enter a name. / The name can have up to 120 characters. | Inserire un nome. / Il nome può avere al massimo 120 caratteri. |
| `accounts.errors.duplicate(number, entity)` | `Account ${number} already exists in ${entity}.` | `Il conto ${number} esiste già in ${entity}.` |
| `accounts.errors.duplicateInactive(number)` | `Account ${number} already exists but is deactivated. Reactivate it from the list.` | `Il conto ${number} esiste già ma è disattivato. Riattivarlo dall’elenco.` |
| `accounts.errors.alreadyActive(number)` / `alreadyInactive(number)` | `Account ${number} is already active.` / `…is already deactivated.` | `Il conto ${number} è già attivo.` / `…è già disattivato.` |
| `accounts.added(number)` / `deactivated` / `reactivated` | `Account ${number} added` / `…deactivated` / `…reactivated` | `Conto ${number} aggiunto` / `…disattivato` / `…riattivato` |
| `accounts.deactivate` / `reactivate` | Deactivate / Reactivate | Disattiva / Riattiva |
| `accounts.deactivateLabel(number)` / `reactivateLabel(number)` | `Deactivate account ${number}` / `Reactivate account ${number}` | `Disattiva il conto ${number}` / `Riattiva il conto ${number}` |
| `accounts.deactivateDialog.title(number)` | `Deactivate account ${number}?` | `Disattivare il conto ${number}?` |
| `accounts.deactivateDialog.body` | No module can choose it any more. What was already booked with it keeps it. A module that uses it as a default needs another one. You can reactivate it at any time. | Nessun modulo potrà più sceglierlo. Quanto è già stato registrato con questo conto lo mantiene. Un modulo che lo usa come predefinito dovrà sceglierne un altro. Si può riattivare in qualsiasi momento. |
| `accounts.deactivateDialog.confirm` / `busy` | Deactivate / Deactivating… | Disattiva / Disattivazione… |
| `vatCodes.title(entity)` / `description(entity)` / `caption(entity)` | `VAT codes — ${entity}` / `The VAT codes of ${entity}. Each carries one fixed rate.` / `${entity} VAT codes` | `Codici IVA — ${entity}` / `I codici IVA di ${entity}. Ognuno ha un’aliquota fissa.` / `Codici IVA di ${entity}` |
| `vatCodes.columns.code` / `label` / `rate` | Code / Label / VAT rate | Codice / Descrizione / Aliquota IVA |
| `vatCodes.add` / `addDialog.title(entity)` | Add VAT code / `Add VAT code — ${entity}` | Aggiungi codice IVA / `Aggiungi codice IVA — ${entity}` |
| `vatCodes.addDialog.description` | The rate cannot be changed later: a new rate needs a new code. | L’aliquota non può essere modificata in seguito: una nuova aliquota richiede un nuovo codice. |
| `vatCodes.addDialog.code` / `codeHint` | Code / Letters, digits, - and _ (up to 16). Saved in capitals. | Codice / Lettere, cifre, - e _ (fino a 16). Salvato in maiuscolo. |
| `vatCodes.addDialog.label` / `rate` / `rateHint` | Label / VAT rate (%) / Between 0 and 100, up to 2 decimals. | Descrizione / Aliquota IVA (%) / Tra 0 e 100, fino a 2 decimali. |
| `vatCodes.errors.codeEmpty` / `codeFormat` / `codeTooLong` | Enter a code. / Use letters, digits, - or _ only. / The code can have up to 16 characters. | Inserire un codice. / Usare solo lettere, cifre, - o _. / Il codice può avere al massimo 16 caratteri. |
| `vatCodes.errors.labelEmpty` / `labelTooLong` | Enter a label. / The label can have up to 80 characters. | Inserire una descrizione. / La descrizione può avere al massimo 80 caratteri. |
| `vatCodes.errors.rateInvalid` | Enter a rate between 0 and 100, with up to 2 decimals. | Inserire un’aliquota tra 0 e 100, con al massimo 2 decimali. |
| `vatCodes.errors.duplicate(code, entity)` / `duplicateInactive(code)` | `VAT code ${code} already exists in ${entity}.` / `VAT code ${code} already exists but is deactivated. Reactivate it from the list.` | `Il codice IVA ${code} esiste già in ${entity}.` / `Il codice IVA ${code} esiste già ma è disattivato. Riattivarlo dall’elenco.` |
| `vatCodes.errors.alreadyActive(code)` / `alreadyInactive(code)` | `VAT code ${code} is already active.` / `…is already deactivated.` | `Il codice IVA ${code} è già attivo.` / `…è già disattivato.` |
| `vatCodes.added/deactivated/reactivated(code)`, `deactivate*`, `empty.*`, `loading`, `loadError` | As accounts, with "VAT code" | As accounts, with "codice IVA" |
| `vatCodes.deactivateDialog.body` | No module can choose it any more. What was already booked with it keeps it. A module that uses it as a default needs another one. Its rate never changes. You can reactivate it at any time. | Nessun modulo potrà più sceglierlo. Quanto è già stato registrato con questo codice lo mantiene. Un modulo che lo usa come predefinito dovrà sceglierne un altro. La sua aliquota non cambia mai. Si può riattivare in qualsiasi momento. |
| `fx.title(entity)` / `caption(entity)` | `Exchange rates — ${entity}` / `${entity} monthly average exchange rates` | `Tassi di cambio — ${entity}` / `Tassi di cambio medi mensili di ${entity}` |
| `fx.description(own)` | `${own} for 1 unit of the foreign currency, monthly average. Other modules convert at these rates.` | `${own} per 1 unità di valuta estera, media mensile. Gli altri moduli convertono con questi tassi.` |
| `fx.noSource.title(entity)` / `body` | `No official source for ${entity} yet` / Exchange rates are not fetched or kept for this entity yet. They will be added when its source is chosen. | `Ancora nessuna fonte ufficiale per ${entity}` / I tassi di cambio di questa entità non vengono ancora recuperati né conservati. Saranno aggiunti quando verrà scelta la fonte. |
| `fx.source.term` / `bazg` | Source / Official monthly average of the Swiss Federal Office for Customs and Border Security (BAZG) | Fonte / Media mensile ufficiale dell’Ufficio federale della dogana e della sicurezza dei confini (UDSC) |
| `fx.loading` / `loadError` | Loading exchange rates… / Could not load the exchange rates. | Caricamento dei tassi di cambio… / Impossibile caricare i tassi di cambio. |
| `fx.empty.title` / `body` | No months to show yet / No completed month has rates to show. | Ancora nessun mese da mostrare / Nessun mese concluso ha tassi da mostrare. |
| `fx.columns.month` | Month | Mese |
| `fx.origin.fetched` / `corrected` / `missing` | Fetched / Corrected / Missing | Recuperato / Corretto / Mancante |
| `fx.correct` / `correctLabel(currency, month)` | Correct / `Correct the ${currency} rate for ${month}` | Correggi / `Correggi il tasso ${currency} di ${month}` |
| `fx.cellLabel(currency, month, rate, origin)` / `cellMissingLabel(currency, month)` | `${currency}, ${month}: ${rate}, ${origin}` / `${currency}, ${month}: missing` | `${currency}, ${month}: ${rate}, ${origin}` / `${currency}, ${month}: mancante` |
| `fx.fetchNow` / `fetching` / `checking` | Fetch now / Fetching… / Checking for new rates… | Recupera ora / Recupero… / Verifica di nuovi tassi… |
| `fx.fetchedOk(n)` / `nothingNew` | `Recorded the rates for ${n} months.` (1: `…for 1 month.`) / No new rates to record. | `Registrati i tassi di ${n} mesi.` (1: `…di 1 mese.`) / Nessun nuovo tasso da registrare. |
| `fx.notFetchable(month)` / `throttled` / `deferred(n)` | `The rates for ${month} are not published yet.` / The rates were checked a moment ago. Try again in a few minutes. / `${n} more months are still to fetch. Fetch again to continue.` (1: `1 more month is…`) | `I tassi di ${month} non sono ancora pubblicati.` / I tassi sono stati controllati poco fa. Riprovare tra qualche minuto. / `Restano ancora ${n} mesi da recuperare. Recuperare di nuovo per continuare.` (1: `Resta ancora 1 mese…`) |
| `fx.disabled` / `disabledReader` | Automatic fetching is turned off in this environment. Enter the rates by hand. / Automatic fetching is turned off in this environment. | Il recupero automatico è disattivato in questo ambiente. Inserire i tassi a mano. / Il recupero automatico è disattivato in questo ambiente. |
| `fx.fetchError` | Could not fetch the rates. Try again. | Impossibile recuperare i tassi. Riprovare. |
| `fx.lastFetch.term` / `never` | Last fetch / No fetch yet | Ultimo recupero / Ancora nessun recupero |
| `fx.lastFetch.ok(at)` / `failed(at)` / `disabled(at)` / `throttled(at)` / `notFetchable(at)` | `${at} — succeeded` / `— failed` / `— switched off` / `— checked a moment ago` / `— not published yet` | `${at} — riuscito` / `— non riuscito` / `— disattivato` / `— controllo appena eseguito` / `— non ancora pubblicato` |
| `fx.lastFetch.failedTitle` / `failedBody(at, reason)` | The last fetch failed / `On ${at}: ${reason}. The rates already recorded are unchanged.` | L’ultimo recupero non è riuscito / `Il ${at}: ${reason}. I tassi già registrati non sono cambiati.` |
| `fx.reason.*` | Moved verbatim (timeout, http, parse, monthMismatch, currencyMissing, unknown) | Moved verbatim |
| `fx.deepLink.notListed(month)` | `${month} is not in the list. A month is listed once it has ended; its rate is published a few days later.` | `${month} non è nell’elenco. Un mese compare quando è concluso; il suo tasso viene pubblicato qualche giorno dopo.` |
| `fx.correction.title(currency, month)` | `Correct rate — ${currency} · ${month}` | `Correggi tasso — ${currency} · ${month}` |
| `fx.correction.description` | Anything booked from now on uses this rate. What was already booked with the previous rate keeps it. The previous value is kept in the audit trail. | Tutto ciò che viene registrato da ora in poi usa questo tasso. Quanto è già stato registrato con il tasso precedente lo mantiene. Il valore precedente resta nel registro di audit. |
| `fx.correction.rate(currency, own)` / `hint` / `inEffect(rate, origin)` | `Rate (${own} per 1 ${currency})` / Greater than 0 and below 1000, up to 6 decimals. / `In effect: ${rate} (${origin})` | `Tasso (${own} per 1 ${currency})` / Maggiore di 0 e inferiore a 1000, fino a 6 decimali. / `In vigore: ${rate} (${origin})` |
| `fx.correction.rateInvalid` / `monthNotCompleted` / `notConvertible` | Enter a rate greater than 0 and below 1000, with up to 6 decimals. / This month is not finished yet; its rate cannot be corrected. / This currency has no rate: it is the entity's own currency. | Inserire un tasso maggiore di 0 e inferiore a 1000, con al massimo 6 decimali. / Questo mese non è ancora concluso: il suo tasso non può essere corretto. / Questa valuta non ha un tasso: è la valuta propria dell’entità. |
| `fx.correction.save` / `busy` / `saved(currency, month)` | Save correction / Saving… / `${currency} rate for ${month} corrected` | Salva correzione / Salvataggio… / `Tasso ${currency} di ${month} corretto` |

#### refund-ui `strings.ts`: added, changed, removed

| Key | EN | IT |
|---|---|---|
| `settings.descriptionAll` (changed) | The mileage rates and the default classification of expense types. | Le tariffe chilometriche e la classificazione predefinita dei tipi di spesa. |
| `settings.sections.defaults` (new; `accounting` and `exchangeRates` removed) | Default classification | Classificazione predefinita |
| `settings.accountingLink.withAccess` / `linkText` / `linkLabel` | Ledger accounts, VAT codes and exchange rates are kept in the Accounting app. / Open Accounting / Open Accounting: ledger accounts, VAT codes and exchange rates | I conti contabili, i codici IVA e i tassi di cambio sono tenuti nell’app Contabilità. / Apri Contabilità / Apri Contabilità: conti contabili, codici IVA e tassi di cambio |
| `settings.accountingLink.withoutAccess` | Ledger accounts, VAT codes and exchange rates are kept in the Accounting app by accounting managers. Ask one of them if an entry is missing. | I conti contabili, i codici IVA e i tassi di cambio sono tenuti nell’app Contabilità dai responsabili della contabilità. Se manca una voce, rivolgersi a uno di loro. |
| `settings.defaults.state.deactivated` / `notFound` | Deactivated in Accounting / Not found in Accounting | Disattivato in Contabilità / Non trovato in Contabilità |
| `settings.defaults.needsChoice(n)` | `${n} defaults need a new choice: their entry is deactivated or no longer in Accounting. Lines of those types get no default until you choose another.` (1: `1 default needs a new choice: its entry is deactivated …`; "Lines of that type") | `${n} predefiniti richiedono una nuova scelta: la loro voce è disattivata o non più presente in Contabilità. Le righe di quei tipi non hanno un predefinito finché non se ne sceglie un altro.` (1 analogous, singular) |
| `settings.defaults.unavailable.title` / `body` | Accounting cannot be read now / The defaults are shown as recorded. You cannot change them until Accounting can be read. | Contabilità non è leggibile in questo momento / I predefiniti sono mostrati come registrati. Non si possono modificare finché Contabilità non è leggibile. |
| `settings.defaults.changeBlocked` | Accounting cannot be read now, so defaults cannot be changed. | Contabilità non è leggibile in questo momento: i predefiniti non si possono modificare. |
| `settings.defaults.recovered` / `stillUnavailable` | Accounting can be read again. / Accounting still cannot be read. | Contabilità è di nuovo leggibile. / Contabilità non è ancora leggibile. |
| `settings.defaults.dialog.notFoundCurrent(what)` | `The current ${what} is no longer in Accounting. Choose another, or none.` | `Il valore attuale (${what}) non è più presente in Contabilità. Sceglierne un altro, oppure nessuno.` |
| `settings.defaults.dialog.tryAgain` | Try again | Riprova |
| `settings.defaults.errors.accountNotFound` / `vatNotFound` | That account is no longer in Accounting. Choose another. / That VAT code is no longer in Accounting. Choose another. | Questo conto non è più presente in Contabilità. Sceglierne un altro. / Questo codice IVA non è più presente in Contabilità. Sceglierne un altro. |
| `settings.defaults.foreign.notFoundWarning(code)` | `${code} is no longer in Accounting, so foreign-currency lines get no VAT code until you designate another.` | `${code} non è più presente in Contabilità: le righe in valuta estera non hanno un codice IVA finché non se ne designa un altro.` |
| `settings.accounts.*`, `settings.vatCodes.*`, `settings.fx.*`, `settings.history.rateColumn/originColumn` | removed (moved or dropped) | removed |
| `accountingUnavailable.cause` | Accounting's reference data cannot be read right now. | I dati di riferimento di Contabilità non sono leggibili in questo momento. |
| `accountingUnavailable.approve` | Accounting's reference data cannot be read right now. Nothing was approved. Try again in a few minutes. | I dati di riferimento di Contabilità non sono leggibili in questo momento. Non è stato approvato nulla. Riprovare tra qualche minuto. |
| `accountingUnavailable.classify` | …cannot be read right now. The classification was not changed. Try again in a few minutes. | …Non è stata modificata la classificazione. Riprovare tra qualche minuto. |
| `accountingUnavailable.save` | …cannot be read right now. Nothing was saved. Try again in a few minutes. | …Non è stato salvato nulla. Riprovare tra qualche minuto. |
| `accountingUnavailable.options` | …cannot be read right now, so there is nothing to choose from. Try again in a few minutes. | …quindi non ci sono voci tra cui scegliere. Riprovare tra qualche minuto. |
| `pages.reviewDetail.classification.accountingUnavailablePage.title` / `body` | Accounting cannot be read now / Each line is shown as recorded. Classification cannot be changed until Accounting can be read. | Contabilità non è leggibile in questo momento / Ogni riga è mostrata come registrata. La classificazione non si può modificare finché Contabilità non è leggibile. |
| `…classification.accountingUnavailableLine` | Accounting cannot be read now, so this classification cannot be changed. | Contabilità non è leggibile in questo momento: questa classificazione non si può modificare. |
| `…classification.defaultRecorded` | Default (as recorded) | Predefinito (come registrato) |
| `…classification.notFoundOption(text)` | `${text} (not in Accounting)` | `${text} (non presente in Contabilità)` |
| `…classification.inactiveCurrentAccount` / `inactiveCurrentVat` (reworded), `notFoundCurrentAccount` / `notFoundCurrentVat` | This account is deactivated in Accounting. The line keeps it; choose an active one to change it. / This account is no longer in Accounting. The line keeps it; choose another to change it. (VAT code likewise) | Questo conto è disattivato in Contabilità. La riga lo mantiene; sceglierne uno attivo per cambiarlo. / Questo conto non è più presente in Contabilità. La riga lo mantiene; sceglierne un altro per cambiarlo. (codice IVA analogo) |
| `…classification.defaultDeactivated(what)` / `defaultNotFound(what)` | `The default ${what} for this type is deactivated in Accounting. Choose one.` / `…is no longer in Accounting. Choose one.` with `what` = account / VAT code | `Il ${what} predefinito di questo tipo è disattivato in Contabilità. Sceglierne uno.` / `…non è più presente in Contabilità. Sceglierne uno.` with conto / codice IVA |
| `…classification.rateNotYet` / `rateNotYetHelp(currency, month)` | No rate yet / `No ${currency} rate for ${month} yet. You can still approve: the rate is copied at the first export.` | Ancora nessun tasso / `Ancora nessun tasso ${currency} per ${month}. Si può comunque approvare: il tasso viene copiato alla prima esportazione.` |
| `…classification.ratePending` / `ratePendingHelp(currency, month)` | Rate pending / `No ${currency} rate for ${month} yet. It is copied at the first accounting export of the batch.` | Tasso in attesa / `Ancora nessun tasso ${currency} per ${month}. Viene copiato alla prima esportazione contabile del lotto.` |
| `…classification.follows` (reworded) / `frozen` | Amounts follow the approved total and the exchange rate as they stand now. They are fixed when the request is approved. / Account, VAT code and rate are kept as booked. Later changes in Accounting do not change this line. | Gli importi seguono il totale approvato e il tasso di cambio attuali. Si fissano quando la richiesta viene approvata. / Conto, codice IVA e tasso restano come registrati. Le modifiche successive in Contabilità non cambiano questa riga. |
| `…classification.askManager` (replaces `batchDetail.accountingExport.blocked.askAdmin` in both places) | Ask an accounting manager to enter or fetch it. | Chiedere a un responsabile della contabilità di inserirlo o recuperarlo. |
| `…classification.accountUnknown` / `vatUnknown` | That account is no longer in Accounting. Choose another. / That VAT code is no longer in Accounting. Choose another. | Questo conto non è più presente in Contabilità. Sceglierne un altro. / Questo codice IVA non è più presente in Contabilità. Sceglierne un altro. |
| `pages.batchDetail.accountingExport.pending(n)` | `${n} lines get their exchange rate at this export.` (1: `1 line gets its exchange rate at this export.`) | `${n} righe ricevono il tasso di cambio con questa esportazione.` (1: `1 riga riceve il tasso di cambio con questa esportazione.`) |
| `…accountingExport.blocked.unavailableTitle` / `unavailableBody` | Accounting cannot be read / The exchange rates of lines with a pending rate cannot be fetched. You can still pay or discard this batch. Check again in a few minutes. | Contabilità non è leggibile / I tassi di cambio delle righe con tasso in attesa non si possono recuperare. Il lotto può comunque essere pagato o scartato. Verificare di nuovo tra qualche minuto. |
| `…accountingExport.blocked.rateReason.notPublished` / `fetchFailed` / `noSource` | not published yet / the official source did not answer / no official source | non ancora pubblicato / la fonte ufficiale non ha risposto / nessuna fonte ufficiale |
| `…accountingExport.blocked.fetchTried` (reworded) | Accounting just tried to fetch the missing rates from the official source. | Contabilità ha appena provato a recuperare i tassi mancanti dalla fonte ufficiale. |
| `…accountingExport.blocked.readyAgain(n)` / `stillBlocked(n)` (from A-3 of 20261118) | `The export is ready: ${n} rows.` / `Still blocked: ${n} items.` | `L’esportazione è pronta: ${n} righe.` / `Ancora bloccata: ${n} voci.` |

Each refusal message above names the cause and the remedy, and contains no address, identifier or internal text, in both languages (AC-6.10). The plan's own sentence for `accounting_unavailable` is kept as the base; the Italian uses the file's impersonal "Riprovare" instead of the plan's "Riprova".

## Accessibility

**Per screen: accounting-ui**

- **Frame (AS1).** One h1 (`ToolLayout`), h2 per page (`PageHeader`), h3 per card, h4 only for a `StatePanel` inside a card. `TabNav` is a `nav` landmark named "Accounting sections" with `aria-current="page"`; the shell owns `<main>`. A state that replaces the page (denied, not found) takes focus on its heading through `StatePanel focusOnMount`; the loading line is a polite live region.
- **Entity switch (AS2).** A visible `Field` label "Entity" (AC-8.4), a native select, so the platform's keyboard contract applies. The change is announced by one polite status ("Showing WellD Italia"); focus stays on the select; the cards below are remounted, so a screen reader that was reading rows of one entity is not left in a list that changed under it.
- **Lists (AS3, AS4).** `DataTable` supplies caption, `scope` and a keyboard-scrollable region. Row actions are named after their row ("Deactivate account 5905"). After Deactivate or Reactivate, focus moves to the row header (`focusRowKey`), because the pressed button was replaced; after Add it returns to Add. Status is a badge with a glyph and text, never colour alone. The empty state is a `StatePanel`, not a lone line.
- **Dialogs (AS6).** Modal, labelled, Tab trapped, Escape and × close except while busy, focus returns to the opener. Required fields use `Field`'s `*` plus `aria-required`; there is no "(required)" text. A failed submit moves focus to the first refused field and the message is in that field's `aria-describedby` and its own `role="alert"` (UX-6), so it is announced once, not twice. Hints (the number format, the rate limit) are `aria-describedby` text, available before the error. The deactivate confirm opens on Cancel.
- **Rates (AS5).** One header cell per currency; each cell is a `role="group"` named "EUR, October 2026: 0.9301, Fetched" or "EUR, October 2026: missing", so the cell reads as one unit; the icon-only Correct has an `aria-label` naming currency and month. Missing is a badge with a glyph and the word. Auto-fetch never moves focus; its progress, results, the persistent failed banner and the switched-off banner are polite `role="status"`. The failed banner is not `alert`: it is not time-critical and is still there when the user reaches it. A deep link moves focus to the row header exactly once; an unlisted month is a polite status, not a focus move.
- **Reader and denied states.** The read-only sentence is plain text in the card, in reading order. `PermissionDenied` is an alert that takes focus and offers no retry (not transient).

**Per screen: refund-ui deltas**

- **Settings tabs.** Unchanged `Tabs` behaviour (one tab stop, arrows, Home/End); two tabs now. The link note is plain text with a link whose accessible name says where it goes ("Open Accounting: ledger accounts, VAT codes and exchange rates").
- **Defaults card.** State is a text badge, never colour. The needs-a-new-choice note is a static `role="note"` with an `aria-label`, read in place before the table. The unavailable `Banner` is polite and persistent. **Change** while unavailable is `aria-disabled`, stays focusable and is described by its reason (a `disabled` button would drop focus and hide the reason, design-system § Buttons rule 5). History keeps working.
- **Panel.** Same fieldset-per-line grouping. A deactivated or not-found stored value is a disabled selected option **and** a hint, so the control tells the truth and the reason is read with the field. The unavailable state is a read-only group with a `role="status"` sentence that takes `tabIndex=-1`; the page banner is the first thing in the lines region.
- **Rate pending.** A badge with a glyph and the words "Rate pending"; amounts show "—", not an empty box and not 0.
- **Approve dialog.** The 503 sentence is `role="alert"` inside the dialog; focus returns to the confirm button when busy ends (A-4 of 20261118 is still open: the new refusal makes it reachable more often).
- **Export card.** The new blocker is a heading plus a paragraph inside the same static warning banner (`live="off"`); the lists remain real `<ul>`s; Download stays focusable and `aria-disabled` with its reason (UX-7 of 20261118). The links to Accounting are named after their item ("Open exchange rates: EUR · March 2026"). The quiet re-read after a download announces nothing by itself; the success banner already did.
- **Retry that removes its banner (UX-23).** Focus goes to a named stable anchor and a polite line gives the result. Without it the pattern of A-3 recurs in two more places.

**Cross-cutting**

- **Contrast.** Only tokens: `text-soft` for secondary text, `text-org-text` / `text-red-text` / `text-grn-text` for toned text, never `text-muted` and never bare `text-org` / `text-red`. Nothing new needs a token. Check both themes.
- **Reflow at 320 px.** `TabNav` has `wrap`; the entity select drops under the title; cards stack; the rates and lists tables scroll inside their keyboard-focusable region; dialogs keep their footer in view.
- **Motion.** Nothing beyond the library's spinner, drawer and banner dismissal, which respect reduced motion.
- **Language.** `<html lang>` is set by the shell. Rates and percentages follow the viewer's convention (`0.9246` vs `0,9246`, `8.1%` vs `8,1%`) through `formatNumber`; the API's display string is kept for the rate (as 20261118 did) and is never parsed to compute anything.
- **Keyboard-only paths to verify (QE):** reach Accounting from the sidebar; switch entity; add an account and a VAT code; deactivate then reactivate and land on the row; correct a rate; follow a deep link and land on the month; in Refund, change a default, follow the link note, and fix a refused approval by the summary link.

### How accounting-ui gets the same automated accessibility check as refund-ui

The 20261118 check has three layers; accounting-ui gets all three, so AC-8.4 ("no WCAG 2.1 AA violation found by the suite's automated check") is not left to the first layer alone, which cannot see contrast or layout.

1. **Component tests, jsdom, `expectNoAxeViolations`.** Copy `refund-ui/src/test-support/axe.ts` to `accounting-ui/src/test-support/axe.ts` unchanged (same API: `expectNoAxeViolations(root, { allow })`, `axeViolations`, `formatAxeViolations`, `AxeAllowance`), with its self-test `axe.test.tsx` (the deliberately broken fixture proves the helper fails). Do **not** copy `axeKnownFindings.ts`: its two allowances are about refund-ui's own older components; accounting-ui starts with none and records any future allowance inline with a reason. Add `axe-core ^4.14.0` to accounting-ui's `devDependencies` (refund-ui's version; letterheads-ui and inventory-ui are on `^4.11`). Mirror refund-ui's `vitest.config.ts` (default `environment: 'node'`, per-file `@vitest-environment jsdom`, the `shell/session` and `shell/tokens.css` stubs, the `@operai/ui` alias, `dedupe` for React). The helper's file comment says why `color-contrast`, `region`, `landmark-one-main` and `page-has-heading-one` are off; keep it, and point its "browser pass" reference at layer 2.
   - **The rule that makes the helper count:** one axe assertion per row of the state tables above. Minimum matrix: AS1 (loading, denied, authorization unavailable, other failure, loaded), AS2 (switch with two entities, not found), each card in loading, failed, empty, loaded-manager, loaded-reader, WellD Italia empty, action refused and success; AS5 additionally no-source, missing cell, auto-fetch running, fetch failed banner, switched off, throttled, deep-link note; every dialog idle, field refused, duplicate, busy, general error; the deactivate confirm.
   - A `strings` parity test (`catalogGaps(en, it)` is `[]`) and a `noHardcodedStrings` test over every `.tsx` under `src/` (from letterheads-ui, the scaffold model).
2. **Real-browser axe in the suite's e2e (`shell/e2e`).** jsdom cannot compute contrast or reflow. The suite already runs axe in a real browser (`axeViolations(page, include)` in `helpers/meetingsFixtures.ts`, tags `wcag2a, wcag2aa, wcag21a, wcag21aa`, used by `legal-entities.spec.ts` in **light and dark**, English and Italian, with transitions allowed to finish first). `accounting.spec.ts` and `accounting-access.spec.ts` call it with `include: 'main'` on: ledger accounts (manager, reader), the add dialog with a field error, VAT codes, exchange rates with a Missing cell and the failed-fetch banner, WellD Italia empty and no-source, the denied state; and Refund's adapted `refund-accounting-settings.spec.ts` / `refund-accounting.spec.ts` on the Default classification view with a deactivated default, the review panel with Rate pending, and the export card blocked by "Accounting cannot be read". These are owner-run like the rest of the e2e stack.
3. **One manual browser pass at QE**, as in 20261118: every state of the tables above in both themes, English and Italian, at 320 px, with focus order and live regions inspected. Findings go into this file's **Browser accessibility pass** section, as before.

Lifting `expectNoAxeViolations` into a shared test package is the right fix once a third remote needs it (it already has two near-copies: refund-ui's and letterheads-ui's `formStateAxe.ts`); it is not needed to ship this feature (Gaps G4).

**Test hooks.** New `data-testid`s use the `accounting-` prefix: `accounting-shell`, `accounting-denied`, `accounting-entity-switch`, `accounting-ledger-card`, `accounting-ledger-add`, `accounting-ledger-table`, `accounting-ledger-deactivate-<number>`, `accounting-ledger-reactivate-<number>`, `accounting-vat-card`, `accounting-vat-add`, the same pair for VAT codes keyed by code, `accounting-fx-card`, `accounting-fx-fetch-now`, `accounting-fx-correct-<month>-<currency>`, `accounting-fx-cell-<month>-<currency>`, `accounting-fx-failed`, `accounting-fx-no-source`, `accounting-empty`. The 20261118 `settings-account*`, `settings-vat*` and `settings-fx-*` ids move with their components, so `shell/e2e` specs T31 and T32 are adapted in the same change (the plan already lists this).

## Implementation notes the code tasks must carry (from this design)

- **Natural keys, not ids** (UX-5). `LedgerAccount` and `VatCode` types lose `id`, `createdAt`, `createdByEmail`, `history`; `CatalogSelect` in refund-ui takes `value` as a number or code and drops `id` from its entry types.
- **Key the cards by entity** so a row never outlives its entity switch. `useLoadedResource`'s loader identity does not restart a load (only `enabled` and `reload()` do); a remount is what restarts it.
- **`canManage` is per displayed entity from `/v1/me`.** Do not use `usePermissions()` for write controls in accounting-ui; the shell's `apps` is only for the sidebar and for refund-ui's link note.
- **Client limits come from `lib/limits.ts` and mirror the server's.** The 20261118 account-number pattern (`3 to 6 digits`) is wrong under AC-1.2 and the rate input's 9999 ceiling is wrong under AC-2.5.
- **A write that returns 403 re-reads `/v1/me`** (FA10). A list that returns 404 does the same and falls back (FA2).
- **Auto-fetch** stays once per visit and is started from a callback, never by setting state in the effect body (`react-hooks/set-state-in-effect`, the Promise-chain style of `useLoadedResource`).
- **Merge returned rows, never compute.** A POST/PUT answers with the row or month; the card swaps it in and reloads for order. No CHF, VAT or rate arithmetic in either remote.
- **Dialogs beside the card, not inside a form** (ADR 20261118 dialog-beside-form), as before.
- **refund-ui:** the 503 and the new 422 codes are branched on `error.code`, never on status or `detail` (the lesson of G2 of 20261118). `ReviewDetailPage`'s approve error switch gains `accounting_unavailable` next to `accounting_release_pending`. The accounting view is reloaded after any 503 from a classification write.
- **FU-S7 / A-1 of 20261118** (an approval refused only for out-of-scope lines fails silently) is **still open** and is not changed by this design. The new refusals reuse the same page-level region; it should be fixed in this release, as that design's pass recommended.
- **Sidebar and shell:** add `accounting: <Icon name="list-ordered" …/>` to `TOOL_ICONS`, `tools.accounting` in both languages, and place the `TOOLS` entry last in the main list.

## Gaps found

| # | In | Gap | Proposed answer |
|---|---|---|---|
| G1 | plan, Components touched (shell) | `Sidebar.tsx` has `TOOL_ICONS: Record<ToolId, ReactNode>`; a new `ToolId` does not compile without an icon, and the library has no ledger icon. The plan lists neither. | UX-14: `list-ordered`, no library change; or add a "book" icon to `@operai/ui` (story, test, changeset) as a follow-up. Add the Sidebar edit to the shell task. |
| G2 | plan, UI (accounting-ui) | "The three views are `Tabs`" contradicts the plan's own routes and design-system § Tool frame (separate URLs are `TabNav`). | UX-1: `TabNav`. Update the plan bullet. |
| G3 | plan, UI vs e2e | The UI paragraph says an entity outside `/v1/me` "falls back to the first covered entity"; the e2e says "a WellD Italia URL → 404 view" for a CH-only manager. | UX-12: garbage falls back, a known uncovered entity is a not-found view. Align the plan's UI paragraph with its e2e. |
| G4 | plan, Components moved | `useLoadedResource`, `ErrorBanner`, `SuccessBanner` and `ConfirmDeleteModal` are imported by every moved card and are not in the move list. | `useLoadedResource` is copied (a hook, D29); the three adapters are **not**: accounting-ui uses `Banner` and `ConfirmDialog` through letterheads-ui's `LoadState`/`Saved` pattern. Design-system principle 1 says a pattern in two apps belongs in the library: lifting `useLoadedResource` and the axe helper into `@operai/ui` (or a test package) is the follow-up once a third app needs them. |
| G5 | plan, API: `POST …/exchange-rates/fetch` | The 200 body is `attempts: [{month, outcome, errorCode}]`; the moved UI also reads `recorded` per attempt (to say "Recorded the rates for N months"), `deferredMonths`, and outcomes `not_fetchable` and `throttled`. Without them the confirmation and two info banners built in 20261118 (S5a) cannot be produced. | Keep the 20261118 shape (`recorded`, `deferredMonths`, the five outcomes) in the moved `fx.service`, and say so in the contract; or accept losing those banners. The design assumes the shape is kept. |
| G6 | plan, API: `lastFetch` | After D4 a fetch may be triggered by a consumer, so a reader's "last fetch failed" can come from a Refund-triggered fetch. | No change needed; noted so QE does not read it as a bug. The banner copy does not say who fetched. |
| G7 | plan, API: export summary `missingRates` | A pending line approved in the **current** month blocks the export with a month the Exchange rates table cannot show yet, and the item says nothing about why it is missing. The consumer rates answer already knows (`not_published`, `fetch_failed`, `no_source`). | Add `reason` to each `missingRates` item so the card can say "not published yet" instead of sending the person to a row that does not exist. UX-11's unlisted-month note covers the Accounting side either way; the Refund side degrades to the unexplained item if `reason` is absent. |
| G8 | plan, API: review view | (a) For a type default that is deactivated or not found, the view must return the entry **with its state and `accountIsDefault: true`** (not `null`) for the panel to say why (RS4); `null` would read as "no default set". (b) The panel's rate link needs the same `viewer.canOpenAccountingRates` the export summary has; with only `apps`, a reader limited to WellD Italia would see a link that lands on a not-found view. | (a) State it in the contract; AC-6.3's refusal stays server-side. (b) Add `viewer.canOpenAccountingRates` to `GET /review/requests/{id}/accounting`; fallback: `apps ∋ "accounting"`. |
| G9 | plan, API: `409 vat_code_duplicate` | `reactivate: true` is shown for any duplicate, but AC-1.6 says to point to reactivation only when the existing code is deactivated; for an active duplicate the pointer is wrong. | Define `reactivate` as "the existing code is deactivated" (the UI also checks its own list). Add the same flag to `ledger_account_duplicate` for symmetry. |
| G10 | plan, API: export summary | `fetchAttempted` (used by the blocked card's "just tried to fetch" sentence) is not in the plan's summary list; after the move, the fetch is Accounting's, not Refund's. | Keep `fetchAttempted` (the consumer call knows whether it asked for a fetch) and the reworded sentence; otherwise drop the sentence and its two keys. |
| G11 | spec AC-1.6 / AC-1.3 | The spec points to reactivation for VAT codes only; for a duplicate **account** the same pointer is useful and the 20261118 UI already had it. | Keep it for both (designed that way); no spec change. |
| G12 | auth catalog (AC-3.1) | The admin GUI shows the catalog's `label` fields, in English only. | Resource "Accounting", actions "Read" and "Manage". No description field exists to say that Manage includes Read (AC-3.2); put it in the admin docs, not the catalog. |
| G13 | spec AC-2.3 vs plan D18 | AC-2.3 asks the rate list to show "fetched or corrected by hand" (designed, as the origin badge) but nothing shows **who** or **when**; the plan's D18 and the spec's non-goal agree. | Nothing to do. Recorded so a reviewer does not look for it. |
| G14 | 20261118 findings still open | A-1 (silent approval refusal for out-of-scope lines), A-2, A-3, A-4 and A-7 of the Browser accessibility pass are not part of this feature but sit on screens it changes (review panel, approve dialog, export card, last-fetch line). | A-7 is closed here (UX-9); A-3 is designed in (UX-23); A-4 is noted in RS5. A-1 and A-2 remain for the 20261118 fix round. |
