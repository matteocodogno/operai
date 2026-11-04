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

More groups (plan.md § Environment). A misconfiguration exits 1 naming the variable, never its value.

| Variable | Notes |
|---|---|
| `MEETINGS_S3_ENDPOINT` / `_REGION` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | required; own EU bucket (MinIO locally). A non-AWS endpoint also needs `MEETINGS_S3_EU_ENDPOINT_HOSTS`. At start the bucket must carry one unfiltered lifecycle rule of at most 29 days and versioning must not be enabled (AC-4.4) |
| `NOTIFY_INTERNAL_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` | all or none; required in production. Client `meetings-api` needs scopes `notifications.push host-notices.send` |
| `CRM_API_URL` | the CRM host; required in production (defaults to `http://localhost:8084` otherwise) |
| `MEETINGS_AI_PROVIDER` | `real` (default, required in production) or `fake` (development and test only) |
| `AZURE_SPEECH_REGION`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_ENDPOINT` | transcription; region must be EU or Swiss; the optional endpoint must be a Microsoft regional host for that same region |
| `BEDROCK_REGION`, `BEDROCK_MODEL_ID`, `MEETINGS_AWS_ACCESS_KEY_ID`, `MEETINGS_AWS_SECRET_ACCESS_KEY` | language model; region must be an EU one |
| `MEETINGS_WORKER` | `on` (default), `off` or `only`: the job runner runs in this process |
| `MEETINGS_TEST_HOSTS` | JSON array of test hosts; refused in production |

Tests: `src/test-support/testEnv.ts` (the `bunfig.toml` preload) sets placeholders for all of the
above with `??=`. `DATABASE_URL` defaults to `postgresql://postgres:postgres@localhost:5435/meetings_test`;
where the compose Postgres has other credentials, export `DATABASE_URL` for a migrated `meetings_test`
database first (`bun run db:deploy`). DB-backed tests: `src/schema.test.ts`, `src/jobs/runner.test.ts`,
`src/health/health.test.ts`.

## Logging (AC-4.10)

The request logger writes method, path **without the query string**, status and duration. No
body, no title, no transcript, no search term is ever logged. Do not add one.

## Image

The Dockerfile installs a pinned `ffmpeg`/`ffprobe` (Debian) and runs as the non-root `bun`
user. `railway.json` pins `numReplicas: 1`: the job runner lives in the process (ADR-0062).
