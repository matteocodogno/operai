---
spec: 20261112
status: approved
approved: 2026-11-27
---

# Plan: Project hours — time worked against what was sold

Spec: `spec.md` (approved 2026-11-26, re-opened for D78–D79; re-opened a second time for US-5, D86–D94, and approved again
2026-11-27). Decision ledger: `../20261112-time-tracking/ledger.md`, with D95 and D96 decided with this plan at gate 2
(2026-11-27): the over state reads "Limit reached" at exactly 100 % of the reference and "Over the limit" only above it
(D95; the AC-5.9 test row, § Signals' Levels bullet), and US-5's readings are confirmed, the neutral bar among them (D96).
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
Amended a seventh time 2026-11-27 (the spec was re-opened a second time for **US-5, signals on the consumption block**, and
approved again the same day: AC-5.1–5.29, ledger D86–D94, F16–F21, A53–A56; AC-1.7, AC-1.9 and AC-3.2 changed; A52 gained a
fifth case). The consumption block now also says the consumed percentage, its state (on track, close to the limit, over), the
excess, the time elapsed and the dates that have passed or are near, and draws them on a bar (the owner's "option C").
**One contract change:** projects-api's terms view states the Europe/Zurich day it was derived for, `Terms.asOf`, so every
signal that reads today reads the day of `currentPeriod` (D-P7, AC-5.29). The rest is projects-ui: the signals are pure
functions in `lib/consumption.ts` (D-P9), a new app-local `ConsumptionBar` draws the bar (D-P8), and `HoursSection` and
`ConsumptionBlock` take the project's state (AC-5.26). No route, request, migration, variable, scope or `@operai/ui` export,
no change to hours-api, hours-ui, crm-ui or meetings-api, and no shell *source* change — but the shell is rebuilt and
deployed from the same commit, because its one Tailwind sheet generates the bar's utilities (§ Deploy order, R13). New:
§ Signals on the consumption block, D-P7–D-P9, the projects-ui contract under § API contracts, the AC-5.x test rows and e2e
journeys E and F, R9–R13, a § Deploy order note, § Notes for the task re-sync (with the eval's two docs follow-ups) and one
ADR candidate (an amendment of ADR 20261126-a-figure-set-against-another-owners-figure-…). Changed: § Shape, § Components
(the shell, projects-api (c), projects-ui (g)–(k)), the note under the § Consumption table and its last row, § Data model,
the AC-1.7, AC-1.9 and AC-3.2 test rows, R6, R8 (case (e), D86 extending D85) and § Security (no new surface). design.md S1
decided "no status colour" and "no progress bar"; D86 reverses both, and the designer amends design.md after this plan
(§ Notes for the task re-sync). Corrected the same day, within this amendment, on design.md's own amendment (its G7, G8,
G10): the bar's labels are decoration inside its `aria-hidden` root, not "no text" (the AC-5.11 row, § Signals' bar
bullet); the shell is rebuilt from the same commit, with its skew and checks (§ Components, D-P8, § Deploy order, the
AC-5.15 row, e2e F, R13, § Notes for the task re-sync, § ADR candidates); and the bar is neutral when no state is said,
pinned pending the owner's one-line confirmation (the Levels bullet, the AC-5.25 and AC-5.26 rows). Status back to
`draft` until the owner approves the plan again (gate 2).
Amended an eighth time 2026-11-27, after approval (count reported by T24, commit `d30ba888`, `decisions.md` § T24): the
implementation drops the bar's "125%" label from a bar narrower than 230 px with a container query,
`@max-[230px]:hidden` (in the shell the card is 205 px wide at a 360 px viewport and 165 px at 320, and "100%" and "125%"
collided), so the bar's utilities new to the suite are seventeen, not sixteen: § Components (the shell row), § Deploy
order and R13 now say so, and R13 says why its two checks stay as they are. No route, API, AC→test row, decision or ADR
change.

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
mechanism of ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route § 5, mirrored). Since US-5
(2026-11-27) the consumption block also says where the project stands — the consumed percentage, its state, the excess, the
time elapsed and the dates that have passed or are near — and draws it on a bar; projects-ui works these out from the same two
answers, the project's state and the day projects-api states it derived the terms for (`asOf`), with no new request.

### Components

| Service / app | Change | ACs |
|---|---|---|
| **meetings-api** | `GET /system/meetings/hosts` takes `projectId=` (exactly one of `ids`, `dealId`, `projectId`); host fixed to `{app:"projects", entityType:"project"}`; same scope `meetings.hosts.read`, same `sub` allowlist, same answer shape. `src/system/hosts.routes.ts` | AC-4.1–4.5, 4.8–4.10 |
| **projects-api** | (a) `POST /activity-host/v1/resolve` open items gain `projectManagerId: string \| null` (`null` while the project awaits one), `src/activity-host/activity-host.routes.ts`. (b) the terms view's `hourPackage` gains `currentPeriod: { from, to, ended } \| null` (`ended` only `true` for a capacity package past its expiry, D83), derived on read by a pure `packagePeriod(hourPackage, today)` (`src/terms/packagePeriod.ts`, new) with `today` the Europe/Zurich date (`src/lib/businessDay.ts`, new, same rule as hours-api `src/entries/today.ts`), wired in the terms view itself, `termsView` and `toTermsView` (`src/terms/terms.ts:175,216`, through `hourPackageView` at `:166-169`), so every response carrying `TermsViewSchema` has it: the project view, whose `toProjectView` calls `toTermsView` (`src/projects/projects.routes.ts:120`), and the `POST`/`PATCH /projects/{id}/terms` answers (`src/terms/terms.routes.ts:162,210`), neither route file changed; schema `HourPackageView` (`src/projects/projects.schemas.ts:56-62`). (c) *US-5:* every answer carrying `TermsSchema` also carries `asOf`, the Europe/Zurich business day `toTermsView` derived `currentPeriod` for — the one `today` argument it already passes to `termsView` (`src/terms/terms.ts:216-225`), now also returned; schema `TermsSchema` (`src/projects/projects.schemas.ts:73-80`); no route file changes (D-P7) | AC-1.1–1.3, 1.9, 2.3, 2.7, 5.18–5.25, 5.29 |
| **crm-api** | `POST /activity-host/v1/resolve` deal items gain `ownerUserId: string`, `src/activity-host/resolve.routes.ts:86-97` | AC-2.4 |
| **hours-api** | (a) new `GET /time-entries/summary` (`src/summary/`, new: route, query, `summaryOf`); (b) `projectCondition` beside `dealCondition` in `src/entries/filters.ts` — the `projectId` filter of the list and totals = entries on the project OR on meetings linked to it now, cursor key + 409 like the deal's; (c) `byProject` in `src/totals/totals.ts` places a meeting entry under its linked project (new tail bucket `project-unknown`); (d) `src/labels/resolve.ts` resolves a meeting's project from the same `readMeetingHosts` read and the viewer's projects resolve, `TimeEntryView` meeting `on` gains `project: MeetingProject` (`src/entries/view.ts`); (e) clients: `readMeetingsLinkedToProject` in `src/clients/meetings.ts`, `projectManagerId` / `ownerUserId` parsed in `src/clients/projects.ts` / `crm.ts`; (f) OpenAPI + `src/matrix.test.ts` inventory | AC-1.x (window), 2.1–2.7, 4.1–4.10 |
| **shell** | `hours.hostHours` in `ExtensionProps` and `LOADERS` (`() => import('hours/HostHours')`), `shell/src/lib/extensions.tsx:36-69`; props `{ on: 'project' \| 'deal', targetId: string }`. *US-5:* no source change, but a build from the commit that carries projects-ui's US-5 source: the suite's one Tailwind sheet is the shell's (`src/index.css:15-28` `@source`s every remote) and generates the bar's utilities, seventeen of which no other source in the suite uses (§ Deploy order, R13) | AC-2.x, 2.6, 5.14–5.17 |
| **hours-ui** | (a) exposes `./HostHours` (`src/HostHours.tsx` + `src/HostHoursModel.ts`, new): the total recorded and the "includes linked meetings" line, always visible; a **"Show breakdown"** disclosure, closed on every mount, whose state is the widget's own (not in the URL), opening a region that stays in the DOM with `hidden` while closed: per work type, per person when the answer carries it (D80); one summary call on mount, none on open; its own loading/error states; imports `hoursApi`, strings and `@operai/ui` only — never `exceljs`, the pages or the router (the `./RecordHours` rule). (b) types: meeting `on.project`, `TotalsGroup` kind `project-unknown`, `UnavailableSource` `meeting-projects`, `SummaryAnswer` (`src/lib/hoursApi.types.ts`). (c) `getSummary` in `src/lib/hoursApi.ts`. (d) export: a **Counts for project** column right after Counts for deal, the 7th of the sheet's 10 (`src/lib/hoursWorkbook.ts`), screen line `countsForProjectLine` (`src/lib/names.ts`). (e) project-filter refusal: `DealFilterUnavailable` generalised to the deal or the project filter (`src/components/DealFilterUnavailable.tsx`, `pages/MyHoursPage.tsx`, `pages/EveryoneHoursPage.tsx`), 409 `project_meetings_changed` handled like the deal's. (f) `TotalsCardRows.ts` word for `project-unknown`. (g) en/it strings. (h) `./RecordHours` broadcasts the content-free `operai:time-entry-recorded` event after a successful save, and `HostHours` re-reads its summary when the event names its own target (D-P6). (i) a missing `on.project` (an hours-api older than step 4) reads as `{ state: "none" }` in the types, `countsForProjectLine`, the export cell and `hasHiddenName` (design G4) | AC-2.1–2.8, 4.4–4.11, 3.2 |
| **projects-ui** | (a) `HoursSection` (new) owns **one "Hours" card** right after Details on `ProjectDetailPage.tsx` (D80): the consumption block first, then the widget's slot (`useExtensionSeam`, `HostExtension name="hours.hostHours"`, the slot's own "Hours unavailable" fallback, `ExtensionContain` keyed by project id); the card frame and title always show, only the slot is swapped on a failure. (b) `ConsumptionBlock` (new, a block inside that card, not a card) shown when the terms sold something comparable: calls the summary itself (with the package window when there is one) and renders `consumptionOf(terms, summary)` from `src/lib/consumption.ts` (new, pure). (c) `getHoursApiBaseUrl` declared in `src/federation/remotes.d.ts`, `src/lib/hoursApi.ts` (new, one function). (d) `Terms` type gains `currentPeriod` with `ended`; the block shows "Over by" the absolute figure once the package is exceeded (D81) and an "Expired" `StatusBadge` (`voided`) when `ended` (D83). (e) `ConsumptionBlock` re-reads on `operai:time-entry-recorded` naming its project (D-P6). (f) en/it strings. *US-5:* (g) `src/lib/types.ts` `Terms` gains `asOf?: string` (absent from a projects-api that predates it). (h) `src/lib/consumption.ts` gains the signals (§ Signals on the consumption block, § API contracts): a `share` on the `package`, `fixed_price` and `t_and_m` variants, `dateSignalsOf`, `hasConsumptionBlock`, `elapsedPercentOf`; `consumptionOf` takes the project's state; still pure, `import type` only, integers (D-P9). (i) `ConsumptionBar` (new, `src/components/ConsumptionBar.tsx`): the bar, its 80 % and 100 % marks, the today and estimate marks, `aria-hidden`, positions from `share.bar` through inline `style` only (D-P8). (j) `ConsumptionBlock` draws under its facts the bar, the pace line, the state and the excess when there is a `share`, and its date lines whenever `dateSignalsOf` has any, in every state of its read (AC-5.24); `HoursSection` and `ConsumptionBlock` take `state` (`pages/ProjectDetailPage.tsx:265` passes `project.state`) and decide whether there is a block, and so a divider, by `hasConsumptionBlock` (AC-1.7 amended). (k) en/it strings for the state words, the pace line, the excess and the date lines (design.md) | AC-1.1–1.9, 2.6, 2.8, 3.2, 5.1–5.29 |
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
| no terms, or nothing comparable (an SLA and no hour package) | — | — | no figures; the HostHours widget shows the total (AC-1.7, D82); *since US-5* a block of date lines alone when the terms' end date has passed or is near and the project is neither closed nor cancelled (AC-1.7 amended, AC-5.21–5.24, AC-5.26) |

