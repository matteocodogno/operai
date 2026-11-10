---
id: 027
slug: project-collaboration
status: draft
rigor: mvp
created: 2026-11-03
depends-on: 025
---

# Project collaboration — tasks and discussion threads

Decision ledger: `../025-projects/ledger.md` (shared with specs/025 and specs/026)

> **Origin.** Split out of specs/025 on 2026-11-03 (ledger D33). specs/025 gives projects,
> their project manager and team; this spec gives that team a shared to-do list and a place
> to discuss the project that keeps its history.

## Problem

Once a project exists, what is left to do, who is doing it and what was decided along the
way live in personal mailboxes, chats and people's heads. When someone is away, nobody can
tell which of their to-dos are open; when a choice is questioned months later, nobody can
show when and by whom it was made, or whether the message that recorded it was changed
since.

## Domain language

- **task** — as in the CRM (specs/017): something someone must do, with an assignee and an
  optional due date, open until done; here it belongs to a project (D28, A17).
- **thread** — a titled discussion on a project; its messages are never deleted and keep
  every earlier version of an edit (D31).

## User stories

### US-1 Tasks
As a project manager, I want to list what is left to do on a project and who does it, so
that the team works from one list.

- AC-1.1 A task has a title (required), an assignee — the project's project manager or a
  team member — and an optional due date (D28, A18).
- AC-1.2 Creating, editing and reassigning a task requires the manage-projects capability
  for the project's entity (D13).
- AC-1.3 The assignee of a task can mark it done or not done, without the manage-projects
  capability (A22).
- AC-1.4 The project page lists open tasks, earliest due first and no due date last, marks
  overdue ones, and can show done ones instead — the CRM's task list convention (specs/017
  AC-4.4).

### US-2 Threads keep the project's history
As anyone working on a project, I want to discuss it in threads that keep their history,
so that we can reconstruct what was decided and when.

- AC-2.1 Any project-module user opens a thread on a project with a title and a first
  message, and replies to any thread (D31).
- AC-2.2 A thread shows its messages in chronological order, each with its author's live
  Operai name (ADR-0039 posture) and the moment it was written.
- AC-2.3 Only the author of a message can edit it; an edited message shows "edited" (D31).
- AC-2.4 The previous versions of an edited message can be opened, each with the moment it
  was replaced (D31).
- AC-2.5 No one, admins included, can delete a thread or a message (D31).

### US-3 Access and copy
As anyone with access to the project module, I want to read every project's tasks and
threads in my language, so that I can cover for a colleague.

- AC-3.1 Every holder of the project module's access reads every task and thread
  (D13, specs/025 AC-4.3).
- AC-3.2 All new copy exists in English and Italian; dates use the library formatters.

## Non-goals

- **Notifications** for tasks or threads: assignment, due dates, new messages (A19).
- **Planned units of work**: tasks carry no man-days, no estimate epics and no link to a
  contract; no Gantt or timeline (D28).
- **Time tracking** against tasks (D27).
- **Attachments and @mentions** in threads (A28).
- Deleting or hiding messages, including by admins (D31).

## Assumptions (from the ledger — strike any that is wrong)

- A17 The to-do is the CRM's **task** concept on a project.
- A18 A task's assignee is the project manager or a team member.
- A19 No notifications in v1.
- A22 The assignee may mark their own task done.
- A28 Threads are plain text: no attachments, no mentions in v1.

## Open questions

- None.
