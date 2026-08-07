---
spec: 013
generated: 2026-08-07
---

# Tasks: Estimate sharing — invite registered EstimAI users to collaborate on an estimate

Derived from `plan.md` (approved 2026-08-07) and `design.md`. Three tracks —
**A** (`auth`), **B** (`estimai-api`), **C** (`estimai-ui`) — are independent at their roots
and are meant to run as parallel agents; sequence only along `deps:`.

Track roots: **T1** (A), **T4** (B), **T14** (C) have no dependencies and start together.

---

## Track A — `auth`: the third-party endpoints

- [x] T1: Add the `lower(email)` functional index and the reusable in-process rate limiter — refs: AC-1.2 — deps: none
  - touch: `auth/prisma/migrations/<new>/migration.sql`, `auth/src/lib/rateLimiter.ts` (new), `auth/src/lib/env.ts`
  - note: `CREATE INDEX user_email_lower_idx ON "user" (lower(email))` — new migration file only, never edit an existing one. The limiter is a sliding-window `Map<sub, timestamps[]>` with periodic prune, written behind one interface so a shared store is a later swap (plan R7). New env: `APP_ACCESS_CHECK_FLOOR_MS` (150), `APP_ACCESS_CHECK_RATE_LIMIT` (40), `APP_ACCESS_CHECK_RATE_WINDOW_MS` (600000), validated at startup with `process.exit(1)` on missing.
  - done when: `bun run db:migrate` applies cleanly; `EXPLAIN` on `WHERE lower(email) = $1` shows an index scan on `user_email_lower_idx`; a unit test proves the limiter admits N and rejects N+1 within the window and re-admits after it; `bun run typecheck` passes.

- [x] T2: `POST /authz/app-access-check` — the eligibility **decision** endpoint — refs: AC-1.1, AC-1.2 — deps: T1
  - touch: `auth/src/authz/appAccessCheck.routes.ts` (new), `auth/src/authz/appAccessCheck.routes.test.ts` (new), `auth/src/index.ts`, `auth/src/openapi/`
  - note: implement exactly the plan's contract — `{eligible:true,userId}` / `{eligible:false}` with **one** key on every negative path; caller gate = caller holds `(appId,"access")` via the existing `resolveEffectivePermissions` and is not soft-deleted (else 403 `app_access_required`); target predicate includes `deletedAt IS NULL`; parameterised `lower(email) = $1` probe (**never** Prisma `mode:"insensitive"`, which emits `ILIKE` and cannot use the index); `resolveEffectivePermissions` runs on **every** path including no-such-user (sentinel id, result discarded) so the query shape is equal; `APP_ACCESS_CHECK_FLOOR_MS` floor on every `eligible:false`, success not floored; rate limit 40/10min per `sub` → 429 + `Retry-After`. `POST` so the email never reaches a URL or access log; the probed email must never appear in a log line.
  - done when: integration tests prove (a) no-such-user and user-without-`estimai:access` return **byte-identical** bodies, (b) a soft-deleted target is `eligible:false`, (c) a caller lacking `(appId,"access")` gets 403, (d) the **anti-enumeration snapshot test** asserts the negative body has exactly one key, (e) the timing test over 50 samples per cause shows both medians ≥ floor and differing by < 10% of the floor, (f) the 41st call in the window is 429. All green under `bun test`.

- [x] T3: `POST /authz/users/identities` — id-keyed identity resolution — refs: AC-2.1, AC-10.5 — deps: T1, T2
  - dep note: T2 was originally listed as a sibling, but both tasks register routes in `auth/src/index.ts` and `auth/src/openapi/` — a shared-file edge, so they are sequenced (or done by one agent) rather than run as parallel worktrees.
  - touch: `auth/src/authz/identities.routes.ts` (new), `auth/src/authz/identities.routes.test.ts` (new), `auth/src/index.ts`, `auth/src/openapi/`
  - note: ids only (1..100, each 1..64 chars); returns `{id,status:"active"|"deleted"|"unknown",name}` with `name` non-null **only** for `active`; emails are never returned; no email/name/query/prefix/wildcard/pagination input is accepted — this boundary IS the Non-goal, it must not erode.
  - done when: integration tests cover all three statuses; the **directory-shape contract test** proves a body carrying `email`, `name`, `query`, or `prefix` is rejected and >100 ids is rejected; a deleted user's `name` is asserted `null`; `bun test` green.

