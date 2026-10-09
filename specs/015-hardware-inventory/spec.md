---
id: 015
slug: hardware-inventory
status: in-progress
rigor: production
created: 2026-10-06
approved: 2026-10-06
amended: 2026-10-06
---

# Hardware inventory and depreciation register

## Problem

wellD's accounting department tracks every piece of company hardware, and its yearly
depreciation, in one hand-maintained Excel file (`Ammortamenti_hardware_2026.xlsx`: one
sheet, 113 purchase rows from 2022 to 2026, CHF only). Depreciation amounts are typed by
hand to make each schedule land on its CHF 1 memo value, the year-end roll-forward block
no longer agrees with the per-asset columns above it (see Open questions O3), and
disposals, order state and invoice numbers live in free-text cells. The same file is also
the only record of who holds which device, yet a serial number or an assignee is present
on roughly a third of the rows, and nothing records that an employee actually received a
device. wellD IT's hardware is not in the file at all. Accounting needs a register whose
figures are computed, closed and reproducible per legal entity, and the company needs an
inventory that knows where each device is and who accepted it.

## Domain language

New terms; the suite has no glossary entry for any of them yet. `entity` (`welld_ch` |
`welld_it`) keeps the meaning it has in `specs/007-refund-service`.

- **asset** — one physical hardware unit owned by one entity. Never a quantity: a purchase
  of 13 monitors is 13 assets (US-1).
- **category** — the kind of asset, from a fixed list (e.g. laptop, desktop, phone, tablet,
  monitor, peripheral, other). Used for filtering and reporting only; it never changes
  how an asset depreciates.
- **holder** — the Operai account an asset is currently assigned to. An asset with no
  holder is company stock. A party without an Operai account can never be a holder.
- **status** — exactly one of `ordered`, `in_stock`, `assigned`, `in_repair`, `lost`,
  `disposed`. `lost` covers lost and stolen, and is still on the books; only `disposed`
  removes an asset from the books.
- **assignment** — the act of giving an asset to a holder. It is `pending` until the
  employee confirms receipt, and ends as `confirmed`, `declined` or `cancelled`.
- **depreciation rule** — the per-entity set of parameters that turns a purchase price
  into a yearly schedule: useful life in years, first-year share (full or half), low-value
  threshold (optional), and residual value per asset. Effective-dated by purchase date.
- **schedule** — the yearly depreciation amounts of one asset, from its purchase year
  until it reaches its residual value.
- **book value** — purchase price minus all depreciation booked so far, at a given date.
- **residual value** — the book value a schedule stops at (CHF 1.00 "memo value" for
  wellD CH; zero for wellD IT).
- **disposal** — the accounting act that takes an asset off the books, with a reason from
  a fixed list: `ceded_to_employee`, `sold`, `scrapped`, `returned_to_vendor`, `lost`.
- **fiscal year** — the calendar year, per entity. It is `open` or `closed`.
- **roll-forward** — the per-entity, per-fiscal-year statement: opening book value −
  disposals + purchases − depreciation = closing book value.
- **inventory manager** / **hardware accountant** — the two capabilities of this module
  (US-9). A person may hold either or both.

## User stories

### US-1: Register hardware

As an inventory manager, I want to register each purchased device with what it is, what
it cost and which entity owns it, so that the inventory and the books start from the same
record.

**Acceptance criteria:**
- AC-1.1: Given an inventory manager, when they register an asset with entity, category,
  description, purchase date and purchase price, then the asset exists with status
  `in_stock`, or `ordered` if they marked it as not yet received.
- AC-1.2: Given a new asset, then its currency is CHF when its entity is `welld_ch` and
  EUR when its entity is `welld_it`, and the manager cannot choose otherwise.
- AC-1.3: Given a registration with quantity N > 1 and a total price, when it is saved,
  then N assets are created, each with price = total ÷ N rounded down to the cent, and the
  remaining cents added to the last asset, so the N prices sum exactly to the total.
- AC-1.4: Given a registration with no serial number, when it is saved, then it succeeds;
  serial number is optional on every asset.
- AC-1.5: Given a serial number already used by a non-disposed asset of the same entity,
  when a second asset is saved with that serial, then the save is rejected with a message
  naming the conflict.
