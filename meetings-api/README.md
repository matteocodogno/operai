# meetings-api

The Meetings tool's resource server (specs/021-meetings): record, upload or paste a meeting,
transcribe it, summarise it with templates and ask questions of it. Bun + Hono + Prisma, port
**8085**, logical database **`meetings`**. Live API reference at `http://localhost:8085/docs`.

Contract: `specs/021-meetings/plan.md` (§ Architecture, § Data model, § API contracts).

## Run

```bash
bun install
bun run db:deploy   # migrations
bun run dev         # http://localhost:8085
bun run typecheck
bun test
```

Tests run against a real Postgres (`meetings_test` on the compose Postgres, :5435). Nothing in
the tests reaches a cloud provider: storage, the host, the transcriber and the language model
are faked.

## Environment

Validated at startup by `src/lib/env.ts`; the process exits 1 without echoing values.

| Variable | Local value |
|---|---|
| `DATABASE_URL` | `postgresql://<user>:<password>@localhost:5435/meetings` |
| `ALLOWED_ORIGINS` | `http://localhost:5173` |
| `AUTH_JWKS_URL` | `http://localhost:3001/auth/jwks` |
| `AUTH_ISSUER` | `http://localhost:3001` |
| `AUTH_AUDIENCE` | auth's `AUTH_AUDIENCE` (`operai-suite` locally) |
| `AUTH_BASE_URL` | `http://localhost:3001` |
| `PORT` | `8085` (default) |

The storage, notify, host and AI-provider groups are documented in plan.md § Environment and
land with their tasks.

## Logging (AC-4.10)

The request logger writes method, path **without the query string**, status and duration. No
body, no title, no transcript, no search term is ever logged. Do not add one.

## Image

The Dockerfile installs a pinned `ffmpeg`/`ffprobe` (Debian) and runs as the non-root `bun`
user. `railway.json` pins `numReplicas: 1`: the job runner lives in the process (ADR-0062).
