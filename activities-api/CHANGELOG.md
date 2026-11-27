# @operai/activities-api

## 0.5.1

### Patch Changes

- 8653331: Inner deadlines now fit inside their callers' (specs/20261126-teams R13). The host routes of projects-api and crm-api (`/activity-host/v1/resolve`, `/meeting-host/v1/resolve`) wait at most 500 ms for a permission check they have not cached, then answer the usual 503 `authz_unavailable`; the check is single flight per person, is not aborted, and fills its 30 s cache for the retry. hours-api waits 6 s, not 2 s, for activities-api's lists and the meetings list, which ask a host themselves; activities-api waits at most 800 ms for the names on a list, and meetings-api's list makes no permission call (it never read the answer) and waits at most 800 ms for its creators' names. A name not known in time reads as unknown and is known on the next load. No wire contract changes.
- 8653331: A U+0000 in any input is a 400, never a 500. Postgres text (and the text inside jsonb) cannot hold it; every backend's global error handler now answers the database's refusal (Postgres 22021 / 22P05, Prisma P2039 / P2010) with a 400 `validation_failed` (hours-api: `invalid_request`) that names no value and none of the database's words, so a route nobody remembered is still not a 500. In auth a guard in front of the whole app refuses a NUL in the path, the query or a JSON body before any route runs (`GET /admin/users?q=%00`, `POST /admin/departments`, roles, invitations, legal entities, …). In projects-api the shared text helpers (`requiredText`, `optionalText`, a new `searchText`) refuse it, which covers `GET /projects?q=`, a project's name, a T&M position's profile, the Bexio order id and `GET /system/purchase-orders?dealIds=`.
- 8653331: The safety net that answers 400 when Postgres refuses a U+0000 now leaves one log line, `[nul] database refused U+0000 or invalid text` and the Prisma and SQLSTATE codes (`P2039/22021`), so a value built by the server with bad bytes is no longer blamed on the client without a trace (security review A09). The line carries only codes taken from the two closed sets the detector already knows: no message, value, argument, request or person. No wire contract changes.
- 3e5d1b5: A host that lists a project's assignees may answer `assignees: null` ("could not find out"): assigning a task on it is refused with 503 `host_unavailable`, while listing, opening, completing and an unchanged resent assignee are unaffected.

## 0.5.0

### Minor Changes

