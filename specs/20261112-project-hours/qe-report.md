# QE report — project-hours (specs/20261112-project-hours), rigor production, full mode

## QE pass 3 (after fix round 2)

A fresh agent re-checking the one open defect of pass 2 (D3) against the designer's amendment `043ab194` (design.md only), scoped as briefed to that defect and to its class.
The local stack was stopped and the databases were being reset, so no server, browser, backend test or e2e was run; none is needed to judge a docs-only fix whose subject is a frontend
code path that vitest drives. Nothing is BLOCKED.

## QE verdict: PASS   (pass 3; measured at 2166b8e7, clean tree; this report is committed after it, docs only)

**D3 is resolved.** Every clause the fix added to design.md is true of the code (table below), no other place in the spec directory still says the table view cannot restart, and
nothing the D1 fix said became false. I also added the one test the brief allowed, which pins the claim that was previously only read from the code (three tests, test file only).
No defect is open, so the feature's verdict is **PASS** with no product code change.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| Product code unchanged since pass 1 | empty diff | `git diff --stat 117bdadf HEAD -- ':!specs' ':!hours-ui/src/pages/MyHoursPage.table.test.tsx'` prints nothing; the same against `95c3d470` (where pass 1 measured product code) prints nothing. Without the second exclusion the diff is exactly one file, the test I added in this pass (`2166b8e7`). Files changed since pass 2's `9cbf00ad`: that test file, `design.md` (`043ab194`), `qe-report.md` | ✓ |
| D3: every clause of the fix is true of the code | all | 8 of 8 hold (table below); the three that were only read from the code are now pinned by an executed test | ✓ |
| D3 class: nowhere else says the table view cannot restart | none | `grep -n -i "cannot restart\|has no pages" design.md`: only line 23, the amendment note quoting the removed sentence. Every restart mention in `spec.md`, `plan.md`, `tasks.md`, `decisions.md` re-read: `decisions.md:71` (the list's silent restart, true), `plan.md:127` (HostHours burst re-reads, unrelated), `decisions.md:126` (the Export button is the List's, true). Every table-view mention in design.md re-read (lines 77, 87, 310, 363, 398, 419, 561; spec AC-4.11): none denies the restart, none promises a status | ✓ |
| Nothing the D1 fix said became false | pass 2's clauses 1 to 7 | each rests on product code that is byte-identical (first row) and on tests that still pass (next rows); the new paragraph's sentences 1 to 7 are untouched by `043ab194` (`git show 043ab194 -- design.md`: +4 −2, the amendment note, the last sentence of the S4 paragraph with its tag, one clause on the Accessibility bullet) | ✓ |
| hours-ui vitest, the files the brief named (table, entries, export, project filter) + `useHoursQuery.test.tsx` + `EveryoneHoursPage.projectFilter.test.tsx`, at 2166b8e7 | green | **7 files, 215 passed, 0 failed** (212 at 043ab194 before my addition, + 3) | ✓ |
| hours-ui full suite, at 2166b8e7 | green | **104 files, 3116 passed, 0 failed** (pass 1: 3113, + 3) | ✓ |
| hours-ui `pnpm lint`, at 2166b8e7 | exit 0 | exit 0 | ✓ |
| hours-ui typecheck `tsc -b` (covers `src` including tests; a planted type error was reported and then removed), at 2166b8e7 | exit 0 | exit 0 | ✓ |
| `mise run changeset:check` | OK | OK (`project-hours-card-and-consumption.md` among the matches) | ✓ |
| Secret scan (pre-commit betterleaks) | pass | passed on the test commit | ✓ |
| The new tests fail when the behaviour is broken | each mutation fails them | three temporary mutations of product code, each restored with `git checkout` (tree clean afterwards, only the test file differed): (M1) `exportPages.ts:49` without `'project_meetings_changed'` → all 3 tests fail (`[undefined,'c1']` where `[undefined,'c1',undefined]` is expected); (M2) `EXPORT_ATTEMPTS = 2` → the three-in-a-row test fails (4 requests, not 6); (M3) `refusedMeetingsRead` also accepting `project_meetings_changed` → the three-in-a-row test fails (the host-filter state would show) | ✓ |
| Every other row of pass 1 and pass 2 | stands | not re-run, inputs identical (first row); see "What stands" | ✓ (carried) |

### D3's clauses, one by one (design.md S4 paragraph line 315, Accessibility bullet line 448, amendment note line 23)

