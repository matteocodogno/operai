# hours-api

The time-tracking resource server (specs/20261112-time-tracking): **time entries** (a person's hours on one
day, on a project, a deal, a meeting or no entity), the **categories** and **work types** an admin manages, and
the **totals**; and, since specs/20261112-project-hours, the **summary** of the hours on one project or deal.
Bun + Hono + Prisma, port **8090**, logical database **`hours`**. Live API reference at
`http://localhost:8090/docs`.

## Authorization

Every route except `/health`, the API documents and the one service route below needs a valid user JWT (RS256, issuer
and `aud=AUTH_AUDIENCE` pinned). The `hours` catalog has no `access` resource: a person records and reads their own
hours with a session alone, and an entry that is not theirs is a 404 identical to a nonexistent one (a write by a holder
of `time-entry:read-all`, who can read it, is told 403 `owner_only`).

- `POST /time-entries`, `PATCH|DELETE /time-entries/{id}` — one's own entries; whether the caller may book on a
  project, a deal or a meeting is asked of its owner as the caller, failing closed.
- `GET /time-entries`, `GET /time-entries/totals` — one's own; `whose=all` (everyone's) needs `time-entry:read-all`,
  asked live of `auth` and failing closed (503 `authz_unavailable`). A holder never writes someone else's entry. With
  `projectId` they also count the meetings linked to the project (§ The project filter).
