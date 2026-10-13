# Domain glossary

## Terms

### Hardware inventory (specs/015)
- **Asset**: one physical hardware unit owned by one entity, from registration until
  disposal; never a quantity (13 monitors are 13 assets). _Avoid:_ device (UI copy only),
  item, row.
- **Asset category**: the kind of asset, from a fixed list; for filtering and reporting
  only, never an input to depreciation. _Avoid:_ type, class.
- **Holder**: the Operai account an asset is currently assigned to; an asset with no
  holder is company stock. A party without an account is never a holder. _Avoid:_
  assignee, owner (the entity owns the asset).
- **Asset status**: exactly one of `ordered`, `in_stock`, `assigned`, `in_repair`, `lost`,
  `disposed`. `lost` (lost or stolen) is still on the books; only `disposed` is not.
- **Assignment**: the act of giving an asset to a holder; `pending` until the employee
  confirms receipt, then `confirmed`, `declined` or `cancelled`. Never expires.
  _Avoid:_ handover.
- **Depreciation rule**: the per-entity parameters (useful life, first-year share,
  low-value threshold, residual value) that turn a purchase price into a schedule;
  applies to assets purchased on or after its effective date and is never edited.
- **Schedule**: one asset's yearly depreciation amounts, from its purchase year until it
  reaches its residual value. _Avoid:_ plan, amortisation table.
- **Book value**: purchase price minus all depreciation booked so far, at a given date;
  zero from disposal onward.
- **Residual value**: the book value a schedule stops at (CHF 1.00 for `welld_ch`, zero
  for `welld_it`). _Avoid:_ memo value, pro-memoria.
- **Disposal**: the accounting act that takes an asset off the books, with a reason
  (`ceded_to_employee`, `sold`, `scrapped`, `returned_to_vendor`, `lost`); irreversible.
  _Avoid:_ cession, write-off (both are reasons or effects, not the act).
- **Fiscal year**: the calendar year, per entity; `open` or `closed`. A closed year is
  frozen and never reopened.
- **Roll-forward**: the per-entity, per-fiscal-year statement: opening book value −
  disposals + purchases − depreciation = closing book value.
- **Inventory manager**: the capability to register, assign, take back, repair and mark
  assets lost; sees purchase prices, not book values.
- **Hardware accountant**: the capability to see schedules and book values, maintain
  depreciation rules, dispose of assets and close fiscal years.

### Service-to-service credentials (specs/016)
- **Shared token**: the single static secret `auth`, `refund-api` and `estimai-api`
  present to the notification service's internal endpoints; being retired. _Avoid:_
  internal token, system token.
- **Service credential**: what a service client presents to the notification service:
  short-lived, issued by `auth` to that one client, carrying its identity and scopes.
  _Avoid:_ service token where the shared token could be meant.
- **Scope**: one named permission carried by a service credential: **push** (send an
  in-app notification) or **email** (send an email).
- **Caller**: a service that reaches the notification service's internal endpoints.
- **Transition**: the period in which the notification service accepts both the shared
  token and service credentials; it ends when the shared token is retired.

## Relationships
- An **Asset** belongs to exactly one entity for its whole life and has at most one
  **Holder** and at most one `pending` **Assignment** at a time.
- An **Asset** has exactly one **Schedule**, produced by the one **Depreciation rule** in
  force for its entity on its purchase date.
- A **Roll-forward** belongs to one entity and one **Fiscal year**; each line is the sum
  of that year's per-asset figures.

## Open ambiguities
- Whether the `welld_ch` **Residual value** is kept until **Disposal** or written off the
  year after the **Schedule** ends (specs/015 O4) — owner: accounting.
