# 20261116 — A view may sum its own figures in the browser only over one complete, all-or-nothing read of a bounded span: the Week view of My hours folds its week from the export's full walk, narrowing the time-tracking "no figure computed in the browser" convention for that view alone

**Date:** 2026-11-16  
**Status:** Accepted (specs/20261116-record-hours-in-place plan approved 2026-11-16), amended 2026-11-19 (plan re-approved 2026-11-19)  
**Deciders:** wellD  
**Project:** Operai

---

## Context

specs/20261112-time-tracking sets a convention that holds on every screen: "No figure on screen is computed in the browser". Every total, day total and group comes from `GET /time-entries/totals`, and the client never sums a page. Its reason was real. A sum over the pages loaded so far is wrong until the last page arrives, and a deal's total must include meetings linked to it now, which only hours-api's own service credential can read.

specs/20261116-record-hours-in-place US-5 adds a Week view to My hours: one person's entries for Monday to Sunday, as a grid of rows (project, deal, meeting, other work) by days, each cell opening its entries. The grid needs a row per meeting and a row per target the person cannot name, which no totals grouping gives. A two-dimension totals grouping would be a second aggregation shape on the totals contract. The cell's entry list needs the entries anyway.

## Decision

We will build the Week view's figures in the browser. The view reads every entry of the week with `readAllEntries`, the walk the export already makes (`GET /time-entries`, `limit=500`, following `nextCursor` until it is `null`, all or nothing), and folds that one set with a pure `weekGrid(entries, monday)`. Every figure on the view (cell, row, day, week) is a sum over that set, so they agree by construction. A failed page is an error for the whole view, never a partial grid. The convention still holds for the list, its totals card and Everyone's hours. This decision narrows it for the Week view only.

The general rule, which later views inherit: **a view may sum its own figures in the browser only over one complete, all-or-nothing read of a bounded span. A sum over pages loaded so far is never a figure.**

## Failure shape

**A figure on screen that looks complete, built from a set that is not the whole set it claims to cover.** The total is presented as "the week" or "the day", but it came from whatever arrived before the read stopped. Nothing looks wrong: the numbers are plausible, the arithmetic inside the view is correct, and the gap only shows when a person compares the figure with a source of truth. The same shape appears when two figures on one screen come from two reads that saw different sets, so they do not add up.

Where else this shape can appear:

- **Read, partial versus complete.** A walk that stops at its first error and renders what it has, a paged list summed on the page, a "load more" that updates a total before the last page. Recognise it by a sum whose inputs come from a request that may have returned fewer items than the span holds, with no error on the screen.
- **Read, unbounded.** A complete walk over a span with no ceiling (a whole year, all people) becomes a slow or memory-heavy screen that gets cut short by its own size. A walk is admissible only over a span the product bounds (here, a week).
- **Two sources, one screen.** A figure summed in the browser beside a server figure for the same thing (a cell grid beside a `groupBy=day` total), or two sections summed from two reads at different moments. Recognise it by two numbers that should be equal and are not, or that are equal only until someone writes.
- **Write side, the mirror image.** After a save, edit or delete, patching one cell or total in place with the entry's delta, instead of reading the set again. The local figure is then a sum over a set the server no longer has. Recognise it by a total that is adjusted by hand after a write rather than re-derived from a fresh read.
- **Error handling, the mirror of a silent partial.** A failed read that shows last known figures, or an empty grid, in place of an error. The person then reads an absence as a zero.

## Options considered

### Option A — Browser fold over one complete walk of the week (chosen)

Described above. Every figure of the view is one sum over one walk; a failed walk is an error.

**Pros:**
- Figures agree by construction: Σ cells = row total, Σ rows = week total = Σ days, on one screen.
- No new server aggregation shape, no new route, and nothing to version or deploy before hours-ui.
- Needs no meeting-to-deal link in the browser, because a meeting's hours stay on the meeting's own row (spec D10, AC-5.7).
- The cell's entry list, which the spec requires, comes from the same set.
- Reuses the export's walk unchanged, so its all-or-nothing rule is already tested.

**Cons:**
- The browser holds every entry of the week and folds them. The size is bounded by one person's week, but nothing caps the entries a single day can hold.
- hours-ui now sums figures, which the convention forbids elsewhere. A future author can copy the pattern into a view where it is wrong.

### Option B — A server grid (rejected)

A two-dimension `groupBy` on `GET /time-entries/totals`, or a new `GET /time-entries/week`.

**Pros:**
- Keeps the convention literally: no figure is summed in the browser.

**Cons:**
- A second aggregation shape on the totals contract, with its own invariant (`Σ groups = totalMinutes`) to keep in two dimensions.
- A new route to version and deploy before hours-ui can use it.
- The cell's list still needs the entries, so the browser reads them anyway.
- Rows for meetings and for unreadable targets would need the same visibility rules the totals already apply, duplicated for a grid.

### Option C — Day and week totals from `groupBy=day`, cells summed in the browser (rejected)

**Pros:**
- Uses the existing totals route for the day and week figures.

**Cons:**
- Two sources for figures that must add up on one screen. A cell and its day total can disagree if an entry changes between the two reads.

