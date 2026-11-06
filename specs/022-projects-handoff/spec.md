---
id: 022
slug: projects-handoff
status: done
rigor: mvp
created: 2026-11-03
approved: 2026-11-06
done: 2026-11-06
depends-on: 021
---

# Projects hand-off — a won deal reaches OPS "in series"

Decision ledger: `../021-projects/ledger.md` (shared with specs/021 and specs/023)

> **Origin.** Split out of specs/021 on 2026-11-03 (ledger D33). specs/021 gives projects
> and their purchase order; this spec connects them to the CRM pipeline of specs/017 and
> the estimates of specs/018, so that every won deal becomes a project with its purchase
> order.

> **Amended 2026-11-04 (steering, ledger D37–D42).** Gate 1 was re-opened by the user; nothing
> of specs/021 or 022 was on `main` yet. What changed, and where each AC says so:
> - **Sales only** — the to-start queue and "new project from a deal" belong to `sales` and
>   admins; the project manager no longer sees the queue (D37; supersedes D36's "OPS or BD
>   take a deal" and A20).
> - **"Contract" is now "purchase order" (PO)** — a project has 0 or 1 PO, born only from a
>   won deal together with its project; a hand-made project never has one (D38, A32).
> - **No attach** — every won deal, a change request included, starts a new project; ACs
>   1.4, 1.5 and 1.7, the "undoing an attachment" non-goal and assumptions A12 and A27 are
>   retired (D39). Retired AC numbers are not reused.
> - **`saas` is a client type** with a company and its own PO, one project per licence (D40,
>   A30); the type of a project never changes.
> - **Referent** on the PO (D41); **ops-manager** role: BD assigns the PO to one, who is
>   notified and then picks the project manager; until then the project has none (D42,
>   A31, A34, A35). New US-4.
> - The code and `tasks.md` built so far target the earlier text (contract, attach, project
>   manager = creator); the tasks are to be re-derived from this version.

> **Amended 2026-11-05 (grilling of this spec, ledger D43–D51).** Gate 1 was re-opened again;
> the grilling answered Q1–Q5 and S2/S4 of the text above. What changed:
> - **BD fills everything** at creation: type, PO dates, the type's terms (D43; AC-1.2, 1.8).
> - **Ops-manager candidates** are the role's holders for the entity **and the admins**;
>   prefill counts role holders only; an entity with no ops-manager no longer blocks creation
>   (D44, D45, A36; AC-4.1, 4.2). The notification is **English only** (D51; AC-4.3).
> - **Only the person assigned to the PO picks the project manager**, an admin in their place;
>   no reassigning a PO (D46, D47; AC-4.8). While a project awaits one, **`planned` → `active`
>   is refused** (D48; AC-4.7).
> - **Referent** is read live from the CRM and never copied; erasure and outage are handled
>   (D49, A37; new AC-3.8–3.10).
> - **Hand-made projects** may be of any type, are managed by their creator, never have a PO,
>   and may carry their type's terms optionally (D50, A38; new US-5, AC-5.1–5.4). The
>   non-goal "terms on a project without a PO" and assumption A33 as written are replaced.
> - Q1–Q5 closed; S2 and S4 retired (replaced by D48 and by A37/D49). O1 stays open.

> **Amended 2026-11-05 (QE window, ledger D52).** Gate 1 was re-opened a third time, by the
> user's choice, to add a defect that predates this spec: browser back/forward between suite
> modules shows a wrong page (new US-6, AC-6.1; 35 → 36 ACs). Nothing else changes.

> **Amended 2026-11-06 (after QE round 2, ledger D53).** Gate 1 was re-opened a fourth time, by
> the user's choice, to add two more defects that predate this spec: browser back/forward
> *within* one module shows a stale page (AC-6.2, under US-6) and a field's error message stays
> after the field is corrected (new US-7, AC-7.1); 36 → 38 ACs. Nothing else changes.

## Problem

When a deal is won in the CRM (stage `won`, which may be reopened:
`specs/017-crm/spec.md:41-42`), nothing tells the people who deliver it. The work starts when
someone remembers to mention it; the estimate the offer rested on has to be looked up again;
and from the deal there is no way to see which project carries it or which Bexio order it
became. Sales knows the client and what was sold, but not who in OPS will run the delivery:
that choice belongs to OPS, and it has to be asked for, not guessed. A deal reopened after the
fact — a mistake, or a client changing their mind — leaves the delivery side unaware.

## Domain language

- **to-start queue** — the won deals that have no purchase order yet; seen by `sales` and
  admins only (D37).
- **purchase order (PO)** — the delivery-side record of one won deal: what the first draft of
  specs/021 called a "contract" (D38). A project has zero or one PO; a PO is born only from a
  won deal, together with its project; a project created by hand never gets one. It carries
  the deal, the client company, the project's type, a start date and optional end date, the
  type-specific terms of specs/021 AC-2.3–2.8, the Bexio order id, the estimate link, a
  referent and an ops-manager. It is not the offer PDF.
- A PO's **deal** — the won deal a PO was made from. A deal feeds at most one PO, hence one
  project (D4, D39).
- **terms** — the type-specific delivery terms of specs/021 AC-2.3–2.8 (deadline and max
  effort, SLA, hour package, positions, licence period). On a project made from a deal they
  are always recorded, with its PO; on a hand-made project they are optional (D50). Where
  they are stored — on the PO, on the project, or both — is not decided here.
- **hand-made project** — a project created directly, not from a deal (specs/021 AC-1.1). It
  has no PO, ever, and so no deal, Bexio order id, referent or ops-manager (D38, D50).
- **referent** (referente) — the person at the client whom the delivery talks to: one of the
  CRM contacts of the PO's company; optional and changeable (D41). Its details are read live
  from the CRM, never copied onto the PO (D49).
- **ops-manager** (responsabile OPS) — an entity-scoped role. A PO is assigned to one at
  creation, among the role's holders for the deal's entity and the admins (D44); the assignee
  is notified and then picks the project manager (D42, D46, A35).
- **awaiting a project manager** — the state of a project made from a deal whose ops-manager
  has not picked a project manager yet; the only case of a project without one (D42).

## User stories

### US-1 Sales hands over, the ops-manager takes charge
As a salesperson (BD), I want every won deal to wait for me in one queue and to turn it into a
project with its purchase order, so that no sold work is forgotten between sales and delivery.

- AC-1.1 *(amended D37)* Given a deal is `won` in the CRM and has no PO, when a holder of the
  `sales` role or an admin opens the to-start queue, then the deal is listed with its title,
  company, entity, won date and estimate link if it has one, and with no amount (D14, A26).
- AC-1.2 *(amended D37, D39, D43)* Given a deal in the queue, when a `sales` holder with manage
  projects for the deal's entity, or an admin, chooses "new project", then the form offers the
  project name prefilled from the deal's title (editable, required) and the type among
  `t_and_m`, `fixed_price`, `maintenance` and `saas` — not `internal`, which has no company
  and no PO — together with the PO's dates and terms (AC-1.8), referent (AC-3.6) and
  ops-manager (AC-4.1). Sales fills all of it at creation; nothing is left for OPS to fill
  except the project manager (D43, A5, A30).
- AC-1.3 *(amended D38, D42)* Given AC-1.2 completes, then a project exists with the deal's
  company and entity, the chosen type, state `planned` and no project manager (the person who
  created it is not made one); it has exactly one PO made from the deal, carrying the deal's
  company and the project's type; and project and PO exist together or not at all.
- ~~AC-1.4~~, ~~AC-1.5~~ — retired (D39): there is no attaching a deal to a project.
- AC-1.6 *(amended D38)* A deal feeds at most one PO, hence one project: a deal that has a PO
  is not in the queue, and a second "new project" for it is refused (D4).
- ~~AC-1.7~~ — retired with attach (D39); a PO is still never deleted (see Non-goals).
- AC-1.8 *(new, D38; amended D43)* Given the form of AC-1.2, then it also collects the PO's
  start date, an optional end date and the terms of the chosen type as specs/021 AC-2.3–2.8
  define them (`saas`: the licence period, an optional SLA and an optional hour package);
  terms that break one of those rules are refused naming the field, and nothing is created.
  Afterwards any holder of manage projects for the entity can correct the dates and the terms
  (D43); the type itself never changes (specs/021 AC-1.2, D7).
- AC-1.9 *(new, D37)* Given a user who is neither an admin nor a `sales` holder — a project
  manager, an ops-manager, accounting, any other holder of project access — then the project
  module's navigation shows no queue entry, and the queue and "new project" are refused
  (403).
- AC-1.10 *(new, D38, D39)* No action attaches a deal to an existing project or adds a PO to
  one: a request to create a PO on an existing project is refused. A project has at most one
  PO, created with it; a hand-made project never gets one (AC-5.2).
- AC-1.11 *(new)* "New project" is refused, with a message saying why and nothing created,
  when the deal's live stage is no longer `won`, or the person lacks manage projects for the
  deal's entity (S3). When the CRM cannot be reached the queue and "new project" answer
  "unavailable" instead of showing an empty queue (`projects-api/src/queue/queue.routes.ts:12`).

### US-2 A reopened deal is visible, never destructive
As a project manager, an ops-manager or a salesperson, I want to know when a deal behind a
project is no longer won, so that I can act on it without the CRM undoing the project.

- AC-2.1 Given a deal in the queue, when it is reopened in the CRM, then it leaves the queue
  (D17).
- AC-2.2 Given a deal that left the queue by being reopened, when it is won again, then it
  is back in the queue (D17).
- AC-2.3 *(amended: PO)* Given a deal that has a PO, when it is reopened in the CRM, then its
  project and PO are unchanged and both show the notice "the deal is no longer won" (D17).
- AC-2.4 Given the notice of AC-2.3, when the deal is won again, then the notice is gone
  (D17).

### US-3 The PO carries what the deal knows
As a project manager, I want a PO made from a deal to start from what sales already
recorded, so that I do not retype it and I know whom to talk to at the client.

- AC-3.1 *(amended: PO)* Given a `fixed_price` PO is created from a deal with an estimate,
  then its estimated man-days are copied from the estimate and cannot be edited; a later
  change to the estimate does not change them (D8, A6).
- AC-3.2 *(amended: PO)* Given a PO made from a deal with an estimate, when its page is
  opened, then it shows a link that opens the estimate in EstimAI; a person without access to
  it in EstimAI sees it as unavailable (D29, A16).
- AC-3.3 *(amended: PO)* A PO shows the deal's title as a link to the CRM. The origin
  "from deal" / "entered by hand" of specs/021 AC-2.1 no longer exists: every PO is from a
  deal.
- AC-3.4 *(amended: PO)* Given a deal that has a PO, when a CRM user opens the deal page, then
  it shows the project's name and the PO's Bexio order id (empty if none), read-only (D3;
  built at `crm-api/src/lib/projects.ts:1-4`).
- AC-3.5 *(new)* Given a `fixed_price` PO is created from a deal that has no estimate, then
  its estimated man-days may be typed or left empty (specs/021 AC-2.3).
- AC-3.6 *(new, D41; amended A37)* A PO has an optional referent chosen among the non-archived
  CRM contacts of the PO's company, in the form of AC-1.2 or later; a contact of another
  company, a contact with no company, an archived contact or an unknown contact is refused
  with a message.
- AC-3.7 *(new, D41; amended A37)* A holder of manage projects for the PO's entity can set,
  change or clear the referent; anyone else gets no control and the server refuses.
- AC-3.8 *(new, D49)* Given a PO with a referent, when its page is opened by any holder of
  project access — with or without access to the CRM — then it shows the referent's name, job
  title, email and phone (a detail the contact lacks is left blank); the values are read from
  the CRM at each opening and are never copied onto the PO, so a change made to the contact in
  the CRM shows at the next opening.
- AC-3.9 *(new, D49)* Given a PO whose referent contact has been erased in the CRM (specs/017
  AC-2.4), when its page is opened, then it shows no referent and none of the contact's data.
- AC-3.10 *(new, D49)* Given a PO with a referent and the CRM cannot be reached, when its page
  is opened, then the referent's place reads "referent unavailable" and the rest of the page
  is shown.

*Gate before implementation (D49):* the referent is a third party's personal data
(`specs/017-crm/spec.md:37-38`) and the project module has people who cannot open the CRM; a
security check of this read — what crosses from the CRM to the project module, and to whom —
is done before it is built.

### US-4 The ops-manager is told and picks the project manager
As an ops-manager (responsabile OPS), I want to be told when a PO is assigned to me and to
choose who manages its project, so that each delivery starts with the right person in charge.

- AC-4.1 *(new, D42, A35; amended D44, D45)* Given the form of AC-1.2, then the PO's
  ops-manager is required and chosen among the users who hold the `ops-manager` role for the
  deal's entity and the admins. When exactly one user holds the role for that entity, that
  person is prefilled — admins are not counted; otherwise (none, or several) nothing is
  preselected and creation without a choice is refused.
- AC-4.2 *(new, D42; amended D44, A36)* "New project" is refused, with a message saying why,
  nothing created and the deal still in the queue, when the chosen user is neither a holder of
  the `ops-manager` role for the deal's entity nor an admin. An entity with no ops-manager
  does not block creation: an admin can be chosen.
- AC-4.3 *(new, D42, A31; amended D51)* Given a project and PO created from a deal, then the
  PO's ops-manager receives one in-app notification that names the project and links to its
  page; no other user is notified and no email is sent. The notification text is English only
  — a declared exception to specs/021 AC-4.7's English and Italian copy (D51).
- AC-4.4 *(new, S1)* Given the notification of AC-4.3 cannot be delivered, then the project
  and PO are still created and the project stays awaiting a project manager (AC-4.5).
- AC-4.5 *(new, D42)* Given a project awaiting a project manager, when the projects list is
  opened, then its project-manager cell reads "Awaiting project manager" and not blank, and
  the list's project-manager filter offers "none yet" (specs/021 AC-1.4).
- AC-4.6 *(new, D42)* Given a project awaiting a project manager, when its page is opened,
  then it shows a notice naming the PO's ops-manager and linking to the PO.
- AC-4.7 *(new, D42; amended D48)* Given a project awaiting a project manager, when a state
  move from `planned` to `active` is requested, then it is refused with a message saying why;
  every other edit of the project and its PO, and every other state move, follows specs/021
  AC-1.3 as usual.
- AC-4.8 *(new, D42; amended D46, D47)* Given a project awaiting a project manager, when the
  person assigned as its PO's ops-manager at creation — or an admin, in their place — picks
  its project manager among the holders of project access, then the project shows that
  person, is no longer awaiting, and the notice of AC-4.6 is gone. Anyone else, another
  ops-manager and any other holder of manage projects included, gets no control to pick it and
  the server refuses; a person without project access is refused with a message (specs/021
  AC-1.6). A PO is not reassigned to another ops-manager in v1.
- AC-4.9 *(new, A34)* Once a project has a project manager it cannot be left without one:
  clearing it is refused; changing it follows specs/021 (any holder of manage projects for the
  entity).

### US-5 A hand-made project is told apart from a PO project
As a holder of manage projects, I want to create a project by hand — for work that has no won
deal in the CRM — and know that it never has a purchase order, so that what is delivered
under a deal and what is not stay distinguishable.

- AC-5.1 *(new, D50, A33)* Given a holder of manage projects for an entity creates a project
  by hand (specs/021 AC-1.1), then they can choose any type — `t_and_m`, `fixed_price`,
  `maintenance`, `saas` or `internal`; a company is required for every client type, `saas`
  included, and absent for `internal` (otherwise refused with a message); the creator is the
  project manager; the project is `planned` and is not awaiting a project manager; the
  creator, or any holder of manage projects for the entity, can change the project manager
  later (AC-4.9 still forbids clearing it).
- AC-5.2 *(new, D50, D38)* A project created by hand never has a PO: it has no deal, no Bexio
  order id, no referent and no ops-manager; its page shows none of them and offers no control
  to set one, nobody is notified when it is created, and a request to give it a PO is
  refused (AC-1.10).
- AC-5.3 *(new, D50, A38)* Given the creation form of a hand-made project, then it offers the
  terms of the chosen type (specs/021 AC-2.3–2.8) as optional: a project is created either
  with no terms or with a set of terms that meets the type's rules in full (a `fixed_price`'s
  deadline and max effort together, a `maintenance`'s SLA or hour package, a `t_and_m`'s
  positions each with man-days above zero, a `saas`'s licence period); an incomplete or
  invalid set is refused naming the field, and nothing is created. `internal` has no terms.
- AC-5.4 *(new, D50, A38)* Given a hand-made project, when a holder of manage projects for its
  entity sets or edits its terms later, then the same rule as AC-5.3 applies, a refusal
  changes nothing, and the project page shows the terms it has (none shown when it has none);
  a project made from a deal shows its terms with its PO.

### US-6 Browser back and forward show the right page, between modules and within one
As a suite user, I want the browser's back and forward buttons to take me to the page I left —
when I move between modules and when I move within one — so that going back never shows me a
wrong page or an error.

- AC-6.1 *(new 2026-11-05, D52 — pre-existing defect, fixed here by the user's choice)* Given
  a user on a page of one suite module, when they navigate to another module and then return
  with the browser's back button — or its forward button, after going back — then the module
  whose address the browser lands on shows the page of that address (for `/projects`, the
  projects list), never a page matched from the other module's address, and sends no request
  derived from that other address (no project lookup named `admin` or `crm`). It holds for
  every remote module of the shell — admin, CRM, EstimAI, inventory, notifications (notify),
  projects and refund — whichever of them is left and whichever is returned to. Today
  (reproduced 2026-11-05 with a headless browser, D52): `/projects` → `/admin` → back requests
  `GET /projects/admin` and shows "Project not found"; `/crm` → `/admin` → back shows "This
  page does not exist".
- AC-6.2 *(new 2026-11-06, D53 — pre-existing defect, fixed here by the user's choice)* Given
  a user moving *within* one suite module — projects list → "To start", projects list → a
  project, a CRM list → a company — when they use the browser's back button, or its forward
  button after going back, then the module shows the page of the address the browser lands on
  (back from "To start" shows the projects list; back from a project shows the list it was
  opened from; back from a company shows the CRM page it was opened from), every time and
  without any further navigation or reload. It holds for every remote module of the shell —
  admin, CRM, EstimAI, inventory, notifications (notify), projects and refund — and next to
  AC-6.1: moving between modules still lands on the right page. Today (QE round 2, finding D4,
  `specs/022-projects-handoff/qe-report.md:104-106`; reproduced 2026-11-05, 3 of 3 each, on
  the dev stack, and at the code from before AC-6.1 was built): the address changes and the
  page does not — `/projects` → "To start" → back shows the address `/projects` with "To
  start" still on screen; project → back stays on the project; `/crm` → a company → back stays
  on the company. A later navigation makes the page catch up. A production build was not
  checked.

### US-7 A field's error message is shown only while the field is wrong
As a person filling in a form of the project module, I want a field's error message to go away
when I change that field, so that the form never keeps telling me something is wrong after I
have acted on it.

- AC-7.1 *(new 2026-11-06, D53)* Given a form of the project module refused a field — a
  required value missing or a value invalid, whether the form or the server refused it — when
  the person changes that field (types, picks or clears a value), then its message is gone and
  the field is no longer marked invalid, without a new submit and even if the new value is
  still wrong; the next submit re-validates the whole form and shows a message again for any
  field still wrong. A message that names the end date because it falls before the start date
  also goes when the start date is changed. It holds for five dialogs: the take dialog ("New
  project" from a deal in the queue), "Edit details" of a project, the terms dialog (adding the
  terms of a hand-made project and editing the terms of any project), the end-terms dialog
  ("Set end date") and the hand-made create dialog (already so, fixed in the QE fix rounds).
  Today (QE round 2, finding D2, `specs/022-projects-handoff/qe-report.md:95-102`): in the
  take, edit-details and edit-terms dialogs the message and the invalid mark stay after the
  field is corrected, until the next submit (executed); in the end-terms dialog the same, by
  reading the source only (`projects-ui/src/components/EndTermsDialog.tsx:50,58,78`: the field
  error is set on a refusal and the date's change handler does not clear it).

## Non-goals

- **Automatic project creation** when a deal is won: a person takes every deal (D2).
- **One deal feeding several projects**, or one offer split across projects: a mixed offer
  is two deals in the CRM (D4, D6).
- **Attaching a deal to an existing project**, including a change request: it starts its own
  project (D39). A project that gathers several deals or several POs does not exist.
- **A PO entered by hand**, on a hand-made or an existing project (D38). A hand-made project
  may carry terms (AC-5.3) but never a PO.
- **Undoing a creation**: a project made from a deal by mistake is cancelled (specs/021
  AC-1.3); its deal does not return to the queue and its PO is never deleted (D34).
- **Mapping offer templates to project types** (A5).
- **Blocking a CRM reopen** because a project exists, or suspending the project
  automatically (D17).
- Changing the CRM's estimate gate for maintenance deals (O1).
- **Other notifications**: when a deal enters the queue, when a project manager is picked,
  reminders when an ops-manager does not act, an Italian version of the ops-manager's (A19,
  A31, D51). Only AC-4.3.
- **Reassigning a PO to another ops-manager**, or a "my POs" view (D47).
- **Copying the referent's data** into the project module, or showing it to anyone without
  project access (D49).
- **Restoring scroll position, filters or unsaved input** after a module switch: AC-6.1 and
  AC-6.2 are about which page shows, not about what state it comes back with (D52, D53).
- **Messages that are not tied to one field** — a form-level error such as "something went
  wrong" or "authentication unavailable" — and the validation messages of forms outside the
  project module: AC-7.1 covers a field's own message in the project module's five dialogs
  (D53). The pick-project-manager dialog and the PO's referent control already clear theirs
  (QE round 2).

## Assumptions (from the ledger — strike any that is wrong)

- A5 The person who creates the project from the deal (sales) picks the type; no offer
  template carries one.
- A6 Estimated man-days are a snapshot taken when the PO is created.
- A16 The estimate link sits on the PO; the project page shows its PO, if any.
- A19 No notifications in v1, except the ops-manager's of AC-4.3 (D42, A31).
- A26 Deals already `won` when the module ships appear in the queue too.
- A30 A project's type never changes; the product itself is an `internal` project, each
  licence a `saas` project.
- A31 The ops-manager's notification is in-app only, no email, and links to the project.
- A32 The rename to purchase order applies to spec language, UI copy (EN "Purchase order",
  IT "Ordine d'acquisto"), API and data model.
- A33 *(replaced by D50, A38)* A hand-made project may be of any type (a client type, `saas`
  included, needs a company; `internal` none); its creator is its project manager, changeable;
  it has no PO and may carry its type's terms, optionally.
- A34 Once the ops-manager has picked the project manager, changing it follows specs/021.
- A35 The `ops-manager` role holds project access and entity-scoped manage projects, and can be
  assigned as a PO's ops-manager.
- A36 An entity with no `ops-manager` holder does not block creation: nothing is prefilled and
  an admin is picked; creation is refused only when the chosen person is neither a role holder
  for the entity nor an admin (D44; replaces the "no ops-manager" refusal).
- A37 Referent candidates are the non-archived contacts of the PO's company (specs/017 defines
  archiving: `specs/017-crm/spec.md:55-56`); any holder of manage projects for the entity
  sets, changes or clears it (D41, D49).
- A38 On a hand-made project the terms are optional as a whole; once entered they follow
  specs/021's per-type rules (D50).
- Retired by the steering: A12 (a project takes POs for its own company; no attach), A20 (the
  queue is readable by every access holder; replaced by D37) and A27 (a closed project takes
  no new PO; no attach).

Added by this spec, not in the ledger (strike any that is wrong):

- S1 Notifying is best-effort: a failed push never blocks creating the project, as in the
  CRM's own notifications (`crm-api/src/lib/notify.ts:8-11`).
- ~~S2~~ — retired (D48): replaced by AC-4.7's refusal of `planned` → `active`.
- S3 A `sales` holder scoped to one entity sees the whole queue (it has an entity filter,
  not a scope filter: `projects-api/src/queue/queue.routes.ts:26-30,72-79`) but can create
  only for the entity they manage.
- ~~S4~~ — retired: replaced by A37 and D49 (AC-3.6, AC-3.8–3.10).
- S5 The terms of a hand-made project can be removed as a whole as well as edited: they are
  optional as a whole (A38), and what remains must still meet AC-5.3.
- S6 A referent archived in the CRM after it was chosen stays shown on the PO until someone
  changes it: archiving hides a contact from lists, erasure deletes it
  (`specs/017-crm/spec.md:55-57`).

## Open questions

- O1 A maintenance or SLA deal split off a mixed offer (D6) usually has no technical
  estimate: should the CRM's estimate gate (specs/018 AC-3.4) exempt such deals? A CRM
  change, outside this spec — owner: product owner. **Accepted as risk at approval
  (2026-11-03)**: until it is answered, such a deal needs a ready estimate or the admin
  override to reach `won`, and so to enter the queue.
- ~~O3 How is a deal attached to the wrong project undone?~~ Moot since 2026-11-04 (D39):
  nothing is attached.
- ~~Q1 Is an admin assignable as a PO's ops-manager?~~ **Closed 2026-11-05 by D44, D45:**
  yes — the candidates are the role's holders for the entity and the admins; the prefill
  counts role holders only (AC-4.1, AC-4.2).
- ~~Q2 Should `planned` → `active` be refused while a project awaits its project manager?~~
  **Closed 2026-11-05 by D48:** yes, refused with a message; everything else as specs/021
  (AC-4.7).
- ~~Q3 If the assigned ops-manager is away or leaves, who picks the project manager?~~
  **Closed 2026-11-05 by D46, D47:** only the person assigned to the PO at creation picks it;
  an admin in their place; no reassigning a PO in v1 (AC-4.8).
- ~~Q4 What does a project-module user without CRM access see of a referent?~~ **Closed
  2026-11-05 by D49:** name, job title, email and phone, read live from the CRM and never
  copied; a security check comes before implementation (AC-3.8–3.10).
- ~~Q5 In which language is the ops-manager's notification?~~ **Closed 2026-11-05 by D51:**
  English only, a declared exception to specs/021 AC-4.7 (AC-4.3).
