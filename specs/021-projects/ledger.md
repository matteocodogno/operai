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
- D33 The feature is **split in three specs**: specs/021 projects (projects, contracts,
  Bexio order id, access), specs/022 projects-handoff (to-start queue, contracts from won
  deals, reopen notices, estimate link and copy, CRM deal page), specs/023
  project-collaboration (tasks, threads). One ledger, here — asked by the user at spec
  review; recommended option chosen
- D34 (closes O3) **A contract is never removed**: it ends by setting its end date. A deal
  attached to the wrong project stays attached ("not supported"); a hand-entered contract
  is not deleted either — O3, user chose "no undo" over the recommended "remove, deal back
  to the queue"
- D35 (amends D13) The Bexio order id is written by the **existing `accounting` role**
  (amministrazione / contabilità), which gains module access and the Bexio-order
  capability; **no new "administration" role** — recommended option chosen at 021 review
- D36 (amends D2/D13) **Both OPS and BD open projects**: besides the project manager role,
  the existing **`sales`** role (BD) can create a project — from the queue or by hand —
  user, at 021 review ("il progetto lo possono aprire sia OPS che BD")

Steering of 2026-11-04 (specs/022 re-opened at gate 1; nothing of 021/022 was on `main` yet):
- D37 (amends D2, A20) The **to-start queue is for the sales team only**: it is seen by
  `sales` (BD) and admins, and only they create a project from a deal. The project-manager
  role no longer sees the queue nor takes deals — user ("no to start a tutti, ma solo al team
  sales")
- D38 (amends D25, D34, A14) The per-deal record is renamed **purchase order** (PO) and a
  project has **zero or one** PO. A PO is born **only from a won deal**, together with its
  project; a project born without a PO (created by hand) **never gets one**. So no PO is
  ever entered by hand, and the type-specific terms (D8–D12, D26) exist only on a PO — user
  ("rinominare contratto con purchase order e tenere 0-1 col progetto; se il progetto nasce
  senza PO allora rimarrà per sempre senza PO"), and answer "No, PO solo da deal" over the
  recommended "a hand-made project may be born with a hand-entered PO"
- D39 (amends D2, D18–D20, A3, A12) **No attach**: a won deal never joins an existing
  project; every won deal, a change request included, starts a new project — user ("togliere
  attach to project")
- D40 (amends D24, D26) **One project per SaaS licence**: `saas` becomes a client type — a
  licence deal makes a `saas` project for its company, with its PO; the product itself
  (Koordy, wellD Fleet) is an `internal` project without a PO — recommended option chosen
- D41 A PO has a **referent**: one of the CRM contacts of the PO's company, chosen when the
  PO is created, optional and changeable — user ("referente sul purchase order"),
  recommended option chosen
- D42 (amends D15, A29) A new **`ops-manager`** role (responsabile OPS), entity-scoped. When
  BD creates a project and its PO from a deal, BD assigns the PO to an ops-manager of the
  deal's entity — **prefilled when the entity has exactly one**; the ops-manager receives a
  notification and **then picks the project manager**; until then the project has no project
  manager — user ("assegnamento del PM da parte del responsabile OPS dopo che un purchase
  order è stato creato; alla creazione il BD assegnerà il PO al responsabile OPS il quale
  riceverà una notifica"; "nuovo ruolo; se ce ne è solo 1, viene prepopolato; i PM saranno la
  scelta successiva del ops-manager")

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

Added at the 2026-11-04 steering (my defaults, not asked; strike any that is wrong):
- A30 With D40 the `internal` → `saas` type change loses its reason (the product stays
  internal; licences are their own projects): a project's type never changes (D7 without
  the D24 exception).
- A31 The ops-manager's notification (D42) is in-app only (notification centre), no email;
  it links to the project.
- A32 The rename of D38 is applied everywhere — spec language, UI copy (EN "Purchase order",
  IT "Ordine d'acquisto"), API and data model — so that code and domain use one word.
- A33 A project created by hand keeps 021's type and company rules (a client type, `saas`
  now included, needs a company) and simply has no PO, hence no terms; it is created by any
  holder of manage projects and its creator is its project manager by default (D15
  unchanged for it).
- A34 Once the ops-manager has picked the project manager, changing it later follows 021
  (any holder of manage projects for the entity).
- A35 The `ops-manager` role holds module access and entity-scoped manage projects (like the
  project-manager role) plus being assignable as a PO's ops-manager.
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

---

## Grilling of 2026-11-05 — specs/022 amended spec (steering D37–D42)

target: specs/022-projects-handoff/spec.md (status in-progress, gate 1 re-opened) · complete: true (tree resolved)

### Decision map
- G1 Creation split: what BD fills when creating project + PO from a deal (type, PO dates
  and terms) and what OPS fills later — root
- G2 The ops-manager: who can be one (admins? Q1), prefill, entity with none — depends on G1
- G3 Who picks the project manager and when (only the assigned ops-manager or any manage
  holder; reassigning a PO, Q3) — depends on G2
- G4 A project awaiting its project manager: state moves and edits meanwhile (Q2, S2) —
  depends on G3
- G5 The referent: what is shown, to whom, kept or read live (Q4, S4) — independent
- G6 Projects created by hand: which types, who creates, who is project manager (A33) —
  independent
- G7 The ops-manager's notification: language, failure (Q5, S1) — leaf of G2

### Decision ledger — specs/022 steering, grilled
Decided (the user chose):
- D43 (G1) **BD fills everything** when creating project + PO from a deal: type, PO start
  and optional end date, and the type's terms under specs/021's rules (e.g. a fixed price
  needs its deadline and max effort); holders of manage projects correct them afterwards
  — recommended option chosen (the terms are in the offer BD wrote; as built, F13)
- D44 (G2, closes Q1) A PO's ops-manager is chosen among the holders of the `ops-manager`
  role for the deal's entity **and the admins** — user chose this over the recommended
  "role holders only"
- D45 (G2, amends D42's prefill) The prefill **counts role holders only**: with exactly one
  `ops-manager` for the entity, that person is prefilled; admins stay pickable by hand —
  recommended option chosen, asked as a consequence of D44 (counting admins too would
  almost never prefill: two admins exist today)
- D46 (G3, closes Q3) The project manager of a project awaiting one is picked **only by the
  person assigned to its PO at creation** — user's own answer ("chi è assegnato a quel
  PO/Progetto in fase di creazione"), over the recommended "any ops-manager of the entity or
  an admin" and over the amended spec's "any holder of manage projects" (AC-4.8)
- D47 (G3) If the assignee is away or leaves, **an admin picks the project manager in their
  place**; there is **no reassigning a PO** in v1 — recommended option chosen, asked as a
  consequence of D46 (admins already hold every capability, specs/021 AC-4.6)
- D48 (G4, closes Q2) While a project awaits its project manager, **`planned` → `active` is
  refused** with a message; every other edit and state move follows specs/021 as usual —
  user chose this over the recommended "no restriction" (replaces S2 and the amended
  AC-4.7)
- D49 (G5, closes Q4) A PO's page shows its referent's **name, job title, email and phone,
  read live from the CRM and never copied** onto the PO (a CRM erasure takes effect; a CRM
  outage shows "referent unavailable"); a security check of this read comes before
  implementation — recommended option chosen
- D50 (G6, amends D38's consequence and A33) A project **created by hand** may be of **any
  type** (a client type, `saas` included, needs a company); its creator is its project
  manager, changeable; it never has a PO (no deal, Bexio order id, referent or ops-manager)
  but **may carry its type's terms, optionally** (deadline and max effort, SLA, hour
  package, positions, licence period), at creation or later — user ("qualunque tipo, ma
  potrebbe avere il termine; il PM è chi lo crea, modificabile"), then the recommended
  reading "the type's terms, optional" chosen when asked what "il termine" meant
- D51 (G7, closes Q5) The ops-manager's notification is **English only**, like the CRM's
  (F16) — a declared exception to specs/021 AC-4.7's EN+IT copy — recommended option chosen
Delegated (the user deferred to the recommendation):
- (none)
Found (read from the repo, not asked):
- F13 The as-built "new project from a deal" request already carries name, type, project
  manager and the full contract terms in one step — projects-api/src/queue/take.routes.ts:70-78
- F14 A CRM contact has an optional company and can be archived; crm-api's service routes
  expose companies and deals, not contacts, so a referent picker needs a new CRM read —
  crm-api/prisma/schema.prisma:87-97, crm-api/src/system/
- F15 auth's user directory is opened by project:manage and lists users with their entity;
  it has no role filter today — auth/src/authz/directory.routes.ts:65-90
- F16 CRM notifications are English only and strictly best-effort (never block the
  action) — crm-api/src/lib/notify.ts:8-25
Assumed (not load-bearing; strike any that is wrong):
- (carried from the amended spec: S1–S4, A30–A35)
- A36 (from D44) An entity with no `ops-manager` holder does not block creation: nothing is
  prefilled and an admin is picked; creation is refused only when the chosen person is
  neither a role holder for the entity nor an admin (replaces the "no ops-manager" refusal
  of the amended AC-4.2)
- A37 (G5) Referent candidates are the non-archived contacts of the PO's company (S4); any
  holder of manage projects for the entity sets, changes or clears it (amended AC-3.7)
- A38 (G6) On a hand-made project the terms are optional as a whole; once entered they
  follow specs/021's per-type rules (a fixed price's deadline and max effort together, a
  maintenance's SLA or hour package, positions > 0)
Open (unresolved — each needs an owner):
- (none from this session; O1 of the spec stays open as before)

Gate 1 re-approved 2026-11-05 (recommended option): D43's "correct them afterwards" covers
the PO's dates and terms, **not the type** — D7 holds; the PO's S5 (a hand-made project's
terms can be removed as a whole) and S6 (a referent archived after being chosen stays shown)
accepted; one spec, no split; glossary updated (purchase order, PO's deal, terms, hand-made
project, referent, ops-manager, awaiting a project manager; "contract" retired).

Constraint of 2026-11-05 (user, after the gate): *"la nuova PR sarà on top alla 7"* — the 022
PR is stacked on the open PR #7 (specs/021 as written). 021's migration `20261103163000_init`
therefore ships first and is kept; only 022's never-shipped `*_handoff` migration is
replaced, by a guarded `*_purchase_order` migration on top (specs/022 tasks.md).

Defect found during the 022 QE window (2026-11-05), added to specs/022 by the user:
- D52 **Browser back/forward across suite modules shows the right page.** Every remote module
  (admin, crm, estimai, inventory, notify, projects, refund) builds its router once at module
  load; after the shell switches module and the user comes back with the browser's back
  button, the module renders a page matched from the *other* module's address (projects-ui:
  `GET /projects/admin` → "Project not found"; crm-ui: "This page does not exist"). Pre-existing
  since specs/017/021, not caused by 022. User chose "Dentro la 022" over the recommended
  "separate bugfix after 022" — gate 1 re-opened (35 → 36 ACs).
- D53 (2026-11-06, after the 022 QE round 2 PASS) Two more defects go **into 022**, by the
  user's choice ("Dentro la 022") over the recommended "close 022, separate bugfixes after":
  **D4** — the browser's back/forward *inside* one module changes the address but not the page
  (e.g. `/projects` → "To start" → back still shows "To start"; same in the CRM); pre-existing
  (reproduced at the pre-T37 code), every remote module. **D2 remainder** — a field's error
  message stays after the field is corrected, until the next submit, in projects-ui's take
  dialog, "Edit details", the terms dialogs (fixed for the hand-made create dialog only).
  Gate 1 re-opened (36 → 38 ACs).
