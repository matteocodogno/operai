---
id: 20261112
slug: project-hours
status: approved
rigor: production
created: 2026-11-12
reopened: 2026-11-27
approved: 2026-11-27
depends-on: 20261103-projects, 20261103-projects-handoff, 20261104-meetings, 20261112-time-tracking, 20261116-record-hours-in-place
---

# Project hours — time worked against what was sold

Decision ledger: `../20261112-time-tracking/ledger.md` (shared with specs/20261112-time-tracking, specs/20261112-meeting-hours and
specs/20261112-project-alerts; this spec's decisions are D10, D13, D22, D27 and D28, D78–D79 added when it was re-opened, D80 at design, D81–D84
while deriving the tasks, D85 accepted by the owner on 2026-11-27, D86–D91 added when it was re-opened a second time on 2026-11-27,
for the signals on the consumption block, and D92–D94, the owner's answers the same day to the questions that re-opening raised)

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
> **Amended 2026-11-27 while implementing** (the owner, D85): a known limitation is accepted, not a change of scope. A project
> page works out an hour package's current period, and with it whether the package has not started or has expired, on the
> Zurich day the page was loaded on, and keeps that day until it is reloaded. A page left open across a date therefore keeps
> showing the old state: a capacity package without an expiry date leaves the hours recorded on the new day out of its figures;
> a yearly package keeps its old period after its anniversary; a package keeps saying it has not started after its start date;
> a capacity package shows "Expired" only after a reload (A52, AC-1.1 to AC-1.3, AC-1.9, AC-2.8). The owner first accepted the
> first case and, the same day, every case with the same cause. No acceptance criterion changes.
>
> **Re-opened on 2026-11-27**, after the feature had passed QE and eval (approved 2026-11-12 and again 2026-11-26): the owner
> asked for **signals on the consumption block** — a consumed percentage, the states on track, close to the limit and over, the
> excess beyond 100 %, the time elapsed, and dates that have passed or are near — and chose to add them to this spec rather than
> to a spec of their own or to specs/20261112-project-alerts (D86). That re-opens gate 1: the status is back to `draft` until the
> owner approves again, and `approved:` still names the previous approval. The owner looked at three mockups and chose one: under
> the consumption figures, a bar of the consumed share on a scale that goes beyond 100 % (to 125 %) with marks at 80 % and 100 %,
> the part beyond 100 % drawn distinctly, a mark for today at the time elapsed, a line saying how much of the hours is used and how
> much of the period has elapsed, the estimate as a reference mark for a fixed price, and a line for a date that has passed or is
> near. The thresholds are fixed and are those of specs/20261112-project-alerts (D87); the percentage and its reference are D88
> and its rounding down is D92; the dates D89; the time elapsed D90; an expired capacity package stays neutral (D91).
> **New:** US-5 (AC-5.1 to AC-5.29), nine terms in the domain language, A53 to A56 and the non-goals that go with them.
> **Changed:** AC-1.7 (terms that sold nothing comparable may still show a date signal), AC-1.9 (an expired package's
> final figures carry no state), AC-3.2 (percentages and numbers of days use the library formatters), the first non-goal (the alerts
> stay specs/20261112-project-alerts'; these signals are drawn on the project page only) and A52 (a fifth case: the signals that read
> today, D85 extended). **Read next to US-5 and unchanged:** AC-1.1 (the hours "exceeded by" is the excess of AC-5.12 for a package),
> AC-1.4 and AC-1.5 (they gain the percentage and, once over, the excess), AC-1.8 (every reader sees the same signals, AC-5.27) and
> AC-4.9 (no hours figure while hours are unavailable, the percentage included, AC-5.4; the date signals read no hours, AC-5.24).
>
> **Answered by the owner on 2026-11-27, the same day (D92–D94).** The re-opening left two open questions and one assumption
> for the owner at approval; all three are answered. **D92 (O5):** the consumed percentage is the exact percentage rounded
> **down** to a whole number, so the number never contradicts the state — 119 h 30 of 120 h reads 99 % and is close to the
> limit, 95 h 30 of 120 h reads 79 % and is on track, and 100 % is read only once the reference is fully used; beyond 100 % it
> is floored too (116.25 % reads 116 %), and the state, the excess and the bar still follow the exact hours (AC-5.5 to AC-5.9,
> AC-5.12, A53). **D93 (O6):** a closed or cancelled project shows no state and no date signal (AC-5.26, A54). **D94 (A55):**
> a date is today, and has not passed, on its own day; it has passed from the next day (AC-5.22, A55). One consequence the
> owner did not rule on is recorded as an assumption, not asked: the time elapsed is rounded down as well (AC-5.20, A56).
> **No open question is left from O5 or O6, and the spec has none.** The acceptance criteria stay at 59 (from 30 before the
> signals were added).

## Problem

A project's terms say how many hours a maintenance client bought and how much effort a fixed price
may take, but nothing tells the project manager how much of it has been used. An hour package runs
out, or expires half unused, and the first to notice is the client; a fixed price passes its max
effort unnoticed. specs/20261112-time-tracking now records the hours, but until they are set against the terms the
record cannot answer how much is left. And since a meeting can be linked to a project, the time spent meeting about it
is recorded on the meeting, where no figure of the project sees it. Even with the figures on the project page, the project
manager still has to work out alone whether 84 h 30 of 120 h is fine, how much of the period has gone and whether a date that
matters has passed or is near: the page shows hours used and left, or by how much a package is exceeded, and nothing says when a
project is close to what was sold, over it, or past a date.

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
- **consumption block** — the part of a project's page that shows its consumption (US-1) and, since 2026-11-27, its signals
  (US-5).
- **reference** — what the consumed percentage is a share of: an hour package's hours; a fixed price's max effort; the total
  of a time-and-material project's positions' planned man-days. A fixed price's estimated man-days is not a reference (D88).
- **consumed percentage** — the hours on a project that the figures of US-1 count (those of the current period for an hour
  package, all of them for a fixed price and a time-and-material project) as a share of the reference, rounded down to a whole
  number of percent (D88, D92).
- **state** — what the block says about the consumed percentage: *on track* (below 80 % of the reference), *close to the limit*
  (from 80 % to below 100 %) or *over* (from 100 %) (D87). Not the project's own state (planned, active, on hold, closed or
  cancelled).
