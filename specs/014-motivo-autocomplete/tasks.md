---
spec: 014
generated: 2026-08-11
---

# Tasks: Motivo autocomplete from the employee's own past mileage lines

Derived from `plan.md` (approved 2026-08-11) and `design.md`. Two tracks — `refund-api`
(T2–T6) and `refund-ui` (T7–T14) — are dependency-independent of each other once **T1**
lands, and run in parallel. T1 is the shared foundation: the fold and its canonical vectors
are mirrored across both apps (ADR-0025's precedent), so both tracks consume it.

**No schema change, no migration, no new index, no `auth`/catalog change** (plan `## Data
model`, D4). A task proposing one is drift — stop and re-plan.

- [x] T1: Implement `normaliseMotivo` + its canonical test vectors (shared foundation) — refs: AC-1.4, AC-2.1, AC-2.5 — deps: none
  - touch: `refund-api/src/requests/normaliseMotivo.ts`, `refund-api/src/requests/normaliseMotivo.test.ts`
  - The fold from plan D3: trim, collapse internal whitespace runs to one space, lowercase, strip accents (Unicode NFD + combining-mark removal). Pure, no I/O, no Prisma.
  - Export the canonical vector table (input → folded output) as a named export so T8 can assert the **identical** table in `refund-ui` — this is the ADR-0025 mirrored-rule pattern, not a copy-paste.
  - done when: `cd refund-api && bun test normaliseMotivo` passes, covering at minimum `"Milano  →  LUGANO "`, `"milano → lugano"`, `"Milano → Lugàno"` all folding to one identical string, plus an empty/whitespace-only input.

- [x] T2: Define the `GET /line-suggestions` zod-openapi query + response schemas — refs: AC-1.7, AC-2.3, AC-4.3 — deps: T1
  - touch: `refund-api/src/requests/suggestions.schemas.ts`
  - Query: `z.object({ type: z.enum(['travel_km']) })` — a single-member enum on purpose (plan `## API contracts`); **no other parameter may exist**, since a caller-controlled selector is exactly what AC-4.3 forbids. Response per the plan: `{ type, suggestions: TripSuggestion[] }` with `motivo`, `normalisedMotivo`, `km`, `entity`, `count`, `lastUsedOn` (`YYYY-MM-DD`).
  - done when: `bun run typecheck` passes in `refund-api` and a schema unit test asserts an unknown query key is rejected and that no field on the query schema can address another subject.

- [x] T3: Implement the suggestions repository query — refs: AC-2.1, AC-2.2, AC-2.4, AC-2.6, AC-4.1 — deps: T1
  - touch: `refund-api/src/requests/suggestions.repo.ts`
  - Prisma `groupBy` on `(motivo, km, entity)` with `_count` + `_max(date)`, filtered `type='travel_km'` and `date >= cutoff` (24 months, UTC, per request), scoped to requests whose `ownerUserId` is the verified JWT `sub`. **Scope must come from the verified `sub` only — never from any input.** No status filter (AC-2.6 — every status, including `draft`). `take: 2000`. Effect-wrapped with `DatabaseError`, matching `requests.repo.ts`.
  - done when: `bun run typecheck` passes and the query compiles against the existing Prisma client with no schema change (`git diff --exit-code refund-api/prisma/` is clean).

- [x] T4: Implement the fold-merge, ranking and cap service — refs: AC-2.1, AC-2.2, AC-2.3, AC-2.5, AC-1.5 — deps: T1, T3
  - touch: `refund-api/src/requests/suggestions.service.ts`, `refund-api/src/requests/suggestions.service.test.ts`
  - Pure — no DB, no Hono. Merge exact `(motivo, km, entity)` triples into trip signatures keyed on the **folded** motivo (so case/accent/whitespace variants merge, AC-2.1) while carrying the **most recent line's verbatim motivo** as the display text (AC-2.5). Rank `count` desc → `lastUsedOn` desc → `normalisedMotivo` asc → `km` asc → `entity` asc (total, deterministic — plan D8). Cap at 200.
  - done when: `bun test suggestions.service` passes, including: variants merging into one signature with the right count; same motivo + different km staying separate; the full tiebreak order pinned; and a >200-signature input capped to exactly 200 with the highest-ranked retained.

- [x] T5: Wire the route, authz gate and registration — refs: AC-4.1, AC-4.2, AC-4.3 — deps: T2, T4
  - touch: `refund-api/src/requests/suggestions.routes.ts`, `refund-api/src/index.ts`, `refund-api/src/openapi/registry.ts`
  - `OpenAPIHono` router: `jwtMiddleware` → `authzMiddleware` → **existing `request:read`** capability check (no new catalog permission — ADR-0042). The handler **ignores the resolved grant's conditions** and scopes unconditionally to `sub`, so a widest-wins unconditioned `request:review` can never widen the read (ADR-0042). `defaultHook` → **400** for query-validation failure (matching `rates/effective.routes.ts`, not `linesRouter`'s 422). Capability absent → **403**, never 404. Sets `Cache-Control: no-store`. New `Suggestions` OpenAPI tag.
  - **Register at TOP LEVEL, not under `/requests/…`** — `requestsRouter` is registered first and `GET /requests/{id}` would swallow `/requests/line-suggestions` as `id="line-suggestions"`.
  - done when: `bun run typecheck` passes; the route resolves at `GET /line-suggestions` (not 404) in a route-integration test; and a request with no `request:read` grant returns 403.

