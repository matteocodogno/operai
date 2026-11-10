---
topic: Project Management module fed "in series" by the CRM pipeline — the "Project" section of the 2026-11-03 whiteboard
grilled: 2026-11-03
target: idea
complete: true
---

## Source

Whiteboard photo `PXL_20261103_125540335.jpg` (2026-11-03). Three bands:
- **CRM** — Company (people/contacts) → prospect | customer → Lead (onboarding | offering;
  offering loops through "Sale + Eng." → Estimate) → Deal | No deal. Deal forks to
  **Admin (Bexio)** and down to **OPS**.
- **PM** — Project → type: T&M ; Fixed price ; Maintenance. Fixed price → deadline, max
  effort, man days. Maintenance → SLA, pacchetto orario. ("SLA" first written under the
  project itself, then struck out.)
- **Bottom band** — Time tracking | Service desk (empty).

## Decision map

- B1 Scope of this spec (which bands/boxes are in, which are later specs) — root
- B2 Hand-off "in series": how a project is born from the CRM (trigger, deal↔project
  cardinality, projects without a deal) — depends on B1
- B3 Project type: one of T&M / Fixed price / Maintenance; where it comes from; can it change — depends on B2
- B4 Per-type terms: Fixed price (deadline, max effort, man days), Maintenance (SLA,
  hour package), T&M (?) — depends on B3
- B5 People and access: who runs projects (OPS), who sees money — depends on B1
- B6 Project lifecycle (states, closing) — depends on B3
- B7 Rigor tier — independent
- B8 Units of work inside a project (what they are, their name — "activity"/"task" are
  taken by the CRM, F8) — added by D4; depends on B3/B4
- B9 Discussion threads (who writes, what "history" means) — added by D30

Status: B1 closed, B2 closed (D2–D6), B3 closed (D7, A5), B4 closed (D8–D12), B5 closed
(D13–D15), B6 closed (D16–D17, A10); B2 reopened and closed again (D18–D20, D22, D25),
B3 extended (D21, D23, D24), B4 extended (D26), B8 closed (D27–D29), B9 threads closed
(D30–D31), B7 closed (D32). **Tree resolved.**

## Decision ledger — projects

Decided (the user chose):
- D1 Scope: this spec covers the **Project** only — its birth from a won deal, its type
  (T&M / Fixed price / Maintenance), the agreed terms per type, the project list and page.
  Time tracking and service desk are later specs (non-goals here); consumption
  against max effort / hour package is therefore not shown, only the agreed values —
  B1, recommended option chosen
- D1a Bexio: **no integration**. For now the Bexio **order id** is only recorded (typed
  in by a person) — user correction to D1, 2026-11-03
- D2 Hand-off: every won deal enters a PM **"to start" queue**; OPS creates a project from
  it (prefilled from deal, offer, estimate) or attaches it to an existing project; the deal
  stays in the queue until taken — because a closed deal can be reopened (017 AC-3.3), a
  won change request usually belongs to an existing project, and "in series" means sales
  hands over and OPS takes charge — B2a, recommended option chosen
- D3 Bexio order id: **one per won deal**, optional, typed in by **administration**
  (amministrazione), shown on the deal and on every project the deal feeds; a missing id
  never blocks starting a project — Admin and OPS are parallel branches off the deal on
  the whiteboard, and a project can gather several deals (change requests), each with its
  own order — B2-Bexio, recommended option chosen