- **date signal** — what the block says about a terms' end date or a fixed price's deadline: that it has *passed*, or that it is
  *near* (30 days or fewer ahead) (D89).
- **level** — the two degrees of attention a state or a date signal can carry: the milder (close to the limit; a date that is
  near) and the graver (over; a date that has passed). On track is neither.
- **time elapsed** — how much of a span of days has gone by, as a whole number of percent (AC-5.20, D90).
- **pace line** — the one line that states the consumed percentage and, where there is one, the time elapsed (AC-5.18).
- **signal** — anything the consumption block says beyond its figures: a state, the excess, the time elapsed or a date signal.
  A signal is drawn on the project page only; it is not an alert (specs/20261112-project-alerts), and creates no task and no
  notification.

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
  hours recorded (D82) and, when it has terms with an end date that has passed or is near, that date's
  signal (AC-5.21, AC-5.22, AC-5.24). *(Amended 2026-11-26: the SLA-only case added, D82. Amended 2026-11-27: the date
  signal, D89.)*
- AC-1.8 Given every holder of the project module's access, then they see these figures; none of
  them shows an amount, a price or a rate (specs/20261103-projects AC-2.9, A32).
- AC-1.9 Given a capacity package whose expiry date has passed, then its page says that the package
  has expired, beside the figures of its period (D83), and its final figures carry no state (AC-5.25, D91).
  *(Added 2026-11-26. Amended 2026-11-27: no state.)*

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
- AC-3.2 Given any new copy, then it exists in English and Italian, and dates, hours, man-days, percentages and numbers of
  days use the library formatters. *(Amended 2026-11-27: percentages and numbers of days.)*

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

### US-5 Signals on the consumption block
As a project manager, I want the consumption block to tell me in words whether the project is on track, close to what was sold
or over it, how much of the period has gone, and whether a date has passed or is near, so that I see at a glance what needs a
decision and act before the client notices. *(Added 2026-11-27, D86–D94.)*

*The consumed percentage and its state*

- AC-5.1 Given a project whose terms have an hour package with a current period, then the block shows the consumed percentage:
  the hours recorded in that period (AC-1.1 to AC-1.3) as a share of the package's hours (D88). For example, 84 h 30 in a period
  of a 120 h package is 70 %.
- AC-5.2 Given a `fixed_price` project, then the block shows the consumed percentage: all the hours recorded on it (AC-1.4) as a
  share of its max effort, whether or not its estimated man-days are known (D88). For example, 72 h against a max effort of
  12.0 man-days (96 h) is 75 %.
- AC-5.3 Given a `t_and_m` project, then the block shows the consumed percentage: all the hours recorded on it (AC-1.5) as a
  share of the total of its positions' planned man-days (D88). For example, 60 h against positions planned at 10.0 and
  14.0 man-days (192 h) is 31 %.