- [x] T27: Rate-limit `POST /authz/users/identities` — close the shipped-contract gap — refs: AC-2.1, AC-10.5 — deps: T3
  - touch: `auth/src/authz/identities.routes.ts`, `auth/src/authz/identities.routes.test.ts` (or its actual location under `auth/src/auth/`), `auth/src/lib/env.ts`, `auth/.env.example`
  - origin: **drift**, raised by the T2/T3 agent and decided by the user on 2026-08-07. `plan.md`'s API contract for this endpoint lists `429 + Retry-After`, but neither the plan nor T1 provisioned rate-limit config for it, so T3 shipped it unthrottled and documented the gap rather than inventing constants. The user chose to implement rather than amend the contract.
  - note: reuse T1's existing `auth/src/lib/rateLimiter.ts` — do **not** write a second limiter. New env `IDENTITIES_RATE_LIMIT` (default `120`) / `IDENTITIES_RATE_WINDOW_MS` (default `600000`), validated at startup like the `APP_ACCESS_CHECK_*` pair. 120/10 min sits far above real usage (roughly one batched call per list render) while still bounding the 100-id fan-out. Return `429` Problem + `Retry-After`, matching `app-access-check`'s shape. Unlike that endpoint this one needs **no** response-time floor — it resolves ids the caller already holds and leaks no existence signal (ADR-0039), so there is nothing to equalise.
  - done when: the 121st call in the window returns 429 with a `Retry-After` header; a test proves the limiter is keyed per caller `sub` (one caller's exhaustion does not throttle another); the existing identities tests still pass; `bun run typecheck` clean and startup aborts with a named message when either new var is absent.

## Track B — `estimai-api`: ACL, concurrency, collaborator routes

- [x] T4: Schema + migration — `EstimateCollaborator`, `version`, `lastModifiedByUserId` — refs: AC-4.1, AC-9.1, AC-10.1 — deps: none
  - touch: `estimai-api/prisma/schema.prisma`, `estimai-api/prisma/migrations/<new>/migration.sql`
  - note: exactly the plan's Data model block — `EstimateAccessLevel` enum, `estimate_collaborator` with `@@unique([estimateId,userId])` + the two indexes, `onDelete: Cascade` on `estimateId` (**not** `Restrict` — cargo-culting ADR-0018 here would make an estimate with collaborators undeletable and break AC-9.1). `version Int @default(1)` and nullable `lastModifiedByUserId` are additive with non-volatile defaults so no table rewrite; no backfill.
  - done when: `bun run db:migrate` applies to the compose Postgres; a test asserts a pre-existing estimate row reads `version = 1`; deleting an estimate with 2 grants leaves 0 rows in `estimate_collaborator`; generated Prisma client typechecks.

- [x] T5: Outbound clients + env + rate limiter (`auth` eligibility, `auth` identities w/ cache, `notify`) — refs: AC-1.2, AC-2.1, AC-7.1 — deps: none
  - touch: `estimai-api/src/lib/authClient.ts` (new), `estimai-api/src/lib/notify.ts` (new), `estimai-api/src/lib/rateLimiter.ts` (new), `estimai-api/src/lib/env.ts`
  - note: `authClient` exposes two single functions (`checkAppAccess`, `resolveIdentities`) forwarding the **caller's** Bearer JWT — single-function modules specifically so tests use `mock.module()` (the `refund-api` pattern; re-mocking `jose` collides across files in one bun worker). Identities are cached in-process by `sub`, 60 s TTL, batched per list render (distinct subs, self excluded) and **fail soft** to `status:"unknown"`; eligibility **fails closed**. `notify.ts` is a verbatim-contract reuse of `refund-api/src/lib/notify.ts` and **never throws**. New env: `AUTH_BASE_URL`, `NOTIFY_INTERNAL_URL`, `NOTIFY_INTERNAL_TOKEN` (≥32 chars), `SHARE_LOOKUP_FLOOR_MS` (300), `SHARE_ADD_RATE_LIMIT` (20), `SHARE_ADD_RATE_WINDOW_MS` (600000) — all validated at startup, `process.exit(1)` on missing.
  - done when: unit tests prove the identity cache serves a second call without a second fetch and expires at 60 s; a **fail-soft test** proves a throwing `resolveIdentities` still yields `status:"unknown"` rather than an error; a **fail-closed test** proves a throwing `checkAppAccess` surfaces as an error the caller maps to 503; `notify.ts` swallows and logs a rejection; startup aborts with a named message when any new var is absent.

- [x] T6: `resolveAccess` + widen every owner-scoped query + denial taxonomy — refs: AC-1.6, AC-2.1, AC-2.2, AC-2.3, AC-3.3, AC-5.2, AC-10.2, AC-10.3, AC-10.4 — deps: T4, T5
  - touch: `estimai-api/src/estimates/access.ts` (new), `estimai-api/src/estimates/estimates.repo.ts`, `estimai-api/src/estimates/estimates.routes.ts`, `estimai-api/src/estimates/estimates.schemas.ts`
  - note: one helper `resolveAccess(estimateId, callerId) → {level,version,ownerId} | null` in a single query. Apply the plan's per-call-site table: `listEstimates` widens to `OR: [{userId},{collaborators:{some:{userId}}}]` and returns `access` + `owner` (`null` when `access==="owner"`); `getEstimateById` drops the `userId` predicate and gates on `resolveAccess`; `deleteEstimate` keeps its owner-only predicate and maps `count===0` through `resolveAccess` to 403 `owner_only` vs 404; `createEstimate` and `POST /estimates/import` are unchanged (import never creates grants). Denial taxonomy: **no relationship → 404** (ADR-0005 intact), **relationship but wrong level → 403**.
  - done when: integration tests prove an unrelated user gets a 404 whose Problem body is byte-identical to a genuinely absent id on `GET`/`PUT`/`DELETE`; a collaborator's `DELETE /estimates/{id}` is 403 `owner_only`; a user with **only** grants gets a non-empty `GET /estimates`; `owner` is `null` on owned rows and populated on shared rows; existing spec-001 estimate tests still pass unchanged.

- [x] T7: Optimistic concurrency — `version` CAS, required `If-Match`, `ETag`, 409/428 — refs: AC-4.1, AC-4.3, AC-4.4, AC-3.1, AC-3.2 — deps: T6
  - touch: `estimai-api/src/estimates/estimates.repo.ts`, `estimai-api/src/estimates/estimates.routes.ts`
  - note: single-statement CAS — `updateMany({ where: { id, version, OR:[owner, editor-grant] }, data: { …, version: { increment: 1 }, lastModifiedByUserId } })`. The access predicate lives **inside** the statement (no TOCTOU). `If-Match` is **REQUIRED**; absent/malformed → 428 `precondition_required`. `count===0` → re-`resolveAccess` → 404 / 403 `insufficient_access` / 409. Evaluation order is fixed: 401 → 400 → 428 → 413 → 404/403 → 409, so a stranger's probe can never elicit a 409. The 409 body carries `currentVersion`, `updatedAt`, and best-effort `lastModifiedBy` (never blocks the 409, never carries estimate content). `ETag: "<version>"` on 200 `GET`/`PUT`. If Prisma's relation-filter subquery in the CAS proves unusable, fall back to `$executeRaw` with an explicit `EXISTS` (plan R8).
  - done when: two concurrent `PUT`s with the same `If-Match` (`Promise.all`) yield exactly one 200 and one 409, final version incremented by exactly **1**, content equal to the winner's; the same holds for one user's two tabs; a missing `If-Match` is 428; the **CAS-predicate test** proves a viewer with a *correct* `If-Match` still gets 403 (not 409) and an unrelated user always gets 404 (not 409); a viewer's rejected `PUT` leaves the stored row byte-identical.

- [ ] T8: `GET` + `POST /estimates/{id}/collaborators` — the add path — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5, AC-5.4 — deps: T6, T5
  - touch: `estimai-api/src/estimates/collaborators.routes.ts` (new), `estimai-api/src/estimates/collaborators.repo.ts` (new), `estimai-api/src/estimates/collaborators.schemas.ts` (new), `estimai-api/src/index.ts`
  - note: implement the plan's **9-step handler order verbatim** — resolveAccess (404/403) → rate limiter (counts **every** outcome) → normalise+syntax → fast self-check off the JWT `email` claim → duplicate check on `(estimateId,email)` → `auth` eligibility (throw/non-2xx → 503, `eligible:false` → floored generic 422) → definitive self-check on the resolved `userId` → INSERT (unique violation → 409) → post-commit notify. The generic rejection is **ONE** fixed status, **ONE** fixed code (`collaborator_not_eligible`), **ONE** fixed non-interpolated detail string, floored to `SHARE_LOOKUP_FLOOR_MS`. `GET` is owner-only (403 `owner_only` for a collaborator) and returns the **grant's** id, never a `sub`. `grantedByUserId`/`userId` come only from the verified JWT and the `auth` response, never the request body.
  - done when: integration tests cover 201 + the target's list now containing the estimate; both ineligible causes returning an identical 422 body; duplicate → 409 `already_collaborator` with row count still 1; stale-email-snapshot duplicate also mapping to 409 via the unique violation; self-add by JWT email **and** by an alias resolving to the caller's own `sub` → 422 `cannot_share_with_self`; an editor's add → 403; the 21st attempt in the window → 429 with the counter having incremented on successes and 409/422s alike; a throwing `auth` → 503 with **no** grant row created; the owner never appearing in `GET …/collaborators`.

- [x] T9: `PATCH` / `DELETE {collaboratorId}` / `DELETE /me` — manage, revoke, leave — refs: AC-5.1, AC-5.2, AC-5.3, AC-6.1, AC-6.2 — deps: T8
  - touch: `estimai-api/src/estimates/collaborators.routes.ts`, `estimai-api/src/estimates/collaborators.repo.ts`
  - note: all three owner-gated except `/me`. **Register the literal `/me` route BEFORE the `{collaboratorId}` param route.** `PATCH` sends no notification (AC-7.3). An owner calling `/me` gets 404 `not_a_collaborator` (they delete the estimate instead). Enforcement is next-request — no live disconnection.
  - done when: `PATCH` editor→viewer makes the collaborator's next `PUT` 403 and viewer→editor makes it 200; `DELETE` leaves the former collaborator with a 404 whose body is identical to AC-1.6's and an estimates list excluding it; `DELETE /me` as a viewer is 204 and removes them from the owner's list; the owner's `DELETE /me` is 404 `not_a_collaborator`; `PATCH`/`DELETE` on a fabricated grant id is 404.

- [ ] T10: Notification wiring — grant and owner-initiated removal — refs: AC-7.1, AC-7.2, AC-7.3 — deps: T8, T9
  - touch: `estimai-api/src/estimates/collaborators.routes.ts`, `estimai-api/src/lib/notify.ts`
  - note: `POST /system/notifications` with `X-Internal-Token` (ADR-0017/ADR-0040), **after** the grant transaction commits, best-effort — a failure is logged and never rolls back the grant. Grant → `severity:"info"`, `originApp:"estimai"`, names the estimate + level, `link.href:"/estimai/estimates/{id}"`. Owner-initiated removal → names the estimate, **no link**. Self-leave sends nothing. Estimate name truncated to 120 chars (a deliberate, recorded widening of what leaves `estimai-api` — plan R9).
  - done when: tests prove notify is called exactly once on grant with the right recipient/originApp/link and once (link-less) on owner removal; and **never** on `PUT`, on `PATCH` level change, or on `DELETE /me`; a throwing notify client still yields 201 with the grant persisted; the **mutual-exclusion test** proves the collaborator routes reject `X-Internal-Token` and accept only a user JWT, and that `estimai-api` exposes no `/system/*` route.

- [ ] T11: OpenAPI registration for every new/changed `estimai-api` route — refs: AC-1.1, AC-3.1, AC-4.1 — deps: T7, T9
  - touch: `estimai-api/src/openapi/`, `estimai-api/src/estimates/collaborators.schemas.ts`
  - note: register the five collaborator routes plus the changed `GET`/`PUT` response shapes (`access`, `owner`, `version`, `ETag`, `If-Match`) and every new error `code`. Keep it consistent with the existing registry style.
  - done when: the Scalar reference renders all five collaborator routes with their documented status codes; a test asserts the OpenAPI document is generated without schema errors.

## Track C — `estimai-ui`

- [x] T14: Foundations — `strings.ts`, `formatIdentity`, `AccessLevelBadge` — refs: AC-2.1, AC-10.5 — deps: none
  - touch: `estimai-ui/src/strings.ts` (new), `estimai-ui/src/lib/identity.ts` (new), `estimai-ui/src/components/AccessLevelBadge.tsx` (new)
  - note: every new user-facing string from design.md's i18n table lands in `strings.ts` with namespaced keys, typed so a second locale is mechanical (the `refund-ui/src/strings.ts` precedent). **Only new copy** — retro-fitting estimai-ui's existing inline English is explicitly out of scope. `formatIdentity` is the single function that renders `active` / `deleted` ("Former wellD member") / `unknown`, never a blank, a raw cuid, or a tooltip-only value. `AccessLevelBadge` follows `EntityBadge`'s rule: glyph **plus** text, never colour alone, glyph `aria-hidden`.
  - done when: unit tests cover all three `formatIdentity` states; `AccessLevelBadge` renders an accessible name of "Editor"/"Viewer" with the glyph hidden from AT; no new hardcoded user-facing string exists outside `strings.ts` (assert by lint/grep over the new files).

- [x] T15: API clients — `collaboratorsApi`, `estimatesApi` `If-Match`/`ConflictError` — refs: AC-4.1, AC-1.2 — deps: T14
  - touch: `estimai-ui/src/lib/collaboratorsApi.ts` (new), `estimai-ui/src/lib/estimatesApi.ts`, `estimai-ui/src/lib/estimatesApi.test.ts`
  - note: typed wrappers over the five collaborator endpoints reusing `ApiError`; `EstimateFull`/`EstimateListItem` gain `access`, `owner`, `version`; `update()` sends `If-Match` and adopts the returned version; a `ConflictError` subclass carries `currentVersion` and `lastModifiedBy`. All calls go through `apiFetch` (ADR-0001).
  - done when: unit tests prove `update()` sends the `If-Match` header, that a 409 rejects with a `ConflictError` carrying `currentVersion`, that a 428 maps to the same conflict path, and that each collaborator-endpoint error `code` maps to its own typed error; existing `estimatesApi` tests still pass.

- [x] T16: Context — `access` / `canEdit` / `version`, autosave gating and suppression — refs: AC-3.1, AC-3.2, AC-4.2 — deps: T15
  - touch: `estimai-ui/src/context/EstimatorContext.tsx`, `estimai-ui/src/pages/EstimatePage.tsx`, `estimai-ui/src/context/EstimatorContext.test.tsx`, `estimai-ui/src/components/ConfirmDeleteModal.test.tsx`
  - fixture note: T15's type widening (`access`/`owner`/`version` now required) leaves stale `EstimateFull`/`EstimateListItem` literals in these co-located test files. Updating them is part of this task — the tree does not typecheck until they are fixed.
  - note: one `canEdit` derived once in context — R5's whole mitigation is that no component decides this for itself. The autosave effect (a) does not run at all when `!canEdit`, (b) sends `If-Match` and adopts the returned version, (c) on 409/428 enters a `conflict` state and **suspends further autosaves** until resolved, leaving `name/author/params/releases/acts` untouched. `providerKey` moves from `estimate.updatedAt` to `estimate.version`.
  - done when: the **autosave-suppression test** proves that after a 409, advancing timers by 10× the debounce fires **no** further `PUT`; a viewer mount fires no `PUT` at all; local edits are still present in state after a 409.

- [x] T17: Viewer read-only gating across the editor — refs: AC-3.1, AC-3.2 — deps: T16
  - touch: `estimai-ui/src/components/ActivityTable.tsx`, `ParametersPanel.tsx`, `Header.tsx`, `SummaryTable.tsx`, `estimai-ui/src/EstimatorApp.tsx`
  - note: a single `readOnly` prop fed from context's `canEdit` — per design.md, prefer HTML `readOnly` over `disabled` (keeps the element focusable and its value normally exposed to AT); `<select>` columns (Profile, Release) have no native `readOnly` and render as **plain text**, not a disabled select. Add the viewer empty-activities state inline (TemplatePicker's verb is content creation — wrong for a viewer). Server-side 403 remains the real control; this is UX.
  - done when: mounting the editor as a viewer asserts **zero** enabled mutating controls anywhere in the tree (R5's named early check), while `useEstimator`'s computed outputs are deep-equal to the owner's and the export / link-share actions stay enabled; mounting as editor asserts the mutating controls are enabled.

- [ ] T18: `ConflictBanner` + the fourth save-status state — refs: AC-4.1, AC-4.2 — deps: T16, T17
  - touch: `estimai-ui/src/components/ConflictBanner.tsx` (new), `estimai-ui/src/components/Header.tsx`, `estimai-ui/src/EstimatorApp.tsx`
  - note: a **new** component, not an extension of `ToastBanner` (whose contract can't express two actions or never-dismissable without breaking its two existing call sites). `role="alert"`, **never** a dismiss "×", does not steal focus on appear (the user may be mid-keystroke). "Reload latest" primary, "Save as a copy instead" secondary (a `POST /estimates` of the local content). Header gains a 4th "Not saving — reload to continue" state so suppression is visible, not silent.
  - done when: a unit test proves the banner renders on `ConflictError`, exposes both actions, has no dismiss control, does not move focus, and that "Reload latest" triggers a route invalidate while "Save as a copy" posts the local content; the Header's 4th state renders whenever autosave is suspended.

- [x] T19: Generalize `ConfirmDeleteModal` for Remove / Leave — refs: AC-5.2, AC-6.1 — deps: T14
  - touch: `estimai-ui/src/components/ConfirmDeleteModal.tsx`, `estimai-ui/src/components/ConfirmDeleteModal.test.tsx`
  - note: parameterize the hardcoded title/body/confirm-label into `title`/`bodyText`/`confirmLabel` props whose **defaults are today's exact copy**, so `EstimatesPage`'s existing call site is untouched. Kept as its own reviewable unit (design.md's explicit request) rather than folded invisibly into the dialog task.
  - done when: the existing `ConfirmDeleteModal` tests pass **unmodified**, `EstimatesPage`'s delete flow is unchanged, and a new test proves custom title/body/confirm-label render with the same focus-trap and Escape semantics.

- [ ] T20: `CollaboratorsDialog` — owner mode — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-5.1, AC-5.2, AC-5.4 — deps: T15, T19
  - touch: `estimai-ui/src/components/CollaboratorsDialog.tsx` (new), `estimai-ui/src/components/CollaboratorsDialog.test.tsx` (new)
  - note: email + level add form, live list with level switch and remove, per design.md S2. Every failure state must be a designed, reachable state: the generic 422 (whose copy must **not** hint at the cause), 409 already-a-collaborator, self-add, 429 rate-limited, 503 `auth` unavailable. a11y per design.md: `role="dialog" aria-modal aria-labelledby`, live-queried Tab trap (the focusable set changes as rows come and go), default focus on the email input, Escape closes the nested confirm layer first, each Remove button `aria-label="Remove {email}"`, a visually-hidden `aria-live="polite"` region for async outcomes, inline field errors `role="alert"`.
  - done when: tests cover the happy add, all five failure states rendering their distinct designed copy (with the generic 422 asserted to disclose no cause), level change, remove-with-confirm, the owner never appearing as a manageable row, focus landing on the email input, the trap holding after a row is added, and the live region announcing add/remove/level-change outcomes.

- [ ] T21: `CollaboratorsDialog` — member mode + Leave — refs: AC-6.1, AC-6.2 — deps: T20
  - touch: `estimai-ui/src/components/CollaboratorsDialog.tsx`
  - note: second render branch — no form, no list, a "Shared with you by {owner}" line and one Leave action. Default focus goes to the dialog heading (`tabIndex={-1}` + programmatic focus) since there is no input to land on.
  - done when: a member-mode test proves no add form and no collaborator list render, Leave is confirmed through the generalized modal and calls `DELETE …/collaborators/me`, and **no** Leave affordance exists when `access === "owner"`.

- [ ] T22: Toolbar composition — "Share link" relabel + "Collaborators" entry / member chip — refs: AC-8.1, AC-8.2 — deps: T20, T21
  - touch: `estimai-ui/src/EstimatorApp.tsx`, `estimai-ui/src/EstimatorApp.test.tsx`
  - note: design.md's decision — **two permanent, differently-shaped entries, never a shared button or a dropdown-with-modes**. The existing Share button is relabelled "Share link" with icon, behaviour, colour and handler **unchanged** (AC-8.1); the new "Collaborators" control (people glyph, neutral border, count badge) sits in its own group behind the existing divider; a collaborator sees a non-actionable "Shared by {owner} · {level}" chip in that slot instead.
  - done when: a test proves both entries are simultaneously present and separately labelled for an owner, that the chip (not the button) renders for a collaborator, and that the existing share-link handler is invoked unchanged; the count badge reflects `collaboratorCount`.

- [ ] T23: Estimates list — shared indicator, owner identity, orphaned rows — refs: AC-2.1, AC-2.2, AC-2.3, AC-10.5, AC-10.4 — deps: T14, T15
  - touch: `estimai-ui/src/pages/EstimatesPage.tsx`, `estimai-ui/src/pages/EstimatesPage.test.tsx`
  - note: rows with `access !== "owner"` render a "Shared" indicator, the owner label via `formatIdentity`, and an `AccessLevelBadge`; owner-only actions (Delete) are absent on those rows. The empty state keys off the **combined** list length so a user with only shared estimates never sees it.
  - done when: tests prove a shared row is distinguishable from an owned row by role/testid (**not** by class), that a `deleted` owner renders "Former wellD member" and an `unknown` owner the neutral placeholder — neither a blank nor a raw cuid — that a list of only shared estimates does not render the empty state, and that Delete is absent on shared rows.

- [ ] T24: Link-share regression guard — refs: AC-8.1, AC-8.2 — deps: T22
  - touch: `estimai-ui/src/pages/SharedEstimatePage.test.tsx` (new), `estimai-ui/src/lib/shareUrl.ts` (unchanged — guarded only)
  - note: `SharedEstimatePage` and `shareUrl.ts` must be **untouched**. This task only adds the guard.
  - done when: existing `buildShareUrl` behaviour tests still pass unmodified; a contract test proves `SharedEstimatePage` performs **no** `apiFetch` call; a render with a `#data=` payload shows no collaborator list, no level chip, and no "Shared with you" text — only the existing plain `author` field.

## Cross-cutting

- [ ] T12: Cross-service test — owner soft-delete leaves the estimate and grants untouched — refs: AC-10.1, AC-10.2, AC-10.3, AC-10.4 — deps: T9
  - touch: `estimai-api/src/estimates/orphaned-estimate.test.ts` (new)
  - note: AC-10.1 is satisfied by the **absence** of a mechanism (no FK across databases, ADR-0012 point 3 — resource servers do nothing at delete time), so the test must assert exactly that absence, including a network spy proving `auth`'s soft-delete path makes no call into `estimai-api`.
  - done when: after running `auth`'s soft-delete for the owner, the `estimate` row and every `estimate_collaborator` row are byte-identical; the editor's `GET`/`PUT` still succeed and the viewer's `GET` returns identical content; every remaining collaborator gets 403 `owner_only` on `DELETE /estimates/{id}` and on all collaborator-management routes; a route-table assertion proves no ownership-reassignment route exists.

- [x] T13: DevOps — environment wiring across all environments + single-instance guard — refs: AC-1.2, AC-7.1 — deps: T5, T1
  - touch: `estimai-api/.env.example`, `estimai-api/.envrc`, `auth/.env.example`, `auth/.envrc`, `infra/README.md`, `mise.toml` if needed
  - note: wire `AUTH_BASE_URL`, `NOTIFY_INTERNAL_URL`, `NOTIFY_INTERNAL_TOKEN` (identical value to `auth`/`refund-api`/`notify-api`), `SHARE_LOOKUP_FLOOR_MS`, `SHARE_ADD_RATE_LIMIT`/`_WINDOW_MS`, `APP_ACCESS_CHECK_FLOOR_MS`, `APP_ACCESS_CHECK_RATE_LIMIT`/`_WINDOW_MS`. Secrets are 1Password references via direnv — **never** a literal; add `.gitleaksignore` entries if the pre-commit hook flags the references. Record that `estimai-api` and `auth` must stay **single-instance** while the limiter and identity cache are in-process (plan R7, the same constraint `notify-api` already carries).
  - done when: `mise run dev` brings the whole suite up with the new vars resolving; the gitleaks pre-commit hook passes; `infra/README.md` documents the new vars and the single-instance constraint; a startup test proves each service exits non-zero with a named message when a new var is missing.

- [ ] T25: End-to-end two-user flows — refs: AC-1.1, AC-2.1, AC-3.1, AC-4.4, AC-5.2, AC-6.1 — deps: T11, T22, T23, T13
  - touch: `estimai-ui/e2e/estimate-sharing.spec.ts` (new)
  - note: uses the existing seeded-session helper. Covers: owner shares → collaborator sees the estimate in their list with the right badge → viewer cannot edit → owner promotes to editor → editor saves → owner revokes → the estimate disappears from the collaborator's list. Plus the two-tab conflict flow (two browser contexts, **same** user, second tab's autosave surfaces the banner).
  - done when: `pnpm e2e` passes both specs against the locally running stack.

- [ ] T26: Close — all gates green, spec status → done — refs: all — deps: T2, T3, T10, T11, T12, T13, T24, T25
  - touch: `specs/013-estimate-sharing/spec.md`
  - note: the `production` done gate — every task checked, QE PASS, and a fresh passing `eval-report.md`. Run via `/wellforge:done`, never a hand-edit.
  - done when: lint, typecheck, unit, integration and e2e are green across `auth`, `estimai-api` and `estimai-ui`; the security floor (gitleaks, no hardcoded credentials, critical-CVE audit) passes; the owasp-reviewer pass has no finding ≥ medium open; `eval-report.md` is a PASS; spec frontmatter reads `status: done`.

---

## Coverage check

**Every AC → ≥1 task.** AC-1.1 T2,T8,T20,T25 · AC-1.2 T1,T2,T8,T13,T20 · AC-1.3 T8,T20 ·
AC-1.4 T8,T20 · AC-1.5 T8 · AC-1.6 T6 · AC-2.1 T3,T6,T23,T25 · AC-2.2 T6,T23 · AC-2.3 T6,T23 ·
AC-3.1 T7,T16,T17,T25 · AC-3.2 T7,T16,T17 · AC-3.3 T6 · AC-4.1 T4,T7,T15,T18 · AC-4.2 T16,T18 ·
AC-4.3 T7 · AC-4.4 T7,T25 · AC-5.1 T9,T20 · AC-5.2 T6,T9,T20,T25 · AC-5.3 T9 · AC-5.4 T8,T20 ·
AC-6.1 T9,T19,T21,T25 · AC-6.2 T9,T21 · AC-7.1 T5,T10,T13 · AC-7.2 T10 · AC-7.3 T10 ·
AC-8.1 T22,T24 · AC-8.2 T22,T24 · AC-9.1 T4 · AC-10.1 T4,T12 · AC-10.2 T6,T12 · AC-10.3 T6,T12 ·
AC-10.4 T6,T12,T23 · AC-10.5 T3,T14,T23.

**Every task → ≥1 AC.** Verified; no task serves zero ACs.

## Parallelisation

| Batch | Tasks | Notes |
|---|---|---|
| 1 | **T1** ∥ **T4** ∥ **T5** ∥ **T14** | four independent roots (auth, api-schema, api-clients, ui-foundations) |
| 2 | **T2→T3** (one agent, shared `index.ts`) ∥ **T6** ∥ **T15** ∥ **T19** | |
| 3 | **T7** ∥ **T8** ∥ **T16** ∥ **T13** ∥ **T27** | T8 needs T5+T6; T13 needs T1+T5; T27 needs T3 |
| 4 | **T9** ∥ **T17→T18** (one agent, shared `Header.tsx`/`EstimatorApp.tsx`) ∥ **T20** ∥ **T23** | |
| 5 | **T10** ∥ **T11** ∥ **T12** ∥ **T21** | |
| 6 | **T22** → **T24** | |
| 7 | **T25** | needs the full stack |
| 8 | **T26** | close |
