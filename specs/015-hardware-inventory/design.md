---
spec: 015
status: draft
---

# Design: Hardware inventory and depreciation register

Inputs read: `spec.md` (approved, 12 US / 90 ACs), `plan.md` (approved), `.claude/context/glossary.md`,
ADR-0045 / 0034 / 0030, and the source of `refund-ui/src`, `admin-ui/src`, `shell/src/components`.
The local stack was **not reachable** (`http://localhost:5173` returned no response), so the current UI
was audited from source only. The visual companion was **not used** (see the end of this file).

Terminology: the tool uses **asset** (glossary term) in navigation and in the manager/accountant
screens. The employee-facing `/devices` view and every notification say **device** (the spec allows
"device" in UI copy). "Held by" for a holder; "Awaiting confirmation" for a `pending` assignment.
Never "owner" (the entity owns the asset) and never "handover".

## Flows

Three surfaces: **T** = gated tool `/inventory/*` (`inventory-ui ./App`), **D** = ungated `/devices`
(`./MyDevices`), **S** = shell touch points. Routes below are relative to the `/inventory` basepath.
Capability shorthand: **M** = `asset:manage` (inventory manager), **L** = `ledger:manage`
(hardware accountant). A denied capability is **invisible, never disabled**. A *state* that makes an
action unavailable (for example a pending assignment) is shown aria-disabled with its reason.

| # | Flow | Covers |
|---|---|---|
| F1 | Register hardware (incl. quantity N, not-yet-received) | US-1, AC-1.1 to 1.7 |
| F2 | Receive an ordered asset | AC-1.8 |
| F3 | Assign, and cancel a pending assignment (manager side) | AC-2.1, 2.2, 2.5, 2.6, 2.10 |
| F4 | Confirm or decline an assignment (employee side) | AC-2.3, 2.4, 2.7, US-4 |
| F5 | Return, repair, repair done, lost, found | US-3, AC-3.1 to 3.5, AC-7.6 |
| F6 | Edit details, location note, supplier, invoice reference; clear "to verify" | AC-3.6, 5.9, 9.1 to 9.3, 10.1, 12.6, 12.10 |
| F7 | Find assets (filters, invoice reference, "to verify") | AC-3.7, 10.3, 12.10 |
| F8 | Invoice file: upload, link to sibling assets, open | US-10, AC-10.4 to 10.7 |
| F9 | Read an asset's ledger (rule, schedule, book value) | US-5, AC-5.8 |
| F10 | Dispose of an asset | US-7 |
| F11 | Depreciation rules: read history, add a rule | US-6 |
| F12 | Fiscal years: roll-forward, close, export XLSX | US-8 |
| F13 | Read an asset's history | US-11 |
| F14 | My devices (view, empty state) | US-4, AC-4.1, 4.2, 4.4 |
| F15 | Navigation and capability composition | US-9, AC-9.1 to 9.6 |
| F16 | Notification arrives and links in | AC-2.8, 2.9 |

16 flows. Each step list ends with its success and error exits; the error copy is in
"Error and conflict catalogue".

### F1 Register hardware (M)
Entry: Assets list -> "Register asset" (`/assets/new`). Direct URL by a user without M -> in-place
`PermissionDenied` (UX-only; the server 403 is the gate).
1. Fill the form (Screen T3). Currency is shown as read-only text derived from entity (AC-1.2).
2. Quantity > 1 shows a derived breakdown line ("13 assets, 76.78 each, last one 76.79"; AC-1.3 outcome
   made visible, computed by the shared `splitPrice`, never in the component).
3. Submit. Button goes `aria-busy`, fields stay editable-locked until the response.
4. Success: N = 1 -> asset detail, heading focused, status line "Asset registered." N > 1 -> Assets list
   with a status line "13 assets registered." (the list is not filtered).
5. Exits: 422 field errors (summary + inline), `serial_conflict`, `fiscal_year_closed` (both inline on
   their field), 403 entity out of scope (form-level alert), 503 and network failure.
   **Network failure after submit is ambiguous (the POST is not idempotent and may have created N
   assets):** the alert says "We could not confirm the registration. Check the asset list before
   trying again." and the form is kept.
6. Cancel -> back to the list with focus on the "Register asset" button.

### F2 Receive an ordered asset (M)
Detail of an `ordered` asset -> "Mark as received" (one click, no dialog) -> status `in_stock`, status line
"Marked as received." Error: `invalid_transition` -> guardrail + refetch.

