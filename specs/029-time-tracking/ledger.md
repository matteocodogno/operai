---
topic: Time tracking — the hours employees spend on company work (projects, pre-sales, meetings, unmapped work)
grilled: 2026-11-12
target: specs/029-time-tracking/spec.md
complete: true
---

## Decision ledger — time tracking

Moved here from `.forge/grill/time-tracking.md` when specs/029 was written (2026-11-12).

Decision map (parents first; re-drawn after D1, all branches closed):
- B1 Coverage — D2, D3, D4, D5
  - B1a Completeness — D23
  - B1b Unmapped work — D18; B1b-i derivation — D18 (revised), D19; B1b-ii work type — D20
  - B1c Contractual hours per person — moot after D23
- B2 Concept: time entry vs activity — D6, D7
- B3 Comparison with what was sold — D10
  - B3a Timing — D11 (specs/030)
  - B3b Grain — D13
  - B3c Man-day ↔ hours — O1 (specs/030)
  - B3d Yearly package carry-over — O2 (specs/030)
- B4 Who books — D14; B4b where — D16
- B5 Granularity — D8
- B6 Hours from meetings — D17
- B7 Corrections and locking — D24, O4
- B8 Visibility — D9; B8a manager — D21; B8b project and deal pages — D22
- B9 Global view and export — D25
- B25 Amending specs/025 — D15 (nothing to amend)

Decided (the user chose):
- D1 Purpose: record the time employees spend on company work — development on projects, pre-sales, meetings and more; "consumo di ore" did not mean consumption against what was sold (that is B3) — user, 2026-11-12
- D2 Coverage (B1): all work, client and internal; absences (holidays, sickness, permits) are not booked — user, 2026-11-12
- D3 Contractual working time is 42 hours a week, Monday to Friday (8 h 24 min a day); an employee who is present must be able to book hours for the whole contractual day — user, 2026-11-12
- D4 Parallel work: the same hours may be booked on more than one thing at once (e.g. 10:00–12:00 on an internal project and on a client project), so the sum of a day's bookings is not necessarily the contractual day — user, 2026-11-12
- D5 Work that is not an entity in Operai is bookable — training, preparing a talk, other; some may become entities later, some never will — user, 2026-11-12
- D6 Concept (B2): a time entry is its own record, separate from activities; it may point at an activity (task, call, meeting), and one activity may have many entries (several days, several people) — user chose the recommended option, 2026-11-12. Storage (new service vs activities-api) is left to the plan
- D7 Some hours can be inferred rather than typed, e.g. taking part in a meeting — user, 2026-11-12 (how: D17)
- D8 Granularity (B5): a time entry is a day and a duration, in steps of 30 minutes (the user amended the proposed 15), with no start or end time; a start–end time is a non-goal that a later spec may add as optional — user chose the recommended option after asking for pros and cons and how Harvest, Tempo, Productive, Toggl and Clockify do it, 2026-11-12 ("start simple, complicate in a later spec")
- D9 Visibility (B8): a global hours view where an ordinary user sees only their own hours and an "admin" or a "manager" sees everyone's — user, 2026-11-12 (manager: D21)
- D10 Projects: hours logged on a project's work must be compared with the estimates provided and with maintenance hours — user, 2026-11-12 (in specs/030, D11)
- D11 Split (B3a): this spec (029) is time entries and the hours views, branched from main (projects, deals, meetings and activities already exist there — no overlap with feat/projects-handoff); a follow-up spec (030) compares hours with what was sold, after PR #9 is merged (terms/PO, ADR-0086). B3b is still decided here because it fixes what an entry carries from day one — user chose the recommended option after asking for a recap of both specs, 2026-11-12
- D12 For specs/030 (not this spec), proactive alerts, in the user's words: "se il progetto ha due date; se maintenance → trigger che genera un task alla fine / vicinanza della fine del monte ore o se non abbiamo fatto ore; se c'è un ritardo" — user, 2026-11-12; details to be grilled in 030
- D13 Grain (B3b): an entry on a project carries the project only (plus the optional activity pointer of D6, which gives per-task totals); no T&M position and no estimate activity — in 030 the comparison is on the project total, T&M against the total of its positions — user chose the recommended option, 2026-11-12
- D14 Who books (B4): only the person creates, edits and deletes their own time entries; admins and managers read them (D9) but never change them; hours inferred from meetings are therefore suggestions each participant confirms (D17) — user chose the recommended option, 2026-11-12
- D15 Nothing to amend in specs/025 or specs/026 — the earlier "amendare la spec 25 e rivederla" was a slip — user, 2026-11-12
- D16 Where (B4b): on a project only its project manager and team members book; on a deal only the people involved in it — its owner, its technical contact, or the assignee or a participant of one of its activities — user chose this over the recommended "deal: anyone with CRM access", 2026-11-12
- D17 Inferred hours (B6): only Meetings meetings suggest hours — each meeting that has a duration suggests, to its creator and to each Operai participant, an entry on the meeting's day with its duration rounded to 30 minutes, on the meeting (and so on its deal when linked); the person confirms, changes or dismisses it; CRM call/meeting activities (typed by hand, no duration) suggest nothing — user chose the recommended option after asking what "CRM call/meeting" meant, 2026-11-12
- D18 Unmapped work (B1b, revised): an entry is either on an entity (a project, a deal or a meeting) or on no entity; an entry on no entity must have a category, chosen from a dropdown of categories an admin manages (create, rename, retire — never delete); an entry on an entity has no category, and grouping it as delivery / internal / pre-sales in reports is derived from the entity's type, never stored; in the hours view a person can record hours with no entity. The user first said "some categories must be derived from the entity", then "categories are only needed when no entity is associated" — the later, more specific statement is taken, and the user confirmed it at B1b-i. R&D and internal tools go on `internal` projects — user, 2026-11-12
- D19 Work type (B1b-i): an entry on an entity also carries a type of work (development, analysis, PM, support, …) chosen from a list — user chose this over the recommended "no work type on entities (non-goal)", 2026-11-12
- D20 Work type (B1b-ii): optional; two lists, one for project entries and one for deal entries — user chose this over the recommended "required, one list", 2026-11-12
- D21 Manager (B8a): a new permission "see everyone's hours", unconditioned (both entities), held by default by admin only; an admin may grant it to other roles — user chose this over the recommended entity-scoped variant, 2026-11-12
- D22 Project and deal pages (B8b): whoever reads a project or a deal sees the total hours booked on it; the project manager sees the per-person detail on their project, and the deal's owner on their deal; anyone else sees per-person detail only with "see everyone's hours" — user chose this over the recommended "total, no per-person detail", 2026-11-12
- D23 Completeness (B1a): no completeness check in v1 — the personal view shows each day's total, with no "incomplete" mark and no reminder — user chose this over the recommended "mark partial days", 2026-11-12; B1c is therefore moot
- D24 Corrections (B7): a person edits and deletes their own entries at any time; no lock and no approval in v1 — user chose the recommended option, 2026-11-12
- D25 Global view (B9): filters by period, person, project, deal, category and work type; totals grouped by person, project, deal, category and month; export to a file of exactly what the filters show; no charts in v1 — user chose the recommended option, 2026-11-12
- D26 Further split (asked by the user after seeing the size, ~7 stories / ~38 ACs): specs/029 keeps time entries, categories and work types, the hours views with export, and access; the hours on the project and deal pages (D22) move to specs/030, because they touch projects-ui and the CRM deal page that PR #9 changes heavily and 030 already shows a project's hours; the hours suggested from meetings (D17, A4, A5, A17–A19) move to a new specs/031, the only part that touches Meetings. No decision changes, only which spec carries it — user chose the recommended option, 2026-11-12

