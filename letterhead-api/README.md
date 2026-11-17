# letterhead-api

Lays out a whole document (header, footer, page numbers, page breaks) for every tool in the suite.
Rust, [Typst](https://typst.app) embedded as a library, for document layout only. Specification:
`specs/20261116-letterhead-service/` (spec, plan, tasks). Decision:
`docs/adr/20261116-letterhead-api-is-a-rust-service-with-typst-embedded-for-document-layout-only.md`.
Conventions: the **Rust service** section of the repository's `AGENTS.md`.

The skeleton (task T1) is the workspace, the environment contract, `GET /health`, the image and the monorepo wiring; the
engine, the pool and the service routes have been added since, and the person routes follow.

## Layout

| Path | What |
| --- | --- |
| `engine/` | `letterhead-engine`: the pure crate. No I/O, no clock, no network; a test guards it. |
| `api/` | `letterhead-api`: the HTTP supervisor (axum + tokio). Also the home of the `worker` mode. |
| `perf/` | Latency of the 10-page offer (AC-1.9, AC-1.10) and the memory limit under the worst request: scripts and recipes. |
| `Dockerfile` | Multi-stage: pinned Rust builder, then non-root `debian:bookworm-slim`. One binary. |
| `package.json`, `CHANGELOG.md` | The Changesets shim. The Cargo version is **not** the release version. |

## Run it

Rust is pinned in the repository root's `mise.toml` (`mise install`).

```bash
mise run dev:letterhead            # host, :8088, local defaults (needs Postgres + MinIO: `mise run dev` starts them)
docker compose up letterhead-api   # in a container, with its database and bucket
curl -i localhost:8088/health      # 200 {"status":"ok","service":"letterhead-api"}
```

```bash
cd letterhead-api
cargo test --workspace --locked
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release --locked
docker build -t letterhead-api letterhead-api   # from the repository root
```

`letterhead-api healthcheck` makes one request to its own `/health` and exits 0 on 200 (the image has
no curl or wget; this is its `HEALTHCHECK`). Any other argument is a usage error.

## Migrations

```bash
letterhead-api migrate                  # applies the migrations embedded in the binary (sqlx::migrate!), then exits
mise run db:migrate                     # the same, locally, through `cargo run -p letterhead-api -- migrate`
```

`migrate` reads **only** `DATABASE_URL`. It exits 0 when nothing is left to apply, and on failure exits non-zero with a message
that never holds the URL. `letterhead-api` (serve) never migrates and refuses to start on a database that is behind. Compose
runs it as the one-shot `letterhead-api-migrate`, which the service waits for; on Railway it is the service's `preDeploy`
(see below). A new file in `api/migrations` is picked up by the next build (`api/build.rs`).

## Railway and performance

The service, its `letterhead` bucket and its custom domain are declared in `.railway/railway.ts`:
`start: "letterhead-api"`, `preDeploy: "letterhead-api migrate"` (the image has `CMD`, not `ENTRYPOINT`, so both are whole
commands), one replica in `europe-west4`, and `limitOverride` of 2 vCPU and 5 GB (2 workers x 2 GiB plus the supervisor).
Nothing is applied from a branch: provisioning is a person's step, with the commands in `infra/README.md` § `letterhead-api`
service. `perf/` measures the 10-page offer against AC-1.9 and AC-1.10, locally in a container with those limits and, in T40,
on the deployed service (`perf/README.md`).

## Memory of a render

A render runs in a worker process that the supervisor kills when its resident memory passes `LH_WORKER_RSS_MB`
(default 2048). The page limit (AC-3.3, 300 pages) is checked only after the whole document is laid out, so a document
over it has used all the memory it will use before it can be refused 422 `too_many_pages`. The cap therefore has to
sit above the layout of a table a little over the limit: at 1 GiB such a table was killed first and answered 503. At
2 GiB a table of the most blocks the limits allow (4 984) that comes to just over 300 pages is refused with 422: on
Linux its worker peaks at 1.53 GiB (VmHWM, the 300-page table and the 301-page one alike; 1.5 GiB was not enough), on macOS
at 1.6 to 1.8 GiB by `ps` (spike.md, "Not measured"). The memory of a layout grows with its pages, and the limits of AC-3.3 (5 000 blocks, 200 000 characters a text)
do not bound the pages: the same table with a 240-character middle cell reaches the cap before the check and answers
503, which is what the cap is for. Workers x cap plus the supervisor must stay
inside the container (`.railway/railway.ts`, `limitOverride`); raise the two together, with a measurement
(`perf/worst-case.ts`). The tests of the worst case, `tests/pool.rs` and the last of `tests/render.rs`'s refusals, run
only with `LETTERHEAD_WORST_CASE_TESTS=1` (the second also needs `--release`: a debug engine takes minutes over that
document, past the service's 30 s deadline).

## Environment

Read and validated once, at startup, by `api/src/env.rs`. The process exits 1 and prints every problem
(variable name and rule, never a value) when the environment is invalid, before opening a socket.
`tools/env-doctor/manifest.ts` carries the same contract for the deployed environments.

| Variable | Required | Meaning |
| --- | --- | --- |
| `PORT` | no, `8088` | Listening port. |
| `DATABASE_URL` | yes | `postgres://` URL; logical database `letterhead`. Secret. |
| `AUTH_ISSUER` | yes | Public URL of `auth`; the `iss` of its tokens. |
| `AUTH_JWKS_URL` | yes | `auth`'s JWKS. `https`, or `http` only to a loopback, private or internal host (below). |
| `AUTH_BASE_URL` | yes | `auth`'s base URL (`/authz/resolve` for the configurator's routes; the person's bearer token is sent there). Same rule as `AUTH_JWKS_URL`. |
| `AUTH_AUDIENCE` | yes | `aud` of person tokens. |
| `SERVICE_AUDIENCE` | yes | `aud` of service tokens (`/v1/render/*`, scope `letterhead:render`). Must differ from `AUTH_AUDIENCE`. |
| `SERVICE_CLIENT_ID` | yes | This service's own client at `auth` (`letterhead-api`): lower-case alphanumerics and single hyphens, at most 64 characters. Its only scope is `legal-entities:read` (see "The issuer's details" below). |
| `SERVICE_CLIENT_SECRET` | yes | That client's secret, 32 to 256 characters. Secret; read by the supervisor only (the render workers start with an empty environment). |
| `ALLOWED_ORIGINS` | yes | CORS origins, exactly as the browser sends them; no wildcard. |
| `LETTERHEAD_S3_ENDPOINT` / `_REGION` / `_BUCKET` | yes | The EU bucket for logos and backgrounds. |
| `LETTERHEAD_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | yes | Its credentials. Secrets. |
| `LETTERHEAD_S3_EU_ENDPOINT_HOSTS` | for a non-AWS endpoint | Comma-separated EU host suffixes; the residency guard (AC-3.8). |
| `LH_WORKERS` | no, `2` | Render worker pool size, 1 to 64. With 2 or more, previews and the fit check of a save may use at most `LH_WORKERS - 1` of them, so one worker is always free for a PDF; with 1 nothing is reserved (see the ADR amendment of 2026-11-17). |
| `LH_QUEUE` | no, `4` | Renders that may wait for a worker, 0 to 1024. |
| `LH_WORKER_RSS_MB` | no, `2048` | Resident memory, in MiB, at which a render worker is killed and the request answers 503 `render_memory_exceeded`, 64 to 16384. `LH_WORKERS` x this, plus the supervisor, must fit the container (see below). |
| `RAILWAY_PRIVATE_DOMAIN` | no | Set by Railway; when present the service binds `::` (private networking is IPv6-only). |

**Auth URLs (security review F4).** The service sends a person's bearer token to `AUTH_BASE_URL` and trusts the keys at
`AUTH_JWKS_URL`, so a plain `http` URL to a public host stops the start (the message names the variable, never the value).
`http` is accepted for `localhost` and other loopback addresses, the private ranges (`10/8`, `172.16/12`, `192.168/16`,
`fc00::/7`, link-local), `host.docker.internal`, `*.railway.internal` and other `*.internal` names, `*.localhost`, and a
name without a dot (a compose service name). Everything else needs `https`.

**EU residency (AC-3.8).** An `*.amazonaws.com` endpoint needs an EU `LETTERHEAD_S3_REGION`, and a region named in its host
(`s3.us-east-1.amazonaws.com`) must be an EU one too; any other
endpoint needs its host to match `LETTERHEAD_S3_EU_ENDPOINT_HOSTS`. An empty or unset list, a host outside
it, or a region outside the EU stops the start. This is the rule of `crm-api/src/lib/s3Residency.ts`.

**The issuer's details (specs/20261117-legal-entities, AC-1.5, AC-3.3, AC-5.5).** The legal name, address, VAT number and
IBAN that a document prints are `auth`'s, not the caller's: the service reads `GET {AUTH_BASE_URL}/system/legal-entities`
as itself, with a service token from `POST {AUTH_BASE_URL}/system/service-token` (`SERVICE_CLIENT_ID` and
`SERVICE_CLIENT_SECRET`; scope `legal-entities:read`). The code is `api/src/registry/`: `cache.rs` is the rule, `http.rs`
the one real source. The rule is the consumer cache rule of the ADR, the same as `crm-api/src/lib/legalEntities.ts`:

- one entry per process (both entities), stamped with the monotonic time its request was **sent**;
- younger than 30 s: used with no call; otherwise refreshed (one refresh at a time, 5 s in all, no redirect, at most
  64 KiB, a 401 drops the token and retries once);
- the refresh fails and the entry is at most 60 s old: the entry is used and `registry_stale_used` is logged;
- otherwise the read is `Unavailable` (the routes answer 503 `legal_entities_unavailable`, `Retry-After: 5`) and no
  document is made from older details.

So a save in `auth` is in every document started more than 60 s after it, and no document is made from details older
than 60 s. The log has closed words and numbers (`registry event=registry_stale_used age_ms=… cause=…`), never a token,
the secret or a value. The client id is `letterhead-api` in `auth`'s `SERVICE_CLIENTS` (`infra/README.md`); a start without
either variable fails with exit code 1 before any socket is opened. The tests are `api/tests/registry.rs` (a fake clock and
a fake source for the rule, a stub of `auth` on a loopback port for the real source, the shared fixture
`specs/20261117-legal-entities/fixtures/legal-entities.json`).

**Callers (AC-9.3).** No caller is named here or in the code. A caller is a service client at `auth`
with the scope `letterhead:render`; adding one changes `auth`'s `SERVICE_CLIENTS`, not this service.