- [x] T6: Integration tests for the endpoint against real Postgres — refs: AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-1.7, AC-4.1, AC-4.2, AC-4.3, AC-4.4 — deps: T5
  - touch: `refund-api/src/requests/suggestions.routes.test.ts`
  - Real Hono app against the compose Postgres, `jwtMiddleware`/`resolveClient` mocked via `src/test-support/testAuth.ts`, cleaned with `truncateRefundTables()`. Per the plan's AC→test table: cross-owner isolation (A never sees B, and B never inflates A's counts); a caller holding **global-scope `request:review`** still gets only their own lines (AC-4.2); the resolve-fixture matrix for AC-4.3 (403 not 404 when `request:read` is absent); all five statuses contributing (AC-2.6); a 25-month-old line absent **and** not inflating an in-window group's count vs a 23-month-old line present (AC-2.4); verbatim-vs-folded motivo (AC-2.5).
  - AC-4.4: assert row counts of `refund_line`/`refund_request`/`refund_audit_entry`/`refund_setting`/`mileage_rate` are identical before and after the call, and that captured console output during the call contains no motivo text.
  - done when: `cd refund-api && bun test suggestions` passes green with the stack up (`docker compose up -d postgres`).

- [x] T7: Let `getJson` forward a `RequestInit` (additive) — refs: AC-5.2 — deps: none
  - touch: `refund-ui/src/lib/refundApi.ts`
  - Add an optional second parameter `init?: RequestInit`, forwarded to `apiFetch` (which already forwards to `fetch`). Purely additive — **every existing caller must remain unchanged and untouched**. This is what lets an `AbortSignal` reach the fetch.
  - done when: `cd refund-ui && pnpm build` passes (tsc) and `pnpm test refundApi` is green with no existing call site modified (`git diff` touches only the signature and its docblock).

