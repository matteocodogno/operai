---
spec: 007
generated: 2026-07-16
---

# Tasks: Refund service (Rimborsi)

Derived from the approved `plan.md` + `design.md`. Tracks: **S** cross-service seams
(auth / notify-api), **R** refund-api, **U** refund-ui, **D** devops, **V** verification.
Tasks with no mutual `deps:` may run in parallel (typically the S-seams, the refund-api
bootstrap, and the refund-ui foundation all start independently).

Conventions carried into every task: TypeScript only; Bun+Hono+Prisma+Effect+RFC-7807 for
services (mirror `estimai-api`); amounts are integer **cents**, currency derived from entity;
ownership scoped to JWT `sub`; record-level denial → 404, capability-absent → 403; all UI
copy sourced from a centralized strings module (English-only for v1, no hardcoded strings).

---

## Cross-service seams (start first — the plan flags these as load-bearing)

- [x] T1: Add Bearer-authed `GET /authz/resolve` to the `auth` service — refs: AC-5.4, AC-6.4, AC-7.5 (enables server-side authz) — deps: none
  - touch: `auth/src/authz/authz.routes.ts` (or a new `resolve.routes.ts`), `auth/src/authz/resolver.ts`, `auth/src/index.ts`, OpenAPI registry
  - Returns the **caller's own** resolution only (same guard as `/authz/me`), authenticated by the RS256 Bearer JWT (verify own issuer/aud/alg, no session cookie): `{ sub, epoch, permissions[<resource,action,conditions>], entity, jobTitle }`. Adds the caller's own `entity`/`jobTitle` so a resource server can evaluate `match:"user"` conditions locally.
  - done when: an integration test proves a valid Bearer token returns the caller's permissions + entity; a token for user A can never return user B's resolution; missing/invalid/wrong-aud token → 401; `bun test` + `bun run typecheck` green in `auth`.

- [x] T2: Declare refund's real permission catalog + seed accounting grants in `auth` — refs: AC-1.1, AC-5.4, AC-7.5, AC-8.2 — deps: none
  - touch: `auth/src/authz/catalogs/refund.ts` (NEW), `auth/src/authz/seed.ts`, `auth/src/authz/seed.test.ts`
  - Move `refund` out of the access-only `SUITE_APPS` stub; register the full catalog (`refund:access`; `request` resource actions `create`/`read`[ownership]/`review`[entity]/`set-approved-total`[entity]/`approve`[entity]/`reject`[entity]). Seed the `accounting` role with the review/decision grants under the entity condition `{attributes:[{key:"entity",match:"user"}]}`. Do **not** seed any refund grant onto `employee` (admin-assigned per Gate-2 D2); do **not** seed an `accounting-global` role (D3).
  - done when: `seedRefundCatalog` is idempotent on re-run; a test asserts the catalog actions + supportedConditions and that `accounting` carries the entity-conditioned review grants while `employee` carries none; `bun test` green in `auth`.

- [x] T3: Add internal `POST /system/notifications` to `notify-api` (cross-user in-app push) — refs: AC-3.6 — deps: none
  - touch: `notify-api/src/system/` (new route mirroring `/system/emails`), `notify-api/src/index.ts`, env validation, tests
  - Internal-token authenticated (`NOTIFY_INTERNAL_TOKEN`, constant-time compare, ≥32 chars); body `{ recipientId, originApp, severity, title, body, link{href} }`; routes through the existing `inAppChannel.send` (persist + SSE push to `recipientId`). Never accepts a user JWT; `/notifications` never accepts the internal token (ADR-0011 invariant).
  - done when: an integration test pushes a notification to an arbitrary `recipientId` with a valid token and sees it persisted + fanned out; a request without/with a wrong token → 401; `bun test` + `bun run typecheck` green in `notify-api`.

## refund-api (new resource server)

- [x] T4: Bootstrap the `refund-api` service skeleton — refs: (foundation for all R tasks) — deps: none
  - touch: `refund-api/` NEW — `package.json`, `tsconfig`, `src/index.ts`, `src/lib/{env,db,errors,logger}.ts`, `src/auth/jwt.middleware.ts` (JWKS + `iss` + `aud`/`AUTH_AUDIENCE`), `src/openapi/registry.ts`, `src/health/`, `.env.example`, `.envrc`
  - Mirror `estimai-api` verbatim: startup env validation (`process.exit(1)` on missing), global RFC-7807 `onError`/`notFound`, Scalar reference, JWKS-verified identity middleware, `AUTH_AUDIENCE` enforced.
  - done when: `bun run dev` boots on :8082; `GET /health` returns ok; a request with no/invalid/wrong-aud Bearer → 401 Problem JSON; `bun run typecheck` + `bun test` (health) green.

