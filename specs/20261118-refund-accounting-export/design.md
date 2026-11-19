---
spec: 20261118
status: draft
---

# Design: Refund accounting — ledger accounts, VAT, receipt numbers and the batch export

Designed unattended on 2026-11-18 from `spec.md` (approved, amendments A1/A2) and `plan.md`, plus a static read of
`refund-ui/src` and `operai-ui` (components, `docs/design-system.md`, `docs/building-pages.md`). The app was not run
(it needs credentials this run does not have), and the visual companion was not enabled, so there are no mockups;
layouts are described in words and small text wireframes. The product already has a design system, so there is **no
Visual direction section**: tokens, type scale and icons are the system's, and nothing new is added to `tokens.css`.

Design decisions are numbered `UX-n`, each with its reason, so they are cheap to change tomorrow. Anything the plan or
spec must answer is under **Gaps found** at the end.

> **Status and sync (added 2026-11-19).** `status: draft` is deliberate: design is ungated in this flow and nothing approves this file. Everything above the two last sections describes the design as intended on 2026-11-18. Two later changes are recorded in place: what the accounting sign-off round retired or changed is marked "(retired 2026-11-19, sign-off)" or "(changed 2026-11-19, sign-off)", and what moved to the Accounting app the same day (ledger accounts, VAT codes, exchange rates and the dialogs of those cards) is marked "(moved 2026-11-19 to the Accounting app)" and is owned by `specs/20261119-accounting/design.md`. **The section "Sign-off round sync (2026-11-19)" at the end, after the browser pass, reconciles the round with the code; where it and the text above disagree it describes what is built.** The "Browser accessibility pass (2026-11-19)" predates the sign-off round and says nothing about the screens the round changed. The pass for them is pending, owner step T81, and no result is claimed.

## Decisions

