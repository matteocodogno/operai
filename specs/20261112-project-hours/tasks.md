---
spec: 20261112
generated: 2026-11-26
synced: 2026-11-27
---

# Tasks: Project hours — time worked against what was sold

Contracts are `plan.md` (approved 2026-11-26; amended after design for D80 and while deriving these tasks for D81–D84):
Components, Who may see what, Consumption, Refreshing after Record hours, The hours views, Deploy order, Decisions D-P1–D-P6,
API contracts (`GET /time-entries/summary`, `SummaryAnswer`, `MeetingProject`, `currentPeriod { from, to, ended }`,
`hours.hostHours`, `operai:time-entry-recorded`), the Test strategy rows each `done when:` below quotes, Risks R1–R7 and
Security. Screens, states, copy (en + it) and the component inventory are `design.md` (option 2 of D80: one "Hours" card per
page; § Gap resolutions overrides G1–G6). ADRs: 20261126 record hours summary, 20261126 figure composed by the screen that
owns the comparison, and the 2026-11-26 amendments of 20261112 time bookability and 20261116 record hours widget.

**PR #12 (specs/20261112-meeting-hours) is not merged** and touches hours-api, hours-ui, `scripts/check-shared-copies.ts`
and the shared ledger (plan R1). **Re-synced 2026-11-26 (owner's decision): this branch is stacked on PR #12** — T5 rebases
it onto `feat/meeting-hours` now instead of waiting for the merge; how its pull request is stacked (a fork PR against
`feat/meeting-hours`, or a draft against `main` on `matteocodogno/operai`) is the owner's choice when the branch is first
pushed (plan R1: #12's branch exists only on the fork). Every task on those paths still depends on T5, and each re-checks
`git merge-base --is-ancestor <#12's current head> HEAD` first (plan R1). T1–T4, T14, T15 and T17 can start
now.

Test commands: hours-ui, projects-ui, crm-ui, shell `pnpm lint && pnpm build && pnpm test` (shell with
`NODE_OPTIONS=--no-webstorage`); Bun services `bun run typecheck && bun test <files>` — hours-api's preload points at
`hours_test`; for meetings-api, projects-api and crm-api run their tests against a scratch `DATABASE_URL`, never the dev
database (their suites truncate tables); `mise run shared:check`; e2e `cd shell && pnpm e2e project-hours.spec.ts` with the
stack up (`mise run dev`).

- [x] T1: [BE] meetings-api `GET /system/meetings/hosts` takes `projectId=` — refs: AC-4.1, AC-4.2, AC-4.4, AC-4.8, AC-4.9 — deps: none
  - touch: `meetings-api/src/system/hosts.routes.ts`, `meetings-api/src/system/hosts.routes.test.ts`
  - done when: `cd meetings-api && bun run typecheck && bun test src/system/hosts.routes.test.ts` passes with new cases: exactly one of `ids`, `dealId`, `projectId` (two or none → 422); `projectId` returns only meetings whose host is `{app:"projects", entityType:"project", entityId}` now (a deal-hosted and an unlinked meeting are absent; a relinked one moves); the answer stays `{ items: [{ id, host }] }`; scope `meetings.hosts.read` and `sub` `system:hours-api` unchanged, any other credential the same 401

- [x] T2: [BE] projects-api activity-host resolve answers `projectManagerId` — refs: AC-2.3, AC-2.7 — deps: none
  - touch: `projects-api/src/activity-host/activity-host.routes.ts`, `projects-api/src/activity-host/activity-host.test.ts`
  - done when: `cd projects-api && bun run typecheck && bun test src/activity-host/activity-host.test.ts` passes: an open item carries `projectManagerId` (the PM's id), `null` for a project awaiting its manager; `assignees`, `may`, `missing` and `reader:false` unchanged (existing tests untouched)

- [x] T3: [BE] projects-api `packagePeriod`, the Zurich business day and `hourPackage.currentPeriod { from, to, ended }` — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.9 — deps: none
  - touch: `projects-api/src/terms/packagePeriod*.ts`, `projects-api/src/lib/businessDay*.ts`, `projects-api/src/projects/projects.schemas.ts`, `projects-api/src/terms/terms.ts`, `projects-api/src/terms/terms.test.ts`, `projects-api/src/projects/*.test.ts`
  - done when: `cd projects-api && bun run typecheck && bun test src/terms src/lib/businessDay* src/projects` passes with `packagePeriod` vectors (plan Test strategy AC-1.1–1.3, AC-1.9): yearly period *k* and its boundaries, an anniversary on 29 February in a common year, capacity with expiry, without (to = today), after expiry (stays, `ended: true`), before start (`null`), yearly and unexpired `ended: false`; `businessDay` returns the Europe/Zurich date across midnight UTC; `GET /projects/{id}` carries `currentPeriod` inside `hourPackage` and nothing else changes in the view

- [x] T4: [BE] crm-api deal resolve answers `ownerUserId` — refs: AC-2.4 — deps: none
  - touch: `crm-api/src/activity-host/resolve.routes.ts`, `crm-api/src/activity-host/resolve.test.ts`
  - done when: `cd crm-api && bun run typecheck && bun test src/activity-host/resolve.test.ts` passes: a deal's open item carries `ownerUserId`; `involved`, `reader:false` and the strict body unchanged

- [x] T5: [OPS] Stack on PR #12: rebase onto `feat/meeting-hours` — refs: plan R1 — deps: none
  - touch: unknown — a whole-branch rebase onto PR #12's branch; scheduled alone
  - done when: `git merge-base --is-ancestor 75c712da HEAD` (PR #12's head; a later #12 head if it moved) holds and `feat/project-hours` has no merge commit; the conflicts in `specs/20261112-time-tracking/ledger.md`, `AGENTS.md` and `.claude/context/glossary.md` are resolved keeping both sides (ledger: D54–D77 then D78–D84, F and A entries in order); `bunx prisma generate` re-run in hours-api and meetings-api; `cd hours-api && bun run typecheck`, `cd meetings-api && bun run typecheck`, `cd hours-ui && pnpm build` and `mise run shared:check` are green; nothing is pushed (the branch has never been pushed, so no force push is needed; a push is the owner's call)

- [x] T6: [BE] hours-api clients and owner fakes: a project's linked meetings, `projectManagerId`, `ownerUserId` — refs: AC-4.1, AC-2.3, AC-2.4 — deps: T5
  - touch: `hours-api/src/clients/meetings.ts`, `hours-api/src/clients/meetings.system.test.ts`, `hours-api/src/clients/projects.ts`, `hours-api/src/clients/projects.test.ts`, `hours-api/src/clients/crm.ts`, `hours-api/src/clients/crm.test.ts`, `hours-api/src/test-support/*`
  - done when: `cd hours-api && bun run typecheck && bun test src/clients` passes: `readMeetingsLinkedToProject(projectId)` calls `?projectId=` with hours-api's service credential and keeps only `projects/project/<id>` hosts, unavailable on any failure (as the deal's); the projects and crm resolve parsers expose `projectManagerId` / `ownerUserId` and still accept an answer without them (an older owner: `undefined`, never a grant); the fake owners in `test-support/hosts.ts` serve `projectId`, `projectManagerId` and `ownerUserId`

- [x] T7: [BE] hours-api labels: a meeting's project (`on.project`, `MeetingProject`) — refs: AC-4.7, AC-4.10 — deps: T6
  - touch: `hours-api/src/labels/*`, `hours-api/src/entries/view.ts`, `hours-api/src/entries/view.test.ts`, `hours-api/src/entries/list.routes.ts`, `hours-api/src/test-support/*`
  - done when: `cd hours-api && bun run typecheck && bun test src/labels src/entries/view.test.ts` passes: a meeting's `on.project` is `linked visible {id,label,href}` only when the viewer reads the project, `linked hidden|unavailable` with no id/label/href otherwise, `none` when not linked to a project, `unknown` when meetings-api did not answer (with `"meeting-projects"` in `unavailable`); at most one of `on.deal`/`on.project` is linked; `OnSchema` stays strict

- [x] T8: [BE] hours-api project filter with linked meetings and by-project totals — refs: AC-4.4, AC-4.5, AC-4.8, AC-4.10 — deps: T7
  - touch: `hours-api/src/entries/filters.ts`, `hours-api/src/entries/list.routes.ts`, `hours-api/src/entries/*.test.ts`, `hours-api/src/totals/*`, `hours-api/src/test-support/*`
  - done when: `cd hours-api && bun run typecheck && bun test src/entries src/totals` passes with the plan's rows: `GET /time-entries?projectId=` lists the linked meeting's entries; a relink between pages → 409 `project_meetings_changed`; meetings-api down → 503 `host_unavailable`, nothing partial; `groupBy=project` puts a linked meeting entry under a readable project, `hidden`/`unavailable` otherwise, `project-unknown` when the hosts read failed, `none` when unlinked, tail order hidden, unavailable, project-unknown, none; every existing deal-filter test unchanged

- [x] T9: [BE] hours-api `GET /time-entries/summary` — refs: AC-1.8, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.7, AC-3.1, AC-4.1, AC-4.2, AC-4.3, AC-4.9 — deps: T8
  - touch: `hours-api/src/summary/*`, `hours-api/src/index.ts`, `hours-api/src/openapi/registry.ts`, `hours-api/src/matrix.test.ts`, `hours-api/src/openapi.contract.test.ts`, `hours-api/src/test-support/*`
  - done when: `cd hours-api && bun run typecheck && bun test src/summary src/matrix.test.ts src/openapi.contract.test.ts` passes with the plan's rows: strict query (one of `projectId`/`dealId`, window both-or-neither, project only); a reader gets `totalMinutes`, `windowMinutes`, `byWorkType` with the `none` group; `byPerson` only for `projectManagerId === sub`, `ownerUserId === sub` or a `time-entry:read-all` holder, `null` otherwise and for an awaiting project's ops-manager, `null` + `"authz"` when auth is down; linked-meeting entries counted whoever recorded them, following a relink; missing and unreadable record one identical 404; owner or meetings-api down → 503; a key-set test proves no entry, note, meeting id or title, subject or money in the answer; `Cache-Control: no-store`; the inventory lists one new `GET` and no write route

- [x] T10: [FE] The `operai:time-entry-recorded` event: shared module, `./RecordHours` broadcasts it — refs: AC-2.8 — deps: T5
  - touch: `hours-ui/src/lib/timeEntryRecordedEvent*.ts`, `projects-ui/src/lib/timeEntryRecordedEvent.ts`, `hours-ui/src/RecordHours.tsx`, `hours-ui/src/RecordHours*.test.tsx`, `scripts/check-shared-copies.ts`, `scripts/check-shared-copies.test.ts`
  - done when: `mise run shared:check` reports the new group in sync; `cd hours-ui && pnpm lint && pnpm build && pnpm test` passes with: the guard accepts `{ on, targetId }` and refuses anything else; `RecordHours` dispatches exactly one event after a successful save, naming its target (a task row: the task's project), and none after a refused or failed save; `cd projects-ui && pnpm build` still passes with the copied module

- [x] T11: [FE] hours-ui types, the "Counts for project" line, the export column, a missing `on.project` read as none — refs: AC-4.6, AC-4.7, AC-4.11, AC-3.2 — deps: T5
  - touch: `hours-ui/src/lib/hoursApi.types.ts`, `hours-ui/src/lib/names*.ts`, `hours-ui/src/lib/hoursWorkbook*.ts`, `hours-ui/src/lib/tableGrid.test.ts`, `hours-ui/src/components/EntryRow*.tsx`, `hours-ui/src/components/EntriesTable*.tsx`, `hours-ui/src/strings/names.ts`, `hours-ui/src/strings/export.ts`
  - done when: `cd hours-ui && pnpm lint && pnpm build && pnpm test` passes with: `countsForProjectLine` for linked visible / hidden / unavailable, `null` for unknown and none, the widened unknown line "The deal or project these hours count for is unknown right now"; the export's 10 columns with Counts for project 7th and the plan's cell values; an entry without `on.project` behaves as `none` everywhere; `tableGrid` keeps a project-linked meeting entry on the meeting's row; en/it parity

- [x] T12: [FE] hours-ui by-project totals, the grouping banner, the project-filter refusal and its 409 — refs: AC-4.5, AC-4.8, AC-4.10, AC-3.2 — deps: T11
  - touch: `hours-ui/src/components/TotalsCardRows*.ts`, `hours-ui/src/components/HoursBanners*.tsx`, `hours-ui/src/components/DealFilterUnavailable*.tsx`, `hours-ui/src/pages/MyHoursPage*.tsx`, `hours-ui/src/pages/EveryoneHoursPage*.tsx`, `hours-ui/src/strings/totals.ts`, `hours-ui/src/strings/entries.ts`
  - done when: `cd hours-ui && pnpm lint && pnpm build && pnpm test` passes with: `project-unknown` renders "Meetings whose project is unknown right now" in server order; the project-grouping banner only while grouping by project with `meeting-projects` unavailable; the generalised refusal (`kind: 'deal' | 'project'`) on a project filter's 503 replaces Totals and Entries, keeps pages already shown (D48), Clear returns focus to the Project picker; `project_meetings_changed` restarts the list like the deal's 409; an unknown group kind still renders (R4)

- [x] T13: [FE] hours-ui `./HostHours` widget: total, closed breakdown, re-read on the event — refs: AC-1.7, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7, AC-2.8, AC-4.3, AC-4.9, AC-3.2 — deps: T10, T11
  - touch: `hours-ui/src/HostHours*.tsx`, `hours-ui/src/HostHoursModel*.ts`, `hours-ui/vite.config.ts`, `hours-ui/src/lib/hoursApi.ts`, `hours-ui/src/lib/hoursApi.types.ts`, `hours-ui/src/strings/hostHours.ts`, `hours-ui/src/strings.ts`, `hours-ui/src/federation/*`
  - done when: `cd hours-ui && pnpm lint && pnpm build && pnpm test` passes with (design S3, § Gap resolutions): one summary call on mount; total and the "includes linked meetings" line visible; "Show breakdown" closed on mount, `aria-expanded`/`aria-controls` to a region kept in the DOM with `hidden`, opening makes no request; By person only when `byPerson` is present, no placeholder otherwise; empty = "0 min" + sentence, no disclosure; 503/404/network → warning banner with Retry, no figure; `authz`/`identities` notes inside the open region; invalid props throw; an event naming its target re-reads keeping the figures until the answer, another target or malformed detail ignored, a burst one re-read; it imports no exceljs, page or router; `./HostHours` exposed

- [x] T14: [FE] shell registers `hours.hostHours` — refs: AC-2.6 — deps: none
  - touch: `shell/src/lib/extensions*`, `shell/src/federation/*`
  - done when: `cd shell && pnpm lint && pnpm build && NODE_OPTIONS=--no-webstorage pnpm test` passes: `ExtensionProps['hours.hostHours']` is `{ on: 'project' | 'deal'; targetId: string }`, `LOADERS` imports `hours/HostHours`, a failed import or timeout renders the host's fallback (test as for `hours.recordHours`)

- [x] T15: [FE] projects-ui `consumption.ts` (pure) and `currentPeriod` types — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-1.6, AC-1.9 — deps: none
  - touch: `projects-ui/src/lib/consumption*.ts`, `projects-ui/src/lib/types.ts`
  - done when: `cd projects-ui && pnpm lint && pnpm build && pnpm test` passes with `consumptionOf` vectors: package used/left, exceeded → `overBy` the absolute minutes, never negative (D81); `ended` passed through (D83); man-days in integer tenths (480 → 1.0, 30 → 0.1, 24 → 0.1, 23 → 0.0, 3 600 → 7.5); fixed price with and without `estimatedManDays`; T&M against Σ planned man-days, no per-position figure; `none` for no terms or an SLA without hour package (D82)

- [x] T16: [FE] projects-ui one "Hours" card: `HoursSection`, `ConsumptionBlock`, re-read on the event — refs: AC-1.1, AC-1.4, AC-1.5, AC-1.7, AC-1.8, AC-1.9, AC-2.6, AC-2.8, AC-3.2 — deps: T10, T15
  - touch: `projects-ui/src/components/HoursSection*.tsx`, `projects-ui/src/components/ConsumptionBlock*.tsx`, `projects-ui/src/pages/ProjectDetailPage*.tsx`, `projects-ui/src/lib/hoursApi*.ts`, `projects-ui/src/federation/remotes.d.ts`, `projects-ui/src/strings/project.ts`
  - done when: `cd projects-ui && pnpm lint && pnpm build && pnpm test` passes with (design S1, § Gap resolutions): one card right after Details; consumption facts (variants A–D, "Over by", "Expired" `StatusBadge` `voided` only when `ended`), divider, widget slot; no comparable terms → widget alone; block and widget fail independently (four combinations, two banners each with Retry); the slot fallback leaves the block; an event naming the project re-reads the block keeping its figures until the answer; no money formatter imported; en/it parity and the hardcoded-copy scan

- [x] T17: [FE] crm-ui one "Hours" card on the deal page — refs: AC-2.2, AC-2.4, AC-2.6, AC-3.2 — deps: none
  - touch: `crm-ui/src/components/HoursSection*.tsx`, `crm-ui/src/pages/DealDetailPage*.tsx`, `crm-ui/src/strings/deals.ts`, `crm-ui/src/federation/*`
  - done when: `cd crm-ui && pnpm lint && pnpm build && pnpm test` passes: one "Hours" card after Meetings and before the timeline holding `hours.hostHours` with `{ on: 'deal', targetId }`; a failed or missing extension shows the slot's "Hours are unavailable. Reload the page to try again." and the page renders; en/it parity

- [ ] T18: [QE] e2e `shell/e2e/project-hours.spec.ts` — refs: AC-1.1, AC-2.3, AC-2.5, AC-2.8, AC-4.4 — deps: T1, T2, T3, T4, T9, T12, T13, T14, T16, T17
  - touch: `shell/e2e/project-hours.spec.ts`, `shell/e2e/helpers/*`
  - done when: `cd shell && pnpm e2e project-hours.spec.ts` passes with the stack up: a project with a yearly package and entries shows used / left without opening the breakdown; its PM opens the breakdown and sees By person, another `projects:access` reader does not; recording 1 h with Record hours on the page grows the card's figures by 1 h without a reload; My hours filtered by the project lists an entry on a meeting linked to it

- [ ] T19: [DOCS] AGENTS.md, infra/README (deploy order), changesets — refs: plan § Deploy order — deps: T1, T2, T3, T4, T9, T10, T11, T12, T13, T14, T15, T16, T17
  - touch: `AGENTS.md`, `infra/README.md`, `meetings-api/README.md`, `hours-api/README.md`, `.changeset/*`
  - done when: AGENTS.md describes the summary route, meetings-api's `projectId` (and `meetings-api/README.md`'s route paragraph names it; `hours-api/README.md`'s route list names the summary, `project_meetings_changed` and `project-unknown`), `./HostHours` and `hours.hostHours`, the `operai:time-entry-recorded` event and the one Hours card; infra/README states the five-step deploy order of the plan; one changeset selects meetings-api, projects-api, crm-api, hours-api, hours-ui, shell, projects-ui and crm-ui (minor); `mise run changeset:check` passes

- [ ] T21: [FE] hours-ui export refused under a project filter switches the page to the refusal, as for a deal — refs: AC-4.8 — deps: T12
  - touch: `hours-ui/src/components/HoursExport*.tsx`, `hours-ui/src/pages/MyHoursPage*.tsx`, `hours-ui/src/pages/EveryoneHoursPage*.tsx`
  - done when: with a project filter set and Meetings unable to say which meetings are linked when Export is clicked (503 `host_unavailable`), My hours and Everyone's hours switch to the project-filter refusal exactly as they do for a deal filter, nothing is downloaded and the button shows no failure alert of its own; a deal filter behaves as before; tests in `HoursExport.test.tsx` and both pages' project-filter tests; hours-ui `pnpm lint && pnpm build && pnpm test` green

- [ ] T20: Close the feature: all gates green, spec status → done — refs: all ACs — deps: T18, T19, T21
  - touch: `specs/20261112-project-hours/*`
  - done when: every app's lint/build/test and `mise run shared:check` are green on the branch; QE verdict PASS, security review PASS (plan § Security), eval PASS; `/wellforge:done 20261112-project-hours` accepts the gate
