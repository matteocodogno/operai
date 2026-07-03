---
spec: 001
generated: 2026-07-03
---

# Tasks: Estimate persistence API

estimai-api (BE) track and estimai-ui (FE) track run largely in parallel after their
roots; the e2e tasks converge once both are up. New UI components come from `design.md`.

> 2026-07-03: implementation started (spec → in-progress) with the two parallel roots
> T1 (estimai-api scaffold) + T7 (estimatesApi client).

- [x] T1: Scaffold the estimai-api service skeleton — refs: enabling infra (US-1..5) — deps: none
  - touch: `estimai-api/` (new): `package.json`, `src/index.ts`, `src/lib/{env,db,errors}.ts`, `src/health/health.routes.ts`, `src/openapi/registry.ts`, `tsconfig.json`, `.env.example`
  - done when: cloning the `auth` skeleton (Bun + Hono + `@hono/zod-openapi`, zod env
    validation with `process.exit(1)`, Prisma client in `src/lib/db.ts`, RFC 7807
    `app.onError`/`app.notFound`, CORS with `ALLOWED_ORIGINS`), `bun run typecheck` is
    clean and `GET /health` returns 200 against the compose Postgres

- [x] T2: Prisma schema + init migration for the `estimate` table — refs: enabling infra for AC-1.1, AC-2.1 — deps: T1
  - touch: `estimai-api/prisma/schema.prisma`, `estimai-api/prisma/migrations/*`
  - done when: `estimate` model has `id`, `userId`, `name`, `author`, `sizeBytes`,
    `content Json`, `createdAt`, `updatedAt` + `@@index([userId, updatedAt(sort: Desc)])`;
    `prisma migrate` applies cleanly to a fresh DB and the client generates

- [x] T3: JWT resource-server middleware — refs: US-4, AC-4.2 — deps: T1
  - touch: `estimai-api/src/auth/jwt.middleware.ts`, `src/auth/jwt.middleware.test.ts` (new), `src/lib/env.ts` (add `AUTH_JWKS_URL`, `AUTH_ISSUER`)
  - done when: bun tests assert a valid RS256 JWT (correct issuer, `operai-auth-rs256-v1`
    kid) passes and sets `userId=sub`/`email`; missing/malformed/expired/wrong-issuer/
    wrong-alg → 401 Problem; no DB access occurs for unauthenticated requests. Uses
    `jose createRemoteJWKSet` (cached, RS256+issuer pinned)

- [x] T4: Estimate CRUD endpoints, ownership-scoped — refs: US-1,2,3,4, AC-1.1, AC-1.2, AC-2.1, AC-2.2, AC-2.3, AC-3.1, AC-4.1 — deps: T2, T3
  - touch: `estimai-api/src/estimates/{estimates.routes,estimates.repo,estimates.schemas}.ts` (new), `src/index.ts`
  - done when: bun integration tests (real compose Postgres) prove: `POST` then
    `GET /estimates/{id}` deep-equals `content`+name/author (AC-1.1); `PUT` updates in
    place with no duplicate and advances `updatedAt` (AC-1.2); `GET /estimates` returns
    only the caller's items with name+updatedAt (AC-2.1) and `[]` for a fresh user
    (AC-2.3); `DELETE` → 204 then `GET/{id}` → 404 (AC-3.1); every query scoped by
    `userId=sub`, cross-user `GET/PUT/DELETE/{id}` → 404 (AC-4.1)

- [x] T5: Per-estimate size guard — refs: AC-1.4 — deps: T4
  - touch: `estimai-api/src/estimates/estimates.routes.ts`, `src/lib/env.ts` (add `MAX_ESTIMATE_BYTES`, default 1048576)
  - done when: bun tests assert content over `MAX_ESTIMATE_BYTES` on `POST`/`PUT` → 413
    Problem with nothing persisted (prior version intact); in-limit → 201/200; a Hono
    body-size limit caps the request; a loop creating many estimates confirms no count cap

- [ ] T6: Bulk import endpoint — refs: US-5, AC-5.2, AC-5.4 — deps: T4, T5
  - touch: `estimai-api/src/estimates/estimates.routes.ts`, `estimates.repo.ts`, `estimates.schemas.ts`
  - done when: bun tests assert `POST /estimates/import` imports each element in its own
    transaction under the caller's `userId`; a batch with one over-size/invalid element
    returns `results` marking that element `failed` and the others `imported` (AC-5.4),
    imported content round-trips deep-equal (AC-5.2); the endpoint returns 200 for a
    well-formed request regardless of per-element outcome

- [x] T7: estimatesApi client + env — refs: US-1,2,3,5 (client) — deps: none
  - touch: `estimai-ui/src/lib/estimatesApi.ts` (new), `estimai-ui/.env.example`, `estimai-ui/src/lib/estimatesApi.test.ts` (new)
  - done when: typed `create/list/get/update/remove/import` wrappers call
    `apiFetch(`${import.meta.env.VITE_API_URL}/estimates…`)` with correct method/body;
    vitest (mocking `apiFetch`) asserts request shapes and Problem-error handling; no
    hardcoded API URL; `pnpm build` typechecks