- 80e6949: `GET /tasks?status=done&completedSince=` lists the tasks completed since a moment (a board's Done lane: the last 30 days).
- 5318e3c: A task with a due date that is not done emails its assignee and participants the day before, at 08:00 (Zurich), in the CRM and in Projects; `TASK_DUE_REMINDERS=off` turns it off.

## 0.4.0

### Minor Changes

- 2b3d2fe: `GET /activities` takes a fifth filter, `ids` (up to 50, comma-separated), for hours-api's time entries (specs/20261112-time-tracking):
  it answers the activities among them that the caller still reads, as the existing activity view, newest first and
  in one page. Each id's host is asked as the caller, as for every other read. An id that does not exist, that the
  caller may not read or whose record the host no longer knows is left out, and the three answers are identical; a
  host that cannot answer is the existing 503 `host_unavailable`.
- 57ab20d: A task can now be marked "In progress", in the CRM and in Projects. Whoever can mark a task done can start it and stop it again; a task waiting on other tasks cannot be started until they are done. Done is still one click away from Open, and reopening a done task makes it open. The task lists' "Open" view includes tasks in progress (with an "In progress" badge), and a new "In progress" view shows only those. The task shows who started it and when.

## 0.3.0

### Minor Changes

- 241b97c: The author of a CRM activity or task now chooses who sees its details: everyone (the default, and every existing activity), the sales team (people who manage deals: today sales and admin), or only the author and, for a task, its assignee. Everyone else still sees the activity, its subject, people, dates and state, but not its text, description, pictures or attachments; it reads "Details are restricted". No role overrides the choice, administrators included. The subject is always visible, and the form says so. Projects' My tasks shows the same restricted line on a CRM task.

## 0.2.2

### Patch Changes

- 080a1fb: Migration logs on Railway no longer show as errors: `bun run` no longer echoes the command on stderr (`[run] silent = true`) and `db:deploy` sends Prisma's informational stderr to stdout. A failing migration still exits non-zero and fails the deploy.

## 0.2.1

### Patch Changes

- 9cd68a6: Moves activities-api to zod 4 (4.6.7) and `@hono/zod-openapi` 1.6.3, and `@scalar/hono-api-reference` to 0.12.17, closing the zod memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5, zod before 4.6.6, no 3.x fix); the Scalar bump is needed because the old one pulled a second, vulnerable zod. Every rejected request keeps its Problem document (422 with `field` and `errors`), but zod's own wording of the messages changes (for example `Required` for a missing member becomes `Invalid input: expected string, received undefined`). A JSON body sent with another Content-Type, or none, now answers 415 instead of 422. A datetime without seconds or with an offset written `+0200`, a `fileId` or `noticeId` that is not a standard UUID, and a `sizeBytes` beyond the safe integer range are now refused with 422. The OpenAPI document differs only in that the task `description` request member now states `additionalProperties` (any value), which it always allowed. The `/docs` page loads Scalar through a different script. `ACTIVITIES_MAINTENANCE` still turns maintenance on only for the literal `true`.
- 8d5ed71: Pins `hono` to 4.13.16 in every backend (it was a `^4.6.16` range that had resolved to 4.12.12 through 4.13.16 depending on the service), closing the hono advisories reported by `bun audit`, among them the CORS wildcard-origin reflection with credentials (GHSA-88fw-hqm2-52qc), the `bodyLimit()` bypass for chunked bodies (GHSA-9vqf-7f2p-gf9v), the CORS preflight ReDoS (GHSA-8j4g-w8fx-2239), the `mount()` prefix bypass (GHSA-4m76-xfj5-7975) and the RegExpRouter wildcard-middleware skip (GHSA-h7mg-cq63-vhpq). `@hono/node-server`, which only reaches the services through `prisma > @prisma/dev` (pinned there to 1.19.11, used by `prisma dev` and never at runtime), is overridden to 2.1.6 in each `package.json`, closing four path-handling advisories (GHSA-92pp-h63x-v22m, GHSA-frvp-7c67-39w9, GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w). No route, status code or response changes.
- 4b6e43e: Add `410: "Gone"` to the problem-title table of `src/lib/problem.ts`, the file these services keep as a copy of the shared one (specs/20261116-letterhead-service). A 410 problem response now carries the title `Gone` instead of falling back to the generic title.
- fcdb417: The validation hook's issue path type accepts any property key (zod 4 may report symbols), so it type-checks under both zod 3 and zod 4. Responses are unchanged.

## 0.2.0

### Minor Changes

- 4f8e70f: Add activities-api (specs/20261110-activities, ADR 20261110-activities-service-access-delegated-to-host/0082/0083): one backend-only service for the activities, tasks and
  task blockers of the CRM and of Projects, with no permission catalog of its own, so every access decision is
  asked of the host (`crm-api`, `projects-api`) as the caller and fails closed. `crm-api` moves its activities,
  participants, blockers and meeting host state out (they are copied in once by
  `activities-api/scripts/import-crm-activities.ts`, a later push drops the old tables) and calls
  `activities-api` with the new service scope `activities.write`; `projects-api` becomes a host. `auth`
  registers the scope and the `activities-api` service client; `notify-api` accepts the `projects` origin and
  binds `system:activities-api` to `crm` and `projects`; `notify-ui` tags it. The shell trusts the
  activities-api origin; `crm-ui` reads activities from it; `projects-ui` gains a Tasks card on a project and a
  My tasks page.
- 48de67f: Tasks have a rich description with pictures and attachments (ADR 20261113-task-description-files-in-activities-api-bucket). In the CRM and in Projects a task's text is now formatted (bold, lists, check lists…); pictures can be chosen, pasted or dropped into it, and files (PDF, Office, text, CSV, pictures) attached under it. Files are uploaded when the task is saved, live in activities-api's own EU bucket and are shown to whoever can read the task. A task's existing plain text becomes its description.