- [x] T5: Prisma schema + `0001_init` migration (4 tables, enums, audit immutability) — refs: AC-8.1, AC-8.2, AC-8.3, AC-8.4 — deps: T4
  - touch: `refund-api/prisma/schema.prisma`, `refund-api/prisma/migrations/0001_init/`
  - `RefundRequest`, `RefundLine` (12-type enum, per-line `entity`, `requestedAmountCents:Int`, `km:Int?`, `approvedTotalCents:Int?`), `Attachment` (objectKey unique, uploadStatus), append-only `RefundAuditEntry`. Money as integer cents; no stored currency. Audit immutability via a raw-SQL `CREATE RULE`/trigger blocking UPDATE+DELETE; `RefundAuditEntry.request` `onDelete: Restrict`; lines/attachments `onDelete: Cascade`.
  - done when: `bun run db:migrate` applies cleanly against the local DB; a raw-SQL UPDATE/DELETE on `RefundAuditEntry` is rejected by the trigger (test); deleting a request that has an audit row is refused by the FK (test).

- [x] T6: `authzMiddleware` + local condition evaluation — refs: AC-5.4, AC-6.4, AC-7.5 — deps: T4, T1
  - touch: `refund-api/src/auth/authz.middleware.ts`, `refund-api/src/authz/conditions.ts`, tests
  - Resolves the caller's refund permissions from `auth GET /authz/resolve` (forward Bearer), cache keyed `(sub, perm_epoch)` + 30s TTL backstop; **fail-closed** (503) on auth outage. Sets `c.var.authz = { permissions, entity }`. Provide helpers: `hasCapability(resource,action)`, `ownershipOwn(record, sub)`, and the entity-scope predicate `requestInScope(lines, callerEntity | GLOBAL)` = "≥1 line matches, or unconditioned ⇒ all".
  - done when: unit tests cover the predicate (single-entity match/no-match, mixed-entity ≥1 match, global sees all); an integration test shows a missing capability → 403 and the cache serves a second call without re-hitting auth for the same epoch; auth-down → 503, never 200.

- [x] T7: Employee request-level endpoints (create/list/get/delete draft) — refs: AC-1.1, AC-1.4, AC-2.5, AC-3.1, AC-3.2, AC-3.4, AC-3.5, AC-8.4 — deps: T5, T6
  - touch: `refund-api/src/requests/` (routes, service, repo), OpenAPI
  - `POST /requests` (draft, owner=`sub`), `GET /requests` (own only, `[{id,status,updatedAt,subtotals}]`), `GET /requests/:id` (full detail incl. per-currency `subtotals[]`, never blended), `DELETE /requests/:id` (204 only when `status==draft`, else 409). Non-owner-non-accounting on `/requests/:id` → 404.
  - done when: integration tests prove sub-scoping (foreign request 404 + absent from list), draft-only delete (409 otherwise), and correct per-currency subtotal grouping for a mixed-entity request.

- [x] T8: Expense line endpoints + validation — refs: AC-1.2, AC-1.4, AC-1.6 — deps: T7
  - touch: `refund-api/src/requests/lines.*`, validation schema
  - `POST/PUT/DELETE /requests/:id/lines[/:lineId]` (draft-only → 409 otherwise; ownership 404). Validation (422): `date,type,motivo,requestedAmountCents(≥0 int),entity` required; `km` required & `>0` **iff** `type==travel_km`, rejected if present for any other type.
  - done when: unit + integration tests cover every validation branch (km required/rejected by type, missing-field 422 with offending field named) and draft-only mutation guards.

- [x] T9: Attachments + EU object storage (presigned upload/confirm/delete, signed GET) — refs: AC-1.3, AC-1.7, AC-6.2 — deps: T8
  - touch: `refund-api/src/attachments/`, `refund-api/src/lib/storage.ts` (S3-compatible), env (`REFUND_S3_*`, EU-region allowlist assertion at startup)
  - Two-phase: `POST …/attachments` mints a presigned **POST** (policy caps ≤10 MiB + `pdf`/`jpeg`/`png`) → browser uploads direct → `POST …/confirm` (HEAD verifies size/type) flips to `stored`. `DELETE …/attachments/:aid` (draft-only, also deletes the object). `GET …/attachments/:aid/url` mints a ~60s presigned GET **only after** ownership/entity-scope passes. Key: `refund/{requestId}/{lineId}/{attachmentId}/{safeName}`. Only `stored` attachments surface.
  - done when: integration tests (storage mocked) prove the mint→confirm→list flow, oversize/wrong-type rejection at mint, draft-only delete, and that a signed GET is only minted after the authz check; startup aborts if `REFUND_S3_REGION` ∉ EU allowlist.

