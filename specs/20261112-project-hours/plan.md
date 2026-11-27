---
spec: 20261112
status: approved
---

# Plan: Project hours — time worked against what was sold

Spec: `spec.md` (approved 2026-11-26, re-opened for D78–D79). Decision ledger: `../20261112-time-tracking/ledger.md`.
Builds on specs/20261112-time-tracking (hours-api, hours-ui), specs/20261103-projects-handoff (terms, purchase order),
specs/20261104-meetings A18 (Projects as a meeting host) and specs/20261116-record-hours-in-place (the `hours.recordHours`
seam this plan mirrors). Amended 2026-11-26 after design (ledger D80): one "Hours" card per page instead of a Consumption card and
an Hours card, the breakdown behind a closed disclosure inside the widget (components table, test rows; no route, API, deploy
or ADR change). Amended again 2026-11-26 while deriving the tasks (ledger D81–D84, the design's G1–G5): "Over by" instead of a
negative figure, `currentPeriod.ended` and an "Expired" badge, the SLA-only case in AC-1.7, and D-P6 (figures re-read after a
Record hours save, through a content-free browser event — an amendment of ADR 20261116-record-hours-widget-…). Written against
`main` at `225f0275`. Amended a third time 2026-11-26 (owner's decision, after the tasks): specs/20261112-meeting-hours
(PR #12, branch `feat/meeting-hours`, head `75c712da`) is **not** on main yet and touches the same hours-api and hours-ui
files, and the local auth's `SERVICE_CLIENTS` already carries its scope `meeting-hours-notices.send`, which an auth without
#12 refuses at start, so the suite cannot start on a main-based branch. This branch is therefore **stacked on #12**: rebased
onto #12's branch now (task T5) instead of onto `main` after #12 merges, its pull request stacked on #12's and moved to `main`
once #12 merges (Risk R1, § Deploy order). No route, API, decision, test or ADR change; file:line references into files #12
also changes (hours-api `src/entries/filters.ts`, both Prisma schemas) are to `225f0275` and have moved.
Amended a fourth time 2026-11-27 (drift reported by T3, `decisions.md` § T2, T3): § Components said `currentPeriod` is
wired in `toProjectView`, while § API contracts puts it on every response carrying `TermsViewSchema`, the
`POST`/`PATCH /projects/{id}/terms` answers included. T3 followed the contract and derives it in the terms view
(`termsView` / `toTermsView`, `projects-api/src/terms/terms.ts`), which `toProjectView` and the terms routes both call;
the projects-api row (b) and the AC-1.1 test row now say so, with file:line references to T3's `be99186a`. No route,
API, decision or ADR change: the contract is unchanged and the tests the row names exist since T3.
Amended a fifth time 2026-11-27 (the owner's decisions of 2026-11-27, ledger D85, spec A52, on a limitation T16 reported,
`decisions.md` § T16, widened the same day to three further cases of the same cause): Risk R8 added — a package's period
is worked out for the Europe/Zurich day the project page read the project on, so a page left open across midnight keeps,
until it reads the project again (a reload, or a write of its own), a capacity package without an expiry counted up to
that day (the hours dated on the new day out of the consumption block), a yearly package on the period that has ended, a
package "not started" once its start date has come, and an expired capacity package without its "Expired" mark; accepted
and documented, with re-reading the project on a Record hours save named as the way out for all four. The "asks the
summary once" bullet (under § Refreshing after Record hours) and the AC-1.1, AC-1.9 and AC-2.8 test rows point at it. No
route, API, test or ADR change, and no D-P decision changes: the window stays the server's `currentPeriod` (D-P3).
Amended a sixth time 2026-11-27 (wording reported by T19, `decisions.md` § T19): § The hours views called Counts for
project "a 10th column … placed after Counts for deal", which reads as the last column; it is the 7th of the sheet's
10, right after Counts for deal, as the code (`hours-ui/src/lib/hoursWorkbook.ts`) and T11's done-when have it. That
bullet, the hours-ui row (d) and the AC-4.6 test row now say so. No route, API, test, decision or ADR change: the
header-order test the row names exists since T11 (`hours-ui/src/lib/hoursWorkbook.test.ts`).

## Architecture

### Shape in one paragraph

hours-api gains **one read of a record's hours** — `GET /time-entries/summary?projectId=|dealId=` — that returns the hours
of *every* person on a project or a deal (the hours on a project include its linked meetings') to whoever can read that
record, asked of its owner as the caller; the per-person figure is included only for the project's manager, the deal's
owner (a fact the owner now states in its resolve answer) or a holder of `time-entry:read-all`. hours-ui renders that
answer in a new federated read panel, `./HostHours`, which projects-ui's project page and crm-ui's deal page embed through
the shell's `HostExtension` seam (`hours.hostHours`), exactly as they embed `meetings.hostMeetings`. **Consumption** is a
projects-ui card: projects-api derives the hour package's current period on read (it owns the terms), projects-ui asks the
summary for that window, and sets the two figures side by side. Separately, everywhere hours-api answers about a project —
the `projectId` filter, by-project totals, an entry's labels — it now counts the meetings linked to the project, read
live from meetings-api's content-free `GET /system/meetings/hosts`, which learns a `projectId` filter (D78; the deal
mechanism of ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route § 5, mirrored).

### Components

| Service / app | Change | ACs |
|---|---|---|
| **meetings-api** | `GET /system/meetings/hosts` takes `projectId=` (exactly one of `ids`, `dealId`, `projectId`); host fixed to `{app:"projects", entityType:"project"}`; same scope `meetings.hosts.read`, same `sub` allowlist, same answer shape. `src/system/hosts.routes.ts` | AC-4.1–4.5, 4.8–4.10 |
| **projects-api** | (a) `POST /activity-host/v1/resolve` open items gain `projectManagerId: string \| null` (`null` while the project awaits one), `src/activity-host/activity-host.routes.ts`. (b) the terms view's `hourPackage` gains `currentPeriod: { from, to, ended } \| null` (`ended` only `true` for a capacity package past its expiry, D83), derived on read by a pure `packagePeriod(hourPackage, today)` (`src/terms/packagePeriod.ts`, new) with `today` the Europe/Zurich date (`src/lib/businessDay.ts`, new, same rule as hours-api `src/entries/today.ts`), wired in the terms view itself, `termsView` and `toTermsView` (`src/terms/terms.ts:175,216`, through `hourPackageView` at `:166-169`), so every response carrying `TermsViewSchema` has it: the project view, whose `toProjectView` calls `toTermsView` (`src/projects/projects.routes.ts:120`), and the `POST`/`PATCH /projects/{id}/terms` answers (`src/terms/terms.routes.ts:162,210`), neither route file changed; schema `HourPackageView` (`src/projects/projects.schemas.ts:56-62`) | AC-1.1–1.3, 1.9, 2.3, 2.7 |
| **crm-api** | `POST /activity-host/v1/resolve` deal items gain `ownerUserId: string`, `src/activity-host/resolve.routes.ts:86-97` | AC-2.4 |
| **hours-api** | (a) new `GET /time-entries/summary` (`src/summary/`, new: route, query, `summaryOf`); (b) `projectCondition` beside `dealCondition` in `src/entries/filters.ts` — the `projectId` filter of the list and totals = entries on the project OR on meetings linked to it now, cursor key + 409 like the deal's; (c) `byProject` in `src/totals/totals.ts` places a meeting entry under its linked project (new tail bucket `project-unknown`); (d) `src/labels/resolve.ts` resolves a meeting's project from the same `readMeetingHosts` read and the viewer's projects resolve, `TimeEntryView` meeting `on` gains `project: MeetingProject` (`src/entries/view.ts`); (e) clients: `readMeetingsLinkedToProject` in `src/clients/meetings.ts`, `projectManagerId` / `ownerUserId` parsed in `src/clients/projects.ts` / `crm.ts`; (f) OpenAPI + `src/matrix.test.ts` inventory | AC-1.x (window), 2.1–2.7, 4.1–4.10 |
| **shell** | `hours.hostHours` in `ExtensionProps` and `LOADERS` (`() => import('hours/HostHours')`), `shell/src/lib/extensions.tsx:36-69`; props `{ on: 'project' \| 'deal', targetId: string }` | AC-2.x, 2.6 |
| **hours-ui** | (a) exposes `./HostHours` (`src/HostHours.tsx` + `src/HostHoursModel.ts`, new): the total recorded and the "includes linked meetings" line, always visible; a **"Show breakdown"** disclosure, closed on every mount, whose state is the widget's own (not in the URL), opening a region that stays in the DOM with `hidden` while closed: per work type, per person when the answer carries it (D80); one summary call on mount, none on open; its own loading/error states; imports `hoursApi`, strings and `@operai/ui` only — never `exceljs`, the pages or the router (the `./RecordHours` rule). (b) types: meeting `on.project`, `TotalsGroup` kind `project-unknown`, `UnavailableSource` `meeting-projects`, `SummaryAnswer` (`src/lib/hoursApi.types.ts`). (c) `getSummary` in `src/lib/hoursApi.ts`. (d) export: a **Counts for project** column right after Counts for deal, the 7th of the sheet's 10 (`src/lib/hoursWorkbook.ts`), screen line `countsForProjectLine` (`src/lib/names.ts`). (e) project-filter refusal: `DealFilterUnavailable` generalised to the deal or the project filter (`src/components/DealFilterUnavailable.tsx`, `pages/MyHoursPage.tsx`, `pages/EveryoneHoursPage.tsx`), 409 `project_meetings_changed` handled like the deal's. (f) `TotalsCardRows.ts` word for `project-unknown`. (g) en/it strings. (h) `./RecordHours` broadcasts the content-free `operai:time-entry-recorded` event after a successful save, and `HostHours` re-reads its summary when the event names its own target (D-P6). (i) a missing `on.project` (an hours-api older than step 4) reads as `{ state: "none" }` in the types, `countsForProjectLine`, the export cell and `hasHiddenName` (design G4) | AC-2.1–2.8, 4.4–4.11, 3.2 |
| **projects-ui** | (a) `HoursSection` (new) owns **one "Hours" card** right after Details on `ProjectDetailPage.tsx` (D80): the consumption block first, then the widget's slot (`useExtensionSeam`, `HostExtension name="hours.hostHours"`, the slot's own "Hours unavailable" fallback, `ExtensionContain` keyed by project id); the card frame and title always show, only the slot is swapped on a failure. (b) `ConsumptionBlock` (new, a block inside that card, not a card) shown when the terms sold something comparable: calls the summary itself (with the package window when there is one) and renders `consumptionOf(terms, summary)` from `src/lib/consumption.ts` (new, pure). (c) `getHoursApiBaseUrl` declared in `src/federation/remotes.d.ts`, `src/lib/hoursApi.ts` (new, one function). (d) `Terms` type gains `currentPeriod` with `ended`; the block shows "Over by" the absolute figure once the package is exceeded (D81) and an "Expired" `StatusBadge` (`voided`) when `ended` (D83). (e) `ConsumptionBlock` re-reads on `operai:time-entry-recorded` naming its project (D-P6). (f) en/it strings | AC-1.1–1.9, 2.6, 2.8, 3.2 |
| **crm-ui** | `HoursSection`: one "Hours" card after Meetings on `DealDetailPage.tsx` holding the widget's slot only (D80); en/it strings | AC-2.2, 2.4–2.6, 3.2 |

No database migration anywhere: every figure is derived on read from rows that exist (ADR
20260714-invitation-lifecycle-derived-expiry-state posture). No new environment variable: hours-api already has
`PROJECTS_API_URL`, `CRM_API_URL`, `MEETINGS_API_URL` and its service credential; projects-ui reads hours-api's origin from
the shell (`getHoursApiBaseUrl`, `VITE_HOURS_API_URL` is the shell's), which `apiFetch` already trusts
(`shell/src/lib/session.ts:56,374`). env-doctor is unchanged.

### Who may see what — the summary's rules

1. **Reading the record.** hours-api asks the owner as the caller, with the forwarded JWT, on every request (ADR
   20261112-time-bookability-asked-of-owners-meeting-hosts-system-route, never cached): projects-api's activity-host
   resolve for a project, crm-api's for a deal. `reader:false` or `state:"missing"` → `404 not_found`, identical for both
   (existence and access give one answer). The owner unreachable or its answer malformed → `503 host_unavailable`. A
   reader sees `totalMinutes`, `windowMinutes` and `byWorkType` (AC-1.8, AC-2.1, AC-2.2).
2. **Per person.** `byPerson` is present only when the caller is the project's manager (`projectManagerId === sub`), the
   deal's owner (`ownerUserId === sub`), or holds `time-entry:read-all`. The owner's fact is checked first and costs no
   extra call; only a caller who is neither asks auth (`holdsReadAll`, `src/oversight/oversight.ts:62-85`: live, refusals
   cached 30 s, grants never). Otherwise `byPerson: null` (AC-2.3–2.5). A project awaiting its manager has
   `projectManagerId: null`, so only holders see it; the purchase order's ops-manager is not asked about (AC-2.7, D79).
   auth unreachable for a non-manager, non-owner caller → `byPerson: null` and `"authz"` in `unavailable`: the figure is
   withheld, never shown on a guess (fail closed).
3. **Linked meetings.** The hours on a project are its entries plus the entries on meetings meetings-api says are linked
   to it **now** (`projectId=` read with hours-api's own service credential, scope `meetings.hosts.read`; content-free,
   `{id, host}` only). They count whoever recorded them and whether or not that person is on the team (AC-4.1); a relink
   moves them at the next read because nothing is stored (AC-4.2). meetings-api unreachable → the whole summary is `503
   host_unavailable`: no figure lower than the truth (AC-4.9, D45). The same holds for a deal's summary, which reuses the
   existing `dealCondition`.
4. **What the summary never carries:** entries, notes, activity subjects, meeting ids or titles, amounts, prices or rates
   (AC-1.8). Per-work-type and per-person groups only.

### Consumption — where each figure comes from

| Terms | Sold (from projects-api) | Used (from the summary) | Shown |
|---|---|---|---|
| hour package, yearly or capacity | `hourPackage.hours`, `hourPackage.currentPeriod` | `windowMinutes` for `currentPeriod` | package hours, hours used in the period, hours left — or "Over by" the absolute figure once exceeded (D81) — the period's dates, and "Expired" when `ended` (D83) (AC-1.1–1.3, 1.9) |
| hour package, `currentPeriod: null` (before its start) | `hourPackage.hours`, start date | — (no window asked) | the package and "starts on …", no consumption (A51) |
| `fixed_price` | `estimatedManDays` (may be null), `maxEffortManDays` | `totalMinutes` (all time) | used man-days against estimated (when known) and max effort (AC-1.4) |
| `t_and_m` | Σ `positions[].plannedManDays` | `totalMinutes` | used man-days against the planned total (AC-1.5) |
| no terms, or nothing comparable (an SLA and no hour package) | — | — | no consumption block; the HostHours widget shows the total (AC-1.7, D82) |

- **`packagePeriod(hourPackage, today)`** (projects-api, pure): yearly — period *k* is `[start + 12k months, start + 12(k+1)
  months − 1 day]`, *k* the one containing `today`; an anniversary on 29 February falls on 28 February in a common year;
  `null` before `start`. Capacity — `[start, expiry]`, or `[start, today]` without an expiry; after the expiry it stays
  `[start, expiry]` (the final figure) with `ended: true`; `null` before `start`. A yearly period and a capacity package
  without expiry or not yet expired have `ended: false` (D83, AC-1.9). Unused hours of a yearly period are not carried
  (AC-1.2, D28): each period is its own window.

### Refreshing after Record hours (D84, AC-2.8 — D-P6)

- `./RecordHours` (hours-ui), after a `POST /time-entries` that succeeded, dispatches on `window` one
  `CustomEvent('operai:time-entry-recorded', { detail: { on: 'project' | 'deal' | 'none', targetId } })`: the target it just
  recorded on, nothing else — no minutes, no day, no person, no entry id. A save on a project task row names the task's
  project.
- `HostHours` (hours-ui) and `ConsumptionBlock` (projects-ui) listen while mounted and, when `detail` names their own
  target, re-read their summary exactly as on mount (states unchanged: a failed re-read shows their error state). Several
  events in a burst coalesce into one re-read (the read in flight is restarted, never duplicated).
- The event's name and `detail` type live in one module, `src/lib/timeEntryRecordedEvent.ts`, a byte-identical copy in
  hours-ui and projects-ui, registered as a group in `scripts/check-shared-copies.ts` (`mise run shared:check`); crm-ui needs
  none (its card is the widget alone).
- Nothing reaches the host through the seam: no callback, no return value, no prop. A host that does not listen stays
  as it is; an older `./RecordHours` that does not broadcast leaves the figures as they were until a reload.
- This amends ADR 20261116-record-hours-widget-through-the-host-extension-seam ("nothing comes back"): a widget may
  broadcast a content-free fact about the target it wrote to; it still returns nothing and decides no permission.
- **Man-days** (projects-ui `consumption.ts`, pure): `tenths = roundHalfUp(minutes × 10 / 480)` in integers, shown with
  `formatNumber` at one decimal (AC-1.6, D27, A34); planned and estimated man-days are already one-decimal numbers from
  projects-api. Hours are shown with `formatDuration` (minutes → "2 h 30"), dates with `formatDate` (AC-3.2).
- The consumption block asks the summary **once**: with `windowFrom`/`windowTo` when the package has a current period,
  without otherwise. A failed summary shows the block's "Consumption is unavailable" state while the widget below it and the
  rest of the page stay (AC-2.6, AC-4.9). The window is `currentPeriod` as read with the page, and a re-read asks the same
  one: the period, its end, whether the package has started and whether it has ended are those of the Europe/Zurich day of
  that read until the page reads the project again (Risk R8).
- This is arithmetic over two complete answers (a sold figure and a server total), not a sum over pages: ADR
  20261116-week-view-sums-a-complete-read-in-the-browser is not engaged.

### The hours views (specs/20261112-time-tracking surfaces, widened by US-4)

- **Filter** `projectId` = `OR[{projectId}, {meetingId: {in: linked}}]`, as `dealCondition` (`filters.ts:104-113`); the
  cursor carries a `projectMeetingsKey` (11-char sha256 of the sorted ids, as `dealMeetingsKey`), a changed set is `409
  project_meetings_changed`; meetings-api unreachable is `503 host_unavailable` and nothing partial (AC-4.4, AC-4.8).
  hours-ui keeps pages already shown when a later page fails (D48), as for the deal.
- **Totals `groupBy=project`**: a meeting entry linked to a project the viewer can read → keyed under that project; to a
  project the viewer cannot read → `hidden` (or `unavailable` when projects-api cannot answer); hosts unreadable →
  `project-unknown`; not linked to a project → `none` (AC-4.5, AC-4.10). Tail order: hidden, unavailable,
  project-unknown, none.
- **Labels** (`TimeEntryView`): a meeting's `on.project` mirrors `on.deal` (`MeetingDealSchema`,
  `hours-api/src/entries/view.ts:45-50`): `{state:"linked", visibility:"visible", id, label, href}` only when the viewer
  can read that project; `{state:"linked", visibility:"hidden"|"unavailable"}` with no id, label or href otherwise;
  `{state:"none"}`; `{state:"unknown"}` (ADR 20261112-time-bookability § 6, D44 — the AC-4.10 treatment of the meeting's
  deal) (AC-4.7). A meeting has one host, so at most one of `on.deal` and `on.project` is `linked`.
- **Export**: one column added, **Counts for project** (`Conta per il progetto`), right after Counts for deal, so the
  sheet has ten columns and the new one is the **7th**, not the last: Day, Person, Hours, On, Name, Counts for deal,
  **Counts for project**, Category or work type, Activity, Note (the last three move one place right). A project entry
  gives its project, a meeting entry the project it counts for (or the hidden / unknown word), else empty, so the file
  summed by project matches the by-project totals (AC-4.6).
- **Table view**: unchanged — `rowOf` keys a row by the entry's own target (`hours-ui/src/lib/tableGrid.ts:54-64`), so a
  meeting entry stays on the meeting's row (AC-4.11); a test pins it for a project-linked meeting.

### Deploy order

**Before step 1: specs/20261112-meeting-hours (PR #12) has shipped, by its own § Deploy order** (amendment 2026-11-26). This
branch is stacked on #12 (Risk R1) and reaches `main` only after #12 has merged, so #12's preconditions hold first — above all
its step 0, `HOURS_API_URL` on meetings-api, without which any meetings-api carrying #12's code, this branch's included, exits
at start. Nothing below waits for #12's notice channel to be switched on (its scope in production `SERVICE_CLIENTS`).

Every change is additive and each step tolerates the one before it not having shipped:

1. **meetings-api, projects-api, crm-api** (new filter, new fields; consumers parse with `z.object`, which drops unknown
   keys — verified `hours-api/src/clients/projects.ts:34-45`, `activities-api/src/hosts/client.ts:55-80`).
2. **hours-ui** (accepts `project-unknown`, `meeting-projects`, `on.project` — and reads a missing `on.project` as
   `{ state: "none" }`, since hours-api sends it only from step 4 (design G4); exposes `./HostHours`, which shows its
   error state until step 4).
3. **shell** (registers `hours.hostHours`; an unknown name or a failed import renders the host's fallback either way).
4. **hours-api** (summary; project filter and by-project placement). Deployed before step 1, every project filter would be
   a 503 (meetings-api answers 422 to `projectId`): fail closed but a broken view, so step 1 first.
5. **projects-ui, crm-ui** (embed the panel; consumption card).

### Decisions this plan makes

Recorded as ADRs (see § ADR candidates): D-P1/D-P2 in `docs/adr/20261126-a-record-hours-summary-…`, D-P3/D-P4 in
`docs/adr/20261126-a-figure-set-against-another-owners-figure-…`, D-P5 in the 2026-11-26 amendment of
`docs/adr/20261112-time-bookability-asked-of-owners-meeting-hosts-system-route.md`.

- **D-P1 A record's hours are one hours-api read, authorised by the record's owner as the caller.** Chosen over:
  (a) projects-api / crm-api composing the figure with a service credential to hours-api — a user-facing read served
  with a service token, the "borrowed authority" shape of ADR 20261112-time-bookability; (b) widening `whose=all` to
  readers of a record — mixes the oversight path (ADR 20261112-hours-api-time-entries-own-service-hours-catalog) with an
  ordinary read and returns entries, more than the spec shows; (c) per-person computed and hidden by the host page — the
  data would reach a browser that may not see it.
- **D-P2 The project manager and the deal owner are facts the owner adds to its existing resolve answer**
  (`projectManagerId`, `ownerUserId`). Chosen over: a second call per summary to `GET /projects/{id}` / `GET /deals/{id}`
  as the caller (heavier: projects-api's GET reads CRM company names; crm-api's GET omits money but carries the whole
  deal); a host-computed boolean (`may.seePeople`) — the per-person rule is time tracking's (D22), the owner only states
  who holds the role, as it already states `assignees` and `involved`.
- **D-P3 Consumption is composed by projects-ui** from projects-api's derived `currentPeriod` and the summary's window
  total. Chosen over: hours-api reading terms from projects-api (a second service learns the terms model, a new
  cross-service read); projects-api calling hours-api (no user path between them; the alerts of
  specs/20261112-project-alerts, which run without a user, will need their own service path and will reuse
  `packagePeriod`, which lives in projects-api for that reason); the widget receiving terms as props (hours-ui would learn
  the terms model through a string seam).
- **D-P4 The breakdown is hours-ui's read panel `./HostHours` behind `hours.hostHours`**, the ADR
  20261104-host-extension-federated-panel-through-the-shell shape (`meetings.hostMeetings` is the read precedent,
  `hours.recordHours` the write one). Chosen over: a shared `@operai/ui` component rendered by each host from its own
  summary call — two hosts would each own the hours copy (merged-group words, "without a work type"), the error mapping
  and the per-person rendering.
- **D-P5 Linked meetings of a project are read from meetings-api's system hosts route with a new `projectId` filter**,
  the same content-free, service-credential read as the deal's. Chosen over: storing the project on the entry (breaks
  AC-4.2's relink, the ADR's option C), and a per-meeting `ids=` scan of every meeting entry (no index from project to
  meetings on hours-api's side).
- **D-P6 A save made with Record hours reaches the figures on the same page as a content-free browser event**
  (`operai:time-entry-recorded`, `{ on, targetId }`, its type a byte-identical shared copy in hours-ui and projects-ui;
  § Refreshing after Record hours), D84. Chosen over: a callback prop on `hours.recordHours` (the seam's props are plain
  strings and the host would hold the widget's result, the ADR 20261116 boundary); a publish/subscribe API in
  `shell/session` (a shell change and a shell-first deploy for one event); polling the summary (load for nothing,
  late anyway); a host-side reload after the widget closes (the host cannot know a save happened).

## Data model

No change in any database. Reads added:

- **hours-api**: the summary groups `time_entry` by `workTypeId` and by `userId` under `projectCondition` /
  `dealCondition`, optionally `day BETWEEN windowFrom AND windowTo`. Existing indexes `[projectId, day]`, `[dealId, day]`,
  `[meetingId]` serve it (`hours-api/prisma/schema.prisma:44-80`).
- **meetings-api**: `WHERE hostApp='projects' AND hostEntityType='project' AND hostEntityId=$1` on the existing
  `@@index([hostApp, hostEntityType, hostEntityId])` (`meetings-api/prisma/schema.prisma:186`).
- **projects-api**: `currentPeriod` is derived from `project_terms.hourPackage*` columns on read; never stored.

## API contracts

### hours-api — `GET /time-entries/summary` (new, user JWT)

```
GET /time-entries/summary?projectId=<id>[&windowFrom=YYYY-MM-DD&windowTo=YYYY-MM-DD]
GET /time-entries/summary?dealId=<id>
```

Query (`.strict()`): exactly one of `projectId`, `dealId` (`IdSchema`); `windowFrom` and `windowTo` both or neither, only
with `projectId`, `DaySchema`, `windowFrom ≤ windowTo`, no span cap (one record's entries). Anything else → `400
invalid_request`.

```ts
type SummaryAnswer = {
  on: { type: "project" | "deal"; id: string };
  totalMinutes: number;               // all time: entries on the record + on its linked meetings
  windowMinutes: number | null;       // the same, days in [windowFrom, windowTo]; null without a window
  byWorkType: TotalsGroup[];          // keyed by workTypeId { kind:"keyed", key, label, minutes, retired? }
                                      // + { kind:"none", minutes } for entries without a work type (meeting entries included)
                                      // ordered by minutes desc, then label; "none" last
  byPerson: TotalsGroup[] | null;     // keyed by userId { kind:"keyed", key, label: name | null, minutes, status? }
                                      // null when the caller may not see it (rules § 2); ordered by label
  unavailable: ("identities" | "authz")[];  // names unknown (label null) / read-all could not be asked (byPerson null)
};
```

| Status | `code` | When |
|---|---|---|
| 200 | — | the caller reads the record |
| 400 | `invalid_request` | query shape |
| 401 | — | no or bad JWT (existing `jwtMiddleware`) |
| 404 | `not_found` | the record does not exist, or the caller cannot read it (one body for both) |
| 503 | `host_unavailable` | projects-api / crm-api cannot say whether the caller reads it, or meetings-api cannot say which meetings are linked |

`TotalsGroup` is the existing type (`src/totals/groups.ts:23-42`), so hours-ui reuses its rendering. `Cache-Control:
no-store`.

### hours-api — changed

- `GET /time-entries` and `GET /time-entries/totals` with `projectId`: also the entries on meetings linked to the project
  now; `409 project_meetings_changed` when the linked set changed between pages (list only, as `deal_meetings_changed`);
  `503 host_unavailable` when meetings-api cannot answer. `unavailable` may now carry `"meeting-projects"`.
- `TotalsGroup.kind` gains `"project-unknown"` (by-project totals only).
- `TimeEntryView.on` for a meeting: `{ type:"meeting", id, label, href, visibility, deal: MeetingDeal, project:
  MeetingProject }` (`OnSchema`, `.strict()`), where `MeetingProject` is `MeetingDealSchema`'s union with a project's id,
  label and href:

```ts
type MeetingProject =
  | { state: "linked"; visibility: "visible"; id: string; label: string; href: string }
  | { state: "linked"; visibility: "hidden" | "unavailable" }
  | { state: "none" }
  | { state: "unknown" };
```

### meetings-api — `GET /system/meetings/hosts` (changed)

`?projectId=<id>` (1–64 chars, as `dealId`); exactly one of `ids`, `dealId`, `projectId`, else `422` (unchanged rule);
answer `{ items: [{ id, host: { app:"projects", entityType:"project", entityId } }] }` for the meetings linked to that
project now; unpaged, as `dealId`. Auth unchanged (scope `meetings.hosts.read`, `sub` `system:hours-api`, one identical 401).

### projects-api — changed

- `POST /activity-host/v1/resolve` open item: `+ projectManagerId: string | null`.
- `GET /projects/{id}` (and every response carrying `TermsViewSchema`): `hourPackage: { hours, kind, startDate,
  expiryDate, currentPeriod: { from: "YYYY-MM-DD", to: "YYYY-MM-DD", ended: boolean } | null }`.

### Browser event — `operai:time-entry-recorded` (hours-ui → listeners in hours-ui and projects-ui)

```ts
// src/lib/timeEntryRecordedEvent.ts — byte-identical in hours-ui and projects-ui (scripts/check-shared-copies.ts)
export const TIME_ENTRY_RECORDED = 'operai:time-entry-recorded'
export type TimeEntryRecordedDetail = { on: 'project' | 'deal' | 'none'; targetId: string } // targetId '' when on = 'none'
export function isTimeEntryRecordedDetail(value: unknown): value is TimeEntryRecordedDetail
```
A listener ignores an event whose `detail` fails `isTimeEntryRecordedDetail` or names another target.

### crm-api — changed

- `POST /activity-host/v1/resolve` deal open item: `+ ownerUserId: string`.

### shell — `hours.hostHours`

```ts
'hours.hostHours': { on: 'project' | 'deal'; targetId: string }
```
Loader `() => import('hours/HostHours')`, the existing 5 s timeout and error boundary; nothing comes back. The widget
throws at render on an invalid prop set, so the host's fallback shows (the `./RecordHours` rule).

## Test strategy

hours-api tests run against `hours_test` (never the dev database; `bunfig.toml` preload) through `call()` and the fake
owners of `src/test-support/hosts.ts`, which learn `meetings.system-hosts?projectId=`, `projectManagerId` and
`ownerUserId`. projects-api, crm-api and meetings-api route tests in their existing style. UI: Vitest component tests;
e2e in `shell/e2e/project-hours.spec.ts` (new) through the shell.

| AC | Level | Test |
|---|---|---|
| AC-1.1 | unit + integration + component + e2e | projects-api `packagePeriod` vectors; projects-api GET project and the `POST`/`PATCH /projects/{id}/terms` answers carry `currentPeriod`; hours-api summary `windowMinutes` counts only days in the window; projects-ui `consumptionOf` (hours left; once exceeded "over by" the absolute figure, never a negative) and `ConsumptionBlock` inside the Hours card; e2e: a project with a yearly package and entries shows used / left without opening the breakdown; not met by a page open across a yearly anniversary, which keeps the period it was read in (Risk R8, accepted) |
| AC-1.2 | unit + integration | `packagePeriod` yearly: period *k* boundaries, 29 Feb; summary over period 2 excludes period 1's entries |
| AC-1.3 | unit | `packagePeriod` capacity: with expiry, without (to = today), after expiry (stays), before start (`null`) |
| AC-1.9 | unit + component | `packagePeriod` capacity past its expiry → `ended: true`; yearly and unexpired → `false`; `ConsumptionBlock` shows the "Expired" `StatusBadge` only when `ended`; a page open across the expiry shows it only once it reads the project again (Risk R8, accepted) |
| AC-1.4 | unit + component | `consumptionOf` fixed price with and without `estimatedManDays`; `ConsumptionBlock` leaves the estimate out when null |
| AC-1.5 | unit | `consumptionOf` T&M: Σ planned man-days vs used, no per-position figure |
| AC-1.6 | unit | man-day vectors in integer arithmetic: 480 min → 1.0; 30 min → 0.1 (0.0625); 24 min → 0.1 (0.05, half up); 23 min → 0.0; 3 600 min → 7.5; shown with `formatNumber` at one decimal |
| AC-1.7 | component | project without terms, or whose terms are an SLA and no hour package (D82): the Hours card holds the widget alone (no consumption block, no divider), and the total shows without opening the breakdown |
| AC-1.8 | integration + unit | summary as a `projects:access` reader who is neither manager nor holder → 200 with totals; key-set test on `SummaryAnswer` (no money key); `consumption.ts` uses no money formatter |
| AC-2.1 | integration + component | summary `byWorkType` keyed + `none` group (project entry without work type, meeting entry); `HostHours`: the total visible on mount, the breakdown closed on mount and opening with no new request, both groups rendered when open, the By person table only when `byPerson` is present |
| AC-2.2 | integration | deal summary includes entries on meetings linked to the deal, per work type |
| AC-2.3 | integration + e2e | `projectManagerId === sub` → `byPerson` present; e2e: the PM sees per-person, a reader does not |
| AC-2.4 | integration | `ownerUserId === sub` → `byPerson` present |
| AC-2.5 | integration | reader neither manager nor owner → `byPerson: null`; holder of `time-entry:read-all` → present; auth down → `null` + `"authz"` |
| AC-2.6 | component | projects-ui and crm-ui: `HostExtension` failure → the slot's "Hours unavailable" fallback inside the Hours card, page renders; `HostHours` 503 → its error state; `ConsumptionBlock` 503 → its error state; the two failures independent (block fails / widget loads, widget fails / block loads, both fail: two banners, each with its Retry) |
| AC-2.7 | integration | projects-api resolve: `projectManagerId: null` while awaiting; hours-api: caller = PO ops-manager → `byPerson: null`, holder → present |
| AC-2.8 | unit + component + e2e | `timeEntryRecordedEvent` guard; `RecordHours` dispatches exactly once after a successful save and never after a refused one; `HostHours` and `ConsumptionBlock` re-read on an event naming their target and ignore another target or a malformed `detail`; a burst gives one re-read; e2e: record 1 h from the project page, the card's figures grow by 1 h without a reload; not met by the block on a page open across Zurich midnight for a capacity package without an expiry, a yearly package's anniversary or a package's start date (Risk R8 (a)–(c), accepted) |
| AC-3.1 | integration | `matrix.test.ts` inventory: the only new hours-api route is a `GET`; no write route added in any service |
| AC-3.2 | unit | `catalogGaps` parity + no-hardcoded-copy scans in hours-ui, projects-ui, crm-ui; formatters only (`formatDuration`, `formatNumber`, `formatDate`) |
| AC-4.1 | integration | entry on a project-linked meeting by a participant not on the team counts in the project's summary |
| AC-4.2 | integration | fake meetings `relink` project A → project B / deal / none: next summary of A excludes, of B includes |
| AC-4.3 | integration | summary `totalMinutes` and `windowMinutes` include linked-meeting entries |
| AC-4.4 | integration | `GET /time-entries?projectId=` lists the linked meeting's entries; cursor 409 `project_meetings_changed` on a relink between pages |
| AC-4.5 | integration | `groupBy=project`: linked visible → keyed; hidden project → `hidden`; hosts down → `project-unknown`; unlinked → `none` |
| AC-4.6 | unit | `hoursWorkbook`: the ten headers in order, Counts for project the 7th, right after Counts for deal; its cell for project, linked-meeting, hidden, unknown and other entries |
| AC-4.7 | integration | viewer who cannot read the meeting's project: `on.project` is `{state:"linked", visibility:"hidden"}` with no id, label or href; totals put it in `hidden`; export cell is the hidden word |
| AC-4.8 | integration + component | `projectId` filter with meetings-api down → 503, nothing partial; hours-ui refusal view and kept pages (D48) |
| AC-4.9 | integration + component | summary 503 when meetings-api is down; `HostHours` and `ConsumptionBlock` show unavailable, no figure |
| AC-4.10 | integration | no project filter, hosts down → list answers with `on.project.state: "unknown"`, `unavailable` ∋ `meeting-projects` |
| AC-4.11 | unit | `tableGrid`: an entry on a project-linked meeting is on the meeting's row |

Also: meetings-api route tests for `projectId` (exactly-one rule, 422, scope, `sub` allowlist, only project-host meetings
returned); crm-api resolve test for `ownerUserId`; shell `extensions` test for the new name; `HostHours` throws on an
invalid prop set; `openapi.contract.test.ts` for the new route.

## Risks

- **R1 This work is stacked on PR #12 (meeting-hours), which is not merged and touches the same files** — hours-api
  `src/entries/filters.ts`, `view.ts`, `list.routes.ts`, `src/test-support/world.ts` / `hosts.ts`, `src/openapi/registry.ts`,
  hours-ui `hoursApi.types.ts`, `EntryRow.tsx`, `EntriesTable.tsx`, `strings/entries.ts`, `scripts/check-shared-copies.ts`
  and the shared ledger. Since the owner's decision of 2026-11-26 the branch sits on #12's branch instead of waiting for its
  merge, so it depends on #12 landing: a change to #12 in review must be restacked, and this pull request is merged only
  after #12 and only into `main`. Mitigation: T5 rebases onto `feat/meeting-hours` at `75c712da`, and every hours-api and
  hours-ui task follows it. After any new #12 commit, or a rebase of #12 onto a newer `main` (it is 12
  commits behind `main` on 2026-11-26): `git rebase --onto <#12's new head> <the #12 head the branch sat on>` — never a plain
  rebase, which replays #12's old commits once #12 is rewritten — then T5's checks again (`bunx prisma generate` and
  `bun run typecheck` in hours-api and meetings-api, `pnpm build` in hours-ui, `mise run shared:check`), plus `pnpm build`
  in any other app the new base changed (projects-ui: `main`'s task board and drawer since `225f0275`). Once the branch is
  pushed, every restack is a force push, the owner's call each time. When #12 merges by a merge commit nothing is rebased;
  squashed or rebased (both allowed on `matteocodogno/operai`), first `git fetch origin` and
  `git rebase --onto origin/main <#12's last head>`, so #12's commits are not carried twice. A pull request's base is a
  branch of the repository it is opened in, and #12 is a cross-repository PR whose branch exists only in the fork
  (`edoparo:feat/meeting-hours`; `matteocodogno/operai` has none, checked 2026-11-26): unless a maintainer pushes it there,
  the stacked PR is either opened in the fork against `feat/meeting-hours` and re-opened on `matteocodogno/operai` against
  `main` once #12 merges (GitHub does not move a PR between repositories), or opened there against `main` as a draft that
  lists #12's commits until then — the owner's choice at the first push. `changeset-check` and `react-skew` run only for a
  pull request into `main`, so on a stacked base they first run at that move. Early check: before each hours-api or hours-ui
  task, `git merge-base --is-ancestor <#12's current head> HEAD` (`gh pr view 12 --repo
  matteocodogno/operai` gives the head and whether it merged).
- **R2 Deploy order** (§ Deploy order): hours-api before meetings-api makes every project filter a 503. Mitigation: the
  order is in the changeset notes and infra/README; early check: hours-api's integration test with a meetings fake that
  answers 422 to `projectId` asserts a 503, so the failure is a known, closed one.
- **R3 Summary latency** — one owner resolve, one meetings-api read, maybe auth and identities, plus two `groupBy` per page
  view, twice on a project page (the consumption block and the widget, in the one Hours card). Mitigation: no extra round trip beyond these; p95 budget 800 ms as
  specs/20261112-time-tracking R2. Early check: the e2e journey logs the summary's timing; a project page that loads the
  summary twice is accepted for now (one-call merge only if the budget slips).
- **R4 An old hours-ui on a new hours-api** would meet `project-unknown`. Mitigation: hours-ui deploys first (step 2).
  Early check: a `TotalsCardRows` test renders an unknown kind without throwing.
- **R5 The same time recorded twice** (meeting and project) inflates consumption (A48, accepted). Signal: the per-work-type
  "without a work type" group grows on projects with many linked meetings.
- **R6 Consumption composed in the browser** must be rebuilt server-side by specs/20261112-project-alerts. Mitigation:
  `packagePeriod` lives in projects-api now; the man-day rule is one line, recorded here for that spec.
- **R7 Per-person hours of people outside the team** (A49) reach the project manager. Accepted by the owner (A49); part of
  the labour-law sign-off O3 of specs/20261112-time-tracking (hours visible to someone other than the person).
- **R8 A project page open across Zurich midnight keeps the package period of the day it read the project on** —
  projects-api derives `currentPeriod` (`from`, `to`, `ended`, or `null` before the start) for the Europe/Zurich day of the
  read (`packagePeriod`, `projects-api/src/terms/packagePeriod.ts:68-87`, § Consumption); projects-ui draws the
  consumption block from it and sends it as the summary's window (`summaryRequestOf`,
  `projects-ui/src/lib/consumption.ts:107-118`, T15; the summary takes `windowTo` only together with `windowFrom`, § API
  contracts), and every later read of the block — after a Record hours save (AC-2.8) or a Retry — asks the same window.
  Only a new read of the project moves it: a reload, or a write on the page that answers with the project or reads it
  again (details, team, state, terms, purchase order; `projects-ui/src/pages/ProjectDetailPage.tsx:130-142`). One cause,
  four cases: (a) **a capacity package without an expiry** is counted up to the day of the read, so hours dated later stay
  out of the block — used too low, so left too high or "Over by" too low — while the `hours.hostHours` panel's total in
  the same card, read without a window, includes them (AC-1.3, AC-2.8); (b) **a yearly package's anniversary** passing
  leaves the block on the period that has ended, and a save dated in the new period does not move it (AC-1.1, AC-1.2,
  AC-2.8); (c) **a package's start date** arriving leaves the block saying the package has not started, and the block asks
  no summary then, so a save has nothing to re-read (A51, AC-2.8); (d) **a capacity package's expiry** passing shows the
  "Expired" mark only once the page reads the project again, its figures right all along, since the window is `[start,
  expiry]` before and after (AC-1.9). Only (a) is an under-count, and only (a) has no date on screen to show it: the block
  says "From <start>, no expiry", while (b)–(d) show the period's end, the start date or the expiry, which a reader can
  set against the day. Until the project is read again, AC-1.1's current period, AC-1.3's "today", A51's start and
  AC-1.9's expiry are judged on the day of the read, and AC-2.8 holds for the panel, not for the block, in (a)–(c).
  Accepted and documented by the owner's decisions of 2026-11-27 (D85, A52). Rejected: computing the Zurich day, and with
  it the period, in the browser (the day and the period are the server's to decide, D-P3; it would take a second
  `packagePeriod`); letting `GET /time-entries/summary` take `windowFrom` alone (a contract and hours-api change for a rare
  case, and it would mend (a) only); re-reading the project on every `operai:time-entry-recorded` naming it, so
  `currentPeriod` refreshes (one more projects-api read per save, more than the cases are worth for now) — **the way out
  if the limitation ever matters**: it mends all four at the next save on the page, as the re-read after a terms write
  does today (`ProjectDetailPage.tsx:137-142`), a projects-ui change with no API change; a page where nothing is saved
  still keeps the day of its read until it reads the project again. Signal: on a page not reloaded since before a Zurich
  midnight, a Record hours save that moves the panel's total and not the block (a)–(c), or a date on the block that the
  day has reached or passed with nothing changed in the block (b)–(d); a reload corrects each.

## Security

**Security-sensitive: YES.** The summary is the suite's first read of *other people's* hours by someone who does not
hold `time-entry:read-all` (personal data about workers, labour-law O3), its authorisation is delegated to two owners
over the forwarded JWT, and it adds a filter to a service-credential route. Schedule the owasp-reviewer in parallel with
QE. Points to check:

- Existence and access: 404 identical for a missing record and an unreadable one; no enumeration through
  `projectId`/`dealId` (the owner's `missing` and `reader:false` map to the same body).
- `byPerson` withheld on every path that is not manager, owner or holder, including auth outages (never a cached grant).
- No entry, note, meeting id or title, activity subject or amount in `SummaryAnswer` (key-set test).
- meetings-api `projectId` filter: same scope and `sub` allowlist as `dealId`; answer stays `{id, host}`.
- The meeting → project label follows the viewer (D44): an id or a name of a project the viewer cannot read never
  reaches them, in the list, totals or export.
- `HostHours` renders text only (no `href` built from a name).

## ADR candidates

Written 2026-11-26:
`docs/adr/20261126-a-record-hours-summary-is-authorised-by-the-records-owner-as-the-reader-and-its-per-person-part-by-a-role-the-owner-states.md`
(D-P1, D-P2), `docs/adr/20261126-a-figure-set-against-another-owners-figure-is-composed-by-the-screen-of-the-owner-of-the-comparison-and-a-panel-about-one-tools-data-is-that-tools-widget.md`
(D-P3, D-P4), and § Amendment 2026-11-26 of `docs/adr/20261112-time-bookability-asked-of-owners-meeting-hosts-system-route.md` (D-P5).

- **A record's hours are served by hours-api to the record's readers, authorised by the owner as the caller, with the
  per-person figure by a role the owner states** (D-P1, D-P2). Amends ADR
  20261112-hours-api-time-entries-own-service-hours-catalog ("own hours only, everyone's only by oversight"): a third
  read, scoped to one record and aggregated. Rejected: service-credential composition by the host, `whose=all` for
  readers, client-side hiding, a host-computed boolean, a second GET per summary.
- **Consumption is composed by the screen of the terms' owner from two owners' figures; the breakdown is hours-ui's read
  panel through the host-extension seam** (D-P3, D-P4). Rejected: hours-api reading terms, projects-api calling
  hours-api, terms as widget props, a library component per host.
- **Amendment of ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route § 5**: the meetings linked to a
  *project* are read from the same system route with a `projectId` filter, and count for the project everywhere a
  linked meeting counts for a deal (D-P5, D78). Rejected: storing the project on the entry, a per-meeting scan.
- **Amendment of ADR 20261116-record-hours-widget-through-the-host-extension-seam** (D-P6, D84): the widget still returns
  nothing to its host, but broadcasts a content-free fact about the target it wrote to, which any panel showing that
  target's figures may use to re-read. Rejected: a callback prop, a shell pub/sub API, polling, a host-side reload.
