---
topic: Log hours directly from the project and deal pages and from task rows, not only from My hours in the user menu
grilled: 2026-11-16
target: idea (spec written from it: specs/20261116-record-hours-in-place/spec.md)
complete: true
---

## Decision ledger — record hours in place (project, deal, task rows)

Why (the user's words): "il fatto di dover aprire il time tracking dal menu in alto sembra macchinoso e
limita la velocità; dovrebbe essere possibile loggare le ore direttamente dalla vista del progetto/deal".

Map (all closed): B1 entry points (D1, D2) · B2 form (D3) · B3 who sees the button (D4) · B4 after saving (D6) ·
B5 where it lives (D5).

Decided (the user chose):
- D1 Entry points: "Record hours" on the project page, on the CRM deal page AND on each task row (the project's Tasks card, My tasks, the CRM's task lists), a task row prefilling the task as well — user chose this over the recommended "project + deal pages only" and over a global header button, 2026-11-16
- D2 A CRM task with no deal also offers "Record hours": it records "other work" with a category, without a link to the company or the task (an activity pointer exists only on a project or a deal, F6) — user chose this over the recommended "no button on such tasks" and over adding company as a target, 2026-11-16
- D3 Form: the My hours entry dialog itself, opened with the project or deal (and the task, from a task row) already set and not changeable there, the day set to today and focus on the duration; recording elsewhere stays My hours' job — user chose the recommended option over an editable target and over an inline quick form, 2026-11-16
- D4 Who sees the button: only people the page already knows can record there — the project's project manager and team, the deal's owner and technical contact, a task's assignee and participants (and, on a CRM task without a deal, its people, since "other work" needs no owner's leave); no new API: hours-api still decides, and an edge case the page cannot see (e.g. someone on a deal only through another activity) gets no button and uses My hours — user chose the recommended option over "everyone who reads the page" and over asking hours-api, 2026-11-16
- D5 Placement: a new, small spec that depends on specs/20261112-time-tracking only, can start once it closes and ship before specs/20261112-project-hours, whose read-only hours card later sits next to the button — user chose the recommended option over amending project-hours and over adding tasks to time tracking, 2026-11-16
- D6 After Save: a short success message on the page ("2 h 30 recorded on <project>") with a "See in My hours" link; nothing else on the page changes, and editing or deleting stays in My hours — user chose the recommended option over an Undo and over showing the person's own hours on the page, 2026-11-16
Delegated (the user deferred to the recommendation):
- (none)
Found (read from the repo, not asked):
- F1 My hours is reached from the user menu because the hours screens are ungated and not a `TOOLS` entry — docs/adr/20261112-hours-ui-ungated-remote.md
- F2 hours-ui's `EntryDialog` was designed prop-driven (initial values in, one submit out, no router coupling) precisely so the project/deal pages and meeting suggestions could reuse it — specs/20261112-time-tracking/design.md § Seams
- F3 The shell already lets a host page embed another remote's panel with a 5 s timeout, an error boundary and the host's own fallback (Meetings on the CRM deal page) — shell/src/lib/extensions.tsx, ADR 20261104-host-extension-federated-panel-through-the-shell
- F4 specs/20261112-project-hours (approved, no plan yet) adds a READ-ONLY hours card to the project and deal pages (US-2, D34); recording from those pages is in no spec — specs/20261112-project-hours/spec.md
- F5 Who may record is decided by hours-api at write time: on a project its project manager and team, on a deal its owner, its technical contact or an assignee/participant of one of its activities; anyone else gets 403 `not_on_project` / `not_involved_in_deal` — specs/20261112-time-tracking AC-2.2, AC-2.3, ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route
- F6 An entry may point at one activity (task) only on a project or a deal — specs/20261112-time-tracking AC-2.7
- F7 A timer or start/end times are a non-goal of time tracking v1 (D8)
- F8 Hours "right after a meeting" are covered by specs/20261112-meeting-hours (entries suggested from one's meetings)
- F9 A pre-sales (CRM) task is about a company and only OPTIONALLY about one of its deals; time tracking has no "company" target (project, deal, meeting or other work only) — .claude/context/glossary.md § Activities, specs/20261112-time-tracking US-2
Assumed (not load-bearing; strike any that is wrong):
- A1 If hours-ui cannot load, the project/deal page and the task lists still work and show the host's own fallback in place of the button (F3; the A20 posture of specs/20261112-project-hours)
- A2 Same rules as My hours: whole 30-minute steps, a real day not in the future, work type and note optional, the same refusals and messages (the dialog is the same, D3)
- A3 On a CRM task without a deal (D2) the dialog opens on "other work" with no category preselected: the person picks one (no "pre-sales" category is seeded, and none is configured as a default)
- A4 The button is offered on open and on completed tasks alike: hours are often recorded after the work is done
- A5 A project or deal the person can record on in My hours is exactly where the button may appear; whatever hours-api accepts or refuses there (a closed project, a lost deal) applies unchanged — no extra state rule in the pages
- A6 Meeting pages get no button: hours from meetings are specs/20261112-meeting-hours' suggestions (F8)
Open (unresolved — each needs an owner):
- (none)
