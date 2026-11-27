# @operai/projects-ui

## 0.9.0

### Minor Changes

- 3e5d1b5: The Team card of a project has a People section (the listed team, now "Edit people") and a Teams section: each attached team by its current name with its members, badged Deactivated or No access to Projects, and an Archived mark. "Edit teams" attaches teams found by a server-side search (at most 10) and removes them in one save. When teams or their members could not be loaded the card says so, or, for a person over their own limit, says "Too many requests" with the wait; Retry reloads in place.

### Patch Changes

- ad7a071: The task side panel is ordered: the progress buttons first, then the facts as a labelled list, the description, and the other actions with Delete last.
- 3e5d1b5: The teams copy in Italian uses one register, the informal "tu" the rest of Projects uses.

## 0.8.0

### Minor Changes

- f11e72e: A project's tasks and My tasks are one board (Open, In progress, Done): a compact card opens a side panel with the task and its actions, a card dragged to another lane starts, stops, completes or reopens it, and Done shows the last 30 days with a way to the older ones.

### Patch Changes

- f9a7d0a: The Projects tab stays selected on a project's page.

## 0.7.0

### Minor Changes

- a17c260: A won public tender is taken from the to-start queue as a project without a purchase order: the funding body is its company, its project manager is chosen at the take, and the project shows it comes from a tender.

## 0.6.0

### Minor Changes

- ffa3235: Record hours from the project (specs/20261116-record-hours-in-place). A project's manager and team see a **Record hours** button in the project page's header, and the assignee or a participant of a task sees one on the task's row, in the project's Tasks card and in My tasks, done tasks included. It opens the Hours entry dialog with the project (or, for a task of a CRM deal, the deal) and the task already chosen and today as the day, and says what it recorded with a link to My hours. Hours-api still decides each save and the dialog says why in plain words when it refuses. When the Hours screens cannot be loaded the page works as before and shows a My hours link instead. Copy is English and Italian.

## 0.5.0

### Minor Changes

- 1071511: A meeting can be started from a project or a project task: Projects is a meeting host (a project's Meetings card, "Start a meeting" on a task, linked to the task's project with its title), and the creator may let the project's team read it.
- 57ab20d: A task can now be marked "In progress", in the CRM and in Projects. Whoever can mark a task done can start it and stop it again; a task waiting on other tasks cannot be started until they are done. Done is still one click away from Open, and reopening a done task makes it open. The task lists' "Open" view includes tasks in progress (with an "In progress" badge), and a new "In progress" view shows only those. The task shows who started it and when.

## 0.4.1

### Patch Changes

- 241b97c: The author of a CRM activity or task now chooses who sees its details: everyone (the default, and every existing activity), the sales team (people who manage deals: today sales and admin), or only the author and, for a task, its assignee. Everyone else still sees the activity, its subject, people, dates and state, but not its text, description, pictures or attachments; it reads "Details are restricted". No role overrides the choice, administrators included. The subject is always visible, and the form says so. Projects' My tasks shows the same restricted line on a CRM task.

## 0.4.0

### Minor Changes

- d9d06a1: Tasks about a deal link straight to the deal: the deal's title in the CRM's Tasks and activity timelines, and a "Deal:" line on a pre-sales task in My tasks.

## 0.3.1

### Patch Changes

- bc1bf94: Patch the `zod` and `undici` advisories in the frontends' lockfiles: `zod` (reached through better-auth and eslint-plugin-react-hooks) moves to 4.6.7 and `undici` (reached through jsdom, tests only) to 7.30.1. Lockfile-only, both within the parents' existing ranges; no package.json change.
- 0927064: Align `vitest` to 4 (`^4.1.12`, as the other frontends), closing the two critical `tinypool` and the `vitest` / `@vitest/mocker` advisories that vitest 3 pulled in. Tests and tooling only; the app bundle is unchanged. `tsconfig.app.json` now declares the `node` types explicitly (vitest 3 used to bring them in transitively).

## 0.3.0

### Minor Changes

