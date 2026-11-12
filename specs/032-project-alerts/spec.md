---
id: 032
slug: project-alerts
status: approved
rigor: production
created: 2026-11-12
approved: 2026-11-12
depends-on: 026, 028, 030
---

# Project alerts — tasks for the moments a project needs a decision

Decision ledger: `../029-time-tracking/ledger.md` (shared with specs/029, specs/030 and
specs/031; this spec's decisions are D12 and D29–D33)

> **Origin.** Split out of specs/030 on 2026-11-12 (ledger D34). specs/030 shows a project's hours
> against what its terms sold; this spec turns the moments those figures — and the terms' dates —
> call for a decision into tasks for the project manager, in the user's words "trigger che genera
> un task" (D12). **It builds on specs/030 and on the project terms and purchase order of
> specs/026 (PR #9).**

## Problem

Even with consumption on the project page, someone has to look at it at the right time. An hour
package is used up, or is about to expire half unused; a maintenance client stops asking for work;
a contract nears its end date with nobody deciding on renewal; a fixed price passes its deadline
or its max effort. Today these moments are noticed late — often by the client — because nothing
tells the person responsible that a decision is due.

## Domain language

- **alert** — a project task (specs/028 US-3) that Operai creates when a project reaches one of the
  moments of US-1, assigned to the project's project manager (A27). _Avoid:_ warning, reminder,
  notification.
- **moment** — one occasion an alert is raised for: one threshold in one package period, one end
  date, one deadline, one idle stretch (A28).
- **consumption**, **man-day**, **package period** — as in specs/030; **terms**, **purchase
  order**, **ops-manager**, **awaiting a project manager** — as in specs/026.

## User stories

### US-1 Alerts become tasks
As a project manager, I want Operai to give me a task when a project needs a decision, so that I
do not have to watch the figures.

- AC-1.1 Given a project with an hour package, when the hours recorded in the current package
  period reach 80 % of the package, then an alert is created; when they reach 100 %, another
  (D29).
- AC-1.2 Given a project with an hour package, when 15 days remain before the end of the current
  period (yearly) or before the expiry (capacity) and more than 25 % of the period's hours are
  unused, then an alert is created (D30). A capacity package without expiry never reaches this
  moment.
- AC-1.3 Given an `active` project with an hour package, when no hours have been recorded on it for
  10 days, then an alert is created (D30, A29).
- AC-1.4 Given a project whose terms have a start and an end date, when 30 days remain before the
  end date, then an alert is created (D31).
- AC-1.5 Given a project that is not closed or cancelled, when its terms' end date, or a
  `fixed_price`'s deadline, has passed, then an alert is created (D32).
- AC-1.6 Given a `fixed_price` project, when the hours recorded reach 80 % of its max effort (one
  man-day = 8 hours, specs/030), then an alert is created; when they reach 100 %, another (D32,
  D27).
- AC-1.7 Given a `t_and_m` project, then no alert of any kind is ever created for it (D33).
- AC-1.8 Given a closed or cancelled project, then no alert is created for it (A30).
- AC-1.9 Given one moment, then at most one alert is created for it, even if the figures cross the
  threshold again; a changed end date or deadline is a new moment (A28).
- AC-1.10 Given an alert, then it is a task on the project, assigned to its project manager — or
  to its purchase order's ops-manager while the project awaits a project manager — with a title
  that names the moment and the figures (A27).
- AC-1.11 Given an alert, then it behaves like any project task (specs/028 US-3, US-6): it is
  listed on the project and in the assignee's My tasks, the assignee is notified, and it is done
  when the assignee marks it done.
- AC-1.12 Given a project made by hand with terms, then it gets the same alerts as a project with a
  purchase order (A31).

### US-2 Copy
As anyone who receives an alert, I want to read it in my language, so that I understand it at once.

- AC-2.1 Given an alert's title and its notification, then they exist in English and Italian, and
  dates, hours and man-days use the library formatters.

## Non-goals

- **Alerts on time-and-material projects** (D33).
- **Configuring thresholds**: 80 %, 100 %, 15 days, 25 %, 10 days and 30 days are fixed
  (D29–D31).
- **Alerts as anything other than a task**: no email or banner of their own; the task's own
  notification (specs/028 US-6) is the only one (D12).
- **Alerts on deals**, or on projects without terms.
- **Showing consumption** — that is specs/030.

## Constraints

- Alerts are tasks — the user's words: "trigger che genera un task" (ledger D12). Several fire on a
  date rather than on a write (AC-1.2–1.5); the suite otherwise derives time-based state on read
  and never sweeps it (ADR-0013, ADR-0062), so the plan must decide how these fire, likely with an
  ADR.

## Assumptions (strike any that is wrong)

- A27 An alert is assigned to the project manager, or to the PO's ops-manager while the project
  awaits one.
- A28 One alert per moment; a changed date is a new moment.
- A29 The idle check runs only while the project is `active`; one alert per idle stretch, which
  ends when hours are recorded again.
- A30 Closed and cancelled projects get no alerts.
- A31 A project made by hand with terms gets the same alerts as one with a purchase order.

## Open questions

- None.
