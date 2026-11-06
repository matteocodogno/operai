---
id: 021
slug: projects
status: done
rigor: mvp
created: 2026-11-03
approved: 2026-11-03
done: 2026-11-04
depends-on: 017
---

# Projects — the delivery work wellD runs and the contracts behind it

Decision ledger: `ledger.md`

> **Amended by specs/022 on 2026-11-04 (steering, ledger D37–D42) and 2026-11-05 (grilling,
> D43–D51).** The text below is the approved one, left as written; each affected passage
> carries an inline "(amended by specs/022, D3x)" with the new rule. In short:
> **"contract" becomes "purchase order" (PO)** everywhere, and a project has **0 or 1 PO**,
> born only from a won deal together with its project (specs/022) — **no PO is entered by
> hand**, a project created by hand never gets one (D38, A32); a hand-made project **may
> carry the type-specific terms, optionally**, without a PO (D50, A38); **`saas` is a client
> type** — a company and its PO, one project per licence — and the product itself is
> `internal` (D40); **a project's type never changes** (A30); a project made from a deal has
> **no project manager** until the new **`ops-manager`** role picks one (D42, D46); there is
> **no attach** of a deal to a project (D39). Nothing of this spec was on `main` when it was
> amended.

> **Origin.** A whiteboard session on 2026-11-03 drew the CRM pipeline (company → lead →
> deal | no deal), a deal forking to **Admin (Bexio)** and to **OPS**, and below it a **PM**
> band: *Project → type: T&M ; Fixed price ; Maintenance*, with *deadline / max effort /
> man days* under Fixed price and *SLA / pacchetto orario* under Maintenance. Time tracking
> and service desk sit in a third band, left for later. The product owner grilled the
> "Project" section the same day; every decision is in `ledger.md` (D = decided, A =
> assumed and strikeable, O = open).
>
> The work is split in three specs (ledger D33): **this one** is the core — projects,
> contracts, the Bexio order id, access. **specs/022** hands won deals over from the CRM
> ("in series"); **specs/023** adds tasks and discussion threads. Both build on this one.

## Problem

What wellD delivers has no home in Operai. The terms agreed with a client — a deadline and
an effort cap, an SLA's take-in-charge times, an hour package, the profiles of a
time-and-material engagement, a licence period — exist only as free text inside an offer
PDF, and for contracts signed before the CRM not even there. *(Amended by specs/022, D38,
D50: terms are recorded with the PO of a project born from a won deal; a contract signed
before the CRM can still have a project, created by hand, with no PO — and its terms, if
wanted, recorded on the project, optionally.)* The Bexio order
that administration opens is linked to nothing. Products wellD builds itself and sells by
licence (Koordy) have no record of who their clients are. *(Amended by specs/022, D40: each
licence is a `saas` project with its company and PO; the product itself is an `internal`
project.)* Who is responsible for each piece of work, and who is on it, lives in people's
heads.

## Domain language