- [x] T10: Submit / withdraw lifecycle + audit — refs: AC-1.5, AC-1.6, AC-2.1, AC-2.2, AC-2.3, AC-8.1 — deps: T8
  - touch: `refund-api/src/requests/lifecycle.*`, audit writer
  - `POST /requests/:id/submit`: refuse 0-line (422, AC-1.5) and incomplete-line (422 body lists offending line ids, AC-1.6); else → `submitted`, becomes read-only. `POST /requests/:id/withdraw`: `submitted`→`draft` (409 if not submitted). Each transition (submit, withdraw) writes an append-only audit row (actor/ts/action). Editing/deleting a non-draft → 409 (AC-2.3).
  - done when: integration tests cover the full transition matrix incl. the 422 offending-line payload, the withdraw round-trip, terminal-immutability 409s, and an audit row per transition.

- [x] T11: Accounting review read — entity-scoped queue + detail — refs: AC-5.1, AC-5.2, AC-5.3, AC-5.5, AC-5.6, AC-6.1, AC-6.3, AC-6.4, AC-6.5, AC-6.6 — deps: T10, T2
  - touch: `refund-api/src/review/` (routes, service), reuse the entity predicate (T6)
  - `GET /review/requests` (submitted ∧ in-scope; 403 without `request:review`). `GET /requests/:id` for accounting: full detail incl. **all** lines when ≥1 in scope (never filtered); 404 when scope matches none. Decided requests inspectable read-only. Per-currency subtotals as on the employee side.
  - done when: integration tests cover queue scoping (single-entity sees/omits, global sees all, withdrawn absent, only submitted present), whole-request line visibility for an in-scope mixed-entity request, out-of-scope deep-link 404, and non-accounting 403.

- [x] T12: Accounting decisions — set-approved-total / approve / reject + audit — refs: AC-6.5, AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.6, AC-8.1 — deps: T11
  - touch: `refund-api/src/review/decide.*`, audit writer
  - `PUT …/lines/:lineId/approved-total` (submitted-only, entity-scoped, writes an `approved_total_set` audit row). `POST …/approve` → `approved`, each line's total finalized (default = requested for untouched lines), stamps decidedBy/decidedAt. `POST …/reject` requires non-empty motivation (422 if empty) → `rejected`, stamps motivation + decidedBy/decidedAt. Both are whole-request incl. out-of-scope lines. Decided → any change 409 (AC-7.4).
  - done when: integration tests cover approve (defaulting + stamps + audit), reject (empty→422, valid→motivation+stamps+audit), per-line total edits with audit rows, whole-request decision across a mixed-entity request, and decided-immutability 409s.

- [x] T13: Notify the employee on decision — refs: AC-3.3, AC-3.6 — deps: T12, T3
  - touch: `refund-api/src/review/decide.*` (post-commit hook), `refund-api/src/lib/notify.ts`, env (`NOTIFY_INTERNAL_TOKEN`, notify-api base URL)
  - After an approve/reject commits, call `notify-api POST /system/notifications` (`X-Internal-Token`) with `recipientId=<owner sub>`, `originApp:"refund"`, title/body per outcome, `link.href:/refund/requests/:id`. Best-effort: a failed call is logged and never rolls back the decision.
  - done when: an integration test (notify-api mocked) asserts approve and reject each fire the call with the owner's sub + correct link, and that a mocked notify failure still returns a 200 decision.

## refund-ui (federated remote — replace the placeholder)

- [x] T14: refund-ui foundation — router, shell, api client, strings, domain constants — refs: AC-1.1 (routing), (foundation for all U tasks) — deps: none
  - touch: `refund-ui/src/` — TanStack Router at `basepath:'/refund'` with routes `requests`/`requests/new`/`requests/$id`/`review`/`review/$id`; `RefundShell` layout; an `apiFetch`-based client (via `shell/session`); `src/strings.ts` (centralized English copy, no hardcoded JSX text); `EXPENSE_TYPES` constant (12 types, id + labels); `formatMoney(cents,currency)` lib with unit tests. Replace the placeholder `App.tsx`.
  - done when: `pnpm build` + `pnpm lint` green; `formatMoney` unit tests pass per currency (EUR/CHF, 2 decimals); the router mounts all five routes with placeholder screens; no hardcoded UI strings remain (all via `strings.ts`).