Decided for specs/030 (batched interview while writing 030, 2026-11-12):
- D27 O1 closed: in every comparison 1 man-day = 8 hours (EstimAI also divides by 8; the contractual day of D3 is not the day sold) — user chose the recommended option
- D28 O2 closed: no carry-over — each 12-month period of a yearly hour package stands alone, unused hours are lost — user chose the recommended option
- D29 Hour package alert: a task at 80 % and another at 100 % of the package's hours (the current period for a yearly package, until expiry for a capacity one), one per threshold and period, to the project manager (or the ops-manager while the project awaits one) — user chose the recommended option
- D30 Idle-hours alerts, both: (a) 15 days before the end of the period or the expiry, if more than 25 % of the hours are left; (b) no hours recorded on the project for 10 days — user chose "both, with lower thresholds" over the recommended end-of-period check alone (30 days, 50 %), then 15 days / 25 % / 10 days over the recommended 15 / 30 % / 15
- D31 Dates alert: when a project's terms have a start and an end date, a task 30 days before the end date — user chose the recommended option
- D32 Delay alert: a task when the terms' end date or a fixed price's deadline has passed and the project is not closed or cancelled; plus effort tasks at 80 % and 100 % of a fixed price's max effort — user chose "date + effort overrun" over the recommended "date only"
- D33 Time-and-material projects get no alerts of any kind — user, 2026-11-12 (narrows D32's option, which also named T&M positions)
- D34 Split of specs/030 (the user asked whether alerts should be a spec of their own): specs/030 keeps consumption and the hours on the project and deal pages (read-only); the alerts (D12, D29–D33, A27–A31) move to a new specs/032, which depends on 030 and carries the decision on how date-based alerts fire — user chose the recommended option, 2026-11-12

Decided during /wellforge:plan 029 (2026-11-12):
- D35 Spec amendment AC-4.10: a holder of see everyone's hours who cannot read an entry's project, deal or meeting sees the entry's type, minutes and day but not the entity's name nor the activity's subject — user chose the recommended option over "always show names"
- D36 Time entries live in a new service `hours-api`, not inside activities-api — user chose this over the recommended activities-api (cleaner boundary, at the cost of a new service and cross-service reads)
- D37 The hours screens are a new remote `hours-ui`, mounted ungated at `/hours`; the admin lists live in admin-ui — user chose the recommended option over an ungated entry in projects-ui

Decided during /wellforge:design 029 (2026-11-12, gaps raised by the designer):
- D38 AC-3.1 gains restore: a retired category or work type can be brought back from the Time lists screen (the plan already allowed `retired: false`) — user chose the recommended option over "retire is final in the UI"
- D39 The export's duration is one numeric column of decimal hours (2 h 30 = 2.5), so the file sums; AC-4.9's "2 h 30" applies to the screen only — user chose the recommended option over two columns (text + decimal)
- D40 The export carries, for an entry on a meeting linked to a deal, that deal, so the file summed by deal matches the by-deal totals (AC-4.5); its name follows the viewer's access (AC-4.10) — user chose the recommended option over no extra column
- D41 AC-3.3 is reworded to "a user without the permission to manage the lists"; the screen stays in admin-ui, so a role granted that permission also needs Admin access (the mileage-rate pattern, ADR-0023/0090) — user chose the recommended option over moving the screen to hours-ui; AC-3.1's "an admin" aligned to the same wording as a consequence
- D42 The plan amended after design (totals semantics, `groupBy=day`, person filter from the totals, browser-side activity picker, 9-column export with one "Counts for deal" column instead of a "Deal (via meeting)" column, list restore, `formatMonth`/`SearchPicker`/`ExportButton` in `@operai/ui`) stays approved — user approved the amended plan
- D43 AC-4.10 applies to every viewer, the entry's author included: a project, deal, meeting or meeting's deal the viewer cannot read shows no name — user chose the recommended option over "the author always sees names"
- D44 Whether the id of a hidden project, deal or meeting is withheld along with its name (an oversight holder can otherwise tell two hidden entries are on the same record) is left to the owasp review — user chose "keep the id, decide at review" over the recommended "withhold the id too"; the plan keeps `on.id`/`activity.id` and flags it under Security
- D45 New AC-4.11: a view filtered by a deal is refused as unavailable while meetings-api cannot say which meetings are linked to that deal (seconds to minutes: a redeploy of its single replica, a crash, a network error); nothing partial is shown; without a deal filter the view still degrades (AC-4.7) — user chose this over the recommended "deal's own entries + a warning banner", knowing the next read after Meetings answers is complete
- D46 (2026-11-13) Bookability is checked only when an entry is created or moved to another project, deal or meeting: its author may still correct the day, duration, note and work type of an entry on a project/deal they left or a target they can no longer read (new AC-2.12; AC-2.2/2.3 reworded; A3 narrowed); an activity pointer change is still checked (AC-2.7) — user chose the recommended option over "every change is checked, delete only after leaving"

Delegated (the user deferred to the recommendation):
- none — every decision above was chosen explicitly

Found (read from the repo, not asked):
- F1 Time tracking was deferred on purpose to its own spec — specs/025 D27 and Non-goals, specs/027 Non-goals, specs/028 Non-goals
- F2 Activities live in activities-api (specs/028): pre-sales on a company (+ optional contact, deal; note/call/meeting/email/task), operational on a project (tasks only); author, assignee, ≤ 10 participants — activities-api/prisma/schema.prisma; participants were introduced as "the base for time tracking later" — specs/017 US-8
- F3 A meeting linked to a deal is mirrored as a `meeting` activity on the deal — specs/028 AC-1.4, ADR-0059
- F4 What was sold lives on a project's terms: hour package (capacity | yearly), fixed_price max effort + estimated man-days, t_and_m positions with planned man-days — specs/025 US-2; on main in `Contract`, on feat/projects-handoff (PR #9 open, 97 ahead / 0 behind main) in `ProjectTerms` + `PurchaseOrder` — ADR-0086
- F5 specs/025 O2 (yearly package carry-over) is owned by "the time-tracking spec" — specs/025/spec.md Open questions
- F6 No money in projects — specs/025 D14
- F7 `internal` projects exist (R&D, internal tools) — specs/025 domain language
- F8 A Meetings meeting has a start (`startsAt`), a duration only when it has audio (`durationMs`; none for a typed or pasted one), a creator and Operai participants — meetings-api/prisma/schema.prisma, specs/021
- F9 A CRM call/meeting activity has the moment it occurred and participants, but no duration — specs/017 US-4, US-8
- F10 The project team exists because "time tracking will need who may book on a project" — specs/025 ledger D15; the PM and team members are users with the project module's access, which employees do not hold by default — specs/025 AC-4.6
- F11 Every CRM record (deals included) is readable by every `crm:access` holder — ADR-0052
- F12 Departments in `auth` have no head or manager — auth/prisma/schema.prisma
- F13 "Proposal" is ProposAI's word (consulting proposals, AGENTS.md roadmap); the spec says "suggested entry" instead

Assumed (not load-bearing; strike any that is wrong):
- A1 Overlapping hours count in full on each thing they are booked on (10:00–12:00 on two projects gives each project 2 h) — follows from D4
- A2 Every active Operai user (every employee) can record their own hours, whatever tools they can open — follows from D1, D2
- A3 Being on the team or involved in the deal is checked when an entry is created or moved to a project or deal; entries already recorded stay, and stay correctable by their author, when the person leaves the team or stops being involved (the specs/028 AC-3.7 pattern; narrowed by D46)
- A4 A meeting's duration is rounded to the nearest 30 minutes, never below 30; a meeting with no duration (typed or pasted) suggests nothing
- A5 A suggested entry stays until the person confirms or dismisses it; it does not expire
- A6 A meeting's creator and Operai participants may book on it; when the meeting is linked to a deal its hours also count for that deal, without D16's involvement check, and follow the meeting when it is relinked
- A7 A category can require a note; the initial "Other" does
- A8 The two work-type lists are managed by an admin like the categories (create, rename, retire, never delete); entries on a meeting and entries on no entity carry no work type
- A9 One entry is at least 30 minutes and at most 24 hours; a day's entries have no total cap (parallel work, D4)
- A10 Hours cannot be recorded on a future day
- A11 The export holds exactly the entries the viewer sees with the current filters, never a suggested entry
- A12 A project in any state (planned, active, on hold, closed, cancelled) takes entries — work done before a close or a cancellation, and corrections after it, must fit somewhere
- A13 A deal in any stage, won and lost included, takes entries
- A14 An entry may point only at an activity about its own project or deal (a project task; a pre-sales activity of that deal) that the person can read
- A15 Initial lists: categories Training, Talk preparation, Administration, Other; project work types Development, Analysis, Project management, Support; deal work types Analysis, Estimate, Demo, Offer
- A16 A note is at most 1000 characters; category and work-type names are one text each, shown as typed in both languages
- A17 A person who already has an entry on a meeting is not offered a suggested entry for it
- A18 A suggested entry disappears when its meeting is deleted or the person is removed from it before confirming; confirmed entries on a deleted meeting stay, shown without the meeting's title
- A19 Only meetings that start on or after the release day suggest hours (no backlog of old meetings)
- A20 A project or deal page still loads when hours cannot be loaded, and says so (the specs/028 AC-1.5 posture)
- A21 When the tool that owns a project, deal or meeting cannot confirm the person may book on it, the write is refused and nothing changes (fail closed, ADR-0014/0081 posture); the person's own list still shows every entry, with an unknown name where it cannot be resolved
- A22 When an activity an entry points at is deleted, the entry stays on its project or deal without the pointer

Assumed while writing specs/031 and specs/030 (2026-11-12, not grilled — strike any that is wrong):
- A23 (031) A suggested entry is visible only to its person
- A24 (031) A suggestion follows its meeting's day, duration and participants until confirmed; a confirmed entry never changes with the meeting
- A25 (031) When Meetings cannot be reached, the hours view loads and says suggestions are unavailable
- A26 (031) No notification for a new suggestion
- A27 (032) An alert is assigned to the project manager, or to the PO's ops-manager while the project awaits one
- A28 (032) One alert per moment (threshold and period, end date, deadline, idle stretch); a changed date is a new moment
- A29 (032) The idle check runs only while the project is `active`; one alert per idle stretch, which ends when hours are recorded again
- A30 (032) Closed and cancelled projects get no alerts
- A31 (032) Projects made by hand with terms get the same alerts as those with a purchase order
- A32 (030) Consumption figures are visible to every holder of the project module's access, like D22's totals
- A33 (030) Hour packages are compared in hours; fixed price and time-and-material in man-days
- A34 (030) Man-days are shown with one decimal

Open (unresolved — each needs an owner):
- O1 (specs/030) closed by D27
- O2 (specs/030) closed by D28
- O3 Labour-law check before go-live: informing employees about the hours recorded and who reads them (IT: art. 4 L. 300/1970; CH: art. 26 OLL 3) — owner: management / HR
- O4 A lock or approval of recorded hours before they are used to bill T&M on a timesheet — owner: product owner, at the latest with specs/030 or a billing export
