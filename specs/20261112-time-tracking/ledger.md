---
topic: Time tracking — the hours employees spend on company work (projects, pre-sales, meetings, unmapped work)
grilled: 2026-11-12
target: specs/20261112-time-tracking/spec.md
complete: true
---

## Decision ledger — time tracking

Moved here from `.forge/grill/time-tracking.md` when specs/20261112-time-tracking was written (2026-11-12).

Decision map (parents first; re-drawn after D1, all branches closed):
- B1 Coverage — D2, D3, D4, D5
  - B1a Completeness — D23
  - B1b Unmapped work — D18; B1b-i derivation — D18 (revised), D19; B1b-ii work type — D20
  - B1c Contractual hours per person — moot after D23
- B2 Concept: time entry vs activity — D6, D7
- B3 Comparison with what was sold — D10
  - B3a Timing — D11 (specs/20261112-project-hours)
  - B3b Grain — D13
  - B3c Man-day ↔ hours — O1 (specs/20261112-project-hours)
  - B3d Yearly package carry-over — O2 (specs/20261112-project-hours)
- B4 Who books — D14; B4b where — D16
- B5 Granularity — D8
- B6 Hours from meetings — D17
- B7 Corrections and locking — D24, O4
- B8 Visibility — D9; B8a manager — D21; B8b project and deal pages — D22
- B9 Global view and export — D25
- B25 Amending specs/20261103-projects — D15 (nothing to amend)
- B10 Hours of a meeting linked to a project (specs/20261112-project-hours, re-opened 2026-11-26) — D78; B8b-i per-person
  figure of a project awaiting its project manager — D79
- B11 Signals on the consumption block (specs/20261112-project-hours, re-opened a second time 2026-11-27) — D86–D94 (D92
  rounding of the percentage, D93 closed and cancelled projects, D94 the day of a date); D95–D96 at the plan's gate 2 (D95 the
  words at exactly 100 %, D96 the readings of US-5)

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
- D10 Projects: hours logged on a project's work must be compared with the estimates provided and with maintenance hours — user, 2026-11-12 (in specs/20261112-project-hours, D11)
- D11 Split (B3a): this spec (029) is time entries and the hours views, branched from main (projects, deals, meetings and activities already exist there — no overlap with feat/projects-handoff); a follow-up spec (030) compares hours with what was sold, after PR #9 is merged (terms/PO, ADR 20261105-terms-and-purchase-order-two-optional-records-of-a-project-contract-retired). B3b is still decided here because it fixes what an entry carries from day one — user chose the recommended option after asking for a recap of both specs, 2026-11-12
- D12 For specs/20261112-project-hours (not this spec), proactive alerts, in the user's words: "se il progetto ha due date; se maintenance → trigger che genera un task alla fine / vicinanza della fine del monte ore o se non abbiamo fatto ore; se c'è un ritardo" — user, 2026-11-12; details to be grilled in 030
- D13 Grain (B3b): an entry on a project carries the project only (plus the optional activity pointer of D6, which gives per-task totals); no T&M position and no estimate activity — in 030 the comparison is on the project total, T&M against the total of its positions — user chose the recommended option, 2026-11-12
- D14 Who books (B4): only the person creates, edits and deletes their own time entries; admins and managers read them (D9) but never change them; hours inferred from meetings are therefore suggestions each participant confirms (D17) — user chose the recommended option, 2026-11-12
- D15 Nothing to amend in specs/20261103-projects or specs/20261103-projects-handoff — the earlier "amendare la spec 25 e rivederla" was a slip — user, 2026-11-12
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
- D26 Further split (asked by the user after seeing the size, ~7 stories / ~38 ACs): specs/20261112-time-tracking keeps time entries, categories and work types, the hours views with export, and access; the hours on the project and deal pages (D22) move to specs/20261112-project-hours, because they touch projects-ui and the CRM deal page that PR #9 changes heavily and 030 already shows a project's hours; the hours suggested from meetings (D17, A4, A5, A17–A19) move to a new specs/20261112-meeting-hours, the only part that touches Meetings. No decision changes, only which spec carries it — user chose the recommended option, 2026-11-12

