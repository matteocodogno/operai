---
id: 030
slug: project-hours
status: approved
rigor: production
created: 2026-11-12
approved: 2026-11-12
depends-on: 025, 026, 029
---

# Project hours — time worked against what was sold

Decision ledger: `../029-time-tracking/ledger.md` (shared with specs/029, specs/031 and
specs/032; this spec's decisions are D10, D13, D22, D27 and D28)

> **Origin.** Split out of specs/029 on 2026-11-12 (ledger D11, D26). specs/029 records time
> entries; this spec puts a project's hours next to what its terms sold — the hour package, the
> max effort and estimated man-days of a fixed price, the positions of a time-and-material project
> (specs/025 US-2, as amended by specs/026) — and shows a project's and a deal's hours on their
> pages. It answers specs/025 O2 (D28). The alerts raised from these figures are **specs/032**
> (D34). **It builds on the project terms and purchase order of specs/026 (PR #9): no work on it
> starts before that PR is merged.**

## Problem

A project's terms say how many hours a maintenance client bought and how much effort a fixed price
may take, but nothing tells the project manager how much of it has been used. An hour package runs
out, or expires half unused, and the first to notice is the client; a fixed price passes its max
effort unnoticed. specs/029 now records the hours, but until they are set against the terms the
record cannot answer how much is left.

## Domain language

- **consumption** — the hours recorded on a project (specs/029), set against what its terms sold:
  the hour package, or the max effort and estimated man-days, or the positions' planned man-days.
- **man-day** — 8 hours, in every comparison (D27). Not the contractual day of specs/029.
- **package period** — for a yearly hour package, each 12 months from its start date (specs/025
  A7); for a capacity package, from its start date to its expiry, or open-ended without one.
- **terms**, **purchase order**, **ops-manager** — as in specs/026.

## User stories

### US-1 Consumption on the project page
As a project manager, I want to see how much of what was sold has been used, so that I act before
it runs out.

- AC-1.1 Given a project whose terms have an hour package, then its page shows, for the current
  package period, the package's hours, the hours recorded in that period and the hours left
  (negative when exceeded) (D10).
- AC-1.2 Given a yearly package, then each 12-month period is compared on its own: hours not used
  in one period are not added to the next (D28).
- AC-1.3 Given a capacity package, then the hours recorded from its start date up to its expiry
  (or up to today, without one) are compared with its hours.
- AC-1.4 Given a `fixed_price` project, then its page shows the hours recorded, in man-days,
  against its estimated man-days (when known) and its max effort (D10, D27).
- AC-1.5 Given a `t_and_m` project, then its page shows the hours recorded, in man-days, against
  the total of its positions' planned man-days; positions are not compared one by one (D13).
- AC-1.6 Given hours converted to man-days, then one man-day is 8 hours and the figure is shown
  with one decimal (D27, A34).
- AC-1.7 Given a project with no terms (`internal`, or made by hand without them), then its page
  shows only the total hours recorded.
- AC-1.8 Given every holder of the project module's access, then they see these figures; none of
  them shows an amount, a price or a rate (specs/025 AC-2.9, A32).

### US-2 Hours on the project and deal pages
As a project manager or a deal owner, I want to see who spent the hours on my project or deal, so
that I know where the effort went.

- AC-2.1 Given anyone who can read a project, then its page shows the total hours recorded on it,
  and per work type (D22).
- AC-2.2 Given anyone who can read a deal, then its page shows the total hours recorded on it —
  including the hours of meetings linked to it (specs/029 AC-2.6) — and per work type (D22).
- AC-2.3 Given the project's project manager, then its page also shows the hours each person
  recorded on it (D22).
- AC-2.4 Given the deal's owner, then its page also shows the hours each person recorded on it
  (D22).
- AC-2.5 Given anyone else without see everyone's hours (specs/029), then neither page shows a
  per-person figure (D22).
- AC-2.6 Given hours cannot be loaded, then the project or deal page still loads and says that
  hours are unavailable (A20).

### US-3 Access and copy
As an admin, I want consumption to follow the project module's rules, so that nothing new is
exposed.

- AC-3.1 Given the figures of US-1 and US-2, then they use only the hours of specs/029 and the
  terms of specs/026; nothing is entered by hand to feed them.
- AC-3.2 Given any new copy, then it exists in English and Italian, and dates, hours and man-days
  use the library formatters.

## Non-goals

- **Alerts** raised from these figures — package thresholds, end dates, deadlines, idle hours,
  effort overrun: **specs/032** (D34).
- **Per-position comparison** on time-and-material projects (D13).
- **Carrying unused hours** of a yearly package into the next period (D28).
- **Money**: no amount, price, rate or cost anywhere (specs/025 D14).
- **Locking or approving hours** — specs/029 O4 still applies before hours are used to bill.

## Constraints

- None given by the user.

## Assumptions (strike any that is wrong)

- A20 A project or deal page still loads when hours cannot be loaded, and says so.
- A32 Consumption figures are visible to every holder of the project module's access, like the
  totals of D22.
- A33 Hour packages are compared in hours; fixed price and time-and-material in man-days.
- A34 Man-days are shown with one decimal.

## Open questions

- None.
