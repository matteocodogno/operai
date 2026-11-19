---
spec: 20261116
status: approved
approved: 2026-11-19
---

# Plan: Record hours in place — from the project, the deal and the task, and a week and month view of My hours

Spec: `spec.md` (approved 2026-11-16; amended and re-approved 2026-11-16, 2026-11-17 and 2026-11-19). Decision ledger: `ledger.md`.
Plan history: approved 2026-11-16; first amendment 2026-11-17 (below), kept approved; **second amendment 2026-11-19**,
re-approved by the user 2026-11-19 with AC-5.26 settled (ledger D25).

> Second amendment, 2026-11-19, after the spec was reopened and re-approved (ledger D15–D24, MF1–MF7, MA1–MA9): the Week
> view becomes the **table view**, with a week or a month as its period, and My hours opens on it; the List moves to
> `?view=list`; empty cells are no controls; Next stops at the current period; a date field picks the period; every
> hours page has the full width. All of it is in **§ Amendment 2026-11-19** near the end. Where it changes a binding
> contract above, the earlier text is kept as history and marked *Superseded 2026-11-19* or *Changed 2026-11-19*. The
> fix round's changes made outside the plan (eval-report § Spec fidelity (a)–(c)) are now rows of the Components table,
> marked *already built*, and the two as-built deviations (d), (e) are noted on their rows.

> First amendment, 2026-11-17, after /wellforge:design (design.md § Gaps): the widget's message has no timer (G1);
> `activityName` may name a deal-less task's button (G3); a retired category's row offers no recording (G4, spec
> AC-5.24, ledger D12); the Week ignores the List's hidden controls in "filtered" (G5); dialogs from a week cell
> focus Duration (G7); a fixed dialog shows the picker's refusals for the whole dialog (spec AC-4.2, ledger D13).
Depends on specs/20261112-time-tracking (hours-api, hours-ui, `EntryDialog`); nothing here changes hours-api.

## Architecture

### Shape in one paragraph

