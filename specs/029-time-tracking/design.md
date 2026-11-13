---
spec: 029
status: draft
---

# Design: Time tracking — the hours employees spend on company work

Inputs read: `spec.md` (approved, 44 ACs, amended 2026-11-12: AC-3.1, 3.3, 4.6, 4.9, 4.10, new 4.11; 2026-11-13: AC-2.2, 2.3, new 2.12),
`plan.md` (approved, amended after the first design), `ledger.md` D1–D45, glossary § Time tracking,
ADR-0088/0089/0090, `operai-ui/docs/{building-pages,design-system,decisions}.md`, `operai-ui/src/index.ts` and
the page stories, and the precedents named below (read as code; no dev server was running, so nothing was
inspected in a browser). Re-synced on 2026-11-12 with the amended spec and plan (D38–D45); the first draft's
gaps 1–7 and 9 are closed by them (§ Gaps).

Surfaces: **three pages** — *My hours* and *Everyone's hours* in the new remote `hours-ui` (`/hours`),
*Time lists* in `admin-ui` (`/time-lists`) — **three dialogs** (entry, delete confirmation, list-item form)
and **one menu link** in the shell. Page types from `operai-ui/src/pages`: My hours = *Item list* + *Quick
create in a dialog* + *Deletion flow*; Everyone's hours = *Item list* (read-only table); Time lists = three
cards of *Item list* with *Quick create* (the admin-ui `MileageRatesPage` shape, ADR-0023).

Conventions that hold on every screen (not repeated below): all copy is an `en` catalog plus a complete
`it: typeof en` through `selectStrings`, sentence case, parity + hardcoded-copy tests (AC-5.5); durations
only through `formatDuration(minutes * 60_000, { style: 'short' })` → "2 h 30" / "30 min" (AC-4.9) and, where
a screen reader reads the figure, `style: 'spoken'`; months only through `formatMonth`; dates only through
`formatDate` (dd.mm.yyyy) and `formatDateLong`; colour only as token utilities; statuses only through
`StatusBadge`; icons only through `Icon`. "Today" is the calendar day in `Europe/Zurich` (the plan's
`future_day` rule), computed by a small `todayZurich()` in `hours-ui/src/lib`; the server stays the
authority. Weeks start on Monday. **No figure on screen is computed in the browser**: every total, day total
and group comes from `GET /time-entries/totals` (plan § Totals); the client never sums a page. A name a
viewer may not read is never shown, in the DOM or in the file, and no screen displays an entity id.

---

## Flows

Eight flows. The error codes are the plan's `code` values; the surface for each is in *Error surfaces*
under S2.

### F1 Record hours — US-1, US-2, AC-1.1–1.4, 1.7, 1.8, 2.1–2.5, 2.7, 2.8, 2.10, 2.11, 3.4–3.6

Entry point: **Record hours** (the one primary on My hours).

1. The `FormDialog` (S2) opens on the **Day** field, Day = today, nothing else chosen.
2. The person chooses **Duration** (30 min … 24 h in 30-minute steps), then **What was it on**:
   Project, Deal, Meeting or Other work. The fields that apply to that choice appear (matrix in S2).
3. Project / deal / meeting: the person types in the entity field; matches come from what the person
   can already search (projects-api `GET /projects?q=`, crm-api `GET /deals?q=`, meetings-api
   `GET /meetings?q=`, the person's own meetings). The person picks one; for project and deal the
   optional **Work type** and **Activity** fields fill from the pick (S2; the activities are read by the
   browser from activities-api, not through hours-api).
4. Other work: the person chooses a **Category**; a category that requires a note makes **Note** required.
5. Save. Success exit: dialog closes, focus returns to **Record hours**, My hours reloads list and totals,
   a compact success banner confirms (and says so when the saved day is outside the period shown).
6. Error exits (dialog stays open, every value kept): field errors for shape rules; the picker error for
   `not_on_project` / `not_involved_in_deal` / a vanished target; a fail-closed error for `host_unavailable`
   (nothing was saved; Save again retries). A `401` is the library `apiFetch` redirect.

Overlap is never an error: 2 h on one thing and the same 2 h on another are two entries, each counted in
full (AC-1.4); the page says so once (S1 description).

### F2 Change an entry — AC-1.5, 1.6, 2.2–2.4, 3.4, 4.10

Entry point: **Edit** on a row of My hours (own entries only; Everyone's hours has no write control,
AC-1.6).

1. The same dialog opens as "Edit entry" with every value filled. When the person can no longer read the
   project, deal or meeting the entry is on (`on.visibility` `hidden` — AC-4.10 applies to the author too,
   D43) the dialog opens in the **"not visible" variant** of S2: the target stays what it is, shown as
   "Not visible to you"; Day, Duration, Work type and Note can still be changed; the target (and with it
   the Activity) changes only if the person picks another one.
2. The request carries only the members the person changed (plan: `PATCH` takes any subset, `on` whole), so
   a note-only edit of an entry on a **retired** category is not refused (AC-3.4), and `on` is never sent
   for an entry whose target the person did not touch.
3. Success exit as F1. Error exits as F1, plus: a change that keeps the target is never checked against
   the team or the deal (AC-2.12, D46), so an entry on a project the person has left, or on a target they
   can no longer read, saves its day, duration, note and work type normally; `not_on_project` /
   `not_involved_in_deal` / `404` arrive only when the person **moves** the entry to another target, and
   are shown on the picker exactly as in F1 (the stored target is kept). A `404` on a save that kept the
   target means the entry itself is gone — the dialog says so and the list is reloaded when it closes.

### F3 Delete an entry — AC-1.5, 2.4

Entry point: the trash button on a row of My hours → `ConfirmDialog tone="danger"` (S3), focus on Cancel.
Success: row gone, totals and the day's total refreshed, focus to the page heading (the *Deletion flow* page
story), compact success banner. Error: stays open with the error inline. A `404` is treated as "already
gone": the dialog closes, the list reloads and an info banner says the entry no longer existed. Deletion has
no bookability check (plan), so it also works for an entry on a project the person has left or cannot read.

### F4 Review my hours — US-4, AC-4.1, 4.4, 4.5, 4.7–4.11, 1.4

Entry: **My hours** link in the shell menu (F8) → `/hours`.

1. Default period is **This month**. The person narrows by period, project, deal, category and work type
   (person is only in F6). Filters apply on change; stale answers are discarded. Each change asks three
   things: the entries (cursor-paged), the totals for the chosen *Group by*, and the day totals
   (`groupBy=day`, same filters).
2. **Totals** show the total for the match and the groups for the chosen *Group by* (project, deal,
   category, month), in the server's order. What the viewer may not read, or whose owner did not answer, is
   ONE merged row each (`hidden`, `unavailable`; for deal also `deal-unknown`), never one row per item.
   Meeting hours are counted under the meeting's deal (AC-4.5, AC-2.6).
3. **Entries** are listed by day, newest first, each day with its total **as the server states it** — so a day
   whose entries straddle two pages shows its full total at once — and nothing else: no "incomplete" mark, no
   reminder, no comparison with the contractual day (AC-4.1, D23).