| # | Decision | Why | Cost to change |
|---|---|---|---|
| UX-1 | **(changed 2026-11-19, sign-off)** Settings now has two views, General and Default classification: Accounts and VAT and Exchange rates **(moved 2026-11-19 to the Accounting app)**, and the foreign-currency VAT code **(retired 2026-11-19, sign-off)**. As first designed: The Settings page gets **three same-page views** through `Tabs`: **General** (today's mileage-rate cards and the distribution email, unchanged), **Accounts and VAT** (ledger accounts, VAT codes, default classification, foreign-currency VAT code), **Exchange rates**. The active view is in the URL (`?section=general\|accounting\|exchange-rates`, plus `&month=YYYY-MM` for exchange rates). Only the active view is mounted. | Seven-plus cards on one scrolling page is too long, and the rates table is the longest. The URL lets the export's "missing rate" blocker link straight to the month. Mounting only the active view means the plan's `fetchDue` auto-fetch (an outbound call) runs only when an admin actually looks at the rates, not on every Settings visit. A view the user may not open is **left out**, never disabled (design-system § Tool frame); with one view only (a `rate:read`-only user) no tab list is shown and the page is exactly today's. | Replace `Tabs` by stacked cards. The cards are independent, so nothing else moves. |
| UX-2 | A default is edited in a **`FormDialog` per expense type** ("Change"), not with inline selects. | Each save appends a permanent history row (AC-2.1), like a mileage-rate entry. A deliberate dialog with a description is the existing pattern (`AddRateEntryModal`); twelve rows of live selects (fourteen since 2026-11-19, sign-off) would write history on every slip of the mouse. The dialog also gives one place to say that approved lines are unchanged (AC-2.3). | Medium. |
| UX-3 | **Deactivate** is a `ConfirmDialog` with `tone="primary"` that states the consequences. **Reactivate** acts at once, with no dialog. | Deactivation is reversible (A1), so by the design-system rule 2 it is not `danger`. It does change what approval needs (a type whose default is deactivated has no default), so the body says so. Reactivation only restores a state. | Low. |
| UX-4 | Account and VAT code on a line are **native `<select>`s**, labelled **number first** (`5905 — Spese rimborsi…`), committed **on change**. **(changed 2026-11-19, sign-off)** The VAT select has a "None" option and no default marker; the account select is as designed. | The design system says a `<select>` when the list is short and fixed (15 accounts, 3 to a handful of codes); a native select also types ahead by prefix, and the number first makes that work for accountants who know the numbers. A select has no "blur" moment, so on-change is the only sensible commit. | Low. |
| UX-5 | A refused approval (`classification_missing`) is shown as a **page-level `ErrorSummary`** with one jump link per missing value, plus a field error on each panel. **(changed 2026-11-19, sign-off)** A missing value is only ever an account. The approve dialog closes. The plan said "the approve dialog shows the 409 as a list". | A modal dialog covers the controls that have to be fixed. The suite's refused-save pattern (design-system § Refused save) is exactly an `ErrorSummary` over the controls, with focus moved to the first one. `accounting_release_pending` is a plain message and does stay in the dialog (nothing to fix on the page). | Low. Plan wording to update (Gap G1). |
| UX-6 | A **missing exchange rate is a blocker, not an error**: a warning-toned list with a link to the month in Settings, never a red failure. | AC-6.5 says the batch is otherwise unaffected. Orange means "try again / needs someone"; red means "you must fix this field" (INC-20). The copy says the batch can still be paid or discarded. | Low. |
| UX-7 | On the batch page **Download is a `secondary` button**, and while the export is blocked it is `aria-disabled` with the reason as its description, not hidden. | The batch page already has one `primary` (Mark as paid); one primary per view. A user has to be able to reach the disabled button to learn why (design-system § Buttons rule 5). | Low. |
| UX-8 | Receipt numbers are shown **in full, not compressed** (`MC26/014, MC26/015`), on screen. The PDF compresses runs (plan). | No second compression rule to mirror and test in the UI; a screen has the room a printed table has not. | Low. |
| UX-9 | A section the user has no capability for is **left out** (no tab, no card); a 403 that arrives anyway hides the card, as the email card already does (spec AC-3.2 of refund-settings). The export card is the exception: out-of-scope shows a short note. | Same posture as the existing Settings page. The export is visible-but-refused because the batch page itself is open to every reviewer and "why can't I export?" is a real question. | Low. |
| UX-10 | A month is shown as **"March 2026" / "marzo 2026"** through a new `formatMonth` in `@operai/ui`. | The library has no month formatter, and the rules forbid formatting by hand or with `toLocaleString()`. If a library change is unwelcome, the fallback is the ISO `2026-03`, which is language-neutral and is what the CSV and the API carry. | Low. |
| UX-11 | The exchange-rates view runs the plan's `fetchDue` auto-fetch **once per visit**, never loops (also on failure), never moves focus, and reports in a polite live region. A failed fetch leaves a **persistent** warning (AC-5.6) until a later fetch succeeds. | A background call must not steal focus or flicker; the failure must outlive a toast because the AC says the admin can "see that the last fetch failed and when". | Low. |
| UX-12 | The CSV is downloaded as a **`Blob` from `response.blob()`**, never `response.text()`, with a **client-built filename** `refund-accounting-<cutoff YYYY-MM-DD>-<batchId>.csv`. **(changed 2026-11-19, sign-off)** The file is an Excel workbook, `.xlsx`; the Blob rule stands. | `.text()` drops the UTF-8 BOM that `exportFormat.ts` writes on purpose. **(retired 2026-11-19, sign-off)** A workbook has no BOM; decoding it as text would corrupt its bytes instead. `Content-Disposition` is unreadable cross-origin unless refund-api exposes it (Gap G9); the cutoff and id are already on the page. | Low. |
| UX-13 | A line that is **WellD Italia, or rejected**, shows **no** classification panel and no "not applicable" text. | AC-3.9 says no account and no VAT are "shown or required". A rejected line is not booked. | Low. |
| UX-14 | Changing a classification after approval needs **no confirmation dialog**. | It is audited (AC-3.6), reversible by changing it back, and accounting does it many times; a dialog per change would punish the exception work this feature exists to speed up. The capability already gates it. | Low. |

## Flows

Ids: F = flow, S = screen (see Screens & states). Each flow names the user story and acceptance criteria it serves.

**F1 — Admin adds a ledger account** (US-1: AC-1.1, AC-1.2, AC-1.7) **(moved 2026-11-19 to the Accounting app)**
1. Settings → *Accounts and VAT*. Card "Ledger accounts" lists the accounts. Holders of `settings:manage` see **Add account** in the card action.
2. Dialog (S6a): number, name. On blur, a client pre-check compares the number with the loaded list.
3. Save → the row appears, a success banner says "Account 5905 added", focus returns to the Add button.
4. Exits: 409 duplicate → error on the number field naming the number (AC-1.2), and, when the duplicate is deactivated, "…is deactivated. Reactivate it from the list." (A1 makes that the way back). 422 → field error. 403 → dialog error "no permission". Network/5xx → inline error, every typed value kept.

**F2 — Admin deactivates or reactivates an account or VAT code** (US-1: AC-1.3, AC-1.6, AC-1.9, AC-1.10, AC-1.11) **(moved 2026-11-19 to the Accounting app)**
1. Row action **Deactivate** → `ConfirmDialog` (UX-3). Confirm → the row's badge turns *Inactive* and the action turns into **Reactivate**. A success banner confirms; focus moves to the row header (`focusRowKey`), because the button the user pressed no longer exists.
2. **Reactivate** → acts at once, same confirmation and focus.
3. Exits: 409 `already_active` / `already_inactive` (a stale list, AC-1.11) → inline alert "Account 5905 is already active." and the list reloads; nothing else changes.
4. Lines already classified keep their value whatever happens here (nothing in this flow touches them).

**F3 — Admin adds a VAT code** (US-1: AC-1.4, AC-1.5) **(moved 2026-11-19 to the Accounting app)**
Same shape as F1. Dialog fields: code (saved in capitals), label, rate in percent. The description states that the rate cannot be changed later. **The list has no edit control at all** (AC-1.5): its only row actions are Deactivate / Reactivate. Duplicate (active or deactivated) → field error on the code naming it.

**F4 — Admin sets the defaults** (US-2: AC-2.1 to AC-2.8) **(changed 2026-11-19, sign-off)** AC-2.5 to AC-2.7 are retired and a default is one account; see the sync.
1. *Accounts and VAT* → card "Default classification": twelve rows, each with its default account and VAT code or **None** (AC-2.2), who/when, **Change** and **History**. **(changed 2026-11-19, sign-off)** Fourteen rows, each with its default account or **None**; there is no VAT column.
2. **Change** → dialog (S6c) with two selects offering **only active** entries (AC-2.4) and an explicit "None (no default)" option **(changed 2026-11-19, sign-off)** (one select, of accounts). Save is disabled until something differs from what is saved. Success → "Default saved for Travel — train".
3. **History** → drawer (S6e) listing every previous default, newest first (AC-2.1).
4. **(retired 2026-11-19, sign-off)** The **foreign-currency VAT code** sits at the top of the same card as one labelled value with **Change** and **History** (AC-2.5, AC-2.6). If the designated code has been deactivated the card says that foreign-currency lines now get no VAT code (AC-2.7).
5. Exits: 422 `*_inactive` (someone deactivated it while the dialog was open) → field error "That account has been deactivated. Choose another." and the options reload. 403 → inline error.

**F5 — Accounting reviews and classifies a request** (US-3: AC-3.1 to AC-3.5, AC-3.8 to AC-3.10)
1. Review queue → request (status *submitted*). The line list shows, **inside each WellD CH line**, a classification panel (S7) with the account and VAT code already filled in and marked **Default** (AC-3.1; for a line not in CHF the default account and the foreign-currency VAT code, AC-3.2), the exchange rate used, the CHF amount and the VAT amount (AC-3.8). **(changed 2026-11-19, sign-off)** Only the account is pre-filled and marked Default; the VAT code shows **None** with no marker, in CHF and in any other currency (AC-3.1, AC-3.13); the foreign-currency VAT code is **(retired 2026-11-19, sign-off)**; the VAT amount is shown only when a VAT code is set.
2. Accounting changes a select → saved at once (UX-4); the **Default** marker becomes **Set by hand** (AC-3.3); a polite message confirms.
3. Editing the approved total (existing control) reloads the request **and** the accounting view, because the CHF and VAT figures follow the total.
4. **Approve** (existing button, existing `ApproveDialog`).
   - Success: unchanged (navigate to the queue with the confirmation). The classification is frozen server-side at that moment (AC-3.5).
   - `classification_missing` (AC-3.4): dialog closes, `ErrorSummary` "Nothing was approved. 2 values need your attention." **(changed 2026-11-19, sign-off)** (now "Nothing was approved. 2 lines need an account.") lists each line and what is missing, focus moves to the first missing select, every missing select carries its own error.
   - `accounting_release_pending`: plain message in the dialog, Approve stays available for retry.
5. WellD Italia lines show no panel and approval works exactly as before (AC-3.9). The employee's own request pages never call the accounting endpoint and show no accounting copy (AC-3.10).

**F6 — Accounting corrects an approved line** (US-3: AC-3.6, AC-3.7)
1. Review → an *approved* request: each CH panel is still editable when the request's batch is not paid and the user holds `request:reclassify`. A change saves at once, audited, with total and decision untouched.
2. Once the batch is *paid*, the panel is read-only with "Locked: its batch has been paid." A change attempted from a stale page → 409 `classification_locked` → a guardrail dialog with its own copy, then a reload.

**F7 — Everyone sees receipt numbers** (US-4: AC-4.6, AC-4.9)
- The employee's request page (approved, paid) and accounting's review page show the number on each numbered line.
- The batch page shows, under each request row, the request's numbers; the employee's name is already the card title, so the number is always read with the name (AC-4.6).
- Nothing creates or edits a number in the UI; rejected lines and not-yet-approved lines show nothing.

**F8 — Admin looks after exchange rates** (US-5: AC-5.1 to AC-5.7) **(moved 2026-11-19 to the Accounting app)**
1. Settings → *Exchange rates*. Table: months (newest first) × EUR, USD, GBP. Each cell shows the rate and where it came from (*Fetched* / *Corrected*) or **Missing** (AC-5.2, AC-5.5). The last-fetch status is always shown (AC-5.6).
2. On open, if the API says `fetchDue` and the user holds `settings:manage`, the view fetches once, quietly (UX-11).
3. **Fetch now** (manage only) → busy button, then a confirmation of what was recorded, "no new rates", "not published yet", or the persistent failure banner (AC-5.6). Rates already recorded never change on a failed fetch.
4. **Correct** on a cell → dialog (S6f): the rate, with 6 decimals allowed, and a sentence that the previous value stays in the history. Success → the cell shows the new value with *Corrected*; the history is one click away (S6e) (AC-5.3). A later fetch never replaces a correction (AC-5.4) — the UI just keeps showing the corrected value.
5. Arriving with `&month=2026-03` (from the export blocker) scrolls to that row and moves focus to its row header.

**F9 — Accounting exports a batch** (US-6: AC-6.1 to AC-6.12; US-7: AC-7.2)
1. Monthly processing → a batch (compiled or paid) → card **Accounting export** (S10), under the summary card. It checks the export on load without blocking the rest of the page.
2. Ready: it says how many rows, and how many WellD Italia lines are left out (AC-6.6). **Download CSV** **(changed 2026-11-19, sign-off)** (now **Download Excel file**) → busy → the browser saves the file → "Export downloaded: 12 rows". Each download is logged by the server (AC-6.10); the busy state prevents a double click writing two log rows.
3. Header-only (AC-6.7): the card says the file will contain only the header row; Download is still offered.
4. Blocked: the card lists the blockers (S10 states) and Download is `aria-disabled`. **Check again** reruns the check (the server retries the fetch of missing rates, throttled). Mark as paid and Discard keep working, and the card says so (AC-6.5).
5. Discarded batch: the card is not rendered at all (AC-6.9).
6. Out of WellD CH scope: an info note instead of the download (AC-6.11).

**F10 — Lines approved before the feature** (US-7: AC-7.1 to AC-7.3) has no screen of its own. AC-7.1 and AC-7.3 are server work (release script). AC-7.2 appears as the *unclassified lines* blocker of F9, each item linking to the request, where F6 fixes it.

### Acceptance criteria with no UI surface of their own

These are proven by the plan's tests and only *show up* through the screens above; they need no extra design:
AC-1.8, AC-4.1 to AC-4.5, AC-4.7, AC-4.8, AC-4.10 (assignment rules), AC-5.1 and AC-5.4 (the fetch itself), AC-6.2, AC-6.3, AC-6.4, AC-6.8, AC-6.10, AC-6.12 (file contents and log), AC-7.1, AC-7.3.
AC-1.8 is audit recording only; the catalog lists still show who added an entry and when, which the list already carries.

### UI proposed by the plan that no acceptance criterion asks for (reported, not designed)

| Item | Where | Recommendation |
|---|---|---|
| "Back to default" (`null` on the classification PUT) | plan API, review page | No control is designed for it. If product wants it, add an AC; otherwise drop the `null` branch from the API. |
| Source discrepancy on a fetched rate (`sourceDiscrepancy`) | plan API, exchange rates | Not displayed. Add an AC if an admin should see it, or leave it in the fetch log only. |
| A "N lines still need an account" notice before Approve is pressed | review page | Not designed. AC-3.4 only asks that the refusal names the lines (F5 does). |
| A re-export hint on a compiled batch after a post-approval change | review page, plan R9 | Not designed. |
| A change-history view for accounts and VAT codes | Settings | Not designed (AC-1.8 is audit recording). The list shows who added each entry and who last changed its status. |
| The manual **Fetch now** button and the `fetchDue` auto-fetch | exchange rates | Designed, because AC-5.1 and AC-5.6 are unreachable by an admin without them. They have no AC of their own; the architect may want one. |
| The Settings tab structure and `?section=` link (UX-1) | Settings | Structure only, no new behaviour. |

## Screens & states

For every screen, the rule from `building-pages.md` holds: **exactly one state at a time**. "Denied" means the capability is absent: either the section is left out (Settings) or, for the export, a note. Every card announces loading once through a polite `VisuallyHidden` line (on the first card of a view, as the existing page does).

### S1 — Settings shell (`/settings`, existing page)

`PageHeader` (unchanged heading, description extended) → `Tabs` → the active view. `general` holds today's content untouched.

| State | Behaviour |
|---|---|
| One view available (`rate:read` only) | No tab list; page is today's page. |
| Several views | `Tabs` with label "Settings sections"; arrows/Home/End move between tabs; a tab for a view the user cannot open is not in the DOM. |
| Unknown `?section=` or a section the user cannot open | Falls back to the first available view (no error). |
| Each card | Its own fetch and state machine (loading / error / loaded / hidden-on-403), as the email card does today. |

### S2 — Card "Ledger accounts" (Accounts and VAT view) **(moved 2026-11-19 to the Accounting app)**

Columns: **Number** (mono, row header), **Name**, **Status** (`StatusBadge`: *Active* / *Inactive*), **Added** (by · date), **Actions** (manage only).

| State | What the user sees |
|---|---|
| Loading | `SkeletonRows` + polite "Loading ledger accounts…". |
| Empty | `StatePanel` "No ledger accounts yet" + "Add the accounts that refunds are booked to." No CTA (the card action is the CTA). |
| Loaded | The table. Inactive rows carry the *Inactive* badge and the **Reactivate** action; active rows **Deactivate**. |
| Load failed | `ErrorBanner` with Retry. |
| Denied | Card is not rendered (no `settings:read`; or a 403 that arrives anyway). |
| Read-only (read, not manage) | The table without the Add button and without row actions. |
| Saving | Dialog or confirm is `busy` and cannot be dismissed; the table does not change until success. |
| Action refused (409 / 403 / 5xx) | Inline `role="alert"` in the dialog, or, for a row action, a `Banner tone="danger"` above the table; the list reloads on 409. |
| Success | Compact auto-dismissing success banner above the table. |

### S3 — Card "VAT codes" **(moved 2026-11-19 to the Accounting app)**

Same structure as S2. Columns: **Code** (mono, row header), **Label**, **VAT rate** (numeric, `8.1%`), **Status**, **Added**, **Actions**. There is no edit action and no "edit" icon anywhere (AC-1.5).

### S4 — Card "Default classification" **(changed 2026-11-19, sign-off)** Account only, fourteen types; see the sync, section 3.2

**(retired 2026-11-19, sign-off)** Top: `FactList` with one fact, **VAT code for foreign-currency lines**: the code and its label and rate, or "None designated"; if the designated code is inactive, the value shows an *Inactive* badge and a warning sentence (AC-2.7). **Change** and **History** next to it (manage / read).
Below: the 12-row table. Columns: **Expense type** (row header), **Default account**, **Default VAT code**, **Last changed**, **Actions**. **(retired 2026-11-19, sign-off)** Fourteen rows and no VAT column.
- A half with no default shows **None** in secondary text. A half pointing at a now-inactive entry shows the entry and an *Inactive* badge (the plan's warning). **(changed 2026-11-19, sign-off)** There is one half, the account.
- "Last changed" is "Not set yet" for a type never configured, else `by · date`.
- A sentence in the card description explains that where a type has no default accounting must choose on each line before approving (AC-3.4).

| State | What the user sees |
|---|---|
| Loading / failed / denied | As S2. |
| Empty | Never empty: the API always returns the 12 types. A type with nothing shows two **None**. **(changed 2026-11-19, sign-off)** Fourteen types, and a type with nothing shows one **None**. |
| Inactive reference | *Inactive* badge on the cell, plus the sentence "Lines of this type get no default until you choose another." in the row's change dialog. |
| Saving / success / errors | As S2; a success banner names the type. |

### S5 — Exchange rates view **(moved 2026-11-19 to the Accounting app)**

`Card` "Monthly exchange rates" with a `FactList` fact **Last fetch** and the **Fetch now** button (manage) in the card action, then the table. Columns: **Month** (row header, `formatMonth`), **EUR**, **USD**, **GBP** (numeric). A cell = the rate (mono, as the API's display string, e.g. `0.9246`), a `Badge` *Fetched* (neutral) or *Corrected* (accent), and for managers a **Correct** icon button named after its cell. A missing rate = a `StatusBadge` "attention" labelled **Missing**, plus **Correct** for managers (an admin can type a rate for a month that the source never published).

```
Monthly exchange rates                                    [ Fetch now ]
CHF per 1 unit of foreign currency, monthly average.
Last fetch: 18.11.2026 09:14 — succeeded

 Month           EUR                  USD                 GBP
 October 2026    0.9301 [Fetched] ✎   0.8102 [Fetched] ✎  1.0750 [Fetched] ✎
 September 2026  0.9340 [Corrected] ✎ 0.8130 [Fetched] ✎  ⚠ Missing ✎
```

| State | What the user sees |
|---|---|
| Loading | `SkeletonRows` + polite "Loading exchange rates…". |
| Empty | `StatePanel` "No months to show yet." (no completed month in the window). |
| Loaded, nothing missing | The table. |
| Missing | Per cell, `StatusBadge` *Missing*. The row is **not** otherwise highlighted. |
| Auto-fetch running | A polite status line "Checking for new rates…" in the card; the table stays usable; no focus move. |
| Fetch succeeded | Compact success banner: "Recorded the rates for 2 months." or "No new rates to record." |
| Month not published yet (`not_fetchable`) | Info banner: "The rates for October 2026 are not published yet." Not an error. |
| Fetch failed (AC-5.6) | **Persistent** warning banner (not dismissible, `live="polite"`): "The last fetch failed", with the time and a plain reason, and "The rates already recorded are unchanged." It stays until a later fetch succeeds, and **Fetch now** is the retry. |
| Fetching switched off (`disabled`) | Info banner: "Automatic fetching is turned off in this environment. Enter the rates by hand." |
| Load failed | `ErrorBanner` with Retry (the fetch status is part of the same GET). |
| Denied | The tab is not offered; a 403 hides the card. |
| Read-only | The table without Fetch now or Correct. |
| Deep link `&month=` | The row is scrolled into view and its header takes focus; if the month is not in the window the table simply shows from the top. |

### S6 — Dialogs (all mounted beside the card, never inside a `<form>` — ADR 20261118 dialog-beside-form)

All are `FormDialog` (focus on the first field, Enter submits, Escape and × cancel except while busy, typed values kept on failure, error inline above the footer). Buttons that open them carry `aria-haspopup="dialog"`.

- **S6a Add ledger account** **(moved 2026-11-19 to the Accounting app)**. Description: "The number and name cannot be edited later. An account can be deactivated and reactivated." Fields: *Account number* (required, hint "For example 5905 or 2620.1"), *Account name* (required, up to 120). Client checks mirror the server (`^[0-9]{3,6}(\.[0-9]{1,3})?$`, non-empty name); the server stays the authority.
- **S6b Add VAT code** **(moved 2026-11-19 to the Accounting app)**. Description: "The rate cannot be changed later: a new rate needs a new code." Fields: *Code* (required; typed text is upper-cased when the field loses focus; hint on allowed characters), *Label* (required), *VAT rate (%)* (required, `MoneyInput`, dot or comma, 0 to 100, up to 2 decimals).
- **S6c Default classification — {type}** **(changed 2026-11-19, sign-off)** (one select, *Default account*; see the sync). Two `CatalogSelect`s: *Default account*, *Default VAT code* **(retired 2026-11-19, sign-off)**. Options: "None (no default)", then the active entries. If the saved value is inactive the select starts on "Choose…" (an invalid state) and Save is disabled until a real choice is made, so saving can never silently clear a default. Save is disabled while nothing differs from what is saved.
- **S6d VAT code for foreign-currency lines** **(retired 2026-11-19, sign-off)**. One `CatalogSelect` (active codes and "None designated").
- **S6e History drawer** (`Drawer`, reference content, no form). Title "History — {subject}", `DataTable`, newest first: *When*, *By*, then the values (account and VAT code for a type **(changed 2026-11-19, sign-off)** (account only); the code for the foreign-currency VAT code **(retired 2026-11-19, sign-off)**; the rate and origin for an exchange rate). Empty: "No changes recorded yet." One component for all three uses.
- **S6f Correct rate — {currency} · {month}** **(moved 2026-11-19 to the Accounting app)**. Field *Rate (CHF per 1 EUR)*, `MoneyInput`, up to 6 decimals, with the rate currently in effect and its origin as the hint. Description: "The previous value stays in the history. A batch exported before this correction will export differently if it is exported again." Errors: invalid rate on the field; `month_not_completed` as a general error.

Each dialog's states: idle, busy ("Adding…" / "Saving…", not dismissible), field error(s) with focus on the first invalid field, general error (403 "You don't have permission to do this.", 409/5xx generic), success (closes, banner on the card, focus back on the opener).

### S7 — Classification panel (review page, inside each WellD CH line row)

Shown for a line that is **WellD CH, not rejected**, in a request that is submitted or approved or paid. Not shown for WellD Italia lines, rejected lines, drafts, or on the employee's own pages.

```
 19.03.2026 · MC26/014 · Travel — train · [WellD CH] [EUR]            Approved total
 Milan–Lugano return                                                    EUR 52.00
 ─────────────────────────────────────────────────────────────────────────────────
 Classification
 Account [Default]                      VAT code [Default]
 [ 5901 — Spese viaggi in treno    v ]   [ NOVAT — Senza IVA (0%)   v ]
 Exchange rate  0.9246 · March 2026     CHF amount  CHF 48.08     VAT amount  CHF 0.00
```

**(changed 2026-11-19, sign-off)** The wireframe above shows `NOVAT` pre-set and a Default marker on both selects. Now only the account is pre-set and marked Default; the VAT select reads **None** with no marker; `NOVAT` is no longer a code (the seed has `IP00`, 0.00 %). See the sync, section 3.3.

Layout: a `fieldset` named for its line ("Classification for 19.03.2026 · Milan–Lugano return"), a two-column grid of `Field`s that collapses to one column at narrow widths, then a three-fact `dl` (exchange rate, CHF amount, VAT amount). A CHF line has no exchange-rate or CHF-amount fact, only the **VAT amount** with the rate (`CHF 1.56 (8.1%)`).

| State | What the user sees |
|---|---|
| Accounting view loading | A `Skeleton` block **inside CH lines only** (so an Italian-only request never flashes one), with a polite "Loading classification…" once per page. |
| Accounting view failed (network / 5xx) | One `ErrorBanner` with Retry above the lines (not one per line). The rest of the page keeps working. |
| Accounting view 403/404 | An info note above the lines: "The classification is not available for this request." No retry. The page does not block approval; the server decides. |
| Editable, defaults | Both selects set, each with the **Default** marker (AC-3.1/3.2). **(changed 2026-11-19, sign-off)** The account select set with its Default marker; the VAT select on **None**, no marker. |
| Editable, changed by hand | The changed half shows **Set by hand** instead of **Default** (AC-3.3). The marker text lives in the field's hint, so a screen reader hears it, not only a sighted user sees its absence. |
| Missing (no default and not classified) **(changed 2026-11-19, sign-off)** (the account only; a VAT code is never missing) | The select shows its placeholder ("Choose an account") and the hint "Required to approve." No error is shown until approval is attempted. |
| Missing after a refused approval | The select has `aria-invalid` and the error "Choose an account." (AC-3.4). Cleared as soon as a value is chosen. |
| Saving | The select that was changed shows "Saving…" beside it and ignores further changes (`aria-busy`; it stays focusable and keeps focus). |
| Saved | A polite live message: "Account set to 5901 — Spese viaggi in treno." The select shows the server's value (the PUT returns the full line; no client-side derivation of amounts). |
| Save refused | The select reverts to the last saved value and a `role="alert"` message under it says why: 422 inactive "That account was deactivated. Choose another." (and the options reload); 403 "You don't have permission to change this classification."; other "Could not change the classification. Try again." A 409 `classification_locked` opens a guardrail dialog "This line is locked" and reloads; other 409s (status changed) open the existing "already decided" guardrail and reload. |
| Current value is inactive | The select shows it as a disabled selected option labelled "(inactive)" and a hint "This account is deactivated. The line keeps it; choose an active one to change it." (AC-1.3, AC-1.6). |
| Exchange rate missing | Rate fact: `StatusBadge` **Rate missing** with "No EUR rate for March 2026. The CHF and VAT amounts need it."; CHF and VAT amounts show "—" (not 0). For users with `settings:read` a link "Open exchange rates" goes to Settings at that month. |
| No VAT code (foreign line, none designated) **(retired 2026-11-19, sign-off)** | VAT amount shows "—" with the select in its Missing state. Now: a line with no VAT code, in any currency, shows None in the select and "No VAT code, so no VAT amount." as its VAT amount. |
| VAT code with rate 0 | VAT amount shows `CHF 0.00` (a real zero, not "—"; AC-6.12 consistency). **(changed 2026-11-19, sign-off)** The zero-rate code is `IP00`; `NOVAT` is retired. |
| Before approval | A hint: "Amounts follow the approved total as it stands now." (the plan's D11). |
| Read-only: user lacks the capability for this state | The values as plain text (a `dl`, markers kept), and "You can view the classification but not change it." |
| Read-only: batch paid (AC-3.7) | The values as plain text, a `lock` icon and "Locked: its batch has been paid." |

### S8 — Approve refusal and release gate (review page)

| State | What the user sees |
|---|---|
| `classification_missing` **(changed 2026-11-19, sign-off)** (account-only title, hint and rows; see the sync, section 3.4) | See F5 step 4: `ErrorSummary` (assertive, one jump link per missing value, text "19.03.2026 · Milan–Lugano return: choose an account"), focus on the first missing select, each panel's own error. If the 409 names a line the page no longer has (a race), the request and the accounting view reload first. |
| `accounting_release_pending` | The approve dialog stays open with "Approvals are not available yet: the accounting setup has not been completed. Ask an administrator." Cancel closes it; Approve can be pressed again. |
| Other 409s | The existing guardrail ("already decided"), unchanged. **They must be told apart by `error.code`**: today any 409 from approve that is not `all_lines_rejected` is shown as "already decided" (Gap G2). |

### S9 — Receipt numbers

- **Line row** (`ExpenseLineRow`, every mode that is not `edit`): in the first row of details, after the date, `MC26/014` in mono with a visually hidden "Receipt number" label. Nothing is shown for an unnumbered line (no dash).
- **Batch page** request rows: a second line under the status and amount, in the list-row meta style: "Receipts MC26/014, MC26/015", wrapping. A row with none shows no line. The row link's accessible name gains the numbers (it overrides the visible text).
- States: only "has numbers" or "has none"; no loading or error state of its own (the numbers arrive with the request and the batch).

### S10 — Accounting export card (batch page)

Placed under the summary card, above the employee groups. Loads on its own and never delays the page. **(changed 2026-11-19, sign-off)** The file is an Excel workbook: the two wireframes below say CSV and "Download CSV" and list "Lines without an account or a VAT code" with "no VAT code" items; the built card says "Excel file" and "Download Excel file" and lists "Lines without an account" (see the sync, section 3.5, and its gap SG-4).

```
Accounting export
One row per approved WellD CH expense line, with account, VAT and CHF amount, as a CSV file.
12 rows will be exported. 3 WellD Italia lines are left out: the export covers WellD CH only.
                                                                  [ Download CSV ]
```

```
Accounting export
 ⚠ The export is blocked
   The file cannot be produced until the items below are resolved. You can still pay or discard this batch.
   Missing exchange rates
     • EUR · March 2026   Open exchange rates
     • USD · March 2026   Open exchange rates
   Lines without an account or a VAT code
     • Matteo Codogno · MC26/014: no VAT code   Open request
   Refund just tried to fetch the missing rates from the official source.
                        [ Check again ]            [ Download CSV ] (disabled)
```

| State | What the user sees |
|---|---|
| Not rendered | Batch *discarded* (AC-6.9). A batch that becomes discarded while the page is open (409 `batch_discarded`) removes the card and says so in a polite live message. |
| Loading | `SkeletonRows` + polite "Checking the export…". The check may call the official source and take several seconds (Gap G6); the card stays in this state, the page does not. |
| Ready | The row count, the WellD Italia line-count sentence **only when it is above zero** (AC-6.6), **Download CSV** **(changed 2026-11-19, sign-off)** (**Download Excel file**). |
| Ready, header only | The same, with "There are no approved WellD CH lines in this batch. The file will contain only the header row." (AC-6.7). |
| Blocked | `Banner tone="warning" live="off"` with the intro, then the lists that apply, **Check again** (the banner's retry), and Download `aria-disabled` with a description "The export is blocked. See the items above." Lists: *Missing exchange rates* (AC-6.5, each currency and month, with a Settings link only when the user holds `settings:read`; otherwise the text "Ask an administrator to enter or fetch it."), *Lines without an account or a VAT code* **(changed 2026-11-19, sign-off)** (*Lines without an account*) (AC-7.2, employee, receipt number, what is missing, "Open request"), *Lines without a receipt number* (should not occur; one sentence "Contact an administrator."). When `fetchAttempted` is true the sentence "Refund just tried to fetch the missing rates from the official source." is added. |
| Load failed | `ErrorBanner` with Retry, inside the card. |
| Out of scope (403 `accounting_export_out_of_scope`, AC-6.11) | `Banner tone="info" live="off"`: "The accounting export is available to reviewers with WellD CH access." No button. |
| Downloading | Button `busy` with "Preparing file…"; a second press is ignored. |
| Downloaded | Compact auto-dismissing success banner "Export downloaded: 12 rows." |
| Became blocked between check and download (409 `accounting_export_blocked`) | The card switches to the Blocked state with the blockers from the response, plus an `alert` "The export became blocked while you were downloading. See the items below." |
| No file produced (500, including a failed log write) | Inline `role="alert"` next to the button: "No file was produced. Try again." |

## Component inventory

Library in use: **`@operai/ui`** (the suite's shared design system, `operai-ui/`; ADR 20261031-shared-ui-library-consumed-as-source), consumed by `refund-ui` with Tailwind token utilities for layout (per `AGENTS.md`, `docs/design-system.md` now only points there). No Mantine, no MUI. `R` = reuse, `N` = NEW (with the reason nothing fits). `refund-ui/src/components/...` are in-repo components.

| # | Element | Component | R/N |
|---|---|---|---|
| 1 | Settings views switch | `Tabs` + `tabPanelProps` (`@operai/ui`) | R |
| 2 | Page header | `PageHeader` (unchanged) | R |
| 3 | One section per card | `Card` | R |
| 4 | Card loading | `SkeletonRows` + `VisuallyHidden live` | R |
| 5 | Card load failure | `refund-ui/src/components/ErrorBanner.tsx` | R |
| 6 | Success confirmations | `refund-ui/src/components/SuccessBanner.tsx` | R |
| 7 | Accounts list | `DataTable` | R |
| 8 | VAT codes list | `DataTable` | R |
| 9 | Active / Inactive badge | `StatusBadge`; two entries added to `lib/statusMeaning.ts` (`active`→`active`, `inactive`→`voided`) | R |
| 10 | Empty lists | `StatePanel` (as the rates card does) | R |
| 11 | Deactivate confirm | `refund-ui/src/components/ConfirmDeleteModal.tsx` with `tone="positive"` and its own title/body/labels (the `ApproveDialog` precedent) | R |
| 12 | Reactivate, Fetch now, Correct, Download, Change, History | `Button` (`secondary`/`ghost`, `sm`; icon-only with `aria-label` for Correct) | R |
| 13 | Defaults table | `DataTable` | R |
| 14 | Foreign-currency VAT code value **(retired 2026-11-19, sign-off)** | `FactList` | R |
| 15 | Exchange-rate table | `DataTable` | R |
| 16 | Rate origin | `Badge` (neutral *Fetched*, accent *Corrected*) | R |
| 17 | Missing rate / rate missing | `StatusBadge status="attention"` (the dictionary's "needs someone, nothing failed") | R |
| 18 | Last-fetch failure, blocked export | `Banner tone="warning"` with `live="polite"` / `"off"` | R |
| 19 | Fetch result, scope note, switched-off note | `Banner tone="info"` / `SuccessBanner` | R |
| 20 | Field label, hint, error | `Field` | R |
| 21 | Rate and VAT-rate input | `MoneyInput` + `parseDecimal(text, 6)` | R |
| 22 | Default / Set by hand marker | `Badge` | R |
| 23 | Amount, rate, VAT figures | `FactList` (`dl`) with `formatMoney` / `formatNumber`; figures in `font-mono` | R |
| 24 | Locked marker | `Icon name="lock"` + text | R |
| 25 | Refused approval | `ErrorSummary` | R |
| 26 | Approve dialog | `refund-ui/src/components/ApproveDialog.tsx` (unchanged; one more error message) | R |
| 27 | Locked / state-changed 409 | `refund-ui/src/components/GuardrailDialog.tsx` (new copy) | R |
| 28 | Panel and export loading | `Skeleton` / `SkeletonRows` | R |
| 29 | A line row | `refund-ui/src/components/ExpenseLineRow.tsx`: add a `footer` slot prop (the page puts the panel there) and the receipt number in the details row | R (extend) |
| 30 | Batch request rows | `refund-ui/src/components/BatchEmployeeGroupList.tsx`: add the numbers line and extend `openRequestLabel` | R (extend) |
| 31 | Export download | The Blob pattern of `refund-ui/src/components/RequestExportLink.tsx` (a `<button>`, bytes through `apiFetch`, object URL revoked at once); `BatchPdfLink` is *not* the model (short-lived signed URL, and its 📄 emoji breaks INC-31 — left alone, not copied) | R (pattern) |
| 32 | Links to Settings / request | TanStack `Link className="link"` | R |
| 33 | Month label | `formatMonth` added to `operai-ui/src/lib/format.ts` (+ story/test + changeset) | N — the library formats days and instants only (UX-10) |
| 34 | `LedgerAccountsCard` **(moved 2026-11-19 to the Accounting app)** | composition of #3 #4 #5 #7 #10 | N — no equivalent card; built entirely from reused parts |
| 35 | `VatCodesCard` **(moved 2026-11-19 to the Accounting app)** | same | N |
| 36 | `ExpenseTypeDefaultsCard` | composition of #13 #14 | N |
| 37 | `ExchangeRatesCard` **(moved 2026-11-19 to the Accounting app)** | composition of #15 #16 #17 #18 | N |
| 38 | `AddLedgerAccountDialog`, `AddVatCodeDialog` **(moved 2026-11-19 to the Accounting app)** | `FormDialog` + `Field`, modelled on `AddRateEntryModal` | N — different fields and errors; `AddRateEntryModal` is mileage-specific |
| 39 | `DefaultClassificationDialog`, `ForeignCurrencyVatDialog` **(retired 2026-11-19, sign-off)** (deleted) | `FormDialog` + two / one `CatalogSelect` | N — different fields |
| 40 | `RateCorrectionDialog` **(moved 2026-11-19 to the Accounting app)** | `FormDialog` + `MoneyInput`, per `AddRateEntryModal` | N — different field and copy |
| 41 | `CatalogSelect` | one native `<select>` that renders account / VAT options number-first, a "None" or placeholder option, and an inactive current value as a disabled selected option | N — the same control is needed in four places (two dialogs, the panel, and its read-only form); no library control does the inactive-current case |
| 42 | `ChangeHistoryDrawer` | `Drawer` + `DataTable` | N — three uses, none exists; `VersionTable` is for restorable versions and carries Restore |
| 43 | `LineClassificationPanel` | `fieldset` + #20 #22 #23 #41 | N — the feature's core surface |
| 44 | `ReceiptNumber` | a mono `span` with a visually hidden label | N — one rule, three call sites |
| 45 | `AccountingExportCard` | `Card` + #18 #19 #28 + #31 | N — the batch page has no export surface |
| 46 | `useLoadedResource(loader, enabled)` | one hook returning `loading / loaded / error / forbidden`, written with the Promise-chain style the lint rule needs | N — five new cards would each repeat the 40-line effect of `SettingsPage`; the existing sections are left as they are |
| 47 | API modules | `lib/accountingApi.ts`, `lib/exchangeRatesApi.ts`, `lib/accountingExportApi.ts` (typed, on `getJson` / `sendJson`) | N — no code to reuse beyond the plumbing |

**Reuse ratio: 32 reuse (incl. 3 extend/pattern) : 15 NEW.** Four of the NEW rows are page-section cards that only compose reused parts, so the genuinely new building blocks are `CatalogSelect`, `ChangeHistoryDrawer`, `LineClassificationPanel`, `ReceiptNumber`, `AccountingExportCard`, `useLoadedResource`, the dialogs and `formatMonth`. No new colour, token, icon, or library component beyond `formatMonth`.

Status meanings added to the one map `lib/statusMeaning.ts`: catalog *Active* → `active`, *Inactive* → `voided`; a missing rate → `attention`. Rate origin is metadata, not a status, so it is a `Badge`.

### Copy keys (`refund-ui/src/strings.ts`)

Convention: one catalog per language, `en` first and `it: typeof en`, a sentence with a value in it is a **function**, sentence case, Italian in the impersonal form the file already uses ("Impossibile…", "Inserire…", "Riprovare."). New keys go in `settings` (extended), `pages.reviewDetail.classification` (new), `pages.requestDetail.lines` (one key), `pages.batchDetail.accountingExport` (new) and `pages.batchDetail` (one key). `strings.parity.test.ts` must stay green, and every new `.tsx` is subject to `noHardcodedStrings.test.ts`. `n === 1` plurals are written inside the function.

**Settings: sections and shared**

| Key (`settings.`) | EN | IT |
|---|---|---|
| `sections.label` | Settings sections | Sezioni delle impostazioni |
| `sections.general` | General | Generale |
| `sections.accounting` **(moved 2026-11-19 to the Accounting app)** | Accounts and VAT | Conti e IVA |
| `sections.exchangeRates` **(moved 2026-11-19 to the Accounting app)** | Exchange rates | Tassi di cambio |
| `catalog.status.active` | Active | Attivo |
| `catalog.status.inactive` | Inactive | Disattivato |
| `catalog.forbidden` | You don't have permission to do this. | Non si dispone dei permessi per questa operazione. |
| `catalog.genericError` | Could not save. Try again. | Impossibile salvare. Riprovare. |
| `catalog.cancel` | Cancel | Annulla |
| `catalog.close` | Close | Chiudi |
| `catalog.none` | None | Nessuno |
| `catalog.inactiveTag` | Inactive | Disattivato |
| `history.title(subject)` | `History — ${subject}` | `Cronologia — ${subject}` |
| `history.description` | Every change, newest first. | Tutte le modifiche, dalla più recente. |
| `history.empty` | No changes recorded yet. | Ancora nessuna modifica registrata. |
| `history.columns.when / by` | When / By | Quando / Da |
| `history.open` | History | Cronologia |
| `history.openLabel(subject)` | `Show the history of ${subject}` | `Mostra la cronologia di ${subject}` |

**Settings: ledger accounts** **(moved 2026-11-19 to the Accounting app)** (the keys left `refund-ui/src/strings.ts` for `accounting-ui/src/strings.ts`)

| Key (`settings.accounts.`) | EN | IT |
|---|---|---|
| `title` | Ledger accounts | Conti contabili |
| `description` | The accounts of the WellD CH chart of accounts that refunds may be booked to. | I conti del piano dei conti di WellD CH su cui si possono registrare i rimborsi. |
| `caption` | WellD CH ledger accounts | Conti contabili di WellD CH |
| `loading` / `loadError` | Loading ledger accounts… / Could not load the ledger accounts. | Caricamento dei conti contabili… / Impossibile caricare i conti contabili. |
| `empty.title` / `empty.body` | No ledger accounts yet / Add the accounts that refunds are booked to. | Ancora nessun conto contabile / Aggiungere i conti su cui si registrano i rimborsi. |
| `columns.number / name / status / added / actions` | Number / Name / Status / Added / Actions | Numero / Nome / Stato / Aggiunto / Azioni |
| `addedBy(by, on)` | `${by} · ${on}` | `${by} · ${on}` |
| `add` | Add account | Aggiungi conto |
| `addDialog.title` | Add ledger account | Aggiungi conto contabile |
| `addDialog.description` | The number and name cannot be edited later. An account can be deactivated and reactivated. | Numero e nome non possono essere modificati in seguito. Un conto può essere disattivato e riattivato. |
| `addDialog.number` / `numberHint` | Account number / For example 5905 or 2620.1 | Numero del conto / Per esempio 5905 o 2620.1 |
| `addDialog.name` | Account name | Nome del conto |
| `addDialog.busy` | Adding… | Aggiunta… |
| `errors.numberInvalid` | Enter an account number such as 5905 or 2620.1. | Inserire un numero di conto come 5905 o 2620.1. |
| `errors.nameRequired` | Enter a name of up to 120 characters. | Inserire un nome di al massimo 120 caratteri. |
| `errors.duplicate(number)` | `Account ${number} already exists.` | `Il conto ${number} esiste già.` |
| `errors.duplicateInactive(number)` | `Account ${number} already exists but is deactivated. Reactivate it from the list.` | `Il conto ${number} esiste già ma è disattivato. Riattivarlo dall’elenco.` |
| `errors.alreadyActive(number)` | `Account ${number} is already active.` | `Il conto ${number} è già attivo.` |
| `errors.alreadyInactive(number)` | `Account ${number} is already deactivated.` | `Il conto ${number} è già disattivato.` |
| `added(number)` / `deactivated(number)` / `reactivated(number)` | `Account ${number} added` / `…deactivated` / `…reactivated` | `Conto ${number} aggiunto` / `…disattivato` / `…riattivato` |
| `deactivate` / `reactivate` | Deactivate / Reactivate | Disattiva / Riattiva |
| `deactivateLabel(number)` / `reactivateLabel(number)` | `Deactivate account ${number}` / `Reactivate account ${number}` | `Disattiva il conto ${number}` / `Riattiva il conto ${number}` |
| `deactivateDialog.title(number)` | `Deactivate account ${number}?` | `Disattivare il conto ${number}?` |
| `deactivateDialog.body` | It can no longer be chosen as a default or on a line. Lines already classified with it keep it. An expense type that uses it as its default will have no default until you choose another. You can reactivate it at any time. | Non potrà più essere scelto come predefinito né su una riga. Le righe già classificate con questo conto lo mantengono. Un tipo di spesa che lo usa come predefinito resterà senza predefinito finché non se ne sceglie un altro. Si può riattivare in qualsiasi momento. |
| `deactivateDialog.confirm` / `busy` | Deactivate / Deactivating… | Disattiva / Disattivazione… |

**Settings: VAT codes** **(moved 2026-11-19 to the Accounting app)** (`settings.vatCodes.`, same shape as accounts; only the differing keys)

| Key | EN | IT |
|---|---|---|
| `title` / `description` | VAT codes / The VAT codes refunds may use. Each carries one fixed rate. | Codici IVA / I codici IVA utilizzabili nei rimborsi. Ognuno ha un’aliquota fissa. |
| `caption` | WellD CH VAT codes | Codici IVA di WellD CH |
| `columns.code / label / rate` | Code / Label / VAT rate | Codice / Descrizione / Aliquota IVA |
| `add` | Add VAT code | Aggiungi codice IVA |
| `addDialog.title` | Add VAT code | Aggiungi codice IVA |
| `addDialog.description` | The rate cannot be changed later: a new rate needs a new code. | L’aliquota non può essere modificata in seguito: una nuova aliquota richiede un nuovo codice. |
| `addDialog.code` / `codeHint` | Code / Letters, digits, - and _ (up to 16). Saved in capitals. | Codice / Lettere, cifre, - e _ (fino a 16). Salvato in maiuscolo. |
| `addDialog.label` | Label | Descrizione |
| `addDialog.rate` / `rateHint` | VAT rate (%) / Between 0 and 100, up to 2 decimals. | Aliquota IVA (%) / Tra 0 e 100, fino a 2 decimali. |
| `errors.codeInvalid` | Enter a code of letters, digits, - or _ (up to 16). | Inserire un codice di lettere, cifre, - o _ (fino a 16). |
| `errors.labelRequired` | Enter a label of up to 80 characters. | Inserire una descrizione di al massimo 80 caratteri. |
| `errors.rateInvalid` | Enter a rate between 0 and 100, with up to 2 decimals. | Inserire un’aliquota tra 0 e 100, con al massimo 2 decimali. |
| `errors.duplicate(code)` / `duplicateInactive(code)` | `VAT code ${code} already exists.` / `…exists but is deactivated. Reactivate it from the list.` | `Il codice IVA ${code} esiste già.` / `…esiste già ma è disattivato. Riattivarlo dall’elenco.` |
| `errors.alreadyActive(code)` / `alreadyInactive(code)` | `VAT code ${code} is already active.` / `…already deactivated.` | `Il codice IVA ${code} è già attivo.` / `…già disattivato.` |
| `added/deactivated/reactivated(code)` | `VAT code ${code} added` / … | `Codice IVA ${code} aggiunto` / … |
| `deactivateDialog.body` | It can no longer be chosen as a default, as the foreign-currency VAT code or on a line. Lines already classified with it keep it. Its rate never changes. You can reactivate it at any time. | Non potrà più essere scelto come predefinito, come codice IVA per le valute estere né su una riga. Le righe già classificate lo mantengono. La sua aliquota non cambia mai. Si può riattivare in qualsiasi momento. |
| `rateValue(rate)` | formatted with `formatNumber` as a percent, e.g. `8.1%` | `8,1%` |

**Settings: defaults** (`settings.defaults.`)

| Key | EN | IT |
|---|---|---|
| `title` | Default classification | Classificazione predefinita |
| `description` **(retired 2026-11-19, sign-off)** (now `descriptionAccountOnly`) | The account and VAT code each expense type gets in WellD CH. Accounting can change them line by line. Where a type has no default, accounting must choose on each line before approving. | Il conto e il codice IVA assegnati a ogni tipo di spesa in WellD CH. La contabilità può cambiarli riga per riga. Dove un tipo non ha un predefinito, la contabilità deve sceglierlo su ogni riga prima di approvare. |
| `caption` | Default classification by expense type | Classificazione predefinita per tipo di spesa |
| `columns.type / account / vatCode / changed / actions` (`vatCode` **(retired 2026-11-19, sign-off)**) | Expense type / Default account / Default VAT code / Last changed / Actions | Tipo di spesa / Conto predefinito / Codice IVA predefinito / Ultima modifica / Azioni |
| `notSet` | Not set yet | Mai impostato |
| `change` / `changeLabel(type)` | Change / `Change the default for ${type}` | Modifica / `Modifica il predefinito di ${type}` |
| `dialog.title(type)` | `Default classification — ${type}` | `Classificazione predefinita — ${type}` |
| `dialog.description` | Applies to lines reviewed from now on. Lines already approved keep what they have. | Vale per le righe esaminate da ora in poi. Le righe già approvate mantengono quanto hanno. |
| `dialog.account` / `dialog.vatCode` (`dialog.vatCode` **(retired 2026-11-19, sign-off)**) | Default account / Default VAT code | Conto predefinito / Codice IVA predefinito |
| `dialog.noneOption` / `chooseOption` | None (no default) / Choose… | Nessuno (nessun predefinito) / Scegliere… |
| `dialog.inactiveCurrent(what)` | `The current ${what} is deactivated. Choose another, or none.` | `Il valore attuale (${what}) è disattivato. Sceglierne un altro, oppure nessuno.` |
| `dialog.save` / `busy` | Save / Saving… | Salva / Salvataggio… |
| `saved(type)` | `Default saved for ${type}` | `Predefinito salvato per ${type}` |
| `errors.accountInactive` / `vatInactive` (`vatInactive` **(retired 2026-11-19, sign-off)**) | That account has been deactivated. Choose another. / That VAT code has been deactivated. Choose another. | Questo conto è stato disattivato. Sceglierne un altro. / Questo codice IVA è stato disattivato. Sceglierne un altro. |
| `foreign.term` **(retired 2026-11-19, sign-off)** | VAT code for foreign-currency lines | Codice IVA per le righe in valuta estera |
| `foreign.description` **(retired 2026-11-19, sign-off)** | WellD CH lines in a currency other than CHF get this code by default. | Le righe WellD CH in una valuta diversa dal CHF ricevono questo codice per impostazione predefinita. |
| `foreign.none` **(retired 2026-11-19, sign-off)** | None designated | Nessuno designato |
| `foreign.inactiveWarning(code)` **(retired 2026-11-19, sign-off)** | `${code} is deactivated, so foreign-currency lines get no VAT code until you designate another.` | `${code} è disattivato: le righe in valuta estera non hanno un codice IVA finché non se ne designa un altro.` |
| `foreign.dialogTitle` **(retired 2026-11-19, sign-off)** | VAT code for foreign-currency lines | Codice IVA per le righe in valuta estera |
| `foreign.saved` **(retired 2026-11-19, sign-off)** | Foreign-currency VAT code saved | Codice IVA per le valute estere salvato |
| `foreign.historyLabel` **(retired 2026-11-19, sign-off)** | the foreign-currency VAT code | il codice IVA per le valute estere |

**Settings: exchange rates** **(moved 2026-11-19 to the Accounting app)** (`settings.fx.`)

| Key | EN | IT |
|---|---|---|
| `title` | Monthly exchange rates | Tassi di cambio mensili |
| `description` | CHF for 1 unit of the foreign currency, monthly average. Used for the CHF amount in the accounting export. | CHF per 1 unità di valuta estera, media mensile. Usati per l’importo in CHF nell’esportazione contabile. |
| `caption` | Monthly average exchange rates | Tassi di cambio medi mensili |
| `loading` / `loadError` | Loading exchange rates… / Could not load the exchange rates. | Caricamento dei tassi di cambio… / Impossibile caricare i tassi di cambio. |
| `empty.title` / `empty.body` | No months to show yet / No completed month has rates to show. | Ancora nessun mese da mostrare / Nessun mese concluso ha tassi da mostrare. |
| `columns.month` | Month | Mese |
| `origin.fetched` / `corrected` | Fetched / Corrected | Recuperato / Corretto |
| `missing` | Missing | Mancante |
| `correct` | Correct | Correggi |
| `correctLabel(currency, month)` | `Correct the ${currency} rate for ${month}` | `Correggi il tasso ${currency} di ${month}` |
| `cellLabel(currency, month, rate, origin)` | `${currency}, ${month}: ${rate}, ${origin}` | `${currency}, ${month}: ${rate}, ${origin}` |
| `fetchNow` / `fetching` | Fetch now | Recupera ora |
| `checking` | Checking for new rates… | Verifica di nuovi tassi… |
| `fetchedOk(n)` | `n===1`: Recorded the rates for 1 month. else: `Recorded the rates for ${n} months.` | `Registrati i tassi di 1 mese.` / `Registrati i tassi di ${n} mesi.` |
| `nothingNew` | No new rates to record. | Nessun nuovo tasso da registrare. |
| `notFetchable(month)` | `The rates for ${month} are not published yet.` | `I tassi di ${month} non sono ancora pubblicati.` |
| `disabled` | Automatic fetching is turned off in this environment. Enter the rates by hand. | Il recupero automatico è disattivato in questo ambiente. Inserire i tassi a mano. |
| `lastFetch.term` | Last fetch | Ultimo recupero |
| `lastFetch.never` | No fetch yet | Ancora nessun recupero |
| `lastFetch.ok(at)` | `${at} — succeeded` | `${at} — riuscito` |
| `lastFetch.failedTitle` | The last fetch failed | L’ultimo recupero non è riuscito |
| `lastFetch.failedBody(at, reason)` | `On ${at}: ${reason}. The rates already recorded are unchanged.` | `Il ${at}: ${reason}. I tassi già registrati non sono cambiati.` |
| `reason.timeout` | the official source did not answer in time | la fonte ufficiale non ha risposto in tempo |
| `reason.http` | the official source returned an error | la fonte ufficiale ha restituito un errore |
| `reason.parse` | the answer could not be read | non è stato possibile leggere la risposta |
| `reason.monthMismatch` | the answer was for a different month | la risposta riguardava un altro mese |
| `reason.currencyMissing` | a currency was missing from the answer | mancava una valuta nella risposta |
| `reason.unknown` | an unknown error occurred | si è verificato un errore sconosciuto |
| `correction.title(currency, month)` | `Correct rate — ${currency} · ${month}` | `Correggi tasso — ${currency} · ${month}` |
| `correction.description` | The previous value stays in the history. A batch exported before this correction will export differently if it is exported again. | Il valore precedente resta nella cronologia. Un lotto esportato prima di questa correzione darà un risultato diverso se esportato di nuovo. |
| `correction.rate(currency)` | `Rate (CHF per 1 ${currency})` | `Tasso (CHF per 1 ${currency})` |
| `correction.inEffect(rate, origin)` | `In effect: ${rate} (${origin})` | `In vigore: ${rate} (${origin})` |
| `correction.rateInvalid` | Enter a rate greater than 0, with up to 6 decimals. | Inserire un tasso maggiore di 0, con al massimo 6 decimali. |
| `correction.monthNotCompleted` | This month is not finished yet; its rate cannot be corrected. | Questo mese non è ancora concluso: il suo tasso non può essere corretto. |
| `correction.save` / `busy` | Save correction / Saving… | Salva correzione / Salvataggio… |
| `correction.saved(currency, month)` | `${currency} rate for ${month} corrected` | `Tasso ${currency} di ${month} corretto` |
| `history.rateColumn` / `originColumn` | Rate / Origin | Tasso / Origine |

**Review page: classification** (`pages.reviewDetail.classification.`)

| Key | EN | IT |
|---|---|---|
| `legend` | Classification | Classificazione |
| `groupLabel(line)` | `Classification for ${line}` | `Classificazione per ${line}` |
| `account` / `vatCode` | Account / VAT code | Conto / Codice IVA |
| `chooseAccount` / `chooseVatCode` (`chooseVatCode` **(retired 2026-11-19, sign-off)**) | Choose an account / Choose a VAT code | Scegliere un conto / Scegliere un codice IVA |
| `accountOption(number, name)` | `${number} — ${name}` | `${number} — ${name}` |
| `vatOption(code, label, rate)` | `${code} — ${label} (${rate})` | `${code} — ${label} (${rate})` |
| `inactiveOption(text)` | `${text} (inactive)` | `${text} (disattivato)` |
| `defaultMarker` / `handMarker` | Default / Set by hand | Predefinito / Impostato a mano |
| `required` | Required to approve. | Obbligatorio per approvare. |
| `missingAccount` / `missingVatCode` (`missingVatCode` **(retired 2026-11-19, sign-off)**) | Choose an account. / Choose a VAT code. | Scegliere un conto. / Scegliere un codice IVA. |
| `inactiveCurrentAccount` | This account is deactivated. The line keeps it; choose an active one to change it. | Questo conto è disattivato. La riga lo mantiene; sceglierne uno attivo per cambiarlo. |
| `inactiveCurrentVat` | This VAT code is deactivated. The line keeps it; choose an active one to change it. | Questo codice IVA è disattivato. La riga lo mantiene; sceglierne uno attivo per cambiarlo. |
| `rate` | Exchange rate | Tasso di cambio |
| `rateValue(rate, month)` | `${rate} · ${month}` | `${rate} · ${month}` |
| `rateMissing` | Rate missing | Tasso mancante |
| `rateMissingHelp(currency, month)` | `No ${currency} rate for ${month}. The CHF and VAT amounts need it.` | `Nessun tasso ${currency} per ${month}. Servono per gli importi in CHF e IVA.` |
| `openRates` | Open exchange rates | Apri i tassi di cambio |
| `chfAmount` / `vatAmount` | CHF amount / VAT amount | Importo in CHF / Importo IVA |
| `vatAmountValue(amount, rate)` | `${amount} (${rate})` | `${amount} (${rate})` |
| `unavailable` | — | — |
| `follows` | Amounts follow the approved total as it stands now. | Gli importi seguono il totale approvato attuale. |
| `saving` | Saving… | Salvataggio… |
| `savedAccount(text)` / `savedVat(text)` | `Account set to ${text}` / `VAT code set to ${text}` | `Conto impostato su ${text}` / `Codice IVA impostato su ${text}` |
| `saveError` | Could not change the classification. Try again. | Impossibile modificare la classificazione. Riprovare. |
| `forbidden` | You don't have permission to change this classification. | Non si dispone dei permessi per modificare questa classificazione. |
| `accountInactive` / `vatInactive` | That account was deactivated. Choose another. / That VAT code was deactivated. Choose another. | Questo conto è stato disattivato. Sceglierne un altro. / Questo codice IVA è stato disattivato. Sceglierne un altro. |
| `locked` | Locked: its batch has been paid. | Bloccata: il lotto è stato pagato. |
| `readOnly` | You can view the classification but not change it. | È possibile vedere la classificazione ma non modificarla. |
| `loading` / `loadError` | Loading classification… / Could not load the classification. | Caricamento della classificazione… / Impossibile caricare la classificazione. |
| `unavailable404` | The classification is not available for this request. | La classificazione non è disponibile per questa richiesta. |
| `lockedGuardrail.title` / `message` | This line is locked / Its batch has been paid, so the classification can no longer change. | Questa riga è bloccata / Il suo lotto è stato pagato: la classificazione non può più cambiare. |
| `missingSummary.title(n)` **(retired 2026-11-19, sign-off)** (now `titleAccounts(n)`) | `n===1`: Nothing was approved. 1 value needs your attention. else `…${n} values need your attention.` | `Non è stato approvato nulla. 1 valore richiede attenzione.` / `…${n} valori richiedono attenzione.` |
| `missingSummary.hint` **(retired 2026-11-19, sign-off)** (now `hintAccounts`) | Choose the missing values, then approve again. | Scegliere i valori mancanti, poi approvare di nuovo. |
| `missingSummary.account(line)` / `vatCode(line)` (`vatCode(line)` **(retired 2026-11-19, sign-off)**) | `${line}: choose an account` / `${line}: choose a VAT code` | `${line}: scegliere un conto` / `${line}: scegliere un codice IVA` |
| `releasePending` | Approvals are not available yet: the accounting setup has not been completed. Ask an administrator. | Le approvazioni non sono ancora disponibili: la configurazione contabile non è stata completata. Rivolgersi a un amministratore. |

**Receipt numbers and the export card**

| Key | EN | IT |
|---|---|---|
| `pages.requestDetail.lines.receiptNumberLabel` | Receipt number | Numero ricevuta |
| `pages.batchDetail.receiptNumbers(list)` | `Receipts ${list}` | `Ricevute ${list}` |
| `components.batchEmployeeGroupList.openRequestLabel(owner, status, amount, receipts?)` | extended with `, receipts ${receipts}` when present | esteso con `, ricevute ${receipts}` se presenti |
| `…accountingExport.title` | Accounting export | Esportazione contabile |
| `…description` **(retired 2026-11-19, sign-off)** (now `descriptionExcel`) | One row per approved WellD CH expense line, with account, VAT and CHF amount, as a CSV file. | Una riga per ogni spesa WellD CH approvata, con conto, IVA e importo in CHF, in un file CSV. |
| `…loading` / `loadError` | Checking the export… / Could not check the export. | Verifica dell’esportazione… / Impossibile verificare l’esportazione. |
| `…rows(n)` | `n===1`: 1 row will be exported. else `${n} rows will be exported.` | `Verrà esportata 1 riga.` / `Verranno esportate ${n} righe.` |
| `…headerOnly` | There are no approved WellD CH lines in this batch. The file will contain only the header row. | Nel lotto non ci sono righe WellD CH approvate. Il file conterrà solo la riga di intestazione. |
| `…excluded(n)` | `n===1`: 1 WellD Italia line is left out: the export covers WellD CH only. else `${n} WellD Italia lines are left out: …` | `1 riga WellD Italia è esclusa: l’esportazione riguarda solo WellD CH.` / `${n} righe WellD Italia sono escluse: …` |
| `…download` **(retired 2026-11-19, sign-off)** (now `downloadExcel`) / `downloading` | Download CSV / Preparing file… | Scarica CSV / Preparazione del file… |
| `…downloadLabel(batchId)` | `Download the accounting export of batch ${batchId}` | `Scarica l’esportazione contabile del lotto ${batchId}` |
| `…downloaded(n)` | `Export downloaded: ${n} rows` | `Esportazione scaricata: ${n} righe` |
| `…blocked.title` | The export is blocked | L’esportazione è bloccata |
| `…blocked.intro` | The file cannot be produced until the items below are resolved. You can still pay or discard this batch. | Il file non può essere prodotto finché le voci seguenti non sono risolte. Il lotto può comunque essere pagato o scartato. |
| `…blocked.reason` | The export is blocked. See the items above. | L’esportazione è bloccata. Vedere le voci qui sopra. |
| `…blocked.missingRates` | Missing exchange rates | Tassi di cambio mancanti |
| `…blocked.rateItem(currency, month)` | `${currency} · ${month}` | `${currency} · ${month}` |
| `…blocked.askAdmin` | Ask an administrator to enter or fetch it. | Chiedere a un amministratore di inserirlo o recuperarlo. |
| `…blocked.fetchTried` | Refund just tried to fetch the missing rates from the official source. | Rimborsi ha appena provato a recuperare i tassi mancanti dalla fonte ufficiale. |
| `…blocked.unclassified` **(retired 2026-11-19, sign-off)** (now `unclassifiedAccounts`) | Lines without an account or a VAT code | Righe senza conto o senza codice IVA |
| `…blocked.unclassifiedItem(employee, receipt, missing)` | `${employee} · ${receipt}: no ${missing}` | `${employee} · ${receipt}: manca ${missing}` |
| `…blocked.missingWhat.account / vatCode / both` (`vatCode` and `both` **(retired 2026-11-19, sign-off)**) | account / VAT code / account or VAT code | il conto / il codice IVA / il conto o il codice IVA |
| `…blocked.openRequest` | Open request | Apri richiesta |
| `…blocked.unnumbered` | Lines without a receipt number | Righe senza numero di ricevuta |
| `…blocked.unnumberedBody` | Contact an administrator. | Rivolgersi a un amministratore. |
| `…blocked.checkAgain` | Check again | Verifica di nuovo |
| `…blocked.turnedBlocked` | The export became blocked while you were downloading. See the items below. | L’esportazione si è bloccata durante il download. Vedere le voci qui sotto. |
| `…downloadError` | No file was produced. Try again. | Nessun file è stato prodotto. Riprovare. |
| `…denied` | The accounting export is available to reviewers with WellD CH access. | L’esportazione contabile è disponibile ai revisori con accesso a WellD CH. |
| `…discardedAnnouncement` | This batch has been discarded; the export is no longer available. | Questo lotto è stato scartato: l’esportazione non è più disponibile. |

Month names in the keys above come from `formatMonth`; amounts from `formatMoney` / `formatAmount`; dates from `lib/dates.ts`; percents from `formatNumber`. None is typed by hand.

## Accessibility

**Per screen**

- **Settings tabs (S1).** `Tabs` is a real tablist: one tab stop, arrow keys, Home/End; each panel is paired with `tabPanelProps`. Changing the view updates the URL with `replace`, so Back does not walk through tab clicks. Only the active panel is mounted.
- **Catalog tables (S2, S3).** `DataTable` supplies the caption, `scope`, and the keyboard-scrollable region. Row actions are named after their row ("Deactivate account 5905"). After Deactivate or Reactivate focus moves to the row header (`focusRowKey`), not to `<body>`, since the pressed button was replaced. Status is a badge with a glyph **and** text, never colour alone.
- **Dialogs (S6).** All through `FormDialog` / `ConfirmDialog`: modal, labelled, Tab trapped, Escape and × close except when busy, focus back on the opener. After success the opener (Add, Change, Correct) takes focus, as the mileage-rate dialog already does. Required fields use the `*` plus `aria-required` of `Field`; no "(required)" text. A failed submit moves focus to the first invalid field, the error being in the field's own `aria-describedby`.
- **Defaults table (S4).** "None" is real text, not an empty cell. An inactive reference is announced by its text badge. The Change and History buttons are named after the expense type, because twelve identical "Change" buttons would be unusable by their role list. **(changed 2026-11-19, sign-off)** Fourteen types now, one "Change" and one "History" each.
- **History drawer (S6e).** Focus moves to the heading on open and back on close (`Drawer`). Dates are `<time dateTime>` through `formatDateTime`.
- **Exchange-rate table (S5).** One header cell per currency; each cell's text reads "EUR, March 2026: 0.9246, Fetched" (through the cell's accessible name), the icon-only **Correct** button has an `aria-label` naming currency and month. 33-odd small buttons make long tab sequences: the table is in a scroll region that is focusable, and the buttons are in DOM order row by row. A *Missing* cell is a badge with the attention glyph **and** the word. Auto-fetch results go to a polite live region and never move focus. The persistent failure banner is `role="status"` (`live="polite"`), not `alert`: it is not time-critical and it is still there when the user reaches it.
- **Classification panel (S7).** The group is a `fieldset` named for its line, so a screen-reader user entering "Account" knows which of many lines it belongs to (the same reasoning as the approved-total input's row-specific `aria-label`). Labels are visible `Field` labels; the **Default / Set by hand** marker is in the field's hint so it is announced. **(changed 2026-11-19, sign-off)** Only the account carries a marker; the VAT select is not `required`, offers None and has no marker. A select that is saving keeps focus and is `aria-busy` (it is not `disabled`, which would drop focus). A save is confirmed in one polite live region per page; a refusal is a `role="alert"` under the select. The inactive current option is `disabled` but selected so the control still shows the truth. All figures are text in a `dl` with `font-mono`; a missing figure is "—" with the reason beside it, never an empty box.
- **Approve refusal (S8).** The `ErrorSummary` is assertive and announced once when it appears; focus is moved to the first missing select by the page, and the summary's buttons are the second way in (design-system § Refused save). Each missing select carries `aria-invalid` and the same sentence as the summary item.
- **Receipt numbers (S9).** The number is text with a visually hidden "Receipt number" label; on the batch page the link's `aria-label` includes the numbers because an `aria-label` replaces the visible text.
- **Export card (S10).** The check runs under a polite "Checking the export…" and the card does not steal focus when it resolves. **Blocked** is a `Banner` with `live="off"` and the lists are real `<ul>`s, so the content is read in place; the Download button is `aria-disabled` and described by the reason (`aria-describedby`), because it must stay focusable to explain itself. The result of a download is a compact success banner (`role="status"`); a failure is `role="alert"` beside the button. The busy state keeps the label readable ("Preparing file…").

**Cross-cutting**

- **Headings.** One h2 per page (`PageHeader`), h3 for each card, h4 only for the state panels inside a card, as the existing rates card does. The history drawer's title is its own dialog heading.
- **Contrast.** Only tokens: `text-soft` for secondary text, `text-org-text` / `text-red-text` / `text-grn-text` for toned text, never `text-muted` and never the bare `text-org` / `text-red`. Nothing here needs a new token. Check both themes in Storybook for the one new library piece (`formatMonth` has no visual).
- **Reflow at 320 px.** Cards stack; the classification grid collapses to one column; the rates and defaults tables scroll inside their keyboard-focusable region; dialogs keep their footer in view (`FormDialog` is already responsive).
- **Motion.** Nothing animates beyond the library's spinner and drawer, which respect reduced motion.
- **Language.** `<html lang>` is set by the shell. Numbers use the viewer's convention (`8.1%` vs `8,1%`), while the **CSV is always dot-decimal** (D3 of the plan), so a copy line in the export card should not promise otherwise. **(retired 2026-11-19, sign-off)** The export is a workbook: numbers are numeric cells with no decimal separator in the file.
- **Keyboard-only paths to verify** (QE): add an account with the keyboard only; deactivate then reactivate it and land on its row; change a default and reach the history; fix a refused approval by following the summary link; download a blocked-then-ready export.
- **Test hooks.** New `data-testid`s use the `refund-` prefix or the card's own prefix, as the page does; e2e needs at least `classification-account-<lineId>`, `classification-vat-<lineId>`, `accounting-export-card`, `accounting-export-download`, `settings-accounts-add`, and a stable id on each select (`Field id`) for the `ErrorSummary` `onGo`.

## Implementation notes the code tasks must carry (from this design)

- **Do not reuse `runReviewMutation` or the approve handler's 409 branch for the new calls.** Today `handleApproveConfirm` shows the "already decided" guardrail for every 409 except `all_lines_rejected`; `classification_missing` and `accounting_release_pending` are also 409s and would be mislabelled. Branch on `error.code`.
- **After any approved-total change, reject or restore, reload the accounting view with the request** (the CHF and VAT figures depend on the total; a rejected line loses its panel).
- **Merge the PUT's returned line into the accounting state; never compute CHF or VAT in the browser.** The only rounding rule lives in refund-api.
- **Options come from `GET /accounting/options` once per page** (only when a CH line exists and the user can edit), and again after a 422 inactive error.
- **Dialogs are mounted next to the table or card, not inside any `<form>`** (ADR 20261118 dialog-beside-form).
- **Download:** `response.blob()`, anchor with `download`, revoke the object URL straight away (the `RequestExportLink` order), filename built client side (UX-12). **(changed 2026-11-19, sign-off)** The route is `…/accounting-export/file` and the filename ends `.xlsx`.
- **Settings route:** add `validateSearch` for `section` and `month` on `settingsRoute`, with the same strip-or-keep technique the `confirmation` param uses.
- **Leave the existing Settings sections' code alone** (no refactor of the 589-line page beyond splitting it into the view panels that the plan already asks for).
- The `lib/rateValidation.ts` pattern (client check mirrors the server, the server is the authority) applies to the new validators; none of them replaces a server rule.

## Gaps found

| # | In | Gap | Proposed answer |
|---|---|---|---|
| G1 | plan, Components touched (refund-ui) | The plan says the approve dialog shows `classification_missing` as a list of lines. A modal covers the controls to be fixed. | UX-5: `ErrorSummary` on the page. Update the plan's bullet. |
| G2 | refund-ui code (`ReviewDetailPage`) | Any 409 other than `all_lines_rejected` on approve is shown as "this request was already decided". The new 409s would be mislabelled. | Branch on `code` (see Implementation notes). Worth a test. |
| G3 | spec AC-3.4 / plan `resolveClassification` | AC-3.4 says "no default account **or** no *usable* default VAT code". It is silent on a default **account** that was deactivated. | Treat an inactive default account as missing, like the VAT code, and return `account: null` (or flagged inactive) so the panel's Missing state applies. Needs the architect's confirmation; the panel handles either. |
| G4 | plan `GET /review/requests/{id}/accounting` | Not stated whether rejected lines are returned and with what `classification`. | Design assumes `classification: null` or the line omitted, and shows no panel (UX-13). Confirm. |
| G5 | spec / plan | Who may *see* the exchange rates? `GET /exchange-rates` needs `settings:read`. An accounting user who is not an admin may see the "missing EUR · March 2026" blocker but cannot open the rates. | The blocker degrades to "Ask an administrator to enter or fetch it." If accounting should fix it themselves, the role needs `settings:read` (and `settings:manage` to correct): a product question for the user, with open question 5. |
| G6 | plan R10 | The export summary may call the official source for up to 6 months at 5 s each, which is up to 30 s if sequential, inside a request the user is watching. | Ask for the calls to run in parallel or for a total cap of about 10 s. The card is designed to wait without blocking the page, but 30 s of "Checking the export…" is poor. |
| G7 | `@operai/ui` | No month formatter. | UX-10: add `formatMonth` (story, test, changeset), or fall back to `YYYY-MM`. |
| G8 | plan `GET /exchange-rates` | `sourceDiscrepancy`, and `null` on the classification PUT, are in the API with no AC. | See "UI proposed by the plan that no acceptance criterion asks for". Add an AC or drop them. |
| G9 **(retired 2026-11-19, sign-off)** (the route is `…/accounting-export/file`) | plan CSV route | The plan puts the filename in `Content-Disposition` and the counts in `X-Export-*`. A browser on another origin cannot read those headers unless refund-api lists them in `Access-Control-Expose-Headers`. | The UI does not depend on them (UX-12). If a header is wanted, add the CORS exposure. |
| G10 | plan `409 accounting_export_blocked` | The 409 body is said to carry `blockers`; the UI relies on it having the same shape as the summary so it can switch the card to Blocked without a second call. | Confirm the shape is identical. |
| G11 | plan `unclassifiedLines[].missing` | Items carry `employee` and `receiptNumber` but no line label (type, date). An accountant sees "Matteo Codogno · MC26/014: no VAT code", which is enough if the line has a number, and not if it does not. | Add `date` and `type` to each unclassified-line blocker. |
| G12 | spec AC-6.6 | "States how many WellD Italia lines were left out": the design states it only when above zero. If zero should be stated too, it is one line of copy. | Confirm. |
| G13 | existing code | `BatchPdfLink` uses an emoji (`📄`) as an icon, against INC-31. | Not touched by this design (out of scope); the new export button has no glyph prefix. |


## Implementation sync (2026-11-19)

**Status note.** `status` stays `draft` on purpose: design is ungated in this flow, so nothing approves this file. This section was written after the implementation and fix round 1 (read from `refund-ui/src/components`, `pages` and `strings.ts` at `19d1f2b5`), and it answers eval round 1 ("Design fidelity", eval-report.md). Where this section and the sections above disagree, **this section describes what is built**; the earlier text is the original intent. Copy keys are in `refund-ui/src/strings.ts` (en, with `it` at parity).

### States built that the design did not have

**S7a. Read-only panel on the caller's own request** (SR-2, FR-1; `LineClassificationPanel` `selfRestricted`, `data-mode="readOnly"`).
- When: the view says `selfRestricted: true`, or a save was refused with 403 `self_approval_forbidden` (`refusedAsOwner`). It applies even when the user holds the `reclassify` or `set-approved-total` capability, and the options are then not loaded.
- What shows: `role="group"` named `groupLabel(line)`, a `FactList` with the account and VAT code as plain text (each with its Default / Set by hand badge **(changed 2026-11-19, sign-off)**: the VAT code has no badge), the same rate / CHF / VAT figures, then one sentence `pages.reviewDetail.classification.selfRestricted`: "You can't classify your own request. Someone else has to do it." (it: "Non è possibile classificare la propria richiesta. Deve farlo un'altra persona."). A user who lacks the capability gets `readOnly` instead; a paid batch gets `locked` plus the lock icon.
- Transition: a 403 `self_approval_forbidden` on a save turns that panel (and, through `onSelfRestricted`, every panel of the request) read-only at once and reloads the view. The select reverts silently; there is no error under it.
- Related: the Approve button is `aria-disabled` with `decide.selfApprovalTooltip` when the user is the owner and their `approve` grant carries the self-approval deny (pre-existing control).

**S7b. Out-of-scope line** (SR-1; `line.inScope === false`).
- The server sends no account, VAT code or amount for the line. The panel is one `<p>` (`classification-<id>-out-of-scope`): `…classification.outOfScope` "Not shown: this line is outside your entity scope. Ask a colleague with WellD CH access." (it: "Non visibile: questa riga è fuori dal proprio ambito di entità. Rivolgersi a un collega con accesso a WellD CH."). No control, no figure, not focusable.
- A save that returns 404 (stale view) shows `…classification.lineOutOfScope` "This line is outside your entity scope, so you can't change it." under the select, then reloads the view (`onOutOfScope`).
- `GET /accounting/options` answering 403 `accounting_out_of_scope` makes an otherwise editable panel read-only with the generic `readOnly` sentence (no scope-specific copy; see finding A-9).

**S5a. Exchange-rate fetch outcomes beyond ok / failed** (`ExchangeRatesCard`).
- `throttled`: a dismissible info `Banner` with `settings.fx.throttled` "The rates were checked a moment ago. Try again in a few minutes." (it: "I tassi sono stati controllati poco fa. Riprovare tra qualche minuto."). Nothing was written; it is information, not an error.
- `deferred` (response `deferredMonths`, six months per call): a dismissible info banner with `settings.fx.deferred(n)` "1 more month is still to fetch. Fetch again to continue." / "n more months are still to fetch. Fetch again to continue." (it: "Resta ancora 1 mese da recuperare. Recuperare di nuovo per continuare." / "Restano ancora n mesi da recuperare. Recuperare di nuovo per continuare."). It appears beside the "Recorded the rates for k months." confirmation when both apply.
- `not_fetchable`: dismissible info banner `fx.notFetchable(month)` (as designed). A request error: dismissible `danger` banner `fx.fetchError` "Could not fetch the rates. Try again." (or `catalog.forbidden` on a 403).
- All of these are `role="status"` (polite) banners; the failed-fetch and the switched-off banners are derived from the server's `lastFetch` and are persistent (not dismissible).

**S5b. Per-cell history.** Each recorded rate cell has a second icon button, `fx.historyLabel` + `history.openLabel`: "Show the history of the EUR rate for October 2026", opening the shared `ChangeHistoryDrawer`. The design only said history is "one click away".

**S8a. FR-5 gap: an approval refused for a line the approver cannot classify** (plan FR-5, follow-up FU-S7; not designed or fixed).
- Built behaviour: a 409 `classification_missing` that names lines closes the approve dialog and sets the refusal; the `ErrorSummary` lists only lines for which the accounting view has a `classification` object (`ReviewDetailPage` `missingItems`). An out-of-scope line has none, so it gets **no row and is not counted** in the title.
- Case 1, mixed refusal: the summary says "1 value needs your attention" while the server refused 3; the out-of-scope line only keeps its S7b note.
- Case 2, **only** out-of-scope lines named: no summary renders (`ErrorSummary` with zero items returns nothing), the dialog is already closed and focus returns to Approve. **The approval fails silently.** Observed in the browser pass (finding A-1).
- Proposed design for FU-S7: add one summary row per refused out-of-scope line, `…missingSummary.outOfScope(line)` "{line}: needs a colleague with WellD CH access", linking to that line's row (focus the line's out-of-scope note, `tabIndex=-1`); count it in `missingSummary.title`; and when the refusal names only such lines, still render the summary and move focus to it. Copy to add in en and it.

### Reconciled with the built screens

| Design text | As built |
|---|---|
| S7 "one polite live message per page" for a saved value | One `role="status"` `<p>` per panel (`classification-<id>-saved`), empty until a save; no page-level region. Fine for AT. |
| S7 `fieldset` | Editable panel is a `fieldset aria-label` + `legend`; the read-only and locked forms are `div role="group" aria-label` with a `FactList`. |
| S7 loading | Per-line skeleton (`aria-hidden`) plus one polite `VisuallyHidden` "Loading classification…" (as designed). Selects are `disabled` while the options load. |
| S7 inactive current value | Select shows `inactiveOption(text)` "(inactive)" as a disabled selected option plus the hint (as designed). A saved active value missing from the options is still offered. |
| S6c/S6d "focus on the first field" | The default-classification and foreign-VAT dialogs open with focus on **Cancel**; Save is disabled until the choice differs. Add-account, Add-VAT and Correct-rate open on their first field. The deactivate confirm opens on Cancel. |
| S6a/S6b validation | Errors on blur; Save disabled until both fields have text; a failed submit moves focus to the first invalid field (as designed); 409 duplicate shows `errors.duplicate(number)` in an alert. |
| UX-1 tabs | Offered when the user holds `settings:read` (General is always there). The active tab panel is itself a tab stop (`tabPanelProps`). Changing tab replaces the URL (`?section=`). |
| S10 Check again | The button sits in the banner's `actions`; there is no live announcement of the result (A-3). |
| S10 download | `aria-busy` + label "Preparing file…" while running, not `disabled`; focus stays on the button; the success banner is a polite `role="status"`; a failed download is `role="alert"` beside the button. Blocked Download is `aria-disabled`, described by a visually hidden `blocked.reason`; Enter does nothing. |
| Blocked banner | `Banner tone="warning" live="off"` renders as `role="note"` (not announced), as designed. |
| S5 Last fetch | A non-ok outcome shows the time only (`formatDateTime`) with no outcome word; the failed / disabled banner carries the meaning. See A-7. |
| History drawer title | `history.title(subject)` with the exchange-rate subject reads "History — the EUR rate for October 2026" (the article comes from `fx.historyLabel`). Copy nit A-10. |

Copy keys built beyond the table above: `settings.fx.throttled`, `fx.deferred(n)`, `fx.fetchError`, `fx.cellMissingLabel`, `fx.historyLabel`, `history.closeLabel`, `defaults.historyLabel`, `defaults.changedBy`, `defaults.dialog.inactiveSentence`, `foreign.changeLabel`, `foreign.historyLabel` **(retired 2026-11-19, sign-off)**, `vatCodes.empty`, `defaults.loading`; `…classification.selfRestricted`, `outOfScope`, `lineOutOfScope`, `unavailable404`, `lockedGuardrail`, `releasePending`.

### Gaps closed or still open

G1 (ErrorSummary instead of a dialog list) built as designed. G2 built (409s told apart by code). G12 built (excluded sentence only above zero). G4/UX-13 built. Still open: G3, G5, G6, G9, G10, G11; **new:** FR-5 / FU-S7 above.

## Browser accessibility pass (2026-11-19)

*Scope note, added by the sign-off round sync: this pass was run **before** the accounting sign-off round and on the screens as they were then (twelve default rows with a VAT column and a foreign-currency VAT code, a VAT select with "Choose a VAT code", a CSV export card). Its "Passed" items and findings A-1 to A-11 describe that state. The Settings defaults, the review panel's VAT select, the approve summary, the export card and the add-line form's split-receipt hint have had **no browser pass** since. That pass is pending (owner step T81) and no result is claimed here.*

**Method.** refund-ui's own Vite dev server (`vite@8`) ran on `127.0.0.1:5291` with a throw-away config kept outside the repo that aliased `shell/session` to a stub, so no shell, auth, backend, database or network was involved. Every refund-api call was answered by an in-page `fetch` mock whose response shapes follow `lib/*Api.ts` and their tests. The Playwright MCP browser could not be used: its shared profile was locked by another session's Chrome (`Browser is already in use … mcp-chrome-a66b975`). The same Playwright library (`@playwright/test` 1.61.1, resolved from `shell/node_modules`) drove an isolated Chrome with a temporary profile instead, at `deviceScaleFactor: 1`. axe-core 4.14.0 (found under `operai-ui/node_modules`) was injected on every state; a manual contrast scan covered text that axe reported as "incomplete". Light and dark themes were checked on the main screens, 320 px width on Settings and the batch page. Screenshots: `/private/tmp/claude-501/-Users-hermes-claude-workspace/3b8f0432-b131-57d7-bf4a-a725ea48766e/scratchpad/a11y/shots/` (61 files, e.g. `24-review-refused.png`, `33-review-oos-refused.png`, `43-export-blocked.png`); raw axe output in `…/a11y/out/`.

**Limits.** It is a mock, so server behaviour is not tested. No real screen reader was used: names, roles and live regions come from Chrome's accessibility tree and DOM. The shell's `<main>` is absent, so axe's `landmark-one-main` (moderate) appears on every page and is a harness artefact, not a finding. The Italian locale, a paid (locked) batch and the Mark-as-paid flow were not driven.

**Passed (no action).**
- Settings tabs: `tablist` named "Settings sections", roving tabindex, Arrow/Home/End change the view and the URL (`?section=`), focus stays on the tab. Tab order through the three cards is logical; every row action is named after its row ("Deactivate account 5905", "Change the default for Travel — train").
- Dialogs: focus lands inside, Escape returns it to the opener, blur validation links the error with `aria-describedby`, a failed submit focuses the first invalid field. Deactivate / Reactivate move focus to the row header (`th`) and announce through a polite status. History drawer focuses its heading and returns focus. Deep link `&month=2026-09` focuses that row header.
- Exchange rates: cell groups are named "EUR, October 2026: 0.9301, Fetched" / "…: missing"; auto-fetch and Fetch now never move focus, and their notes, the persistent failed banner and the disabled banner are polite `role="status"`.
- Review page: tab order is row by row (total, Reject, Account, VAT code); the fieldset names each group; "Saving…" keeps focus on the select (`aria-busy`); a saved value is announced; a 422 shows an alert under the select with `aria-invalid`. The refused approval renders an `ErrorSummary` (`role="alert"`), moves focus to the first missing select, and its item moves focus to the select. The out-of-scope note, self-restricted panel (both with and without the approve-deny grant), reader panel and the 404 / 500 / loading states are all text, announced where they should be.
- Export card: ready, header-only, blocked, out of scope, loading, download failure and "became blocked" are all reachable and described; the blocked Download is focusable, `aria-disabled`, described, inert on Enter; download works from the keyboard and offers `refund-accounting-2026-11-15-<batch>.csv`.
- Focus indication: links and buttons get a 2 px outline; form controls change border to `#5B6AF7` (3.56:1 light, 3.88:1 dark against the control background). Manual contrast: 0 text below 4.5:1 on all captured screens, light and dark, apart from disabled controls (exempt) and A-5. No horizontal page scroll at 320 px.
- axe: 0 violations other than `landmark-one-main` on Settings (all three views and every dialog), exchange rates (all fetch states), and the review page (all states); one other rule fires on the batch page (A-6, pre-existing).

**Findings.**

| # | Severity | Where | Finding | Owner and fix |
|---|---|---|---|---|
| A-1 | **High** (narrow reach: an entity-scoped approver on a mixed request) | Review page, FR-5 / FU-S7 | When 409 `classification_missing` names only lines outside the approver's scope, the dialog closes, no `ErrorSummary` renders (zero items) and focus goes back to Approve: nothing says the approval failed (WCAG 3.3.1, 4.1.3). With a mixed refusal the summary under-counts (1 instead of 3). | frontend-dev, from the S8a design: a summary row per out-of-scope line, counted in the title; if no in-scope row exists, still show the summary and focus it. Promote FU-S7 from "not planned". |
| A-2 | Medium | `LineClassificationPanel`, 403 `self_approval_forbidden` on save | The editable fieldset is replaced by the read-only group, so the focused select disappears: focus drops to `<body>`, and the `role="status"` region goes with it, so the reason is not announced. | frontend-dev: after the swap, focus the read-only panel's reason `<p>` (`tabIndex=-1`, `role="status"`) so the sentence is read and the keyboard position survives. |
| A-3 | Medium | `AccountingExportCard`, Check again | When the recheck makes the export ready the banner and the focused button unmount, so focus drops to `<body>`; the result (still blocked, or ready) is never announced (the "Checking the export…" region exists only while running). | frontend-dev: on completion focus the card heading or Download, and announce a polite result ("The export is ready: 12 rows." / "Still blocked: 2 items."), which needs two new copy keys (en and it). |
| A-4 | Low | `ApproveDialog` (pre-existing), reached by the new refusals | While Approve is busy the focused button is disabled and focus falls to `<body>`; after `accounting_release_pending` the dialog stays open with the error (`role="alert"`, so it is announced) but focus remains on `<body>` until Tab (which re-enters the trap at Cancel). | frontend-dev or `@operai/ui` `Dialog`: return focus to the confirm button when busy ends. |
| A-5 | Low | Blocked Download (`aria-disabled`, opacity .5) | Its label contrasts 3.47:1 (light) / 4.13:1 (dark). WCAG exempts inactive controls, but UX-7 depends on the button being read. | `@operai/ui` `Button`: a darker `aria-disabled` style, or leave it as accepted. |
| A-6 | Low (axe says serious; pre-existing) | `BatchEmployeeGroupList` request link | `label-content-name-mismatch`: the link's `aria-label` ("Open …, Approved, EUR 52.00") does not contain the visible text as one string. It fires with and without receipt numbers, so this feature did not cause it. | frontend-dev: build the label from the visible strings in order, or drop the override. |
| A-7 | Low | Exchange rates, "Last fetch" | A non-ok outcome shows only a time ("Last fetch 19.11.2026 11:00"), which reads as success until the banner is found; `throttled` and `not_fetchable` have no outcome word at all. | frontend-dev: add an outcome word to the value (`lastFetch.failed(at)`, `lastFetch.disabled(at)`) in en and it. |
| A-8 | Low | Review page, rate missing without `settings:read` | The "Rate missing" help text has no next step for a reviewer who cannot open Settings (the export card has "Ask an administrator…"). | frontend-dev: reuse `blocked.askAdmin` when `canOpenRates` is false. |
| A-9 | Info | Panel when `GET /accounting/options` answers 403 | The read-only sentence is the generic "You can view the classification but not change it", which does not say the cause is entity scope. | frontend-dev: optional scope-specific copy. |
| A-10 | Info | Copy | Exchange-rate history drawer title reads "History — the EUR rate for October 2026". The selects in the default dialogs carry `*` although "None (no default)" is a valid choice. The Correct-rate dialog has a description but no hint when the cell is Missing. | frontend-dev: nits. |
| A-11 | Info | Tab length | The rates table is up to 2 stops per cell (about 18 per three months) plus the focusable table region and tab panel. Reachable, long. | Designer: consider one row-level action menu if admins complain. |

No contrast, reflow or axe failure was found in the new surfaces beyond the items above. A-1 is the one to schedule before release; A-2 and A-3 are small.

**Dev server.** Stopped after the pass (port 5291 free again); no file inside the repository was changed except this `design.md`.


## Sign-off round sync (2026-11-19)

Written on 2026-11-19 by the designer agent, working unattended, to close the design-fidelity finding of eval round 2 (`specs/20261119-accounting/eval-report.md`, "Round 2 (T79)": design fidelity 2, below its floor of 3). The accounting sign-off round (tasks T58 to T82, from `1aaa81c0`; amendments E1 to E7 and F1 to F8 of `spec.md`; `plan.md` SO-1 to SO-18) rebuilt six areas of Refund's UI and no design file followed it. This section reconciles this file with the code at HEAD `2facb68d` of `feat/accounting-module`, read as `git diff ef805983..HEAD` over `refund-ui/src` (`ef805983` is the commit of the module's Implementation sync in `specs/20261119-accounting/design.md`, which touched no refund-ui file, so this is also everything since `0b000570`) plus the full text of the files the round changed: `ExpenseTypeDefaultsCard`, `DefaultClassificationDialog`, `DefaultsSettingsView`, `CatalogSelect`, `LineClassificationPanel`, `ReviewDetailPage` (the approve-refusal parts), `AccountingExportCard`, `accountingExportApi`, `accountingApi`, `ExpenseLineComposer`, `lib/expenseTypes.ts`, `strings.ts` (en and it) and their tests (for the axe call sites). **Nothing was run**: no dev server, no browser, no test suite, no screenshot, and the visual companion was not enabled, so there are no mockups. It records what is built; it changes no decision and approves nothing.

> **Status.** `status: draft` stays: design is ungated in this flow and nothing approves this file. **Where this section and the text above disagree, this section describes what is built.** The text above carries "(retired 2026-11-19, sign-off)" or "(changed 2026-11-19, sign-off)" where the round retired or changed it, and "(moved ...)" where a screen left Refund for the Accounting app earlier the same day. **No browser accessibility result exists for any state this section describes** (section 5): the browser pass stays pending, owner step T81 (which renews T51's live evidence for the round) together with T51's browser-pass section in `specs/20261119-accounting/design.md`.

Key used below: **Built** = as designed. **Changed** = built differently from the text above. **Retired** = designed above, gone. **New** = built, no earlier entry. **Unverified** = depends on something only a browser (or a re-run) can show.

### 1. Who describes what

| Area | Described in full | Cross-referenced from |
|---|---|---|
| Settings defaults card and dialog (S4, S6c, S6d, S6e), review panel (S7), approve refusal (S8), export card (S10), the expense-line composer hint (S11, new), the 14 expense-type labels, refund-ui copy keys | **this file** | `specs/20261119-accounting/design.md` RS2 to RS6 hold the states of the same screens that come from Accounting's reference data (deactivated, not found, unreadable, rate pending); its "Sign-off round sync" reconciles each of them state by state |
| accounting-ui (AS1 to AS7): the rates card's Source text, the VAT code example, what the signed-off seed shows in the lists | `specs/20261119-accounting/design.md` | here by pointer only |

Also, and not part of the sign-off: the Accounts and VAT and Exchange rates views, the ledger account and VAT code cards and dialogs, and the rate correction dialog moved to the Accounting app the same day, before this file was written about them. They are marked "(moved ...)" at S2, S3, S5, S6a, S6b, S6f, F1 to F3 and F8 and are owned by `specs/20261119-accounting/design.md` (AS3 to AS6).

### 2. Decisions the round made, recorded

Numbering continues this file's own sequence; `UX-15` here is not `UX-15` of the 20261119 file.

| # | Decision (as built) | Why | Cost to change |
|---|---|---|---|
| UX-15 | **A default is one account per expense type.** The Default classification card has one value column (account), no VAT column and no foreign-currency designation fact; the Change dialog has one select; fourteen rows. | E2 and SO-16: a VAT code is never pre-set, so there is nothing to default and nothing to designate. | Medium: the backend dropped the VAT half too. |
| UX-16 | **The VAT select on a line is optional.** It always offers "None" (the first option), is not marked required (no `*`, no `aria-required`), has no "Choose…" placeholder and no Default marker. A line with no code **is** "None": there is no separate unset state, and a EUR line is not special. Choosing a code sends `{ vatCode }`; choosing None sends `{ vatCode: null }`, which clears it. | AC-3.3, AC-3.11, AC-3.13. A placeholder or a star would say that a VAT code is expected, and the owner decided it is not (a foreign receipt is not "no Swiss VAT" by default). | Low. |
| UX-17 | **The VAT amount fact says why it is empty.** With no VAT code: "No VAT code, so no VAT amount." With a code but no CHF amount to compute from: "—". With a code and a CHF amount: the figure (a CHF line adds the rate, `CHF 1.56 (8.1%)`; a foreign line shows the CHF figure alone). "—" is therefore never the answer for "no code", and `CHF 0.00` stays a real value (IP00). | AC-3.8 (shown only when a VAT code is set). A bare "—" for both "no code" and "cannot compute" would read as a fault where there is none. | Low. |
| UX-18 | **A refused approval names accounts only**: `ErrorSummary` titled "Nothing was approved. N lines need an account." with the hint "Choose an account for each line, then approve again."; one row per refused line, "{line}: choose an account", and the out-of-scope rows of A-1 are still counted. A line with no VAT code is never listed, and approving it succeeds. | AC-3.4, AC-3.11, AC-8.4. | Low. |
| UX-19 | **The export card downloads an Excel file.** Button "Download Excel file" (still `secondary`, still `aria-disabled` with its reason while blocked), file `refund-accounting-<cutoff>-<batchId>.xlsx` saved from the untouched Blob, served from `…/accounting-export/file` (the old `/csv` route answers 404 and is never called). The blocked list is "Lines without an account". | AC-6.1, AC-6.2, SO-6, SO-12. UX-7 and UX-12 above stand except as marked. | Low. |
| UX-20 | **The split-receipt hint** is one sentence under the Amount of the add-line form, only for a WellD CH line, never for mileage, with no validation. The Italian text keeps the informal "inserisci", word for word from plan SO-15. | AC-3.12 and SO-15 (an owner decision at approval): the VAT code is one per line, so an employee with a multi-rate receipt must enter one line per rate. The file's impersonal "Inserire…" form is deliberately not applied; `strings.test.ts` pins the sentence, so a copy review should not "fix" it. | Low. |
| UX-21 | **Fourteen expense types**: flight and taxi added after "other public transport", the meals type renamed. Labels in section 3.6. | AC-8.1, AC-8.2. | Low (labels are data in `lib/expenseTypes.ts`). |

### 3. Flows and screens

#### 3.1 Flows: what changed

- **F4 — Admin sets the defaults** (AC-2.1 to AC-2.4, AC-2.8; AC-2.5 to AC-2.7 retired). **Changed.** Step 1: fourteen rows, each with its default account or **None**, who and when, **Change** and **History**. Step 2: the dialog has one select (active accounts, "None (no default)"). Step 4 (the foreign-currency VAT code) is retired, and so is its warning. Step 5: only the account refusals remain (422 `ledger_account_inactive` / `ledger_account_not_found`).
- **F5 — Accounting reviews and classifies a request** (AC-3.1, AC-3.3, AC-3.4, AC-3.8, AC-3.11, AC-3.13). **Changed.** Step 1: the panel arrives with the account filled in and marked **Default** (or the account **Missing**, for a type with no default, such as "Representation — gifts", AC-8.4); the VAT code shows **None**; there is no VAT marker, and a EUR line is classified exactly like a CHF line (only its amount facts differ). Step 2: either select saves at once; choosing None for the VAT code clears it and is announced. Step 4: `classification_missing` is account-only (UX-18); approving lines with no VAT code just works.
- **F6 — Accounting corrects an approved line.** **Built**, with the VAT select able to go back to None while the batch is not paid.
- **F9 — Accounting exports a batch** (AC-6.1, AC-6.5, AC-6.7, AC-6.9, AC-6.11, AC-7.2). **Changed.** **Download Excel file** replaces Download CSV in every step; the Blocked list names accounts only.
- **F11 — An employee adds a WellD CH line (AC-3.12, SO-15). New.** Draft request page → the add-line form: date, type, motivo, Amount, Entity, Currency. When the Entity is set to WellD CH, a sentence appears under Amount saying that a receipt with several VAT rates is entered as one line per rate. Exits: none of its own; the sentence blocks nothing, and adding the line works as before. The form is the same for WellD Italia and shows no sentence.
- **F10 and F7** (lines approved before the feature; receipt numbers) have no UI change. AC-4.11 to AC-4.13 and AC-7.4 (the 2026 numbering baseline) show only as the numbers a line gets (F7 stands).

Sign-off ACs with no UI surface of their own, proven by tests and visible only through the flows above: AC-3.11 and AC-3.13 (an absence), AC-3.12 (structural: one VAT select), AC-4.11 to AC-4.13, AC-6.2 to AC-6.3 and AC-6.12 to AC-6.17 (the file's content), AC-7.4 (the release), AC-8.3 (the seed), AC-8.4 and AC-8.5 (behaviour of the panel's existing selects). **UI built that no AC asks for**: the split-receipt hint itself (SO-15 is an owner decision; AC-3.12 only implies it), the polite "VAT code cleared" line, the "No VAT code, so no VAT amount." sentence (AC-3.8 says only that no amount is shown). All three are small copy, reported not designed.

#### 3.2 S4 — Card "Default classification" (changed; S6d retired)

```
Default classification                                                   <- h3, takes focus after a recovered Retry
The account each expense type gets in WellD CH. Accounting can change it line by line. Where a type has no
default, accounting must choose on each line before approving.

 Expense type                  Default account              Last changed                 Actions
 Travel — highway              5906 — …                      admin@… · 01.04.2026         [Change] [History]
 Travel — flight               5902 — Spese viaggi in aereo  Not set yet                  [Change] [History]
 Representation — gifts        None                          Not set yet                  [Change] [History]
 … (fourteen rows, in the order of refund-api's ExpenseType enum)
```

| State | Verdict | What is built |
|---|---|---|
| Loading, load failed, denied | Built | Skeleton and polite "Loading the default classification…"; `ErrorBanner` with Retry; a 403 leaves the card out. |
| Loaded | **Changed** | Fourteen rows, one account column. **None** is real text in secondary colour, never an empty cell. "Last changed" is "Not set yet" or `by · date`. No foreign-currency fact above the table and no VAT column. |
| Read-only (`settings:read` without `settings:manage`) | Built | No Change; History for everyone. |
| An account deactivated or not found | Built, narrower | The account carries `StatusBadge` "Deactivated in Accounting" / "Not found in Accounting"; the card-level static warning counts **types with an unusable account** (there is no designation to count) and says those lines get no default. |
| Accounting cannot be read | Built | One polite warning `Banner` with Retry; entries as recorded, no badge; Change `aria-disabled` and described by its reason; History works. |
| Retry | Built | Recovery focuses the card heading and says "Accounting can be read again."; a failure says "Accounting still cannot be read." |
| Foreign-currency VAT code fact, its warning, its Change and History | **Retired** | Gone with the designation. |
| A default that needs a VAT code | **Retired** | A default is an account. |

**S6c — Default classification — {type} (changed).** One field, *Default account* (`CatalogSelect`: "None (no default)", then Accounting's active accounts, number first). Save is disabled while the value equals what is saved and while the select reads "Choose…"; a saved account that is deactivated or not found makes the select start on "Choose…" with a hint and a one-line note, so saving never clears a default by accident. The request body carries `accountNumber` (a number, or null for None) and nothing else. Refusals: 422 `ledger_account_inactive` / `ledger_account_not_found` → field error on the select, options reload, focus on the select; 503 → alert "…cannot be read right now. Nothing was saved…"; options unavailable (503) → a warning banner with a ghost **Try again** and no options (Save disabled); any other options failure → a load-error banner with Retry; a 403 on the options read → "You don't have permission to do this." The star on the select is kept although "None" is a valid choice (the A-10 nit, still open). **S6d (VAT code for foreign-currency lines) is retired**; its component is deleted. **S6e History drawer**: columns *When*, *By*, *Account* (the VAT column is gone).

#### 3.3 S7 — Classification panel (changed)

```
 19.03.2026 · MC26/014 · Travel — flight · [WellD CH] [EUR]               Approved total
 Milan–Lugano return                                                       EUR 52.00
 ─────────────────────────────────────────────────────────────────────────────────
 Classification
 Account *  [Default]                   VAT code
 [ 5902 — Spese viaggi in aereo   v ]   [ None                    v ]
 Exchange rate  0.9246 · March 2026     CHF amount  CHF 48.08     VAT amount  No VAT code, so no VAT amount.
```
(The wireframe at S7 above shows `NOVAT` pre-set with a Default marker on both selects: **retired**. `NOVAT` is no longer a code; the seed has `IP00` (0.00 %).)

| State | Verdict | What the user sees |
|---|---|---|
| Editable, a default account and no VAT code | **Changed** | Account select set, hint "Default"; VAT select on **None**, no hint, no marker; the VAT amount fact reads "No VAT code, so no VAT amount.". For a line in EUR the same, plus the rate, CHF amount and rate help as before. |
| A VAT code set by hand | **Changed** | The VAT select shows the code, number-first (`IPM81 — … (8.1%)`), no marker; CHF line: `CHF 1.56 (8.1%)`; foreign line: the CHF figure alone. With IP00 the amount is `CHF 0.00`, a real zero. |
| Choosing a code or None | **New** | The select shows the chosen value and "Saving…" and keeps focus (`aria-busy`, not disabled) while the PUT runs; the panel's polite line then says "VAT code set to {code}" or **"VAT code cleared"**; the amount fact follows the server's answer (never computed in the browser). |
| A change refused (403, 422 `vat_code_inactive` / `vat_code_not_found`, 503, other) | Built | The select reverts to what is saved and an alert under it says why; 422 and 503 reload the options or the accounting view as before. |
| The stored VAT copy was deactivated or is gone in Accounting | Built | Shown as a disabled selected option "(deactivated)" / "(not in Accounting)" with the hint "…The line keeps it; choose an active one to change it."; **None** and every active code stay selectable. |
| VAT "Missing", "Required to approve." and "Choose a VAT code" | **Retired** | A VAT code is never required, so it is never missing. |
| Account missing (no default, or the default is unusable) | Built | Placeholder "Choose an account", hint "Required to approve." (or the reason the default is unusable); the field error "Choose an account." only after a refused approval. "Representation — gifts" has no default, so it reads this way from the start, and nothing is suggested (AC-8.4). |
| Read-only, locked (paid batch), self-restricted | **Changed** | The group lists *Account* (with its Default or Set by hand badge) and *VAT code* (plain text, **None** when the line has none, no badge), then the amount facts and the reason sentence. |
| Accounting cannot be read | Built | Read-only group; the account's badge reads "Default (as recorded)"; a VAT code or **None** as recorded. |
| Out-of-scope line, rate pending, rate missing, before and after approval | Built | Unchanged (S7b of the earlier sync; UX-20 of 20261119). |

#### 3.4 S8 — Approve refusal (changed)

`classification_missing`: dialog closes; an assertive `ErrorSummary` titled "Nothing was approved. 1 line needs an account." / "…N lines need an account." with the hint "Choose an account for each line, then approve again." and one jump link per refused line ("{line}: choose an account"; "{line}: needs a colleague with WellD CH access" for a line the approver cannot see, A-1); focus goes to the first account select, or to the summary when only out-of-scope lines are named. A `vatCode` that an older server might still name is not a value the client knows and is ignored. `accounting_release_pending` and `accounting_unavailable`: unchanged.

#### 3.5 S10 — Accounting export card (changed)

```
Accounting export
One row per approved WellD CH expense line, with account, VAT code (when the line has one) and CHF amount, as an Excel file.
12 rows will be exported. 3 WellD Italia lines are left out: the export covers WellD CH only.
                                                              [ Download Excel file ]
```
**The description sentence above is built that way and contradicts AC-6.2 and AC-6.14: see gap SG-4.** The two wireframes at S10 above (Download CSV; "Lines without an account or a VAT code") are **retired**.

| State | Verdict | What the user sees |
|---|---|---|
| Ready, header only, out of scope, loading, load failed, not rendered | Built | As above, with "Download Excel file" for the button. |
| Blocked | **Changed** | The same warning banner (`live="off"`), now with these lists: **Accounting cannot be read** (heading, no missing-rate list, when `accountingUnavailable`), **Missing exchange rates**, **Lines without an account** (each "{employee} · {receipt number, or date and type}: no account" with **Open request**), **Lines without a receipt number**. A line with no VAT code never appears. Check again, the aria-disabled Download with its reason, "N lines get their exchange rate at this export" and the other 20261119 sentences are as built. |
| Downloading | Changed | "Preparing file…", busy, a second press ignored; saved as `.xlsx` from the untouched Blob. |
| Downloaded | Built | "Export downloaded: 12 rows", then a quiet re-read. |
| Became blocked (409 `accounting_export_blocked`), batch discarded (409), no file (500) | Built | The 409 body is read with a guard that accepts `missing: ["account"]` only. |

#### 3.6 S11 — Expense-line composer: the split-receipt hint (new)

Where: the add-line form of the employee's draft request (`ExpenseLineComposer`), on the **Amount** field. It is the field's own hint, so it is wired to the amount input by `aria-describedby`.

> **One VAT rate per line: if a receipt has items at different VAT rates (for example 8.1 % and 2.6 % at a supermarket), enter one line per rate.**
> *Una sola aliquota IVA per riga: se uno scontrino contiene articoli con aliquote diverse (per esempio 8,1 % e 2,6 % al supermercato), inserisci una riga per aliquota.*

| State | Verdict | What the user sees |
|---|---|---|
| Entity not chosen yet | New | No hint. |
| Entity WellD Italia | New | No hint (Italian lines are never classified, AC-3.9). |
| Entity WellD CH, a type with an Amount | New | The sentence under Amount. Nothing is validated and adding the line is never blocked. |
| Entity WellD CH, type "Travel — mileage (km)" | New | No hint: Amount is replaced by the computed mileage breakdown. |
| Switching the entity back and forth | New | The sentence appears and disappears with the entity; there is no announcement of the change (SG-1). |
| The in-place line editor (`ExpenseLineRow`, edit mode) | **Not built** | The editor has Amount and Entity too and shows no hint (SG-2). |

It says nothing about accounts or codes beyond the words "VAT rate", so AC-3.10 holds.

#### 3.7 The fourteen expense types (AC-8.1 to AC-8.3)

Labels are data in `refund-ui/src/lib/expenseTypes.ts` (not in `strings.ts`), shared with refund-api's PDFs through `document-labels.json` (a parity test pins the English labels). They appear in the add-line form and the in-place editor (`<select>`), the Settings defaults rows, the review and request line rows, the export blocker items and the batch PDF. Order is the enum order of refund-api (flight and taxi follow "other public transport"). A line that already carries `representation_meals` shows the new name (AC-8.2). The last column is what the release seeds as the default account (plan SO-17, AC-8.3; the other nine are the draft list until accounting confirms).

| Type id | English | Italian | Seeded default account |
|---|---|---|---|
| `travel_highway` | Travel — highway | Spese di viaggio (autostrada) | 5906 |
| `travel_km` | Travel — mileage (km) | Spese di viaggio (km) | 5905 |
| `travel_parking` | Travel — parking | Spese di viaggio (parcheggio) | 5907 |
| `travel_train` | Travel — train | Spese di viaggio (treno) | 5901 |
| `travel_other_public_transport` | Travel — other public transport | Spese di viaggio (altri mezzi pubblici) | 5904 |
| `travel_flight` **(new)** | Travel — flight | Spese di viaggio (aereo) | 5902 |
| `travel_taxi` **(new)** | Travel — taxi | Spese di viaggio (taxi) | 5903 |
| `company_manuals` | Company manuals | Spese manualistica societaria | 6501 |
| `stationery` | Stationery | Spese di cancelleria | 6101 |
| `representation_meals` **(renamed)** | **Meals with clients** (was "Representation — meals") | **Pranzi/cene con clienti** (was "Spese di rappresentanza (pranzi/cene/aperitivi)") | 6701 |
| `representation_gifts` | Representation — gifts | Spese di rappresentanza (regali) | none |
| `office_material` | Office material | Spese materiale ufficio | 6101 |
| `postal` | Postal | Spese postali | 6104 |
| `telephone` | Telephone | Spese telefoniche | 6102 |

**Open, and not a design decision**: the spec still lists the Italian and English labels of flight and taxi and the English label of the meals type as an open question for the owner (`spec.md`, open questions: Matteo Codogno). What is built are the spec's fallbacks (flight and taxi follow the paper form's "Spese di viaggio (…)" pattern) and the plan's proposal for "Meals with clients". "Pranzi/cene con clienti" is the owner's own wording.

### 4. Copy keys (`refund-ui/src/strings.ts`, en and it)

Added (the tests list them in `ADDED_KEYS` of `strings.test.ts`; both languages at parity):

| Key | EN | IT |
|---|---|---|
| `settings.defaults.descriptionAccountOnly` (replaces `description`) | The account each expense type gets in WellD CH. Accounting can change it line by line. Where a type has no default, accounting must choose on each line before approving. | Il conto assegnato a ogni tipo di spesa in WellD CH. La contabilità può cambiarlo riga per riga. Dove un tipo non ha un predefinito, la contabilità deve sceglierlo su ogni riga prima di approvare. |
| `pages.requestDetail.composer.splitReceiptHint` | One VAT rate per line: if a receipt has items at different VAT rates (for example 8.1 % and 2.6 % at a supermarket), enter one line per rate. | Una sola aliquota IVA per riga: se uno scontrino contiene articoli con aliquote diverse (per esempio 8,1 % e 2,6 % al supermercato), inserisci una riga per aliquota. |
| `…reviewDetail.classification.vatNone` | None | Nessuno |
| `…classification.savedVatNone` | VAT code cleared | Codice IVA rimosso |
| `…classification.vatAmountNone` | No VAT code, so no VAT amount. | Nessun codice IVA, quindi nessun importo IVA. |
| `…classification.missingSummary.titleAccounts(n)` (replaces `title`) | `n === 1`: Nothing was approved. 1 line needs an account. else `…${n} lines need an account.` | `Non è stato approvato nulla. 1 riga richiede un conto.` / `…${n} righe richiedono un conto.` |
| `…missingSummary.hintAccounts` (replaces `hint`) | Choose an account for each line, then approve again. | Scegliere un conto per ogni riga, poi approvare di nuovo. |
| `…batchDetail.accountingExport.descriptionExcel` (replaces `description`) | One row per approved WellD CH expense line, with account, VAT code (when the line has one) and CHF amount, as an Excel file. (**SG-4**) | Una riga per ogni spesa WellD CH approvata, con conto, codice IVA (se la riga ne ha uno) e importo in CHF, in un file Excel. |
| `…accountingExport.downloadExcel` (replaces `download`) | Download Excel file | Scarica file Excel |
| `…accountingExport.blocked.unclassifiedAccounts` (replaces `unclassified`) | Lines without an account | Righe senza conto |

Removed from both catalogs (the tests assert they are gone): `settings.defaults.description`, `settings.defaults.columns.vatCode`, `settings.defaults.dialog.vatCode`, `settings.defaults.errors.vatInactive`, `settings.defaults.errors.vatNotFound`, `settings.defaults.foreign.*` (`term`, `description`, `none`, `inactiveWarning`, `notFoundWarning`, `dialogTitle`, `saved`, `historyLabel`, `changeLabel`), `settings.history.columns.vatCode`, `…classification.chooseVatCode`, `…classification.missingVatCode`, `…classification.defaultWhat.vatCode`, `…classification.missingSummary.title` / `hint` / `vatCode`, `…accountingExport.description`, `…accountingExport.download`, `…accountingExport.blocked.unclassified`, `…accountingExport.blocked.missingWhat.vatCode` and `.both`. **Changed in value, same key:** none.

Still in use, with a narrower meaning: `…classification.inactiveCurrentVat`, `notFoundCurrentVat`, `vatInactive`, `vatUnknown`, `savedVat` (a hand-set VAT copy can still be deactivated or lost, and a code can still be refused); `settings.defaults.dialog.notFoundCurrent(what)` and `…classification.defaultDeactivated(what)` / `defaultNotFound(what)` (`what` is now always the account); `…blocked.missingWhat.account` and `…unclassifiedItem(employee, receipt, missing)`.

The rows of the copy-key tables above carry "(retired 2026-11-19, sign-off)" next to each key listed here. The 14 type labels are not keys: they are in `lib/expenseTypes.ts` (section 3.7). The Italian hint's "inserisci" is intended (UX-20).

### 5. Accessibility

**What is claimed.** Nothing from a browser. No contrast measurement, 320 px reflow check, real tab-order walk, screen-reader run or browser axe run has been made for any state of this section, by the designer or anyone else on record. The "Browser accessibility pass (2026-11-19)" below is **older than the sign-off round**: it drove the screens as they were before it (a mocked API, no Excel card, a VAT select with "Choose a VAT code", twelve default rows with a VAT column), so its "Passed" items describe states that no longer exist and its findings A-1 to A-11 have not been re-checked on the changed screens. It is not evidence for them. The pass is pending, owner step **T81** (with T51's section in `specs/20261119-accounting/design.md`).

**What exists instead: jsdom axe** (`refund-ui/src/test-support/axe.ts`, `expectNoAxeViolations`), with `color-contrast`, `region`, `landmark-one-main` and `page-has-heading-one` switched off, so it says the markup is well formed and nothing about contrast, reflow or real focus. Call sites per file, each after the state settled (some inside `it.each`):

| New or changed state | Where | Axe call sites |
|---|---|---|
| Split-receipt hint shown (WellD CH) with `aria-describedby` asserted, and absent (Italia, no entity chosen) | `ExpenseLineComposer.test.tsx` | 2 (the travel_km case asserts absence only, no axe) |
| VAT select on None, a VAT code cleared and its refusal, read-only group with None | `LineClassificationPanel.test.tsx`, `ReviewDetailPage.test.tsx` ("lines with no VAT code (None selected, no VAT amount), and one just cleared") | 9 and 27 (the second is the whole page in every classification state) |
| Account-only refused-approval summary, out-of-scope-only and mixed | `ReviewDetailPage.test.tsx` (its title still says "a summary of values") | within the 27 |
| Default classification card, 14 types, unusable accounts, Accounting unreadable, Retry, dialog, history | `ExpenseTypeDefaultsCard.test.tsx`, `DefaultClassificationDialog.test.tsx`, `SettingsViews.a11y.test.tsx` (14 types, no VAT) | 14, 12, 4 |
| Excel export card: ready, blocked by accounts, by missing rates, by "Accounting cannot be read", Check again, downloading, downloaded | `AccountingExportCard.test.tsx`, `BatchDetailPage.test.tsx` | 20 and 3 |

The real-browser axe calls of the e2e specs were not extended by the round (`refund-accounting.spec.ts`: 4, `refund-accounting-settings.spec.ts`: 2) and **cover none of**: the composer hint, the VAT select on None, the account-only summary, the ready Excel card. They were rewritten for the round (T73) and have **never been executed** (T81).

**Notes per screen.**

- **Defaults card and dialog.** Change and History are named after their type ("Change the default for Travel — flight"), so fourteen pairs of stops now (twelve before), plus the table's keyboard-scrollable region. One fewer pair (no designation block). The dialog is a `FormDialog` with one select; where focus lands when it opens is the library's behaviour, recorded in the earlier sync and not re-verified here.
- **Panel.** The VAT select is a labelled native select that is not `required`: a screen reader hears "VAT code" and the selected option **None**, not an unset control. A save is confirmed by the panel's `role="status"` line ("VAT code set to IPM81" / "VAT code cleared"); a refusal is a `role="alert"` under the select; the select keeps focus while saving (`aria-busy`, not `disabled`). The VAT amount is a sentence, never an empty box. The account select is unchanged (star, hint with the Default marker). Contrast of the badges and of the hint text is a pending check.
- **Refused approval.** Mechanism unchanged (assertive summary, focus on the first account select, each row a button that moves focus); only the words changed.
- **Export card.** "Download Excel file" is a real `<button>`, `aria-disabled` and described by the reason while blocked; nothing in the card announces the file type. The saved file opens in another program, so the file's own accessibility is outside this design.
- **Composer hint.** It is the hint of the Amount `Field`, so it is read when the Amount input takes focus, **not when it appears**. The Entity select comes after Amount in the form, in the DOM and in the tab order, so a keyboard user who fills the form from top to bottom has passed the Amount before choosing WellD CH; they hear the hint only on returning to it (SG-1). At 320 px the Italian sentence (about 165 characters; the English one about 140) wraps inside a column of at least 160 px and makes that row of the grid taller: **Unverified**.
- **Language.** Sentences in both languages come from `strings.ts`; numbers in the hint ("8.1 %", "8,1 %") are fixed text, not formatted.

**What the pending pass has to add for these states** (in the order of the checklist in `specs/20261119-accounting/design.md`, "Browser accessibility pass"): contrast of the account Default badge, the "(deactivated)" hint, the Rate pending badge and the hint text; the composer at 320 px in Italian; focus after choosing None and after a refused clear; the refused-approval summary with account-only rows; the ready and blocked Excel card in light and dark, English and Italian; and a real download of the `.xlsx`.

### 6. Gaps found in the sync

| # | In | Gap | Proposed answer |
|---|---|---|---|
| SG-1 | `ExpenseLineComposer`, S11 | The hint depends on the Entity, and the Entity comes **after** Amount. A keyboard or screen-reader user who fills the form in order never meets the hint where it applies; when the Entity changes, a sentence appears in the row above it and moves the grid, with no announcement. | Either ask for the Entity before Amount (a layout change that also helps the mileage field, which depends on the entity), or announce the hint's appearance through the form's existing polite status line (the one that announces the km field), or show the sentence in the form's description for both entities and drop the condition (AC-3.9 says Italian lines show no account or code, not that they may not see a sentence about VAT rates; ask the product owner). Not changed here. |
| SG-2 | `ExpenseLineRow`, edit mode | The in-place line editor of a draft has the same Amount and Entity fields and shows no hint, so an employee who edits a line, or switches it to WellD CH, never sees the sentence. SO-15 says "the expense form"; the composer is the only form that has it. | Add the same `hint` to the editor's Amount `Field` (one prop, same key), or record in SO-15 that the composer alone is meant. |
| SG-3 | `missingSummary.titleAccounts`, S8 | The summary counts out-of-scope rows (A-1) in "N lines need an account", but for those rows the approver cannot supply an account: the row says "needs a colleague with WellD CH access". A mixed refusal reads as more work for the approver than there is. | Keep the count and reword the title to "N lines need attention" with the hint carrying the account sentence, or count in-scope rows only and say how many the approver cannot fix. A copy decision for the owner. |
| SG-4 | `accountingExport.descriptionExcel` (en and it), S10 | The card says the file has "VAT code (when the line has one)". The file has no VAT column at all: AC-6.2 lists eight columns, says "no other column exists: in particular no VAT code, VAT rate, VAT amount", and AC-6.14 keeps Tax and Note empty because the accounting system cannot import VAT. An accountant reading the card would expect a VAT code that is not there. The component test pins the sentence. | Reword both languages, for example "One row per approved WellD CH expense line, with account and CHF amount, as an Excel file. VAT is not part of the file." and update `strings.test.ts` and the card test. Needs a frontend task. |
| SG-5 | `strings.ts` (it) | The Italian split-receipt hint uses the informal "inserisci", the rest of the file the impersonal "Inserire…". Intended (UX-20), but nothing in the file says so apart from the test. | Leave it; the code comment on the key already cites SO-15. Recorded so a copy review does not flag it. |

G9 (the CSV route's headers) is superseded: the file route is `…/accounting-export/file`, and the filename is still built by the client. The rest of the earlier gap list, and A-1 to A-11 of the browser pass, were not touched by the round and have not been re-checked on the changed screens.