- **project** — a body of delivery work wellD runs. It has a type, a state, a project
  manager, a team and contracts, and belongs to one wellD entity (`welld_ch` |
  `welld_it`). It carries **no money** (D14). *(Amended by specs/022, D38, D42: "contracts"
  reads "at most one purchase order"; the project manager may be absent while the project
  awaits its ops-manager's pick.)*
- **project type** — exactly one of:
  - `t_and_m`, `fixed_price`, `maintenance` — **client projects**: one company;
  - `saas` — a wellD product sold by licence: no company of its own, its clients are the
    companies of its contracts; *(amended by specs/022, D40: `saas` is a **client type**
    like the three above — one company, one PO, one project per licence; no multi-client
    project exists)*
  - `internal` — no clients and no contracts (internal tools, R&D) (delegated — ledger D21).
    *(Amended by specs/022, D40: the products themselves — Koordy, wellD Fleet — are
    `internal` projects without a PO.)*

  Chosen at creation and never changed, except `internal` → `saas` (D7, D24). *(Amended by
  specs/022, A30: never changed, with no exception.)*
- **contract** — what one client bought on a project, as delivery terms. It always has its
  project's type (D25). In this spec every contract is entered by hand; specs/022 creates
  them from won deals. *Working name — see glossary changes.* *(Amended by specs/022, D38:
  renamed **purchase order (PO)**; a project has 0 or 1; a PO is created only from a won
  deal, together with its project (specs/022); none is entered by hand; a PO also carries a
  **referent** (D41) and an **ops-manager** (D42). Wherever this spec says "contract", read
  "purchase order".)*
- **Bexio order id** — the identifier of the order administration opens in Bexio for a
  contract; typed in, never synchronised (D1a, D3). *(Amended by specs/022, D38: for a
  purchase order.)*
- **SLA** — two fixed priorities, *high* and *normal*, each with a **take-in-charge time**
  in working days (D10).
- **hour package** — a number of whole hours purchased, either a *capacity* package (start
  date, optional expiry) or a *yearly* package (the same hours for each 12-month period from
  its start date) (D11, A7).
- **position** — a profile in a T&M contract ("Senior developer") with its planned man-days
  (D12). A profile, not a person (A8).
- **manage projects** — the capability to create projects, add and edit contracts and move
  states, scoped to an entity. Held by the new **project manager** role (OPS) and by the
  existing **`sales`** role (BD) (D13, D36, A29). *(Amended by specs/022, D42, A35: also
  held by the new entity-scoped **`ops-manager`** role (responsabile OPS); "add contracts"
  is void — D38.)*
- **Bexio-order capability** — the right to write a contract's Bexio order id, held by the
  existing **`accounting`** role (D35).

## User stories

### US-1 Projects
As OPS, I want one list of the projects wellD runs, so that anyone can see what is being
delivered, for whom, and by whom.

- AC-1.1 A holder of manage projects for an entity (OPS or BD, D36) creates a project with a
  name, a type, that entity and a project manager (the creator by default, D15); a company is
  required for a client type and absent for `saas` and `internal` (D5, D19, D24).
  *(Amended by specs/022, D40, D42, D50, A33: a company is required for every client type,
  `saas` included, and absent only for `internal`; this creation is the **by-hand** one — the
  project has no PO, may be of any type, and the creator is its project manager (changeable);
  it may carry the type's terms, optionally, at creation or later, under AC-2.3–2.8 once
  entered — specs/022 US-5. A project made from a won deal is created by specs/022 with the
  deal's company and no project manager yet.)*
- AC-1.2 Changing a project's type is refused, except from `internal` to `saas` (D7, D24).
  *(Amended by specs/022, A30: refused with no exception.)*
- AC-1.3 A project's states are `planned`, `active`, `on_hold`, `closed`, `cancelled`. A new
  project is `planned`. A holder of manage projects moves it:
  - `planned` → `active`;
  - `planned` or `active` → `on_hold`, and back to the state it left;
  - `active` → `closed`, and `closed` → `active`;
  - any state except `closed` → `cancelled`, which is final (D16, A10).

  *(Amended by specs/022, D48: while a project made from a deal awaits its project manager,
  `planned` → `active` is refused; every other move is as above — specs/022 AC-4.7.)*
- AC-1.4 The projects list shows name, type, state, company (or, for `saas`, the number of
  clients; for `internal`, "Internal"), project manager and entity. It is paginated
  (25 per page), sorted by name, searchable by name (case-insensitive substring) and
  filterable by type, state and project manager — the CRM's list conventions (specs/017
  AC-1.1/1.2), not discussed in the grilling. *(Amended by specs/022, D40, D42: `saas` shows
  its company like any client type; a project awaiting its project manager shows "Awaiting
  project manager" in that cell, and the filter offers "none yet" — specs/022 AC-4.5.)*
- AC-1.5 The project page shows its details, its contracts and its team, and as dates the
  earliest contract start and the latest contract end (A8). *(Amended by specs/022, D38, D50:
  its PO, if any; the dates are the PO's start and end, and a project without a PO shows
  none; the terms of a hand-made project, if it has any, are shown as terms, not as project
  dates; an awaiting project shows the notice of specs/022 AC-4.6.)*
- AC-1.6 A project's project manager is required and must hold access to the project
  module; so must every team member. A person without access is refused with a message
  (D15). *(Amended by specs/022, D42, D46, A34: required except while a project made from a
  deal awaits its ops-manager's pick — then only the person assigned to its PO, or an admin,
  picks it; once set it cannot be cleared — specs/022 AC-4.8, AC-4.9.)*
- AC-1.7 Two people editing the same project or contract at once cannot silently overwrite
  each other: the second save is refused and the person is asked to reload (ADR-0038
  posture, as in every Operai tool).

### US-2 Contracts record what was sold
As a project manager, I want each contract's delivery terms in a structured form, so that
I know what we promised without reading the offer PDF. *(Amended by specs/022, D38, D50:
the story now reads "purchase order"; its terms exist on POs made from won deals and,
optionally, on hand-made projects without a PO — A38.)*

- AC-2.1 Every contract shows its client company, its origin ("entered by hand" in this
  spec), its Bexio order id, a start date and an optional end date (D25). *(Amended by
  specs/022, D38: no origin is shown — every PO is from a deal; it also shows its referent,
  D41, and its ops-manager, D42.)*
- AC-2.2 A holder of manage projects adds a contract to a client project (for its own company) or to
  a `saas` project (for any CRM company); an `internal`, `closed` or `cancelled` project
  takes no contract (D5, D24, A12, A27). *(Amended by specs/022, D38, D39: void — no PO is
  added by hand or to an existing project; a PO is created only with its project from a won
  deal, specs/022 AC-1.3 and AC-1.10.)*
- AC-2.3 A `fixed_price` contract has a deadline, estimated man-days and a max effort in
  man-days (D8). Deadline and max effort are required (A21); estimated man-days are typed
  in or left empty (A6; specs/022 copies them from the deal's estimate). *(Amended by
  specs/022, D38: typed in or left empty only when the deal has no estimate — specs/022
  AC-3.1, AC-3.5. D50, A38: on a hand-made project the terms as a whole are optional; once
  entered, this rule applies to them — specs/022 AC-5.3.)*
- AC-2.4 A `maintenance` contract has an SLA, an hour package, or both; saving one with
  neither is refused (D9).
- AC-2.5 An SLA has a take-in-charge time in whole working days for *high* and for
  *normal*, prefilled with 1 and 3 and editable (D10).
- AC-2.6 An hour package has a number of whole hours greater than zero and is either
  *capacity* (start date, optional expiry) or *yearly* (start date; periods of 12 months
  from it) (D11, A7).
- AC-2.7 A `t_and_m` contract has one or more positions, each with a profile name and its
  planned man-days greater than zero (D12).
- AC-2.8 A `saas` contract has the licence period (its start and optional end date), an
  optional SLA and an optional hour package (D26, A15). *(Amended by specs/022, D40:
  the licence's PO, on a `saas` project of the licensee's company.)*
- AC-2.9 No project, contract or list in the project module shows an amount, a price or a
  rate (D14).
- AC-2.10 A contract cannot be deleted; a holder of manage projects ends it by setting its
  end date (D34). *(Amended by specs/022, D38: a PO — D34 holds; a hand-entered one no
  longer exists.)*

### US-3 Administration records the Bexio order
As accounting (amministrazione), I want to record the Bexio order id on each contract, so
that delivery and invoicing point at the same order. *(Amended by specs/022, D38: on each
purchase order.)*

- AC-3.1 Only a holder of the Bexio-order capability sets, changes or clears a contract's
  Bexio order id; anyone else gets no control, and the server refuses (D3, D35).
- AC-3.2 The Bexio order id is free text of at most 64 characters, trimmed; it is not
  checked against Bexio and not checked for uniqueness (A24).
- AC-3.3 A missing Bexio order id never blocks creating, starting or closing a project (D3).

### US-4 Access
As an admin, I want the project module to follow the suite's permission rules, so that
each person sees and changes exactly what their role allows.

- AC-4.1 The project module appears in the suite only for holders of its access
  permission (ADR-0007 posture).
- AC-4.2 Every request without the access permission is refused (403), and an `auth`
  outage is refused as unavailable (503), never allowed (ADR-0014 posture).
- AC-4.3 Every holder of access reads every project and contract (D13). *(Amended by
  specs/022, D37: reading projects and POs is unchanged; the to-start queue is not
  readable by every holder — only `sales` and admins, specs/022 AC-1.9.)*
- AC-4.4 A new **project manager** role holds access and manage projects scoped to an
  entity; the existing **`sales`** role gains the same, also entity-scoped. A holder scoped
  to one entity cannot create or edit the other entity's projects or contracts (refused,
  controls hidden) (D13, D36, A29). *(Amended by specs/022, D42, A35: a new **`ops-manager`**
  role (responsabile OPS) also holds access and entity-scoped manage projects, and can be
  assigned as a PO's ops-manager; the project manager role no longer takes deals from the
  CRM, D37.)*
- AC-4.5 The existing **`accounting`** role gains access and the Bexio-order capability; no
  new role is created for it (D35).
- AC-4.6 Admins hold every capability unscoped; employees get nothing by default (D13).
- AC-4.7 All copy exists in English and Italian; dates use the library formatters.
  *(Amended by specs/022, D51: one declared exception — the ops-manager's notification of
  a new PO is English only, like the CRM's; specs/022 AC-4.3.)*

## Non-goals

- **The hand-off from the CRM** — the to-start queue, projects and contracts created from a
  won deal, the estimate link, the CRM deal page showing its project: **specs/022**.
  *(Amended by specs/022, D38: projects and purchase orders.)*
- **Tasks and discussion threads** on a project: **specs/023**.
- **Time tracking** and anything consumed against what was sold: hours used from a
  package, man-days used against max effort or positions, remaining hours (D1, D27).
- **Service desk**: tickets, and measuring take-in-charge times against an SLA (D1).
- **Bexio integration**: nothing is read from or sent to Bexio; the order id is typed
  (D1a).
- **Money** in projects: prices, rates, fees, budgets (D14). Figures stay on the CRM deal
  behind `deal:financials`.
- **Per-project visibility**: every access holder reads everything (D13).
- **Mapping offer templates to project types** (A5).

## Assumptions (from the ledger — strike any that is wrong)

- A5 The project manager picks the type; no offer template carries one. *(Amended by
  specs/022: for a project made from a deal, sales picks it.)*
- A6 Estimated man-days, once copied from an estimate (specs/022), are a snapshot.
- A7 A yearly hour package runs in 12-month periods from its start date, not the calendar
  year.
- A8 A position is a profile, not a person; a project has no dates of its own. *(Amended by
  specs/022, D38: its dates are its PO's; a hand-made project has none — the terms it may
  carry, D50, are terms, not project dates.)*
- A10 `on_hold` returns to the state it left; `closed` reopens; `cancelled` is final.
- A12 A client project takes contracts only for its own company; `saas` for any company;
  `internal` for none. *(Retired by specs/022, D39, D40: no contract is added to a project.)*
- A15 A `saas` contract may have neither an SLA nor an hour package.
- A21 A `fixed_price` contract requires its deadline and max effort.
- A24 The Bexio order id is unchecked free text up to 64 characters.
- A27 A `closed` project, like a `cancelled` one, takes no new contract until reopened.
  *(Retired by specs/022, D39.)*
- A29 `sales` holds the same manage-projects capability as the project manager, not a
  narrower "create only" one. *(Amended by specs/022, D42, D50: whoever creates a project
  **by hand** is its project manager (changeable); the creator of a project from a deal is
  not.)*

## Open questions

- O2 Do unused hours of a yearly package carry over to the next period? Matters only once
  consumption exists — owner: product owner, for the time-tracking spec. **Accepted as
  risk at approval (2026-11-03)**: this spec records the package, not its consumption.
