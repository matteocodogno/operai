---
id: 025
slug: projects-handoff
status: approved
rigor: mvp
created: 2026-11-03
approved: 2026-11-03
depends-on: 024
---

# Projects hand-off — a won deal reaches OPS "in series"

Decision ledger: `../024-projects/ledger.md` (shared with specs/024 and specs/026)

> **Origin.** Split out of specs/024 on 2026-11-03 (ledger D33). specs/024 gives projects
> and hand-entered contracts; this spec connects them to the CRM pipeline of specs/017 and
> the estimates of specs/018, so that every won deal becomes a contract on a project.

## Problem

When a deal is won in the CRM, nothing tells the people who deliver it. The work starts
when someone remembers to mention it; the estimate the offer rested on has to be looked up
again; and from the deal there is no way to see which project carries it or which Bexio
order it became. A deal reopened after the fact — a mistake, or a client changing their
mind — leaves the delivery side unaware.

## Domain language

- **to-start queue** — the won deals no project has taken yet (D2).
- A contract's **deal** — the won deal a contract was made from (specs/024 contract,
  D25). A deal feeds at most one contract, hence one project (D4).

## User stories

### US-1 Sales hands over, OPS takes charge
As a project manager, I want every won deal to wait for me in one queue, so that no sold
work is forgotten between sales and delivery.

- AC-1.1 Given a deal is `won` in the CRM and feeds no project, when a project-module user
  opens the to-start queue, then the deal is listed with its title, company, entity, won
  date and estimate link if it has one, and with no amount (D2, D14, A20, A26).
- AC-1.2 Given a deal in the queue, when a holder of manage projects for the deal's entity
  — OPS or BD — chooses "new project", then a project is created with the name prefilled
  from the deal's title (editable), the deal's company and entity, the type they pick among
  the client types, state `planned` and them as project manager, changeable (A5, D15,
  specs/024 AC-1.3) (amended 2026-11-03 after approval: D36, BD may also take a deal).
- AC-1.3 Given AC-1.2 completes, then the new project has one contract made from the deal
  (company, deal, project type), and the deal is no longer in the queue.
- AC-1.4 Given a deal in the queue, when a holder of manage projects for the deal's entity
  attaches it to an existing project, then a contract of that project's type is created
  from the deal and the deal leaves the queue (amended 2026-11-03 after approval: D36).
- AC-1.5 Attaching a deal is refused, with a message saying why, when the target project is
  `internal`, `cancelled` or `closed`, or is a client project of another company (A12, A27).
- AC-1.6 A deal feeds at most one project: a deal that already has a contract is not in the
  queue and cannot be attached again (D4).
- AC-1.7 A deal attached to a project cannot be detached or moved to another project; its
  contract, like any contract, can only be ended (D34, specs/024 AC-2.10).

### US-2 A reopened deal is visible, never destructive
As a project manager, I want to know when a deal behind my work is no longer won, so that
I can act on it without the CRM undoing my project.

- AC-2.1 Given a deal in the queue, when it is reopened in the CRM, then it leaves the queue
  (D17).
- AC-2.2 Given a deal that left the queue by being reopened, when it is won again, then it
  is back in the queue (D17).
- AC-2.3 Given a deal that feeds a project, when it is reopened in the CRM, then its project
  and contract are unchanged and both show the notice "the deal is no longer won" (D17).
- AC-2.4 Given the notice of AC-2.3, when the deal is won again, then the notice is gone
  (D17).

### US-3 The contract carries what the deal knows
As a project manager, I want a contract made from a deal to start from what sales already
recorded, so that I do not retype it.

- AC-3.1 Given a `fixed_price` contract is created from a deal with an estimate, then its
  estimated man-days are copied from the estimate and cannot be edited; a later change to
  the estimate does not change them (D8, A6).
- AC-3.2 Given a contract made from a deal with an estimate, when its page is opened, then
  it shows a link that opens the estimate in EstimAI; a person without access to it in
  EstimAI sees it as unavailable (D29, A16).
- AC-3.3 A contract made from a deal shows the deal's title as a link to the CRM, and the
  origin "from deal" instead of "entered by hand" (specs/024 AC-2.1).
- AC-3.4 Given a deal that feeds a project, when a CRM user opens the deal page, then it
  shows the project's name and the contract's Bexio order id (empty if none), read-only (D3).

## Non-goals

- **Automatic project creation** when a deal is won: a person takes every deal (D2).
- **One deal feeding several projects**, or one offer split across projects: a mixed offer
  is two deals in the CRM (D4, D6).
- **Mapping offer templates to project types** (A5).
- **Blocking a CRM reopen** because a project exists, or suspending the project
  automatically (D17).
- Changing the CRM's estimate gate for maintenance deals (O1).
- **Undoing an attachment**: detaching a deal, moving a contract, deleting a contract (D34).
- Notifying OPS when a deal enters the queue (A19).

## Assumptions (from the ledger — strike any that is wrong)

- A5 The project manager picks the type; no offer template carries one.
- A6 Estimated man-days are a snapshot taken when the contract is created.
- A12 A client project takes contracts only for its own company; `saas` for any company;
  `internal` for none.
- A16 The estimate link sits on the contract; the project page lists its contracts.
- A19 No notifications in v1.
- A20 The queue is readable by every access holder; only a holder of manage projects for
  the deal's entity (project manager or `sales`, D36) takes a deal from it.
- A26 Deals already `won` when the module ships appear in the queue too.
- A27 A `closed` project, like a `cancelled` one, takes no new contract until reopened.

## Open questions

- O1 A maintenance or SLA deal split off a mixed offer (D6) usually has no technical
  estimate: should the CRM's estimate gate (specs/018 AC-3.4) exempt such deals? A CRM
  change, outside this spec — owner: product owner. **Accepted as risk at approval
  (2026-11-03)**: until it is answered, such a deal needs a ready estimate or the admin
  override to reach `won`, and so to enter the queue.
- ~~O3 How is a deal attached to the wrong project undone?~~ Closed 2026-11-03 (D34): it
  is not undone; the contract can only be ended (AC-1.7).