- AC-1.6: Given a registration missing any of entity, category, description, purchase
  date or purchase price, or with a price that is not greater than zero, then it is
  rejected and nothing is created.
- AC-1.7: Given a purchase date that falls in a closed fiscal year of the asset's entity,
  when the registration is saved, then it is rejected with a message stating that the
  year is closed (US-8).
- AC-1.8: Given an `ordered` asset, when an inventory manager marks it received, then its
  status becomes `in_stock`.
- AC-1.9: Given an existing asset, then its entity and currency cannot be changed.

### US-2: Assign a device and have the employee confirm it

As an inventory manager, I want to assign a device to an employee and have them confirm
they received it, so that the inventory records an acceptance and not just my claim.

**Acceptance criteria:**
- AC-2.1: Given an `in_stock` asset with no pending assignment, when an inventory manager
  assigns it to an Operai user, then a `pending` assignment exists for that user and the
  asset's status is still `in_stock`.
- AC-2.2: Given an asset with a `pending` assignment, when an inventory manager tries to
  assign it to anyone, then the attempt is rejected.
- AC-2.3: Given a `pending` assignment, when the assigned employee confirms it, then the
  assignment is `confirmed`, the asset's status is `assigned` and the employee is its
  holder.
- AC-2.4: Given a `pending` assignment, when the assigned employee declines it, then the
  assignment is `declined`, the asset stays `in_stock` with no holder, and it can be
  assigned again.
- AC-2.5: Given a `pending` assignment, when an inventory manager cancels it, then the
  assignment is `cancelled`, the asset stays `in_stock` with no holder, and it can be
  assigned again.
- AC-2.6: Given a `pending` assignment that nobody acts on, then it is still `pending`
  30 days later; no assignment changes state through the passage of time.
- AC-2.7: Given a `pending` assignment, when any user other than the assigned employee
  tries to confirm or decline it, then the attempt is denied by the server.
- AC-2.8: Given an assignment is created, then the assigned employee receives an in-app
  notification that links to it.
- AC-2.9: Given an employee confirms or declines an assignment, then the inventory
  manager who created it receives an in-app notification stating which.
- AC-2.10: Given an asset whose status is not `in_stock`, when an inventory manager tries
  to assign it, then the attempt is rejected.

### US-3: Take back, repair and lose devices

As an inventory manager, I want to record a device coming back, going for repair or going
missing, so that the inventory shows what is actually available.

**Acceptance criteria:**
- AC-3.1: Given an `assigned` asset, when an inventory manager records its return, then
  its status is `in_stock` and it has no holder. The employee does not confirm a return.
- AC-3.2: Given an `in_stock` or `assigned` asset, when an inventory manager marks it in
  repair, then its status is `in_repair` and its holder, if any, is unchanged.
- AC-3.3: Given an `in_repair` asset, when an inventory manager marks the repair finished,
  then its status is `assigned` if it has a holder and `in_stock` if it has none.
- AC-3.4: Given an asset in `in_stock`, `assigned` or `in_repair`, when an inventory
  manager marks it lost, then its status is `lost`, its holder is cleared, and its book
  value and schedule are unchanged.
- AC-3.5: Given a `lost` asset, when an inventory manager marks it found, then its status
  is `in_stock`.
- AC-3.6: Given an asset with a free-text location/note, when an inventory manager edits
  it, then the new text is shown on the asset; the note never affects status or holder.
- AC-3.7: Given a list of assets, when an inventory manager filters by status, category,
  entity or holder, then only matching assets are listed.
- AC-3.8: Given a list of assets, when a manager or accountant searches by a text, then
  exactly the assets within their entity scope whose description or serial number
  contains that text, ignoring case, are listed.

### US-4: See my own devices

As an employee, I want to see the devices assigned to me and the ones waiting for my
confirmation, so that I know what the company believes I hold and can decline what I did not receive.

**Acceptance criteria:**
- AC-4.1: Given any signed-in user with no grant for this module, when they open their
  devices view, then they see every asset of which they are the holder and every `pending`
  assignment addressed to them, each with description, category, serial number and the
  date it was assigned.