4. A source that did not answer never hides an entry: names show as unavailable and a banner says which
   (AC-4.7). A name the person may not read shows as "Not visible to you", on their own entries too
   (AC-4.10). A person who changed their Operai name appears under the new name (AC-4.8, no client cache).
5. With a **deal filter** set, if Meetings cannot say which meetings belong to that deal, the whole filtered
   view is one error state with Try again — never an empty or partial list (AC-4.11; S1 § Deal filter
   unavailable). Without a deal filter the view degrades as step 4 says.

### F5 Export what the view shows — AC-4.6, 4.9, 4.10, 4.11

Entry: **Export** (`ExportButton`, NEW in `@operai/ui`) in the *Entries* card of both views; the button is
not rendered when the view has no entries. Click: the button is `aria-busy`, the entries of **every page** of
the current filters are fetched (`limit=500`), `exceljs` is imported lazily inside the button's `build`, the
file downloads. Exits: a polite status ("Preparing file…" → "File ready"); if any page reported an
unavailable source the file is still produced and the status says names are missing ("File ready. Some names
could not be loaded and are missing."); a failed page or build → the button's inline alert, nothing
downloaded, the button is usable again.

The file is the plan's § Export file: nine columns — Day, Person, **Hours**, On, Name, **Counts for deal**,
Category or work type, Activity, Note. Hours is a **number** (2 h 30 is 2.5, format `0.0`) so the file sums;
AC-4.9's "2 h 30" is the screen only (D39). **Counts for deal** is one column, filled for an entry on a deal
and for an entry on a meeting linked to a deal (D40), so Hours summed by Counts for deal equals the by-deal
totals. No ids are written. What the viewer cannot read is written as on screen, from the same catalog words
(table in S1 § Names the viewer cannot read), type kept, name withheld (AC-4.10). The file is named from the
view (`hours-<from>_<to>.xlsx`, ISO dates, never a person's name).

**Deal filter while Meetings is down.** The export's page request answers 503 `host_unavailable` — the same
error as the view (AC-4.11). The export does not show its own alert for it: the page switches to the deal
filter unavailable state of S1 (one surface, one wording), which also unmounts the Export button, so nothing
is downloaded and nothing partial is written.

### F6 Everyone's hours — US-4, US-5, AC-4.2–4.5, 4.7, 4.10, 4.11, 5.4, 1.6

Entry: the **Everyone's hours** tab (shown only to a holder of `time-entry:read-all`; a UX convenience, the
server is the gate — the estimai-ui `whose=all` rule, ADR-0075).

1. Same filters as F4 plus **Person**; same Totals and Entries, but the entries are a flat read-only table
   (no day totals, no row actions). The Person options are the `person` groups of
   `GET /time-entries/totals?whose=all&groupBy=person` with the view's other filters and **without** `userId`
   (S4).
2. Default *Group by* is **person**.
3. Denial and outage: a non-holder who reaches `/hours/all` (typed URL, revoked grant) gets the
   permission-denied panel (`read_all_required`); `auth` down is `authz_unavailable` (AC-5.4) with a retry,
   and a link back to My hours, which keeps working (ADR-0088).
4. A deal filter with Meetings unavailable is the same error state as F4 step 5 (AC-4.11); the Person options
   call carries the deal filter too, so it fails with the rest.

### F7 Manage the lists — US-3, AC-3.1–3.4, 3.7, 3.8

Entry: the **Time lists** tab of the Admin tool (visible only with `time-list:manage`, the `rate:read`
pattern in `SectionNav.tsx`). Reaching it also needs access to the Admin tool (AC-3.3 as amended, D41): a
role granted `time-list:manage` alone is stopped by Admin's own no-access screen, which already exists.

1. One load fills three cards: Categories, Project work types, Deal work types (retired ones included).
2. **Add** (per card) and **Rename** open a `FormDialog`; a category form also has "Entries in this category
   need a note". **Retire** and **Restore** are one click on the row and ask nothing (S5, decision below);
   an active row offers Rename + Retire, a retired row Rename + Restore (AC-3.1 as amended, D38). There is no
   Delete anywhere (AC-3.2).
3. Errors: duplicate name → field error (`name_taken`); `403 time_list_manage_required` → in the page the
   permission-denied panel, in a dialog an inline error; `503 authz_unavailable` → the authorization
   banner / inline error; nothing changes (S5 row-action states).

### F8 Reach the screen — US-5, AC-5.1, 5.3

The shell `UserMenu` gets **My hours** after **My meetings** → `/hours/$`, an ungated child of
`shellRoute`, no `beforeLoad`, not in `TOOLS`. A user with zero grants reaches it. No session → the
existing `_authed` redirect. A remote that fails to load shows the existing `RemoteMount` in-place error.

---

## Screens & states

### Frame of `hours-ui` — `HoursShell`

`ToolLayout` (title "Hours" / "Ore", width `default`, no `<main>`), the `MyMeetingsShell` shape. `nav` is a
`TabNav` with two links, **My hours** (`/`) and **Everyone's hours** (`/all`), **only for a holder**; for
everyone else there is no TabNav at all (one tab is noise; the `MyDevices` precedent). The holder test is
`usePermissions().permissions.some(p => p.resource === 'time-entry' && p.action === 'read-all')`
(`/authz/me` lists every effective permission, so a catalog without `access` is included), and the tab stays
**out of the DOM** until permissions have resolved (the estimai-ui "permissions loaded" test). Inner router,
basepath `/hours`: `/`, `/all`, and a not-found route (`StatePanel` + back link). Filters live in URL search
params (`period`, `from`, `to`, `person`, `category`, `workType`, `group`; estimai-ui precedent); the chosen
project and deal live in memory, because a pick needs its label and the URL does not carry one (so the deal
filter, and with it the AC-4.11 state, is never present on first load).

### S1 My hours — `/hours`

Purpose: record, review, change and delete my own hours; see my totals.

```
Hours                                   (h1, ToolLayout)  [My hours | Everyone's hours]  ← tabs only for holders
My hours                                (h2)                                   [Record hours]  (primary)
Time worked on two things at once counts in full on each, so a day can add up to more than a working day.
[ compact success / info banner — above the first card ]
[ info banner: "Hours are complete; these names could not be loaded: …" ]            (only when unavailable[])
[ info note: "Some of your entries are on a project, deal or meeting you can't open …" ]  (only when something is hidden)
┌ Filters ─────────────────────────────────────────────────────── [Clear filters] ┐
│ Period ▾   (From / To when Custom)   Project ▸ type to search   Deal ▸ type…      │
│ Category ▾                           Work type ▾ (Project work types / Deal work types) │
└──────────────────────────────────────────────────────────────────────────────────┘
┌ Totals ──────────────────────────────────────────────────────────────────────────┐
│ Total   84 h 30                                        Group by ▾ (Project…)      │
│ DataTable: <group name> | Time                                                    │
│   Project Alpha                       40 h                                        │
│   Projects not visible to you         12 h                                        │
│   Not on a project                    32 h 30                                     │
└──────────────────────────────────────────────────────────────────────────────────┘
┌ Entries ─────────────────────────────────────────────────────────────── [Export] ┐
│ 12 November 2026                                  Day total 8 h 30  (groupBy=day) │
│  [Project] Project Alpha                       4 h      [Edit] [Delete: icon button] │
│  Development · Activity: Write the offer                                          │
│  [Project] Not visible to you                  2 h      [Edit] [Delete: icon button] │
│  Development                                                                      │
│  [Meeting] Kick-off call                       2 h 30   [Edit] [Delete: icon button] │
│  Counts for deal Acme renewal · Note text …                                       │
│  …                                                       [Load more]              │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Key elements and rules

- **Period** (`select`): This week, Last week, This month (default), Last month, This year, Custom range.
  Custom shows two `DateInput`s From / To. Validation: To ≥ From; at most 366 days (the plan's span rule) —
  field errors, no request while invalid.
- **Project / Deal** filters use `SearchPicker` (NEW, see inventory). **Category** lists every category
  including retired ones (suffixed "(retired)"); **Work type** is one select with two `optgroup`s
  (project list, deal list) because the two lists repeat names ("Analysis") but have different ids. Both
  come from the single `GET /time-lists?includeRetired=true` the page also gives the entry dialog.
- **Clear filters** (`ghost` `sm`, in the Filters card `action`) appears only when something differs from
  the defaults.
- **Totals**: `FactList` with one fact (Total = `totalMinutes`), `Field` + `select` "Group by" (Project, Deal,
  Category, Month; Person is Everyone's only; Day is never offered — it feeds the day headings), then a
  `DataTable` (caption names the grouping; group name is the `rowHeader`; Time is the `numeric` column). Rows
  are the server's, in the server's order (plan § Totals), never client-sorted:
  - project / deal: the `keyed` groups (`label`, minutes desc), then the merged rows in this order —
    `hidden` "Projects / Deals not visible to you", `unavailable` "Projects / Deals whose name is
    unavailable", for deal `deal-unknown` "Meetings whose deal is unknown right now", then `none` "Not on a
    project" / "Not on a deal". A merged row is ONE row however many items it holds, and is absent when
    empty.
  - category: `keyed` by minutes (retired ones suffixed), then `none` "On a project, deal or meeting".
  - month: newest first, the label is `formatMonth(key)` ("November 2026" / "novembre 2026").
  - person (Everyone's): by name, `status: unknown` → "Unknown user", `deleted` → "<name> (deactivated)".
- **Entries**: one `section` per day with an `h4` (`formatDateLong`) and the day total (`font-mono`) taken
  from the `groupBy=day` answer for that day's key, then a `ListRows` whose rows are
  `div.list-row.is-interactive` (the documented "row with actions" form). Row: type `Badge` (neutral: Project
  / Deal / Meeting / Other work) + the name (a plain `.link` anchor to the API's `href` — the suite-path
  precedent in `projects-ui/.../MyTasksPageRow.tsx`; **not a link, and not a name, when the viewer cannot read
  it**, § Names the viewer cannot read), duration on the right in `font-mono`, then meta lines: `work type`
  or `category` (retired ones suffixed), `Activity: <subject>` (the view carries no activity type; deleted →
  nothing, AC-2.9), a meeting's "Counts for deal <name>" (AC-2.6) and the full note. Actions: **Edit**
  (`secondary` `sm`, `aria-label` names the entry) and **Delete** (`danger` `sm` `iconOnly` trash,
  `aria-label` names the entry) — the *Deletion flow* story. The day total covers the entries that match the
  filters, as the list does.
- **Paging**: the list is a cursor endpoint → `LoadMore`. The day total never depends on how many pages have
  loaded.
- A person's entries on one day that exceed 8 h 24 are shown as any other: no tint, no icon, no text (D23).

States (exactly one per region; Filters and the header are always shown)

| Region | Loading | Empty | Error / partial |
|---|---|---|---|
| Totals | `SkeletonRows` + `VisuallyHidden live` "Loading totals…" | `totalMinutes` 0: Total "0 min" and the line "Nothing to total." in the card | `Banner tone="warning"` + Retry inside the card (a failed totals call never blocks the list) — except the AC-4.11 case below |
| Day totals | the day heading's total slot is empty (no placeholder figure, no client sum) | — | one compact `Banner tone="warning"` + Retry at the top of the Entries card, "Day totals could not be loaded."; the list stays, headings show without a total |
| Entries | `SkeletonRows` + `VisuallyHidden live` "Loading your hours…" | no filters: `StatePanel` "No hours recorded in this period" / "Record the hours you worked and they appear here, by day." (no action: the header has it). Filters active: `StatePanel` "No entries match these filters" + `Button ghost` "Clear filters" | `Banner tone="warning"` + Retry; a failed "Load more" is `LoadMore`'s own `error` and keeps the pages already shown |
| Source down (`unavailable[]`) | — | — | one persistent `Banner tone="info" live="polite"` under the header naming the sources in words — people's names (`identities`), project names (`projects`), deal names (`crm`), activity subjects (`activities`), meeting titles (`meetings`), the deal that meeting hours count for (`meeting-deals`): "Hours are complete; these names could not be loaded and show as unavailable." Grouping by **Deal** with `meeting-deals` unavailable adds `tone="warning" live="polite"` "Meeting hours can't be placed under their deal right now, so they are shown in one separate row. The total is unchanged." |
| Names not visible (AC-4.10) | — | — | a persistent `Banner tone="info" live="off"` with an `aria-label`, shown whenever any loaded entry, group, deal or activity is `hidden`: "Some entries are on a project, deal or meeting you can't open, so they show without a name. Their hours are still counted." |
| Deal filter unavailable (AC-4.11) | as Totals / Entries | — | the rule below: ONE banner replaces Totals and Entries |
| Lists (`/time-lists`) | Category / Work type selects disabled "Loading…" | — | warning `Banner` + Retry; the selects stay disabled; project/deal/meeting entries can still be recorded (S2) |
| Whole page | the shell's `RemoteMount` loading | — | the shell's `RemoteMount` error with Retry |

**Deal filter unavailable (AC-4.11, D45) — S1 and S4.** Applies only while a deal filter is set.

- *Trigger.* Any of the view's reads — entries first page, the chosen totals, the day totals (S1), the Person
  options (S4) — answers `503 host_unavailable` (Meetings cannot say which meetings are linked to the deal),
  or the export's walk does (F5). Without a deal filter these reads do not fail this way; they degrade.
- *Surface.* The Filters card stays. Totals and Entries are **replaced by one** `Banner tone="warning"` (its
  default `role="alert"`) titled "Hours on this deal can't be shown right now": "Operai could not check which
  meetings belong to this deal, so a list or total would be incomplete. Nothing is shown until it can. Try
  again in a moment." Actions: **Retry** (`onRetry`) and a `ghost` `sm` "Clear the deal filter" (`actions`).
  The source-down and names-not-visible banners are not shown (there is no data). Record hours stays active.
- *Never.* Not the empty `StatePanel` ("No entries match"), not "0 min", not a list or totals left over from
  before the filter was set (they are discarded when the filter changes), not a partial list. The one
  exception is a failed **Load more** after a first page that did arrive: those pages were complete when read
  and stay, with `LoadMore`'s own error and retry.
- *Announcement and focus.* The alert is announced when it appears; focus is **not** moved by it (the person is
  in the Filters card, having just picked the deal or changed another filter). Retry: the two regions show
  their loading state (polite "Loading…"); on success focus moves to the Totals card heading
  (`focusableHeading`) and the polite status reads "<total> in total"; on failure the banner reappears and
  **takes focus** (`ref`, `tabIndex={-1}`), because the Retry button that had it is gone. "Clear the deal
  filter": the filter clears, the view reloads normally, focus goes to the Deal picker's input. When the
  error is raised from the Export button (F5) the button unmounts and the banner takes focus likewise.

**Names the viewer cannot read (AC-4.10, D43).** Applies to every viewer, the entry's author included. The
catalog words below are used on screen and in the export, so the two never disagree.

| Where | `hidden` | `unavailable` | `unknown` (meeting → deal only) |
|---|---|---|---|
| Row name (S1) / "On" first line (S4) / export Name | "Not visible to you" | "Name unavailable" | — |
| Meeting row "Counts for deal" line / export Counts for deal | "Counts for a deal that is not visible to you" / "Not visible to you" | "Counts for a deal whose name is unavailable" / "Name unavailable" | "The deal these hours count for is unknown right now" / "Unknown" |
| Activity line / export Activity | "Activity: not visible to you" / "Not visible to you" | "Activity: name unavailable" / "Name unavailable" | — |
| Totals rows (merged, one each) | "Projects / Deals not visible to you" | "Projects / Deals whose name is unavailable" | `deal-unknown`: "Meetings whose deal is unknown right now" |

The type `Badge` (or the "On" second line) is always shown, so the row still says what kind of work it was;
the name is plain text, not a link (`href` is `null`), at the same size as a name. A `hidden` row is never
distinguishable from another `hidden` row on screen (D44 leaves `on.id` in the API; the UI never uses it
except for the author's own edit dialog).

### S2 Entry dialog — create and edit

`FormDialog` over S1, `size="lg"`; title "Record hours" / "Edit entry"; submit "Save entry" (busy "Saving…").
The fields are more than the library's "five at most" guideline for a dialog (up to seven are visible at
once). Kept as a dialog on purpose: recording is the tool's highest-frequency act and a page per entry costs
more than it saves; the extra fields are the optional work type / activity and the conditional entity field.
The prop-driven form (initial values in, one `onSubmit` out) is reusable by specs/030 and 031.

| Field | Control | Required | Options / rule |
|---|---|---|---|
| Day | `DateInput` in `Field` | yes | default today; `max` today; after today → `future_day` text (AC-1.3) |
| Duration | native `<select>` in `Field` | yes | 48 options, 30 min … 24 h, labelled with `formatDuration(…, 'short')`; hint "In steps of 30 minutes, up to 24 hours." (AC-1.2, A9). Why not a number box: `type="number"` rejects the comma, a free text box needs a parser and invites "2:30"; a select cannot hold an invalid value and has typeahead |
| What was it on | `RadioGroupField` (legend) | yes | Project · Deal · Meeting · Other work. **Nothing is preselected** when recording (no default guess, D18) |
| Project / Deal / Meeting | `SearchPicker` in `Field` | yes | the label follows the radio; each carries its rule as `hint`: project "You can record hours on projects where you are the project manager or on the team."; deal "…on deals you own, are the technical contact of, or take part in through an activity."; meeting "…on meetings you created or take part in." (plan R5) |
| Category | `select` | yes, Other work only | non-retired categories (+ the entry's own retired one when editing); none available → the field says "No categories are available. Ask whoever manages the time lists." and Save is blocked |
| Work type | `select` | no, Project / Deal only | first option "No work type"; the projects list for a project, the deals list for a deal; non-retired (+ own retired) |
| Activity | `select` + `Button ghost sm` "Try again" in its error state | no, Project / Deal only | see *Activity field* below |
| Note | `textarea` in `Field` | only when the chosen category requires one (then `*` and the hint "This category needs a note.") | counter hint "n of 1000"; over 1000 → field error (AC-1.7); no `maxLength`, so a long paste is not silently cut |

Applicability matrix (a field that does not apply is not in the DOM)

| On | Entity | Category | Work type | Activity | Note |
|---|---|---|---|---|---|
| Project | picker | — | projects list | activities of that project (tasks) | optional |
| Deal | picker | — | deals list | activities of that deal | optional |
| Meeting | picker | — | — | — | optional |
| Other work | — | required | — | — | optional / required by the category |

Changing the radio clears the entity, category, work type and activity (they no longer apply) and keeps Day,
Duration and Note. Changing the entity clears the activity (it belongs to the old one).

**Activity field.** Once a project or a deal is picked the **browser** reads its activities from activities-api
as the person — `GET {getActivitiesApiBaseUrl()}/activities?projectId=<id>` or `?dealId=<id>` with
`pageSize=100` — not through hours-api. One page, in activities-api's own order (latest first); an option is
labelled "Type · subject" (a project's are tasks); the first option is "No activity".

| State | Field | Hint (`aria-describedby`) |
|---|---|---|
| before an entity is chosen | `aria-disabled`, "No activity" | "Choose a project first." / "Choose a deal first." |
| loading | `aria-disabled`, "Loading activities…" | polite status "Loading activities…" |
| loaded | usable | none; when `total > items.length`: "Showing the latest N activities. Older ones can't be chosen here." (N = what was loaded, at most 100) |
| `404` (the project or deal is not readable through activities-api), `503 host_unavailable`, network | `aria-disabled`; only "No activity" and, when editing, the entry's current activity stay | "Activities could not be loaded. You can save without one." (polite) + **Try again** (`ghost` `sm`, re-sends the read) |

The field is optional, so **Save stays enabled in every state**: what the picker showed never decides the save;
hours-api's own rules do (`activity_not_allowed` → "This activity does not belong to the chosen project /
deal.", `host_unavailable` → the fail-closed error below). An edited entry's current activity stays an option
from its view even when it is outside the loaded page.

**The "not visible" variant (AC-4.10, D43).** When the entry's `on.visibility` is `hidden` the author's dialog
opens as follows; nothing else about it changes.

- *What was it on* keeps the entry's type selected. The entity field is the same `SearchPicker`, holding the
  placeholder "Not visible to you" as its value, with the hint "You can't open this project, so its name
  isn't shown. The entry stays on it unless you choose another." Typing replaces the value (the picker's
  "picked, never typed" rule); until the person picks something else the target is **unchanged** and `on` is
  not sent.
- *Editable:* Day, Duration, Work type (the lists do not depend on reading the project), Note. *Not editable
  while the target is unchanged:* Activity — it shows the entry's pointer ("Activity: not visible to you", or
  "No activity") and no list is read, because the person cannot read that project's activities. Picking a new
  target makes Activity a normal field again.
- A meeting whose *deal* is hidden needs no variant: the deal is not an editable member of the dialog.
- `visibility: unavailable` is **not** this variant: the owner only failed to answer, so the dialog opens
  normally with the placeholder "Name unavailable" and the activity read is attempted.
- Saving with the target unchanged makes no bookability check (AC-2.12, D46), so this variant saves like
  any other edit; only picking a new target can be refused, on the picker (*Error surfaces* below).

Picker states (`SearchPicker` `emptyState`, each also announced politely): while typing "Searching…"; no match
"No <projects / deals / meetings> match."; `403` from the owning API (no Projects or CRM access) "You can't search
<projects / deals>." (the entry can still be recorded on another target type); `503` or a network failure
"The search is unavailable. Try again."; the result count is announced ("5 projects").

Validation: on blur of a touched field and on submit; a failed submit moves focus to the first invalid field
(`focusFirstInvalid`). Required fields carry `*` + `aria-required` (suite convention, no "(optional)" text).

Error surfaces (server code → where, what it says)

| Code | Surface | Meaning for the person |
|---|---|---|
| `invalid_minutes`, `future_day`, `note_too_long`, `note_required` | the field | the same words as the client rule; the client rules make them rare |
| `category_not_found`, `category_retired`, `work_type_not_found`, `work_type_retired`, `work_type_not_allowed` | the field | "No longer available — choose another." (lists are reloaded) |
| `activity_not_allowed` | the Activity field | "This activity does not belong to the chosen project / deal." |
| `not_on_project` | the project picker | "You are not the project manager or on the team of this project." On edit it can only follow a change of target (AC-2.12): same words, the entry keeps its current project |
| `not_involved_in_deal` | the deal picker | same shape for deals (owner, technical contact, activity assignee or participant) |
| `404 not_found` (create) | the entity picker | "This <project / deal / meeting> is no longer available to you. Choose another." (identical for missing and unreadable, AC-2.10: the copy does not tell which) |
| `404 not_found` (edit) | `.form-error` | "This entry, or what it is on, can no longer be found. If it is still listed, you can delete it. Close this window; the list will reload." |
| `host_unavailable` 503 | `.form-error`, `role="alert"` | fail closed (AC-2.11): "Operai could not check that you may record hours on this <project / deal / meeting>. Nothing was saved. Try again in a moment." Save is pressed again to retry |
| `invalid_request`, network, other | `.form-error` | generic "Something went wrong. Nothing was saved." |
| `owner_only`, `read_all_required` | — | not reachable from this dialog (no write control on someone else's entry) |

### S3 Delete confirmation

`ConfirmDialog tone="danger"`, focus on Cancel. Title "Delete this entry?"; body "<duration> on <name>,
<date>. This can't be undone." (for a hidden target: "<duration> on a <project / deal / meeting> that is not
visible to you, <date>."); confirm "Delete entry" (busy "Deleting…", not dismissible). Error inline in the
dialog; `404` handled as in F3.

### S4 Everyone's hours — `/hours/all`

Purpose: read-only oversight of every person's hours (US-4, D9, D21).

- Header: `PageHeader` "Everyone's hours", description "Read only. Hours can be changed only by the person
  who recorded them." (AC-1.6). No primary action; **Export** sits in the Entries card.
- Filters card: S1's plus **Person** (`select`, "Everyone" first). Its options are the `person` groups of
  `GET /time-entries/totals?whose=all&groupBy=person` with the view's period, project, deal, category and
  work type and **without** `userId` — complete (never paged), `key` = the user id the filter then sends,
  `label` = the live name — so they list exactly the people who have hours under the other filters; no user
  directory is needed. `label: null` → "Unknown user"; `status: deleted` → "<name> (deactivated)". The
  current choice is always kept as an option, so a person who drops out of the narrowed list is not
  silently reset. While it loads the select shows "Everyone" and the current choice, `aria-disabled`, hint
  "Loading people…". If this call fails (`identities` unavailable → names show as "Unknown user"; any other
  failure → the select shows "Everyone" and the current choice, `aria-disabled`, hint "People could not be
  loaded."), the rest of the view is unaffected; the AC-4.11 case is the shared error state of S1.
- Totals card: as S1 with **Person** added and the default group. `FactList` Total. Merged rows and month
  labels as S1.
- Entries card: `DataTable` with columns **Day** (`formatDate`), **Person**, **On** (name or placeholder + a
  second line "Project · Development" / "Other work · Training" / "Counts for deal …", placeholders as in S1),
  **Details** (`Activity: <subject>` or its placeholder, and the full note), **Time** (`numeric`). Sorted as
  the server returns (day, newest first), never client-sorted; `LoadMore`. Rows are not interactive.
- The persistent `Banner tone="info" live="off"` for hidden names (S1) reads here: "Some projects, deals or
  meetings are not visible to you, so they show without a name. Their hours are still counted." (AC-4.10,
  plan R4).

States: *permissions resolving* → `SkeletonRows` + live "Loading…" (nothing fetched); *not a holder or
`403 read_all_required`* → `StatePanel role="alert" focusOnMount` "You can't see everyone's hours" (the app's
`PermissionDenied`) with a `.link` to My hours; *`503 authz_unavailable`* → `Banner tone="warning"` titled
"Authorization service unavailable", Retry, "Your own hours are not affected."; *load error*, *empty*
("No hours have been recorded in this period" / "No entries match these filters" + Clear filters), *loading*,
*source down*, *names not visible* and *deal filter unavailable* as in S1.

### S5 Time lists — admin-ui `/time-lists`

Purpose: create, rename, retire and restore categories and the two work-type lists (US-3).

```
Admin  [Roles][Departments][Users][Refund*][Time lists*]                 [Audit]     * only with the permission
Time lists   (h2)   "Categories and work types people pick from when they record hours."
[ compact success banner / warning or danger banner ]
┌ Categories ────────────────────────── [Add category] ┐
│ Name      | Entries need a note | Status  | Actions                   │
│ Training  | No                  | Active  | [Rename] [Retire]          │
│ Other     | Yes                 | Active  | [Rename] [Retire]          │
│ Seminars  | No                  | Retired | [Rename] [Restore]         │
│ "Entries keep their category, so it can be retired and restored but not deleted."
└────────────────────────────────────────────────────────┘
┌ Project work types ─── [Add work type] ┐   ┌ Deal work types ─── [Add work type] ┐
```

- `SectionNav` gains the **Time lists** link (the `rate:read` pattern: out of the DOM until `usePermissions()`
  resolves and holds `time-list:manage`, never disabled). A role with the permission but no Admin access
  cannot reach the screen (AC-3.3 as amended); that is the Admin tool's existing no-access screen, nothing
  new.
- Each card: `Card` (title h3, `action` secondary `sm`) + `DataTable` (Name as `rowHeader`; categories also
  have the "Entries need a note" column; Status through `StatusBadge`: Active → `active`, Retired → `voided`,
  the label is text so colour is never the only signal; Actions). Retired rows are listed after active ones
  (a stable client partition of a small, unpaginated list), so a row moves when it is retired or restored.
- **Row actions**, all `ghost` `sm` with an `aria-label` naming the item (the CRM `TemplatesCard` row
  buttons): an **active** row offers **Rename** + **Retire**; a **retired** row offers **Rename** +
  **Restore** (AC-3.1 as amended, D38). Retire and Restore each send one `PATCH { retired }` and are
  idempotent, so a double click or a race with another holder is harmless.
- Names are shown **exactly as typed** in both languages (AC-3.8): never passed through the strings catalog.
- **Add / Rename** (`FormDialog`, size `md`): **Name** (`Field`, required, ≤ 80 characters after trimming, hint
  "Shown exactly as you type it, in English and Italian."); categories add a single checkbox "Entries in this
  category need a note". `409 name_taken` → field error "A category with this name already exists. It may be
  retired." (names are unique per list, case-insensitive, retired included).
- No Delete control, no route (AC-3.2).

**Decision — Retire asks nothing.** The first draft guarded Retire with a `ConfirmDialog` because nothing
could undo it. Restore (D38) makes it a one-click reversible state change that touches no entry, and the suite
already treats that class of action as unconfirmed: the CRM's `TemplatesCard` archives and restores with no
dialog ("Archiving is recoverable, so it asks nothing"), while `ConfirmDialog` is for what cannot be undone
(`design-system.md` § Dialogs, the `danger` rule). A confirmation here would also not prevent the one real
consequence — someone mid-entry meets "No longer available — choose another" — and Restore is what repairs
it. What replaces the dialog is feedback that says what happened and where the way back is (the success banner
below), and focus that follows the row. If the owner wants a pause before Retire, a `ConfirmDialog
tone="primary"` can be added back without touching anything else.

**Retire and Restore — states (a row action; no dialog)**

| State | What the person sees |
|---|---|
| idle | `ghost` `sm` "Retire" / "Restore" (`aria-label` "Retire Training" / "Restore Training") |
| pending | the clicked button is `busy` (`aria-busy`, spinner, label "Retiring…" / "Restoring…", clicks ignored — not `disabled`, so focus stays); the same row's Rename ignores clicks (`aria-disabled`); other rows stay usable |
| success | the row takes the server's answer (no refetch), moves to its partition, its badge reads Active / Retired and its buttons swap; a compact success banner (the admin-ui `SuccessBanner`, polite `role="status"`, 3 s) says "“Training” retired. Entries that have it keep it. You can restore it from this list." / "“Training” restored. People can pick it again."; **focus moves to the same item's new toggle button** (Restore after a retire, Retire after a restore), so a keyboard user is not dropped when the row moves |
| `403 time_list_manage_required` | the person's permission was withdrawn since the page loaded; nothing changed; the page switches to `PermissionDenied` (`StatePanel role="alert" focusOnMount`) in place of the cards |
| `503 authz_unavailable` | nothing changed; `ErrorBanner` (warning) titled "Authorization service unavailable" with **Retry**, which re-sends the same `PATCH` (safe, idempotent); the row button is idle again, so focus has not moved |
| network / `5xx` / other | nothing changed; `ErrorBanner tone="danger"` "Something went wrong. Nothing was changed." + Retry, as above |
| `404 not_found` | the item no longer exists (no route deletes one, so only after a database reset): the lists reload and an info banner says so |
| `409 name_taken` | not reachable from these buttons (a restore alone cannot collide, plan § Lists); it belongs to Rename |

States of the page: *loading* — three cards, each with `SkeletonRows`, one polite "Loading time lists…";
*load failed* — `ErrorBanner` (warning) + Retry replaces the cards; *403* — `PermissionDenied`
(`StatePanel role="alert" focusOnMount`) in place of the cards; *`503 authz_unavailable`* — banner titled
"Authorization service unavailable" + Retry; *empty list* — `StatePanel` inside the card "No categories yet" /
"Add one so people can record hours on work that is not in Operai." (work types: "No work types yet. Entries
can be recorded without one."); a list with only retired rows shows those rows, not the empty state; *dialog
write failure* — inline `.form-error` (403 and 503 use the same words as the page states), dialog stays open,
values kept; *success* — the compact banner ("Category added", "Renamed", "Training retired", "Training
restored") above the cards.

### S6 Menu link — shell `UserMenu`

One `<Link role="menuitem" className="menu-item">` "My hours" / "Le mie ore" after "My meetings", to the string
`/hours` (the splat-route form `MY_MEETINGS_PATH` uses). Shown to every signed-in user, no permission check.

---

## Component inventory

Library in use: **`@operai/ui`** (`operai-ui/`, ADR-0050/0051) with Tailwind token utilities; TanStack Router;
`shell/session` for `apiFetch`, `usePermissions`, `get*ApiBaseUrl`. Not Mantine.

### Reused (library or in-repo)

| Element | Reuse |
|---|---|
| Tool frame, section nav | `ToolLayout` + `TabNav` (`operai-ui`); admin-ui `SectionNav.tsx` gains one link |
| Page title, description, primary | `PageHeader` |
| Filter bar, totals, entries, list cards | `Card` (with `action`), `FactList` |
| Fields | `Field`, `RadioGroupField`, `DateInput`, native `select` / `textarea` (base look from `tokens.css`), `focusFirstInvalid` |
| Day list | `ListRows` + `listRowClassName` / `listRowMetaClassName` with `is-interactive` rows, `Badge`, `Button`, `Icon` |
| Tables | `DataTable` (totals, everyone's entries, admin lists) |
| Paging | `LoadMore` (cursor endpoint) |
| Dialogs | `FormDialog` (entry, list item), `ConfirmDialog` (delete only — Retire no longer confirms) |
| Feedback | `Banner` (success compact + `autoDismiss`, warning + Retry + `actions`, info), `StatePanel`, `SkeletonRows`, `VisuallyHidden`; admin-ui's `SuccessBanner`, `ErrorBanner` and `PermissionDenied` adapters for S5; the same three as thin hours-ui adapters |
| Status | `StatusBadge` with the app's one map (`active` → `active`, `retired` → `voided`) |
| Menu link | shell `UserMenu.tsx` (`Menu` + router `Link`) |
| Remote mount, route | `RemoteMount`, the `/my-meetings/$` route shape in `shell/src/router.tsx` |
| Holder-only view | the estimai-ui rule (`EstimatesPage.tsx`, `EstimateFilters.tsx`): UX gate by permission, absent not disabled, server is the gate, stale answers discarded |
| Admin list page | the admin-ui `MileageRatesPage.tsx` shape (ADR-0023): state union loading/loaded/error/forbidden, per-card empty |
| Recoverable list action | the CRM `TemplatesCard.tsx` shape: `ghost` `sm` row buttons, busy per row, a success notice, no confirmation for archive / restore |
| Workbook | `exceljs` lazily imported inside `ExportButton`'s `build`, built from the list pages (the `inventory-ui` `yearWorkbook.ts` pattern, **not** copied code) |
| Durations | `formatDuration` + its planned `style: 'short'` (an extension of an existing formatter, plan, with story + test) |

### NEW

| New | Where | Why nothing fits |
|---|---|---|
| `SearchPicker` | **`@operai/ui`** (story + test) | A `Combobox` wrapped in `Field` that owns what the "dumb" `Combobox` leaves to the caller for a **server-side** search: debounce, abort and discard of stale answers, "picked, never free text" (typing after a pick clears it), `emptyState` for loading / no match / forbidden / unavailable, the result-count announcement. `PersonPicker` filters a whole list client-side and cannot do this. `crm-ui` and `projects-ui` each already carry a near-identical `CompanyPicker`; hours-ui is the third app that needs it, with five uses (project, deal and meeting in the entry dialog, project and deal in the filters), so by the library rule it belongs in the library. The two existing copies can migrate later (not in this spec) |
| `formatMonth` | **`@operai/ui`** `lib/format.ts` (test, both locales) | Group keys for "by month" are `YYYY-MM`; the library has no month formatter and formatting by hand is forbidden |
| `ExportButton` | **`@operai/ui`** (story + test) | Committed (the plan rejected a local copy): the busy / polite status / failed-alert download button is the shape of `inventory-ui`'s `ExportYearButton` (app code) and hours-ui is the second consumer, in two views, so by the library rule it belongs in the library. `inventory-ui` migrates later |

App-level compositions (new files in the app, built only from the entries above): hours-ui `HoursShell`,
`MyHoursPage`, `EveryoneHoursPage`, `HoursFilters`, `TotalsCard`, `EntryDayList`, `EntriesTable`, `EntryDialog`,
`ActivityField`, `DeleteEntryDialog`, `DealFilterUnavailable`, `buildHoursWorkbook`, `todayZurich`; admin-ui
`TimeListsPage`, `TimeListCard`, `TimeListItemDialog`, `timeListsApi.ts`; shell route + menu link. They bind
copy, test ids (`hours-…`, `time-lists-…`) and the app's status map; none restyles a library component.

Ratio: **22 existing `@operai/ui` components** (plus its formatters and `Combobox` inside the new picker),
**3 admin-ui adapters** (`SuccessBanner`, `ErrorBanner`, `PermissionDenied`) and **5 in-repo patterns**
(holder-only view, admin list page, recoverable list action, workbook build, remote route) reused, against
**2 NEW library components (`SearchPicker`, `ExportButton`) and 1 NEW formatter (`formatMonth`)**, plus one
option on an existing formatter (`formatDuration` `short`); none duplicates an existing one.

---

## Accessibility

Common: one h1 (tool title), one h2 per page, cards h3, day headings h4; the shell owns `<main>`; every
icon-only button has an `aria-label` naming the entry; icons `aria-hidden`; focus ring is the library's; both
themes checked; no text uses `--muted`; `prefers-reduced-motion` is the library's. Colour is never the only
signal: type is a `Badge` with text, hidden and unavailable names are words, status badges carry glyph + text.

**Shell menu link (S6)** — `Menu` keyboard (Arrow keys, Home/End, Escape back to the avatar) is the library's;
the item is a real link.

**HoursShell / tabs** — `TabNav` links with `aria-current="page"`; the Everyone's tab is simply absent for a
non-holder. A not-found or denied state replaces the content and takes focus on its heading
(`StatePanel focusOnMount`).

**My hours (S1)**
- Keyboard path: header (Record hours) → Filters (Period, [From, To], Project, Deal, Category, Work type,
  Clear filters) → Totals (Group by, table region) → Entries (per row: name link where there is one, Edit,
  Delete; Export; Load more). Table scroll regions are keyboard-scrollable (`DataTable`).
- Filters apply on change: when the totals arrive a polite live region reads "<total> in total" (or "No entries
  match" for an empty list); the list's own count is not announced, because the list is paged; focus never
  moves. The `SearchPicker` follows `Combobox` rules (↓/↑, Home/End, Enter picks, Escape closes, Tab leaves
  without picking; focus stays in the input, `aria-activedescendant`).
- Each day is a `section` labelled by its heading; its `ListRows` has `aria-label` "Entries on <date>". The
  duration in a row is visible as "2 h 30" and carries the spoken form ("2 hours, 30 minutes") for assistive
  technology; the day total, which is part of the heading's line, likewise. A day whose total has not arrived
  has no total text at all (nothing is read as "0").
- A row's Edit and Delete `aria-label`s name the entry — "Edit 4 h on Project Alpha, 12.11.2026" — and for an
  entry whose target is not visible "Edit 4 h on a project not visible to you, 12.11.2026", so two hidden rows
  of one day are told apart by duration and position only; that is deliberate: the UI shows no id for a
  hidden record (whether the API keeps it is left to review, D44).
- Totals table: the merged rows are ordinary rows read in order, their first cell a plain sentence
  ("Projects not visible to you"); the table has a caption naming the grouping and `scope` headers; month names
  come from `formatMonth`, so they are read in the page language.
- After a save or a delete a compact success `Banner` (`role="status"`, 3 s) is the confirmation; after delete
  focus moves to the page heading (`focusableHeading`), after save the library returns it to **Record hours**.
- Loading regions are `aria-hidden` skeletons with one polite "Loading…" line; the info banner for
  unavailable sources is `live="polite"`, never `alert`; the "names not visible" note is `live="off"`
  (`role="note"`, `aria-label`) because it is a standing fact, not news.
- **Deal filter unavailable (AC-4.11)** — the banner is a `role="alert"` and is announced when it replaces
  the Totals and Entries regions; it does not take focus on its own (the person is in the Filters card). Retry
  → polite "Loading…"; success → focus to the Totals heading and "<total> in total"; failure → the banner
  returns and takes focus (`tabIndex={-1}`), because the Retry button that had focus is gone. "Clear the deal
  filter" → focus to the Deal picker's input. Both actions are real buttons with visible text, in tab order
  after the Filters card.

**Entry dialog (S2)**
- Modal, labelled by its title, trap + Escape + × + focus return are `useDialogBehavior`; the backdrop does not
  close it (typed input); not dismissible while saving. Focus lands on **Day** (first field).
- **Duration select**: label "Duration" with `*` + `aria-required`; the hint is `aria-describedby`; native
  typeahead works ("2" jumps to "2 h"); option text uses the short form for consistency with the lists. The
  short form ("2 h 30") may be read as the letter "h" by some screen readers: QE checks NVDA and VoiceOver
  readback, and the fallback is option text in the `spoken` style.
- **What was it on** is a `fieldset` with a legend (radio group, arrow keys); fields that appear after a choice
  follow the group in DOM order, so the next Tab reaches them; nothing is announced or moved.
- **Activity field** — a native `select`; its state text (choose first / loading / latest N / could not be
  loaded) is the `aria-describedby` hint, and the loading and error texts are also polite status. In every
  non-usable state it is `aria-disabled` rather than `disabled`, so a person who tabs to it learns why. **Try
  again** is a real button after the hint in tab order; Save is never blocked by this field, and nothing about
  its error is `role="alert"` (it is optional).
- **"Not visible" variant** — the entity input's value "Not visible to you" is real text read with the field's
  label; its hint says the entry stays on it unless another is chosen; the Activity hint says why it is not
  editable. Picking another target moves nothing: the field simply becomes live and its hint changes.
- Picker errors, field errors and the `.form-error` are `role="alert"` and linked by `aria-describedby`; a
  failed submit focuses the first invalid control; every typed value survives a failure.
- Disabled fields that the person must learn about (Activity before an entity is chosen, lists not loaded) use
  `aria-disabled` + `aria-describedby` text rather than `disabled`, per the design-system rule.
- Note counter is static hint text (not live); the over-limit error is on blur/submit.

**Delete confirmation (S3)** — `alertdialog`, focus on Cancel, Escape cancels, busy locks it; Confirm is
`danger`.

**Everyone's hours (S4)** — the table has an sr-only caption and `scope` headers; Person and On are text;
sort order is the server's (no `aria-sort`). The denied / authorization-unavailable states are alerts and take
focus; the "not visible to you" banner is `live="off"` (`role="note"`, `aria-label`). The Person select has a
visible label; its options are text only; when its call failed it is `aria-disabled` with the hint as
`aria-describedby`. The deal filter unavailable state is as in S1.

**Time lists (S5)** — tab visibility as in the shell; each card's table has a caption ("Categories", …); the
row buttons name the item ("Rename Training", "Retire Training", "Restore Training"); the status is a badge
with text. **Retire / Restore** have no dialog: keyboard path is Tab to the row's button, Enter/Space once;
the button is `aria-busy` while pending (not `disabled`); on success the polite status banner says what
changed, and focus moves to the same item's other toggle button because the one pressed is replaced; on a
503 / network failure focus stays on the (idle again) row button and the warning/danger banner announces. The
403 permission-denied panel takes focus on its heading. Add/rename dialogs focus **Name**; `409` is a field
error (`aria-invalid`).

**Export** — the button is `aria-busy` (not `disabled`, which would drop focus); a polite status line says
"Preparing file…" then "File ready" or "File ready. Some names could not be loaded and are missing."; failure is
a `role="alert"` line. A failure that is the AC-4.11 error is announced and focused by the view's banner
instead, since the button is gone.

---

## AC coverage and scope

All 44 ACs of the spec (41 + AC-4.10 + AC-4.11 + AC-2.12 as amended) are accounted for below.

| Surface | ACs |
|---|---|
| S2 (+F1, F2) | AC-1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 2.1–2.5, 2.7, 2.8, 2.10, 2.11, 2.12 (editing an entry on a left or unreadable target), 3.4, 3.5, 3.6, 4.10 (the "not visible" variant) |
| S3 | AC-1.5 |
| S1 | AC-1.4 (explained), 2.6, 2.9, 4.1 (day totals from `groupBy=day`), 4.4, 4.5, 4.7, 4.8, 4.9, 4.10, 4.11 |
| S4 | AC-4.2, 4.3, 4.4, 4.5, 4.10, 4.11, 5.4 |
| Export (both) | AC-4.6, 4.9 (screen vs file), 4.10, 4.11 |
| S5 | AC-3.1 (create, rename, retire, restore), 3.3, 3.4, 3.7 (the seeded rows are simply the first rows), 3.8 |
| S6 + shell route | AC-5.1, 5.3 |
| AC-5.5 | every surface (catalog parity, formatters) |

ACs with **no UI surface of their own** (backend or an absence): AC-1.6 (no write control exists on someone
else's entry; the refusals are API-only), AC-1.8 (the dialog has no start/end field), AC-3.2 (no Delete control),
AC-5.2 (catalog seed), AC-2.9 (derived on read: the row just shows no activity). AC-1.2's refusal is reachable
only through a server error, because the control cannot hold an invalid duration.

UI present that no AC asks for (small, kept, say if you want it removed): the "outside the period you are
viewing" wording of the save banner; the "names not visible" note (plan R4's mitigation); the Person options
read from `GET totals?groupBy=person` (AC-4.4 asks for the filter and no directory is available, ADR-0066);
the **Clear the deal filter** button in the AC-4.11 banner (AC-4.11 asks only for "refused as unavailable");
the activity field's **Try again** button; the success banners of Retire and Restore.

**Not designed — scope creep, reported:** a week grid or timesheet, a timer, "save and add another", copy
yesterday, drill-down from a totals row into a filter, the API's `meetingId` / `target` list filters (no
AC-4.4 entry), charts (D25), any "incomplete day" cue or reminder (D23), an Undo link in the retire banner
(Restore on the row is the undo), bulk retire / restore, a "show retired" toggle (retired rows are always
listed, after the active ones), a Group by Day option (day totals only label the entries).

**Seams.** specs/030 (hours on project and deal pages) and specs/031 (suggested entries) must not need a
redesign of S2: keep `EntryDialog` prop-driven (initial values in, one submit out, no router coupling). 031's
"Suggested" card would sit between Totals and Entries on S1 and would say "suggestions unavailable" when
Meetings does not answer (A25); 030's per-project totals are a different page and reuse only `formatDuration`.
Neither is designed here.

---

## Gaps found in the spec and plan

**Closed by the amendments (no action):** (1) Restore of a retired item → AC-3.1 / D38; (2) Person filter
source → plan § Totals; (3) totals semantics → plan § Totals; (4) `formatMonth` → plan § `@operai/ui`;
(5) day totals vs cursor paging → `groupBy=day`; (6) activity pointer source → plan § Components `hours-ui`;
(7) export duration and meeting entries → D39 / D40 and plan § Export file; (9) who can reach Time lists →
AC-3.3 / D41.

**Open**

1. ~~Editing an entry whose target the author cannot read~~ — **closed 2026-11-13 by D46 / AC-2.12**: a
   change that keeps the target is not re-checked, so the S2 "not visible" variant (day, duration, note,
   work type editable) stands; only moving the entry is checked.
2. **`PATCH` 404 is ambiguous** — entry gone, target gone and target unreadable share one body (AC-2.10). The
   copy says "this entry, or what it is on" and adds Delete. Acceptable; recorded so QE does not expect two
   messages.
3. **Pickers offer what the person cannot book on** (plan R5) and are empty for a person without Projects or
   CRM access: the filter by project / deal is then not usable for them (consistent with AC-4.10). Copy states
   the rule; nothing else is designed.
4. **Later page failing under a deal filter.** AC-4.11 says "nothing partial is shown". The design keeps pages
   already shown when a *Load more* gets `503 host_unavailable` (each was complete when read) and replaces the
   view only when the first page, the totals or the export do. **Decided in the main loop (2026-11-13,
   owner may strike):** keep it — the totals above the list were read complete, so no figure is shown low,
   which is what D45 protects.
5. **`ExportButton` has one fixed `failed` string** (plan sketch). The AC-4.11 export failure is routed to the
   view's banner so it needs nothing more; any other failure reads generically. Not blocking.