*Since US-5 (2026-11-27)* every compared row also carries its signals (consumed percentage, state, excess, bar, time elapsed),
and every row with terms may carry date lines: § Signals on the consumption block.

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

### Signals on the consumption block (US-5, D86–D94) — where each comes from

Every signal is worked out by projects-ui's pure `lib/consumption.ts` (D-P9) from what the block already holds — the terms
(with `currentPeriod` and `asOf`), the summary's `windowMinutes` / `totalMinutes` and the project's `state` — and from nothing
else: no new request, no per-person figure, no clock. *used* and *reference* are whole minutes: *used* is the used minutes of
§ Consumption (`windowMinutes` for a package, `totalMinutes` otherwise); *reference* is a package's `hours × 60`, a fixed
price's `maxEffortManDays` or a time-and-material project's Σ `plannedManDays`, each as whole tenths × 48 (a tenth of a
man-day is 48 minutes, D27).

| Signal | Rule | Not shown when |
|---|---|---|
| **consumed percentage** | `⌊100 × used / reference⌋` by integer division, uncapped: 119 h 30 of 120 h is 99, 216 h is 180 (AC-5.1–5.5, D88, D92) | the variant compares nothing (`none`, `package_not_started`, `unavailable`), or the reference is not above zero (AC-5.4; the schemas forbid one, F17) |
| **state** | on the exact minutes, never the floored figure or the man-days shown (AC-5.6, A53): `on_track` ⇔ 5 × used < 4 × reference; `close_to_limit` ⇔ 4 × reference ≤ 5 × used and used < reference; `over` ⇔ used ≥ reference (AC-5.7–5.9, D87). With whole-number thresholds the floored percentage reads below 80, 80–99 and 100 or more exactly then (D92): a property the tests check, not an assumption | as above; and `null` (no state said) for a capacity package past its expiry, `currentPeriod.ended` (AC-5.25, D91), and for a `closed` or `cancelled` project (AC-5.26, D93) |
| **excess** | a package: `overByMinutes`, the AC-1.1 "Over by" — one figure for both (AC-5.12); a fixed price or time and material: `tenths = roundHalfUp((used − reference) × 10 / 480)`, the AC-1.6 rule, which equals used tenths − reference tenths since the reference is whole tenths; `0` tenths with a positive excess is `belowOneTenth`, "less than 0.1 man-day" (AC-5.13) | used ≤ reference (AC-5.9: exactly 100 % is over with no excess) |
| **bar** | positions in percent of the bar's **length**, its scale being 0–125 % of the reference (so 100 % sits at 80): `within = 80 × min(used, reference) / reference`; `beyond = min(80 × used / reference, 100) − 80`, drawn only when used > reference (an integer comparison, so exactly 100 % has no beyond part, AC-5.15) and ending at 100 from 125 % on while the percentage still reads in full (AC-5.16); marks fixed at 64 and 80, i.e. 80 % and 100 % (AC-5.14); a fixed price's estimate mark at `80 × e / m` (whole tenths) when `4e ≤ 5m`, both ends included (AC-5.17) | as for the percentage; the estimate mark for any other terms, a fixed price without an estimate, or an estimate beyond 125 % of the max effort |
| **time elapsed** | over a span `[from, to]`, both days counted: `days = to − from + 1`, `gone = clamp(asOf − from, 0, days)`, `⌊100 × gone / days⌋` (AC-5.20, A56); the span is the package's `currentPeriod` when the package has an end — yearly, or capacity with an expiry, an expired one included (100) — or, for a fixed price, from the terms' `startDate` to its `deadline` (AC-5.18, D90); the today mark at `0.8 × elapsed` | a capacity package without an expiry, time and material, a deadline before the start date (AC-5.19), no consumed percentage (AC-5.4), `asOf` absent or not `YYYY-MM-DD` (an older projects-api, R10) |
| **date signals** | a fixed price's `deadline`, then the terms' `endDate` (any client type), each on its own line even on the same day (AC-5.23): `d = date − asOf` in whole days; `d < 0` → passed by `−d` days, graver (AC-5.21); `0 ≤ d ≤ 30` → near, in `d` days, `0` said as today and not passed, milder (AC-5.22, D94); `d > 30` → nothing | a `closed` or `cancelled` project (AC-5.26); no terms, or no end date for that line; `asOf` absent or malformed. **Not** withheld when hours cannot be loaded, for a package not started or for terms that sold nothing comparable: a date signal reads the terms alone (AC-5.24) |