- AC-4.2: Given a user's devices view, then it contains no purchase price, book value or
  depreciation figure, and the server does not return those fields to that user.
- AC-4.3: Given a user without either capability, when they request an asset they do not
  hold and have no pending assignment for, by any means including a direct API call, then
  the server responds as if that asset does not exist.
- AC-4.4: Given a user with no assets and no pending assignments, then the view shows an
  explicit empty state.

### US-5: Compute each asset's depreciation schedule

As a hardware accountant, I want each asset's yearly depreciation computed from its
entity's rule, so that I stop typing and hand-correcting amounts.

All amounts are in cents. One rounding rule applies everywhere: a yearly amount is
rounded half-up to the cent, and the final year of a schedule takes whatever remains so
the book value ends exactly at the residual value.

**Acceptance criteria:**
- AC-5.1: Given a `welld_ch` asset under the launch rule (useful life 3 years, full first
  year, no threshold, residual CHF 1.00) bought on 2026-09-25 for CHF 998.15, then its
  schedule is 2026: 332.38, 2027: 332.38, 2028: 332.39, and its book value on 2028-12-31
  is exactly CHF 1.00.
- AC-5.2: Given a `welld_ch` asset, then its purchase-year depreciation is the same
  whether it was bought on 1 January or 31 December of that year (no pro-rata).
- AC-5.3: Given a `welld_ch` asset whose schedule has ended, then its book value stays at
  CHF 1.00 in every later year until it is disposed (see Open questions O4).
- AC-5.4: Given a `welld_it` asset under the launch rule (useful life 5 years, half first
  year, threshold EUR 516.46, residual zero) bought in 2026 for EUR 1,000.00, then its
  schedule is 2026: 100.00, 2027–2030: 200.00 each, 2031: 100.00, and its book value on
  2031-12-31 is exactly EUR 0.00.
- AC-5.5: Given a `welld_it` asset bought for EUR 516.46 or less, then its whole price is
  depreciated in its purchase year and its book value at that year's end is EUR 0.00.
- AC-5.6: Given a `welld_it` asset bought for EUR 516.47, then it follows the multi-year
  schedule of AC-5.4, not AC-5.5.
- AC-5.7: Given an asset in status `ordered`, then its schedule starts in the year of its
  purchase date, exactly as if it had been received.
- AC-5.8: Given a hardware accountant opens an asset, then they see its purchase price,
  every year of its schedule and its book value at each year end.
- AC-5.9: Given an asset's purchase price or purchase date is edited while every fiscal
  year from its purchase year on is open, then its schedule is recomputed from the new
  values; if any of those years is closed, the edit is rejected.

### US-6: Maintain depreciation rules

As a hardware accountant, I want to change an entity's depreciation rule from a given
date, so that a change in law or policy does not need a new release and does not rewrite
existing schedules.

**Acceptance criteria:**
- AC-6.1: Given a hardware accountant, when they open an entity's rules, then they see
  the rule currently in force and every earlier and future rule, each with its effective
  date, useful life, first-year share, threshold and residual value.
- AC-6.2: Given a new rule saved with effective date D, then every asset of that entity
  with purchase date on or after D is scheduled by the new rule, and every asset with an
  earlier purchase date keeps the schedule it had.
- AC-6.3: Given an effective date that falls in a closed fiscal year of that entity, when
  the rule is saved, then it is rejected.
- AC-6.4: Given a rule with useful life below 1 year, a negative threshold or a negative
  residual value, when it is saved, then it is rejected with a message naming the field.
- AC-6.5: Given a saved rule, then it records who created it and when, and it cannot be
  edited or deleted afterwards; a correction is a new rule.
- AC-6.6: Given the module at launch, then `welld_ch` has the rule of AC-5.1 and
  `welld_it` the rule of AC-5.4, both effective from the earliest imported purchase date.

### US-7: Dispose of an asset

As a hardware accountant, I want to take a device off the books when it is ceded, sold,
scrapped, returned or written off as lost, so that the register carries only what the
company still owns.

**Acceptance criteria:**
- AC-7.1: Given a non-disposed asset with no `pending` assignment, when a hardware
  accountant disposes of it with a date and a reason from the fixed list, then its status
  is `disposed`, its holder is cleared, and it can no longer be assigned, repaired or
  edited.
