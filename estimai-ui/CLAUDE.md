# Operai — EstimAI UI

Internal toolsuite by **wellD** (wellD.ch) for AI-assisted software consulting workflows.
EstimAI is the first tool in the suite — a software effort estimator.

**Tagline:** *AI tools built by craftspeople, for craftspeople.*

---

## Project structure

```
estimai-ui/
├── src/
│   ├── components/
│   │   ├── ActivityTable.tsx    # TanStack Table — Detail grid
│   │   ├── SummaryTable.tsx     # TanStack Table — Summary grid
│   │   ├── MetricsBar.tsx       # Top KPI strip
│   │   ├── ParametersPanel.tsx  # Model parameters tab
│   │   └── Header.tsx           # Project name, author, export
│   ├── context/
│   │   └── EstimatorContext.tsx # Global state + localStorage persistence
│   ├── hooks/
│   │   └── useEstimator.ts      # All estimation computation logic
│   ├── types.ts                 # Shared TypeScript interfaces
│   ├── EstimatorApp.tsx         # Top-level layout + state
│   └── main.tsx
├── CLAUDE.md
├── package.json
└── vite.config.js
```

---

## Tech stack

- **Runtime:** Node 22 via mise
- **Package manager:** pnpm
- **Framework:** Vite + React 18
- **Tables:** TanStack Table v8
- **Export:** SheetJS (xlsx)
- **Fonts:** DM Sans, DM Mono, Syne (Google Fonts)
- **Styling:** tailwindcss
- **Deploy:** Vercel (auto-deploy on push to `main`)

---

## Estimation model

All computation lives in `src/hooks/useEstimator.ts`. Do not duplicate logic in components.

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

Use these terms consistently in code, UI copy, and API calls:

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

Authentication: JWT (Spring Security). Dates always ISO 8601.

---

## Development conventions

### Git
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/`
- Commit style: Conventional Commits (`feat: add AI cost column to summary`)
- `main` is always deployable

### Code
- **All files must be TypeScript** (`.ts` or `.tsx`) — never create `.js` or `.jsx` files
- Computation logic belongs in `useEstimator.ts` — never in components
- Components receive data and callbacks as props; they do not compute
- CSS variables defined in the root `<style>` block in `EstimatorApp.tsx`; do not add
  external CSS files unless introducing a proper CSS module setup
- All numbers displayed to the user must be rounded (`.toFixed()` or `Math.round()`)
- No hardcoded strings that appear in the UI — use constants or i18n from day one
  (the tool will need Italian and English at minimum)

---

## Running locally

```bash
mise use node@22      # first time only
pnpm install
pnpm dev              # http://localhost:5173
```