- `GET /time-entries/summary?projectId=<id>|dealId=<id>` — the hours on ONE project or deal, **everyone's**, for whoever
  the record's owner says may read it (asked of projects-api or crm-api as the caller, on every request); the per-person
  part only for the project's manager, the deal's owner or a holder of `time-entry:read-all` (§ A record's hours).
- `GET /time-lists`, `POST|PATCH /time-categories`, `POST|PATCH /work-types` — the lists; every write needs
  `time-list:manage`, live. Items are retired and restored, never deleted.

## The service route: meetings-api's notices (specs/20261112-meeting-hours)

`POST /system/meeting-hours/v1/notices` is the only route that takes a **service** credential, and the only way an
automatic entry is ever written.

| | |
|---|---|
| Caller | `system:meetings-api`, and no other service |
| Credential | a scoped service JWT minted by `auth` (`POST /system/service-token`): RS256 via `AUTH_JWKS_URL`, issuer `AUTH_ISSUER`, `aud=SERVICE_AUDIENCE` (never `AUTH_AUDIENCE`) |
| Scope | `meeting-hours-notices.send`, held in `auth`'s `SERVICE_CLIENTS` by the `meetings-api` entry only |
| Failures | a user JWT of any role, another audience, issuer, key, scope or `sub` (another service holding the scope included), an expired or malformed token, no token: the same 401 body, decided **before** the body is read |
| Body | `{ noticeId, meeting: { id, seq, facts: null \| { startsAt, durationMs \| null, creatorId, participantIds } } }`, strict: an unknown member at any level (a title, an external participant) is a 400 `invalid_request` and nothing is written. The schema is `src/lib/meetingHoursWire.ts`, a byte-identical copy of meetings-api's (`mise run shared:check`) |
| Answers | `200 { applied }` (`false`: a version older than the one already applied, nothing changed), `400`, `401`, `500` (a database failure that wrote nothing: the sender retries) |

`src/meetingHours/notices.routes.ts` mounts it; `src/index.ts` mounts that router **above** the user session guard
(mounted below it, a service JWT meets the user gate and every notice is a 401). Applying a notice is
`src/meetingHours/apply.ts`: one transaction under a row lock on the meeting, no outbound call and no notification.
An automatic entry is an ordinary entry of its person with `origin: "meeting"`; it follows its meeting only until the
person changes it, and is never written again once they delete it. `meeting_hours_release.since`, written by the
migration as the Zurich date the migration ran, is the release day: meetings before it get no entries.

## A record's hours: `GET /time-entries/summary` (specs/20261112-project-hours, ADR 20261126-a-record-hours-summary-is-authorised-by-the-records-owner-as-the-reader-and-its-per-person-part-by-a-role-the-owner-states)

The **hours on a project** are the entries on the project itself plus the entries on the meetings meetings-api says are linked
to it **now** (`GET /system/meetings/hosts?projectId=`, read with hours-api's own service credential, scope `meetings.hosts.read`),
whoever recorded them and whether or not they are on the team. Nothing about the link is stored on an entry, so a relink moves
the hours at the next read. A deal's hours are defined the same way (`dealId`). The summary is the suite's third read of hours,
beside a person's own and everyone's (`time-entry:read-all`): a read, and no write route comes with it.

| | |
|---|---|
| Query | strict: exactly one of `projectId`, `dealId`; `windowFrom` and `windowTo` (`YYYY-MM-DD`, `windowFrom` not after `windowTo`) both or neither, and only with `projectId`. Anything else is 400 `invalid_request` naming the member, decided before any owner or database is asked |
| Who may read | whoever the record's **owner** says may read it, asked as the caller with the forwarded JWT on every request and never cached: projects-api's `POST /activity-host/v1/resolve` for a project, crm-api's for a deal. `reader: false`, a missing record and an unreadable one are ONE 404 `not_found` |
| Answer | `{ on, totalMinutes, windowMinutes, byWorkType, byPerson, unavailable }` and nothing else: no entry, note, meeting id or title, activity subject or amount (a key-set test pins it). `Cache-Control: no-store`, also on the 404 and 503 |
| Figures | `totalMinutes` is all time, the sum of `byWorkType` (the most hours first, then by name; entries without a work type, a meeting's included, are one `none` group, last) and, when present, of `byPerson`. Only `windowMinutes` is windowed (the days of the window, both ends included; `null` without one). All of it is one `REPEATABLE READ` snapshot |
| `byPerson` | present only when the caller is the project's manager (`projectManagerId === sub`, from projects-api's resolve; `null` while a project awaits its manager, so then only a holder sees it), the deal's owner (`ownerUserId === sub`, crm-api's) or holds `time-entry:read-all` (asked live of `auth`, only for a caller who is neither; refusals remembered 30 s, a grant never). `null` for everyone else. `null` with `"authz"` in `unavailable` when `auth` could not say, never shown on a guess. A member an older owner does not send is read as nobody's, never as a grant |
| `unavailable` | `"identities"`: `auth` could not name some people (their `label` is `null`, the minutes still counted); `"authz"`: see `byPerson` |
| Failures | `400`; `401`; `404 not_found`; `503 host_unavailable` when the record's owner could not say whether the caller reads it, or meetings-api could not say which meetings are linked. Nothing partial: a record's hours are never shown low |

`src/summary/` holds it (`query.ts`, `summary.routes.ts`, `summary.ts`); `src/matrix.test.ts` pins the route inventory, so a write route added
beside it fails the suite.

### The project filter, by-project totals and an entry's project

`projectId` on `GET /time-entries` and `GET /time-entries/totals` means the hours on a project (`projectCondition` in `src/entries/filters.ts`,
beside the deal's `dealCondition`), and in particular:

- a list's cursor carries the linked meetings' key, and a set that changed between two pages is **409 `project_meetings_changed`** (as
  `deal_meetings_changed`: the client reads the list again from the start); meetings-api unable to say which meetings are linked is
  **503 `host_unavailable`** and nothing partial;
- `groupBy=project` puts a linked meeting's entries under its project when the viewer can read that project, under `hidden` or `unavailable`
  when not, under **`project-unknown`** when meetings-api could not be asked, and under `none` when the meeting is linked to no project (tail
  order: hidden, unavailable, project-unknown, none);
- a meeting entry's `on.project` (`MeetingProject`, beside `on.deal`) is `{ state: "linked", visibility: "visible", id, label, href }` only for a
  viewer who can read that project, `{ state: "linked", visibility: "hidden" | "unavailable" }` with no id, label or href otherwise,
  `{ state: "none" }` or `{ state: "unknown" }`; a meeting has one host, so at most one of `on.deal` and `on.project` is linked. `unavailable`
  may carry `"meeting-projects"`: an entry list names it together with `"meeting-deals"` (one read of the one host), a by-project totals read only
  its own.

## Environment

All variables are validated at startup (`src/lib/env.ts`); a missing one exits 1 naming it. Copy `.env.example` to
the gitignored `.env` and fill it. Required: `DATABASE_URL`, `ALLOWED_ORIGINS` (never `*`), `AUTH_JWKS_URL`,
`AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_BASE_URL`, the four owner URLs `PROJECTS_API_URL`, `CRM_API_URL`,
`ACTIVITIES_API_URL`, `MEETINGS_API_URL`, and hours-api's own service credential `SERVICE_CLIENT_ID`,
`SERVICE_CLIENT_SECRET` (at least 32 characters) and `SERVICE_AUDIENCE` (must differ from `AUTH_AUDIENCE`).
`SERVICE_AUDIENCE` is also the audience the notices route verifies. Optional: `PORT` (8090), `NODE_ENV`.

## Commands

```bash
bun install
bun run db:deploy        # apply migrations (db:migrate for a dev migration)
bun run db:generate      # regenerate the Prisma client
bun run dev              # http://localhost:8090 (hot reload)
bun run typecheck        # tsc --noEmit
bun test                 # against the `*_test` database next to DATABASE_URL (default `hours_test`), never the dev one
```