Decided for specs/20261112-project-hours (batched interview while writing 030, 2026-11-12):
- D27 O1 closed: in every comparison 1 man-day = 8 hours (EstimAI also divides by 8; the contractual day of D3 is not the day sold) — user chose the recommended option
- D28 O2 closed: no carry-over — each 12-month period of a yearly hour package stands alone, unused hours are lost — user chose the recommended option
- D29 Hour package alert: a task at 80 % and another at 100 % of the package's hours (the current period for a yearly package, until expiry for a capacity one), one per threshold and period, to the project manager (or the ops-manager while the project awaits one) — user chose the recommended option
- D30 Idle-hours alerts, both: (a) 15 days before the end of the period or the expiry, if more than 25 % of the hours are left; (b) no hours recorded on the project for 10 days — user chose "both, with lower thresholds" over the recommended end-of-period check alone (30 days, 50 %), then 15 days / 25 % / 10 days over the recommended 15 / 30 % / 15
- D31 Dates alert: when a project's terms have a start and an end date, a task 30 days before the end date — user chose the recommended option
- D32 Delay alert: a task when the terms' end date or a fixed price's deadline has passed and the project is not closed or cancelled; plus effort tasks at 80 % and 100 % of a fixed price's max effort — user chose "date + effort overrun" over the recommended "date only"
- D33 Time-and-material projects get no alerts of any kind — user, 2026-11-12 (narrows D32's option, which also named T&M positions)
- D34 Split of specs/20261112-project-hours (the user asked whether alerts should be a spec of their own): specs/20261112-project-hours keeps consumption and the hours on the project and deal pages (read-only); the alerts (D12, D29–D33, A27–A31) move to a new specs/20261112-project-alerts, which depends on 030 and carries the decision on how date-based alerts fire — user chose the recommended option, 2026-11-12

Decided during /wellforge:plan 029 (2026-11-12):
- D35 Spec amendment AC-4.10: a holder of see everyone's hours who cannot read an entry's project, deal or meeting sees the entry's type, minutes and day but not the entity's name nor the activity's subject — user chose the recommended option over "always show names"
- D36 Time entries live in a new service `hours-api`, not inside activities-api — user chose this over the recommended activities-api (cleaner boundary, at the cost of a new service and cross-service reads)
- D37 The hours screens are a new remote `hours-ui`, mounted ungated at `/hours`; the admin lists live in admin-ui — user chose the recommended option over an ungated entry in projects-ui

Decided during /wellforge:design 029 (2026-11-12, gaps raised by the designer):
- D38 AC-3.1 gains restore: a retired category or work type can be brought back from the Time lists screen (the plan already allowed `retired: false`) — user chose the recommended option over "retire is final in the UI"
- D39 The export's duration is one numeric column of decimal hours (2 h 30 = 2.5), so the file sums; AC-4.9's "2 h 30" applies to the screen only — user chose the recommended option over two columns (text + decimal)
- D40 The export carries, for an entry on a meeting linked to a deal, that deal, so the file summed by deal matches the by-deal totals (AC-4.5); its name follows the viewer's access (AC-4.10) — user chose the recommended option over no extra column
- D41 AC-3.3 is reworded to "a user without the permission to manage the lists"; the screen stays in admin-ui, so a role granted that permission also needs Admin access (the mileage-rate pattern, ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition, 20261112-hours-ui-ungated-remote) — user chose the recommended option over moving the screen to hours-ui; AC-3.1's "an admin" aligned to the same wording as a consequence
- D42 The plan amended after design (totals semantics, `groupBy=day`, person filter from the totals, browser-side activity picker, 9-column export with one "Counts for deal" column instead of a "Deal (via meeting)" column, list restore, `formatMonth`/`SearchPicker`/`ExportButton` in `@operai/ui`) stays approved — user approved the amended plan
- D43 AC-4.10 applies to every viewer, the entry's author included: a project, deal, meeting or meeting's deal the viewer cannot read shows no name — user chose the recommended option over "the author always sees names"
- D44 Whether the id of a hidden project, deal or meeting is withheld along with its name (an oversight holder can otherwise tell two hidden entries are on the same record) is left to the owasp review — user chose "keep the id, decide at review" over the recommended "withhold the id too"; the plan keeps `on.id`/`activity.id` and flags it under Security
- D45 New AC-4.11: a view filtered by a deal is refused as unavailable while meetings-api cannot say which meetings are linked to that deal (seconds to minutes: a redeploy of its single replica, a crash, a network error); nothing partial is shown; without a deal filter the view still degrades (AC-4.7) — user chose this over the recommended "deal's own entries + a warning banner", knowing the next read after Meetings answers is complete
- D46 (2026-11-13) Bookability is checked only when an entry is created or moved to another project, deal or meeting: its author may still correct the day, duration, note and work type of an entry on a project/deal they left or a target they can no longer read (new AC-2.12; AC-2.2/2.3 reworded; A3 narrowed); an activity pointer change is still checked (AC-2.7) — user chose the recommended option over "every change is checked, delete only after leaving"

Decided during /wellforge:tasks 029 (2026-11-13, raised while deriving tasks):
- D47 A pointed activity that no longer resolves is worked out on read only (`activity: null` while the project/deal is readable, hidden when it is hidden); the stored id is never cleared — user chose the recommended option over "clear it after an owner check"
- D48 Under a deal filter, a failed "Load more" keeps the pages already shown, with the error and Retry below them; only a failing first page, totals or export replaces the view (AC-4.11 amended) — user chose this over replacing the whole view
- D49 The list's `target` and `meetingId` filters stay in hours-api although no AC uses them (likely needed by specs/20261112-meeting-hours) — user chose the recommended option over dropping them

Decided during /wellforge:orchestrate 029 (2026-11-13, raised by the third plan amendment):
- D50 `note_required` (AC-3.6) is checked only when a `POST` records an entry, or a `PATCH` sends `note` or moves the entry (`on`) — a `PATCH` that touches neither (e.g. minutes only) on an entry recorded before its category was marked as requiring a note goes through; rejected: checking every save against the stored result (the literal reading the architect first wrote), which blocks a minutes-only fix until a note is typed — user chose the recommended, least invasive option

Decided by the OWASP review (T37, 2026-11-13), as the user delegated D44 ("keep the id, decide at review"):
- D44 (resolved) WITHHOLD — in a `TimeEntryView`, `on.id` (project, deal, meeting) and `activity.id` are returned only when the record is `visible` to the viewer or the entry is the viewer's own; otherwise `null`. Reason: finding F1 (Medium, A01) — a `time-entry:read-all` holder without CRM access could feed hidden ids back as `dealId`/`projectId`/`meetingId` filters and learn which hidden meetings are linked to which hidden deal, the disclosure ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route A1 forbids; no product cost (Everyone's hours and the export use no ids; the author keeps own ids for editing). Rejected: keeping the ids and adding a viewer crm read on every `dealId` filter (new call and refusal, does not close the `projectId`/`meetingId` pivots); nulling them for the author too (breaks the edit dialog for no gain). See `owasp-report.md`.