- [x] T15: Ported shared components + badges — refs: AC-3.4 (status badge), AC-3.5 (entity chip) — deps: T14
  - touch: `refund-ui/src/components/` — port `ErrorBanner`, `SkeletonListRows`, `ConfirmDeleteModal`, `GuardrailDialog`, `PermissionDenied` (from admin-ui patterns); NEW `RequestStatusBadge` (4 variants), `EntityBadge` (glyph+text+color, never color-only).
  - done when: component tests render each badge variant and the ported dialogs' focus-trap/Escape/confirm behavior; `pnpm lint`/`build` green.

- [x] T16: Screens R1 (My requests) + R2 (draft composer & status-driven detail) — refs: AC-1.2, AC-1.4, AC-1.5, AC-1.6, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-3.1, AC-3.2, AC-3.3, AC-3.4, AC-4.1, AC-4.2 — deps: T15
  - touch: `refund-ui/src/pages/` + components `ExpenseLineComposer`, `ExpenseLineRow`, `SubtotalsPanel`, `SubmitValidationSummary`, `MonthlyProcessingNote`, R1/R2 rows
  - R1 list (loading/empty/populated/error/PD). R2 variants: draft (composer with type-driven `km`, add/edit/delete line, delete-request confirm, submit-disabled-on-0-lines), submitted (RO pending), approved (requested vs approved + subtotals + MonthlyProcessingNote), rejected (motivation + "+ New request"). 422 → SubmitValidationSummary with jump links; 409 → GuardrailDialog; NF → neutral not-found. Integrates T7/T8/T10.
  - done when: component/integration tests cover the km show/hide, submit-blocked-on-empty, the four status variants, the validation-summary jump behavior, and MonthlyProcessingNote present only on approved; a11y: labelled fields, focus-on-transition, `aria-live` announcements.

- [x] T17: Attachment upload/download UI — refs: AC-1.3, AC-1.7, AC-6.2 — deps: T16, T9
  - touch: `refund-ui/src/components/AttachmentList.tsx`, per-file upload state machine, `AttachmentDownloadLink`
  - Draft mode: multi-file input, client-side size/type pre-check with per-file inline error, three-phase mint→direct-PUT→confirm with live `aria-live` per-file state, remove (draft-only). Accounting mode: download-only (click → mint signed GET → open).
  - done when: tests cover per-file rejection (oversize/wrong type), the phase state machine transitions, remove-on-draft, and that accounting mode exposes no upload/remove; `aria-live` announcements present.

- [x] T18: Screens A1 (Review queue) + A2 (Review detail & decide) — refs: AC-5.1, AC-5.2, AC-5.4, AC-6.1, AC-6.3, AC-6.5, AC-6.6, AC-7.1, AC-7.2, AC-7.3, AC-7.4, AC-7.6 — deps: T15, T16
  - touch: `refund-ui/src/pages/` A1/A2, per-line approved-total input, `ApproveDialog` (ported+recolored `--grn`), `RejectDialog` (NEW, required motivation, disabled-until-valid)
  - A1 queue (loading/empty/populated/error/PD-403). A2: full RO line list + download-only attachments, per-line approved-total inputs (default-shown, write-on-change only), Approve/Reject with dialogs, 409→GuardrailDialog, out-of-scope→NF, decided→RO. Integrates T11/T12.
  - done when: tests cover PD on missing review grant, the approved-total input row-identity `aria-label`s, RejectDialog disabled-until-non-empty motivation, the approve/reject flows returning to the queue, and the decided read-only variant.

## DevOps

- [x] T19: Wire refund-api into local dev + deploy (EU region, object storage, shared secrets) — refs: data-residency constraint, AC-3.6 (notify token), AC-8.* (durable DB) — deps: T4
  - touch: root `mise.toml` (`mise run dev` includes refund-api), `compose.yaml` if a logical DB is added, `refund-api/.env.example`/`.envrc`, deploy config (EU region), 1Password refs for `REFUND_S3_*`, `NOTIFY_INTERNAL_TOKEN` (shared with notify-api), `AUTH_AUDIENCE`
  - done when: `mise run dev` brings up refund-api alongside the suite; documented EU-region deploy target + object-storage bucket provisioning; `NOTIFY_INTERNAL_TOKEN` shared between auth/refund-api/notify-api; startup env validation verified.