| # | Clause | Evidence | Holds |
|---|---|---|---|
| 1 | "My hours' table view has no Load more" | `LoadMore` is rendered only in the List's branch (`MyHoursPage.tsx:705`); the table branch renders `TableView` (`:627`), which has none | ✓ |
| 2 | "its one complete read of the period goes through the export's walk (`readAllEntries`)"; note: "called by `readTable`" | `readTable` (`MyHoursPage.tsx:87-90`) calls `readAllEntries(filters, { signal })`; `readAllEntries` has exactly two callers, `HoursExport.tsx:46` and `readTable`; its filters are `tableFilters` (`:214`), which carries `applied.projectId` / `applied.dealId` | ✓ |
| 3 | "so it restarts the same way" (both 409 codes, at most three walks) | `exportPages.ts:41-52`: attempt below `EXPORT_ATTEMPTS` (`:32`) and `isCode(error, 'deal_meetings_changed', 'project_meetings_changed')` loops; pinned by the new tests below and by `exportPages.test.ts:149`, `:164` | ✓ |
| 4 | "a 409 answers only a later page, so a period that holds more than one page of 500 entries can meet it" | hours-api `list.routes.ts:188-193`: both 409s need `position !== null`, i.e. a cursor; the walk asks `limit=500` (`exportPages.ts:30`, the API's maximum, `list.routes.ts:27`) and a next cursor exists only when `rows.length > limit` (`:204`); so a period of at most 500 entries is one request and cannot meet it | ✓ |
| 5 | "the walk then starts over, silently (the card stays in its one loading state)" | one promise: `useHoursQuery` is `loading` until `readTable` settles (`useHoursQuery.ts:53-74`); `TableView` draws the skeleton for `loading` (`TableView.tsx:376`). **Now pinned**: `MyHoursPage.table.test.tsx:1058` (week and month): between the 409 and the restart's first page the skeleton is up, no grid, no `hours-table-error`, no refusal, `queryByRole('alert')` is null, and the grid that arrives holds the second walk's 2 h 30 alone (none of the first walk's 4 h) | ✓ |
| 6 | "at most three walks in all" | `exportPages.ts:32`; **now pinned**: `MyHoursPage.table.test.tsx:1118` sees cursors `[undefined,'c1',undefined,'c1',undefined,'c1']` (3 walks, each refused on its 2nd page), then waits and sees no seventh request | ✓ |
| 7 | "Refused three times in a row, the card shows its own read-failure state with Retry, as for any failed read of the period, not the host-filter refusal (503 `host_unavailable` only)" | `refusedMeetingsRead` is `isCode(state.error, 'host_unavailable')` only (`MyHoursPage.tsx:112-113`); the error branch of `tableState` (`:559`) is `tableFailure(error)` = `strings.entries.error.body` for any answered status, drawn by `TableView`'s `ErrorBanner` with title, body and Retry (`TableView.tsx:391-398`). **Now pinned** in the same test: title "Your hours could not be loaded", body "Try again in a moment.", one alert, toolbar kept, no `hours-project-filter-unavailable`, and Retry (now healthy) reads the period again and shows the grid | ✓ |
| 8 | Accessibility: "the table card's own polite loading line ("Loading your week…" / "Loading your month…"), already spoken when the read began, is all there is: its text does not change during the restart" | the line is `VisuallyHidden live` = `aria-live="polite"` (`TableView.tsx:372`, `operai-ui` `VisuallyHidden`), its text is `announcement()` = `words.loading` while loading (`:257-258`), `strings/table.ts:41` and `:56` (English; Italian `:136`, `:151`). **Now pinned**: a `MutationObserver` on that node records nothing from the moment the first walk is waiting through the 409 and the restart's request (the same node, the same text), and records the change once the period arrives (a positive control, so the silence is not an observer that cannot see) | ✓ |
| – | Amendment note: "F4 speaks only of 'the list' and is true as written"; "Changed in place: S4 (last sentence), Accessibility (one clause)" | F4 (lines 77-79) says the list starts over silently and that the table view's grid is replaced by the refusal, both true; the diff of `043ab194` matches the note (it also retitles the paragraph "QE D1 and D3", which the note does not list; harmless) | ✓ |

## Defects (pass 3)

None open. **D3. RESOLVED (verified in this pass).** Root cause, now closed: the D1 fix described the table view from its name (a view with "no pages", so "nothing to restart") instead of from the call it makes
(`readTable` → `readAllEntries`, the export's walk, which is the code that restarts). The designer replaced the denial with the true statement and added the Accessibility consequence; I checked each clause against the code
above and pinned the three that had been read only. Class check: no other place in the spec directory repeats the denial (third row of the table).

## Observations (pass 3; not defects)

- **O6 is narrower, not gone.** The table view's restart is now run as one chain (restart, loading line untouched, three refusals, Retry). The List's and Everyone's hours' restart still rests on a composition of pinned pieces, as pass 2 said.
- **O7 stands** (a restart re-reads the entries only, not the totals), unchanged.
- **O8. The new tests drive the page against a faked API.** The fake answers the 409 to the first request that carries a cursor, so no 500-entry fixture is needed; the server half (a 409 needs a cursor and a changed linked set) is pinned by hours-api's own `src/entries/projectFilter.test.ts:150`, which I read but did not run (no backend tests, by instruction).

## What stands from passes 1 and 2

Every other row stands, because no product code changed since pass 1: `git diff --stat 117bdadf HEAD -- ':!specs' ':!hours-ui/src/pages/MyHoursPage.table.test.tsx'` is empty (and so is the same against `95c3d470`). That covers
the AC sweep (30/30), the gates (hours-api, meetings-api, projects-api, crm-api, projects-ui, crm-ui, shell, coverage, `shared:check`, audits), the e2e results, the rendered checks, the performance numbers, the security note, the
"Pre-existing red outside scope" list (including the shell audit, `hours-in-place` A and the crm-api `offerDrafts.preview.test.ts:739` red) and the residue note. None was re-executed here; their inputs are identical.
Of the hours-ui row of pass 1 (`pnpm lint && build && test`), this pass re-executed lint, the typecheck half of the build (`tsc -b`) and the full suite, with the three new tests added to the count; `vite build` was not re-run, its inputs being identical.

## Tests added (pass 3, committed in `2166b8e7`, test file only)

`hours-ui/src/pages/MyHoursPage.table.test.tsx`, a new `describe` at line 1044 ("the linked meetings changed between two pages of the period's read"): two tests (the first parameterised over the week and the month, so three runs), 117 lines. No other file touched.

## Blocked (pass 3)

None.

## Security

No recommendation: the change is a docs amendment and one test file; nothing touches auth, input handling, upload or a dependency (no manifest or lockfile in either commit).

## Self-critique (pass 3)

One pass over this section. The PASS rests on reading the code and on tests run at a clean `2166b8e7` (215 in the named files, 3116 in the suite), nothing observed in a browser (by instruction), so "silent" is shown by a jsdom run of the real page with a faked API, not by a live restart; a real period over 500 entries with a relink between pages was not made.
I added a test and counted it as evidence for three clauses; the observer-based check of the live line is the most elaborate assertion in it, and I made it prove it can see by a positive control, but it asserts a DOM fact, not what a screen reader says (a polite region with unchanged text is silent by the ARIA rules, not by anything I heard).
The M1 to M3 mutations were applied to product files and restored by `git checkout`; I confirmed a clean tree after each, but a reader who wants certainty can re-run `git status` and `git diff` on those two files. The report is committed after the gates, docs only, as passes 1 and 2 were: the measured tree is `2166b8e7`.

---

## QE pass 2 (after fix round 1)

A fresh agent re-checking the one open defect of pass 1 (D1) against the designer's amendment `9cbf00ad` (design.md only). Scope as briefed: code, tests and docs.
The local stack was stopped and the databases were being reset, so no server, browser, backend test or e2e was run; none is needed to judge this, because no product
code changed. Nothing is BLOCKED.

## QE verdict: FAIL   (pass 2; measured at 9cbf00ad, clean tree; this report is committed after it, docs only)

**D1 is resolved**: design.md no longer promises a status, and seven of the eight clauses the amendment writes about the restart are true of the code and pinned by tests.
The verdict is still FAIL because the eighth, the last sentence of the paragraph the fix added, is false of the code (**D3**, low, docs only): it says My hours' table view
"cannot restart", and it can, silently, through the same walk as the export. Correcting that one clause makes this a PASS with no code change.

| Check | Threshold | Actual | Result |
|---|---|---|---|
| Product code unchanged since pass 1 | empty diff | `git diff --stat 117bdadf HEAD -- ':!specs'` prints nothing; the same against `95c3d470` (where pass 1 measured product code) prints nothing, and `git diff --name-only 95c3d470 HEAD` lists only files under `specs/`. The one commit since `117bdadf` is `9cbf00ad`: `specs/20261112-project-hours/design.md`, +7 −3, nothing else | ✓ |
| D1: no place in design.md still promises a status for the 409 restart | none | `grep -n -i refresh design.md`: "refreshed" survives only in the amendment note (line 21, quoting the removed sentence) and in the new paragraph (line 313, negating it); the other hits are line 417 and G5 (lines 588-592), both about there being no Refresh action for the card's figures after Record hours, not about this list. F4 (line 77) says "silently (S4)", the Accessibility bullet (line 446) says silent by design with the Entries region's loading line as the only announcement, the Copy section holds no string for it. Every other polite status in the file (loading lines, the grouping banner, HostHours notes) is unrelated to the 409 | ✓ |
| Amended text consistent with spec.md | no clause the spec contradicts | AC-4.8 asks for the refusal and the kept pages, AC-4.4 for the entries on the project's linked meetings; neither asks for a status on a restart. The amendment's two citations check out: `specs/20261112-time-tracking/plan.md:901-902` ("the list reloads its first page, the export restarts…") and that spec's design.md has no mention of the 409 | ✓ |
| Amended text consistent with the code | every clause | 7 of 8 hold (table below); the table-view clause does not (D3) | ✗ |
| Tests pin the described behaviour | green | hours-ui `vitest run` at 9cbf00ad: `useHoursQuery.test.tsx`, `exportPages.test.ts`, `HoursExport.test.tsx`, `MyHoursPage.projectFilter.test.tsx`, `EveryoneHoursPage.projectFilter.test.tsx`: **5 files, 90 passed, 0 failed**; `MyHoursPage.entries.test.tsx`, `MyHoursPage.table.test.tsx`: **2 files, 122 passed, 0 failed** | ✓ |
| Every other row of pass 1 | stands | not re-run, inputs identical (first row); see "What stands" | ✓ (carried) |

### The amended paragraph, clause by clause (design.md S4 "The linked set changed between two pages", line 313, with F4 line 77 and the Accessibility bullet line 446)

| # | Clause | Evidence | Holds |
|---|---|---|---|
| 1 | A 409 `project_meetings_changed` answers a Load more; the list starts over from its first page, silently | `hours-ui/src/lib/useHoursQuery.ts:149-153` (both codes → `reload()`, no state, no message); `useHoursQuery.test.tsx:418` (both codes: calls `[undefined, 'c2', undefined]`, `moreFailed` false, `more` empty; any other 409 stays an ordinary failed Load more); `MyHoursPage.projectFilter.test.tsx:346` (page: first page asked again with no cursor and `projectId=p1`, the new list on screen, no Load more, `queryByRole('alert')` null) | ✓ |
| 2 | The Entries region shows its ordinary loading state, the skeleton and the polite "Loading your hours…" | `reload` is `loading` in the same render (`useHoursQuery.test.tsx:148`); the loading branch is `MyHoursPage.tsx:731-732` and `EveryoneHoursPage.tsx:447-448` (`VisuallyHidden live` + `SkeletonRows`); pinned for a first load by `MyHoursPage.entries.test.tsx:364`. A composition of three pinned pieces: no single test asserts the line during a restart (O6) | ✓ |
| 3 | It then answers as any first page does: the new list, the region's error banner with Retry, or the refusal when Meetings cannot say | the same first-page branches (`MyHoursPage.tsx:668-731`, `refusedMeetingsRead`); refusal and error tests of pass 1 are in the 90 above | ✓ |
| 4 | No Banner, no alert, no "refreshed" status for the restart itself | no such string on this path: the only "refreshed" in hours-ui is `strings/entry.ts:151`, "That entry no longer exists. The list has been refreshed." (an entry deleted elsewhere, another event); the page test above asserts no alert | ✓ |
| 5 | The export's walk restarts the same way, at most three walks in all, shows nothing for a restart | `exportPages.ts:32` (`EXPORT_ATTEMPTS = 3`) and `:41-51` (`readAllEntries`); `exportPages.test.ts:149` (restart under a project filter, none of the first walk kept) and `:164` (gives up after 3 walks: `2 * EXPORT_ATTEMPTS` requests, rejects with `project_meetings_changed`); `HoursExport.test.tsx:349` (one file downloaded, no alert, `onFilterUnavailable` not called) | ✓ |
| 6 | Refused three times in a row it fails like any other export failure, with the button's own alert | `readAllEntries` rethrows the 409; `HoursExport.tsx:46-50` takes only `host_unavailable` for the host-filter state, everything else is the button's `failed` alert (`HoursExport.test.tsx:338` pins that for another code). The third-refusal path itself is not pinned at component level (O6) | ✓ |
| 7 | One code path for both host filters, in My hours' List and in Everyone's hours | `useHoursPages` is used by both pages (`MyHoursPage.tsx:220`, `EveryoneHoursPage.tsx:193`) and both codes go through the one `isCode(...)`; Everyone's has no page-level 409 test, the hook test covers it (O6) | ✓ |
| 8 | "My hours' table view reads one complete period, has no pages and **cannot restart**" | **false**: see D3 | ✗ |

## Defects (pass 2)

**D1. RESOLVED (verified in this pass).** Root cause, now closed: design S4 was drafted from the deal's pattern with a sentence the deal never had (a polite "refreshed" status);
T12 implemented the deal's silent restart and recorded the difference as a reinterpretation in `decisions.md`, and design.md was never reconciled. The designer chose the silent
restart for both host filters and amended design.md only (F4, S4, Accessibility). The text now matches the code, spec.md and the tests, apart from D3 below.

**D3 (new; low; owner: designer; docs only). The amended S4 paragraph says My hours' table view "cannot restart"; it restarts.**
design.md line 313, last sentence: "My hours' table view reads one complete period, has no pages and cannot restart."
`MyHoursPage.tsx:87-90` `readTable` calls `readAllEntries(tableFilters)`, and `tableFilters` is `{ ...applied, from, to }` with `applied.projectId` / `applied.dealId`
(`:202-206`, `:214`): the export's own walk, which already restarts on both codes. So a 409 on a later page of the period (a period with more than one 500-entry page under a host
filter) starts the walk over, silently, at most three walks in all; refused a third time it ends in the table's own read-failure state with Retry (`tableFailure`,
`MyHoursPage.tsx:79`, `:556-559`), not in the host-filter refusal (`refusedMeetingsRead` is `host_unavailable` only). What the sentence gets right: the table has no Load more
and no list to restart from a first page, and its restart shows nothing (one promise, state `loading` throughout). What it gets wrong is the denial: the paragraph's own previous
sentence says this walk restarts, and the table view is the other caller of that walk.
Why low: the behaviour is the one the designer decided (silent), nobody would build a status for it, no AC is affected. It still tells the next reader a path does not exist that does.
Placements, same pattern: S4 line 313 ✗; F4 line 77 ✓ (speaks only of "the list"); Accessibility line 446 ✓; amendment note line 21 ✓ (does not mention the table view); line 361
"Table view (AC-4.11). Unchanged" ✓ (about `tableGrid`).
**New since the fix** as a sentence (added in `9cbf00ad`); the code fact it contradicts was there in pass 1, and my pass-1 placement list ("My hours' table view not paged, n/a")
overlooked it, so QE **missed it earlier** as well.
Smallest correction, for the designer: replace "and cannot restart" with the true statement, for example "My hours' table view has no Load more; its one complete read goes through the
export's walk, so it restarts the same way, silently, at most three walks in all, and refused three times it shows its own read-failure state with Retry." No code change. No test
pins the table's restart (no `MyHoursPage` table test sends a 409; `exportPages.test.ts:149-176` pin the walk); this pass was limited to this file, so none was added: a table-view
test with a 409 on page 2 would keep the sentence true if the designer wants one.

## Observations (pass 2; not defects, no AC or design clause says otherwise)

- **O6. Composition gaps in the tests, not in the behaviour.** No single test asserts the polite loading line *during* a 409 restart (clause 2 rests on `reload` = `loading` plus the loading branch plus the first-load test), none asserts the
  export button's alert after the third refusal (clause 6 rests on the rethrow plus the alert test for another code), and Everyone's hours has no page-level 409 test (clause 7 rests on the shared hook). Each link is pinned; the chain is not run as one.
- **O7. A restart re-reads the list only.** `entries.reload` reloads the entries query; the day totals and the Totals card are keyed on the filters and are not re-read, so after a relink between two pages the Totals card can describe the previous linked set
  until a filter changes or the page reloads (the deal filter behaves the same). The designer's "nothing is wrong, nothing for the person to do" holds for the list; it is also why a "refreshed" status would have claimed more than the code does.
  No AC or design clause asks for the Totals to follow; recorded so the decision is made knowing it.

## What stands from pass 1

Every other row of pass 1 stands, because no product code changed since: `git diff --stat 117bdadf HEAD -- ':!specs'` is empty (and so is the same diff against `95c3d470`, the commit pass 1 measured product code at;
shell was measured at `75947f28`, an ancestor of both). That covers the AC sweep (30/30), the gates (typecheck, lint, build, coverage, `shared:check`, `changeset:check`, audits, secret scan), the e2e results,
the rendered checks, the performance numbers, the security note, the "Pre-existing red outside scope" list (including the shell audit and `hours-in-place` A) and the residue note. None of them was re-executed in this pass; their inputs are byte-identical.
Only `design.md` changed, and its Design-states and Accessibility rows are re-read above: the added Accessibility bullet (line 446) matches the code (the loading line is the only announcement), and no state or a11y requirement was removed.

## Blocked (pass 2)

None.

## Self-critique (pass 2)

One pass over this section: the D1 verdict rests on reading the code and on 212 passing tests (90 + 122) at a clean `9cbf00ad`, nothing run live (by instruction), so "the table's restart is silent in the browser" is code reading (one promise, `loading` throughout), not an observed run.
D3 is small enough that it is fair to ask whether it should block: I counted it because the brief asked for the text to be consistent with the code and pass 1 counted D1, the same class (a design clause that disagrees with the code), as FAIL; the caller may overrule on proportion, and the fix is a clause.
I did not re-verify pass 1's rows, on the strength of an empty diff; if anything outside `git diff` (a dependency, an environment change) moved since, that is not covered by this pass.

---

## QE pass 1 (original report, unchanged below)

Pass 1 of the feature, a fresh agent, everything listed before anything is fixed.

## QE verdict: FAIL   (product code measured at 95c3d470; the report is committed after it, docs only)

One open defect (D1, design gap, low). The hours-owners e2e regression (D2) was found and fixed by QE (test code only) in this pass. Four reds
that are **not** this feature's are listed apart under "Pre-existing red outside scope" and are not counted in the verdict.

**Executable here:** everything. The stack was running from this branch, the Playwright MCP browser worked, every gate command ran. Nothing is
BLOCKED. Limits of what ran live: a real Meetings / Projects / auth outage cannot be made without stopping a service, so the unavailability
states were driven by intercepting the browser's requests (as the brief allowed) and their backend halves by the integration suites; a project
that awaits its manager (AC-2.7) was not built live (it needs a won deal taken with an ops-manager), only its integration tests ran.

**Measured at:** product code at `95c3d470` (identical to `ee2090c7` apart from my test files and `plan.md`, `git diff --stat ee2090c7 HEAD`: 5 files, none
product). projects-api was re-run on `95c3d470`; shell on `75947f28` (the next commit touches only a projects-api test); hours-api, meetings-api, crm-api,
hours-ui, projects-ui, crm-ui were last run on `ee2090c7`, and no file of theirs has changed since.

## Gates

| Check | Threshold | Actual | Result |
|---|---|---|---|
| AC coverage (executed checks behind each AC) | 30/30 | 30/30 (table below; AC-2.7, 4.10, 4.11 at integration/unit level only, not live) | ✓ |
| hours-api `typecheck` + `bun test` (scratch `hours_ph_test`) | green | 2457 pass / 0 fail, 58 files | ✓ |
| meetings-api `typecheck` + tests (`meetings_ph_test`) | green | 2169 pass / 0 fail | ✓ |
| projects-api `typecheck` + tests (`projects_ph_test`), at 95c3d470 | green | 1260 pass / 0 fail | ✓ |
| crm-api `typecheck` + tests (`crm_ph_test`) | green | 2399 pass / 4 skip / 1 fail = the known `offerDrafts.preview.test.ts:739` | pre-existing (listed apart) |
| hours-ui `pnpm lint && build && test` | green | lint ✓, `tsc -b && vite build` ✓, 3113 pass | ✓ |
| projects-ui lint/build/test | green | lint ✓, build ✓, 1169 pass + 2 expected-fail (`MyTasksPage.projectsDown.qe.test.tsx`, pre-existing) | ✓ |
| crm-ui lint/build/test (`--no-webstorage`) | green | lint ✓, build ✓, 1880 pass | ✓ |
| shell lint/build/test (`--no-webstorage`), at 75947f28 | green | lint ✓ (covers `e2e/`), build ✓, 766 pass; `tsc -p tsconfig.e2e.json` clean (run apart: `tsc -b` does not reference it) | ✓ |
| `mise run shared:check` | in sync | 36 groups in sync, incl. `timeEntryRecordedEvent` | ✓ |
| `mise run changeset:check` | OK | OK (`project-hours-card-and-consumption.md`, 8 apps minor) | ✓ |
| Line coverage of the changed code | >= 80% | hours-api 99.30% overall; changed files: `summary.ts` 98.89, `terms.ts` 96.67 (projects-api), `hosts.routes.ts` 98.94, crm `resolve.routes.ts` 99.44, every other changed hours-api/projects-api file 100. Frontends (vitest v8, `--coverage.include` of the changed files): hours-ui 100% lines / 98.5% branches, projects-ui 100% / 99.2%, crm-ui `HoursSection` 100%, shell `extensions.tsx` 97.4% | ✓ |
| Dependency audit `pnpm audit --prod --audit-level high` | exit 0 | hours-ui 0, projects-ui 0, crm-ui 0; **shell exit 1** (5 high via `better-auth>vitest>vite>postcss>nanoid`); no critical anywhere, `bun audit` clean on the four backends. The feature touches no manifest or lockfile (`git show` over its commits; `shell/package.json` differs from main only by `version`) | shell pre-existing (listed apart) |
| Secret scan (pre-commit betterleaks) | pass | passed on both QE commits | ✓ |
| e2e `project-hours.spec.ts` | 5/5 | 5/5 | ✓ |
| e2e `project-hours-visibility.spec.ts` (new, QE) | 3/3 | 3/3 | ✓ |
| e2e neighbours (`hours`, `hours-owners`, `hours-in-place`(+`round1`), `meeting-hours`, `-measured`, `-moved`) | green | first run 35 pass / 2 fail / 8 not run; after repair and re-runs: `hours-owners` 7/7, `hours-in-place` B–F 5/5, `round1` 4/4, T24 G.1–G.8 pass, `hours`, `meeting-hours*` pass; the one remaining red is `hours-in-place` A (pre-existing, below) | ✓ except A |
| Design states (design.md) | every state present | all present; one clause missing (D1) | ✗ |
| Accessibility (design.md) | keyboard + ARIA + contrast per design | holds (below) | ✓ |
| Exploratory UI pass | every designed flow walked | walked, 320/360/1280, light and dark, English and Italian | ✓ |
| Performance (plan R3, p95 under 800 ms) | under 800 ms | summary p95 14 / 48 / 92 ms (project, windowed, deal), filtered list 8 ms, 40 samples each | ✓ |

## AC sweep

Each row: the executed checks. "Live" = driven in the browser or against the real owners in this pass.

| AC | Evidence | Result |
|---|---|---|
| 1.1 | `packagePeriod.test.ts` + QE `packagePeriod.oracle.test.ts` (independent date oracle over a leap cycle; 3 seeded mutations fail it); `terms.test.ts` (GET/POST/PATCH carry `currentPeriod`); `figures.test.ts` window; `consumption.test.ts`, `ConsumptionBlock.test.tsx`; e2e `project-hours` A; live all variants | ✓ |
| 1.2 | oracle (period k, 29 Feb, no gap or overlap), `figures.test.ts`, e2e A (period 2 excludes period 1: used 4 h 30, total 6 h 30) | ✓ |
| 1.3 | capacity vectors and oracle; live "From 01.08.2026, no expiry" 5 h 30 / 34 h 30 | ✓ |
| 1.4 | `consumption.test.ts`; live: 7.5 / 10.0 / 12.0 man-days; no estimate gives no row; e2e visibility A | ✓ |
| 1.5 | `consumption.test.ts`; live 7.5 against 24.0, no position named; e2e visibility A | ✓ |
| 1.6 | vectors 480 / 30 / 24 / 23 / 3600; live one decimal ("7.5", Italian "7,5") | ✓ |
| 1.7 | `HoursSection.test.tsx`; live SLA-only and internal: no block, no divider, total only; e2e visibility A | ✓ |
| 1.8 | `answer.test.ts` key-set, no-money scan of the card's files; e2e regex over the card; live every variant | ✓ |
| 1.9 | `packagePeriod` `ended`; badge test; live "Expired" beside the dates, Italian "Scaduto"; e2e visibility A (A52(d) accepted) | ✓ |
| 2.1 | `figures.test.ts`, `record.test.ts`, `HostHours.test.tsx`; e2e B; live "Without a work type" group | ✓ |
| 2.2 | `figures.test.ts`; live deal total 2 h 30 = 1 h 30 on the deal + 1 h on its meeting; e2e visibility B | ✓ |
| 2.3 | `people.test.ts`; e2e B; live PM sees By person (3 people, the meeting's reader among them, A49) | ✓ |
| 2.4 | `people.test.ts`; live deal owner; e2e visibility B | ✓ |
| 2.5 | `people.test.ts`; live API matrix: PM, admin (read-all) get `byPerson`; reader gets `null`, outsider 404; UI shows no table, heading or placeholder | ✓ |
| 2.6 | component suites (projects-ui, crm-ui, hours-ui); live by interception: block fails / widget fails / both fail (two banners, two Retries) / host import aborted (slot fallback inside the card) / deal 503 / loading, all with the page and the card's title standing | ✓ |
| 2.7 | projects-api resolve test (`projectManagerId: null`), hours-api `people.test.ts` (ops-manager and team member get `null`, holder gets it). Not live | ✓ (integration) |
| 2.8 | event guard, `RecordHours`/`HostHours`/`ConsumptionBlock` tests; e2e C (project) and visibility B (deal: 2 h 30 to 3 h, no reload, breakdown stayed open); live on the deal page. A52 cases (a)-(c) accepted, not tested as defects | ✓ |
| 3.1 | `matrix.test.ts`: one new `GET`, write routes pinned | ✓ |
| 3.2 | `catalogGaps` and hardcoded-copy scans green in the three apps; live Italian pass of the card, the list and the export | ✓ |
| 4.1 | `figures.test.ts`, `projectFilter.test.ts`; live: the 1 h of a person on no team and with no `projects:access` counts for the project | ✓ |
| 4.2 | live, real owners: project 120 to 0 (relink to deal; deal +180) to 0 (unlink) to 120 (relink back); e2e visibility C; hours-api tests | ✓ |
| 4.3 | `figures.test.ts`, e2e | ✓ |
| 4.4 | `projectFilter.test.ts`; e2e D; live list line "Counts for project <name>" in My hours and Everyone's hours | ✓ |
| 4.5 | `totals` tests; live: keyed / `hidden` ("Projects not visible to you") / `none`; `project-unknown` row and polite grouping banner by response rewrite | ✓ |
| 4.6 | `hoursWorkbook.test.ts`; downloaded files read with exceljs: 10 columns, Counts for project 7th; file summed by it equals the by-project totals (e2e visibility C) | ✓ |
| 4.7 | live outsider (`employee` only): `on.project` = `{state:"linked",visibility:"hidden"}`, no id/label/href anywhere in the list, totals `hidden`, summary 404 identical to a missing project, screen line "not visible to you", export cell "Not visible to you" (e2e visibility C) | ✓ |
| 4.8 | `projectFilter.test.ts` (refusal, kept pages D48, 409 restart), `HoursExport` tests (T21); live refusal at 360/320, Retry and Clear by keyboard, focus lands in the Project field | ✓ (D1 aside) |
| 4.9 | `record.test.ts` (503), component tests; live 503 on both parts: no figure | ✓ |
| 4.10 | hours-api `list.test.ts`, `totals`/`labels` tests; UI: the single "deal or project is unknown" line and one source phrase by response rewrite. A real outage not made | ✓ (integration) |
| 4.11 | `tableGrid.test.ts` (meeting on its own row); not live | ✓ (unit) |

## Rendered checks the implementers could not do (all `RENDERED: no` items)

Evidence in `specs/20261112-project-hours/qe-evidence/` (68 files; names below are the files).

| Check | Result | Evidence |
|---|---|---|
| Project Hours card, all variants, 1280/360/320, light and dark | ✓ no horizontal page overflow in any of the 24 combinations | `variant-{year,over,capexp,capopen,fixed,empty}-{360,320}-{light,dark}.png`, `variant-*-1280-light.png`, `yearly-1280-light-{closed,open-pm}.png` |
| "Over by" (no minus, no colour), "Expired" badge beside the dates, divider only when both parts show | ✓ | `variant-over-1280-light.png`, `variant-capexp-1280-light.png`, `variant-sla-1280-light.png` |
| Package not started (variant B) | ✓ and it makes no windowed request | `variant-capfuture-1280-light.png` |
| Unavailable: block, widget, both; Retry and focus | ✓ focus lands on the "Consumption" / "Hours on this project" group after each Retry, by keyboard, whether it succeeds or fails again | `unavailable-{both,widget-only,block-only}-1280-light.png`, `fallback-host-1280-light.png`, `project-loading-1280-light.png` |
| Deal Hours card: frame, loading, 503, host fallback inside the card, order Meetings, Hours, Activity | ✓ order confirmed from the headings | `deal-{loading,503,fallback}-1280-light.png`, `deal-{360,320,1280}-{light,dark}-open.png` |
| `HostHours`: toggle, `hidden` region, tab stops, h4, Escape, focus ring | ✓ closed region skipped by Tab, `aria-controls` always resolves, Enter and Space toggle, Escape does nothing, 2 px ring | `keyboard-toggle-focus-1280-light.png` |
| `HostHours` tables at 320 | ✓ scroll inside their own named, focusable regions; a long unbreakable name pushes Time out of view (observation O3) | `variant-year-320-dark.png`, `deal-320-dark-open.png` |
| `identities` and `authz` notes inside the open region | ✓ closed: not shown; open: polite, Retry on the second | `hosthours-notes-1280-light.png` |
| "Counts for project" line, My hours list and Everyone's hours; hidden variant | ✓ | `everyone-project-1280-light.png`, `hours-outsider-hidden-project-1280.png` |
| Project-filter refusal at 360 and by keyboard | ✓ `role=alert`, Retry re-asks and focuses the banner if it fails again, Clear puts focus in the Project input | `hours-project-refusal-banner-360-light.png`, `hours-refusal-{360-dark,1280-dark,320-light}.png` |
| Grouping banner and `project-unknown` row | ✓ `role=status` polite, server order kept | `hours-project-grouping-360-light.png`, `hours-grouping-{360-dark,1280-dark,320-light}.png` |
| Contrast, both themes | ✓ lowest measured 4.87 (the refusal's ghost "Clear", dark), card text 5.24 (light) / 5.40 (dark), Expired badge 5+ | measured in page |
| Italian | ✓ "Ore", "Sforato di", "Scaduto", "Giornate", comma decimals, "Conta per" | `it-year-1280.png`, `it-capexp-1280.png` |

## Defects

**D1. Design clause not implemented: no polite "refreshed" status when a project filter's 409 restarts the list** (design.md F4/S4; low; owner: designer, or PO if it should be a requirement).
design.md S4 says a 409 `project_meetings_changed` "is handled like `deal_meetings_changed`: the list restarts from its first page **and the polite status says it
was refreshed**". The code restarts the list silently (`hours-ui/src/lib/useHoursQuery.ts:149`, the export walk's retry `exportPages.ts:49`). T12 recorded this as a
reinterpretation because the deal's own 409 has no status either, so the design sentence describes behaviour the deal never had. Placements, the same code
path: My hours list ✗, Everyone's hours ✗, export walk (silent retry) ✗; the deal filter ✗ identically (the design's premise was wrong for it too); My hours' table view not paged, n/a.
Evidence: `MyHoursPage.projectFilter.test.tsx:347` pins the silent restart. First seen this pass (missed earlier, not new since a fix).
Resolve either by amending design.md (drop the clause; AC-4.8 asks for nothing here) or by adding the status for both host filters.

**D2. Neighbouring e2e regression: `hours-owners.spec.ts` asserted the nine-column export — FIXED by QE in `75947f28`.**
Class: a spec'd contract change (AC-4.6, ten columns, Counts for project 7th) updated in the unit test and not in the neighbouring e2e.
Placements: `hours-owners.spec.ts:300` header assertion ✗ (failed in the first run), `helpers/hoursOwnersFixtures.ts` `readHoursExport` read nine cells ✗ (would have mis-mapped Category, Activity and Note), the other six specs and `project-hours.spec.ts` read no export ✓.
Root cause: T11 and T19 changed the column list and ran only the unit tests; T18's e2e covered only its own spec. Fix: header and reader now ten columns, plus an assertion that no row of that spec counts for a project; `hours-owners` 7/7 green at `75947f28`. Missed earlier (T11, T18), not new.

## Pre-existing red outside scope (triaged, not counted in the verdict)

- **`hours-in-place.spec.ts` A** (reader's step, `openTaskCard` at `hours-in-place.spec.ts:377`): Playwright refuses to click the task's board card because it is `aria-disabled="true"` for a reader who may not move it (`@operai/ui` Board, `useDraggable({ disabled })`, `d5b9ad82`, `ad7a0719`; the journeys were last adapted in `d87289e3`). None of those files is touched by this feature's commits, and the member half of A, which exercises Record hours on the page this feature changed, passed. Serial mode then skipped B-F; run alone they pass 5/5. Owner: whoever owns the task-board change.
- **crm-api `offerDrafts.preview.test.ts:739`**: the known red the brief named.
- **projects-ui `MyTasksPage.projectsDown.qe.test.tsx`**: two `it.fails`, an earlier spec's recorded gap.
- **shell dependency audit**: 5 high through `better-auth>vitest>vite>postcss>nanoid`; the lockfile is unchanged by this branch (only `version` differs from main), so it fails the CI command identically on main. A production-tier gate failure the owner should know about; not attributable to this feature.

## Observations (not defects; no AC, design clause or contract says otherwise)

- **O1. Unexplained disclosure reset, not reproduced.** Twice, early in the session, the open breakdown of the project card closed itself (not a reload: no second page-load log; the DOM node was not replaced in later runs). Five later observation runs (100 s, 60 s, 80 s, focus/visibility events, light/dark switches), with a mutation observer and a network observer, saw no reset and no request except the notify-api retry. notify-api was down all session (an environment fact), so the shell's stream-ticket retries ran throughout. Nothing points at this feature: `HostHours` keeps `open` in `Panel` state that only a change of `on:targetId` resets. Worth one look in an environment with notify-api up.
- **O2. A spoken zero reads "0 seconds"** (`formatDuration(0, { style: 'spoken' })`) in the empty card and a zero "Hours used"; the library's wording, new here only because a total can now be zero.
- **O3. At 320 px the By person table scrolls horizontally for a name with no break point** (test personas are "Php pm 1795768761306-638557"); design says the tables scroll in their own regions, so this is by design, but Time can sit out of view.
- **O4. The consumption facts wrap a date range at 1280** ("01.09.2026 – / 31.08.2027") because four facts share the row; and the programmatic focus ring on the Consumption group sits flush against its text (no inset). Cosmetic, for the designer if wanted.
- **O5. Accepted limitation A52 / D85 / R8** (page open across a Zurich date keeps the day it was read on): four cases accepted by the owner, not tested as defects. The behaviour in the code matches the description, including the window `[start, to-at-load]`.

## Environment faults

None. The stack answered throughout. notify-api and accounting-api were not running (as briefed): every page logs `ERR_CONNECTION_REFUSED` for `:8081` stream-ticket and push config; nothing else in the console belongs to this feature.

## Tests added (committed)

- `projects-api/src/terms/packagePeriod.oracle.test.ts` (4 tests, 120 ms): the period against a date-arithmetic oracle; the three mutations tried (expiry `>` to `>=`, 29 February clamp removed, anniversary `<=` to `<`) each fail it. (First version sampled 1.6 million days and timed out in the full suite under load; replaced in `95c3d470`.)
- `shell/e2e/project-hours-visibility.spec.ts` (3 journeys, real owners): variants, the deal card, linked meeting relink and hidden project in the list, totals, summary and file.
- `shell/e2e/hours-owners.spec.ts` and `helpers/hoursOwnersFixtures.ts`: the ten-column export (D2).
- Evidence: `specs/20261112-project-hours/qe-evidence/` (68 PNGs).

## Residue left in the shared dev stack (cannot be removed without a direct database write)

Throwaway projects, companies and a deal named `QE …` / `Php QE …` (the owners expose no delete); one 30-minute hours entry
`cmwyr4eb8002gbpvdaq743yjm` on deal `cmwyqcsze000ccyvdi312s0h6`, recorded through the browser during the live AC-2.8 check, whose person was removed by the run's cleanup before I
had registered it. Every other entry, meeting and person of this pass was removed.

## Security

owasp-reviewer: PASS already given by the caller (0 at medium or above; the low about `byPerson` on the wire is theirs). QE adds only evidence: the summary is 404 for an unreadable and a missing record with one body, never carries an id or name
of a project the viewer cannot read, `Cache-Control: no-store` on 200, 404 and 503, strict query (400 on none, both, half a window, reversed window, a window with a deal, an extra key), 401 without a JWT.

## Self-critique

One pass over this report: every number above was read from a log or a command in this session, not recalled; the "pre-existing" labels each rest on a stated check (files untouched by the feature's commits, lockfile unchanged), not on assumption, and are kept out of the verdict openly so the caller can overrule them. Two things I would not defend as thoroughly as the rest: O1 (I could not reproduce it and say so) and the e2e rows for AC-2.7, 4.10 and 4.11, which rest on integration and unit tests only because a live outage or an awaiting-manager project was out of reach. The FAIL rests on one low design clause; if the designer drops that sentence the verdict is a PASS without any code change.