- D4 Cardinality: **a won deal feeds exactly one project, and a project has exactly one
  type**; inside a project there are units of work ("activities — tasks or something else,
  suggest the name") — B2b, user's own answer (recommendation "1 deal → N projects" rejected)
- D5 A project can also be **created by hand without a deal**, always for a CRM company —
  contracts already running when the module ships (SLAs, maintenance sold before the CRM)
  must be manageable without fake won deals that would distort the pipeline; **internal
  projects without a client are out** (non-goal) — B2c, recommended option chosen
- D6 D4 holds with no exception: an offer that sells two kinds of work (020's "Una tantum +
  SLA prepagato", "CR a corpo con pacchetto manutenzione") is **two deals in the CRM**,
  each with its own project and its own Bexio order id (D3 unchanged). The user accepts the
  costs: two offers, or one offer on the main deal and none on the other; the second deal
  needs a ready estimate or the admin override to pass `qualified` (018 AC-3.4, AC-3.7) —
  conflict D4 vs 020 templates; recommendation "1 deal, 2 projects, Bexio id per link"
  rejected
- D7 The project type is **fixed at creation**; a wrong type means cancelling the project
  and creating a new one — terms are type-specific and the type mirrors what was sold —
  B3, recommended option chosen
- D8 Fixed-price terms are three values: a **deadline** (date), the **estimated man-days**
  (from the deal's estimate, read-only) and a **max effort** in man-days (the contractual
  cap, typed by hand, separate from the estimate) — B4-fixed, user chose the option
  "estimated and max distinct" over the recommended "deadline + max effort prefilled from
  the estimate"
- D9 A Maintenance project has an **SLA, an hour package, or both — at least one** — the
  "CR a corpo con pacchetto manutenzione" template already sells both together (F9) —
  B4-maintenance, recommended option chosen
- D10 An SLA records **two fixed priorities, high and normal**, each with a
  **take-in-charge time in working days**, defaulting to wellD's standard **1 and 3**,
  editable per project — every wellD offer uses this shape and the future service desk
  will measure against these numbers — B4-SLA, recommended option chosen
- D11 An hour package records the **hours purchased** (whole hours) and comes in **two
  shapes**: a capacity package (start date, optional expiry; renews "by capacity" per
  F10) **or** a yearly package (the hours apply to each yearly period) — B4-hours, user's
  own answer ("ore + inizio e scad. opz ma anche periodo annuale")
- D12 A T&M project has **one or more positions** (a profile such as "Senior developer",
  with its planned man-days), as in the Cornèr 0010 offer — B4-T&M, user chose "with
  positions" over the recommended "start, end, optional cap"
- D13 Access follows the CRM pattern: every holder of the module's **access** reads every
  project (ADR-0052 posture); creating projects (from the queue or by hand) and editing
  terms and units of work needs a **manage projects** capability **scoped to the entity**
  (like `deal:manage`), held by a new **project manager** role; the Bexio order id is
  written only with an **administration** capability, held by a new **administration**
  role; admins hold everything — OPS needs colleagues' projects (cover, workload), and
  per-project visibility would need an access list per record — B5a, recommended option
  chosen
- D14 **No money in projects** in v1: a project shows effort only (man-days, hours, SLA) and
  links to its deal, where figures stay behind `deal:financials` (ADR-0054) — billing is
  Bexio's, and people on projects are often technicians who see no figures today — B5b,
  recommended option chosen
- D15 A project has **one responsible project manager** (required; an Operai user with
  module access, checked like the CRM owner in 018 AC-2.2; the creator by default) and an
  **optional team** of Operai users with module access — "who works on what" is OPS's
  first question and time tracking will need who may book on a project — B5c, recommended
  option chosen
- D16 Project states: **planned → active → closed**, plus **on hold** and **cancelled**; a
  new project starts `planned` and becomes `active` **by hand** — B6, user chose "with
  planned" over the recommended "starts active"
- D17 A won deal **reopened** in the CRM: if still in the queue it **leaves the queue**; if
  it already feeds a project, the project is **unchanged** and its page shows a notice
  "the deal is no longer won", gone again if the deal is won again — user's criterion:
  "start with the least invasive and easiest to change"; the recommended option is that
  one (no CRM change, no automatic project state change) — B6b
- D18 Some projects are **born without a deal and are multi-tenant**: **several deals can
  refer to one pre-existing project** — user clarification before B8, 2026-11-03.
  **Conflicts with D5** ("always for a CRM company; internal projects without a client are
  out") when the deals come from different companies — resolved by D19
- D19 (amends D5) **Internal projects are in scope**: a project can be born internally,
  with no deal and no company, and a deal can come **afterwards** and be linked to it —
  e.g. **Koordy**, a project born internally, built multi-tenant, from which a deal was
  later born. So a project's company is **optional**; its clients are its own company (if
  any) plus the companies of the deals linked to it — user clarification, 2026-11-03.
  (The two-forms "client / multi-tenant" proposal was not needed.)
- D20 A deal linked to an existing project brings **only the link**: its company joins the
  project's clients, plus the link to the deal and its Bexio order id (D3); the project's
  type and terms do not change; client-specific terms stay in the CRM deal/offer in v1 —
  B2e, recommended option chosen, with the user's addition "a project can also NOT be
  multi-tenant by nature" (that addition is replaced by D22; the "terms stay in the CRM"
  part is under review in B2f)
- D22 There is **no "multi-tenant" type or flag**: a project may not be born multi-tenant.
  A project like Koordy is an **internal project** (type Internal, D21) — user, 2026-11-03
- D23 **Koordy is sold by licence**: all its clients buy the same thing, so "one client
  with an SLA, another with T&M" on one shared project does not happen — user correction
  of an example of mine, 2026-11-03; the user suggests mapping a **SaaS** type (B3c)
- D24 Five project types: **T&M, Fixed price, Maintenance, SaaS, Internal**. **SaaS** = a
  wellD product sold by licence: born without a deal and without a company, takes deals
  from any company, each deal a licence; **Koordy is SaaS** (replaces "Koordy is
  Internal" in D22). **Internal** = a project with no clients (internal tools, R&D, Operai
  itself) and takes no deals. The only type change allowed is **Internal → SaaS** (an
  internal product starts being sold — Koordy's history); D7 holds otherwise — B3c,
  recommended option chosen
- D25 Terms live on a **per-deal record in the PM module** (working name **contract**), not
  on the project and not on the CRM deal: one per won deal linked to a project, or entered
  **by hand** for contracts sold before the CRM (D5). A contract carries the client company,
  the deal link (absent for pre-CRM contracts), the Bexio order id (D3), start date and
  optional end date, and the type-specific terms of D8–D12; it always has its project's
  type. The project keeps the work: type, state, people, units of work. Supersedes the
  "terms stay in the CRM" part of D20 and moves D8–D12 from project to contract (content
  unchanged) — because terms differ per deal inside one project (CR deadline, extra hour
  package, T&M extension, each Koordy licence), OPS writes them (D13 needs no CRM access),
  and pre-CRM contracts need no fake deals (D5) — B2f, recommended option chosen after the
  user asked to see the field list first
- D26 A **SaaS** contract (a licence) records like a Maintenance one: the licence period
  (start, optional end), an optional SLA (D10 shape) and an optional hour package (D11
  shapes) — B4-SaaS, user chose "like Maintenance" over the recommended "period + optional
  SLA"
- D27 **Units of work are in this spec; time tracking stays out** — B8 scope, user chose
  over the recommended "defer units to the time-tracking spec"
- D28 Units of work are **lightweight to-dos**: a title, an assignee, a due date, done / not
  done — no man-days, no link to the estimate or to a contract — B8a, user chose "light
  to-dos" over the recommended "planned unit"
- D29 When an **estimate** exists, its **link** is shown in the detail — user, 2026-11-03
- D30 A project has **discussion threads with history** — user, 2026-11-03 (details: B9)
- D31 Threads: any module-access holder opens a thread (title + first message) and replies;
  messages in chronological order with author and time; the author may **edit** their own
  message and **previous versions stay visible** ("edited"); **no message is ever
  deleted** — history must show what was decided and when — B9, recommended option chosen
- D32 Rigor **mvp** — user: "proceed with mvp if the CRM was done in mvp" (it was: F12);
  the user had first picked production over the recommended mvp, then conditioned it on the
  CRM — B7
- D33 The feature is **split in three specs**: specs/025 projects (projects, contracts,
  Bexio order id, access), specs/026 projects-handoff (to-start queue, contracts from won
  deals, reopen notices, estimate link and copy, CRM deal page), specs/027
  project-collaboration (tasks, threads). One ledger, here — asked by the user at spec
  review; recommended option chosen
- D34 (closes O3) **A contract is never removed**: it ends by setting its end date. A deal
  attached to the wrong project stays attached ("not supported"); a hand-entered contract
  is not deleted either — O3, user chose "no undo" over the recommended "remove, deal back
  to the queue"
- D35 (amends D13) The Bexio order id is written by the **existing `accounting` role**
  (amministrazione / contabilità), which gains module access and the Bexio-order
  capability; **no new "administration" role** — recommended option chosen at 025 review
- D36 (amends D2/D13) **Both OPS and BD open projects**: besides the project manager role,
  the existing **`sales`** role (BD) can create a project — from the queue or by hand —
  user, at 025 review ("il progetto lo possono aprire sia OPS che BD")

Delegated (the user deferred to the recommendation):
- D21 An internal project (Koordy) has a fourth type, **Internal**, with no terms — user:
  "Internal or no type makes no difference"; recommended because every project then has a
  type (no empty case in lists and filters) — B3b

Found (read from the repo, not asked):
- F1 CRM stages are `lead → qualified → proposal → negotiation → won | lost`; a company
  becomes `customer` when a deal is won (AC-1.8) — specs/017-crm/spec.md
- F2 An estimate request links a deal to one EstimAI estimate (releases, epics, man-days);
  a deal cannot reach `proposal` without a `ready` estimate — specs/018-crm-sales-flow/spec.md
- F3 Offer templates already name the commercial kinds wellD sells: fixed-price project,
  phased fixed price, prepaid yearly SLA, maintenance package, consulting by the day
  billed on actuals with a monthly timesheet, training — specs/020-crm-offer-document/spec.md
- F4 Money in the CRM is behind `deal:financials`; `crm-technical` sees no figures — ADR-0054
- F5 Two legal entities, `welld_ch` and `welld_it`; every CRM record belongs to one — specs/017
- F6 `projects-api/` exists with only an untracked `.env`: no code, no spec, no ADR — repo root
- F7 Bexio, time tracking and service desk appear nowhere in specs, ADRs or code — repo-wide grep
- F8 "activity" and "task" are taken: the CRM shows activities as "Attività" and tasks as
  "Attività da fare" / "Tasks" — crm-ui/src/strings/activities.ts, nav.ts
- F9 wellD's standard SLA (seeded offer templates): ticket **take-in-charge** times by
  priority — high (severe fault, system down) 1 working day, normal (minor fault) 3 working
  days; working day 9:00–18:00 CET on the Ticino calendar; no penalties, no resolution
  times; renewed yearly. The "CR a corpo con pacchetto manutenzione" template carries the
  SLA **and** a prepaid hour package (credit note for the remainder on early termination);
  extra work at 140/hour — crm-api/src/offers/defaultTemplates.ts
- F10 Standard renewal clause: every recurring (time) or capacity (hours) cost line has a
  3-month notice for both parties; without notice it renews for the same duration/capacity
  — crm-api/src/offers/defaultTemplates.ts (RENEWAL_IT)
- F11 The CRM has **no contract entity**: a deal is the sales opportunity (amount, stage,
  can be lost or reopened); an offer is the PDF titled "CONTRATTO DI FORNITURA – Rif. …",
  whose terms are free text in template sections plus money cost lines; which version the
  client signed is not recorded. "Contract" appears only in prose and in the PDF renderer's
  name — specs/017, specs/018, specs/020, crm-api/src/offers/contract.ts
- F12 specs/017–020 all carry `rigor: mvp` in their frontmatter — specs/01[7-9]*/spec.md,
  specs/020*/spec.md

Assumed (not load-bearing; strike any that is wrong):
- A1 Whiteboard "Lead" = a CRM deal in an open stage; "Deal" = a deal `won`; "No deal" = `lost`.
- A2 "OPS" = the people who deliver the work (delivery / operations), not a role that exists in auth today.
- A3 D4 limits the deal side only: a project may still gather several won deals (a change
  request attached to an existing project, D2/D3).
- A5 OPS picks the project type when creating the project (from the queue or by hand); in
  v1 nothing maps an offer template to a project type (templates carry no type, and a
  mixed template would map to two).
- A6 The estimated man-days (D8) are a snapshot taken when the project is created (what
  was sold), not a live read of the estimate; a project created by hand without a deal
  (D5) has them typed in, or left empty.
- A7 A yearly hour package (D11) runs in 12-month periods from its start date (not the
  calendar year), the same hours each period.
- A8 A position (D12) is a profile, not a person; who staffs it belongs to B5/B8. Dates
  live on contracts (D25); a project has no dates of its own and shows the earliest
  contract start and the latest contract end.
- A14 The working name "contract" is confirmed (or replaced) at spec review as a glossary
  change; it is the delivery-side record of a won deal, not the offer PDF.
- A15 Unlike Maintenance (D9, at least one of the two), a SaaS licence may have neither an
  SLA nor an hour package: both are optional.
- A16 The estimate link (D29) is on the **contract** detail (the estimate belongs to the
  deal, so to its contract); the project page lists its contracts with their links; it
  opens in EstimAI under EstimAI's own permissions (as 018 AC-3.2).
- A17 The to-do (D28) is named **task** (IT "attività da fare"): the same concept as the
  CRM task — something someone must do, with an assignee and an optional due date, open
  until completed — on a project instead of a company. Confirmed at review as a glossary
  change.
- A18 A task's assignee is the project manager or a team member (D15).
- A19 Threads send no notifications in v1; they are read in place, like CRM activities.

Added when writing the spec (not asked; strike any that is wrong):
- A20 The to-start queue is readable by every access holder; only a project manager of the
  deal's entity takes a deal from it (D13 scoping).
- A21 A Fixed-price contract requires its deadline and max effort.
- A22 The assignee of a task may mark it done or not done; creating, editing and
  reassigning tasks needs manage projects (D13).
- A24 The Bexio order id is free text up to 64 characters, not checked against Bexio nor
  for uniqueness.
- A26 Deals already won when the module ships appear in the queue too.
- A27 A closed project, like a cancelled one, takes no new contract until reopened.
- A28 Threads are plain text: no attachments, no mentions in v1.
- A29 D36 gives `sales` the **same** manage-projects capability as the project manager,
  entity-scoped (create, attach, edit terms, move states), not a narrower "create only"
  one; whoever creates a project is its project manager by default and can hand it to an
  OPS colleague (D15).
- A9 A project belongs to one entity (`welld_ch` | `welld_it`): the deal's, or the
  company's when created by hand (D5), or chosen by hand for an internal project (D19). A
  deal of the other entity may still be linked to it.
- A10 `on hold` is reachable from `planned` or `active` and returns to the state it left;
  `closed` can be reopened to `active` by a project manager; `cancelled` is final and
  reachable from any state but `closed`.
- A11 Whiteboard "Lead: onboarding" = a deal that puts a new client (tenant) on an existing
  multi-tenant project, with no estimate loop; "Lead: offering" = a deal that goes through
  "Sale + Eng. → Estimate" (018) and usually feeds a new project.
- A12 A client project (T&M, Fixed price, Maintenance) takes linked deals only from its own
  company (change requests); SaaS from any company; Internal from none (D24).

Open (unresolved — each needs an owner):
- O1 A maintenance/SLA deal split off a mixed offer (D6) usually has no technical estimate:
  should 018's estimate gate (AC-3.4) exempt such deals? A CRM change, outside this spec —
  owner: product owner
- O2 Do unused hours of a yearly package carry over to the next period? Only matters once
  consumption exists — owner: product owner, for the time-tracking spec
- ~~O3 How is a deal attached to the wrong project undone?~~ Closed by D34.
