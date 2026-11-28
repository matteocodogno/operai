# hours-api

The time-tracking resource server (specs/20261112-time-tracking): **time entries** (a person's hours on one
day, on a project, a deal, a meeting or no entity), the **categories** and **work types** an admin manages, and
the **totals**. Bun + Hono + Prisma, port **8090**, logical database **`hours`**. Live API reference at
`http://localhost:8090/docs`.

## Authorization

Every route except `/health`, the API documents and the one service route below needs a valid user JWT (RS256, issuer
and `aud=AUTH_AUDIENCE` pinned). The `hours` catalog has no `access` resource: a person records and reads their own
hours with a session alone, and an entry that is not theirs is a 404 identical to a nonexistent one (a write by a holder
of `time-entry:read-all`, who can read it, is told 403 `owner_only`).

- `POST /time-entries`, `PATCH|DELETE /time-entries/{id}` — one's own entries; whether the caller may book on a
  project, a deal or a meeting is asked of its owner as the caller, failing closed.
- `GET /time-entries`, `GET /time-entries/totals` — one's own; `whose=all` (everyone's) needs `time-entry:read-all`,
  asked live of `auth` and failing closed (503 `authz_unavailable`). A holder never writes someone else's entry.
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
