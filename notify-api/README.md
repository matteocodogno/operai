# notify-api

The suite's notification backend: persistence, an SSE push stream authenticated by a short-lived
ticket (ADR-0008/0009), an email channel via Resend (ADR-0011) and the internal `/system/*` routes
other services call. Bun + Hono + Prisma, port **8081**. Live API reference at
`http://localhost:8081/docs`. The service-wide conventions are in the repository's `AGENTS.md`;
this file records the service-to-service contract.

## The system routes

`POST /system/notifications` (scope `notifications.push`) and `POST /system/emails` (scope
`emails.send`) accept one credential: a 5-minute service JWT minted by `auth`
(`POST /system/service-token`, ADR-0044/0049) with `aud = SERVICE_AUDIENCE`. Every failure answers the
same `401`. Each caller authenticates as itself (`sub = system:<client>`) and is **bound to the
origin apps it may raise** (`SERVICE_ORIGIN_BINDINGS` in `src/system/systemAuth.middleware.ts`); a
body naming another `originApp` is `403`, and a `system:*` caller with no binding may raise none.

| Caller (`sub`) | May raise `originApp` |
|---|---|
| `system:inventory-api` | `inventory` |
| `system:refund-api` | `refund` |
| `system:estimai-api` | `estimai` |
| `system:crm-api` | `crm` |
| `system:projects-api` | `projects` (specs/022) |

### The `projects` origin (specs/022, AC-4.3)

projects-api pushes **one notification** to a purchase order's ops-manager after a won deal is taken
into a project: severity `info`, English only, a title naming the project, a body naming the company
and asking for the project manager, and a link to `/projects/<projectId>`. It carries no contact data,
and it is best effort on the caller's side (a failure here never fails the take). notify-ui labels the
origin "Projects" / "Progetti" in the notification centre.

Adding an origin app is a code change in three places: the binding above, the `originApp` enum in
`src/notifications/notifications.schemas.ts` and notify-ui's labels.

## Commands

```bash
bun install
bun run db:deploy     # applies the migrations to the database DATABASE_URL names
bun run dev           # http://localhost:8081
bun run typecheck
bun test
```

`direnv exec .` loads the environment, as for every backend (`cd notify-api && direnv exec . bun test`).