### Option D — Sums over the list's paged reads (rejected)

**Pros:**
- No second read; the list already loads its pages.

**Cons:**
- This is the "so far" sum the time-tracking convention forbids. The week's total is wrong until the last page, and a failed page leaves a plausible but short figure.

## Consequences

**Positive:**
- The Week view's figures are internally consistent and need no server change.
- The rule above gives later views one question to answer before they sum in the browser: is the read complete, all-or-nothing, and bounded?

**Negative / trade-offs:**
- hours-api is unchanged, but the time-tracking convention "No figure on screen is computed in the browser" no longer holds without qualification. It holds for the list, the totals card and Everyone's hours. The Week view is the one exception, and this ADR is the record of it.
- A week that holds more than 500 entries is walked page by page (`limit=500`). Each page is one request, so a large week takes several round trips before the grid appears.
- The Week's figures and the list's server day totals are computed at different moments. If entries change between the two reads, the two can differ. They are never on screen together, and each view re-reads after its own writes (AC-5.20), so this is a timing gap, not a split on one screen.

**Risks:**
- **Copying the pattern into a view that should not use it.** Mitigation: the rule above is stated as a condition (complete, all-or-nothing, bounded), and each new browser sum names it in its own spec. The Everyone's hours view has no week grid and must not reuse this fold (spec WA4).
- **The walk outgrows the browser.** A week with very many entries makes the walk slow. Mitigation: revisit (see below) before adding a cap; a cap would make the read partial, which this decision forbids.

**Revisit this ADR if:**
- a view must sum over a span that is not bounded (a year, all time, all people), or over entries it is not allowed to read in full;
- the walk's size or latency becomes a real problem for one person's week;
- a second screen needs the same grid for other people's entries (Everyone's hours), which the rule above does not cover without a further read decision.

## Compliance notes

- GDPR / data-protection impact: none beyond the existing list. The browser already receives these entries for the list and the export; the Week view holds one person's own entries in memory for the length of the screen.
- Data residency: unaffected. No new data flow or service; hours-api stays the only source.
- Audit trail: not required. Reads are not recorded beyond ordinary request logs, as for the list.

## Amendment 2026-11-19 — the table view: week or month

**Scope widened.** The Week view of My hours is now the table view of My hours, which takes a period: one calendar week
(Monday to Sunday) or one calendar month (its first day to its last, 28 to 31 days). Wherever the decision above says
"the Week view", it now means the table view in either period. The rule is unchanged: a figure is a sum only over one
complete, all-or-nothing read of a bounded span. The bounded span is now "one calendar week or one calendar month (at
most 31 days) of one person's own entries".

**Decision.** The month's figures are summed in the browser from ONE complete read of that calendar month, through the
same `readAllEntries` walk the week uses (`GET /time-entries`, `limit=500`, following `nextCursor` until it is `null`,
all or nothing), and folded by the same pure grid over the period's days. Every figure of the month (cell, row total,
day total, month total) is a sum over that one set, so they agree by construction. A failed page is an error for the
whole table, never a partial grid. Changing the period, a filter or the view aborts the walk in flight (its signal
reaches every page's request) and its late answer is dropped, so no page of one period ever reaches the grid of
another. The period's days and boundaries come from one pure module (`lib/tablePeriod.ts`), so the table does not
decide them itself.

**Rejected alternatives** (as the plan records them, ADR candidate R3):

- **A server month grid** — a two-dimension `groupBy` on `GET /time-entries/totals`, or a month route. This is Option B
  above again, with 31 columns on the totals contract, and the cell's entry list is still needed, so the browser reads
  the entries anyway.
- **A month assembled from its weeks' reads.** Several reads taken at different moments are summed on one screen (the
  "two sources" failure shape above), and one failed week would leave a partial month.
- **The month's day and row totals from `groupBy=day` and `groupBy=project`, with the cells summed in the browser.**
  Two sources for figures that must add up on one screen (Option C above).
- **A cap on the month's entries.** A cap makes the read partial, which this decision forbids (Option D above).

**Consequences.**

- *Positive:* one fold, one rule and one view serve both periods. The month needs no server change: hours-api accepts a
  span of up to 366 days, and a month is at most 31.
- *Negative / trade-offs:* the read size is up to a month of one person's entries, over possibly several pages of 500.
  The month's first grid waits for the whole walk. The convention "No figure on screen is computed in the browser" now
  holds for the list, the totals card and Everyone's hours only; it is narrowed for the table view in both periods.
  Everyone's hours must still not reuse this fold.
- *Risks:* the month's walk is slower than the week's. Mitigation: the e2e journey logs the month's first-grid time
  (not a failing threshold), and a cap is not the answer, because it would make the read partial.
- *Revisit this amendment if:* a longer period (a quarter, a year) is asked of the table view, or the month's walk is
  measurably slow for one person's month.

**Compliance notes (amended).** The browser holds up to one calendar month of the person's own entries in memory for the
length of the screen, where the week held one week. The same data flows, to the same service, and no new data is
received. GDPR / data-protection impact: none beyond the existing list (the same person's own entries, already received for the list and the export). Data residency and audit trail are unchanged.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