Decided after the rebase onto main (2026-11-16), when main had moved Refund's settings from admin-ui into refund-ui
(ADR 20260720-mileage-rate-model-snapshot-admin-ui-composition amendment, 2026-11-13, the owner: "Dobbiamo spostare i settings dell'applicazione refund da admin all'app refund"):
- D51 The time lists (categories and the two work-type lists) move from admin-ui into hours-ui, as a **Settings** tab at `/hours/settings` shown only to holders of `time-list:manage`; admin-ui keeps nothing of time tracking — user: "si, spostiamo ma aggiungi un altro task in questa spec" (T43). Supersedes the admin-ui placement of ADR 20261112-hours-ui-ungated-remote and the D41 wording of AC-3.3: the permission alone now reaches the screen, since the hours screens are ungated
- D52 A **Recorded on** filter (All / Project / Deal / Meeting / Other work) in My hours and Everyone's hours, so the hours the Totals show as "Not on a project" / "Not on a deal" can be isolated — user, 2026-11-16, after seeing that no filter reached them ("nessun filtro mi consente di vedere le ore loggate su `Not on a project`"); chose it over a negated "No project" / "No deal" option in the Project and Deal filters (Clockify's "Without project", an hours-api change) and over deferring it. Frontend only: hours-api's list and totals already take `target`; "Not on a project" is Deal + Meeting + Other work, read one at a time
- D53 The entry dialog's **Duration** is a text field read by a forgiving parser (`2:30`, `2,5`, `2.5`, `2h30`, `2 h 30`, `90m`), showing how it read the value ("= 2 h 30") and refusing — never rounding — a value that is not whole 30-minute steps from 30 min to 24 h, instead of the native select of 48 options — user, 2026-11-16, after using it ("la select box per la selezione della duration non è usabile: mi mostra la lista delle opzioni per 30 min"); chose it over two selects (hours + minutes) and over a stepper with presets. Harvest, Clockify and Toggl type the duration the same way. The rules of AC-1.2 are unchanged

