# Operai — EstimAI

Internal toolsuite by **wellD** (wellD.ch) for AI-assisted software consulting workflows.
EstimAI is the first tool in the suite — a software effort estimator.

**Tagline:** *AI tools built by craftspeople, for craftspeople.*

---

## Project structure

```
operai/
├── estimai-ui/          # React + Vite frontend (this repo)
│   ├── src/
│   │   ├── components/
│   │   │   ├── ActivityTable.jsx    # TanStack Table — Detail grid
│   │   │   ├── SummaryTable.jsx     # TanStack Table — Summary grid
│   │   │   ├── MetricsBar.jsx       # Top KPI strip
│   │   │   ├── ParametersPanel.jsx  # Model parameters tab
│   │   │   └── Header.jsx           # Project name, author, export
│   │   ├── hooks/
│   │   │   └── useEstimator.js      # All estimation computation logic
│   │   ├── utils/
│   │   │   └── export.js            # XLSX export via SheetJS
│   │   ├── EstimatorApp.jsx         # Top-level layout + state
│   │   └── main.jsx
│   ├── CLAUDE.md
│   ├── package.json
│   └── vite.config.js
│
└── estimai-api/         # Spring Boot + Kotlin backend (separate repo)
    ├── src/main/kotlin/
    │   └── com/welld/operai/estimai/
    │       ├── estimate/            # Estimate domain
    │       ├── release/             # Release domain
    │       ├── activity/            # Activity domain
    │       └── user/                # User/auth domain
    └── build.gradle.kts
```

---

## Tech stack

### Frontend (estimai-ui)
- **Runtime:** Node 22 via mise
- **Package manager:** pnpm
- **Framework:** Vite + React 18
- **Tables:** TanStack Table v8
- **Export:** SheetJS (xlsx)
- **Fonts:** DM Sans, DM Mono, Syne (Google Fonts)
- **Styling:** CSS-in-JS via inline styles + CSS variables (no external UI library)
- **Deploy:** Vercel (auto-deploy on push to `main`)

### Backend (estimai-api)
- **Language:** Kotlin
- **Framework:** Spring Boot 3.x
- **Database:** PostgreSQL
- **Build:** Gradle (Kotlin DSL)
- **Deploy:** Railway (EU region — data residency requirement)

---

## Estimation model

All computation lives in `src/hooks/useEstimator.js`. Do not duplicate logic in components.

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

AI-assisted M/D   = Expected × (1 − AI Productivity Gain)   [per activity]
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

## API contract (estimai-api)

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

Authentication: JWT (Spring Security). Auth provider TBD (Keycloak or Spring Authorization Server).

---

## Data residency

wellD operates across Italy and Switzerland. Some clients are in regulated sectors
(energy, finance, healthcare). Apply these rules:

- Backend **must** deploy to an EU region (Railway EU, Fly.io fra, Azure Switzerland North)
- No estimate data should be logged by the hosting provider beyond standard access logs
- The frontend is purely client-side — no estimate data is transmitted except to the estimai-api

---

## Development conventions

### Git
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/`
- Commit style: Conventional Commits (`feat: add AI cost column to summary`)
- `main` is always deployable

### Frontend
- **All files must be TypeScript** (`.ts` or `.tsx`) — never create `.js` or `.jsx` files
- Computation logic belongs in `useEstimator.ts` — never in components
- Components receive data and callbacks as props; they do not compute
- CSS variables defined in the root `<style>` block in `EstimatorApp.tsx`; do not add
  external CSS files unless introducing a proper CSS module setup
- All numbers displayed to the user must be rounded (`.toFixed()` or `Math.round()`)

### Backend
- Follow standard Spring Boot package-by-feature structure
- Use Kotlin data classes for DTOs; no `@Data` Lombok
- All DB access via Spring Data JPA repositories
- Flyway for migrations — never modify existing migration files
- Return `Problem` (RFC 7807) for all error responses

### Both
- No hardcoded strings that appear in the UI — use constants or i18n from day one
  (the tool will need Italian and English at minimum)
- Dates and durations always in ISO 8601 in API contracts; display formatting is a UI concern

---

## Running locally

### Frontend
```bash
cd estimai-ui
mise use node@22      # first time only
pnpm install
pnpm dev              # http://localhost:5173
```

### Backend
```bash
cd estimai-api
./gradlew bootRun     # http://localhost:8080
```

Requires a local PostgreSQL instance. Copy `.env.example` to `.env` and fill in credentials.

### Both together
```bash
# Terminal 1
cd estimai-api && ./gradlew bootRun

# Terminal 2
cd estimai-ui && pnpm dev
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