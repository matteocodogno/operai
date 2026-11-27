---
id: 20261112
slug: project-hours
status: in-progress
rigor: production
created: 2026-11-12
reopened: 2026-11-26
approved: 2026-11-26
depends-on: 20261103-projects, 20261103-projects-handoff, 20261104-meetings, 20261112-time-tracking, 20261116-record-hours-in-place
---

# Project hours — time worked against what was sold

Decision ledger: `../20261112-time-tracking/ledger.md` (shared with specs/20261112-time-tracking, specs/20261112-meeting-hours and
specs/20261112-project-alerts; this spec's decisions are D10, D13, D22, D27 and D28, D78–D79 added when it was re-opened, D80 at design, D81–D84
while deriving the tasks and D85 accepted by the owner on 2026-11-27)

> **Origin.** Split out of specs/20261112-time-tracking on 2026-11-12 (ledger D11, D26). specs/20261112-time-tracking records time
> entries; this spec puts a project's hours next to what its terms sold — the hour package, the
> max effort and estimated man-days of a fixed price, the positions of a time-and-material project
> (specs/20261103-projects US-2, as amended by specs/20261103-projects-handoff) — and shows a project's and a deal's hours on their
> pages. It answers specs/20261103-projects O2 (D28). The alerts raised from these figures are **specs/20261112-project-alerts**
> (D34). **It builds on the project terms and purchase order of specs/20261103-projects-handoff (PR #9, merged
> 2026-11-14).**
>
> **Re-opened on 2026-11-26**, before any plan (first approved on 2026-11-12). Since then a meeting can be linked to a
> project (specs/20261104-meetings A18, 2026-11-23), and specs/20261112-meeting-hours (PR #12) records a meeting's hours
> automatically for the people who took part; that spec leaves to this one how a project counts the hours of its
> meetings. The owner decided that they count for the project everywhere, as a linked meeting's hours already count for
> a deal (ledger D78, US-4), and that no one beyond the holders of see everyone's hours sees the per-person figure of a
> project that awaits its project manager (D79, AC-2.7). AC-2.1 now says where hours without a work type go. Every other
> acceptance criterion is unchanged. A project made from a won public tender has terms and no purchase order (ADR
> 20261124-a-won-public-tender-becomes-a-project-without-a-purchase-order-…) and is compared like any other project with
> terms.
>
> **Amended 2026-11-26 while deriving the tasks** (the owner's answers to the design's gaps G1–G5): an exceeded package
> shows the hours it is exceeded by, as a positive figure (AC-1.1, D81); terms that sold nothing comparable show the total
> only (AC-1.7, D82); an expired capacity package says so (AC-1.9, D83); and the hours figures of a project or deal page
> follow a save made with Record hours on that page (AC-2.8, D84).
>
> **Amended 2026-11-27 while implementing** (the owner, D85): a known limitation is accepted, not a change of scope. A capacity
> hour package without an expiry date is compared up to the Zurich day the page was loaded on, so a project page left open across
> Zurich midnight leaves the hours recorded on the new day out of its consumption figures until it is reloaded (A52, AC-1.3,
> AC-2.8). No acceptance criterion changes.

## Problem

A project's terms say how many hours a maintenance client bought and how much effort a fixed price
may take, but nothing tells the project manager how much of it has been used. An hour package runs
out, or expires half unused, and the first to notice is the client; a fixed price passes its max
effort unnoticed. specs/20261112-time-tracking now records the hours, but until they are set against the terms the
record cannot answer how much is left. And since a meeting can be linked to a project, the time spent meeting about it
is recorded on the meeting, where no figure of the project sees it.

## Domain language

- **hours on a project** — the hours recorded on the project itself plus the hours recorded on the meetings linked to it
  now (D78, US-4). Every figure of this spec about a project's hours means these. For a deal, the same rule already
  holds (specs/20261112-time-tracking AC-2.6).
- **linked meeting** — a Meetings meeting whose host is a project or a deal (specs/20261104-meetings). A meeting has at
  most one host, so its hours count for one project or one deal, never both.
- **consumption** — the hours on a project, set against what its terms sold: the hour package, or the max effort and
  estimated man-days, or the positions' planned man-days.
- **man-day** — 8 hours, in every comparison (D27). Not the contractual day of specs/20261112-time-tracking.
- **package period** — for a yearly hour package, each 12 months from its start date (specs/20261103-projects
  A7); for a capacity package, from its start date to its expiry, or open-ended without one.
- **terms**, **purchase order**, **ops-manager** — as in specs/20261103-projects-handoff.

## User stories

### US-1 Consumption on the project page
As a project manager, I want to see how much of what was sold has been used, so that I act before
it runs out.

- AC-1.1 Given a project whose terms have an hour package, then its page shows, for the current
  package period, the package's hours, the hours recorded in that period and the hours left — or,
  once the package is exceeded, the hours it is exceeded by, as a positive figure (D10, D81).
  *(Amended 2026-11-26: "negative when exceeded" became "exceeded by", D81.)*
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
- AC-1.7 Given a project with no terms (`internal`, or made by hand without them), or whose terms
  sold nothing to compare with (an SLA and no hour package), then its page shows only the total
  hours recorded (D82). *(Amended 2026-11-26: the SLA-only case added, D82.)*
- AC-1.8 Given every holder of the project module's access, then they see these figures; none of
  them shows an amount, a price or a rate (specs/20261103-projects AC-2.9, A32).
- AC-1.9 Given a capacity package whose expiry date has passed, then its page says that the package
  has expired, beside the figures of its period (D83). *(Added 2026-11-26.)*

### US-2 Hours on the project and deal pages
As a project manager or a deal owner, I want to see who spent the hours on my project or deal, so
that I know where the effort went.

- AC-2.1 Given anyone who can read a project, then its page shows the total hours recorded on it,
  and per work type, the hours without a work type (an entry on a meeting has none) forming one group of their own
  (D22). *(Last clause added 2026-11-26.)*
- AC-2.2 Given anyone who can read a deal, then its page shows the total hours recorded on it —
  including the hours of meetings linked to it (specs/20261112-time-tracking AC-2.6) — and per work type (D22).
- AC-2.3 Given the project's project manager, then its page also shows the hours each person
  recorded on it (D22).
- AC-2.4 Given the deal's owner, then its page also shows the hours each person recorded on it
  (D22).
- AC-2.5 Given anyone else without see everyone's hours (specs/20261112-time-tracking), then neither page shows a
  per-person figure (D22).
- AC-2.6 Given hours cannot be loaded, then the project or deal page still loads and says that
  hours are unavailable (A20).
- AC-2.7 Given a project that awaits its project manager (specs/20261103-projects-handoff), then only holders of see
  everyone's hours see its per-person figure; its purchase order's ops-manager does not, unless they hold that
  permission (D79). *(Added 2026-11-26.)*
- AC-2.8 Given a person who records hours from a project's or a deal's page (specs/20261116-record-hours-in-place),
  when the save succeeds, then that page's hours figures include the new hours without the page being reloaded (D84).
  *(Added 2026-11-26.)*

### US-3 Access and copy
As an admin, I want consumption to follow the project module's rules, so that nothing new is
exposed.

- AC-3.1 Given the figures of US-1 and US-2, then they use only the hours of specs/20261112-time-tracking and the
  terms of specs/20261103-projects-handoff; nothing is entered by hand to feed them.
- AC-3.2 Given any new copy, then it exists in English and Italian, and dates, hours and man-days
  use the library formatters.

### US-4 Hours of the meetings linked to a project
As a project manager, I want the time spent in my project's meetings to count for the project, so that its consumption
includes the meetings with the client and the team. *(Added 2026-11-26, D78.)*

- AC-4.1 Given an entry on a meeting linked to a project, then its hours count for that project, whether its person
  recorded it or Operai did (specs/20261112-meeting-hours), and whether or not that person is on the project's team
  (D78).
- AC-4.2 Given a meeting that is relinked to another project or to a deal, or unlinked, then from the next read its
  hours count for its new host only, or for no project, and no longer for the old project (D78).
- AC-4.3 Given the figures of US-1 and US-2 for a project, then they include the hours of AC-4.1 (D78).
- AC-4.4 Given the hours views of specs/20261112-time-tracking filtered by a project, then they also list the entries on
  the meetings linked to that project (specs/20261112-time-tracking AC-4.4 widened, D78).
- AC-4.5 Given the hours views' totals grouped by project, then the entries on a meeting linked to a project are counted
  under that project (specs/20261112-time-tracking AC-4.5 widened, D78).
- AC-4.6 Given an export of the hours view, then an entry on a meeting linked to a project also carries that project,
  so the file summed by project matches the by-project totals of AC-4.5 (specs/20261112-time-tracking AC-4.6 widened,
  D78).
- AC-4.7 Given a viewer who cannot read the project a meeting is linked to, then the entry is listed, counted and
  exported, and that project is treated exactly as specs/20261112-time-tracking AC-4.10 treats the deal a meeting is
  linked to: no name, and its id withheld by the same rule (D78).
- AC-4.8 Given an hours view filtered by a project, when Meetings cannot say which meetings are linked to that project,
  then the view is refused as unavailable and nothing partial is shown; pages of a list already shown before a later page
  fails stay, with the error below them (specs/20261112-time-tracking AC-4.11 widened, D45, D48, D78).
- AC-4.9 Given a project page, when Meetings cannot say which meetings are linked to the project, then the page says its
  hours are unavailable (AC-2.6) and shows no hours figure lower than the truth (D45, D78).
- AC-4.10 Given an hours view without a project filter, when Meetings cannot say which meetings are linked to a
  project, then the view still answers as specs/20261112-time-tracking AC-4.7 says (D45, D78).
- AC-4.11 Given an entry on a meeting that counts for a project, then in My hours' table view its hours are on the
  meeting's row, not on the project's row (as specs/20261116-record-hours-in-place AC-5.7 for a deal, D78).

## Non-goals

- **Alerts** raised from these figures — package thresholds, end dates, deadlines, idle hours,
  effort overrun: **specs/20261112-project-alerts** (D34).
- **Per-position comparison** on time-and-material projects (D13).
- **Carrying unused hours** of a yearly package into the next period (D28).
- **Money**: no amount, price, rate or cost anywhere (specs/20261103-projects D14).
- **Locking or approving hours** — specs/20261112-time-tracking O4 still applies before hours are used to bill.
- **Detecting the same time recorded twice** — on a linked meeting and on its project — or merging the two (A48).
- **Moving an entry** from a linked meeting onto its project, or the reverse, on the person's behalf: the person still
  may, as for any entry (specs/20261112-time-tracking).

## Constraints

- None given by the user.

## Assumptions (strike any that is wrong)

- A20 A project or deal page still loads when hours cannot be loaded, and says so.
- A32 Consumption figures are visible to every holder of the project module's access, like the
  totals of D22.
- A33 Hour packages are compared in hours; fixed price and time-and-material in man-days.
- A34 Man-days are shown with one decimal.
- A48 An hour recorded both on a linked meeting and on its project counts twice for the project, as parallel work does
  (specs/20261112-time-tracking A1); Operai neither detects nor merges it.
- A49 The project manager's per-person figure (AC-2.3) includes the hours of people outside the team who took part in
  a linked meeting, as the deal owner's per-person figure includes a linked meeting's participants (AC-2.4).
- A50 The hours recorded on a deal do not count for the project made from it, nor the reverse.
- A51 Before an hour package's start date no package period is current: the page shows the package with no consumption,
  and hours recorded before the start date count in no period.
- A52 A capacity package without an expiry date is compared from its start date up to today (AC-1.3), and today is the
  Europe/Zurich day Projects works out when the project page loads. If that page stays open across Zurich midnight and the
  person then records hours from it with Record hours (AC-2.8), the hours on the new day are not in the page's consumption
  figures until the page is reloaded, while the project's total hours (AC-2.1) include them. Nothing is lost and nothing is
  wrong after a reload. Accepted by the owner on 2026-11-27 as a known limitation, not fixed by this spec (D85).

## Open questions

- None.