### F3 Assign and cancel a pending assignment (M)
1. Detail of an `in_stock` asset with no pending assignment -> "Assign..." opens `AssignDialog`.
2. Pick a holder (searchable list of active users from the directory) -> "Assign".
3. Success: dialog closes, detail shows the pending callout ("Awaiting confirmation from {name}, offered
   {date}, {n} days ago"). Status stays `in_stock` (AC-2.1). No expiry wording anywhere (AC-2.6).
4. While pending: "Assign..." and Repair / Lost are not rendered (AC-2.2); the callout carries
   "Cancel assignment" (a `ConfirmDeleteModal` stating the consequence; AC-2.5). After cancel the asset
   is `in_stock` with no holder and "Assign..." returns.
5. Exits: `assignment_pending` (race), `invalid_transition`, `unknown_user` (picked account became
   inactive), directory 429, 503.
The "Assign..." entry is also not rendered for any status other than `in_stock` (AC-2.10).

### F4 Confirm or decline (employee; screen D)
1. Entry: shell UserMenu "My devices" or a notification link (`/devices`).
2. A "Waiting for your confirmation" card shows description, category, serial, offered date.
3. "I have received this device" confirms in one click (a recorded click, per the spec's non-goal of a
   signed document). The card becomes a device in "Devices I hold".
4. "Decline" opens a confirm dialog ("{description} returns to stock and the inventory manager is
   told you declined it."). Confirm -> card removed.
5. Exits: 404 / `assignment_not_pending` -> "This assignment is no longer open." and the list reloads
   (the manager may have cancelled it).
(Open question Q3 on whether Confirm should also take a dialog.)

### F5 Return, repair, repair done, lost, found (M)
Actions available per status (all other transitions are not rendered):

| Status | Actions |
|---|---|
| `ordered` | Mark as received |
| `in_stock`, no pending | Assign..., Mark in repair, Mark lost |
| `in_stock`, pending | Cancel assignment (callout) only |
| `assigned` | Record return, Mark in repair, Mark lost |
| `in_repair` | Repair finished, Mark lost |
| `lost` | Mark found |
| `disposed` | none |

"Record return" and "Mark lost" use `ConfirmDeleteModal` (neutral tone for return, destructive tone for
lost) with the consequence ("{Name} is no longer recorded as holder", "Lost assets stay on the books; the
holder is cleared and is not restored by Mark found"). The other four act on one click. Exit errors:
`invalid_transition {from}`, `assignment_pending`, `asset_disposed` -> `GuardrailDialog` + refetch.

### F6 Edit details (M, and L for two fields)
"Edit details" opens `EditAssetDialog`. **The field set depends on capability** (fields are absent, not
disabled): M gets category, description, serial number, purchase date, purchase price, supplier,
invoice reference, location/note; L-only gets supplier and invoice reference only (AC-9.3, AC-10.1);
M+L gets the M set. Entity and currency are shown as read-only text (AC-1.9). "Mark as verified" (M) is
a one-click action in the "To verify" chip's callout (clears the mark, AC-12.6). Exits: 422 field,
`serial_conflict`, `fiscal_year_closed {year}` (price/date only, shown as a banner at the top of the
dialog, the two fields stay visible but the dialog explains why they cannot change), `asset_disposed`.
Disposed assets render no edit entry at all (AC-7.1).

### F7 Find assets (M and L)
Assets list (T1). Filters: Status, Category, Entity (only when two entities are in scope), Holder (M
only), "To verify" checkbox, Invoice reference. Filters live in the URL search params
(shareable, survives back). Empty result keeps the filters and offers "Clear filters".

### F8 Invoice file (M and L)
1. Detail -> Invoice panel. Precondition: the asset has an invoice reference (the mint call requires it).
   Without one the upload button is `aria-disabled` with the reason "Set an invoice reference first" and
   a link-button to edit.
2. "Upload invoice" -> native file picker. The client checks type and size first (same rule as
   `validateFileForUpload`); a rejected file is shown with its reason, never silently dropped.
3. Per-file phase announced politely: uploading -> saved / failed (mint -> bucket -> confirm collapses to
   one "uploading" span, as `AttachmentList` does).
4. After a successful upload the panel offers "Link to other assets with the same invoice reference":
   a checklist of sibling assets (`GET /assets?invoiceRef=`) not yet linked; "Link selected" ->
   `PUT /invoice-files/{id}/assets`.
5. "Open invoice" fetches a 60 s presigned URL and opens it in a new tab (`AttachmentDownloadLink`
   behaviour); a stale URL is re-minted on the next click.
6. Exits: client/server 413, 415, `upload_not_found`, `invoice_ref_mismatch {assetId}`, 404.
Not designed (no endpoint, see gaps): remove or replace a file.

### F9 Ledger (L)
Detail -> "Ledger" block: book value today, the rule applied, the schedule table, and "Dispose..." (F10).
A manager-only user never receives this block (the server omits `ledger`; the client renders nothing,
not an empty block).

### F10 Dispose (L)
1. Ledger block -> "Dispose..." opens `IrreversibleActionDialog` (dispose form: date, reason,
   sale price when reason is `sold` or `ceded_to_employee`).
2. The dialog states the consequence and requires the acknowledgement checkbox. Confirm is disabled
   until valid and acknowledged.
3. Success: the dialog closes, the detail re-renders as disposed (book value zero, no actions, a
   "Disposed on {date}, {reason}" panel), focus goes to the page heading.
4. If a pending assignment exists the button is `aria-disabled` with "Cancel the pending assignment to
   {name} first. Only an inventory manager can do that." (AC-7.5). The server 409 `assignment_pending`
   is still handled inline for the race.
5. Exits: `fiscal_year_closed`, `disposed_before_purchase`, `sale_price_not_allowed` (prevented by
   hiding the field for other reasons), `asset_disposed`, 503.

### F11 Rules (L)
Rules screen (T4): one section per in-scope entity, each a table of every rule (past, in force, future)
with "New rule". "New rule" opens `IrreversibleActionDialog` with the rule form. On success the new row
appears, focus moves to it, status line "Rule added. It applies to purchases from {date}." No edit or
delete anywhere (AC-6.5). Exits: 422 with `field`, 409 `fiscal_year_closed`, 503.

### F12 Fiscal years (L)
1. Fiscal years screen (T5): one section per in-scope entity listing years (year, Open/Closed, closed
   on). Each row links to the year detail (T6).
2. Year detail: roll-forward statement (five lines), per-asset table, "Export XLSX" and, for an open
   year, "Close year".
3. Close: `IrreversibleActionDialog` shows the five lines and the consequence; acknowledgement; confirm.
   Success: page re-renders closed, the "Provisional" banner and the Close button disappear, focus to the
   heading.
4. If `closable` is false the Close button is `aria-disabled` "Close {year-1} first." (AC-8.5).
5. Export: browser-side `exceljs` (lazy chunk). An open year exports marked provisional (AC-8.9).
6. Exits: `previous_year_open`, `already_closed`, `nothing_to_close`, 404 (year outside scope), 503,
   export build failure.

### F13 History (M and L)
Detail -> "History" section: chronological list, oldest first (AC-11.3). Read-only; no edit/delete
control exists (AC-11.2).

### F14 My devices (every signed-in user)
Screen D1. Sections "Waiting for your confirmation" (hidden when empty) and "Devices I hold". No money
figures at all (AC-4.2). The explicit empty state covers "nothing at all" (AC-4.4).

### F15 Navigation and composition (S + T)
Sidebar "Inventory" appears only with `inventory:access` (AC-9.6). Inside the tool the tab bar is
`Assets` (always), `Depreciation rules` and `Fiscal years` (L only). The Register button is M only.
A user with neither capability never sees the tool; `/devices` stays reachable from the UserMenu.

### F16 Notifications (S)
Assignment created -> assignee gets an in-app notification linking to `/devices`. Confirm or decline ->
the creating manager gets one linking to `/inventory/assets/{id}`. Copy in "Shell touch points".

## Screens & states

Every screen shares one convention for the cross-cutting states, defined once here and referenced below:

- **Loading**: `SkeletonListRows` plus an `sr-only` `aria-live="polite"` line ("Loading assets").
- **Failed to fetch**: `ErrorBanner` (`role="alert"`) with Retry, using the RFC 7807 `detail`.
- **403 (capability absent)**: `PermissionDenied` in place of the content, no Retry (not transient).
- **503 fail-closed (`auth` unavailable)**: an `ErrorBanner` variant with its own heading "Authorization
  service unavailable" and body "We cannot verify your access right now. Nothing was changed." plus
  Retry. For a write, the dialog stays open with the same alert and keeps every typed value.
  The 503 never occurs on `/devices` (`/me/*` has no `auth` dependency, ADR-0045).
- **404 on a record**: one in-place "Not found" page for both "does not exist" and "outside your
  scope" (no existence leak, ADR-0014); focus on its heading.
- **Remote failed to load**: shell `RemoteMount` failure (`role="alert"` + Retry, chrome untouched),
  for `/inventory` with module label "Inventory" and for `/devices` with "My devices" (ADR-0030).
- **Capability tabs while permissions load**: `usePermissions()` returns empty first, so the L tabs
  and the Register button appear a tick late (the `RefundShell` precedent). A deep link to a hidden tab
  by a user without the capability lands on `PermissionDenied`.

### T0 InventoryShell
Heading "Inventory" (h1, Syne), tab nav `aria-label` "Inventory sections": Assets / Depreciation rules /
Fiscal years, active tab `aria-current="page"`. `/inventory` index redirects to `/assets`.

### T1 Assets list (`/assets`) - M and L
```
Assets                                              [Register asset]   (M only)
[Status v] [Category v] [Entity v*] [Holder: any v**] [x To verify] [Invoice ref ____]
Showing 24 assets - more available                                      * 2 entities in scope
                                                                        ** M only
Description / category / serial   Entity  Status         Held by   Purchased   Price      Book value***
MacBook Pro 14  laptop  SN123     CH      ● Assigned     A. Rossi  2026-09-25  CHF 998.15  CHF 998.15
 invoice INV-77 . ⚑ To verify                                                              *** L only
                                          [ Load more ]
```
- Columns: Description (row header, link to detail; category, serial, invoice reference and the
  "To verify" chip as secondary text), Entity (hidden if one entity in scope), Status (badge, plus the
  "Awaiting confirmation" chip on an `in_stock` row with a pending assignment), Held by, Purchase date,
  Purchase price, Book value (L only, from `ledger.bookValueCents`).
- Sorted as the API returns (see gap G5: the order must be defined). No client sort, no row actions:
  every action lives on the detail screen, so there are no dead row controls and no row-action focus
  problem.
- Pagination is cursor-based: "Load more" appends.
- States:
  - Loading: skeleton rows. Failed/403/503: as above.
  - Empty, nothing registered, M: "No assets yet." + "Register asset". Empty, L-only: "No assets in
    your scope yet." (no CTA, an accountant cannot register). Both add: "Assets of an entity you are
    not scoped to are not shown."
  - Empty after filters: "No assets match these filters." + "Clear filters".
  - "To verify" filter empty: "Nothing left to verify." (positive copy, AC-12.10).

### T2 Asset detail (`/assets/$id`) - M and L
Regions, each present iff its capability is held (this is how the two roles coexist on one screen):

| Region | Content | Visible to |
|---|---|---|
| Header | description, `AssetStatusBadge`, pending chip, "To verify" chip, entity + currency | M or L |
| Status line | polite result of the last action | M or L |
| Action bar | the status actions of the F5 table, "Edit details" | M (L-only: just "Edit invoice details") |
| Pending callout | pending assignee, offered date, age, "Cancel assignment" (M only) | M or L (button M only) |
| Holder-deleted callout | "{name}'s account was deleted. Record the return to put this asset back in stock." with "Record return" | M or L (button M only) |
| Facts | category, serial, purchase date, purchase price, holder, location/note, supplier | M or L |
| Invoice panel | reference, file, link siblings | M or L |
| Ledger block | book value, rule applied, schedule table, **Dispose...** | L only |
| Disposal panel | date, reason, sale price | M or L (read-only) |
| History | `HistoryTimeline` | M or L |

Union user = union of the rows. Operational actions are in the header action bar; the one accounting
action (Dispose) lives **inside the Ledger block** with destructive styling. The two groups are therefore
spatially separate, each labelled by its own heading, so neither role scans past the other's controls.
Manager-only sees no Ledger block, no Dispose, no book value, no rule (AC-9.2). Accountant-only sees no
action bar apart from "Edit invoice details", no Assign, no Register (AC-9.3).

Ledger block detail: "Book value today" figure; "Rule applied: life 3 y, full first year, no threshold,
residual CHF 1.00"; schedule table (Year, Depreciation, Book value at year end, State: Closed or Open);
for an imported asset the closed years show the sheet figures (the server marks them `closed: true`).
A disposed asset shows its schedule up to the disposal year and a "Disposed" row with zero book value.
Purchase price for an `ordered` asset is shown the same way (AC-5.7).

States: Loading skeleton of the facts grid; 404 "Asset not found" (also out of scope); 403 only if
neither capability (cannot happen behind T0 but handled); disposed (all action regions absent, banner
"Disposed on {date}. This asset can no longer be changed."); history load failure is local to the
History section (inline `ErrorBanner` + Retry) so the rest of the page stays usable.

### T3 Register asset (`/assets/new`) - M
Fields (labels always visible, errors under the field with `aria-describedby`): Entity (select, or a
fixed read-only value when the grant is scoped to one entity), Category (select), Description (text,
required), Purchase date (date input), Total price (money input, currency shown as a read-only suffix),
Quantity (number 1 to 200, default 1), Serial number(s) (one input for N = 1; a textarea, one per line,
for N > 1, line k belongs to unit k, blank lines skip a unit), "Not yet received" checkbox, Supplier,
Invoice reference, Location / note. A validation summary (`SubmitValidationSummary` pattern) lists
errors with links to the fields. States: submitting, success (F1), 422/409/403/503/network (catalogue),
no empty/loading state (static form).

### T4 Depreciation rules (`/rules`) - L
One section per in-scope entity (the `MileageRatesPage` layout), heading with `EntityBadge`.
Table columns: Effective from, Useful life (years), First-year share (Full / Half), Low-value threshold
(amount or "None"), Residual value, Added by, Added on, Status (`In force` / `Scheduled` / `Superseded`;
In force from `inForceId`, Scheduled when `effectiveFrom` is after today). The row in force is
visually marked and carries text, not colour alone. "New rule" per section; no edit or delete.
States: loading skeleton per section; section empty "No rule is configured for {entity}." (the launch
seed makes this unreachable, kept for safety); error/403/503 as above.
`createdBy` for the seeded launch rules resolves to an unknown identity; show "System" (gap G9).

### T5 Fiscal years (`/years`) - L
One section per in-scope entity, a table of years, newest first: Year, Status (`Open` / `Closed`),
Closed on, link "Open". States: loading, per-entity empty ("No fiscal years yet. A year appears once
{entity} has assets."), error/403/503.

### T6 Fiscal year detail (`/years/$entity/$year`) - L
```
[CH] Fiscal year 2026   ◌ Open                         [Export XLSX] [Close year]
Provisional: figures change until this year is closed.            (open years)
Roll-forward (CHF)
  Opening book value        21,689.00
  less Disposals               530.00
  plus Purchases            18,295.89
  less Depreciation         22,458.31
  = Closing book value      16,996.58
Per-asset table: Purchase date, Description, Serial, Held by, Purchase price, Depreciation, Disposal, Closing
```
The five lines are a two-column table (`<th scope="row">` + amount), with words as well as signs
("less", "plus"), because a lone "-" is unreliable for screen readers. A closed year shows "Closed on
{date} by {name}" and no Close button; there is no reopen control anywhere. States: loading, 404 (year
before the entity's first year or out of scope), error/403/503, export-in-progress (`aria-busy`,
"Preparing file..."), export failure (inline alert), empty per-asset table ("No assets in this year").

### D1 My devices (`/devices`) - every signed-in user
```
My devices
Waiting for your confirmation (1)
  MacBook Pro 14 . laptop . SN123 . offered 2026-10-06
  [ I have received this device ]  [ Decline ]
Devices I hold (2)
  Dell U2723QE . monitor . SN456 . assigned 2026-03-12
```
Cards (`DeviceCard`), no price, no book value, no entity. States: loading skeleton + polite announce;
empty (nothing at all): "You have no devices assigned to you, and nothing is waiting for your
confirmation."; no pending: the first section is omitted; pending only: "Devices I hold" shows "You do
not hold any devices yet."; fetch error: `ErrorBanner` + Retry; confirm/decline conflict (404 or
`assignment_not_pending`): inline alert on that card, list reloads. No 403/503 branch.

### Dialogs
| Dialog | Based on | Content | Default focus |
|---|---|---|---|
| `AssignDialog` | NEW composition over `Combobox` | holder picker, consequence line | picker input |
| `EditAssetDialog` | `AddRateEntryModal` form pattern | fields per capability | first field |
| Return / Lost / Cancel assignment / Decline | `ConfirmDeleteModal` (title, body, tone props) | consequence copy | Cancel |
| Conflict acknowledgements | `GuardrailDialog` | message, "OK" then refetch | OK |
| Dispose, New rule, Close year | NEW `IrreversibleActionDialog` | see below | first field, else Cancel |

#### Irreversible actions (dispose, new rule, close year)
Shared shape: title, optional form fields, a consequence paragraph, the acknowledgement checkbox whose
label is the full sentence, Cancel, Confirm (disabled until the form is valid and the box checked; the
label names the act, never "OK"). Escape and the backdrop cancel; while the request is in flight the
dialog cannot be dismissed.

| Act | Consequence copy (the substance, not final wording) | Acknowledgement | Confirm |
|---|---|---|---|
| Dispose | "{description} comes off {Entity}'s books on {date}. Its book value becomes {CHF 0.00}, it is removed from {holder}, and it can no longer be assigned, repaired or edited. This cannot be undone." | "I understand this cannot be undone." | "Dispose asset" |
| New rule | "From {date}, every {Entity} asset bought on or after {date}, including assets already registered, is scheduled by this rule. Assets bought earlier keep their schedule. A saved rule cannot be edited or deleted; a correction is a new rule." | "I understand this rule cannot be changed afterwards." | "Add rule" |
| Close year | the five roll-forward lines, then "Closing {year} for {Entity} freezes this statement and every asset's figures. Dates in {year} and earlier can no longer be used for new assets, edits, disposals or rules. A closed year cannot be reopened; corrections are booked in the open year." | "I understand a closed year cannot be reopened." | "Close {year}" |

Form fields: Dispose = disposal date (default today, min = purchase date), reason (radio group of the five
reasons, `lost` labelled "Written off as lost"), sale price (appears only for sold or ceded, optional).
New rule = effective date, useful life (years, whole number >= 1), first-year share (radio Full / Half),
low-value threshold (optional money, empty means none), residual value (money >= 0), with the rule
currently in force shown beside it for comparison.

## Error and conflict catalogue

| Code / status | Where | Presentation and copy | Recovery |
|---|---|---|---|
| 422 validation | T3, EditAssetDialog, rule, dispose | inline under field + summary (T3); rule errors use the response `field` | fix and resubmit |
| `serial_conflict {serialNumber}` | T3, Edit | field error: "Serial number {sn} is already used by an active asset of this entity." | change serial |
| `fiscal_year_closed {year}` | T3 date, Edit price/date, dispose date, rule date | field error: "{year} is closed for {Entity}. Choose a date in an open year." Edit price/date: dialog banner "Price and purchase date cannot change because {year} is closed." | change date / cancel |
| `assignment_pending` | Lost, Repair, Dispose, Assign | those actions are pre-empted when the pending state is known; on a race `GuardrailDialog`: "This asset has a pending assignment to {name}. Cancel it first." | refetch |
| `invalid_transition {from}` | every status action, Assign | `GuardrailDialog`: "This asset is now {from}; someone else changed it. The page has been refreshed." | refetch |
| `asset_disposed` | every action and edit | `GuardrailDialog`: "This asset has been disposed of and can no longer be changed." | refetch |
| `previous_year_open` | Close year | inline in dialog: "Close {year-1} first." (also pre-empted via `closable`) | close prior year |
| `already_closed` | Close year | `GuardrailDialog`: "{year} is already closed." | refetch |
| `nothing_to_close` | Close year | inline in dialog: "{year} has no assets to close." | cancel |
| `disposed_before_purchase` | Dispose date | field error: "The disposal date cannot be before the purchase date ({date})." | change date |
| `sale_price_not_allowed` | Dispose | prevented (field hidden for other reasons); if returned, form alert | change reason |
| `invoice_ref_mismatch {assetId}` | Link siblings | inline: "{asset} has a different invoice reference and was not linked." | refresh list |
| `upload_not_found` | Invoice upload | per-file failed: "The upload did not complete. Try again." | retry |
| 413 | Invoice upload | "This file is larger than 10 MiB." (pre-checked on the client too) | pick another |
| 415 | Invoice upload | "Only PDF, JPEG or PNG files can be uploaded." (pre-checked) | pick another |
| `unknown_user` 422 | Assign | "That person can no longer receive devices." | pick another |
| 429 (directory) | Assign picker, holder filter | in the list area: "Too many lookups. Try again in {n} seconds." (`Retry-After`) | wait |
| `assignment_not_pending` / 404 | Employee confirm/decline, Cancel assignment | card/callout alert: "This assignment is no longer open." then list reloads | none |
| 403 | any gated route | `PermissionDenied` | none |
| 404 | detail, year | "Not found" page | back to list |
| 503 | any gated route or write | "Authorization service unavailable" banner | Retry |
| network / unknown | any | `ErrorBanner` + Retry; writes keep input | Retry |

## Component inventory

Library in use: **Tailwind CSS 4 plus a bespoke component set on the Operai CSS variables**
(`--ink-soft`, `--rule`, `--acc`, `--grn`, `--red`, `--org`, `--soft`, `--muted`, `--text`, `--disp`,
`--body`), per `refund-ui/package.json` and the source. There is no Mantine, MUI or other component
library, and no table or data-grid component in any remote. `inventory-ui` cannot import another
remote's source across the Module Federation boundary (ADR-0006), so "reuse" here follows the
established precedent: **re-author the existing component into `inventory-ui/src/components` keeping its
props and behaviour** (`refund-ui`'s own `ErrorBanner`/`PermissionDenied` do exactly this from admin-ui).

### Reuse (ported or consumed as-is): 21

| Element | Reuse from |
|---|---|
| Tool root layout + tab nav | `refund-ui/src/components/RefundShell.tsx` (`usePermissions()` capability tabs) |
| Fetch error | `refund-ui/src/components/ErrorBanner.tsx` (adds the 503 heading as a prop-level variant, no new component) |
| 403 state | `refund-ui/src/components/PermissionDenied.tsx` |
| Loading rows | `refund-ui/src/components/SkeletonListRows.tsx` |
| Confirm dialogs (return, lost, cancel assignment, decline) | `refund-ui/src/components/ConfirmDeleteModal.tsx` (generic title/body/tone props) |
| Conflict acknowledgement | `refund-ui/src/components/GuardrailDialog.tsx` |
| Entity chip | `refund-ui/src/components/EntityBadge.tsx` |
| Currency chip / suffix | `refund-ui/src/components/CurrencyBadge.tsx` |
| Money display | `refund-ui/src/lib/money.ts` `formatMoney` (EUR/CHF supported) |
| Amount parsing for money inputs | port the helper from `refund-ui/src/lib/lineDraft.ts` (to verify it fits; `money.ts` has no parser) |
| Date display | `refund-ui/src/lib/dates.ts` |
| Invoice file open | `refund-ui/src/components/AttachmentDownloadLink.tsx` |
| Upload rules (10 MiB, pdf/jpeg/png) | `refund-ui/src/lib/attachmentsApi.ts` `validateFileForUpload` + the mint/bucket/confirm sequence |
| Validation summary on T3 | `refund-ui/src/components/SubmitValidationSummary.tsx` |
| Holder picker and holder filter | `admin-ui/src/components/Combobox.tsx` |
| "In force" badge on rules | `admin-ui/src/components/RateInEffectBadge.tsx` |
| Rules screen layout (per-entity, append-only, Added by/on) | `admin-ui/src/pages/MileageRatesPage.tsx` |
| Form modal pattern | `admin-ui/src/components/AddRateEntryModal.tsx` |
| Not-found page | `refund-ui/src/pages/NotFoundPage.tsx` |
| Remote boundary for `/inventory` and `/devices` | `shell/src/components/RemoteMount.tsx` (unchanged) |
| Sidebar entry, UserMenu link, bell, toast | `shell/src/lib/tools.ts` + `Sidebar.tsx`, `UserMenu.tsx`, `Bell.tsx`, `ToastHost.tsx` (a one-line `TOOLS` entry and one menu row) |

### NEW: 10 components (+ 1 hook)

| Component | Why nothing existing fits |
|---|---|
| `AssetStatusBadge` | six new variants (`ordered`, `in_stock`, `assigned`, `in_repair`, `lost`, `disposed`); `RequestStatusBadge`/`BatchStatusBadge` have other value sets. Same glyph + text + colour convention: ⇢ Ordered, ▢ In stock, ● Assigned, ⚙ In repair, ⚠ Lost, ⌀ Disposed (all distinct glyphs; the "Awaiting confirmation" chip uses ⏳, the "To verify" chip ⚑) |
| `AssetFilterBar` | no list screen in any remote has filters (`ReviewQueuePage` has none); native selects, checkbox and text input bound to URL search params |
| `LoadMore` | `admin-ui` `Pagination` is page-number + total based; the API is cursor-only (`nextCursor`) |
| `IrreversibleActionDialog` | generalises `MarkPaidDialog` (checkbox-acknowledged, trapped tab sequence) which is hard-wired to batch subtotals; three acts here need it, plus a form slot (a fourth copy would be worse) |
| `DataTable` | no table primitive exists; `MileageRatesPage` inlines one. Six tables here need the same caption, `scope`, numeric right-alignment and responsive scroll wrapper |
| `ScheduleTable` | per-asset yearly schedule with a Closed/Open state column and a book-value column; domain presentation over `DataTable` |
| `RollForwardStatement` | the five-line statement as a labelled table with words and signs; `BatchSubtotalsPanel` is a per-currency subtotal list with different semantics |
| `HistoryTimeline` | an ordered list of events with actor, time and old to new value; no timeline exists (the admin audit log is a paged table of a different shape) |
| `InvoiceFilePanel` | single immutable file per asset with sibling linking; `AttachmentList` is multi-file per expense line with remove |
| `DeviceCard` | employee-facing list item with the confirm/decline actions and no money; no card component exists |
| hook `useInventoryCapabilities()` | derives `{canManageAssets, canManageLedger}` from `usePermissions()` once, so every screen gates the same way; a hook, not a component |

Reuse/NEW ratio: **21 reuse : 10 NEW components** (about 2:1), plus 7 new pages that no existing page
covers: Assets, Register, Asset detail, Rules, Fiscal years, Fiscal year detail, My devices. Shell
changes are additive (`TOOLS` entry, `/devices` route per ADR-0045, one UserMenu row).
No NEW component duplicates an existing one under another name; `IrreversibleActionDialog` is a
deliberate generalisation and the plan should not leave `MarkPaidDialog` as its only twin in refund-ui.

### Strings and numbers
Every string through `inventory-ui/src/strings.ts` with a `noHardcodedStrings` test (as `refund-ui`).
Namespaces: `nav`, `pages.{assets,register,assetDetail,rules,years,yearDetail,myDevices}`, `badges.assetStatus`,
`actions`, `dialogs.{assign,edit,return,lost,cancelAssignment,decline,dispose,newRule,closeYear}`,
`errors.<code>`, `empty.*`, `history.<action>`, `categories`, `disposalReasons`. Money via `formatMoney`
from integer cents, always with the currency code; schedule/roll-forward figures only displayed, never
computed in components (the shared `schedule-vectors.json` rule). Italian: see Q1.

## Shell touch points

- **Sidebar**: `TOOLS` gains `{ id: 'inventory', label: 'Inventory', to: '/inventory' }`, shown only with
  `inventory:access`. `/devices` is not in `TOOLS`, so no sidebar entry is active on it.
- **UserMenu**: a "My devices" row (`role="menuitem"`, a real `<Link to="/devices">`) directly after "My profile",
  copy `{ en: 'My devices', it: 'I miei dispositivi' }` through the menu's existing `COPY`/`resolveLocale`.
  Visible to every signed-in user.
- **Notifications** (AC-2.8, 2.9; composed by `inventory-api`, link targets fixed by the plan):
  - assignee, link `/devices`: "A device is waiting for your confirmation" / "{description} has been
    assigned to you. Confirm that you received it."
  - manager, link `/inventory/assets/{id}`: "Assignment confirmed" / "{name} confirmed receipt of
    {description}." and "Assignment declined" / "{name} declined {description}. It is back in stock."
  The `/devices` link lands on the page, not on one card (no per-card anchor in the contract; the list
  is short).

## Accessibility

Applies everywhere: native elements first (`<button>`, `<a>`, `<table>`, `<select>`, `<input type="date">`);
one `h1` per page (the tool heading in T0; on `/devices` the page heading, at the same level as
`AccountScreen`'s, to be verified); `h2` per section; skip-to-content stays the shell's.
Status of an action is announced through one polite `role="status"` line per page; errors use
`role="alert"`.

**Badges and chips** (all screens): text is always present and is the accessible name; the glyph is
`aria-hidden`; no information is carried by colour alone; the six asset states have six different glyphs.
Contrast to verify in both themes: badge text on its 10% tint (notably `--soft` for Ordered and
Disposed, `--org` for In repair and To verify) at 4.5:1, and the focus ring at 3:1 against `--ink-soft`
(the `ring-acc/50` used in the shell may fall short on the dark ink).

**Data tables** (T1, T4, T5, T6, ScheduleTable, roll-forward): `<caption>` (sr-only) naming the table and
the active filters; `<th scope="col">`; the description/year is `<th scope="row">`; amounts right-aligned
in DM Mono with `tabular-nums`, each with its currency code; no sortable columns, so no `aria-sort`;
wider than the viewport -> a scroll wrapper with `tabindex="0"`, `role="region"` and an `aria-label`.
The roll-forward is a table whose row headers read "Opening book value", "Disposals (subtracted)", etc.

**T0 shell and tabs**: tab nav is a `nav` landmark with a label; links in tab order; active
`aria-current="page"`; capability-hidden tabs are absent from the DOM.

**T1 list**: filters are a labelled `form role="search"`; each control has a visible label; the invoice
reference applies on Enter or after a 300 ms pause; a polite status line announces "N assets shown" after
each change; focus stays in the control that changed. "Load more" keeps focus on its button and announces
"{n} more assets loaded"; when the last page loads the button is removed and focus moves to the last
loaded row's link. Keyboard path: skip link -> tabs -> Register -> filters -> table links -> Load more.

**T2 detail**: action bar buttons are real buttons in a `role="group"` labelled "Asset actions"; Ledger
block is a `section` with its own heading containing Dispose, so a screen reader user reaches
accounting controls only under that heading. After a one-click action (receive, repair, found) the
trigger may disappear: focus moves to the page heading (`tabIndex=-1`) and the status line announces the
outcome. After a dialog closes, focus returns to its trigger if it still exists, else to the heading.
The pending callout and the holder-deleted callout are `role="status"`. `aria-disabled` buttons (Dispose
with a pending assignment, Upload without an invoice reference, Close year when not closable) stay
focusable and reference their reason via `aria-describedby`; activation is a no-op.
History is an `<ol>`; each entry has a `<time datetime>`.

**T3 form**: labels via `<label for>`; required marked in text ("required") not only by an asterisk;
errors `aria-describedby` + `aria-invalid`; on a failed submit focus moves to the validation summary,
whose entries link to the fields; the live quantity breakdown is `aria-live="polite"`; the currency suffix
is part of the label ("Total price, CHF").

**Dialogs** (`alertdialog` for the confirm and irreversible kinds, `dialog` for Assign and Edit):
`aria-modal`, labelled and described by title and consequence; full Tab trap over the real focusable set
(disabled Confirm excluded, as in `MarkPaidDialog`); Escape cancels; default focus per the dialog table
(Cancel for pure confirms and for the checkbox-only Close year; first field for forms). The
acknowledgement checkbox label is the whole sentence. Closing returns focus as described for T2.
In-flight: buttons `aria-busy`, dialog not dismissible.

**Holder picker (`Combobox`)**: ARIA combobox/listbox as in admin-ui; each option reads "Name, email,
entity"; loading, "No active users match" and the 429 message render inside the listbox region and are
announced.

**Invoice panel**: file input reachable by keyboard through the button (hidden input pattern of
`AttachmentList`); a polite per-file status; a rejected file's reason is rendered next to it and stays
until dismissed; the sibling list is a checkbox group with a legend ("Link to assets with invoice
reference {ref}") and a live count of selected items.

**T4 rules**: "New rule" is a button in each section's heading, labelled with the entity ("New rule for
WellD CH"), so the two buttons are distinguishable out of context. After adding, focus moves to the new
row's header cell, which has `tabIndex=-1`.

**T6 year detail**: Provisional banner is `role="status"`. Export: button `aria-busy` while building,
polite "File ready" / alert on failure; the browser's download takes over. Close year: after success
focus to the page heading, the banner and button are gone.

**D1 my devices**: sections are labelled landmarks via headings with counts; cards are a `<ul>`; each
card's actions are named with the device ("Confirm receipt of MacBook Pro 14"). After Confirm, focus
moves to the heading of the card that just appeared under "Devices I hold" and a polite line says
"Confirmed: {description}". After Decline, focus moves to the next pending card's heading, else to the
page heading, with "Declined: {description}". A failed action keeps focus on the same card's alert.
Empty state is plain text in the page flow (not an `alert`).

**Remote load failure**: `RemoteMount`'s alert owns focus announcement (existing behaviour), with
Retry reachable first.

**Mobile (phone width)**: tables get the scroll wrapper; D1 cards stack with full-width actions of at
least 44 px; the filter bar wraps into one column.

## Coverage against the spec

- **ACs with no UI surface by design**: AC-2.7, AC-4.3, AC-9.7 (server enforced); AC-5.1 to 5.4, 5.6, 5.7
  (computation, only their output is displayed); AC-6.2, 6.5 (no edit/delete control is the surface);
  AC-8.3, 8.6, 8.7 (property of stored data; absence of a reopen control); AC-11.2 (absence of edit);
  AC-12.1 to 12.5, 12.8, 12.9 (one-off import script, no import screen, per the non-goal);
  AC-12.6, 12.7 surface only as the "To verify" chip and the location/note text.
- **UI that no AC asks for (scope creep, reported not designed)**: free-text `q` search on `GET /assets`
  (plan only); a holder filter for an accountant-only user (needs the manager-gated directory); a
  derived "holder periods" summary (AC-11.4 is satisfied by the timeline); a "how many assets does this
  rule affect" preview (no endpoint); bulk actions; remove/replace of an invoice file; any per-card
  deep link on `/devices`. The live quantity breakdown on T3 is a display of the AC-1.3 outcome and is
  kept; say so in review if it is unwanted.
- **Explicit non-goals respected**: no import screen, no reopen control, no reminders or expiry
  wording on pending assignments, no signed handover, no external holders (the picker lists Operai
  accounts only), no per-category rules, no entity change on an asset (read-only).

## Gaps found in the spec or the plan

- **G1 (plan)**: the client has no way to know which entities the caller is scoped to. The register form,
  the entity filter, the Rules screen and the Fiscal years screen need it, and `GET /rules?entity` and
  `GET /fiscal-years?entity` return 404 for an out-of-scope entity. `usePermissions()` exposes conditions
  as opaque. Recommend one cheap read (either capability), for example `GET /scope` returning
  `{ entities: Entity[] }`, and that `entity` be optional on `/rules` and `/fiscal-years` (omitted = all
  in-scope entities). Until then the design shows a section per entity and relies on 404 handling.
- **G2 (plan)**: `GET /assets/{id}/history` returns `oldValue`/`newValue` as untyped JSON. The per-action
  value shape (especially `edited`: which field, old, new) must be defined or the timeline can only say
  "edited". Needed for AC-11.1 and AC-11.4 to be readable.
- **G3 (plan)**: `FiscalYearView.assets[]` has no per-asset opening or purchase figure although
  `AssetYearFigure` holds both. Without them the five lines cannot be reconciled to the table
  (AC-8.2) on screen. Recommend adding `openingCents` and `purchaseCents` to each row.
- **G4 (plan)**: `Ledger.rule` lacks `effectiveFrom`, so the asset's ledger cannot say or link which rule
  row it follows. Add it.
- **G5 (plan)**: `GET /assets` has no stated sort order. Define one (suggest purchase date descending,
  then creation time) since the UI offers no sort.
- **G6 (plan)**: invoice file lifecycle holes: no unlink or replace endpoint (a wrong upload is
  permanent); behaviour of changing `invoiceRef` on an asset that already has a linked file is not
  defined; upload/link on a disposed asset is not defined (the design hides them, following AC-7.1's "no
  longer edited").
- **G7 (plan)**: `serial_conflict` carries only `serialNumber`, so the message cannot link to the
  conflicting asset (AC-1.5 asks to name the conflict). Suggest adding the conflicting asset id.
  Also unspecified: whether `serialNumbers[]` is positional when shorter than `quantity`.
- **G8 (spec, AC-4 / US-4)**: US-4 says the employee can "correct" what the company believes, but
  only a pending assignment can be declined; there is no way to dispute a device already held. No AC
  covers it; not designed.
- **G9 (plan)**: `createdBy` of the seeded launch rules is a system actor that identity resolution
  returns as `unknown`. The UI will print "System"; a resolvable display name from the API would be cleaner.
- **G10 (plan)**: `GET /assets` for an L user carries the full `ledger.schedule` per row; the list only
  needs the book value. Payload size is a risk at hundreds of rows (R-8 covers only the roll-forward).
- **G11 (plan, R-7)**: a user whose conditioned grant resolves to no entity sees an empty list with no
  explanation, indistinguishable from "nothing registered". The empty copy carries a generic hint;
  better is a distinguishable response.
- **G12 (plan)**: notification copy language. Notifications are composed server-side but the recipient's
  locale is unknown to `inventory-api`; the plan does not say which language(s) the text ships in.

## Open design questions (recommendation first)

- **Q1 i18n.** CLAUDE.md requires Italian and English from day one; `refund-ui` shipped English-only.
  Recommend `inventory-ui/src/strings.ts` typed `Strings` with `en` and `it`, resolved by the same
  `navigator.language` heuristic the shell uses, at least complete for `/devices`, the UserMenu row and
  notifications (Italian employees are the audience of `/devices`).
- **Q2 Sibling linking placement.** Recommend linking inside the Invoice panel right after upload (F8),
  not as a separate bulk screen.
- **Q3 Employee Confirm.** Recommend one click with an explicit label and no dialog (it is a recorded
  click, a dialog on the primary action is friction), and a dialog only on Decline. Alternative: dialog
  on both if wellD wants a firmer acknowledgement.
- **Q4 Lost confirm.** Recommend a confirm dialog (the holder is cleared and not restored by "found").
  Return gets one too; repair and found do not.
- **Q5 `q` search.** Recommend adding it (cheap, the API has it, hundreds of assets) but it needs a
  spec AC; until then it is not designed.
- **Q6 Holder filter for accountants.** Recommend leaving it M-only; alternatively relax the directory
  gate to include `ledger:manage` (an ADR-0047 change).
- **Q7 Categories (spec O6).** The category labels are placeholders from the glossary proposal; the
  select reads them from `strings.ts`, so a change in O6 is a copy change.

## Visual companion

Not used. This was an orchestrated run with no way to put the just-in-time offer to a user, and the skill
requires the user to accept first. The layouts above are text wireframes; the open questions are
interaction and policy rather than visual. No files were written under `.forge/design/`.

## Resolutions (2026-10-06, after review with the user)

Recorded by the main loop; the sections above are otherwise as the designer wrote them.
Where a line here contradicts a gap or open question above, this section wins.

- **G1, G11** resolved in plan.md: `GET /scope` returns the entities each capability
  covers. The register form's entity select, the entity filter, Rules and Fiscal years
  read it; when both lists are empty for a user who has tool access, T1 shows a
  "no entity in your scope — ask an administrator" state, distinct from the empty list.
- **G2** resolved: history events carry typed `changes: {field, from, to}[]`; the
  timeline renders "field: from → to".
- **G3** resolved: per-asset rows carry `openingCents` and `purchaseCents`; T6 shows all
  five columns so the statement can be reconciled on screen.
- **G4** resolved: `ledger.rule.effectiveFrom` is shown in the Ledger block.
- **G5** resolved: the list is ordered by purchase date, newest first.
- **G6** resolved: linking a new file replaces the asset's link; there is no remove
  control; changing the invoice reference unlinks the file (the edit dialog says so
  before saving); a disposed asset shows the invoice panel read-only.
- **G7** resolved: `serial_conflict` returns the conflicting asset id, shown as a link
  when present; the register form requires either no serial numbers or one per unit.
- **G9** resolved: system actors render as "System".
- **G10** resolved: list rows carry book value only.
- **G8** resolved in spec.md: US-4 reworded to "decline what I did not receive";
  reporting a confirmed device as not held is a non-goal. No new UI.
- **G12, Q1** resolved: English only at launch, every string through `strings.ts`,
  including notification text. Recorded as a spec non-goal.
- **Q5** resolved: spec AC-3.8 added. `AssetFilterBar` gains one labelled search input
  bound to `q` (description or serial number, case-insensitive), debounced, combined
  with the other filters, available to both capabilities; clearing it restores the
  filtered list. It is part of T1's keyboard path before the filter controls.
- **Q2, Q3, Q4, Q6** not put to the user: the designer's recommendations above stand
  (link siblings inside the invoice panel after upload; one-click Confirm with a dialog
  only on Decline; confirm dialogs for Lost and Return; holder filter manager-only).
- **Q7** still open with spec O6 (category list).