- 0d8b9df: Projects hand-off (specs/20261103-projects-handoff, ADR 20261104-projects-handoff-live-reads-between-crm-and-projects-over-service-credentials to 0094): a won deal reaches OPS "in series".
  Sales (and admins) see a to-start queue of the CRM's won deals that no project has taken, read live
  (a reopened deal leaves it, a re-won one returns), and turn one into a new project with its purchase
  order (PO): type, dates and terms, an optional referent among the company's CRM contacts, and the
  ops-manager the PO is assigned to. The project starts without a project manager; the ops-manager is
  notified and picks one (an admin may in their place), and `planned` to `active` is refused until then.
  A project has 0..1 terms and 0..1 purchase order: a PO is born only from a won deal, and a hand-made
  project may be of any type and carry terms but never a PO. A fixed-price PO from
  a deal with an estimate copies the estimate's man-days once, and they cannot be edited. The PO shows its
  deal, a "no longer won" notice, the estimate link and the referent's name, job title, email and phone,
  read live from the CRM and never stored; the CRM deal page shows its project and the PO's Bexio order id,
  read-only.
  - **auth:** the `projects` catalog gains `purchase-order:bexio` (held by `accounting`: the PO's Bexio
    order id), `purchase-order:receive` and `handoff:take`; new `ops-manager` system role; `sales` gains
    `handoff:take`. New `GET /authz/users/holders`, gated on `handoff:take`, lists the holders of
    `purchase-order:receive` for an entity as `{ id, name, unconditioned }` (ADR 20261105-handoff-take-and-purchase-order-receive-capabilities-auth-holders-listing-amends-0047 amends ADR 20261006-user-directory-endpoint-capability-gated). New
    service scopes `crm.deals.read`, `crm.contacts.read`, `estimai.estimates.read` and
    `projects.purchase-orders.read`.
  - **estimai-api:** its first `/system/*` route, `GET /system/estimates/{id}/summary`, returns only
    `{ id, name, manDays }` to a service credential with `estimai.estimates.read`; new optional
    `SERVICE_AUDIENCE`.
  - **crm-api:** new `GET /system/deals` (`crm.deals.read`, no amounts) and `GET /system/contacts`
    (`crm.contacts.read`, minimal shape per mode) for projects-api; the deal read gains `delivery` and
    `deliveryKnown`, read from projects-api's `GET /system/purchase-orders`; `SERVICE_CLIENT_ID` /
    `SERVICE_CLIENT_SECRET` are now required with either `NOTIFY_INTERNAL_URL` or the new optional
    `PROJECTS_INTERNAL_URL`.
  - **crm-ui:** a read-only "Delivery" card on the deal page.
  - **notify-api:** `system:projects-api` may raise `projects` notifications.
  - **notify-ui:** the notification centre labels the `projects` origin "Projects" / "Progetti".
  - **projects-api:** one new migration on top of the Projects module's own; the take (`POST /queue/{dealId}/project`) behind
    `handoff:take`, with ops-manager candidates from auth, referent contacts from the CRM and a best-effort
    notification; `GET /queue`, the terms and purchase-order routes, the referent and the project-manager
    pick, hand-made projects with optional terms, and `GET /system/purchase-orders`; `GET /scope` gains
    `take` and `oversees`; new `ESTIMAI_INTERNAL_URL`, `NOTIFY_INTERNAL_URL` and `SERVICE_AUDIENCE`.
  - **projects-ui:** the queue (sales only), "New project" from a deal with the ops-manager and referent
    pickers, the purchase-order and terms cards, the awaiting notice with "Pick project manager", the
    list's "Awaiting project manager" state and filter, and hand-made creation with optional terms.

### Patch Changes

- 0d8b9df: The browser's back and forward buttons show the page of the address in every module,
  within a module and between modules. Each module now builds its router when it mounts,
  so coming back from another module no longer shows a page matched from that module's
  address (a project named "admin", "This page does not exist"). The router also follows
  the address while the shell hides the module behind its pending fallback, so back from
  "To start" or from a company shows the list it was opened from, not the page it left.
- 66ef8fa: The design system `@operai/ui` is compiled once, by the shell, and shared with every remote as a Module Federation singleton: remotes declare it with `import: false` and no longer bundle it (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell). The rich-text entry is still compiled by crm-ui, meetings-ui and projects-ui.

## 0.2.0

### Minor Changes

- 4f8e70f: Add activities-api (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host/0082/0083): one backend-only service for the activities, tasks and
  task blockers of the CRM and of Projects, with no permission catalog of its own, so every access decision is
  asked of the host (`crm-api`, `projects-api`) as the caller and fails closed. `crm-api` moves its activities,
  participants, blockers and meeting host state out (they are copied in once by
  `activities-api/scripts/import-crm-activities.ts`, a later push drops the old tables) and calls
  `activities-api` with the new service scope `activities.write`; `projects-api` becomes a host. `auth`
  registers the scope and the `activities-api` service client; `notify-api` accepts the `projects` origin and
  binds `system:activities-api` to `crm` and `projects`; `notify-ui` tags it. The shell trusts the
  activities-api origin; `crm-ui` reads activities from it; `projects-ui` gains a Tasks card on a project and a
  My tasks page.
- 4f8e70f: Add the Projects module (specs/20261103-projects, ADR 20261103-projects-tool-shape-and-authorization/0080): the delivery work wellD runs. A
  project has a type (T&M, fixed price, maintenance, SaaS, internal), a state, a project manager and
  a team; its contracts record what each client bought as structured delivery terms (deadline and
  max effort, SLA, hour package, T&M positions, licence period), and `accounting` records the Bexio
  order id on each contract. No money anywhere in the module. New services `projects-api` and
  `projects-ui`; the shell mounts the tool at `/projects`.
  - **auth:** registers the `projects` catalog (`projects:access`, entity-scoped `project:manage`,
    `contract:bexio`) and the `project-manager` role; `sales` gains access and entity-scoped manage,
    `accounting` gains access and the Bexio order capability; `project:manage` holders can read the
    user directory; new service scope `crm.companies.read`.
  - **crm-api:** new `GET /system/companies`, readable only with a service credential carrying
    `crm.companies.read` (the first `/system/*` route on the CRM).
- 48de67f: Tasks have a rich description with pictures and attachments (ADR 20261113-task-description-files-in-activities-api-bucket). In the CRM and in Projects a task's text is now formatted (bold, lists, check lists…); pictures can be chosen, pasted or dropped into it, and files (PDF, Office, text, CSV, pictures) attached under it. Files are uploaded when the task is saved, live in activities-api's own EU bucket and are shown to whoever can read the task. A task's existing plain text becomes its description.

### Patch Changes

- 039ba3f: Lists no longer blank to a loading skeleton when you come back to them or when they reload after a change: they show what was last loaded at once and refresh it in the background (Meetings list, templates and folders; CRM companies, contacts, pipeline and tasks; Projects list and My tasks). Kept in memory only, for the open tab.
- f494bbc: Pin `@tanstack/react-router` to 1.170.17 like every other frontend, so the suite resolves one router for the Module Federation singleton (specs/20261111-push-notifications E-1).
- c4ba4c3: Pages use more of a wide screen: the default tool column grows from 64rem to 80rem and the wide one (the CRM pipeline) fills the width beside the sidebar; single forms stay at 40rem.
