# Operai — EstimAI

Internal toolsuite by **wellD** (wellD.ch) for AI-assisted software consulting workflows.
EstimAI is the first tool in the suite — a software effort estimator.

**Tagline:** *AI tools built by craftspeople, for craftspeople.*

---

## Project structure

```
operai/
├── estimai-ui/          # React + Vite frontend
│   ├── src/
│   │   ├── components/              # ActivityTable, SummaryTable, MetricsBar,
│   │   │                            # ParametersPanel, Header, HelpDrawer, QrModal, …
│   │   ├── context/
│   │   │   └── EstimatorContext.tsx # Global state + localStorage persistence
│   │   ├── hooks/
│   │   │   ├── useEstimator.ts      # All estimation computation logic
│   │   │   └── useTheme.ts
│   │   ├── lib/                     # pdfExport, ganttChart, healthWarnings,
│   │   │                            # shareUrl, templates, projects, …
│   │   ├── pages/                   # EstimatesPage, EstimatePage, SharedEstimatePage
│   │   ├── router.tsx               # TanStack Router
│   │   ├── types.ts                 # Shared TypeScript interfaces
│   │   ├── EstimatorApp.tsx         # Top-level layout + state + XLSX export
│   │   └── main.tsx
│   ├── package.json
│   └── vite.config.ts
│
├── auth/                # Bun + Hono authentication service
│   ├── src/
│   │   ├── auth/        # better-auth config, middleware, routes
│   │   ├── jwks/        # JWKS endpoint (RS256 public key)
│   │   ├── health/      # Health check routes
│   │   ├── openapi/     # OpenAPI registry (zod-openapi + Scalar)
│   │   └── lib/         # db (Prisma), env validation, errors
│   ├── prisma/          # Schema + migrations (PostgreSQL)
│   └── package.json
│
├── estimai-api/         # PLANNED — Spring Boot + Kotlin backend (directory empty)
│
├── compose.yaml         # Local PostgreSQL 17 (host port 5435)
├── mise.toml            # Node 24, corepack-managed pnpm
└── specs/               # Spec-driven workflow (see below)
```

---

## Tech stack

### Frontend (estimai-ui)
- **Runtime:** Node 24 via mise (pnpm via corepack, see `mise.toml`)
- **Package manager:** pnpm
- **Framework:** Vite 8 + React 19 (TypeScript)
- **Routing:** TanStack Router
- **Tables:** TanStack Table v8
- **Export:** `exceljs` + `xlsx` for XLSX, `jspdf` + `jspdf-autotable` for PDF
- **Sharing:** `lz-string` (URL-encoded estimates) + `qrcode`
- **Fonts:** DM Sans, DM Mono, Syne (Google Fonts)
- **Styling:** Tailwind CSS 4
- **Lint/format:** ESLint 9 (flat config) + Prettier
- **Deploy:** Vercel (auto-deploy on push to `main`)