Decided when specs/20261112-meeting-hours was re-opened (2026-11-24, before any plan; batched interview):
- D54 A meeting's hours are recorded AUTOMATICALLY: when its duration becomes known, its creator and each Operai participant get a time entry on it, rounded to the nearest 30 minutes — no suggestion, no confirmation — user: "perchè parli di suggerimento? se un meeting è terminato, l'orario registrato apparirà in automatico (approssimato al 0.5h più vicino)". Supersedes D17's suggest-and-confirm (and its consequence in D14: "hours inferred from meetings are therefore suggestions each participant confirms"); narrows D14: Operai, not a user, records the entry — users still never create, change or delete someone else's. A5, A23 and A25 are moot. Asked where suggestions should appear, the user answered "dentro la tabella e nella lista": automatic entries are ordinary entries, shown in both
- D55 An automatic entry its person deletes is never recorded again for them on that meeting — user chose the recommended option over "it comes back while the person has no entry on the meeting"
- D56 An UNTOUCHED automatic entry follows its meeting (date-time → day, duration, removal from the participants, deletion of the meeting); once its person changes it, it is theirs and never changes with the meeting — user chose the recommended option over "never follows, an ordinary entry from the start"
- D57 Automatic entries are marked "From meeting" wherever entries are listed one by one (the List, a table cell's entries); the mark stays after a change — user chose the recommended option over no mark

Decided during /wellforge:plan of specs/20261112-meeting-hours (2026-11-24; the user answered "procedi" to "Mi confermi D-P3 e D-P4, e l'architettura va bene?"):
- D58 A38 ("only Operai participants whose account is active") is enforced where a person is added to the meeting (meetings-api already refuses an inactive participant; a creator is active when creating) and is not re-checked when the duration becomes known — hours-api has no service path to auth's identities; a person deactivated in between gets an entry
- D59 A meeting whose `durationMs` is 0 has no known duration (AC-1.3): no automatic entry, rather than A36's 30-minute floor
- The plan's architecture (meetings-api pushes versioned facts through an until-delivered outbox, hours-api applies the newest; plan D-P1, D-P2, D-P5) — accepted at the same review

Decided during /wellforge:design of specs/20261112-meeting-hours (2026-11-24, gaps raised by the designer; the plan was approved in the same answer):
- D60 The Italian mark reads "Da riunione", not "Dal meeting" — every Italian string of hours-ui and meetings-ui, the kind badge on the same row included, says "riunione" — user chose the recommended option (G3)
- D61 New AC-2.7: deleting an automatic entry, the confirmation also says Operai will not record it again from its meeting and that the person can still record hours themselves — user chose the recommended option over leaving the dialog unchanged (G1)
- D62 AC-2.3 names Everyone's hours among the places that show the mark (plan D-P5) — user chose the recommended option over removing the mark from Everyone's hours (G4)

Decided by the owner after the OWASP review of specs/20261112-meeting-hours (T13), 2026-11-24 — the review's optional
hardenings added to that spec, approved again at 34 acceptance criteria (25 before); three of them withdrawn the same day
by D74–D76 (the spec then has 28):
- D63 Operai corrects a recorded or uploaded meeting's duration to the measured length of its audio when it differs by more than the larger of 30 s and 10 % of the held duration (A42); untouched entries follow it (D56), changed ones stay; a meeting whose audio cannot be read keeps its reported duration — review L1
- D64 [withdrawn by D74] A correctly signed service credential refused only for its service or its permission is recorded for the operators (reason and service name, never the credential); the caller's answer stays the one identical refusal — review I1 (how widely: open, at plan)
- D65 [withdrawn by D75] A meeting notice with an identifier containing a character no Operai identifier uses (A45) is refused for good and never retried — review I3
- D66 [withdrawn by D76] Once a meeting is deleted, Operai keeps no record of which of its people deleted or already had an entry on it; the version record stays, so a late notice still records no hours — review I6
- D67 The "From meeting" mark is shown only while an automatic entry is recorded on a meeting; one its person moved to a project, a deal or other work no longer shows it — review I8, design G6 reversed; amends D57 ("the mark stays after a change") and the Everyone's-hours consequence of D62; D60 unchanged
- D68 AC-3.8 (the measured duration) stays in specs/20261112-meeting-hours; specs/20261104-meetings is not amended — user accepted the recommended default
- D69 Audio Operai cannot read keeps its reported duration and the entries built on it (AC-3.10) — user accepted the recommended default
- D70 AC-2.7's sentence stays for a deleted automatic entry its person had moved off the meeting (it is true) — user accepted the recommended default
- D71 A meeting dated after the release day with a duration at release gets its entries only at its next change of start, duration or Operai participants (plan § Release backfill); accepted as a known limit — user accepted the recommended default
- D72 [withdrawn by D74] D64 (refusals recorded) is made in the shared service-credential check itself, so all six copies (meetings-api, hours-api, crm-api, estimai-api, activities-api, accounting-api) change together and stay byte-identical — user chose the recommended option over hours-api alone (which would leave the shared-copies group)
- D73 Glossary: Untouched, Block (meeting hours), Hours fact, Hours notice, Held duration / Measured duration added, Automatic entry amended for D67 — user accepted all
- D74 I1 withdrawn, D64 and D72 no longer apply: AC-5.1, AC-5.2 and A44 are removed from specs/20261112-meeting-hours, with US-5 — owner, choice "A", 2026-11-24. The sender already shows the refusal (meetings-api logs `meeting_hours.notice_retry … code=unauthorized` and keeps `lastErrorCode` on the outbox row, which is how a missing scope was diagnosed the same day), and changing the shared service-credential check would touch six services, four of them unrelated to the feature. The review's note I1 is accepted as risk; the spec carries it as a non-goal
- D75 I3 withdrawn, D65 no longer applies: AC-5.3, AC-5.4, A45 and the open question about A45 are removed — owner, choice "A", 2026-11-24. Every identifier is made by the server (cuid, better-auth, the JWT `sub`, participants confirmed active by auth), and the hardening would add a worse failure than the one it prevents: a real identifier outside the set would refuse a whole meeting's hours for good, because a refused notice is final. The review's note I3 is accepted as risk; the spec carries it as a non-goal
- D76 I6 withdrawn, D66 no longer applies: AC-4.4, AC-4.5 and A46 are removed — owner, choice "A", 2026-11-24. The records of a deleted meeting are inert (no notice reads them again) and hold minimal data (person id, meeting id, reason); clearing them would cost a migration, a lock in the entry DELETE and race risks. The review's note I6 is accepted as risk; the spec carries it as a non-goal. An entry its person changed still stays when its meeting is deleted (AC-3.6, unchanged), and D73's glossary entry for Block no longer says it is dropped with the meeting

Decided by the owner after the code review of PR #12 (specs/20261112-meeting-hours, 2026-11-25; a drift correction of one non-goal, no scope or behaviour change):
- D77 The non-goal "A history of where a moved entry came from" is REWORDED to say what the build does, and the build is not changed: no log of what an entry was recorded on before is kept or shown, and no "From meeting" mark shows once it is recorded on a project, a deal or other work (AC-2.3); but `origin` stays `meeting` (never rewritten), is sent for every viewer, a `time-entry:read-all` holder included, and on such an entry drives only the delete confirmation's sentence (AC-2.7, D70) — owner, 2026-11-25. The review of PR #12 found the old wording ("nothing on the entry shows it was ever automatic") contradicted the build; the security review had already accepted the residual (owasp-report I8, N3). Offered and declined: send the real `origin` only to the entry's person. No acceptance criterion changes

Decided when specs/20261112-project-hours was re-opened (2026-11-26, before any plan; batched interview). Numbered after D77,
the last decision of specs/20261112-meeting-hours (PR #12, D54–D77, not yet on main when this was written):
- D78 The hours recorded on a meeting linked to a project (specs/20261104-meetings A18, 2026-11-23) — by its person or
  automatically (specs/20261112-meeting-hours) — count for that project EVERYWHERE, as a linked meeting's hours count for a
  deal (specs/20261112-time-tracking AC-2.6): on the project page and in its consumption, in the hours views' project filter
  and by-project totals, and in the export (the project carried like the deal of D40); without the team check; they follow a
  relink; a project filter or a project page's hours are refused as unavailable while Meetings cannot say which meetings are
  linked (D45's rule, never a figure lower than the truth); the project a meeting is linked to follows the viewer's access
  as the deal does (AC-4.10). specs/20261112-meeting-hours had left the question to this spec (its non-goals). User chose
  the recommended option over "the project page only" (two different figures for one project) and over "only the hours
  recorded on the project" (no new read, but consumption blind to meetings and a rule different from deals), after the
  comparison with Harvest, Toggl and Clockify, which put calendar meeting time on the project
- D79 While a project awaits its project manager, its per-person figure is shown only to holders of see everyone's hours;
  the purchase order's ops-manager does not see it — user chose the recommended option (D22 read literally) over "the
  ops-manager while the project awaits one" (the A27 rule of specs/20261112-project-alerts)

Decided during /wellforge:design of specs/20261112-project-hours (2026-11-26, after seeing the canvas of the first design):
- D80 The project page and the deal page each get **one "Hours" card**, not two: on a project it shows the consumption
  (when the terms sold something comparable) and the total recorded, always visible, and the breakdown by work type and by
  person behind a **"Show breakdown"** disclosure, closed by default; on a deal it shows the total and the same closed
  disclosure — the owner: "le card aggiuntive nella pagina di deals e progetto rischiano di provocare un carico cognitivo non
  indifferente (che già sono tante)". The owner first chose tabs Overview | Hours, then dropped them on seeing that the page
  would carry two menus (the tool's section tabs and the page's tabs: "così però nella stessa pagina ci sarebbe un doppio
  menu"), had all the layouts drawn (two open cards; one card with a closed breakdown; tabs under the section menu; tabs with
  the section menu removed from record pages; an Hours button opening a side panel; one line in Details plus a separate hours
  page) and chose **"one card, breakdown closed"** (option 2), the recommended one together with the side panel. Consumption
  stays visible at a glance. No acceptance criterion changes: the breakdown is on the page, one click away

Decided during /wellforge:tasks of specs/20261112-project-hours (2026-11-26, the design's gaps G1–G5; batched questions):
- D81 (G1) An exceeded hour package shows **"Over by" the absolute figure** ("Sforato di 4 h 30") instead of a negative "Hours
  left": AC-1.1 amended. The library's `formatDuration` clamps a negative to zero and is not changed — user chose this over
  the recommended `signed` option in `@operai/ui` (a library task and a shell-first deploy), the least invasive one
- D82 (G2) AC-1.7 also covers terms that sold nothing to compare with (an SLA and no hour package): the card shows the total
  only — user chose the recommended rewording
- D83 (G3) An expired capacity package says so: projects-api's `currentPeriod` gains `ended`, derived by the same
  `packagePeriod`, and the card shows a badge **"Expired" / "Scaduto"** (`StatusBadge` meaning `voided`) beside the period —
  new AC-1.9. The user accepted the badge and asked to align the word with existing features: `expired` is the suite's word
  for something no longer valid after a date (admin-ui invitations, "Expired"/"Scaduto", `voided`) and the terms already say
  "Package expiry date" / "scade il"; `overdue` ("Overdue"/"In ritardo", `attention`) is a task not done by its due date,
  which would read as work still to do. Rejected: no badge (the two dates the only signal)
- D84 (G5) After a save with Record hours on a project or deal page, that page's hours figures show the new hours without
  a reload — new AC-2.8. User chose this over the recommended "accept and note it in the release". Mechanism in the plan
  (D-P6): a content-free browser event broadcast by the Record hours widget, amending ADR
  20261116-record-hours-widget-through-the-host-extension-seam ("nothing comes back")

Decided by the owner while implementing specs/20261112-project-hours (2026-11-27; a known limitation accepted, not a scope
change: no acceptance criterion changes and the spec's status and approval stand):
- D85 The project page's "today" is the Europe/Zurich day projects-api works out when it reads the project, which the page
  does when it loads (`projects-api/src/terms/packagePeriod.ts`); an hour package's current period, its figures, whether it
  has not started and whether it has expired are all derived from it. A page left open across a date therefore keeps what was
  true on the day it was loaded, even after a save made with Record hours (AC-2.8, D84), until the page is reloaded (reading
  the project again moves it, and a reload always does; so does a save of the project's terms or purchase order on that page,
  `projects-ui/src/pages/ProjectDetailPage.tsx` `recordChanged`). The project's total hours (AC-2.1) are not read through that
  day and are not affected by it; nothing is lost or wrong after a reload. ACCEPTED as one known limitation (A52 of the
  spec), in four cases with the same cause: (a) a capacity package without an expiry date, the page open across Zurich
  midnight: the hours dated the new day are left out of its consumption figures (AC-1.3), so the hours used are too low and
  the hours left too high (or "Over by" too low) — the one case where a figure is too low with no date on screen to show it,
  because the block then shows the start date and "no expiry" and no end date; (b) a yearly package's anniversary passes: the
  block keeps showing the old period and its figures, and hours recorded in the new period do not move it (AC-1.1, AC-1.2,
  AC-2.8); (c) a package's start date arrives: the block keeps saying the package has not started, with no figures (A51,
  AC-2.8); (d) a capacity package's expiry date passes: the "Expired" mark appears only after a reload (AC-1.9), the figures
  stay right. In (b) to (d) the block shows a date that has already passed (the period's end, the start date, the expiry).
  Owner, 2026-11-27: first (a) alone, choice "A" of four, for specs/20261112-project-hours — the implementer had recorded it
  as drift (specs/20261112-project-hours/decisions.md, T16); then, the same day, WIDENED to (b), (c) and (d), every case with
  the same cause: "it is negligible, refreshing the page is enough". Rejected: computing the day in the browser (the Zurich
  day is the server's to decide); letting the summary take an open-ended window (a contract and hours-api change for a rare
  case); re-reading the project on every save (rejected for now, as more than the case is worth)

Decided when specs/20261112-project-hours was re-opened a second time (2026-11-27, after it had passed QE and eval; the owner
asked for signals on the consumption block and chose to add them to THIS spec, which re-opens gate 1; they looked at three
mockups and chose option C, then decided the points below, the recommendations put to them accepted). Numbered after D85:
- D86 Scope and look: **signals on the consumption block** — a consumed percentage, the states on track, close to the limit
  and over, the excess beyond 100 %, the time elapsed, and dates passed or near — are added to THIS spec as US-5, not to a spec
  of their own and not to specs/20261112-project-alerts. The status goes back to `draft` until the owner approves again;
  `approved:` stays 2026-11-26, the date of the previous approval. The look is "option C" of the three mockups: under the
  consumption figures, a bar of the consumed share on a scale that goes beyond 100 % (to 125 %), marks at 80 % and 100 %, the
  part beyond 100 % drawn distinctly, a "today" mark for the time elapsed in the period, a line "used X % of the hours with Y %
  of the period elapsed", the estimate as a reference mark for a fixed price, and a deadline line (passed / near). It reverses
  two decisions of specs/20261112-project-hours/design.md S1 — "Exceeded" has no status colour, and the block has no progress
  bar — which were taken while raising attention was project-alerts' alone: the designer amends the design. Alerts stay
  project-alerts' (D34): nothing here creates a task or a notification. D85's limitation (A52) applies to every signal that
  reads today — owner, 2026-11-27
- D87 Thresholds, fixed and not configurable: below 80 % of the reference is on track; from 80 % to below 100 % is "close to
  the limit" (the milder level, a warning); from 100 % is "over" (the graver level, a danger). The same thresholds as
  specs/20261112-project-alerts (AC-1.1, AC-1.6), so the card and the alert task agree. A state is always said in words with
  an icon, never by colour alone — owner, 2026-11-27
- D88 The consumed percentage is rounded to a whole number (down: D92) and shown as it is beyond 100 % ("117 %"). The reference: an hour
  package → its hours in the current period; `fixed_price` → its max effort (the estimate, when known, is shown as a reference
  mark on the bar, not as the percentage's base); `t_and_m` → the sum of its positions' planned man-days. None for an SLA-only,
  an internal and a no-terms project, nor for a package not started (as the figures today) — owner, 2026-11-27. The owner's
  phrase was "usage percentage"; the glossary lists "usage" among the words to avoid for consumption, so the spec says
  "consumed percentage"
- D89 Dates ("times overrun"): the `fixed_price` deadline AND the terms' end date of every client type — passed → the graver
  state, saying by how many days; 30 days or fewer remaining → the milder state, saying in how many days; otherwise nothing.
  The same 30 days as specs/20261112-project-alerts AC-1.4 — owner, 2026-11-27
- D90 Time elapsed (the "today" mark and the pace line): shown for hour packages whose current period has an end (yearly;
  capacity with an expiry date) and for a `fixed_price` over the span from its terms' start date to its deadline; not shown
  for a capacity package without an expiry, a `t_and_m`, SLA-only, internal or no-terms projects — owner, 2026-11-27
- D91 An expired capacity package: its final figures stay neutral — no close-to-the-limit or over state, even if it had gone
  over — with the existing "Expired" mark (AC-1.9, D83); the excess still reads in the figures — owner, 2026-11-27

Decided by the owner on 2026-11-27, the same day, answering the two open questions the second re-opening raised (O5, O6) and
confirming one of its assumptions (A55), before the spec's new approval. Numbered after D91:
- D92 (closes O5) The consumed percentage is the exact percentage rounded DOWN to a whole number (the floor), beyond 100 % as
  well, so the number never contradicts the state: 119 h 30 of 120 h (99.58 %) reads "99 %" and is close to the limit; 95 h 30
  of 120 h (79.58 %) reads "79 %" and is on track; 116.25 % reads "116 %"; "100 %" is read only once the reference is fully used
  (from exactly the reference up to, not including, 101 % of it). The state, the excess and the bar still follow the exact
  hours (A53). Both thresholds being whole numbers, the floor reads below 80 % exactly when the project is on track, 80 % to
  99 % exactly when it is close to the limit and 100 % or more exactly when it is over. Refines D88 ("rounded to a whole
  number"); AC-5.5 to AC-5.9, AC-5.12 and A53 follow. Rejected: rounding half up (95 h 30 of 120 h would read 80 % and 119 h 30
  would read 100 %, with the state saying on track and close to the limit with 30 min left) — owner, 2026-11-27
- D93 (closes O6) A closed or cancelled project shows no state and no date signal, as project-alerts gives it no alert
  (specs/20261112-project-alerts AC-1.5, AC-1.8, A30); a planned, active or on-hold project shows them; its figures, its bar and
  its time elapsed read as for any other project (AC-5.26). Confirms A54. Rejected: showing them like any other project (a
  project whose terms ended on purpose, F20, would read "passed by 200 days" at the graver level once closed) — owner,
  2026-11-27
- D94 (confirms A55) A date — a terms' end date, a fixed price's deadline — is a whole calendar day of the Europe/Zurich
  calendar, counted in whole days from the page's day (A52, D85); the day itself is "today" and has not passed (0 days away,
  said as today); it has passed from the next day, by 1 day, as a capacity package's expiry date has (AC-1.9, F18). D89 had not
  said; confirmed as written (AC-5.21, AC-5.22) — owner, 2026-11-27
Decided by the owner on 2026-11-27 at the plan's gate 2, after the spec's new approval, on what the design and the plan raised:
- D95 (design.md G9) At exactly 100 % of the reference — the hours used equal the reference, nothing left and no excess — the
  over state is said as the limit being reached ("Limit reached", "Limite raggiunto"); "Over the limit" ("Oltre il limite") only
  once the hours are above the reference. Same state, same graver level, icon and tone: only the words change (AC-5.9).
  Rejected: "Over the limit" from exactly 100 % (it says "over" where nothing has been exceeded) — owner, 2026-11-27
- D96 Readings of US-5 confirmed with the plan at gate 2 (design.md § Readings, G10, G11): an icon follows the level — three
  shapes for the three states, two for passed and near, a state and a date signal of the same level sharing their level's
  shape (AC-5.10); the bar's estimate is given in text by the "Estimated man-days" fact, its position on the bar not put in
  words (AC-5.11); a bar with no state said (an ended capacity package, a closed or cancelled project) is drawn neutral, never
  in a state's tone (AC-5.25, AC-5.26) — owner, 2026-11-27

Found while re-opening specs/20261112-project-hours (read from the repo, not asked):
- F14 A meeting has at most one host, a CRM deal or (since 2026-11-23) a project; a meeting started from a project task is
  linked to the task's project — specs/20261104-meetings A18; meetings-api `GET /system/meetings/hosts` answers `ids=` or
  `dealId=` today
- F15 A won public tender becomes a project with terms and no purchase order — ADR 20261124-a-won-public-tender-…;
  a fixed-price project always has a deadline and a max effort, its estimated man-days may be absent —
  projects-api `project_terms` CHECKs

Found while re-opening specs/20261112-project-hours a second time (2026-11-27, read from the repo, not asked):
- F16 Today the consumption block draws figures only: hours used and left (or "Over by" once a package is exceeded, D81),
  man-days used against the estimate, the max effort or the planned total — no percentage, no state, no bar and no date line;
  a capacity package past its expiry shows the "Expired" mark; terms that sold nothing comparable draw no block at all —
  `projects-ui/src/components/ConsumptionBlock.tsx:50-111`, `projects-ui/src/lib/consumption.ts:120-181`. The design recorded
  "no status colour" and "no progress bar" — `specs/20261112-project-hours/design.md:182-190` (reversed by D86)
- F17 What terms allow: a start date is required and an end date optional, not before the start, for every client type; a
  fixed price has a required deadline, a max effort above zero and an optional estimate of zero or more; an hour package has
  more than zero hours; a time-and-material project has 1 to 50 positions, each above zero man-days. No rule orders a fixed
  price's deadline against its start date, nor its estimate against its max effort — `projects-api/src/terms/terms.schemas.ts:30-70,
  83-87`, `projects-api/prisma/migrations/20261103163000_init/migration.sql:137-165`. So a reference is never zero, a deadline
  can precede the start date (no span for the time elapsed) and an estimate can exceed the max effort (a mark beyond the scale)
- F18 A package period's ends are inclusive and a capacity package has ended only from the day after its expiry date
  (`ended: today > expiryDate`); the day is Europe/Zurich and the server's (D85) — `projects-api/src/terms/packagePeriod.ts:68-87`
- F19 A project's states are planned, active, on_hold, closed and cancelled; specs/20261112-project-alerts raises no alert for a
  closed or cancelled project and raises the end-date and deadline alert only for one that is not — `projects-ui/src/lib/types.ts:14`,
  `specs/20261112-project-alerts/spec.md:57-58, 63`
- F20 The terms' end date is also how a project "ends" its terms (a contract is never deleted, it ends by an end date) —
  specs/20261103-projects AC-2.10 — so a passed end date can be deliberate; specs/20261112-project-alerts raises its alert for it all the same (AC-1.5)
- F21 The library has no percentage formatter of its own: `formatNumber` takes `{ style: 'percent' }` (en-GB and it-IT number
  formats) — `operai-ui/src/lib/format.ts:114-121`

Assumed while re-opening specs/20261112-project-hours (2026-11-26, not grilled — strike any that is wrong):
- A48 (030) An hour recorded both on a linked meeting and on its project counts twice for the project (A1); not detected
- A49 (030) The project manager's per-person figure includes people outside the team who took part in a linked meeting
- A50 (030) A deal's hours do not count for the project made from it, nor the reverse
- A51 (030) Before an hour package's start date no period is current; hours recorded before it count in no period

Assumed while re-opening specs/20261112-project-hours a second time (2026-11-27, not grilled — strike any that is wrong;
A52 is the spec's own, written at D85; A53 to A55 were then confirmed by the owner the same day, D92–D94, and A56 was added):
- A53 (030) The state, the excess and the bar are decided on the exact hours, and the percentage is the exact percentage
  rounded down for display (D92): with whole-number thresholds it never contradicts the state — confirmed by the owner with
  D92 (closes O5)
- A54 (030) A closed or cancelled project shows no state and no date signal, as it gets no alert (project-alerts AC-1.5, AC-1.8,
  A30); a planned, active or on-hold project shows them — confirmed by the owner, D93 (closes O6)
- A55 (030) A date is a whole calendar day of the Europe/Zurich calendar, counted in whole days from the page's day; the date
  itself has not yet passed (it has passed from the next day, as a capacity package's expiry date has, AC-1.9) and is 0 days
  away, said as today — D89 did not say; confirmed by the owner, D94
- A56 (030) The time elapsed (AC-5.20) is rounded down to a whole number, as the consumed percentage is (D92): rounded half up,
  a span of 200 days or more would read 100 % on its last day, before it has ended (a yearly package, 365 days, would), which
  contradicts "100 % from the day after its last day". Written after D92, not asked of the owner, whose answer was about the
  consumed percentage — strike it if the time elapsed should be rounded another way

Delegated (the user deferred to the recommendation):
- none — every decision above was chosen explicitly

Found (read from the repo, not asked):
- F1 Time tracking was deferred on purpose to its own spec — specs/20261103-projects D27 and Non-goals, specs/20261103-project-collaboration Non-goals, specs/20261110-activities Non-goals
- F2 Activities live in activities-api (specs/20261110-activities): pre-sales on a company (+ optional contact, deal; note/call/meeting/email/task), operational on a project (tasks only); author, assignee, ≤ 10 participants — activities-api/prisma/schema.prisma; participants were introduced as "the base for time tracking later" — specs/20261101-crm US-8
- F3 A meeting linked to a deal is mirrored as a `meeting` activity on the deal — specs/20261110-activities AC-1.4, ADR 20261104-meeting-host-contract-resolve-and-notices
- F4 What was sold lives on a project's terms: hour package (capacity | yearly), fixed_price max effort + estimated man-days, t_and_m positions with planned man-days — specs/20261103-projects US-2; on main in `Contract`, on feat/projects-handoff (PR #9 open, 97 ahead / 0 behind main) in `ProjectTerms` + `PurchaseOrder` — ADR 20261105-terms-and-purchase-order-two-optional-records-of-a-project-contract-retired
- F5 specs/20261103-projects O2 (yearly package carry-over) is owned by "the time-tracking spec" — specs/20261103-projects/spec.md Open questions
- F6 No money in projects — specs/20261103-projects D14
- F7 `internal` projects exist (R&D, internal tools) — specs/20261103-projects domain language
- F8 A Meetings meeting has a start (`startsAt`), a duration only when it has audio (`durationMs`; none for a typed or pasted one), a creator and Operai participants — meetings-api/prisma/schema.prisma, specs/20261104-meetings
- F9 A CRM call/meeting activity has the moment it occurred and participants, but no duration — specs/20261101-crm US-4, US-8
- F10 The project team exists because "time tracking will need who may book on a project" — specs/20261103-projects ledger D15; the PM and team members are users with the project module's access, which employees do not hold by default — specs/20261103-projects AC-4.6
- F11 Every CRM record (deals included) is readable by every `crm:access` holder — ADR 20261101-crm-tool-shape-and-authorization
- F12 Departments in `auth` have no head or manager — auth/prisma/schema.prisma
- F13 "Proposal" is ProposAI's word (consulting proposals, AGENTS.md roadmap); the spec says "suggested entry" instead

Assumed (not load-bearing; strike any that is wrong):
- A1 Overlapping hours count in full on each thing they are booked on (10:00–12:00 on two projects gives each project 2 h) — follows from D4
- A2 Every active Operai user (every employee) can record their own hours, whatever tools they can open — follows from D1, D2
- A3 Being on the team or involved in the deal is checked when an entry is created or moved to a project or deal; entries already recorded stay, and stay correctable by their author, when the person leaves the team or stops being involved (the specs/20261110-activities AC-3.7 pattern; narrowed by D46)
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
- A20 A project or deal page still loads when hours cannot be loaded, and says so (the specs/20261110-activities AC-1.5 posture)
- A21 When the tool that owns a project, deal or meeting cannot confirm the person may book on it, the write is refused and nothing changes (fail closed, ADR 20260716-refund-api-authorization-enforcing-resource-server, 20261110-activities-service-access-delegated-to-host posture); the person's own list still shows every entry, with an unknown name where it cannot be resolved
- A22 When an activity an entry points at is deleted, the entry stays on its project or deal without the pointer

Assumed while writing specs/20261112-meeting-hours and specs/20261112-project-hours (2026-11-12, not grilled — strike any that is wrong):
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
- O1 (specs/20261112-project-hours) closed by D27
- O2 (specs/20261112-project-hours) closed by D28
- O3 Labour-law check before go-live: informing employees about the hours recorded and who reads them (IT: art. 4 L. 300/1970; CH: art. 26 OLL 3) — owner: management / HR
- O4 A lock or approval of recorded hours before they are used to bill T&M on a timesheet — owner: product owner, at the latest with specs/20261112-project-hours or a billing export
- O5 (specs/20261112-project-hours) closed by D92 — the consumed percentage is rounded down, so it never reads at or above a threshold the state has not reached
- O6 (specs/20261112-project-hours) closed by D93 — a closed or cancelled project shows no state and no date signal