- [x] T8: Rewire estimates list to the API — refs: AC-2.1, AC-2.3 — deps: T7
  - touch: `estimai-ui/src/pages/EstimatesPage.tsx`, `estimai-ui/src/components/SkeletonListRows.tsx` (new)
  - done when: the list loads from `estimatesApi.list` with a `SkeletonListRows` loading
    state and the existing empty state on `[]`; vitest asserts loading → rows, and empty
    state with no error when the API returns `[]`

- [x] T9: Rewire estimate load + auto-save to the API — refs: AC-1.1, AC-1.2, AC-1.3, AC-2.2 — deps: T7
  - touch: `estimai-ui/src/pages/EstimatePage.tsx`, `estimai-ui/src/router.tsx` (loader), `estimai-ui/src/context/EstimatorContext.tsx`, `estimai-ui/src/components/ToastBanner.tsx` (new)
  - done when: opening an estimate loads its content from `estimatesApi.get` (no blank
    flash) and computed values match the model (AC-2.2); the auto-save effect switches to
    a debounced `PUT` (create-then-update, last-write-wins); on save failure the effect
    keeps in-memory state and surfaces a `ToastBanner` without clearing/overwriting
    (AC-1.3); vitest covers load, save-calls-PUT, and failure-preserves-state

- [x] T10: Delete with an accessible confirm — refs: AC-3.1, AC-3.2 — deps: T7, T8
  - touch: `estimai-ui/src/components/ConfirmDeleteModal.tsx` (new), `estimai-ui/src/pages/EstimatesPage.tsx`
  - done when: component tests assert confirm → `estimatesApi.remove` then list refresh
    (AC-3.1); decline → no API call, item still present (AC-3.2); modal traps focus with
    Cancel as default focus, Esc = Cancel; per-row delete has `aria-label`

- [ ] T11: Size-limit rejection UX — refs: AC-1.4 (client) — deps: T9
  - touch: `estimai-ui/src/context/EstimatorContext.tsx`, `estimai-ui/src/components/ToastBanner.tsx`
  - done when: vitest asserts a 413 from save surfaces a clear human-readable
    `ToastBanner` message and the editor's in-memory estimate is unchanged (nothing lost)

- [x] T12: Import-offer modal + flow — refs: US-5, AC-5.1, AC-5.2, AC-5.3, AC-5.4 — deps: T7
  - touch: `estimai-ui/src/components/ImportOfferModal.tsx` (new), `estimai-ui/src/pages/EstimatesPage.tsx` (or a session-load hook), `estimai-ui/src/lib/projects.ts` (read-only import source)
  - done when: on first authenticated load with legacy `estimai_project_*` keys present,
    the offer renders with accept/decline (AC-5.1); decline is remembered for the session
    and not re-shown (AC-5.3) and leaves localStorage untouched; accept runs
    `estimatesApi.import` and shows a per-estimate results table incl. partial failure
    (AC-5.4), removing no local data; component/integration tests cover offer-shown,
    decline-session-remembered, and the results table

- [ ] T13: e2e — persistence journey — refs: AC-1.1, AC-2.1, AC-2.2, AC-3.1 — deps: T4, T8, T9, T10
  - touch: `estimai-ui/e2e/persistence.spec.ts` (new)
  - done when: `pnpm e2e` (against live estimai-api + auth + Postgres, seeded session)
    signs in, creates/saves an estimate, reloads and sees it in the list, reopens it with
    matching content, deletes it and confirms it is gone

- [ ] T14: e2e — JWKS identity + real-401 (closes the 002 eval gaps) — refs: AC-3.2-equiv, AC-4.1, AC-4.2 — deps: T3, T4, T9
  - touch: `estimai-ui/e2e/auth-identity.spec.ts` (new), or an estimai-api integration test
  - done when: `T-JWKS-identity` proves a real JWT verified against the live JWKS resolves
    the correct user (user A's token reaches only A's data; B's cannot — AC-4.1); and
    `T-real-401` drives `apiFetch` against a genuine estimai-api 401 and asserts the
    ADR-0001 refresh-retry-then-redirect circuit fires against a real backend 401

- [ ] T15: e2e — import journey — refs: US-5, AC-5.1, AC-5.2, AC-5.4 — deps: T6, T12, T13
  - touch: `estimai-ui/e2e/import.spec.ts` (new)
  - done when: `pnpm e2e` seeds legacy localStorage estimates, signs in, accepts the
    import offer, and asserts each estimate appears in the account with matching content;
    a batch with one bad element shows the partial-failure report and removes no local data

- [ ] T16: devops — estimai-api deploy + local wiring — refs: data-residency constraint — deps: T1
  - touch: `compose.yaml` (or estimai-api compose entry), estimai-api deploy config, `estimai-api/.env.example`
  - done when: estimai-api runs locally against the compose Postgres; the deploy config
    explicitly names an EU region (Railway EU) and disables request-body logging; a check
    confirms no estimate `content` is written to application logs

- [ ] T17: Close-out — gates green, spec done — refs: closing task — deps: T1–T16
  - touch: `specs/001-estimate-persistence/spec.md`
  - done when: estimai-api `bun run typecheck` + `bun test` pass; estimai-ui `pnpm lint`,
    `pnpm build`, `pnpm test`, `pnpm e2e` pass; every task above is checked; then
    `/wellforge:eval` PASS gates the spec status → `done` (production tier)