- [x] T8: Mirror the fold + implement query matching in the UI — refs: AC-1.4, AC-1.5, AC-2.1 — deps: T1
  - touch: `refund-ui/src/lib/tripSuggestions.ts`, `refund-ui/src/lib/tripSuggestions.test.ts`
  - `normaliseMotivo` (identical semantics to T1), `queryQualifies` (≥2 non-whitespace characters), `matchTripSuggestions(corpus, query, limit)` — folds the **query only** (the corpus arrives pre-folded as `normalisedMotivo`), substring `includes` match (anywhere, not prefix — AC-1.4), order-preserving, `slice(0, 8)`.
  - Assert **T1's exact canonical vector table** here (ADR-0025 mirrored rule + shared vectors). A divergence between the two folds is the failure mode this task exists to prevent.
  - done when: `pnpm test tripSuggestions` passes, including `"lug"`/`"LUG"`/`"lùg"` all matching mid-string in `"Milano → Lugano client visit"`, `"xyz"` matching nothing, a 30-match corpus returning exactly 8, and the shared vector table asserting identically to T1's.

- [x] T9: Implement the suggestions API client — refs: AC-5.2 — deps: T2, T7
  - touch: `refund-ui/src/lib/suggestionsApi.ts`, `refund-ui/src/lib/suggestionsApi.test.ts`
  - `getTripSuggestions(signal: AbortSignal): Promise<TripSuggestion[]>` calling `GET /line-suggestions?type=travel_km`, plus the `TripSuggestion` type matching T2's wire shape.
  - done when: `pnpm test suggestionsApi` passes, asserting the signal reaches the fetch and that a non-2xx response rejects (the swallow happens in T11, not here — this layer stays honest).

- [x] T10: Add the `components.motivoSuggest` copy namespace — refs: AC-5.7, AC-1.7 — deps: none
  - touch: `refund-ui/src/strings.ts`
  - The six keys from `design.md`: `listboxLabel`, `available(count)`, `km(km)`, `usage(count, lastUsed)`, `optionLabel(motivo, km, entity, count, lastUsed)`, plus `pages.requestDetail.composer.suggestionApplied(motivo, km, entity)`. **English only**, under the existing namespaced key-path convention, typed against the exported `Strings` type (AC-5.7 as amended 2026-08-11).
  - **No empty-state, error, or loading string may be added** — AC-1.6 and AC-5.2 forbid those surfaces; a string for them would be a spec violation.
  - done when: `pnpm build` passes (the `Strings` type still infers) and no key exists for an error/empty/loading state.