- AC-7.2: Given an asset disposed in fiscal year Y, then Y's roll-forward disposals line
  includes its book value at the start of Y, or its purchase price if it was bought in Y.
- AC-7.7: Given an asset disposed in fiscal year Y, then it contributes zero to the
  depreciation line of Y and of every later year.
- AC-7.8: Given a disposed asset, then its book value on any date from the disposal date
  on is zero.
- AC-7.3: Given a disposal with reason `sold` or `ceded_to_employee`, then the accountant
  may record a sale price, which is displayed on the asset and changes no roll-forward
  figure.
- AC-7.4: Given a disposal date in a closed fiscal year, or earlier than the asset's
  purchase date, when the disposal is saved, then it is rejected.
- AC-7.5: Given an asset with a `pending` assignment, when a hardware accountant tries to
  dispose of it, then the attempt is rejected with a message naming the pending
  assignment.
- AC-7.6: Given a `disposed` asset, then no user can return it to any other status.

### US-8: Roll forward and close a fiscal year

As a hardware accountant, I want the year's roll-forward computed per entity and the year
closed once reported, so that next year's opening value is always what was reported.

**Acceptance criteria:**
- AC-8.1: Given an entity and a fiscal year, when a hardware accountant opens its
  roll-forward, then they see opening book value, disposals, purchases, depreciation and
  closing book value, where closing = opening − disposals + purchases − depreciation, to
  the cent.
- AC-8.2: Given a roll-forward, then each of its lines equals the sum of the
  corresponding per-asset figures for that entity and year, to the cent.
- AC-8.3: Given two consecutive fiscal years of one entity, then the later year's opening
  book value equals the earlier year's closing book value.