- AC-5.4 Given a project with no terms, terms that sold nothing to compare with (AC-1.7), a package that has not started
  (A51), a reference that is not above zero (the terms do not allow one), or hours that cannot be loaded (AC-2.6, AC-4.9), then
  the block shows no consumed percentage, no bar, no state, no excess and no time elapsed (D88).
- AC-5.5 Given a consumed percentage, then it is the exact percentage rounded down to a whole number, and it is shown as it is
  beyond 100 % (D88, D92). For example, 75 h of a 120 h package (62.5 %) reads 62 %, 119 h 30 of 120 h (99.58 %) reads 99 %,
  139 h 30 of 120 h (116.25 %) reads 116 %, 140 h 30 (117.08 %) reads 117 %, and 216 h reads 180 %; 30 min of 120 h (0.42 %)
  reads 0 %, as does a project with no hours recorded in the period it is compared over. It reads 100 % only once the
  reference is fully used: from exactly the reference up to, not including, 101 % of it.
- AC-5.6 Given the hours and the reference, then the state, the excess and the bar are worked out from the exact hours (whole
  minutes) against the exact reference, never from the rounded percentage and never from man-days as they are shown to one
  decimal (A53). For example, 19 h against a max effort of 3.0 man-days (24 h) is 79 % and on track, although 19 h shows as 2.4
  of 3.0 man-days. Because the percentage is rounded down and the thresholds are whole numbers, it reads below 80 % exactly when
  the project is on track, from 80 % to 99 % exactly when it is close to the limit, and 100 % or more exactly when it is over:
  it never contradicts the state (D92).
- AC-5.7 Given hours below 80 % of the reference, then the block says the project is on track (D87). For example, 95 h 30 of a
  120 h package (79.58 %, which reads 79 %), and a package with nothing recorded (0 %).
- AC-5.8 Given hours from 80 % of the reference up to but not including 100 %, then the block says the project is close to the
  limit (D87). For example, 96 h of a 120 h package (exactly 80 %), and 119 h 30 of 120 h (99.58 %, which reads 99 %, with
  30 min left).
- AC-5.9 Given hours from 100 % of the reference, then the block says the project is over (D87). At exactly 100 % (120 h of a
  120 h package) it is over with no hours left and no excess; at 120 h 30 (100.42 %, which reads 100 %) it is over by 30 min.
- AC-5.10 Given any state or date signal, then it is said in words and by an icon of its own, so that none is told by colour
  alone (D87).
- AC-5.11 Given the bar, then everything it shows — the consumed percentage, the state, the time elapsed and the estimate — is
  also given in text, so that the block can be read without seeing the bar (D86).

*The excess*

- AC-5.12 Given hours above the reference, then the block shows the excess, the hours beyond the reference, as a positive
  figure: in hours for an hour package (the figure AC-1.1 calls "exceeded by") and in man-days with one decimal (AC-1.6) for a
  fixed price and a time-and-material project; at or below the reference there is none (D86). For example, 108 h against a max
  effort of 12.0 man-days (96 h) is 112 % and 1.5 man-days over.
- AC-5.13 Given a fixed price or time-and-material project over its reference by an amount that would show as 0.0 man-days,
  then the excess reads as less than 0.1 man-day, never as zero (D86). For example, 9 h against a max effort of 1.1 man-days
  (8 h 48 min) is over by less than 0.1 man-day.

*The bar*

- AC-5.14 Given a consumed percentage, then the block draws a bar of it on a scale from 0 % to 125 % of the reference, with a
  mark at 80 % and a mark at 100 %, filled in proportion to the consumed percentage (D86). For example, 100 % fills four fifths
  of the bar's length.
- AC-5.15 Given a consumed percentage above 100 %, then the part of the bar beyond the 100 % mark is a part of its own, told
  apart from the part before it by more than colour (D86). At exactly 100 % there is no such part.
- AC-5.16 Given a consumed percentage above 125 %, then the bar is filled to its end while the percentage and the excess still
  read in full (180 % reads 180 %); at exactly 125 % (150 h of a 120 h package) the fill reaches the end of the bar with nothing
  cut off (D86).
- AC-5.17 Given a `fixed_price` project whose terms carry estimated man-days, then the bar carries a mark for the estimate at the
  estimate's share of the max effort when that share is within the scale, ends included (10.0 man-days against a max effort of
  12.0 is at 83 %; an estimate of 0 is at the start; one of exactly 125 % of the max effort is at the end); an estimate beyond
  125 % of the max effort has no mark, and neither has a fixed price without an estimate nor any other kind of terms; the
  estimate's man-days stay in the figures (AC-1.4) (D86).

*The time elapsed*