- [x] T11: Build the `MotivoSuggestField` combobox — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.5, AC-1.6, AC-1.7, AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-5.6 — deps: T8, T9, T10
  - touch: `refund-ui/src/components/MotivoSuggestField.tsx`
  - Renders the Motivo `<input>` plus the suggestion listbox. Owns: corpus state (**memory only — never `localStorage`/`sessionStorage`/IndexedDB**, ADR-0001 posture extended to personal data), the lazy fetch (first crossing of the 2-char threshold, 150 ms debounce, **not** on mount), `AbortController` + a monotonic request-token guard so a slow early response can never overwrite a fast later one, a 5 s timeout, keyboard navigation, and the full ARIA wiring from `design.md` (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`, `aria-activedescendant`, `role="listbox"`/`role="option"`).
  - `enabled=false` → renders an **identical** input with no combobox roles and never fetches (AC-1.1). Open state is the single derived boolean from `design.md`, so "no list" is never an error branch: `open = enabled && !disabled && focused && !suppressed && queryQualifies(value) && matches.length > 0`.
  - **Every** failure (network, 400, 403, 503, timeout, abort) is swallowed in `.catch()` → empty corpus, no list, **no toast/banner/alert/role="alert"** (AC-5.2), and must never propagate to the composer's error state.
  - Carry `design.md`'s re-open-after-pick fix: `suppressed` is set by a pick and cleared **only** from the input's own `onChange` — otherwise the list re-opens on the motivo the pick just wrote and AC-3.5 fails.
  - Options are `<li>`, never `<button>`. If matched-substring highlighting is implemented, it must **not** use `dangerouslySetInnerHTML` (motivo is user-controlled free text).
  - done when: `pnpm build` passes and `pnpm test MotivoSuggestField` is green for the enabled/disabled render split, the debounce-and-single-fetch behaviour, and each swallowed failure mode producing no alert node.

- [x] T12: Wire the field into `ExpenseLineComposer` — refs: AC-1.1, AC-1.8, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.5, AC-3.6, AC-3.7, AC-5.3, AC-5.4 — deps: T11
  - touch: `refund-ui/src/components/ExpenseLineComposer.tsx`
  - Replace the raw Motivo `<input>` with `<MotivoSuggestField enabled={showKm} …>`, keeping the **same `id="composer-motivo"` and `data-testid`**, as **one** JSX node across both branches so React preserves the DOM node and focus when the type changes.
  - `onPick` sets `{ motivo, km: String(km), entity }` in **one atomic `setDraft`** (AC-3.1/3.4 — overwrite, not fill-if-empty). Date untouched (AC-3.2). Nothing saved (AC-3.7). `MileageAmountField` re-derives on its own from `(entity, date, km)` — no new wiring (AC-3.5). Announce the pick through the **existing** `composer-km-status` polite region.
  - **The Enter trap (highest-risk line in the feature):** Enter on a highlighted option must call `preventDefault()` so implicit form submission does not fire in the same event — otherwise a complete draft posts a line carrying the **pre-pick km and entity** under the new motivo: wrong money, no error. `preventDefault()` on exactly that one branch; the `active === -1` branch must behave exactly as today (AC-5.4).
  - `ExpenseLineRow.tsx` stays **untouched** — AC-1.8 is satisfied structurally.
  - done when: `pnpm build` passes, `git diff --exit-code refund-ui/src/components/ExpenseLineRow.tsx` is clean, and a component test proves Enter-on-highlight picks without calling `onAdd`.

- [x] T13: Component tests for the composer + field behaviour — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-3.5, AC-3.6, AC-3.7, AC-5.1, AC-5.2, AC-5.3, AC-5.4, AC-5.5, AC-5.6 — deps: T12
  - touch: `refund-ui/src/components/MotivoSuggestField.test.tsx`, `refund-ui/src/components/ExpenseLineComposer.test.tsx` (extend)
  - Implement the plan's AC→test table at ui-comp level. Non-obvious ones that must not be skipped: AC-1.3's three cases (`"l"`, `""`, `"   "`); AC-1.6 asserting **no** `role="alert"`/`role="status"` message; AC-1.8 typing in `row-{id}-motivo` triggering no fetch; AC-3.3 asserting no `composer-currency`/`composer-amount` node exists post-pick; AC-3.5 asserting the mocked `getEffectiveRate` is re-invoked with the picked entity; AC-5.3/5.4 tested **as a pair** on `onAdd`; AC-5.6 asserting the polite region's text changes with option count and is **empty** on no-match.
  - done when: `cd refund-ui && pnpm test` is green and every AC listed above has at least one named assertion.

- [x] T14: Port the no-hardcoded-strings guard to `refund-ui` — refs: AC-5.7 — deps: T10, T12
  - touch: `refund-ui/src/lib/noHardcodedStrings.test.ts`
  - Port `estimai-ui`'s equivalent, scoped at minimum to the files this feature adds/changes: every non-technical user-facing literal must come from `strings.ts`.
  - done when: `pnpm test noHardcodedStrings` passes and fails if a literal is reintroduced into `MotivoSuggestField.tsx` (verify by temporarily inlining one).

- [ ] T15: End-to-end journey through the shell — refs: AC-3.7, AC-5.1, AC-5.2, AC-5.6 — deps: T5, T12
  - touch: `shell/e2e/motivo-autocomplete.spec.ts`
  - **In `shell/e2e/`, never in `refund-ui`** — a federated remote has no standalone authed bootstrap. Seed a refund employee via `helpers/refundFixtures.ts`'s `grantRefundEmployee`, seed ≥3 past mileage lines through the real API, open a new draft, choose Travel by car, type 3 characters, assert the list, navigate and pick **by keyboard only** (AC-5.6), assert the three filled fields and the recomputed amount, add the line (AC-3.7). Then `page.route('**/line-suggestions*').abort()` and assert the composer still works with no error surface (AC-5.2).
  - done when: `cd shell && pnpm e2e motivo-autocomplete.spec.ts` passes with the stack up (`mise run dev`).

- [ ] T16: Record the changeset — refs: none (release hygiene; required by CI) — deps: T6, T13, T14
  - touch: `.changeset/*.md`
  - `mise run changeset` selecting **both** `@operai/refund-api` and `@operai/refund-ui` in ONE changeset (they are not npm-linked, so a cross-app change must name both), minor for each — a new user-facing capability plus a new endpoint.
  - done when: `mise run changeset:check` passes against `main`.

- [ ] T17: All gates green, spec → done — refs: all — deps: T6, T13, T14, T15, T16
  - touch: `specs/014-motivo-autocomplete/spec.md` (frontmatter only)
  - `cd refund-api && bun run typecheck && bun test`; `cd refund-ui && pnpm lint && pnpm build && pnpm test`; `cd shell && pnpm e2e motivo-autocomplete.spec.ts`. QE verdict PASS, owasp-reviewer findings below medium, and eval PASS (production tier).
  - done when: every task above is checked, the commands above are green, and `spec.md` reads `status: done` + `done: <date>` — set via `/wellforge:done`, never by hand.

## Coverage mapping

Every AC is served by ≥1 task; every task serves ≥1 AC (T16 excepted and flagged: release
hygiene required by CI, carrying no AC).

| AC | Tasks | AC | Tasks |
|---|---|---|---|
| AC-1.1 | T11, T12, T13 | AC-3.1 | T12, T13 |
| AC-1.2 | T11, T13 | AC-3.2 | T12, T13 |
| AC-1.3 | T11, T13 | AC-3.3 | T12, T13 |
| AC-1.4 | T1, T8 | AC-3.4 | T12, T13 |
| AC-1.5 | T4, T8, T11, T13 | AC-3.5 | T11, T12, T13 |
| AC-1.6 | T11, T13 | AC-3.6 | T12, T13 |
| AC-1.7 | T2, T6, T10, T11, T13 | AC-3.7 | T12, T13, T15 |
| AC-1.8 | T12, T13 | AC-4.1 | T3, T5, T6 |
| AC-2.1 | T1, T3, T4, T6, T8 | AC-4.2 | T5, T6 |
| AC-2.2 | T3, T4, T6 | AC-4.3 | T2, T5, T6 |
| AC-2.3 | T2, T4, T6 | AC-4.4 | T6 |
| AC-2.4 | T3, T6 | AC-5.1 | T13, T15 |
| AC-2.5 | T1, T4, T6 | AC-5.2 | T7, T9, T11, T13, T15 |
| AC-2.6 | T3, T6 | AC-5.3 | T11, T12, T13 |
| | | AC-5.4 | T11, T12, T13 |
| | | AC-5.5 | T11, T13 |
| | | AC-5.6 | T11, T13, T15 |
| | | AC-5.7 | T10, T14 |

## Parallelism

```
T1 ─┬─► T2 ─┐
    │       ├─► T5 ─► T6 ──────────────┐
    ├─► T3 ─┴─► T4 ─┘                  │
    │                                  ├─► T16 ─► T17
    └─► T8 ─┐                          │
T7 ────────►├─► T9 ─┐                  │
T10 ───────►└───────┴─► T11 ─► T12 ─┬─► T13 ─┤
                                    ├─► T14 ─┤
                                    └─► T15 ─┘
```

**Batch 1 (parallel):** T1 · T7 · T10 — no mutual deps.
**Batch 2 (parallel, two tracks):** backend T2→T3→T4→T5→T6 · frontend T8→T9→T11→T12→T13/T14.
**Batch 3:** T15 (needs both tracks) · then T16 · then T17.