### Auth service (auth)
- **Runtime:** Bun (`bun run --hot` for dev)
- **Framework:** Hono + `@hono/zod-openapi` (Scalar API reference)
- **Auth:** better-auth — OAuth (Google, GitHub) + session management
- **Tokens:** RS256 JWT issuance (`jose`) + JWKS endpoint; keypair via env vars
  (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`), generated locally with openssl — `.pem`
  files are gitignored, never commit them
- **Database:** PostgreSQL via Prisma 7 (`@prisma/adapter-pg`)
- **Errors:** Effect TS
- **Secrets:** 1Password references via `.envrc` (direnv); see `auth/.env.example`

### Backend (estimai-api) — planned, not yet implemented
- **Language:** Kotlin
- **Framework:** Spring Boot 3.x
- **Database:** PostgreSQL
- **Deploy:** Railway (EU region — data residency requirement)

---

## Estimation model

All computation lives in `estimai-ui/src/hooks/useEstimator.ts`. Do not duplicate
logic in components.

### Calculation chain (per release)

```
PERT              = (O + 4 × ML + P) / 6
Expected          = PERT + Risk Buffer
Individual M/D    = Σ Expected (for release) + QA Deploy + QA Test + PM overhead
Planning Days     = FTE × (Individual / Sprint Duration) / 8
Total Baseline    = Individual + Planning
Elapsed Days      = ROUND(Baseline × (1 − Parallelism × (FTE−1) / FTE))
Total Man/Days    = Elapsed × FTE
Elapsed Months    = Elapsed / Working Days per Month

AI-assisted M/D   = Expected × (1 − AI Productivity Gain)   [per activity, falls back to global]
AI-assisted Elapsed = same chain applied to AI-assisted individual sum
Total M/D (AI)    = AI-assisted Elapsed × FTE
AI Cost           = AI Cost Coefficient × FTE × Elapsed Days

Best Case         = full chain using Optimistic estimates
Worst Case        = full chain using Pessimistic estimates
```

### Model parameters and defaults

| Parameter | Default | Notes |
|---|---|---|
| Parallelism factor | 0.70 | % of work runnable in parallel |
| Sprint duration | 10 days | Drives planning overhead |
| Working days / month | 20 | Elapsed → months conversion |
| QA Deploy / release | 0 days | Fixed cost per release |
| QA Test / release | 0 days | Fixed cost per release |
| PM overhead / release | 0 days | Fixed cost per release |
| AI cost coefficient | 10 | €/$ per FTE per elapsed day |
| AI productivity gain | 0.30 | 30% effort reduction with AI tools |

### PERT derivation when only ML is given
```
Optimistic  = ML × 0.75
Pessimistic = ML × 1.60
```

### Important: PERT is never used directly in Summary
PERT is an intermediate value in the Detail table. Summary always SUMIFs on
`Expected` (= PERT + Risk Buffer), `Optimistic`, or `Pessimistic` — never on
PERT directly.

---

## Domain language

Use these terms consistently in code, API contracts, and UI copy:

| Term | Meaning |
|---|---|
| `estimate` | A top-level estimation document (project + releases + activities) |
| `release` | A delivery milestone, has a name and FTE count |
| `activity` | A single unit of work, belongs to an epic and a release |
| `epic` | A feature group containing multiple activities |
| `profile` | Specialist role required for an activity (e.g. Backend Dev, Designer) |
| `expected` | PERT + risk buffer — the primary effort figure per activity |
| `elapsed` | Calendar days for a release (after parallelism adjustment) |
| `man_days` | Total person-days (elapsed × FTE) |
| `ai_gain` | Fractional productivity improvement from AI tools (0.0–1.0) |
| `ai_cost_coef` | Cost per FTE per elapsed day for AI tooling |

---

## API contract (estimai-api — planned)

Base URL: `https://api.estimai.operai.io` (production) / `http://localhost:8080` (local)

### Planned endpoints

```
POST   /estimates                    Create a new estimate
GET    /estimates                    List estimates for current user
GET    /estimates/{id}               Get full estimate with releases + activities
PUT    /estimates/{id}               Update estimate metadata
DELETE /estimates/{id}               Delete estimate

POST   /estimates/{id}/releases      Add a release
PUT    /estimates/{id}/releases/{rid}
DELETE /estimates/{id}/releases/{rid}

POST   /estimates/{id}/activities    Add an activity
PUT    /estimates/{id}/activities/{aid}
DELETE /estimates/{id}/activities/{aid}

GET    /estimates/{id}/export/xlsx   Download Excel file (server-rendered)
```

Authentication: RS256 JWT issued by the `auth` service, verified via its JWKS endpoint.

---

## Data residency

wellD operates across Italy and Switzerland. Some clients are in regulated sectors
(energy, finance, healthcare). Apply these rules:

- Backend **must** deploy to an EU region (Railway EU, Fly.io fra, Azure Switzerland North)
- No estimate data should be logged by the hosting provider beyond standard access logs
- The frontend is purely client-side — no estimate data is transmitted except to the estimai-api

---

## Spec-driven workflow

Features follow the welld spec-driven workflow: `specs/NNN-slug/` holds `spec.md`
(what & why) → `plan.md` (how) → `tasks.md` (ordered work), produced by
`/welld-dev:spec`, `/welld-dev:plan`, and `/welld-dev:tasks` with a user approval
gate between each stage. See `specs/README.md`. The spec is the source of truth —
if implementation reveals it's wrong, update the spec first, then re-sync tasks.

---

## Development conventions

### Git
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/`
- Commit style: Conventional Commits (`feat: add AI cost column to summary`)
- `main` is always deployable
- A pre-commit hook runs gitleaks; 1Password references are allowlisted in `.gitleaksignore`

### Frontend
- **All files must be TypeScript** (`.ts` or `.tsx`) — never create `.js` or `.jsx` files
- Computation logic belongs in `useEstimator.ts` — never in components
- Components receive data and callbacks as props; they do not compute
- CSS variables defined in the root `<style>` block in `EstimatorApp.tsx`; do not add
  external CSS files unless introducing a proper CSS module setup
- All numbers displayed to the user must be rounded (`.toFixed()` or `Math.round()`)

### Auth service
- Validate all environment variables at startup (`src/lib/env.ts`)
- Routes grouped by feature directory (`auth/`, `jwks/`, `health/`), registered in
  `src/index.ts`; OpenAPI schemas in `src/openapi/registry.ts`
- Database access only through the Prisma client in `src/lib/db.ts`
- Prisma migrations — never modify existing migration files

### Backend (when estimai-api is built)
- Follow standard Spring Boot package-by-feature structure
- Use Kotlin data classes for DTOs; no `@Data` Lombok
- All DB access via Spring Data JPA repositories
- Flyway for migrations — never modify existing migration files
- Return `Problem` (RFC 7807) for all error responses

### All services
- No hardcoded strings that appear in the UI — use constants or i18n from day one
  (the tool will need Italian and English at minimum)
- Dates and durations always in ISO 8601 in API contracts; display formatting is a UI concern

---

## Running locally

### Database (shared)
```bash
docker compose up -d   # PostgreSQL 17 on localhost:5435
```

### Frontend
```bash
cd estimai-ui
pnpm install
pnpm dev              # http://localhost:5173
pnpm lint             # ESLint
pnpm build            # tsc -b + vite build (typecheck happens here)
```

### Auth service
```bash
cd auth
bun install
cp .env.example .env  # fill in credentials (or use direnv + 1Password via .envrc)
bun run db:migrate    # Prisma migrate dev
bun run dev           # http://localhost:3001 (hot reload)
bun run typecheck     # tsc --noEmit
```

### Backend (once it exists)
```bash
cd estimai-api
./gradlew bootRun     # http://localhost:8080
```

---

## Operai suite — future tools

EstimAI is tool #1. The suite roadmap (not yet built):

| Tool | Purpose |
|---|---|
| **EstimAI** | Software effort estimation with PERT + AI productivity modelling |
| **ReviewAI** | AI-assisted code and architecture review checklists |
| **RetroAI** | Sprint retrospective facilitation and pattern detection |
| **ProposAI** | Consulting proposal drafting from project briefs |

All tools share the Operai design system (DM Sans / DM Mono / Syne, dark ink palette, purple AI accent).
