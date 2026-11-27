# QE report — project-hours (specs/20261112-project-hours), rigor production, full mode

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