- AC-5.18 Given an hour package whose current period has an end — a yearly package (its current period) or a capacity package
  with an expiry date (from its start date to its expiry date, an expired package included) — or a `fixed_price` project (from
  its terms' start date to its deadline), then the bar carries a mark for today at the time elapsed, and the pace line states the
  consumed percentage and the time elapsed together (for example, used 40 % of the hours with 50 % of the period elapsed)
  (D90).
- AC-5.19 Given a capacity package without an expiry date, a `t_and_m` project, or a `fixed_price` project whose deadline is
  before its terms' start date (the terms allow it), then no time elapsed is shown: no mark for today, and the pace line states
  the consumed percentage alone (D90). A project that shows no consumed percentage (AC-5.4) has no pace line.
- AC-5.20 Given a span of days, then its time elapsed is the number of its days that have gone by, today not counted, as a
  share of all its days — its first and its last day both counted — rounded down to a whole number (A56): 0 % up to and including
  its first day, 100 % only from the day after its last day, never beyond (D90). For example, in a span of 10 days it is 0 % on the
  first day, 40 % on the fifth, 90 % on the last and 100 % the day after; in a span of 365 days it is 99 % on the last day (364
  days gone) and 100 % the day after; in a span of one day it is 0 % on that day and 100 % the day after.

*The dates*

- AC-5.21 Given terms with an end date, whatever the client type, or a `fixed_price` project with its deadline, when that date
  is before today, then the block says which date it is (the terms' end date or the deadline), shows the date, and says that it
  has passed and by how many days, at the graver level (D89). The day after the date it has passed by 1 day.
- AC-5.22 Given the same dates, when the date is today or up to 30 days ahead, then the block says which date it is, shows the
  date and says in how many days it falls (today, for the day itself), at the milder level; with 31 days or more to go it says
  nothing (D89). Exactly 30 days ahead is said; 31 is not. A date that is today has not passed (D94).
- AC-5.23 Given a `fixed_price` project that has both a deadline and an end date, then each has its own line, even when both
  fall on the same day, and each is judged on its own (D89). Terms without an end date have no line for it.
- AC-5.24 Given a date signal, then it reads the terms alone: it shows when hours cannot be loaded (AC-4.9), for a package that
  has not started and for terms that sold nothing comparable (AC-1.7) (D89).

*Where no state is said*

- AC-5.25 Given a capacity package whose expiry date has passed (AC-1.9), then the block says no state about its consumption —
  neither close to the limit nor over, even if the package went over — and leaves out nothing else: the "Expired" mark, the
  consumed percentage as it is (117 % reads 117 %), the excess and the bar read as for any package (D91). On the expiry day
  itself the package has not expired and has its state like any other.
- AC-5.26 Given a project that is closed or cancelled, then the block says no state about its consumption and shows no date
  signal; its figures, its bar and its time elapsed read as for any other project (D93).

*Who sees it, and when it moves*

- AC-5.27 Given every holder of the project module's access, then they see the same signals, whatever their role and their right
  on the project; no signal shows an amount, a price, a rate or a figure per person (AC-1.8, D86).
- AC-5.28 Given a person who records hours from the project's page (AC-2.8), when the save succeeds, then the consumed
  percentage, the bar, the state and the excess follow the new hours without the page being reloaded; the time elapsed and the
  date signals do not change (A52).
- AC-5.29 Given a signal that reads today — the time elapsed, a date signal, the expiry of AC-5.25 — then it reads the same day
  as the package's current period: the Europe/Zurich day the page was loaded on, not the browser's own day, kept until the page is
  reloaded (A52, D85).

## Non-goals

- **Alerts** — the tasks Operai creates for a project manager when a threshold, an end date or a deadline is reached, when no
  hours are recorded or when effort is overrun: **specs/20261112-project-alerts** (D34). The signals of US-5 are drawn on the
  project page only: they create no task, send no notification and change nothing in project-alerts. A time-and-material project
  still gets no alert (D33), yet its block shows the signals (D88); and the block says a fixed price's deadline is near, which
  project-alerts has no task for.
- **Per-position comparison** on time-and-material projects (D13), and so no per-position percentage or signal.
- **Carrying unused hours** of a yearly package into the next period (D28).
- **Money**: no amount, price, rate or cost anywhere (specs/20261103-projects D14).
- **Locking or approving hours** — specs/20261112-time-tracking O4 still applies before hours are used to bill.
- **Detecting the same time recorded twice** — on a linked meeting and on its project — or merging the two (A48).
- **Moving an entry** from a linked meeting onto its project, or the reverse, on the person's behalf: the person still
  may, as for any entry (specs/20261112-time-tracking).
- **Configurable thresholds or scale**: 80 %, 100 %, 30 days and the 125 % end of the bar are fixed (D87, D89). They are those
  of project-alerts by decision, so that the block and the alert task agree; changing them is a decision for both specs.
- **Signals anywhere else**: none on the deal page, the projects list, the Terms card, My tasks, the page header or the shell;
  only the consumption block of the project page (D86).
- **A signal for a package's own end**: beyond the "Expired" mark of AC-1.9, no line says that a package expires soon or that a
  period ends soon, and none says that hours are unused; the owner named the fixed-price deadline and the terms' end date only
  (D89). The unused-hours alert is project-alerts' (AC-1.2).
- **Judging the pace, or forecasting**: no state compares the consumed percentage with the time elapsed (ahead of or behind the
  pace), and nothing says when a package will run out; the state comes from the consumed percentage alone (D87, D90).
- **One overall state** for the project: the consumption state and each date signal are said on their own.
- **Dismissing or silencing a signal**: a signal follows the figures and the dates; nobody acknowledges, snoozes or hides one.

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
- A52 The project page works out an hour package's current period on the Europe/Zurich day on which Projects reads the
  project, which the page does when it loads; the period, its figures, "not started" and "Expired" all follow from that day.
  A page left open across a date keeps what was true on the day it was loaded until the page is reloaded, a save made with
  Record hours (AC-2.8) included. Five cases have this cause: (a) a capacity package without an expiry date, the page open
  across Zurich midnight: the hours recorded on the new day are not in the block's figures (AC-1.3), so the hours used are
  too low and the hours left too high (or the excess too low), the one case where a figure is too low with no date on screen
  to show it, because the block shows the start date and no end date; (b) a yearly package's anniversary passes: the block
  keeps showing the old period and its figures, and hours recorded in the new period do not move it (AC-1.1, AC-1.2, AC-2.8);
  (c) a package's start date arrives: the block keeps saying the package has not started, with no figures (A51, AC-2.8);
  (d) a capacity package's expiry date passes: the "Expired" mark appears only after a reload (AC-1.9), the figures stay
  right; (e) the signals of US-5 that read today (AC-5.29): the time elapsed and each date signal stay on the day the page
  was loaded on, so a date that is today still says today after Zurich midnight, a date 31 days ahead does not yet show as near
  and a date that passes at midnight is not yet said to have passed, while the consumed percentage, its state and the excess are
  not affected, since they follow the hours (AC-5.28). In (b) to (d) the block shows a date that has already passed (the
  period's end, the start date, the expiry); in (e) it shows the date and the number of days counted from the loaded day. The
  project's total hours (AC-2.1) do not depend on that day and are not affected; nothing is lost or wrong after a reload.
  Accepted by the owner on 2026-11-27 as a known limitation, not fixed by this spec: first case (a), then, the same day, every
  case with this cause ("it is negligible, refreshing the page is enough", D85); and, when the signals of US-5 were added,
  recorded as applying to (e) and to anything else derived from the page's day (D86).
- A53 The state, the excess and the bar are decided on the exact hours (whole minutes) against the exact reference, and the
  percentage is the exact percentage rounded down for display (D92). Because it is rounded down and both thresholds are whole
  numbers, it never contradicts the state (AC-5.5 to AC-5.9). Confirmed by the owner on 2026-11-27 with D92: "the state still
  follows the exact hours".
- A54 A closed or cancelled project is a finished one: it shows no state and no date signal, as it gets no alert
  (specs/20261112-project-alerts AC-1.5, AC-1.8, A30); a planned, active or on-hold project shows them. Decided by the owner on
  2026-11-27 (D93).
- A55 A date is a whole calendar day of the Europe/Zurich calendar, counted in whole days from the page's day (A52); the date
  itself has not yet passed — it has passed from the next day, as a capacity package's expiry date has (AC-1.9) — and is 0 days
  away, said as today. Decided by the owner on 2026-11-27 (D94); D89 had not said.
- A56 The time elapsed is rounded down to a whole number, as the consumed percentage is (D92), not half up (AC-5.20): rounded
  half up, a span of 200 days or more would read 100 % on its last day, before it has ended (a yearly package, 365 days, would),
  which contradicts "100 % from the day after its last day". Not asked of the owner, whose answer was about the consumed
  percentage; strike it if the time elapsed should be rounded another way.

## Open questions

- None. The two questions raised when the spec was re-opened on 2026-11-27 — whether the consumed percentage may read at or above
  a threshold the state has not reached, and whether a closed or cancelled project shows the states and the date signals — were
  answered by the owner the same day (D92: rounded down; D93: no state and no date signal), and A55 was confirmed (D94).