- **One day for every signal that reads today** (AC-5.29, D-P7): projects-api's `toTermsView` derives `currentPeriod` and
  returns `asOf` from the same `today` argument, so the period, "Expired", the time elapsed and each date signal are of one
  Europe/Zurich day, the day of the read. Day differences are integer calendar arithmetic on `YYYY-MM-DD` (a day number per
  date, for instance `Date.UTC(y, m - 1, d) / 86_400_000`); `consumption.ts` never reads a clock or a time zone (no `new
  Date()`, no `Date.now()`), so the browser's own day cannot leak in. The page keeps `asOf` until it reads the project
  again, as it keeps `currentPeriod`: case (e) of A52 and R8, accepted (D86).
- **Levels** (D87): `close_to_limit` and a near date are the milder level (a warning), `over` and a passed date the graver
  (a danger), `on_track` none, and `state: null` none. design.md maps each to complete token class strings and an icon:
  three states need three distinct icons and the two date kinds two (AC-5.10), and a status-dictionary icon is used only
  with its own meaning (design-system § Icons). `over` keeps one level, icon and tone whatever its words — "Limit reached"
  when its `excess` is null (used equal to the reference, exactly 100 %), "Over the limit" otherwise (D95; the copy is
  design.md's) — so the block picks them from `state` and `excess`, and `Share` gains no member (a flag would only restate
  `excess === null`). With no state said (`state: null`) the bar is neutral, never in the over tone: a tone without its
  words would be colour alone (AC-5.10). The spec names no tone for that case (AC-5.25, AC-5.26); this follows design.md's
  G10, which the owner confirmed (D96).