- AC-8.4: Given an open fiscal year whose previous year is closed (or which is the
  entity's first year), when a hardware accountant closes it, then it is `closed` and its
  roll-forward and per-asset figures are stored as closed.
- AC-8.5: Given an open fiscal year whose previous year is still open, when a hardware
  accountant tries to close it, then the attempt is rejected.
- AC-8.6: Given a closed fiscal year, then its roll-forward and per-asset figures are
  identical every time they are viewed afterwards, whatever is later changed in open
  years.
- AC-8.7: Given a closed fiscal year, then no user can reopen it.
- AC-8.8: Given a closed fiscal year, when a hardware accountant exports it, then they
  receive an XLSX file for that entity and year containing one row per asset (purchase
  date, description, serial number, holder, purchase price, depreciation for the year,
  book value at year end) and the five roll-forward lines.
- AC-8.9: Given an open fiscal year, when it is exported, then the file is marked as
  provisional.

### US-9: Two capabilities, scoped by entity

As wellD, we want running the inventory and keeping the books to be separately grantable
and restrictable to one entity, so that someone can move devices without touching the
books and the two companies' books can be kept apart.

**Acceptance criteria:**
- AC-9.1: Given a user with only the inventory manager capability, then they can perform
  every action of US-1, US-2 and US-3, and the server denies them every action of US-6,
  US-7 and US-8.
- AC-9.2: Given a user with only the inventory manager capability, then they can see and
  enter an asset's purchase price, and the server returns them no schedule, book value,
  rule or roll-forward.
- AC-9.3: Given a user with only the hardware accountant capability, then they can
  perform every action of US-5 to US-8 and see every asset, and the server denies them
  every action of US-1, US-2 and US-3.
- AC-9.4: Given a capability restricted to one entity, then its holder can neither see
  nor change the other entity's assets, rules, roll-forwards or fiscal years, and a
  direct request for one of the other entity's assets is answered as if it did not exist.
- AC-9.5: Given a capability with no entity restriction, then it applies to both
  entities.
- AC-9.6: Given a user with neither capability, then the module is absent from their
  navigation except for the devices view of US-4.
- AC-9.7: Given any denied action in AC-9.1 to AC-9.4, then the denial is enforced by the
  server and holds for a direct API call, not only in the interface.

### US-10: Keep the purchase document with the asset

As a hardware accountant, I want the supplier, the invoice reference and the invoice file
attached to the assets they cover, so that I can go from a device to its invoice and from
an invoice to its devices.

**Acceptance criteria:**
- AC-10.1: Given an asset, when an inventory manager or hardware accountant sets its
  supplier and invoice reference, then both are stored as their own fields, separate from
  the description.
- AC-10.2: Given a multi-unit registration (AC-1.3), then all N assets carry the same
  supplier and invoice reference.
- AC-10.3: Given an invoice reference, when a manager or accountant searches by it, then
  every asset carrying it within their entity scope is listed.
- AC-10.4: Given an asset, when a manager or accountant uploads an invoice file (PDF,
  JPEG or PNG, at most 10 MiB), then it can be opened from that asset afterwards.
- AC-10.5: Given an invoice file uploaded on one asset, when it is linked to other assets
  with the same invoice reference, then it opens from each of them and is stored once.
- AC-10.6: Given a file of another type or larger than 10 MiB, when it is uploaded, then
  it is rejected and nothing is stored.
- AC-10.7: Given a user without a capability covering the asset's entity, including the
  asset's own holder, when they request its invoice file, then the server denies it.

### US-11: History of every device

As wellD, we want every change to a device recorded, so that who held it, who moved it
and who took it off the books can always be reconstructed.

**Acceptance criteria:**
- AC-11.1: Given any status change, assignment outcome, return, edit of price or purchase
  date, disposal or fiscal-year close, then a history entry records the actor, the time,
  and the old and new value.
- AC-11.2: Given a history entry, then no user, including an administrator, can edit or
  delete it.
- AC-11.3: Given an asset, when a manager or accountant with scope over it opens its
  history, then they see every entry in chronological order.
- AC-11.4: Given an asset's history, then its sequence of holders with start and end
  dates can be read from it for the asset's whole life in the module.

### US-12: Move the existing register in

As a hardware accountant, I want the current Excel register loaded into the module once,
with its reported past untouched, so that the first year the module computes continues
from the books as they stand.

**Acceptance criteria:**
- AC-12.1: Given the wellD CH sheet, when the one-off import has run, then every purchase
  row exists as one or more `welld_ch` assets with its purchase date, description and
  price, and the row for 13 monitors exists as 13 assets (AC-1.3).
- AC-12.2: Given an imported asset, then its depreciation and year-end book value for
  each fiscal year up to and including 2025 are exactly the amounts in the sheet, rounded
  half-up to the cent, and are not recomputed by the rule.
- AC-12.3: Given the import has run, then every `welld_ch` fiscal year up to and
  including 2025 is `closed`.
- AC-12.4: Given the import has run, then the sum of all imported assets' book values at
  2025-12-31 equals the opening balance accounting has confirmed for 2026 (the figure is
  Open question O3; the import is not accepted until this equality holds).
- AC-12.5: Given an imported asset with book value V above CHF 1.00 at 2025-12-31 and k
  years left of its 3-year life, then its schedule from 2026 spreads V − 1.00 evenly over
  those k years by the rounding rule of US-5; for example V = 532.55 and k = 2 gives
  2026: 265.78, 2027: 265.77, ending at CHF 1.00.
- AC-12.6: Given a sheet row with no assignee, then its asset is imported `in_stock` with
  a visible "to verify" mark that an inventory manager can clear.
- AC-12.7: Given a sheet row whose assignee text matches exactly one Operai user by name,
  then its asset is imported `assigned` to that user with the assignment already
  `confirmed`; any other assignee text is kept in the location/note field and the asset
  is imported per AC-12.6.
- AC-12.8: Given the two 2026 cession rows of the sheet, then each is imported as a 2026
  disposal with reason `ceded_to_employee` of the asset it refers to, and not as a new
  asset.
- AC-12.9: Given the row marked "Ordinato - In attesa di ricezione", then its asset is
  imported with status `ordered` and no serial number.
- AC-12.10: Given an inventory manager filters by the "to verify" mark, then exactly the
  assets still carrying it are listed.

## Non-goals

- **Anything that is not hardware.** Furniture, vehicles, software licences and other
  fixed assets stay wherever they are tracked today.
- **Depreciation rules per category, or overrides per asset.** One rule per entity; a
  server depreciated over a different life is not supported.
- **Holders without an Operai account.** A device with a contractor or a client stays
  company stock with a note.
- **Reopening a closed fiscal year.** A late correction is booked in the open year.
- **Automatic confirmation or expiry of a pending assignment**, and reminders about one.
- **A signed handover document.** Confirmation is a recorded click, not a signed PDF.
- **Gain or loss on disposal, tax deductibility and journal entries.** The sale price is
  informational; the accountant books the rest elsewhere.
- **Pushing figures into accounting software.** The hand-off is the XLSX export.
- **A link to Refund.** A device an employee bought and claimed is registered by hand.
- **Moving an asset between entities.** That is a disposal in one and a purchase in the
  other, done by hand.
- **Reporting a confirmed device as not held.** An employee can decline a pending
  assignment; for a device they already confirmed and no longer have, they tell the
  inventory manager outside the tool.
- **Italian copy at launch.** Every string is externalised so Italian can be added, but
  only English is written, including notification text, as in Refund today.
- **An import screen.** The Excel load is a one-off at launch, not a product feature.
- **Device management.** No MDM integration, remote wipe, labels, barcodes or QR codes.
- **Pro-rata depreciation by month or day** for either entity.
- **wellD IT history at launch**, unless accounting supplies a source (O2); without one,
  wellD IT starts with no imported assets and no closed years.

## Amendments

- 2026-10-06, after the design stage, agreed by Matteo Codogno: AC-3.8 added (text
  search); US-4 reworded from "can correct it" to "can decline what I did not receive";
  two non-goals added (reporting a confirmed device as not held; Italian copy at launch).

## Constraints

- Money is integer minor units, rounded once by one rule (ADR-0025).
- Invoice files are business data and fall under the suite's EU data-residency rule.
- The devices view of US-4 must be reachable by every signed-in user regardless of grants
  (ADR-0034 is the existing rule for such screens; where it lives is the plan's decision).

## Open questions

**Accepted as risk at approval (2026-10-06, Matteo Codogno):** the spec was approved with
O1–O6 unresolved. The ACs that depend on them (AC-5.3 on O4; AC-5.4 to AC-5.6 on O1;
AC-12.4 on O3; AC-12.8 on O5; US-12's Italian half on O2) may change when accounting
answers, and any such change is drift on this spec.

- [ ] **O1** — The wellD IT rule in AC-5.4 to AC-5.6 (20% a year, halved in the purchase
  year, full expensing up to EUR 516.46, no residual) was chosen from the standard
  ministerial coefficients as recalled during the interview, not from wellD IT's books.
  Does it match what the Italian accountant actually applies? — owner: accounting /
  Italian accountant
- [ ] **O2** — Does a wellD IT asset register exist, in what form, and what is its last
  reported closing value? Decides whether US-12 has an Italian half. — owner: accounting
- [ ] **O3** — The sheet's year-end block does not agree with its own per-asset columns.
  It states "Valore al 31.12.2025" as 29,756.49, while the per-asset 31.12.2025 column
  sums to 21,689.00 and the 31.12.2024 column to 28,672.08. Its lines labelled "2026"
  (purchases 15,793.10, depreciation 22,776.18) sum the 2025 rows and the 2025
  depreciation column; the 2026 rows give purchases 18,295.89 and depreciation 22,458.31.
  Which per-asset values and which opening balance are the reported ones? AC-12.4 cannot
  be tested until this is answered. — owner: accounting
- [ ] **O4** — For 2022 purchases the sheet depreciates the last CHF 1 in 2025, taking
  them to zero, while 2023 purchases stay at CHF 1. Is the memo value kept until disposal
  (AC-5.3 as written) or written off the year after the schedule ends? — owner: accounting
- [ ] **O5** — Three rows (purchases of 18.09.2023, 09.05.2022, 10.02.2022) have a value
  at 31.12.2023 and nothing after; one cession row's serial (`FVFF1239Q05P`) matches no
  purchase row; one 2022 MacBook is both written to zero in 2025 and ceded at CHF 1 in
  2026. How should each be imported? — owner: accounting
- [ ] **O6** — The fixed category list: the examples in Domain language are a proposal.
  — owner: Matteo Codogno