Two pieces, both owned by hours-ui. **(1) Record hours on other tools' pages** is a new federated module of
hours-ui, `./RecordHours`: a button that opens My hours' own `EntryDialog` with the target (and the task) set and
fixed, records the entry as the person through the unchanged `POST /time-entries`, and says what it recorded with
a link to My hours. Hosts embed it through the shell's existing `HostExtension` seam under the new name
`hours.recordHours` (ADR 20261104-host-extension-federated-panel-through-the-shell), with their own fallback — a
link to My hours — when hours-ui cannot be loaded (AC-4.5). Whether a page offers it at all is decided by the host
from data it already holds and the person's id (D4): the project's manager and team, the deal's owner and
technical contact, a task's assignee and participants. Hours-api still decides every save, fail closed (ADR
20261112-time-bookability-asked-of-owners-meeting-hosts-system-route). **(2) The Week view** is a second view of
My hours on the same page (`/hours?view=week`), built from ONE complete, all-or-nothing read of the person's
entries of that week (`readAllEntries`, the export's walk) and folded into rows × days by a pure function; its
cells open the same `EntryDialog` (preset, not fixed) or the list of their entries with the list's Edit and
Delete. No hours-api route, schema or permission changes.

### Components

| Where | What changes | Why |
|---|---|---|
| `hours-ui/src/components/EntryDialog.tsx`, `EntryDialogModel.ts` | Recording mode gains `preset` (day, target, task), `fixed` (target kind, entity and task shown read-only) and `focus` (`day` default, or `duration`). `emptyValues` → `presetValues(today, preset)`. Editing mode unchanged. | D3, AC-1.3, AC-2.3, AC-3.2–3.4; AC-5.12, AC-5.13, AC-5.18 (preset, not fixed — WA6). The design's seam ("prop-driven, initial values in", time-tracking design § Seams). |
| `hours-ui/src/components/ActivityField.tsx` | `locked?: boolean` becomes `lock?: 'hidden' \| 'fixed'`: `hidden` is today's "not visible" variant, `fixed` shows the task the page chose with its own words. | AC-3.2, AC-3.3: the task is set and not changeable. *As built: `locked?: boolean` is kept as a deprecated alias of `lock="hidden"` (decisions.md T1; eval (d)).* |
| `hours-ui/src/RecordHours.tsx` (new, exposed `./RecordHours`) | The widget: button → lists read on open (`getTimeLists`) → `EntryDialog` with `preset` + `fixed` + `focus: 'duration'` → `createEntry` → a status message "2 h 30 recorded on <name> · See in My hours" (`navigateSuite('/hours')`). Never edits, never deletes. | US-1–US-4. *As built and as the sequence below says: the button is busy until `getTimeLists` answers or fails, then the dialog opens (decisions.md T2; eval (e) concerned design S4, since corrected).* |
| `hours-ui/vite.config.ts`, `src/federation/exposes.test.ts` | `exposes['./RecordHours']`; the "exposes nothing else" test lists three modules. | The seam. |
| `hours-ui/src/lib/week.ts` (new) | `mondayOf(day)`, `weekDays(monday)` (7, Mon–Sun), `readWeekParam(search, today)` (a real day → its Monday; anything else → this week), `shiftWeek(monday, ±1)`. | AC-5.3–5.5, WA1, WA5. *Changed 2026-11-19: `readWeekParam` clamps a future week (§ Amendment).* |
| `hours-ui/src/lib/weekGrid.ts` (new, pure) | `weekGrid(entries, monday) → WeekGrid` (contract below): rows, cells, row/day/week totals, order. | AC-5.6–5.10, 5.23, 5.24. *Superseded 2026-11-19 by `lib/tableGrid.ts` (§ Amendment).* |
| `hours-ui/src/components/EntryRow.tsx` (new, moved out of `EntryDayList.tsx`) | The list's entry row, exported unchanged so the cell dialog shows exactly what the list shows. `EntryDayList` imports it. | AC-5.15 ("each with what My hours' list shows"). |
| `hours-ui/src/components/WeekView.tsx`, `WeekCellDialog.tsx`, `WeekNavigator.tsx`, `ViewSwitch.tsx` (new) | The grid card, the cell's entries (Edit, Delete, Add hours), previous / next / this week, the List \| Week switch. | US-5. Exact controls and layout: `/wellforge:design`. *Renamed and generalised to a period 2026-11-19 (§ Amendment).* |
| `hours-ui/src/pages/MyHoursPage.tsx` | Reads `view`; in Week it makes the week read instead of the three list reads (entries, day totals, totals), hides Period, Totals, Entries and Export, shows the week card. The record / edit / delete handlers are shared; after any write it re-reads whichever view is shown. The deal-filter refusal (AC-4.11 of time tracking) blocks the week as it blocks the list. | AC-5.1, 5.2, 5.19–5.22, WA10. *Changed 2026-11-19 (§ Amendment).* |
| `hours-ui/src/components/HoursFiltersState.ts`, `HoursFilters.tsx` | `view` and `week` in the search; `clearFilterSearch` keeps both (a view, not a filter); Period is not rendered in Week, and in Week `isFiltered` and Clear filters ignore `period`, `from`, `to` and `group` (G5). | AC-5.21, 5.22, WA5. *Changed 2026-11-19 (§ Amendment, The address of My hours).* |
| `hours-ui/src/components/HoursShell.tsx` | `ToolLayout width="wide"` while My hours is in Week (C1, the EstimAI workspace width); `default` everywhere else. | C1. *Superseded 2026-11-19: `wide` on every hours page (AC-5.33, D16).* |
| `hours-ui/src/strings/recordHours.ts`, `strings/week.ts` (new) + `strings.ts` | en + `it: typeof en`. | AC-4.6. *2026-11-19: `strings/week.ts` becomes `strings/table.ts` (§ Amendment, Copy).* |
| `shell/src/lib/extensions.tsx` | `ExtensionProps['hours.recordHours']` and `LOADERS['hours.recordHours'] = () => import('hours/RecordHours')`. | The seam. |
| `shell/src/federation/remotes.d.ts`, `shell/vitest.config.ts`, `shell/src/federation/__stubs__/hoursRecordHours.tsx`, `shell/src/lib/noHardcodedStrings.test.ts`, `shell/src/lib/extensions.test.tsx` | Ambient type, test alias and stub, the dotted name allowlisted, a loader test. | The seam. |
| `projects-ui/src/federation/remotes.d.ts`, `projects-ui/vitest.config.ts`, `projects-ui/src/federation/__stubs__/shellExtensions.ts` (new) | projects-ui's first use of `shell/extensions`: ambient type (`'hours.recordHours'` only), alias, stub (renders `fallback`, the crm-ui stub's shape). | — |
| `projects-ui/src/lib/recordHours.ts` (new), `src/components/RecordHoursAction.tsx` (new) | `mayRecordOnProject`, `mayRecordOnTask`, `recordHoursPropsOf(task)`; the seam wrapper (dynamic `import('shell/extensions')`, `typeof HostExtension === 'function'`, own error boundary — `crm-ui/src/components/MeetingsSection.tsx:39-106`'s shape) with the fallback link. | AC-1.1, 1.2, 3.1–3.6, 4.5. |
| `projects-ui/src/pages/ProjectDetailPage.tsx` (header, beside the manage actions), `src/components/ProjectTaskItem.tsx` and `src/pages/MyTasksPageRow.tsx` (`TaskRow` `actions`) | Render `RecordHoursAction` when the rule says so. `TasksCard` already passes `currentUserId`. | US-1, US-3. |
| `crm-ui/src/federation/remotes.d.ts` | `ExtensionProps` gains `'hours.recordHours'` (the hand-kept copy). | The seam. |
| `crm-ui/src/lib/recordHours.ts` (new), `src/components/RecordHoursAction.tsx` (new) | `mayRecordOnDeal`, `mayRecordOnTask`, `recordHoursPropsOf(activity)`; the seam wrapper. | AC-2.1, 2.2, 3.1, 3.3–3.6, 4.5. |
| `crm-ui/src/pages/DealDetailPage.tsx` (header), `src/components/ActivityItem.tsx` (`TaskRow` `actions`, so the Tasks page and every Activity timeline — deal, company, contact) | Render it. `ActivityItem` already has `currentUserId` (`:51`). | US-2, US-3. |
| projects-ui and crm-ui `strings` | The fallback link's words ("My hours" / "Le mie ore"), en + it. | AC-4.5, AC-4.6. |
| `shell/e2e/hours-in-place.spec.ts` (new), `shell/e2e/helpers/hoursOwnersFixtures.ts` (reused) | The journeys below. | Test strategy. |
| `AGENTS.md`, `.changeset/*` | hours-ui exposes `./RecordHours`; the shell's `hours.recordHours` extension; the Week view. Changesets: hours-ui, shell, projects-ui, crm-ui (minor). | — |
| `operai-ui/src/components/ListRows.tsx` (+ `ListRows.test.tsx`, a sentence in `operai-ui/docs/design-system.md`, `.changeset/operai-ui-list-rows-keyed.md`) | ***Already built*** *(fix round 1, QE D3, `2a13468e`; added here 2026-11-19).* Each `<li>` is keyed by its child's key (`Children.toArray`), not by its position, so a row added or removed above no longer remounts the rows below. A behaviour change of an existing library component for every caller (all call sites key rows by id), no new prop; it ships through the shell, so until that shell is live a host keeps the old behaviour. | AC-4.3: a task row's success message survives the host list's re-read when a row above it changes. |
| `projects-ui/src/components/TasksCard.tsx` (`cacheKey`) | ***Already built*** *(`6a5cf4a0`, `9e044889`).* `useResource(load, { cacheKey: 'project-tasks:' + JSON.stringify([project.id, view, page]) })`: a re-read keeps the rows on screen; a revisit shows the last-known rows and refreshes behind them, as My tasks does. Tests: `TasksCard.reload.test.tsx`, `MyTasksPage.keepsRows.test.tsx`. | AC-4.3 (the message in a Tasks card row survives the card's re-read) |
| `crm-ui/src/components/ActivityTimeline.tsx` (`cacheKey`; `ListRows` kept) | ***Already built*** *(`94a55af3`, `b7aac5e5`).* `useResource(load, { cacheKey: 'crm-activities:' + JSON.stringify([target, page]) })`, the same effect on every timeline (deal, company, contact). Tests: `ActivityTimeline.keepsRows.test.tsx`, `TasksPage.keepsRows.test.tsx`. | AC-4.3 (the message in a timeline row survives the timeline's re-read) |
| `hours-ui/src/lib/useHoursQuery.ts` | ***Already built*** *(T12, decisions.md).* An outcome is dropped as soon as the request it answered is no longer the one wanted (a key change, or `null`), so a view that goes away and comes back with the same request text is `loading`, never its old answer. Tests: `useHoursQuery.test.tsx` ("a key left for another … is loading"), `MyHoursPage.weekCells.test.tsx` ("Week → List, an entry deleted there → Week"). | AC-5.20 (figures follow a write, never an old answer), Decision 1 (no figure from a set that is not the current read) |
| `hours-ui/src/components/DeleteEntryDialog.tsx` | ***Already built*** *(fix round 1, `ea592129`).* A delete that fails leaves the keyboard on Confirm (found through `closest('form')`, the D2 route), never on `<body>`. Tests: `DeleteEntryDialog.focus.test.tsx`, `MyHoursPage.edit.test.tsx`, `MyHoursPage.weekCells.test.tsx`, e2e R3. | AC-5.17 (Delete from a cell's list asks first; a refused delete keeps the dialog usable) |

### Decisions this plan makes

1. **The week's figures are summed in the browser, from one complete read** (ADR candidate R1, written as
   `docs/adr/20261116-week-view-sums-a-complete-read-in-the-browser.md`). The Week view
   reads every entry of the person's week through `readAllEntries` (`GET /time-entries`, `limit=500`, every
   page, all or nothing — the export's walk, `hours-ui/src/lib/exportPages.ts`) and folds them with
   `weekGrid`. Every figure — cell, row, day, week — is a sum over that one set, so they agree by construction
   (Σ cells = row, Σ rows = week = Σ days), and a page that fails shows an error, never a partial grid. The
   cell's list (D8) needs the entries anyway, and the grid needs a row per meeting and per unreadable target
   (AC-5.6, AC-5.23), which no totals grouping gives (`project` and `deal` merge what the viewer cannot name
   into one `hidden` group; there is no `meeting` grouping).
   This **narrows** the time-tracking design convention "No figure on screen is computed in the browser"
   (specs/20261112-time-tracking/design.md, conventions) for this view: its reason was a sum over the pages
   loaded so far, wrong until the last page (plan § Totals, "Day totals", rejected "a client sum marked so
   far"), and a deal's total that must include meetings linked now (read with hours-api's own credential).
   Neither applies: the read is complete or absent, and a meeting's hours stay on the meeting's row (D10).
   *Rejected:* a server grid (`groupBy` of two dimensions, or a `GET /time-entries/week`) — a second
   aggregation shape on the totals contract, a new route to version and deploy first, and the cell's list
   would still need the entries; the week's day and week totals from `groupBy=day` with cells summed in the
   browser — two sources for figures that must add up on one screen; the list's paged reads — "so far" sums.
   *Amended 2026-11-19:* the same holds for the table view's month (§ Amendment, decision 8 and § The period's read;
   ADR candidate R3 widens the ADR's scope from "the Week view" to "the table view, week or month").
2. **Record hours is hours-ui's own widget, reached through the shell's `HostExtension`** (ADR candidate R2,
   written as `docs/adr/20261116-record-hours-widget-through-the-host-extension-seam.md`).
   The host passes plain strings (the convention of ADR 20261104-host-extension-federated-panel-through-the-shell;
   the boundary is keyed by `JSON.stringify(props)`, `shell/src/lib/extensions.tsx:130`) and nothing comes back:
   the widget owns the dialog, the write, and the message after it (AC-4.3: "nothing else on the page changes",
   so the host needs no callback). The link to My hours goes through `navigateSuite` (`shell/src/lib/session.ts:872`),
   a shell-router transition, not a reload. *Rejected:* a copy of the dialog in each host (two dialogs, two
   sets of rules, against D3 and "never copy a component"); `EntryDialog` in `@operai/ui` (it reads hours-api
   and three owners; ADR 20261104-host-extension-federated-panel-through-the-shell keeps domain widgets out of the
   library); a link that opens My hours with the target prefilled (the person leaves the page — the problem
   the spec exists for); a host callback across the seam or a new shell toast API for the message (a function
   across the boundary, or a new shell seam, for a message the widget can say itself).
3. **Who is offered Record hours is decided by the host, from what it already shows** (D4, the user's choice;
   no ADR — the ledger records it and its rejected options). A pure function per host, `null` for a person
   whose id the session has not given yet:
   - project: `me === project.projectManager?.id || project.team.some(p => p.id === me)`
     (`projects-ui/src/lib/types.ts:162-164`);
   - deal: `me === deal.owner.id || me === deal.estimate?.technical.id` (`crm-ui/src/lib/types.ts:112, 126`;
     both are auth user ids: `ownerUserId`, `technicalUserId`);
   - task: `me === task.assignee?.id || (participants ?? []).some(p => p.id === me)` — the author alone is not
     offered it (AC-3.1); a done task as an open one (AC-3.6, A4).
4. **What a task row records on** (D2, F6, F9): a project task (`kind: 'operational'`, `project.id`) →
   project + task; a pre-sales task with a deal (`deal.id`) → deal + task; a pre-sales task with no deal →
   other work, kind fixed, no category chosen, no task (`activityId` is accepted only on a project or a deal,
   time-tracking AC-2.7). The crm-ui `Activity` type gains nothing: `deal` is on it (`types.ts:311-332`).
5. **The view is a search param of My hours, not a route** — `?view=week&week=YYYY-MM-DD`. The page stays
   mounted when the person switches, so the project and deal picked in the filters (held in memory, the URL
   carries no label — `HoursFiltersState.ts` header) are still set (AC-5.22); My hours' tab stays current
   (`includeSearch: false`); the list's `period` stays in the URL, unread in Week, so going back restores it.
   *Rejected:* a `/hours/week` route (a remount loses the in-memory picks; the tab would need its own
   matching). A plan note, not an ADR: one page's address, changed in one file.
   *Superseded 2026-11-19 for the address itself (§ Amendment, The address of My hours): the table view is the default
   and the List is `?view=list`. The reasoning — a search param, not a route, so the page stays mounted — stands.*
6. **Seam wrapper per host.** projects-ui and crm-ui each get a ~40-line `RecordHoursAction` with the
   `MeetingsSection` shape (dynamic import of `shell/extensions`, feature check, own boundary). `@operai/ui`
   cannot import `shell/extensions`, and a library component that took the loader as a prop would hide nothing.
   In crm-ui the dynamic import may be shared with `MeetingsSection` through a small hook; that refactor is
   allowed, not required.
7. **Rows without a readable name, and rows on a retired category, offer no recording** (AC-5.24, WA8, D12):
   `hidden` and `unavailable` alike — an owner that did not answer cannot be named in the dialog either — and a
   retired category is never offered for a new entry (time-tracking AC-3.4). Their entries are still listed, edited and
   deleted from the cell.
   *Amended 2026-11-19:* an empty cell is no control on any row (AC-5.32, D17); what remains of this decision is the
   absence of Add hours in such rows' cell lists (AC-5.24 as amended).

### Sequences

**Record from a page (project, deal or task row)**

```
host page renders → may(me, record)? ─no→ nothing
                                    └yes→ <RecordHoursAction props=…/> → import('shell/extensions')
   → <HostExtension name="hours.recordHours" props fallback=<a My hours>/>
   → shell LOADERS → import('hours/RecordHours')   (5 s; failure or timeout → fallback, AC-4.5)
click Record hours → getTimeLists() → EntryDialog(preset, fixed, focus: duration)
Save → POST /time-entries as the person (hours-api asks the owner as the caller, fail closed)
   201 → dialog closes; widget shows "2 h 30 recorded on <name>" + See in My hours (navigateSuite('/hours'))
   4xx/5xx → EntryDialog's own failureOf words it, values kept (AC-4.2)
```

**The Week view** — *superseded 2026-11-19 by § Amendment, Sequence: the read is the period's, and an empty cell records nothing.*

```
/hours?view=week[&week=d] → monday = readWeekParam(search, todayZurich())
readAllEntries({ whose: 'mine', from: monday, to: monday+6, target, projectId, dealId, categoryId, workTypeId })
   ok → weekGrid(items, monday) → WeekView; unavailable → HoursBanners as on the list
   503 host_unavailable with a deal filter → DealFilterUnavailable (time-tracking AC-4.11), nothing drawn
   any other failure → ErrorBanner + Retry (no partial grid)
empty past cell → EntryDialog(preset: day + row, focus: duration)   cell with hours → WeekCellDialog(entries)
   → Edit → EntryDialog(entry) → PATCH;  Delete → DeleteEntryDialog → DELETE;  Add hours → EntryDialog(preset, focus: duration)
any write that worked → readAllEntries again → new figures (AC-5.20)
```

## Data model

No change. No migration in any service.

## API contracts

hours-api, projects-api, crm-api and activities-api: **unchanged**. The contracts below are between hours-ui,
the shell and the two hosts.

### The shell's extension `hours.recordHours`

```ts
// shell/src/lib/extensions.tsx — ExtensionProps
'hours.recordHours': {
  on: 'project' | 'deal' | 'none'
  targetId: string      // the project or deal id; '' when on = 'none'
  targetName: string    // its name as the host shows it; '' when the host cannot name it, or on = 'none'
  activityId: string    // the task's id when recorded from a task row on a project or a deal; else ''
  activityName: string  // the task's subject; '' when there is no task. With on = 'none' (a CRM task with no
                        // deal) it only names the button, never sent (G3)
  placement: 'page' | 'row'   // the page header's button, or a task row's smaller one
}
// LOADERS
'hours.recordHours': () => import('hours/RecordHours')
```

The host renders:

```tsx
<HostExtension name="hours.recordHours" props={…} fallback={<a href="/hours">{t.myHours}</a>} />
// no `loading`: nothing shows until the widget is ready; the fallback only on failure or after 5 s
```

### `hours/RecordHours` (hours-ui `./RecordHours`)

```ts
export default function RecordHours(props: RecordHoursProps): ReactNode   // the props above
```

- Valid sets: `on: 'project' | 'deal'` with `targetId !== ''`, and `activityName` only with `activityId`;
  `on: 'none'` with `targetId`, `targetName`, `activityId` `''` and `activityName` free (the button's name only). Anything else **throws** at render (the host's boundary shows
  its fallback): a host bug, never a silent "record on nothing".
- `targetName === ''` → the dialog and the message say "this project" / "this deal".
- Writes only `POST /time-entries` with the body `EntryDialog` builds (`toInput`), the same as My hours.
- No edit, no delete, no read of entries, no permission check (`useHoursAccess` is not used).
- The message: `role="status"`, the duration in `formatDuration(…, { style: 'short' })`, "on <name>" or "on
  other work: <category>", and "See in My hours"; it goes by ×, by the next save or by leaving the page — never on
  a timer, so its link stays reachable (WCAG 2.2.1; G1). Placement next to the button (page) or under the row's actions (row):
  `/wellforge:design`.

### `EntryDialog` (recording mode only)

```ts
type EntryPreset = {
  day?: string                         // YYYY-MM-DD; default todayZurich()
  on:
    | { kind: 'project'; project: ProjectChoice }   // companyName may be null
    | { kind: 'deal'; deal: DealChoice }
    | { kind: 'meeting'; meeting: MeetingChoice }   // startsAt may be null
    | { kind: 'none'; categoryId: string | null }   // null: no category chosen (A3)
  activity?: { id: string; subject: string | null } // project or deal only
}
type EntryDialogRecordingProps = {
  entry?: undefined
  onSubmit: (input: EntryInput) => Promise<void>
  preset?: EntryPreset   // absent: today, nothing chosen (My hours' Record hours, unchanged)
  fixed?: boolean        // true: the kind, the entity and a preset activity are shown, not editable
  focus?: 'day' | 'duration'   // default 'day'
}
```

- `fixed` without `preset` is a type error (the union says so). With `fixed` and `kind: 'none'` the kind is
  fixed and the category is chosen as usual.
- With `fixed`, a refusal S2 shows on the entity picker (`not_on_project`, `not_involved_in_deal`, the target gone)
  is the form-level error with the same sentence; the target-gone sentence drops its "Choose another"
  (`strings.entry.errors.targetGoneFixed`) — spec AC-4.2 as amended, D13.
- A preset day after today is a host bug: the dialog opens on it and Save refuses it with the usual
  `future_day` words (the Week view never offers one, AC-5.14).

### My hours' address

*Superseded 2026-11-19 → § Amendment, The address of My hours. Kept as the record of the first contract;
`?view=week&week=<day>` still opens the week it names.*

```
/hours                         the List (unchanged; the user menu's link)            AC-5.1
/hours?view=week               the Week, this week                                    AC-5.2, AC-5.4
/hours?view=week&week=<day>    the week holding <day> (any real day → its Monday)     AC-5.5
```

`view` other than `week` → List. A `week` that is not a real day → this week. `target`, `category`,
`workType` (URL) and the picked project and deal (memory) apply to both views; `period`, `from`, `to` and
`group` are read by the List only and kept in the URL while the Week shows. Clear filters keeps `view` and
`week`.

### `weekGrid`

*Superseded 2026-11-19 by `tableGrid(entries, days)` (§ Amendment); every rule below holds unchanged for the week and
the month.*

```ts
type WeekCell = { minutes: number; entries: TimeEntryView[] }          // only days with entries
type WeekRow = {
  key: string                  // 'project:<id>' | 'deal:<id>' | 'meeting:<id>' | 'category:<id>'
  kind: 'project' | 'deal' | 'meeting' | 'none'
  name: string | null          // null: not readable (visibility 'hidden' | 'unavailable')
  visibility: Visibility       // 'visible' for a category
  retired: boolean             // a category's; false otherwise
  preset: EntryPreset['on'] | null   // what Add hours sets; null when name is null or the category is
                                     // retired (AC-5.24, D12)
  cells: Readonly<Record<string, WeekCell>>   // key: YYYY-MM-DD within the week
  minutes: number
}
type WeekGrid = {
  days: readonly string[]      // 7, Monday..Sunday
  dayMinutes: readonly number[]   // 7, 0 for a day with nothing
  rows: readonly WeekRow[]
  totalMinutes: number
}
function weekGrid(entries: readonly TimeEntryView[], monday: string): WeekGrid
```

- One row per `on.type` + id (an entry on a meeting is on the meeting's row whatever deal it counts for,
  AC-5.7); one row per category for `type: 'none'`.
- Order (AC-5.8): projects, deals, meetings, other work; within a kind, named rows by name
  (`Intl.Collator(<html lang>, { sensitivity: 'base' })`), then rows with no name, then by key (stable,
  never shown).
- An entry outside `monday..monday+6` throws (the read asked for the week; anything else is a server bug).
- An own entry always carries its target's id (time-tracking D44); one without (defensive) goes to the
  kind's one `<kind>:unknown` row, unnamed, with no Add hours.
- Labels: `name` is `on.label` when `visibility: 'visible'`, the category's name otherwise; how an unnamed
  row reads is the list's (`lib/names.ts` `rowName`), AC-5.23.

## Test strategy

Levels: **unit** (pure functions, vitest), **component** (React Testing Library + vitest, the app's
existing harness: `shell/session` and `shell/extensions` stubbed, `fetch`/`apiFetch` mocked), **e2e**
(`shell/e2e/hours-in-place.spec.ts`, the dev stack, nothing stubbed; fixtures from `hoursOwnersFixtures`).
File names are where the test lives; `*` = new.

| AC | Level | Test (what fails if the AC is broken) |
|---|---|---|
| AC-1.1 | unit + component + e2e | `projects-ui/src/lib/recordHours.test.ts`* PM and team member → true; `ProjectDetailPage.recordHours.test.tsx`* `HostExtension` called with `{on:'project', targetId, targetName, activityId:'', activityName:'', placement:'page'}`; e2e A: a team member sees Record hours on the project page |
| AC-1.2 | unit + component + e2e | same unit: reader not on the team, PM `null` (awaiting), `me` `null` → false; page test: `HostExtension` never called; e2e A: a salesperson who can read the project sees none |
| AC-1.3 | component | `hours-ui/src/RecordHours.test.tsx`*: dialog opens with the project as read-only text (no picker, no other kind selectable), Day = today, focus on Duration |
| AC-2.1 | unit + component + e2e | `crm-ui/src/lib/recordHours.test.ts`* owner, technical contact → true; `DealDetailPage.recordHours.test.tsx`* props `{on:'deal', …}`; e2e B: the deal's owner sees it |
| AC-2.2 | unit + component + e2e | unit: a reader, a task assignee on the deal who is not owner or technical, `estimate: null` → false; page test: never called with `placement: 'page'`; e2e B: the assignee of the deal's task sees no Record hours in the deal page's header, while their task's row in the page's timeline offers it (AC-3.1) |
| AC-2.3 | component | `RecordHours.test.tsx`: on=deal → deal read-only, Day today, focus Duration |
| AC-3.1 | unit + component + e2e | both `recordHours.test.ts`: assignee, participant → true; author only, anyone else → false; `crm-ui/src/components/ActivityItem.recordHours.test.tsx`*, `projects-ui/src/components/ProjectTaskItem.recordHours.test.tsx`*, `projects-ui/src/pages/MyTasksPageRow.recordHours.test.tsx`*: action present / absent; e2e C: a project task's assignee sees it on the Tasks card row |
| AC-3.2 | unit + component | `recordHoursPropsOf(projectTask)` → project + task; `RecordHours.test.tsx`: project and task both read-only, the POST carries `activityId` |
| AC-3.3 | unit + component | crm-ui and projects-ui (My tasks, pre-sales) `recordHoursPropsOf(task with deal)` → deal + task; `RecordHours.test.tsx` as AC-3.2 for a deal |
| AC-3.4 | unit + component | `recordHoursPropsOf(task without deal)` → `{on:'none', targetId:'', activityId:''}`; `RecordHours.test.tsx`: Other work fixed, no category selected |
| AC-3.5 | component + e2e | `RecordHours.test.tsx`: the POST body is `{on:{type:'none',categoryId}}` with no `activityId`; e2e D: from a CRM company task with no deal, My hours lists other work with the category, no task |
| AC-3.6 | unit + component | `recordHoursPropsOf` / `may…` give the same answer with `completedAt` set; row tests render it on a done row |
| AC-4.1 | component + e2e | `RecordHours.test.tsx`: the POST body equals `toInput` of the same values (My hours' builder); e2e A: after recording from the project page, My hours lists the entry with the same day, duration, project, task, work type and note |
| AC-4.2 | component | `RecordHours.test.tsx`: a 403 `not_on_project`, a 422 `invalid_minutes`, a future day, a 503 `host_unavailable` each show the string `EntryDialog` shows in My hours (same `strings.entry.errors.*` key), values kept; `not_on_project` / `not_involved_in_deal` / a 404 on the target as the form-level error, the 404 as `targetGoneFixed` (D13); `EntryDialog.preset.test.tsx`*: the client rules hold with a preset |
| AC-4.3 | component + e2e | `RecordHours.test.tsx`: after 201 the dialog closes, a `status` says "2 h 30 recorded on <name>" (and "on other work"), "See in My hours" calls `navigateSuite('/hours')`, and it is still there after 10 s (no timer, G1); host tests: no host read is repeated after the widget's save (fetch count unchanged); e2e A: the message shows, the link opens My hours |
| AC-4.4 | component | `RecordHours.test.tsx`: no Edit or Delete is ever rendered, and the widget never calls PATCH/DELETE; host tests: no hours action besides Record hours |
| AC-4.5 | component + e2e | host tests with the `shell/extensions` stub (renders `fallback`): the page and the rows work and show the My hours link; `shell/src/lib/extensions.test.tsx`: `hours.recordHours` falls back on rejection and timeout; e2e E: `**/5184/remoteEntry.js` (hours) aborted → the project page, the deal page and My tasks load, with the link (the `remote-failure.spec.ts` pattern) |
| AC-4.6 | unit | hours-ui `strings.test.ts` (parity, `catalogGaps`) + `noHardcodedStrings.test.ts`; projects-ui and crm-ui the same for the link; `RecordHours.it.test.tsx`* with `<html lang="it">` |
| AC-5.1 | component | `MyHoursPage.week.test.tsx`*: `/hours` shows the list and a List \| Week switch with List current |
| AC-5.2 | component | same: `/hours?view=week` opens on the Week |
| AC-5.3 | unit + component | `week.test.ts`*: `weekDays` = 7, Monday first, Sunday last; component: seven day headings |
| AC-5.4 | unit + component | `readWeekParam({}, today)` = this Monday; component with a fixed today: the read asks `from`=Monday, `to`=Sunday of today's week |
| AC-5.5 | component | previous / next / this week change `week` and the read's span |
| AC-5.6 | unit | `weekGrid.test.ts`*: two entries on one project on two days → one row; a project, a deal, a meeting and two categories → five rows |
| AC-5.7 | unit | an entry on a meeting whose `deal` is linked and visible → on the meeting's row, the deal's row unchanged |
| AC-5.8 | unit | rows come projects, deals, meetings, other work; by name inside each; unnamed after named |
| AC-5.9 | unit + component | a cell = the sum of its entries; a day with none has no cell and renders empty |
| AC-5.10 | unit | vectors: Σ cells = row, Σ rows = `totalMinutes` = Σ `dayMinutes`; each entry in exactly one cell |
| AC-5.11 | component | the Week shows no target, no "incomplete", no comparison: only durations from `weekGrid` (asserted against a 42 h week and a 1 h week, same markup) |
| AC-5.12 | component | an empty cell of today / yesterday opens `EntryDialog` with that day and the row's target selected, focus on Duration (G7) |
| AC-5.13 | component | that dialog's Day and target are editable; a save after changing both posts the changed values |
| AC-5.14 | component | tomorrow's cells have no button; a future week's grid has none |
| AC-5.15 | component | a cell with hours opens `WeekCellDialog` listing its entries through `EntryRow` (same text as the list) |
| AC-5.16 | component | Edit → `EntryDialog` with the entry → PATCH with the changed members only |
| AC-5.17 | component | Delete → `DeleteEntryDialog`; DELETE only after Confirm; Cancel sends nothing |
| AC-5.18 | component | Add hours in the cell's list → `EntryDialog` with the day and the row's target |
| AC-5.19 | component + e2e | recording from My hours' Record hours on a target not in the week → the week is read again and has its row; e2e F |
| AC-5.20 | component | after a save, an edit and a delete from the Week the read runs again and the cell, row, day and week figures change without a reload |
| AC-5.21 | component | with category, work type, recorded on, project and deal set, the week's read carries `categoryId`, `workTypeId`, `target`, `projectId`, `dealId` |
| AC-5.22 | component | switch List → Week → List: the URL keeps `category`/`workType`/`target`, the picked project and deal stay chosen |
| AC-5.23 | unit + component | an entry `visibility: 'hidden'` → row `name: null`; the row reads as the list reads it (`rowName`) |
| AC-5.24 | unit + component | `weekGrid`: `preset: null` for an unreadable row and for a retired category's row; component: those rows' empty cells have no button and their cell lists have no Add hours (Edit and Delete stay) |

*Rows AC-5.1, 5.2, 5.4, 5.5, 5.12 (withdrawn 2026-11-19), 5.13, 5.14 and 5.24, and journey F below, are superseded by
§ Amendment, Test strategy (2026-11-19). The suite sizes in "Existing suites must stay green" are those of 2026-11-16.*

**e2e journeys** (`shell/e2e/hours-in-place.spec.ts`, per-run `hip-*@operai.test` people, entries deleted at the end):
A. Project page: a team member records 2 h 30 with a work type and a note → message, link, My hours lists it
   (AC-1.1, 1.2, 4.1, 4.3); a salesperson reading the project sees no button.
B. Deal page: the owner records from the header; the assignee of the deal's task sees none in the header and
   one on their task's row (AC-2.1, 2.2, 3.1).
C. Project Tasks card: the task's assignee records from the row → the entry points at the task (AC-3.1, 3.2).
D. CRM company task without a deal → other work with a category, no task (AC-3.4, 3.5).
E. hours remote down → pages load with the link (AC-4.5).
F. Week: entries on two projects across three days → cells and totals; an empty past cell records; a cell's
   Edit changes it; figures follow (AC-5.12, 5.16, 5.19, 5.20).

Existing suites must stay green: hours-ui (1504), shell (659), projects-ui, crm-ui, operai-ui (290),
`shell/e2e/hours.spec.ts` + `hours-owners.spec.ts` (10/10).

## Risks

| Risk | Mitigation | Early check |
|---|---|---|
| R1 A long task list mounts many `HostExtension`s (a 5 s timer and a boundary each) | Only rows the person may record on render one; the module import is cached after the first | component test: 100 rows, one import; e2e C logs the Tasks card's render time |
| R2 Deploy order: a host on a shell without `hours.recordHours`, or a shell before hours-ui's expose | Both degrade to the host's fallback (unknown name → fallback, `extensions.tsx:92-93`; failed import → fallback). Deploy hours-ui → shell → projects-ui, crm-ui | `extensions.test.tsx` unknown-name case; e2e E |
| R3 `./RecordHours` drags in hours-ui's heavy code (exceljs, the pages) | It imports only `EntryDialog`, `hoursApi`, `searchers`, strings; `exceljs` stays behind its lazy import | the build's chunk for `./RecordHours` is checked in the T-task's done-when (no `exceljs` in its graph) |
| R4 A new `@operai/ui` component for the switch or the grid is used by hours-ui before the live shell provides it (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell) | Prefer existing components; any addition ships in the shell first, its own push | design names any NEW component; tasks order it before hours-ui |
| R5 The widget's message in a task row breaks the row's layout on a phone | Placement decided in the design with the row's slots (`TaskRow` `actions`/`children`) | design screenshot at 375 px; component test that the message is inside the row |
| R6 The Week's browser sums and the List's server day totals could show different figures for the same day if entries change between reads | Each view reads at its own moment and re-reads after its writes; they are never on screen together | none needed beyond AC-5.20's test |
| R7 A week holding more than 500 entries | `readAllEntries` walks every page (a week of 30-minute entries is at most 336 if no day passes 24 h; nothing caps a day, so the walk, not one page, is the rule) | `weekGrid` vector with 2 pages in the component test |
| R8 The widget runs on `/projects` and `/crm` pages: CSP `connect-src` must already allow hours-api there | The shell's CSP is document-wide and already names hours-api for `/hours` | e2e A–D pass only if it does |
| R9 `EntryDialog` changes regress My hours | `preset`/`fixed`/`focus` are optional and absent from every existing call; the 1504 tests stay | hours-ui suite green after the dialog task, before any page work |
| R10 The widget shows `targetName` and records on `targetId` and cannot check they belong together: a host bug could show one project's name over another's id | Each host builds all six props from ONE object in one pure function (`recordHoursPropsOf`), never assembled at the call site; the saved entry is what hours-api checked and what My hours shows | the hosts' `recordHours.test.ts` assert id and name come from the same record for every task and page shape |

## Security

**Security-sensitive: YES** — personal data about workers (hours), and a write path into hours-api now offered
on other tools' pages. Nothing widens: no new route, permission, scope or credential.

*2026-11-19:* still **YES**; the amendment changes no surface (no route, permission, scope, origin or data flow, and
one write entry point fewer) — § Amendment, Security.

What the owasp pass checks:
- **A01 access control.** The host's rule (decision 3) decides only whether a button shows; every save is
  still decided by hours-api as the caller, failing closed (`not_on_project`, `not_involved_in_deal`,
  `host_unavailable`). A forged prop (another project's id) reaches the same check. The Week reads
  `whose=mine` only; no `userId`, no oversight path.
- **Data across the seam.** Props are ids and names the host already shows to this person; nothing about
  hours goes back to the host. The widget reads no entries.
- **A03 injection / XSS.** Names render as React text; the link is a fixed path through `navigateSuite`;
  no HTML from any answer.
- **No new origin.** The widget calls hours-api and, for the activity field, activities-api — origins the
  shell's CSP already allows; `apiFetch` attaches the JWT to trusted origins only.
- **Logging.** No new log line; no note or name in a URL (the Week's address carries a day and the existing
  filter ids only).

## Amendment 2026-11-19 — the table view: week and month

For re-approval. Inputs: `spec.md` as re-approved 2026-11-19 (US-5: AC-5.1, 5.2, 5.4, 5.5, 5.13, 5.22 and 5.24 amended,
AC-5.12 withdrawn, AC-5.25–5.34 new, C1 widened, MA1–MA8, and "unless an AC names one period, it holds for the week and
for the month"); `ledger.md` § table view (D15–D24, MF1–MF7, MA1–MA9: the user's decisions, taken as given here);
`decisions.md`; `eval-report.md` § Spec fidelity (a)–(e); ADR 20261116-week-view-sums-a-complete-read-in-the-browser and
ADR 20261116-record-hours-widget-through-the-host-extension-seam; and the code at `34d3902f`: hours-ui `HoursShell`,
`HoursFiltersState`, `HoursFilters`, `ViewSwitch`, `WeekNavigator`, `WeekView`, `WeekViewModel`, `WeekCellDialog`,
`lib/week.ts`, `lib/weekGrid.ts`, `lib/exportPages.ts`, `lib/useHoursQuery.ts`, `lib/period.ts`, `pages/MyHoursPage.tsx`,
`router.tsx`, `strings/week.ts`, `strings.test.ts`; `@operai/ui` `DateInput` (`MoneyInput.tsx`), `ToolLayout`, `DataTable`
(`.table-region`), `formatMonth`; the e2e `hours-in-place.spec.ts`, `hours-in-place.round1.spec.ts`, `hours.spec.ts`,
`hours-owners.spec.ts`.

**Frontend only, hours-ui only.** No hours-api route, query, schema, permission, scope, variable or migration changes;
projects-ui, crm-ui and the shell's code are not touched (the shell and `@operai/ui` change only if the design asks for
the optional library addition of R12, which then ships through the shell first). Nothing found needs a backend change: a
month is at most 31 days (hours-api takes a span of up to 366), read with the existing walk (`limit=500`, every page), and
`to` may be a future day of the current period, as the List's presets already send.

### Shape in one paragraph

The Week view becomes My hours' **table view**, written for a **period** — a week or a calendar month — instead of for
seven days. One pure module, `lib/tablePeriod.ts`, holds everything that differs by period: its days, the period holding
a day, the previous / current / next period, the switch between week and month, the clamp to today and the date field's
bounds. Everything else is the Week's own, taking the period's days where it took a Monday: the fold (`tableGrid`, was
`weekGrid`), the card (`TableView`, was `WeekView`), the cell dialog, and the page's read, re-read and focus machinery
that QE verified. The table view is where My hours opens (`/hours` = the current week); the List moves to `?view=list`;
an existing `?view=week&week=<day>` link still opens its week. Empty cells stop being controls. `HoursShell` gives every
hours page the `wide` column. The month's figures come, like the week's, from one complete, all-or-nothing walk of the
period, so ADR 20261116-week-view-sums-a-complete-read-in-the-browser is amended from "the Week view" to "the table
view, week or month" (ADR candidate R3).

### Decisions this amendment makes

8. **One table view, parameterised by a `TablePeriod`; no second view for the month.** The month is the week's grid over
   more days (D15, MA1: the same rows, cells and cell dialog), so the fold, the card, the cell dialog and the page take
   the period's days, and only `tablePeriod.ts` knows how a week and a month differ. *Rejected:* a parallel `MonthView` /
   `monthGrid` / month cell dialog — two copies of what MA1 says is one, which drift the first time one changes, with the
   focus machinery QE fixed in round 1 existing twice; a month made of its four to six weeks' reads — several reads at
   different moments summed on one screen (the "two sources" failure shape of ADR 20261116-week-view-sums-a-complete-read-in-the-browser),
   and a partial month when one week fails; keeping the "week" names on code that now draws a month.
9. **Renamed before generalised.** `weekGrid` → `tableGrid`, `WeekView` → `TableView`, `WeekNavigator` →
   `PeriodNavigator`, `WeekViewModel` → `TableViewModel`, `WeekCellDialog` → `TableCellDialog`, `strings/week.ts` →
   `strings/table.ts`, test ids `hours-week-*` → `hours-table-*` (the navigator's `hours-period-previous` / `-current` /
   `-next`), in a first, behaviour-preserving step: every test green, no assertion changed but names. The later diffs
   then show behaviour only.
10. **The address is one `view` parameter, `list` | `week` | `month`, with the week as the default** (§ The address).
    *Rejected:* a route per period (`/hours/month`) — Decision 5's reason holds: a remount loses the in-memory project and
    deal picks (AC-5.22); the List's `period` parameter for the table's period — it already holds the List's presets
    (`thisWeek`, `thisMonth`, …) and stays in the address while the table shows; a separate `span=week|month` beside
    `view=table` — two parameters where one says it, and `view=week` links need the translation anyway; opening the List
    for a viewless address that carries a List-only parameter (old bookmarks such as `/hours?period=lastMonth`) — the table
    keeps `period` in its own address for the List's sake, so that rule would misread the table's own address.
11. **An empty cell is plain text in a `td`, not a disabled control** (D17, AC-5.32). *Rejected:* a button that does
    nothing, or one `aria-disabled` — a tab stop announced as a button that offers nothing.
12. **Next and Previous are `aria-disabled` where they cannot move, as "This week" is today.** Next on the current
    period (AC-5.28); Previous on the first period hours-api answers (the `2000-01-01` floor: a defensive rule no AC asks
    for, so Previous never writes an address the reader would refuse). `aria-disabled`, not `disabled`: Next keeps the
    keyboard after the press that reached the current period, and a press on it does nothing. *Rejected:* `disabled`
    (that press would drop focus to `<body>`); hiding Next (the navigator's buttons would move under the pointer).
13. **Every hours page has the `wide` column** (D16, AC-5.33). *Rejected:* `wide` for My hours only — the jump moves to
    the tabs (D16 weighed and rejected it).
14. **The date field navigates on every complete, in-range day, with no Apply button** (the Custom range's posture, D18:
    "the date input hours-ui's filters already use"). *Rejected:* an Apply button (a second action for one choice; the
    navigator applies at once too); a debounce (a day typed in full would still wait, and an intermediate day's walk is
    aborted anyway, R16).
15. **MyHoursPage is generalised in place, not restructured.** *Rejected:* extracting a `useTableView` hook now — it
    would move the read, re-read and focus machinery QE verified across a module boundary for no AC; the eval's code
    nit (d), the page's length, stays a follow-up.

### Components (2026-11-19)

| Where | What changes | AC |
|---|---|---|
| `hours-ui/src/lib/tablePeriod.ts` (new, pure) | The `TablePeriod` union and every rule that differs by period (contract below). | AC-5.4, 5.5, 5.26–5.31 |
| `hours-ui/src/lib/month.ts` (new) | `monthOf(day)`, `monthDays(month)`, `shiftMonth(month, n)`, `readMonthParam(search, today)` (strict `YYYY-MM`, floor `2000-01`, future → current). | AC-5.25, 5.29 |
| `hours-ui/src/lib/week.ts` | `readWeekParam`: a week after the current one → the current week; the rest unchanged. | AC-5.29 |
| `hours-ui/src/lib/weekGrid.ts` → `tableGrid.ts` | `tableGrid(entries, days)`; types `TableGrid`, `TableGridRow`, `TableGridCell`; a row's preset is `EntryPreset['on']` itself (decisions T8 foresaw it). | AC-5.6–5.10, 5.23–5.25 |
| `hours-ui/src/components/WeekView.tsx` → `TableView.tsx` | `period` in place of `monday`; heading by period; the navigator, the date field and the period switch in the part that is never replaced; empty cells plain (`onRecordCell` removed); weekday from the date; no "not started" state; scroll hint by period. | AC-5.3, 5.9–5.11, 5.25, 5.32, 5.34 |
| `WeekNavigator.tsx` → `PeriodNavigator.tsx` | Previous / current / Next for either period; Next and Previous `aria-disabled` where they cannot move (decision 12). | AC-5.5, 5.28 |
| `PeriodDateField.tsx` (new) | `Field` + `DateInput`: bounds, reference day, its own text while focused (contract below). | AC-5.30, 5.31 |
| `PeriodSwitch.tsx` (new, thin; may stay inline in `TableView`) | Week \| Month with an existing library control the design picks; reports the kind. | AC-5.26, 5.27 |
| `WeekViewModel.ts` → `TableViewModel.ts` | `periodLabel(period)` (`weekRange` or `formatMonth`), `longDay(day)` (index argument removed), `rowLabel`, `rowPhrase`, `cellOf`. | AC-5.23 |
| `WeekCellDialog.tsx` → `TableCellDialog.tsx` | `dayIndex` removed (the weekday comes from the date); otherwise unchanged. | AC-5.15–5.18, 5.24 |
| `ViewSwitch.tsx` | The table view and List (`'table' \| 'list'`); the order of the two tabs is the design's. | AC-5.1 |
| `HoursFiltersState.ts` | § The address: `readMyHoursAddress`, `withTablePeriod`, `withList`, `withTable`; `clearFilterSearch` and `isFiltered` for the table view in either period. `readView` and `withWeek` are replaced. | AC-5.1, 5.2, 5.4, 5.22, 5.29 |
| `HoursFilters.tsx` | `showPeriod` false in the table view, either period (the prop exists). | WA5 |
| `HoursShell.tsx` | `width="wide"` always; no longer reads the route or the address. | AC-5.33 |
| `operai-ui/src/components/DataTable.tsx` (+ story, test; changeset `@operai/ui` minor) | **Added at the design gate (D27, R12):** an optional `DataTableColumn.pin?: 'start' \| 'end'` — the month's row-label column and its Total column stay in view while the table scrolls, from 48 rem up (ignored below); scroll padding so a focused cell never sits under a pinned one (design.md § the table view). Ships in the shell before hours-ui uses it (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell): a hours-ui on an older shell passes a prop the live library ignores, so the month shows unpinned until the shell is live — no error. | AC-5.34 |
| `pages/MyHoursPage.tsx` | Reads the address; one table read keyed by the period's span and the filters; writes the period with `withTablePeriod`; the empty-cell recording path goes (`recordingCell` keeps Add hours only; `rowKeyOf` and the "landed" focus go); `savedMessage` by period; a cell that empties sends focus to the card's heading. | AC-5.1, 5.2, 5.4, 5.13, 5.19–5.22, 5.26–5.30, 5.32 |
| `strings/week.ts` → `strings/table.ts`, `strings.ts`, `strings.test.ts` (`AREAS`) | § Copy. | AC-4.6 |
| `lib/exportPages.ts`, `lib/useHoursQuery.ts`, `EntryDialog*`, `EntryRow.tsx`, `DeleteEntryDialog.tsx`, `RecordHours*` | **Unchanged.** "See in My hours" and the hosts' fallbacks keep `/hours`, which is now the current week. | — |
| `AGENTS.md`, `infra/README.md`, `.changeset/hours-ui-record-in-place.md` | My hours opens on the table view (`/hours`, `?view=month`, `?view=list`); infra's verification step reads `/hours` instead of `/hours?view=week`; the pending changeset's text is rewritten, no new changeset (nothing has shipped, D22). The ADR index line follows R3. | — |
| `shell/e2e/hours-in-place.spec.ts` (A, F, new G), `hours-in-place.round1.spec.ts` (R3), `hours.spec.ts`, `hours-owners.spec.ts` | § Test strategy (2026-11-19). | — |

### Sequence (2026-11-19; supersedes "The Week view")

```
/hours[?…] → address = readMyHoursAddress(search, todayZurich())                       (§ The address)
  list          → the List's three reads, unchanged
  table(period) → readAllEntries({ whose: 'mine', from: firstDayOf(period), to: lastDayOf(period),
                                   target, projectId, dealId, categoryId, workTypeId })    (limit 500, every page)
                    ok   → tableGrid(items, daysOf(period)) → TableView
                    503 host_unavailable with a deal picked → DealFilterUnavailable in the card (time-tracking AC-4.11)
                    any other failure, or an entry outside the period (RangeError) → ErrorBanner + Retry, no grid
cell with hours → TableCellDialog → Edit      → EntryDialog(entry) → PATCH
                                  → Delete    → DeleteEntryDialog → DELETE
                                  → Add hours (readable row, not retired, day ≤ today)
                                              → EntryDialog(preset: day + row, focus: duration) → POST
empty cell → nothing (not a control)
period switch | previous | current | next | date field → withTablePeriod(search, next, today), replace navigation
   → a new read key → the walk in flight is aborted and its answer dropped → skeleton → the new grid
any write that worked → the same read again (AC-5.20); an open cell dialog keeps the last grid until the new one lands
List | table switch → withList / withTable → the other view's reads; filters and picks kept (AC-5.22)
```

### The address of My hours (supersedes § My hours' address)

| Address | Shows | AC |
|---|---|---|
| `/hours` | the table view, week, the current week — the user menu, the hosts' fallback links and "See in My hours" land here | AC-5.1, 5.4 |
| `/hours?week=<day>` | the week holding `<day>` (any day → its Monday) | AC-5.2 |
| `/hours?view=week[&week=<day>]` | the same; the first contract's address, read and never written | AC-5.2 |
| `/hours?view=month` | the table view, month, the current month | AC-5.2 |
| `/hours?view=month&month=<YYYY-MM>` | that month | AC-5.2 |
| `/hours?view=list` | the List, reading `period`, `from`, `to`, `group` as before | AC-5.2 |

Reading — `readMyHoursAddress(search, today): { view: 'list' } | { view: 'table'; period: TablePeriod }`:
- `view` `list` → the List; `month` → the month; anything else, absent included (`week`, garbage, a number) → the week.
  A pasted link always lands somewhere real (the file's rule), now on the default view.
- `week` (read in the week only): a string that is a real `YYYY-MM-DD` → the Monday of its week (unchanged); a Monday
  **after the current Monday → the current week** (AC-5.29, new); a Monday before `2000-01-01`, a week past the year 9999,
  or anything that is not a day → the current week (unchanged).
- `month` (read in the month only): a string matching `^\d{4}-(0[1-9]|1[0-2])$` → that month; **after the current month
  → the current month** (AC-5.29); before `2000-01` (the month of `MIN_DAY`) or anything else (`2026-1`, `2026-11-05`,
  `202611`, a number, garbage) → the current month.
- An address that was clamped or ignored is not rewritten (today's rule for a bad `week`): the period shown is derived
  from it, and the next write puts the period shown in the address.
- `period`, `from`, `to`, `group` are read by the List only and kept untouched while the table shows (G5);
  `target`, `category`, `workType` and the picked project and deal (memory) apply to every view and period.

Writing (each keeps every other key; a replacing navigation, as today):
- `withTablePeriod(search, period, today)` — the table view at `period`. Week: `view` and `month` removed; `week` = its
  Monday, removed when it is the current week. Month: `view=month`; `week` **kept as it was** — the week the month was
  reached from, which Month → Week returns to (AC-5.27, D26) and which only the week reads; `month` = `YYYY-MM`, removed
  when it is the current month. Used by the navigator, the period switch and the date field.
- `withList(search, shown: TablePeriod)` — `view=list`. When the month was shown, `month` is written, the current month
  included, and `week` **kept as it was** (corrected 2026-11-19 at T22: removing it lost the week left that D26 /
  AC-5.27 return to after a List detour), so going back finds the month and then the week; when the week was shown,
  `week` stays as it was and `month` is removed (T10's behaviour).
- `withTable(search, today)` — back from the List: `view=month` when the address holds a valid `month` (removed again
  when it is the current month), else `view` removed (the week of `week`, or the current week).
- `clearFilterSearch(search, view)` — in the table view clears `person`, `target`, `category`, `workType` and keeps
  `view`, `week`, `month`, `period`, `from`, `to`, `group`; `isFiltered` ignores the period in either period.
- The List's Period is its own: switching view translates neither a week or month into it nor back (not asked; the
  List keeps the Period the person left it on).

### `TablePeriod` (`hours-ui/src/lib/tablePeriod.ts`, pure)

```ts
export type TablePeriodKind = 'week' | 'month'
export type TablePeriod =
  | { kind: 'week'; monday: string }  // YYYY-MM-DD, always a Monday
  | { kind: 'month'; month: string }  // YYYY-MM

daysOf(p): string[]               // week: 7, Monday..Sunday (weekDays); month: 28–31, the 1st..the last (monthDays)
firstDayOf(p): string             // week: the Monday; month: the 1st
lastDayOf(p): string              // week: the Sunday; month: the last day
periodKey(p): string              // 'week:2026-11-16' | 'month:2026-11' — never shown
holding(kind, day): TablePeriod   // the week (its Monday) or the month holding `day` (AC-5.30)
current(kind, today): TablePeriod
isCurrent(p, today): boolean
shift(p, n): TablePeriod          // n whole; weeks by 7 days, months by the calendar (January − 1 = December before)
hasNext(p, today): boolean        // p is before the current period (AC-5.5, AC-5.28)
hasPrevious(p): boolean           // firstDayOf(shift(p, -1)) >= MIN_DAY (decision 12)
clamp(p, today): TablePeriod      // a period after the current one → the current one (AC-5.29)
switchTo(p, kind, today): TablePeriod
  // week → month: the current month when p is the current week, else the month holding  (AC-5.26, D25)
  //               the week's Monday
  // month → week: the week left (the address's `week`) when any of its days is in the month,
  //               else the current week when any of its days is in the month,
  //               else the first week whose Monday is in the month                       (AC-5.27, D26)
  // same kind: p
referenceDay(p, today): string    // the date field's value: today in the current period, else firstDayOf(p)
pickBounds(kind, today): { min: string; max: string }
  // max = today (AC-5.31); min = the first day of the earliest period the address accepts:
  // week 2000-01-03 (the first Monday on or after MIN_DAY), month 2000-01-01
```

- `today` is `todayZurich()`, read by the caller at render, as everywhere in hours-ui. Every function is arithmetic on
  `YYYY-MM-DD` in UTC, the `week.ts` / `period.ts` rule, so no time zone or daylight-saving change moves a day.
- A caller bug (a `monday` that is not a Monday, a malformed `month`, a fractional `n`) is a `TypeError`, as in
  `week.ts` (decisions T8). `switchTo` and `shift(p, -1)` never give a future period; `shift(p, +1)` is called only
  when `hasNext`.
- **AC-5.27, settled at the design gate (2026-11-19, ledger D26):** a week "has a day in" a month when any of its seven
  days is in it. Month → Week shows, in this order: the week the month was reached from (kept in the address's `week`
  while the month shows), the current week, the first week whose Monday is in the month (for November 2026, whose 1st
  is a Sunday, Mon 2 – Sun 8 November, not Mon 26 Oct – Sun 1 Nov). So week → month → week always lands on the week
  left, past weeks included (design.md G14, G15).
- **AC-5.26, settled at the plan gate (2026-11-19, ledger D25):** on a current week that straddles two months (Mon 30
  Nov – Sun 6 Dec 2026, today 2 December), Month shows **December**, the month holding today; a past week shows the
  month of its Monday. The spec was amended to say so.

### The period's read (extends Decision 1)

- Span: `from = firstDayOf(period)`, `to = lastDayOf(period)` — 7 days, or 28–31; the current period's future days
  included (no entry can be on them).
- Request: `readAllEntries({ whose: 'mine', from, to, target?, projectId?, dealId?, categoryId?, workTypeId? }, { signal })`
  — `GET /time-entries`, `limit=500`, every page by cursor, all or nothing (`exportPages.ts`, unchanged). `whose=mine`
  only: no `userId`, no oversight path.
- Key: `table:<JSON of those filters>` in `useHoursQuery`. A change of period, filter or view is a new key: the walk in
  flight is aborted (its `signal` reaches every page's request), a late answer is dropped (the stale-outcome rule of
  T12), and the skeleton shows at once — never the previous period's figures under the new span.
- Fold: `tableGrid(items, daysOf(period))` inside the read, so an entry outside the period (a server bug) is a failed
  read with Retry, never a throw while the page draws (T10's rule).
- A category or work type named in the address waits for the lists, as now; the deal-filter refusal replaces the grid in
  both periods (time-tracking AC-4.11).
- After any write that worked: the same key again (AC-5.20).

### `tableGrid` (`hours-ui/src/lib/tableGrid.ts`; supersedes § `weekGrid`)

```ts
type TableGridCell = { minutes: number; entries: TimeEntryView[] }
type TableGridRow = {                         // was WeekRow; members unchanged
  key: string                                 // 'project:<id>' | 'deal:<id>' | 'meeting:<id>' | 'category:<id>'
  kind: 'project' | 'deal' | 'meeting' | 'none'
  name: string | null                         // null: not readable
  visibility: Visibility
  retired: boolean
  preset: EntryPreset['on'] | null            // what Add hours sets; null: unreadable row or retired category
  cells: Readonly<Record<string, TableGridCell>>   // key: a day of `days`; only days with entries
  minutes: number
}
type TableGrid = {
  days: readonly string[]                     // the period's: 7, or 28–31, consecutive, ascending
  dayMinutes: readonly number[]               // one per day; 0 for none
  rows: readonly TableGridRow[]
  totalMinutes: number
}
function tableGrid(entries: readonly TimeEntryView[], days: readonly string[]): TableGrid
```

- An entry on a day not in `days` throws a `RangeError` naming the entry's id and day (never its note).
- Every rule of § `weekGrid` holds unchanged for both periods: one row per project, deal, meeting and category; a meeting's
  hours on the meeting's row (AC-5.7); the order (AC-5.8); the visibility summary (AC-5.23); `<kind>:unknown`; Σ cells =
  row, Σ rows = `totalMinutes` = Σ `dayMinutes`.

### The table view on screen (`TableView`, `PeriodNavigator`, `PeriodDateField`, `PeriodSwitch`)

- **Never replaced.** The card's heading (the period's label: a week as `weekRange`, "16.11.2026 – 22.11.2026"; a month as
  `formatMonth('2026-11')`, "November 2026"), the navigator, the date field and the period switch stay mounted through
  loading, empty, error and the deal-filter refusal, so focus and a half-typed date survive every read. Where each sits
  is the design's.
- **Days by date, not by column.** The weekday a column header shows and a cell's accessible name says comes from the
  date (`(getUTCDay() + 6) % 7`), never from the column's index: in a week they coincide, in a month that starts on a
  Sunday (November 2026) they do not. `longDay(day)` and `TableCellDialog` lose their index argument.
- **Cells.** A cell that holds hours is the Week's button (figure, `aria-haspopup="dialog"`, a name with the row, the
  day and the number of entries, `data-cell`) and opens the cell dialog. An empty cell, on any day and any row, has no
  button, no `data-cell`, no tab stop and no handler; a click on it does nothing (AC-5.32). `onRecordCell` and the
  `cell.record` copy go.
- **Navigator.** Previous, the return to the current period ("This week" / "This month") and Next, one group named for
  the period. Next `aria-disabled` and inert while `!hasNext` (AC-5.28); the return `aria-disabled` on the current period
  (unchanged); Previous `aria-disabled` while `!hasPrevious`. Each reports the period asked for; the page writes the
  address.
- **Date field.** A `Field` + `DateInput` (D18; no new library component), labelled for the period; `min` and `max` from
  `pickBounds` (`max` = today, AC-5.31). It shows `referenceDay(period, today)`, or what the person typed while it has
  focus. A complete day within [`min`, `max`] gives `holding(kind, day)`: another period is written to the address
  (AC-5.30); the period shown reads nothing. Anything else — an incomplete or emptied value, a day before `min`, a day
  after today — changes nothing and reads nothing; the field keeps the text until it loses focus, then shows the
  reference day again. What it shows is never reset by a re-render while it has focus (a controlled `type="date"` that
  writes a prop under a half-typed date loses the typing, R16). A period change by any other control shows the new
  period's reference day.
- **Period switch.** Week | Month (the design's words and control, MA2), `switchTo(period, kind, today)`.
- **States.** The "not started" state (`emptyFuture`) goes: no future period can be shown (AC-5.28, 5.29). The empty
  states are "no hours recorded" in the period's words, and with a filter set the List's "No entries match these
  filters" with Clear filters. Loading, error with Retry, the deal-filter refusal and the notes about names are the
  Week's.
- **Focus after a write** (the machinery is unchanged but for one branch): when a cell runs out of entries, the cell
  dialog closes and focus goes to the card's heading, since the empty cell is no control (`focusCell` → `false` →
  heading, a branch that exists for unreadable rows).
- **Scroll hint.** By period ("…all seven days" / "…every day of the month"), only with a grid; for the month it shows at
  every width where the grid scrolls — the breakpoint is the design's (R11).
- **Saved outside.** A save on a day outside the period shown says so in the period's words.
- **Announcement.** "<period label>: <spoken total> in total." for either period.

### Width

`HoursShell` renders `ToolLayout width="wide"` on every route and view — My hours in either view and period, Everyone's
hours, Settings, the not-found panel — so no switch of view, period or tab changes the column (AC-5.33, D16).

### Copy (en + `it: typeof en`; the words are the design's, MA2 — the keys, arguments and shape are the plan's)

`strings/week.ts` becomes `strings/table.ts`. The two period catalogs share one type, so a word the month lacks is a
compile error:

```ts
type PeriodWords = {
  title: (label: string) => string
  loading: string
  nav: { label: string; previous: string; current: string; next: string }
  pick: { label: string }                         // the date field
  empty: { title: string }
  savedOutside: (date: string) => string
  scrollHint: string
}
// strings.table.week: PeriodWords; strings.table.month: PeriodWords
```

| Key | Status | en (draft) | it (draft) |
|---|---|---|---|
| `table.view.label` / `.list` | kept (was `week.view.*`) | View of your hours / List | Vista delle tue ore / Elenco |
| `table.view.table` | new, replaces `week.view.week` | Table | Tabella |
| `table.period.label` / `.week` / `.month` | new | Period / Week / Month | Periodo / Settimana / Mese |
| `table.week.title(range)` | kept (was `week.title`) | Week {range} | Settimana {range} |
| `table.month.title(month)` | new | {month} ("November 2026", `formatMonth`) | {month} ("novembre 2026") |
| `table.week.nav.*` | kept; `thisWeek` → `current` | Choose a week / Previous week / This week / Next week | Scegli una settimana / Settimana precedente / Questa settimana / Settimana successiva |
| `table.month.nav.*` | new | Choose a month / Previous month / This month / Next month | Scegli un mese / Mese precedente / Questo mese / Mese successivo |
| `table.week.pick.label` / `table.month.pick.label` | new | Show the week of / Show the month of | Mostra la settimana del / Mostra il mese del |
| `table.week.loading` / `table.month.loading` | kept / new | Loading your week… / Loading your month… | Caricamento della tua settimana… / Caricamento del tuo mese… |
| `table.week.empty.title` / `table.month.empty.title` | kept / new | No hours recorded this week / No hours recorded this month | Nessuna ora registrata in questa settimana / Nessuna ora registrata in questo mese |
| `table.empty.body` | kept (was `week.empty.body`) | unchanged | unchanged |
| `table.week.savedOutside(date)` / `table.month.savedOutside(date)` | kept / new | Entry saved. {date} is outside the week you are viewing. / Entry saved. {date} is outside the month you are viewing. | Registrazione salvata. Il {date} è fuori dalla settimana che stai guardando. / Registrazione salvata. Il {date} è fuori dal mese che stai guardando. |
| `table.week.scrollHint` / `table.month.scrollHint` | kept / new | Scroll sideways to see all seven days. / Scroll sideways to see every day of the month. | Scorri di lato per vedere tutti e sette i giorni. / Scorri di lato per vedere tutti i giorni del mese. |
| `table.weekday.*`, `table.today`, `table.grid.caption(label)`, `table.grid.total`, `table.cell.open(…)`, `table.cellDialog.*`, `table.announce(label, total)`, `table.announceEmpty(label)` | kept, moved; `caption` and `announce*` take the period's label | unchanged | unchanged |
| `week.cell.record(on, day)` | **removed** (AC-5.32) | — | — |
| `week.emptyFuture.title` / `.body` | **removed** (AC-5.28, 5.29) | — | — |

A native speaker reads the Italian before release (design § Copy's standing note).

### Data model

No change. No migration in any service.

### Test strategy (2026-11-19)

Levels as in § Test strategy. `*` new file; `(→ x)` renamed from `x` by decision 9. Unless a row names one period, its
component cases run for the week and the month (`describe.each(['week', 'month'])`), with today pinned
(`vi.setSystemTime`) and the boundary days among the vectors (Sunday 1 November 2026; the week Mon 30 Nov – Sun 6 Dec
2026; Tuesday 1 September 2026).

| AC | Level | Test (what fails if the AC is broken) |
|---|---|---|
| AC-5.1 (reversed) | component + e2e | `pages/MyHoursPage.table.test.tsx` (→ `.week`): `/hours` selects the table view and the week, heads the current week, reads Monday..Sunday of today's week (`whose=mine`, `limit=500`) and asks none of the List's reads; the List tab is there, not selected. e2e: `hours.spec.ts` "opens My hours from the user menu" lands on the table view's current week (its empty state) before switching to the List; F and G open `/hours` on the table view; A's "See in My hours" lands there |
| AC-5.2 | unit + component + e2e | `components/HoursFiltersState.address.test.ts`* (→ `.week`): every row of § The address, the legacy `?view=week&week=` included; `withList` / `withTable` round trips for a past week, a past month and the current month; component: each address opens its view and period with the matching read; e2e G: `goto` of `?view=list`, `?view=week&week=<a past day>`, `?view=month&month=<last month>` |
| AC-5.4 | unit + component | `readMyHoursAddress({}, today)` and `{ view: 'week' }` → the current week; component: the read's `from` / `to` are the Monday and Sunday of today's week, with today a Monday and today a Sunday |
| AC-5.5 (amended) | unit + component + e2e | `lib/tablePeriod.test.ts`*: `shift` ±1 for weeks (over a month and a year) and months (December → January, January → December, 31 → 30 → 28 / 29 days); `hasNext` true only before the current period; `hasPrevious` false at the floor; `components/PeriodNavigator.test.tsx` (→ `WeekNavigator`): for each period Previous, the return and Next report the shifted or current period, the return is `aria-disabled` on the current one; e2e F: Previous, then the return |
| AC-5.13 (amended) | component + e2e | `pages/MyHoursPage.cells.test.tsx` (→ `.weekCells`): Add hours in a cell's list opens the entry dialog with that day and that row set, both still changeable; a save after changing both posts the changed values, not the cell's; for a week cell and a month cell; e2e F: Add hours in a cell's list records and the figures follow |
| AC-5.22 (amended) | unit + component | `MyHoursPage.table.test.tsx`: category, work type, recorded on (address) and the picked project and deal survive List → week → month → week → List, every read carrying them, the List's `period` untouched throughout; `clearFilterSearch` in the month keeps `view` and `month` (unit) |
| AC-5.24 (amended) | unit + component | `lib/tableGrid.test.ts` (→ `weekGrid`): `preset: null` for an unreadable row and a retired category; `components/TableCellDialog.test.tsx` (→ `WeekCellDialog`) and `MyHoursPage.cells.test.tsx`: those rows' cell lists have no Add hours, Edit and Delete stay, in both periods |
| AC-5.25 | unit + component + e2e | `lib/month.test.ts`*: `monthDays` of February 2026 (28), February 2028 (29), November 2026 (30), December 2026 (31), first the 1st, last the last; `tableGrid` over a month: entries on the 1st and the last day land, one on the next month's 1st throws; `components/TableView.test.tsx` (→ `WeekView`): a month draws the row-label column, one column per day and Total; e2e G: the month shown has that many day columns |
| AC-5.26 | unit + component + e2e | `switchTo(week, 'month')` for a week inside one month, for the current week Mon 30 Nov – Sun 6 Dec 2026 with today 2 December (→ December, D25) and for that week as a past week, today 9 December (→ November); page: the switch writes `view=month` (and `month` unless current) and reads that month's span; e2e G from the current week, expectation computed with the same rule |
| AC-5.27 | unit + component + e2e | `switchTo(month, 'week', today, left)` (D26): the week left when it has a day in the month (Mon 12 – Sun 18 Oct 2026 → October → back to 12 Oct; Mon 28 Sep – Sun 4 Oct → October → back to it); else the current week when it has a day in the month (the current month; the month before when the current week reaches into it, today Sunday 1 November 2026: October → the week of Monday 26 October); else the first week whose Monday is in the month (November 2026 → Monday 2 November; September 2026 → Monday 7 September); the address keeps `week` while the month shows; page: the round trip week → month → week lands on the week left, past weeks included; e2e G as AC-5.26 |
| AC-5.28 | unit + component + e2e | `hasNext(current) === false` in both periods; `PeriodNavigator`: Next `aria-disabled="true"` on the current week and month and a press reports nothing (page: address and read unchanged); Next pressed on the period before keeps the focus on Next, now `aria-disabled`; e2e F (week) and G (month) |
| AC-5.29 | unit + component + e2e | `readWeekParam`: next week, a day of next week, `9999-12-20` → the current week; `readMonthParam`: next month, `9999-12` → the current month; page: `/hours?week=<next Monday>` reads the current week and its Next is `aria-disabled`; e2e G: both addresses |
| AC-5.30 | unit + component + e2e | `holding('week' \| 'month', day)`; `components/PeriodDateField.test.tsx`*: a complete day of another period reports `holding(kind, day)`, a day of the period shown reports nothing; page: address and read follow, week and month; e2e G: a day of last month picked in each period; a day typed key by key in Chromium (`pressSequentially`) lands on its period (R16) |
| AC-5.31 | unit + component + e2e | `pickBounds`: `max` = today, `min` `2000-01-03` / `2000-01-01`; `PeriodDateField`: the `max` attribute is today; tomorrow, a day before `min` and an emptied value report nothing, and on blur the field shows the reference day again; e2e G: `max` = today |
| AC-5.32 | component + e2e | `TableView.test.tsx`, both periods: an empty cell today, earlier and later, on a readable, an unreadable and a retired row: no button, no `data-cell`, no tab stop; a click on its `td` calls nothing; page: the click opens no dialog and sends no request; e2e F and G: a click on an empty past cell opens no dialog |
| AC-5.33 | unit + e2e | `components/HoursShell.width.test.tsx`: `tool-width-wide` on `/hours`, `?view=list`, `?view=month`, `/all`, `/settings`, and through view and period switches without a remount; e2e G, as an admin (holder of both permissions, so the real pages are measured) at 1440 px: the tool container (`.tool-main` in `hours-shell`) and the page's own root where it has one (`hours-my-page`, `hours-everyone-page`) have one width in px on the List, the week, the month, Everyone's hours and Settings |
| AC-5.34 | component + e2e | `TableView.test.tsx`: the month table is inside `DataTable`'s focusable, labelled scroll region with every day's column; e2e G at 1280 px: the region's `scrollWidth > clientWidth`, `document.documentElement.scrollWidth <= innerWidth`, the region scrolled to its end shows the last day's header, and the tool container's width equals the week's |
| AC-4.6 (the new and moved copy) | unit + component | `strings.test.ts`: `AREAS` holds `table` (not `week`), parity (`catalogGaps`) over `table.week` and `table.month` (one `PeriodWords` type, so a missing month word does not compile); `noHardcodedStrings.test.ts` over the new components; `TableView.it.test.tsx`, `PeriodNavigator` and `PeriodDateField` with `<html lang="it">`: the month's heading (`formatMonth`, "novembre 2026"), "Mese precedente" / "Questo mese" / "Mese successivo", the date field's label and the month's empty, saved-outside and scroll-hint sentences in Italian, no English |
| AC-5.3, 5.6–5.11, 5.14–5.21, 5.23 in the month (D15) | unit + component | `tableGrid.test.ts` vectors over a 30- and a 31-day month (rows, order, cells, a meeting on its own row, the Σ invariants); `TableView.test.tsx` and `TableView.it.test.tsx` run their row, cell, totals, names and AC-5.11 cases for both periods (AC-5.11: a 160 h month and a 1 h month, one markup); a month cell's button and dialog name the date's weekday (1 November 2026 → Sunday); `MyHoursPage.cells.test.tsx`: Edit, Delete and Add hours from a month cell re-read the month (AC-5.15–5.20); `pages/MyHoursPage.month.test.tsx`*: the filters are in the month's read (5.21), Record hours on a target new to the month adds its row (5.19), the deal-filter refusal replaces the month's grid; AC-5.14 in either period is AC-5.32's "later day" case (a future cell is always empty). AC-5.3 is the week's and keeps its tests |

**Existing tests that change**, each for a named reason (the rest move with decision 9's renames, assertions intact):

- *The List is no longer the default (AC-5.1 reversed).* The `renderPage` / `setup` default path of `MyHoursPage.test.tsx`,
  `.entries`, `.edit`, `.record`, `.export`, `.it`, `.edit.it` — and any other test that mounts `/hours` for the List —
  becomes `/hours?view=list`, and each explicit List path (`/hours?period=…`) gains
  `view=list`; their assertions do not change. `MyHoursPage.week.test.tsx`: "`/hours` opens on the List as before" is
  reversed, "the List reads what it read before" moves to `?view=list`, "choosing Week writes `?view=week` … choosing
  List takes it out" becomes "List writes `view=list`, the table takes it out". `HoursFiltersState.week.test.ts`:
  `readView` ("no view: the List", "anything else is the List") and `withView` ("the List leaves view out") are reversed.
  `ViewSwitch.test.tsx`: the tabs are the table view and List. `router.test.tsx` and `HoursShell.test.tsx` mount
  `/hours`: their assertions (frame, headings, tabs) hold, since their `apiFetch` stub answers nothing for the table's
  read as it answered nothing for the List's.
- *Width (AC-5.33).* `HoursShell.width.test.tsx`: "the default width on the List", "`?view=anything-else` is the List"
  (it uses `?view=month`, now the month) and "stays the default width on Everyone's hours and Settings" are reversed;
  `MyHoursPage.week.test.tsx` "is wide on the Week and the default width on the List".
- *The empty-cell plus (AC-5.12 withdrawn, AC-5.32).* `WeekView.test.tsx`: "makes an empty cell … a plus button", "calls
  back … when an empty cell is pressed", "offers nothing on a day after today … the first day without", "offers nothing at
  all in a week that has not started, and an empty cell everywhere in a week long past", "offers no recording on a row whose
  name …", "… on a retired category", and the record half of "offers a button only for the handler the page gave";
  `WeekView.it.test.tsx` "names the cell buttons …" (the record name); `MyHoursPage.weekCells.test.tsx`: the describe "an
  empty cell of today or an earlier day records (AC-5.12, G7)" goes; "the day and the target stay changeable (AC-5.13)",
  "the figures follow a save" and the "outside the week" case that records from a cell move to Add hours; "focus after a
  save" loses its empty-cell cases; "a week that is over offers every empty day …" and "cells that offer no recording stay
  without it on the page" go (AC-5.32 covers them); "moving the only entry of a cell …" and "deleting the last entry of a
  cell …" now expect the card's heading, not "the cell, now empty".
- *Next into the future and "not started" (AC-5.5, 5.28, 5.29).* `WeekNavigator.test.tsx` "offers Next week in a week that
  has not started"; `WeekView.test.tsx` "says the week has not started …", "counts the week that holds today as started …"
  and the navigator case that presses Next from the current week; `WeekView.it.test.tsx` "words … the week that has not
  started …"; `MyHoursPage.week.test.tsx` "Next week reads the week after, and a week that has not started is drawn as
  such"; `MyHoursPage.weekCells.test.tsx` "a week that has not started has no grid …"; `week.test.ts` `readWeekParam`
  cases that name a future week (`2026-11-25` and `2027-01-01` in "is the Monday of the week holding the day it names",
  "ignores the other keys", `9999-12-26 → 9999-12-20`) now expect the current week.
- *e2e.* `hours-in-place.spec.ts` A: after "See in My hours" (`/hours`) the table view's current week shows 2 h 30 in today's
  cell on the project's row, then the List shows the entry row as before (AC-4.1). F: rewritten as below.
  `hours-in-place.round1.spec.ts` R3: the List part opens `/hours?view=list` (its Week part may keep `?view=week`, the
  legacy address). `hours.spec.ts`: "opens My hours from the user menu …" asserts the table view on `/hours` and switches to
  the List before its day-heading and Totals assertions; the copy test (D-2, D-3) opens `/hours?view=list` before Period and
  Custom. `hours-owners.spec.ts`: `openDialogOn` and the two `goto('/hours')` before `hours-day-total-*` and Group by open
  `/hours?view=list`. The other time-tracking journeys reach My hours only to use Record hours in the header, which both
  views have.

**e2e journeys (2026-11-19).**
- F (rewritten). The table view, week, on the real stack: `/hours` opens on it (AC-5.1); the List through the switch and
  back; last week by Previous: the same cells, rows, order and totals as today's F; a click on an empty past cell opens
  nothing (AC-5.32); Add hours in a cell's list records with day and row set and changeable, figures follow (AC-5.13,
  5.18, 5.20); Edit and Delete from a cell's list as today (AC-5.16, 5.17); deleting a cell's last entry leaves the cell
  blank, closes the dialog and puts focus on the card's heading; Record hours in the header on a target new to the week
  adds its row (AC-5.19); on the current week Next is `aria-disabled` (AC-5.28).
- G (new). Addresses, month, date field, width: one person with entries on two projects on a day of last month and one
  today. `/hours?view=list`, `?view=week&week=<a past day>`, `?view=month&month=<last month>`, `?week=<next Monday>`,
  `?view=month&month=<next month>` (AC-5.2, 5.29); from the current week, Month → the month of its Monday, with that many
  day columns and Next `aria-disabled` (AC-5.25, 5.26, 5.28); Previous to last month: the two entries in their cells and
  totals; Week → the week the rule gives (AC-5.27); the date field's `max` is today and a day of last month picked in each
  period shows its week or month, also typed key by key (AC-5.30, 5.31, R16); a click on an empty cell opens nothing
  (AC-5.32); as an admin, one width of the tool container and of each page's root on List, week, month, `/hours/all`
  and `/hours/settings` (AC-5.33); at 1280 px the month
  scrolls inside its region and the page does not (AC-5.34); the month's first grid time is logged (R13). Every expected
  period is computed in the test with the same rules, never hardcoded (R21).

### Risks (2026-11-19)

| Risk | Mitigation | Early check |
|---|---|---|
| R11 The month is wide: about 2,000 px with compact day headers and about 2,800 px with `formatDate` headers (31 × the ~88 px measured on the week, plus label and Total), so it scrolls on almost every screen — wider than the "~1500 px" the ledger assumed (D23) — and a row's name scrolls away from its cells | The design picks a compact month header; a cell keeps its full accessible name (row and date), so a scrolled cell still says what it is; a sticky row-label column is the design's option, R12 | the design measures a 31-day month of 10 rows at 1280, 1440 and 1920 px before tasks; e2e G asserts AC-5.34 at 1280 |
| R12 A sticky first column, or a compact date formatter, is a change to `@operai/ui` (`DataTable` has no sticky column; the library writes dates as dd.mm.yyyy) | **The design asked and the user accepted (D27):** the optional `DataTableColumn.pin` prop, with a story and a test, in the shell before hours-ui uses it (ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell; plan R4); no date formatter (the design's month header uses `formatNumber`) | its own task, before the month; a real-browser e2e proves a focused cell is never hidden under a pinned column |
| R13 The month's read is bigger: up to 31 days, maybe several pages, each page's names asked of projects-api, crm-api, meetings-api and activities-api as the person | A bounded span (the ADR's rule); the walk the List's Export already runs for its default period, This month; aborted on every change | e2e G logs the month's first-grid time; an early run with 300 own entries in one past month reports above 800 ms, not fails (time tracking's R2 posture) |
| R14 Address back-compat: bookmarks of `?view=week&week=`, old List links (`/hours?period=…`), the hosts' fallbacks and "See in My hours" (`/hours`) | `view=week` is read as before; an old List link opens the table on the current week with its `period` kept, one click from the List; `/hours` is the current week, which holds an entry recorded today from a page (one recorded on an earlier day is a Previous or the List away; accepted, the link stays a fixed path, ADR 20261116-record-hours-widget-through-the-host-extension-seam) | the address test's legacy rows; e2e F opens `?view=week`; e2e A follows the link |
| R15 The reversed default breaks time tracking's e2e (`hours.spec.ts`, `hours-owners.spec.ts`), two journeys of this feature and seven hours-ui page suites, which open `/hours` and expect the List | Named above; changed in the same task as the reversal | run `hours.spec.ts`, `hours-owners.spec.ts`, `hours-in-place*.spec.ts` and the hours-ui suite right after the default flips, before any month work |
| R16 A native date input typed key by key passes through valid intermediate days (the year 0002, 0020, 0202, 2026), and a controlled value re-rendered under a half-typed date wipes the typing | Only a complete day in [`min`, today] navigates; the field holds its own text while focused; an intermediate in-range day's walk is aborted by the next (`useHoursQuery`) | `PeriodDateField.test.tsx`; e2e G types a date key by key in Chromium and lands on its period with no error |
| R17 The Week names a day by its column's position, which is wrong in a month that does not start on a Monday | The weekday from the date (one function), the index arguments removed | `TableView` and `TableCellDialog` tests on November 2026 (1 November is a Sunday) |
| R18 Next turns unavailable under the keyboard when it reaches the current period | `aria-disabled`, not `disabled` (decision 12) | `PeriodNavigator.test.tsx`: focus stays on Next |
| R19 The renames touch many files at once | A first step that only renames: every test green, no assertion changed but names | that task's done-when: the same number of tests passing before and after |
| R20 Full width on Settings and Everyone's hours (D16's accepted cost): long lines on very wide screens | Accepted by the user; the design may cap a form's own width with layout utilities | a design screenshot at 1920 |
| R21 e2e that depend on today: a run on a Monday, a Sunday or the 1st changes which weeks straddle months | Expected periods computed in the test with the same rules, never hardcoded; unit tests pin today on the boundary days | G green on any day |

R6 (the table's browser sums and the List's server totals read at different moments) holds unchanged for the month.

### Security (2026-11-19)

**Security-sensitive: YES**, as before — personal data about workers (hours), and a write path offered on other tools'
pages. **This amendment changes no surface:** no route, permission, scope, credential, origin, storage or data flow is
added, and one write entry point goes (the empty cell no longer records).
- **A01.** The table reads `whose=mine` only, for 7 to 31 days; no `userId`, no oversight path. Add hours, Edit and
  Delete are the List's, decided by hours-api as before.
- **Input to the API.** `view`, `week`, `month` and the date field's value reach hours-api only as `from` / `to` built by
  `tablePeriod.ts` from a checked day or month (strict pattern, a real calendar day, the floor, the clamp to today);
  anything else falls back to the current period, so a pasted link never makes a refused, unbounded or future request.
- **The address** carries a day, a month and the existing filter ids — no name, note or person.
- **XSS.** Names as React text (unchanged); the month's label from `formatMonth`.
- **Memory.** A month of one person's own entries held for the screen only, as the week's.

What the owasp delta pass checks: `readMyHoursAddress` and `readMonthParam` never put an unchecked value in a request;
`whose=mine` on every table read; the date field cannot send a day after today or before the floor. No escalation to the
frontier tier: no regulated data beyond what the List already shows.

### What the design decides (design.md is amended after this plan)

The words for the table view, its periods and the date field (MA2); the period switch's control (`Tabs`, a radio group
or a select — an existing library component) and where the switch, the navigator and the date field sit in the
never-replaced part; the order of the two view tabs; the month's compact day header and how today is marked across 31
columns; whether the month gets a sticky row-label column (R12); the scroll hint's breakpoint per period; whether an empty
cell is blank or carries a non-interactive mark. design.md text that this plan supersedes: S6 (default view, width), S7
(empty cells, Next, "not started"), F3, F4 (withdrawn), F5 step 5 (focus to the heading), S9 (from Add hours only), § Copy,
§ Accessibility (empty cells, Next), § AC coverage.

### Order of change (for `/wellforge:tasks`; each step green on its own)

1. The renames of decision 9, nothing else.
2. `tablePeriod.ts` with the week only; `tableGrid(entries, days)`; `TableView` and the page on a `TablePeriod` — no
   behaviour change.
3. The address, the reversed default and the `wide` column, with every List test and time-tracking e2e of R15.
4. Empty cells inert, Next and Previous availability, the future clamp, "not started" removed, focus to the heading.
5. The month: `month.ts`, `switchTo`, the period switch, the month's copy. (R12's library addition — the `pin` prop, D27
   — before this step, in its own task; the shell deploys it before hours-ui.)
6. The date field.
7. e2e A, F and G; AGENTS.md, infra/README.md, the pending changeset; ADR R3.

## ADR candidates

- **R1 (written 2026-11-16) — A view may sum its own figures in the browser only over a complete, all-or-nothing read of a bounded
  span.** The Week view of My hours folds one person's week, read in full by the export's walk; a partial
  read is an error, never a grid. Narrows the time-tracking design convention "No figure on screen is computed
  in the browser" for this view. *Rejected:* a two-dimension totals grouping or a week route in hours-ui's
  API; server day totals beside browser cells; sums over the loaded pages.
  → `docs/adr/20261116-week-view-sums-a-complete-read-in-the-browser.md`
- **R2 (written 2026-11-16) — Recording hours on another tool's page is hours-ui's own widget through the shell's `HostExtension`,
  plain strings in and nothing back.** The host decides only whether to show it; the widget owns the dialog,
  the write and its message; the host's fallback is a link to My hours. *Rejected:* a copy of the dialog per
  host; `EntryDialog` in `@operai/ui`; a prefilled link into My hours; a host callback or a shell toast API.
  → `docs/adr/20261116-record-hours-widget-through-the-host-extension-seam.md`
- **R3 (new 2026-11-19) — amend R1: the table view's month is summed in the browser over one complete read, as the week
  is.** The bounded span of ADR 20261116-week-view-sums-a-complete-read-in-the-browser becomes "one calendar week or one
  calendar month (at most 31 days) of one person's own entries"; its narrowing of the time-tracking convention "No figure
  on screen is computed in the browser" moves from "the Week view" to "the table view, in either period"; the rule itself
  (complete, all-or-nothing, bounded) is unchanged. *Rejected:* a server month grid — a two-dimension `groupBy` or a
  month route, the ADR's Option B with 31 columns on the contract and the entries still needed for the cell's list; the
  month assembled from its weeks' reads — several reads at different moments on one screen (the ADR's "two sources"
  failure shape) and a partial month when one week fails; the month's day and row totals from `groupBy=day` /
  `groupBy=project` with cells summed in the browser — two sources; a cap on the month's entries — a partial read,
  which the rule forbids. Revisit when a longer period (a quarter, a year) is asked of the table view, or when a month's
  walk is measurably slow (R13).
  → amendment in place: `docs/adr/20261116-week-view-sums-a-complete-read-in-the-browser.md` § Amendment 2026-11-19
  (status "Accepted, amended 2026-11-19"); the AGENTS.md index line and the hours-ui paragraph follow it.

Considered and not candidates: the address shape (one page's address, decision 10 — a plan note, as Decision 5 was);
one width for every hours page (D16, the user's choice for this tool, not a suite rule: the CRM keeps a width per route);
Next stopping at the current period (D24, a product rule with no architectural alternative).