- **Is there a block** — one rule, `hasConsumptionBlock(terms, state)`: a compared or not-started variant, or at least one
  date signal. `HoursSection` draws the divider by it and `ConsumptionBlock` renders by it, so the two cannot disagree (the
  T16 rule, widened by AC-1.7's amendment): an SLA-only project whose end date has passed or is near now has a block of
  date lines alone; one with no end date, or one more than 30 days ahead, still has the widget alone.
- **What follows a Record hours save** (AC-5.28): the re-read of § Refreshing after Record hours changes the summary only,
  so the percentage, the state, the excess and the bar move; the time elapsed, the today mark and the date signals come
  from `asOf`, which only a new read of the project changes, and do not.
- **Formatting** (AC-3.2, F21): both percentages reach `formatNumber(p / 100, { style: 'percent', maximumFractionDigits: 0 })`
  as the already floored integer, so the formatter's half-up rounding has nothing left to round (R11); a number of days
  goes through `formatNumber`, its plural chosen by the strings function from the integer; the package excess through
  `formatDuration` (short for the eye, spoken for the reader: the block's `Duration`), the man-day excess through
  `formatNumber` with exactly one decimal, as AC-1.6.
- **The bar** is `ConsumptionBar` (D-P8): `aria-hidden`, drawn from `share.bar` by inline `style` widths and positions only,
  and every fact it shows is also text — the pace line (the consumed percentage and, when there is one, the time elapsed),
  the state, the excess, and the estimate's man-days in the facts (AC-1.4) — so the block reads complete without it
  (AC-5.11). Its labels, which design.md draws inside the `aria-hidden` root (S1.1, G7) — the scale's "80%", "100%" and
  "125%", "Today" at the today mark, "Estimate" at the estimate mark — are decoration of the drawing, never information
  only it carries: "80%" and "100%" name the thresholds the state words stand for, "Today" and "Estimate" the marks whose
  figures the pace line (the time elapsed) and the facts (the estimated man-days) state, "125%" the drawing's own end;
  none is a figure about the project. The estimate's own share of the max effort is not put in words: no AC asks for a
  second percentage of another base beside the consumed one, and the estimate is never the reference (D88). The beyond
  part is an element of its own, told apart from the fill before it by shape as design.md draws it, never by colour alone
  (AC-5.15).
- **No viewer input** (AC-5.27): no function takes a person, a role or a permission, and the block keeps only the two totals
  (`getHoursSummary`, T16), so every `projects:access` holder sees the same signals and none of them is per person.

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
   *US-5:* built from the commit that carries projects-ui's US-5 source, with no source change of its own (below, R13).
4. **hours-api** (summary; project filter and by-project placement). Deployed before step 1, every project filter would be
   a 503 (meetings-api answers 422 to `projectId`): fail closed but a broken view, so step 1 first.
5. **projects-ui, crm-ui** (embed the panel; consumption card).

**US-5 (2026-11-27) adds no step and moves none, but gives step 3 a condition.** It ships in the same release:
projects-api's `asOf` with step 1, projects-ui's signals with step 5; no change to `@operai/ui`, hours-api, hours-ui or
crm-ui (D-P8: the bar is projects-ui's own), and **no shell source change, but the shell is rebuilt and deployed from the
same commit as projects-ui**: step 3, before step 5, and independent of projects-api's step 1 (neither reads the other).
The suite has one Tailwind sheet, which the shell generates from every remote's source (`shell/src/index.css:15-28`; ADR
20260709-suite-frontend-module-federation, addendum 2026-07-10), and Tailwind emits only the classes a scanned source
holds. Seventeen of the bar's utilities are in no scanned source but the bar's own (checked 2026-11-27 over `shell/` and
every `@source`, and again after T24 against the implementation's class strings): `h-2.5`, `size-2`, `rotate-45`,
`-top-1.5`, `bottom-1`, `-translate-x-full`, a bare `ring-1` (only `focus-visible:ring-1` exists), `ring-ink`,
`ring-dim`, the stripes' `bg-linear-90`, `from-red`, `from-soft`, `from-50%`, `to-transparent`, `to-50%`,
`bg-size-[6px_100%]`, and, added by T24 (`decisions.md` § T24), `@max-[230px]:hidden`, a container query on the bar's
own width (`@container` is in the sheet already: crm-ui's offer wizard uses it) that drops the "125%" label from a bar
narrower than 230 px; missing on its own, it lets that label show and touch "100%" in a narrow bar (the card is 205 px
wide at a 360 px viewport, 165 at 320), every line still correct, never a wrong figure. The shell's own Tailwind (4.3.2;
design.md compiled the first sixteen with projects-ui's 4.3.3) generates each of them once a source holds it (compiled
against `tokens.css` the same day; the seventeenth compiled after T24, to `@container (width < 230px) { display: none }`).
In this release the shell is rebuilt from a commit that holds the bar anyway: this branch changes `shell/` (`hours.hostHours`)
and the release commit rewrites `shell/src/lib/suiteVersion.generated.json`, whether or not Vercel skips a project whose
directory did not change (infra/README.md says "every changed" frontend in its legal-entities section and "every Vercel
project" in § Project hours release). So the condition is what step 3 *confirms* (R13's check (2)), and what to redo by
hand if the shell is rolled back or a later push changes projects-ui alone. Skew: a projects-ui live before that shell (a
build that finishes first, a rolled-back shell, or a tab loaded before the shell's deploy that then mounts the new
projects-ui) draws every line of the block complete and right, their utilities being in the sheet already, and the bar
without its track, fill, beyond part or estimate diamond (zero height or size, no stripes, no outlines): its ticks, today
line and labels only, the "125%" label past the bar's end at every width (with `-translate-x-full` missing too, it starts
where it would otherwise end, clear of "100%"; read from the class list, not seen in a browser). A missing
drawing, never a wrong figure: the bar is `aria-hidden` and the lines say everything it shows (AC-5.11); AC-5.14–5.17's
drawing holds once the shell is live and the page reloaded (R13).

Skew with projects-api: a projects-ui live before projects-api finds neither `currentPeriod` nor `asOf` — an hour package
is not compared, as before; a fixed price's or time and material's block shows its percentage, state, excess and bar with no
time elapsed and no date line; an SLA-only project's date-only block does not show. Less, never wrong (R10). design.md uses
only shapes `@operai/ui`'s `Icon` already has (`check`, `alert`, `x-circle`, `calendar`), so no library change: a new shape
would reach projects-ui through the shell (step 3), and a projects-ui live before that shell would draw an empty glyph
beside words that still carry the signal. A new library *component* would need its own earlier push to `main` (AGENTS.md
§ Frontend, ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell) and a plan amendment (R9).

### Decisions this plan makes

Recorded as ADRs (see § ADR candidates): D-P1/D-P2 in `docs/adr/20261126-a-record-hours-summary-…`, D-P3/D-P4 in
`docs/adr/20261126-a-figure-set-against-another-owners-figure-…`, D-P5 in the 2026-11-26 amendment of
`docs/adr/20261112-time-bookability-asked-of-owners-meeting-hosts-system-route.md`. D-P7 (US-5, 2026-11-27) is a candidate
amendment of the D-P3/D-P4 ADR, not yet written; D-P8 and D-P9 apply rules that exist (§ ADR candidates says why).

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
- **D-P7 (US-5) Every signal that reads today reads the day projects-api states with the terms, `Terms.asOf`** (AC-5.29,
  D85, D94; § Signals on the consumption block). `toTermsView` already takes one `today` and gives it to `packagePeriod`; it
  now also returns it. projects-ui works out the time elapsed and the date signals from `asOf` by calendar arithmetic on
  `YYYY-MM-DD`, with no clock and no time zone, so the signals and the period are of the same day by construction, and the
  page keeps that day until it reads the project again (A52 (e), R8). It sits on the terms, not on the project: it dates
  `currentPeriod`, which every `TermsSchema` answer carries, the terms routes' answers included, and a project without
  terms has no date to judge. It is named `asOf`, not `today`: a page open the next day holds it as yesterday's, which is
  exactly what A52 (e) accepts, and the name should not claim otherwise. Chosen over: (a) the browser's own day in
  Europe/Zurich (the shape of `hours-ui/src/lib/todayZurich.ts`; `projects-ui/src/components/TaskModel.ts` `today()` even
  uses the local zone) — AC-5.29 asks for the period's day, and two clocks can straddle midnight (a page read at 23:59:59
  would show the 27th's period beside the 28th's date lines) or simply disagree (a wrong device clock); hours-ui uses its own
  day only for a guard the server re-checks; (b) projects-api deriving each signal (`elapsedPercent` on `currentPeriod` and on
  a fixed price's terms, days to the end date and to the deadline) — four derived members on the wire for two lines of
  arithmetic over a day it can simply state, and the block's rules split across two services, while the percentage, the
  state and the excess need the summary and so stay in the browser (D-P3); project-alerts would gain nothing it does not
  already have in `businessDay` and the stored dates; (c) a calendar route, or the HTTP `Date` header — a second read at
  another moment than the terms' (and `Date` is an instant in UTC that a cross-origin script cannot read without an
  `Access-Control-Expose-Headers` change); (d) no day at all — drops AC-5.18–5.24.
- **D-P8 (US-5) The bar is projects-ui's own component, `ConsumptionBar`, drawn for the eye only (`aria-hidden="true"`);
  the text says everything it shows** (AC-5.11, D86). Built from token utilities (`bg-*`, `border-*` and their opacity
  modifiers), the library's `Icon` where design.md places one, and inline `style` for widths and positions only (ADR
  20261031-one-styling-dialect-token-utilities); it computes nothing — its positions are `share.bar`. It needs no shell
  source change, but it does need the shell's build: the suite's one Tailwind sheet is generated by the shell from every
  remote's source, so the shell is rebuilt from the same commit in the same release, and a skew draws the bar incompletely
  while every line stays complete and right (R13), where a library export skewed loses the page. Chosen over: (a) a
  `Meter` in `@operai/ui` now — one app needs it (the signals are drawn nowhere else, a non-goal), and a new export a remote
  uses must first be live in the shell (AGENTS.md § Frontend, ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell):
  the release would become two merges to `main` (the legal-entities E10 shape), and a projects-ui live before that shell
  would import `undefined` and lose the whole project page to the shell's error boundary; this feature kept `Duration` and
  the disclosure private for the same reason (design.md § Component inventory) — lift the bar when a second app needs it;
  (b) extending `ProgressBar` (marks, a second segment, tones) — it is meetings-ui's and crm-ui's indicator of work moving
  to completion, `role="progressbar"`, clamped at its maximum by contract, and a change to it reaches those remotes at the
  next shell deploy, untested by them; (c) `role="meter"` on the drawing — it repeats the percentage the pace line already
  says, cannot expose the marks, the today mark or the estimate, needs a clamped `aria-valuenow` past 125 % with the real
  figure in `aria-valuetext`, and its support differs between screen readers; (d) the native `<meter>` — it cannot be
  styled alike across engines and has no second segment and no marks. If design.md needs a look an app cannot express in
  the dialect (a hatch pattern needs `var(--…)` or a component class), the bar moves into the library and § Deploy order
  gains a library-first push: a plan amendment, not a design-only change (R9).
- **D-P9 (US-5) The signals are pure functions in `lib/consumption.ts`, over the terms, the summary's two totals and the
  project's state** (§ Signals on the consumption block, § API contracts). `consumptionOf` gains a required `projectState`
  and a `share` on each compared variant; `dateSignalsOf` reads the terms alone (AC-5.24); `hasConsumptionBlock` is the one
  "is there a block" rule for `HoursSection`'s divider and `ConsumptionBlock`. All of it is integer arithmetic on whole
  minutes and tenths: the consumed percentage and the time elapsed are floored there and reach `formatNumber` as integers
  (D92, A56); the state, the excess and the bar are decided on the exact minutes (A53). Chosen over: (a) computing in
  `ConsumptionBlock` (AGENTS.md § Frontend: components receive data and do not compute; the boundary vectors need a pure
  seam); (b) a second signals module that reads the terms again — two readers of "what is compared" could disagree, and
  T15's `soldOf` is the one reader; (c) an optional `projectState` defaulting to active — a forgotten caller would show
  signals on a closed project (T12's precedent: required props); (d) leaving the floor to the formatter
  (`roundingMode: 'floor'` on `Intl.NumberFormat`) — D92 is a domain rule with vectors, not a display option, and the
  integer is also what the tests read; (e) judging the state on the floored percentage — equivalent under whole-number
  thresholds (D92), but AC-5.6 names the exact hours, and deciding on the exact minutes keeps the equivalence a property the
  tests check.

## Data model

No change in any database. Reads added:

- **hours-api**: the summary groups `time_entry` by `workTypeId` and by `userId` under `projectCondition` /
  `dealCondition`, optionally `day BETWEEN windowFrom AND windowTo`. Existing indexes `[projectId, day]`, `[dealId, day]`,
  `[meetingId]` serve it (`hours-api/prisma/schema.prisma:44-80`).
- **meetings-api**: `WHERE hostApp='projects' AND hostEntityType='project' AND hostEntityId=$1` on the existing
  `@@index([hostApp, hostEntityType, hostEntityId])` (`meetings-api/prisma/schema.prisma:186`).
- **projects-api**: `currentPeriod` is derived from `project_terms.hourPackage*` columns on read; never stored.
- **projects-api** (US-5): `asOf` is the business day of the read, returned with the terms; never stored, never an input.

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
- *US-5 (D-P7):* every response carrying `TermsSchema` — `GET /projects/{id}` and every answer built by `toProjectView`
  (create, update, transitions, team, the take), and the `POST`/`PATCH /projects/{id}/terms` answers — gains
  `asOf: "YYYY-MM-DD"`: the Europe/Zurich business day `toTermsView` derived `currentPeriod` for, from the same `today`
  argument. Required, never `null`, on every terms type (a time-and-material project's end date reads it too); derived on
  read, never stored, not part of the ETag (`version` stays the ETag). Not an input: the terms request schemas are
  `.strict()`, so a body carrying `asOf` stays `400 validation_failed`.

```ts
// projects-api TermsSchema (src/projects/projects.schemas.ts:73-80), US-5
{ id: string; type: ProjectType; startDate: string; endDate: string | null; terms: TermsView; version: number;
  asOf: string /* YYYY-MM-DD, Europe/Zurich, the day currentPeriod was derived for */ }
```

### projects-ui — `lib/consumption.ts` and the block's props (US-5; in-app, the contract its tests and design.md read)

```ts
// lib/types.ts — the terms as read; `asOf` absent from a projects-api that predates US-5
type TermsOf<Type, View> = { id; type; startDate; endDate; terms: View; version; asOf?: string }

// lib/consumption.ts — still pure, still `import type` only (HourPackageKind, ProjectState, Terms); whole minutes, whole tenths
export const CLOSE_TO_LIMIT_PERCENT = 80  // D87; the same as specs/20261112-project-alerts AC-1.1, AC-1.6
export const OVER_PERCENT = 100           // D87
export const SCALE_END_PERCENT = 125      // D86: the bar's end
export const NEAR_DAYS = 30               // D89; the same as project-alerts AC-1.4
export const BAR_MARKS = { closeToLimit: 64, over: 80 } as const   // percent of the bar's length

export type ConsumptionState = 'on_track' | 'close_to_limit' | 'over'   // the spec's "state" (not a project state)
export type Level = 'milder' | 'graver'
export function levelOfState(state: ConsumptionState): Level | null    // on_track → null

export type Excess =
  | { unit: 'hours'; minutes: number }                             // a package; minutes > 0, = overByMinutes
  | { unit: 'man_days'; tenths: number; belowOneTenth: boolean }   // fixed price, t_and_m; belowOneTenth ⇔ tenths === 0

export type Share = {
  consumedPercent: number               // integer ≥ 0, uncapped (AC-5.5)
  state: ConsumptionState | null        // null: an ended capacity package (AC-5.25), a closed or cancelled project (AC-5.26)
  excess: Excess | null                 // null at or below the reference (AC-5.9, AC-5.12)
  elapsedPercent: number | null         // integer 0–100; null: no span with an end (AC-5.19) or no usable asOf
  bar: {
    within: number                      // 0–80
    beyond: number                      // 0–20; > 0 exactly when used > reference
    estimate: number | null             // 0–100; a fixed price only (AC-5.17)
    today: number | null                // 0–80, = 0.8 × elapsedPercent; null with it
  }
}

export type Consumption =                // T15's variants, unchanged but for `share`
  | { variant: 'none' }
  | { variant: 'package_not_started'; kind; packageMinutes; startDate }   // no share (AC-5.4)
  | { variant: 'unavailable' }                                             // no share (AC-5.4)
  | { variant: 'package'; kind; packageMinutes; period; ended; usedMinutes; leftMinutes; overByMinutes; share: Share | null }
  | { variant: 'fixed_price'; usedTenths; estimatedTenths; maxEffortTenths; share: Share | null }
  | { variant: 't_and_m'; usedTenths; plannedTenths; share: Share | null }
// share is null only for a reference not above zero (AC-5.4)

export function consumptionOf(terms: Terms | null, summary: SummaryFigures | null, projectState: ProjectState): Consumption
export function summaryRequestOf(terms: Terms | null): SummaryRequest | null   // unchanged: a re-read asks the same window

export type DateSignal = {
  which: 'deadline' | 'end_date'
  date: string                          // YYYY-MM-DD, shown with formatDate
  when: 'passed' | 'near'
  days: number                          // passed: ≥ 1, days since; near: 0–30, days to go (0 = today, D94)
  level: Level                          // passed → graver, near → milder
}
export function dateSignalsOf(terms: Terms | null, projectState: ProjectState): DateSignal[]   // deadline first; [] when none
export function hasConsumptionBlock(terms: Terms | null, projectState: ProjectState): boolean
export function elapsedPercentOf(span: { from: string; to: string }, asOf: string): number | null   // null when to < from

// components (projects-ui/src/components)
HoursSection({ projectId: string; terms: Terms | null; state: ProjectState })      // ProjectDetailPage passes project.state
ConsumptionBlock({ projectId: string; terms: Terms | null; state: ProjectState })
ConsumptionBar({ share: Share })                                                    // computes nothing; aria-hidden
```

An `asOf` that does not match `^\d{4}-\d{2}-\d{2}$` is read as absent: no time elapsed and no date signal, never a guess.

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
| AC-1.9 | unit + component | `packagePeriod` capacity past its expiry → `ended: true`; yearly and unexpired → `false`; `ConsumptionBlock` shows the "Expired" `StatusBadge` only when `ended`; a page open across the expiry shows it only once it reads the project again (Risk R8, accepted); *amended 2026-11-27:* `ended` → `share.state` null, with the percentage, the excess and the bar kept and no state words drawn (AC-5.25) |
| AC-1.4 | unit + component | `consumptionOf` fixed price with and without `estimatedManDays`; `ConsumptionBlock` leaves the estimate out when null |
| AC-1.5 | unit | `consumptionOf` T&M: Σ planned man-days vs used, no per-position figure |
| AC-1.6 | unit | man-day vectors in integer arithmetic: 480 min → 1.0; 30 min → 0.1 (0.0625); 24 min → 0.1 (0.05, half up); 23 min → 0.0; 3 600 min → 7.5; shown with `formatNumber` at one decimal |
| AC-1.7 | unit + component | a project without terms; or one whose terms are an SLA and no hour package (D82) and whose end date is absent or more than 30 days ahead, or which is closed or cancelled: the Hours card holds the widget alone (no consumption block, no divider), and the total shows without opening the breakdown; *amended 2026-11-27:* SLA-only terms whose end date has passed or is near → `hasConsumptionBlock` true, the block holds the date line alone (no figure, bar, percentage or state) and the divider shows (D89, AC-5.24); no terms → never a block |
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
| AC-3.2 | unit + component | `catalogGaps` parity + no-hardcoded-copy scans in hours-ui, projects-ui, crm-ui; formatters only (`formatDuration`, `formatNumber`, `formatDate`); *amended 2026-11-27:* both percentages through `formatNumber(p / 100, { style: 'percent', maximumFractionDigits: 0 })` from the floored integer, in en and it (99 → "99%", 116 → "116%", 1 234 → "1,234%" / "1234%"), numbers of days through `formatNumber` with the plural chosen from the integer, and each strings function takes the formatted value (R11) |
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
| AC-5.1 | unit + component + e2e | `consumptionOf` package: 84 h 30 (5 070 min) in the window of a 120 h package → `consumedPercent` 70, read from `windowMinutes`, not `totalMinutes`; the block shows "70%"; e2e E: the yearly package's percentage equals the oracle over the period's minutes |
| AC-5.2 | unit | fixed price: 72 h against 12.0 man-days → 75, the same with and without `estimatedManDays` (the estimate is never the base, D88) |
| AC-5.3 | unit | time and material: 60 h against 10.0 + 14.0 → 31 (Σ in tenths, then × 48 minutes) |
| AC-5.4 | unit + component | no `share` for `none`, `package_not_started` and `unavailable`, and `share: null` for a reference not above zero (hand-built terms, `hours: 0`); the block then draws no bar, percentage, pace line, state, excess or time elapsed (its date lines aside, AC-5.24) |
| AC-5.5 | unit | floor by integer division, all of 120 h (7 200 min): 4 500 → 62, 7 170 → 99, 8 370 → 116, 8 430 → 117, 12 960 → 180, 30 → 0, 0 → 0, 7 200 → 100, 7 271 (100.99 %) → 100, 7 272 (101 %) → 101 |
| AC-5.6 | unit | 19 h against 3.0 man-days (1 440 min) → 79 and `on_track` while `usedTenths` is 24 (2.4); property over every used minute from 0 to 2.5 × reference, for references 7 200, 1 440, 528 and 11 520: floor below 80 ⇔ `on_track`, 80–99 ⇔ `close_to_limit`, 100 or more ⇔ `over` (D92) |
| AC-5.7 | unit + component | 5 730 of 7 200 (79 %) and 0 → `on_track`; the block says it in words, with its icon |
| AC-5.8 | unit + component | 5 760 (exactly 80 %) and 7 170 (99 %, 30 min left) → `close_to_limit`; words, icon, milder level |
| AC-5.9 | unit + component | 7 200 of 7 200 → `over`, `consumedPercent` 100, `leftMinutes` 0, `excess` null; 7 230 → `over`, `consumedPercent` 100, `excess` `{ unit: 'hours', minutes: 30 }`; a fixed price at exactly its max effort (5 760 min against 12.0) → `over`, `excess` null, and 1 min above it → `{ unit: 'man_days', tenths: 0, belowOneTenth: true }`; graver level in all four. Component (D95): the state line reads design.md's "Limit reached" at 7 200 of 7 200 and at the fixed price's exact max effort, with no excess shown, and "Over the limit" at 7 230 (beside "100%", the floor) and 1 min above the max effort (beside "less than 0.1 man-day"), with the same icon and the same tone in all four, and in it (the `HoursSection.it.test.tsx` harness) "Limite raggiunto" at 7 200 and "Oltre il limite" at 7 230: the words follow `state === 'over'` and `excess === null`, never the percentage or the man-days shown |
| AC-5.10 | component | each state and each date signal renders its words and an icon; the icon map gives the three states three distinct icons and the two date kinds two (design.md picks them); no state, level or excess is carried by a class alone |
| AC-5.11 | component | the `ConsumptionBar` root is `aria-hidden="true"`, and every text inside it is decoration the lines and facts repeat, never information only the bar carries: the root's text is exactly the closed set of its labels (design.md S1.1, G7) — "80%", "100%" and "125%" (`formatNumber` of the constants), "Today" only with a today mark, "Estimate" only with an estimate mark — and never the consumed percentage, an excess, a day count or a date; whenever the bar shows "Today" the pace line states the time elapsed, and whenever it shows "Estimate" the facts hold "Estimated man-days"; "80%" and "100%" are the thresholds the state words stand for, "125%" the drawing's own end; the pace line holds the percentage and, when present, the time elapsed; the state and the excess are text; axe on the loaded states (the `HoursSection.test.tsx` harness) |
| AC-5.12 | unit + component | package: `excess` = `overByMinutes`, in hours (the "Over by" fact); fixed price 108 h against 12.0 → 112 and 15 tenths ("1.5 man-days"); time and material likewise; property: the man-day excess = `usedTenths` − reference tenths whenever positive |
| AC-5.13 | unit + component | 9 h against 1.1 man-days (528 min) → `{ tenths: 0, belowOneTenth: true }`; 23 min over → below; 24 min over → 1 tenth (half up); the block reads "less than 0.1 man-day", never "0.0" |
| AC-5.14 | unit + component | 7 200 of 7 200 → `within` 80, `beyond` 0; 0 → 0; `BAR_MARKS` 64 and 80; the component sets widths and positions through `style` only, from `share.bar` |
| AC-5.15 | unit + component + e2e + QE | `beyond` > 0 exactly when used > reference (7 200 → 0, 7 201 → above 0); the beyond part is its own element, absent at exactly 100 %; QE screenshots in light, dark and greyscale show it told apart by more than colour; e2e F finds its stripes in the shell's built sheet (R13) |
| AC-5.16 | unit + component | 9 000 (125 %) → 80 + 20, nothing cut; 12 960 (180 %) → 80 + 20 with `consumedPercent` 180 and the text "180%" |
| AC-5.17 | unit | estimate 10.0 / max 12.0 → mark at 66.67 of the bar (83 % of the reference); 0 → 0; 15.0 / 12.0 → 100; 15.1 / 12.0 → `null`; no estimate, a package, time and material → `null`; `estimatedTenths` unchanged in the facts |
| AC-5.18 | unit + component | yearly: elapsed over `currentPeriod` at `asOf`; capacity with an expiry, before and after it (expired → 100); fixed price over `[startDate, deadline]`; `bar.today` = 0.8 × elapsed; the pace line states both figures |
| AC-5.19 | unit + component | capacity without an expiry, time and material, a deadline before the start date → `elapsedPercent` and `bar.today` null, the pace line the percentage alone; no `share` → no pace line |
| AC-5.20 | unit | `elapsedPercentOf` over 2026-03-01…10: 02-28 → 0, 03-01 → 0, 03-05 → 40, 03-10 → 90, 03-11 → 100, 12-31 → 100; over 2026-03-01…2027-02-28 (365 days): last day 99, the day after 100; over 2027-03-01…2028-02-29 (366): last day 99; a one-day span: 0 on it, 100 the day after; a span across a year end; `to < from` → null |
| AC-5.21 | unit + component + e2e | `dateSignalsOf` at `asOf` 2026-11-27: end date 11-26 → passed 1, graver; 2026-05-11 → passed 200; a deadline likewise; e2e F: the passed end-date line |
| AC-5.22 | unit + component + e2e | 11-27 → near 0, said as today, not passed (D94); 12-27 → near 30; 12-28 → nothing; across a year end (2026-12-15 → 2027-01-14 is 30) and over a 29 February; milder; e2e F: the near deadline line |
| AC-5.23 | unit + component | a fixed price whose deadline and end date fall on the same day → two signals, the deadline first; terms without an end date → no line for it |
| AC-5.24 | unit + component | `dateSignalsOf` takes no summary; the block shows its date lines beside the "Consumption is unavailable" banner, while loading, for a package not started and for SLA-only terms |
| AC-5.25 | unit + component | `ended: true` → `state` null with `consumedPercent` 117, the excess and the bar kept, the bar in the neutral tone and no state's class (AC-5.10; design.md G10), beside "Expired"; on the expiry day itself (`ended: false`) the state is said |
| AC-5.26 | unit + component + e2e | `closed` and `cancelled` → `state` null and `dateSignalsOf` → `[]`, the percentage, the bar (neutral, as AC-5.25) and the time elapsed kept; `planned`, `active`, `on_hold` → said; a closed SLA-only project with a passed end date → no block; e2e F: after the project is closed and the page reloaded, no state and no date line, the percentage stays |
| AC-5.27 | unit + component + e2e | no function takes a person, a role or a permission (signatures); `HoursSection`'s props are `{ projectId, terms, state }`; the block keeps only the two totals (`getHoursSummary` key-set test, T16); e2e B: the PM and the other reader see the same percentage and state |
| AC-5.28 | component + e2e | an `operai:time-entry-recorded` re-read with more minutes moves the percentage, the bar, the state and the excess, while the time elapsed, the today mark and the date lines stay (same `asOf`) — this also pins A52 case (e), where the eval found no test pinning A52; e2e E: Record hours 1 h moves the percentage, not the time elapsed |
| AC-5.29 | unit + integration + component | projects-api: `asOf` on `GET /projects/{id}`, on a `toProjectView` write answer and on the terms `POST`/`PATCH` answers, equal to the day `currentPeriod` was derived for (the clock seam at 23:30Z on the eve of an anniversary: both of the next Zurich day; `projects.test.ts` beside its `currentPeriod` cases, `terms.test.ts`); projects-ui: a source test (`consumption.ts` has no `Date.now(` and no `new Date(`), signals unchanged under fake timers set to another day and another `TZ`; `asOf` absent, empty or malformed → no time elapsed, no date signal |

Also: meetings-api route tests for `projectId` (exactly-one rule, 422, scope, `sub` allowlist, only project-host meetings
returned); crm-api resolve test for `ownerUserId`; shell `extensions` test for the new name; `HostHours` throws on an
invalid prop set; `openapi.contract.test.ts` for the new route.

*US-5 (2026-11-27):* e2e **E** (the yearly package of journeys A–C): the block's percentage and state follow the fixture's
minutes, and its pace line's time elapsed equals an oracle the spec computes from projects-api's `asOf` and `currentPeriod`
by AC-5.20's rule (the setup test reads both, as it reads `currentPeriod` today); after C's Record hours save of 1 h the
percentage moves and the time elapsed does not (the fixture's minutes are chosen so that 1 h moves the floored figure).
**F** (new): a hand-made, active `fixed_price` project with a max effort of 1.0 man-day, an estimate of 0.9 man-day and 9 h
recorded, its terms starting 60 days before the fixture's Zurich day, ending the day before it, and a deadline 10 days after
it: over, 112 %, "0.1 man-day" over, a passed end-date line and a near deadline line, each day count computed from the
API's `asOf`, not from the runner's clock, so a fixture that straddles midnight still agrees. Since component tests run
with no stylesheet, F also reads in the browser the computed styles that only the bar's utilities new to the suite give
(R13): the track row 10 px high, the beyond part's `background-image` a `linear-gradient` with `background-size`
`6px 100%`, and the estimate diamond 8 px wide with a ring (`box-shadow` not `none`), through test ids the block task adds
(`project-hours-consumption-bar-track`, `-bar-beyond`, `-bar-estimate`; design.md names the root only). Then the project is
closed through the API and the page reloaded: the percentage and the bar stay, no state and no date line. projects-api: the
`asOf` cases above; a terms body carrying `asOf` stays 400. QE visual pass: on track, close to the limit, over beyond
125 %, expired and closed, with date lines, at 320 and 1280 px, light and dark, en and it, plus one greyscale capture; the
fills and marks measured (R12).

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
  `packagePeriod` lives in projects-api now; the man-day rule is one line, recorded here for that spec. *Since US-5
  (2026-11-27):* the signals add rules project-alerts will also run server-side, with the same values by decision — 80 % and
  100 % on the exact hours (D87, A53), 30 days with a date's own day as today (D89, D94). They live in `consumption.ts` as
  named constants beside their vectors (§ Test strategy AC-5.5–5.9, AC-5.21–5.22), which that spec's plan should adopt as
  its own; its day is `businessDay`, which projects-api already has. Signal: a date or a threshold on which the card and an
  alert task disagree.
- **R7 Per-person hours of people outside the team** (A49) reach the project manager. Accepted by the owner (A49); part of
  the labour-law sign-off O3 of specs/20261112-time-tracking (hours visible to someone other than the person).
- **R8 A project page open across Zurich midnight keeps the package period, and since US-5 the signals that read
  today, of the day it read the project on** — projects-api derives `currentPeriod` (`from`, `to`, `ended`, or `null`
  before the start) for the Europe/Zurich day of the read (`packagePeriod`,
  `projects-api/src/terms/packagePeriod.ts:68-87`, § Consumption); projects-ui draws the consumption block from it and
  sends it as the summary's window (`summaryRequestOf`, `projects-ui/src/lib/consumption.ts:107-118`, T15; the summary
  takes `windowTo` only together with `windowFrom`, § API contracts), and every later read of the block — after a
  Record hours save (AC-2.8) or a Retry — asks the same window. Only a new read of the project moves it: a reload, or
  a write on the page that answers with the project or reads it again (details, team, state, terms, purchase order;
  `projects-ui/src/pages/ProjectDetailPage.tsx:130-142`). One cause, five cases, the fifth since US-5: (a) **a
  capacity package without an expiry** is counted up to the day of the read, so hours dated later stay out of the
  block — used too low, so left too high or "Over by" too low — while the `hours.hostHours` panel's total in the same
  card, read without a window, includes them (AC-1.3, AC-2.8); (b) **a yearly package's anniversary** passing leaves
  the block on the period that has ended, and a save dated in the new period does not move it (AC-1.1, AC-1.2,
  AC-2.8); (c) **a package's start date** arriving leaves the block saying the package has not started, and the block
  asks no summary then, so a save has nothing to re-read (A51, AC-2.8); (d) **a capacity package's expiry** passing
  shows the "Expired" mark only once the page reads the project again, its figures right all along, since the window
  is `[start, expiry]` before and after (AC-1.9); (e) **the signals that read today** (US-5, D86): the time elapsed,
  the today mark and each date signal come from `asOf`, the day of the read (D-P7), so after midnight a date that is
  today still says today, a date 31 days ahead does not yet show as near, a date that passes at midnight is not yet
  said to have passed, and the today mark does not move, while the percentage, the state and the excess follow the
  hours and are right (AC-5.28, AC-5.29); (e) shows each date with a day count from the read's day. Only (a) is an
  under-count, and only (a) has no date on screen to show it: the block says "From <start>, no expiry", while (b)–(d)
  show the period's end, the start date or the expiry, which a reader can set against the day. Until the project is
  read again, AC-1.1's current period, AC-1.3's "today", A51's start and AC-1.9's expiry are judged on the day of the
  read, and AC-2.8 holds for the panel, not for the block, in (a)–(c). Accepted and documented by the owner's
  decisions of 2026-11-27 (D85, A52; (e) with D86). Rejected: computing the Zurich day, and with it the period, in the
  browser (the day and the period are the server's to decide, D-P3; it would take a second `packagePeriod`); letting
  `GET /time-entries/summary` take `windowFrom` alone (a contract and hours-api change for a rare case, and it would
  mend (a) only); re-reading the project on every `operai:time-entry-recorded` naming it, so `currentPeriod` refreshes
  (one more projects-api read per save, more than the cases are worth for now) — **the way out if the limitation ever
  matters**: it mends all five at the next save on the page (the re-read brings a new `asOf` too, and AC-5.28's "do
  not change" would then be amended), as the re-read after a terms write does today (`ProjectDetailPage.tsx:137-142`),
  a projects-ui change with no API change; a page where nothing is saved still keeps the day of its read until it
  reads the project again. Signal: on a page not reloaded since before a Zurich midnight, a Record hours save that
  moves the panel's total and not the block (a)–(c), or a date on the block that the day has reached or passed with
  nothing changed in the block (b)–(e); a reload corrects each.
- **R9 The bar is drawn by projects-ui within the styling dialect** (D-P8). design.md could ask for a look an app cannot
  express — a hatch pattern needs `var(--…)` or a component class in `tokens.css` — which would move the bar into
  `@operai/ui` and add a library-first push to the release (a projects-ui on a shell without the export loses the page to
  the error boundary). Mitigation: D-P8's constraints go to the designer with this plan (§ Notes for the task re-sync); the
  beyond part can be told apart by shape (an outline, a separated segment) and by words, which token utilities draw. Early
  check: the designer's amendment is read against D-P8 before the block task starts; `pnpm lint` (the design-token rule)
  refuses `var(--` and colour values in projects-ui.
- **R10 An older projects-api without `asOf`.** A projects-ui live before projects-api (step 1) gets no `asOf` (nor
  `currentPeriod`): no time elapsed, no date signal, and an SLA-only project's date-only block does not show; a fixed
  price's or time and material's percentage, state, excess and bar do. Less, never wrong. Mitigation: § Deploy order; an
  absent or malformed `asOf` reads as no day. Early check: unit vectors for an absent, an empty and a malformed `asOf`.
- **R11 A floored figure re-rounded by the formatter.** `formatNumber(…, { style: 'percent' })` is a plain
  `Intl.NumberFormat`, which rounds half up (F21): fed the exact ratio, 119 h 30 of 120 h would read "100%" beside "close to
  the limit", the contradiction D92 removed. Mitigation: the floor is `consumption.ts`'s, and the formatter receives the
  integer over 100 with `maximumFractionDigits: 0`. Early check: vectors through the real formatter in en and it (99.58 % →
  "99%", 100.99 % → "100%", 116.25 % → "116%").
- **R12 Colour alone, and non-text contrast.** The levels' tones (`--org`, `--red`, which are not text tones in the light
  theme) fill the bar and its marks: a reader who cannot tell them apart must still get every state (AC-5.10, AC-5.15), and
  a fill or a mark below 3:1 against the track fails WCAG 1.4.11. Mitigation: words and an icon per state and per date
  kind, the beyond part told apart by shape, text only in `*-text` tokens or library components. Early check: QE measures
  the fills and marks in both themes, as it measured the card's text (lowest 4.87), and takes one greyscale capture.
- **R13 The bar's utilities reach a page only through a shell built from a commit that holds them** (design.md G8). The
  suite's one Tailwind sheet is the shell's (§ Deploy order), so seventeen of `ConsumptionBar`'s utilities, used nowhere
  else in the suite, exist on a page only once the shell is built from a commit that carries projects-ui's US-5 source;
  before that the block's lines are complete and right and the bar is drawn without its track, fill, beyond part or
  estimate diamond. It happens when the two Vercel builds of one push finish in no fixed order (minutes); a shell is
  rolled back or promoted to an older deployment while projects-ui stays on US-5; a tab loaded before the shell's deploy
  then mounts the new projects-ui (the sheet is the document's, read once; a reload clears it); or, later, a push changes
  projects-ui alone with a utility new to the suite and may not rebuild the shell before the next release commit.
  Mitigation: § Deploy order step 3's condition, confirmed live before step 5; the shell and projects-ui rolled back
  together, never the shell alone past this release. A missing drawing, never a wrong figure: the bar is `aria-hidden` and
  the lines say everything it shows (AC-5.11). Early checks: (1) before the release, e2e F (§ Test strategy), whose shell is
  served by `build && preview` from the same tree, reads the computed styles only these utilities give, so a utility the
  shell's Tailwind does not generate (a typo, an unsupported class, a dropped `@source`) fails the run, which a component
  test cannot see (jsdom applies no stylesheet); (2) at step 3, the live shell's sheet holds the bar:
  `for css in $(curl -s https://operai.welld.io/ | grep -oE '/assets/[^"]+\.css'); do curl -s "https://operai.welld.io$css"; done | grep -c 'bg-linear-90'`
  prints 1 or more (0: the live shell predates the bar), beside RELEASING.md's `version.json` check. Neither check changes
  for the seventeenth utility, `@max-[230px]:hidden` (T24): it hides a label and draws no part of the bar, so (1) has
  nothing of it to read (F runs at the suite's Desktop Chrome viewport, 1280 px wide, where the bar is wider than 230 px
  and the label shows either way), and it came in with `bg-linear-90` in one file and one commit (`d30ba888`), so a live
  sheet in which (2) finds `bg-linear-90` holds it too. Its absence alone would only let "125%" touch "100%" in a narrow
  bar; what guards it is the component test (the class on the label, `ConsumptionBar.test.tsx`), the shell's 4.3.2
  compile (§ Deploy order) and QE's visual pass at 320 px (§ Test strategy), where the label is gone. Signal: a block
  whose state and pace lines read and whose bar shows ticks and labels over no track.

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

**US-5 (2026-11-27): no new surface; the flag above is unchanged.** `asOf` is the server's calendar day, no personal or
record data. The signals are arithmetic over what every `projects:access` reader already sees (AC-1.8, AC-5.27): the terms
and the summary's `totalMinutes` / `windowMinutes`, never `byPerson` (projects-ui's client keeps only the two totals,
`projects-ui/src/lib/hoursApi.ts`, T16). No new request, route, input, storage, outbound call or log line; the bar and the
lines render no user text, no `href` and no HTML. `asOf` is not an input (the strict request schemas refuse it). The
feature's flag stays YES, so the owasp-reviewer pass scheduled with QE for the re-sync covers the amendment too, with two
added points: no per-person figure reaches a signal, and `asOf` is refused as input. The open owasp low (the block
receives `byPerson` on the wire for a project manager and discards it) is unchanged and still the owner's.

## Notes for the task re-sync (2026-11-27, US-5)

Not tasks: tasks.md is re-derived once the owner approves this plan. What the re-sync must carry:

- **Order.** design.md first (the designer, below). Then, in parallel, [BE] projects-api `asOf` (`src/terms/terms.ts`
  `toTermsView`, `src/projects/projects.schemas.ts` `TermsSchema`; tests in `src/terms/terms.test.ts` and
  `src/projects/projects.test.ts`, run against a scratch `DATABASE_URL`, never the dev database) and [FE] the pure functions
  (`projects-ui/src/lib/consumption.ts`, `types.ts`, `consumption.test.ts`; `asOf?` is optional in the type, so this task
  does not wait for the BE one). Then [FE] the block (`components/ConsumptionBar.tsx` new, `ConsumptionBlock.tsx`,
  `HoursSection.tsx`, `pages/ProjectDetailPage.tsx`, `strings/project.ts` en + it, and their tests
  `ConsumptionBlock.test.tsx`, `HoursSection.test.tsx`, `HoursSection.it.test.tsx`), after design.md and the pure task.
  Then [QE] the e2e journeys E and F and [DOCS], below. T20 (close) waits for all of them.
- **Existing tests that change on purpose:** `consumption.test.ts`'s "no money anywhere" pins the one import line (it gains
  `ProjectState`, still `import type`); every `consumptionOf` call gains the state; `HoursSection.test.tsx`'s "no comparable
  terms: widget alone" splits by end date (AC-1.7 amended); T3's exact-shape terms assertions in projects-api gain `asOf`.
- **design.md (the designer), before the block task.** Reverse S1's "'Exceeded' has no status colour" and "No progress bar"
  (D86, ledger F16) and design, within D-P8: the bar (the tone per level, the beyond part told apart by shape, the 80 % and
  100 % marks, the today and estimate marks), the pace line, the state line, the excess, the date lines and their order under
  the facts; where the date lines sit in the loading and "Consumption is unavailable" states (they need no hours, AC-5.24);
  a block of date lines alone (SLA-only); the icons (AC-5.10); the copy, en and it (plural days, "today", "less than 0.1
  man-day"); accessibility (the bar `aria-hidden`, what is read in which order, 320 px); and the AC coverage rows for
  AC-5.x. **The eval's design follow-up, in the same pass:** strike or fold the passages § Gap resolutions already overrides
  (eval-report § Design fidelity: design.md lines 56, 167, 301, 419, 430 and 522 — "negative when exceeded", "−4 h 30",
  "Nothing in the widget changes…", the "expired" cue and the Refresh action under "not designed", the spoken "over" twin,
  the `leftSpoken` / `overSpoken` copy row) and set its `status`.
- **The shell (design.md G8, R13): no shell task, since no shell source changes.** What the tasks carry instead: the
  block task gives the bar's track row, beyond part and estimate mark the three test ids e2e F reads
  (`project-hours-consumption-bar-track`, `-bar-beyond`, `-bar-estimate`); the [QE] task gives F its estimate of 0.9
  man-day and the computed-style assertions; the [DOCS] task, in infra/README.md § Project hours release, gives the
  `shell` row of the pieces table a US-5 note (no source change; rebuilt from the release commit, so its sheet holds the
  bar's utilities), gives step 3 its confirm check (R13 (2)), and adds a "What a wrong order does" row: `projects-ui` (5)
  live before a shell built from the release commit (3) → every line right, the bar drawn without its track, fill, beyond
  part or estimate diamond, cleared by the shell's deploy and a reload. No changeset change: the existing one already
  selects `@operai/shell` (for `hours.hostHours`).
- **[DOCS] — the eval's other follow-up, then US-5.** The "known limitation" sentence describes only case (a) of A52 in all
  three places T19 wrote it: `.changeset/project-hours-card-and-consumption.md` (the "Known limitation" bullet), AGENTS.md
  (the Consumption paragraph, lines 77–79) and infra/README.md (§ Project hours release, after "What a wrong order does",
  lines 3915–3917). Widen each, in one sentence, to the five cases (a)–(e) of A52 and R8. In the same three places add US-5:
  the changeset (projects-api's `asOf`, projects-ui's signals; the branch is unreleased, so editing the existing changeset
  keeps one release note, `@operai/projects-api` and `@operai/projects-ui` staying `minor`), AGENTS.md (the Consumption
  paragraph and the `consumption` row of § Domain language's Time tracking table, line 863) and infra/README.md (the
  projects-api row of the pieces table, and the "`projects-ui` (5) before `projects-api` (1)" row of "What a wrong order
  does": no time elapsed and no date line either). The glossary already holds the US-5 terms.

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

Candidate 2026-11-27 (US-5), not yet written:

- **Amendment of ADR 20261126-a-figure-set-against-another-owners-figure-… — the day a figure was derived for travels with
  it** (D-P7). A service that derives a figure from today (`currentPeriod`) states that day beside it (`Terms.asOf`), and
  the screen that composes the comparison judges every companion signal that reads today (the time elapsed, a date that is
  near or has passed) against that stated day, never against its own clock or another read. Rejected: the browser's
  Europe/Zurich clock (fit only for a guard the server re-checks, as hours-ui's form uses it; here it can straddle midnight
  against the server's period and puts two days on one card), projects-api deriving each signal (four derived members, and
  the block's rules split across two services while the percentage and the state must stay in the browser, D-P3), a
  calendar route or the `Date` header (a second read, another moment). Constrains: any later derived-on-read figure with a
  today-dependent companion carries its `asOf` (project-alerts' server path, a future projects-list signal). Predicted path:
  § Amendment 2026-11-27 of `docs/adr/20261126-a-figure-set-against-another-owners-figure-is-composed-by-the-screen-of-the-owner-of-the-comparison-and-a-panel-about-one-tools-data-is-that-tools-widget.md`,
  which § Decisions D-P7 points to; at `production` the caller dispatches the `adr-writer`.
- **Not ADRs:** D-P8 (the bar is app-local) applies AGENTS.md § Frontend ("a pattern a second app needs goes into the
  library") and ADR 20261114-operai-ui-shared-singleton-provided-by-the-shell's live-shell rule without adding to them, and
  names its trigger (a second app, or a look the dialect cannot draw in an app); D-P9 (pure functions, the floor before
  the formatter) implements the owner's D87–D94, which the ledger records. Nor is R13 a decision of this plan: it applies
  ADR 20260709-suite-frontend-module-federation's addendum of 2026-07-10 (one shell-owned Tailwind sheet). That
  addendum's Consequences name only the `@source` line a new remote needs, and its Option A still says a remote
  redeploys "with no shell … rebuild required", which holds for code and not for a utility no scanned source held
  before. Recording that in the addendum is a one-paragraph amendment for the caller to weigh; it decides nothing new
  and rejects no alternative, so it is not dispatched as an ADR.