- [x] T20: Federation & routing wiring — shell mounts refund at `/refund` + trusted-origin — refs: AC-1.1 (reachable), ADR-0006, ADR-0001 — deps: T14
  - touch: `refund-ui/vite.config.ts` (exposes `./App` — verify), `shell/` remote registration + `/refund/*` route mapping, runtime remote-URL resolution per-env, **`shell/src/lib/session.ts` `getTrustedOrigins()`** (+ the shell's env for the refund-api URL)
  - **Trusted-origin fix (drift from T14):** `shell/src/lib/session.ts`'s `getTrustedOrigins()` allowlist currently covers auth/estimai/notify only — NOT refund-api. Until refund-api's origin is added, `apiFetch` sends refund-api requests WITHOUT the Bearer header (ADR-0001 attaches the token to trusted origins only) and every refund-api call 401s. Add the refund-api origin (mirrors how specs/005-notification-center added notify-api in its own shell task). This is the enabler for T16–T18's real API calls to work end-to-end.
  - done when: the shell mounts refund-ui at `/refund` in dev, the `_authed` guard runs before mount, the nav item for the Review queue is gated at the shell level, **and an `apiFetch` to the refund-api origin carries the Bearer token (trusted-origins test/assertion)**; `pnpm build` green for both shell and refund-ui.

## Verification & close

- [ ] T21: End-to-end headline journeys (Playwright) — refs: AC-2.1, AC-3.2, AC-3.6, AC-6.5, AC-7.2, AC-7.3 — deps: T16, T17, T18, T13
  - touch: `refund-ui/e2e/` (seeded-session helper), stack config
  - Journeys: (1) employee composes a mixed-entity request with an attachment → submits → accounting (scoped) adjusts a total → approves → employee sees requested-vs-approved + the notification + the monthly note; (2) a reject-with-motivation path showing the motivation to the employee.
  - done when: both e2e journeys pass against the running stack.

- [ ] T22: Close — all gates green, spec status → done — refs: (all) — deps: T1–T21
  - done when: every task above checked; QE PASS + owasp findings resolved; a fresh passing `eval-report.md`; then `/wellforge:done 007-refund-service` flips `status: done`.

---

## AC coverage (both directions)

| AC group | Covered by |
|---|---|
| US-1 (1.1–1.7) compose | T7 (1.1), T8 (1.2/1.4/1.6), T9 (1.3/1.7), T10 (1.5/1.6), UI T16/T17 |
| US-2 (2.1–2.5) submit/withdraw | T10 (2.1/2.2/2.3), T7 (2.5), UI T16 |
| US-3 (3.1–3.6) track/outcome | T7 (3.1/3.2/3.4/3.5), T12 (3.3), T13 (3.6), UI T16 |
| US-4 (4.1–4.2) monthly note | UI T16 (MonthlyProcessingNote) |
| US-5 (5.1–5.6) queue | T11, UI T18 |
| US-6 (6.1–6.6) inspect | T11 (6.1/6.3/6.4/6.5/6.6), T9 (6.2), UI T18 |
| US-7 (7.1–7.6) decide | T12, UI T18 |
| US-8 (8.1–8.3) audit | T5 (8.2/8.3 trigger+Restrict), T10/T12 (8.1 writes) |
| Enablers | T1 (authz seam), T2 (catalog/seed), T3 (notify seam), T4 (bootstrap), T6 (authz mw), T14 (ui foundation), T19/T20 (devops) |

Every task references ≥1 AC (or is a named enabler for AC-bearing tasks); every AC is served
by ≥1 task.

## Parallelization

- **Wave 1 (no deps):** T1, T2, T3, T4, T14 — start together (seams + refund-api bootstrap + ui foundation).
- **Wave 2:** T5,T6 (after T4/T1) · T15 (after T14) · T19 (after T4) · T20 (after T14).
- **Wave 3:** T7→T8→T9/T10 (refund-api domain chain) · T16 (after T15).
- **Wave 4:** T11→T12→T13 · T17 (after T16/T9) · T18 (after T16).
- **Wave 5:** T21 (full stack) → T22 (close).

FE and BE tracks are dependency-independent until integration (T16/T17/T18 exercise the
T7–T13 endpoints) and run as parallel worktree-isolated batches per the implement protocol.
