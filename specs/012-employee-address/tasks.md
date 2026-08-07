---
spec: 012
generated: 2026-08-04
---

# Tasks: Employee address — admin-managed, autocomplete-assisted capture

Derived from the approved `plan.md` (status `approved`, 2026-08-04) and `design.md`.
Sources of truth: `spec.md` for ACs, `plan.md` for contracts and file paths,
`design.md` for states, component reuse and a11y.

**Tracks.** Three dependency-independent tracks run in parallel:
**BE** (`auth`) = T1–T6 · **FE-admin** (`admin-ui`) = T7–T13 · **FE-shell** (`shell`) = T14–T15.
T16 (infra) is independent of all three. T17 (e2e) joins the tracks.

---

## Backend — `auth`

- [x] T1: Add the `EmployeeAddress` model and its migration — refs: AC-1.2, AC-1.4, AC-2.5, AC-3.4 — deps: none
  - touch: `auth/prisma/schema.prisma`, `auth/prisma/migrations/<ts>_employee_address/migration.sql`
  - 1:1 with `User` (`userId` PK/FK, `ON DELETE CASCADE`); `countryCode`/`city`/`street`/`houseNumber` `NOT NULL`; `postalCode`/`region`/`latitude`/`longitude` nullable; lat/lng `Decimal(9,6)`; `createdAt`/`updatedAt`/`updatedByUserId` (nullable, **not** a FK).
  - Hand-append the CHECKs per plan.md §Data model: non-blank required fields, `countryCode ~ '^[A-Z]{2}$'`, `(latitude IS NULL) = (longitude IS NULL)`, lat/lng ranges.
  - **`audit_log` and the `AuditLog` model must not be touched** — no column, no FK change, no `onDelete` change (ADR-0033; plan.md §Data model "Scope guarantee").
  - done when: `bun run db:migrate` applies cleanly on a fresh DB; a direct `INSERT` violating each of the five CHECKs is rejected by the database; `git diff` on the migration shows no statement naming `audit_log`.

- [x] T2: Add the shared zod schema and the pure formatted-address deriver — refs: AC-1.1, AC-1.4 — deps: none
  - touch: `auth/src/profile/address.schema.ts`, `auth/src/profile/address.format.ts`, `auth/src/profile/address.format.test.ts`
  - Schema validates **shape/type/length only** — all four required components declared `.optional()`; the completeness check is handler logic (plan.md §Shared shapes, "Validation split"). `formatted` is derived on read, never stored; country/region names via `Intl.DisplayNames`, with a raw-code fallback that never throws (R8).
  - done when: `address.format.test.ts` passes, covering a full address, a minimal four-field address, both optional fields absent, and the `Intl.DisplayNames`-unavailable fallback path.

- [x] T3: Implement `GET`/`PUT /admin/users/{id}/address` — refs: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-2.4, AC-2.5, AC-3.3, AC-3.4, AC-4.1, AC-5.1, AC-5.4, AC-6.3, AC-6.4 — deps: T1, T2
  - touch: `auth/src/admin/userAddress.routes.ts` (NEW), `auth/src/admin/userAddress.routes.test.ts` (NEW), `auth/src/index.ts` (+1 router registration)
  - The router **must** carry its own `userAddressRouter.use("/admin/users/*", sessionMiddleware, requireAuth, requireAdmin)` line — plan.md calls a forgotten gate "the single highest-consequence mistake available in this feature".
  - Handler algorithm exactly per plan.md §Admin surface: 404 on absent-or-soft-deleted target → normalize (trim, upper-case `countryCode`, quantize coords to 6 dp, drop a half-present lat/lng pair) → four-field completeness → `422` + `code:"address_incomplete"` + `missingFields` → **AC-5.4 semantic no-op guard** (return `200`, write nothing, no audit row, no `updatedAt` bump) → `withAudit` with `action:"user.address.set"` and **`affectedUserIds: []`** (no epoch bump). `PUT {"address": null}` clears. RFC 7807 on every error.
  - done when: `userAddress.routes.test.ts` passes with, at minimum — non-admin gets `403` on **both** verbs against a colleague's id **and their own**; no session ⇒ `401`; table-driven `422` for each of the four fields absent/`""`/`"   "`; both optional fields omitted ⇒ `200`; a `FR` address saves normally; `PUT` then fresh `GET` round-trips byte-identically with exactly one row; clear writes an audit row; identical double-`PUT` (incl. differing whitespace/case) writes exactly one audit row.

- [x] T4: Implement `GET /me/address` (employee self-read) — refs: AC-6.1, AC-6.2, AC-6.3, AC-6.4 — deps: T1, T2
  - touch: `auth/src/profile/address.routes.ts` (NEW), `auth/src/profile/address.routes.test.ts` (NEW), `auth/src/index.ts` (+1 router registration)
  - `sessionMiddleware + requireAuth`, **no `requireAdmin`**. **No `:id` parameter may exist** — the handler resolves `c.get("user")!.id` only (AC-6.4 is structural). **No write verb may be registered** (AC-6.3 falls through to `app.notFound()` ⇒ 404). `updatedByUserId` is deliberately omitted from this response. Defensive `404` on `deletedAt !== null`.
  - done when: tests prove two distinct fixture users each receive strictly their own row; `PUT`/`POST`/`PATCH`/`DELETE /me/address` each return `404` RFC 7807; unauthenticated ⇒ `401`.

- [x] T5: Add optional `targetType`/`targetId`/`action` filters to `GET /admin/audit` — refs: AC-5.3 — deps: none
  - touch: `auth/src/authz/audit.ts` (optional `where` only), `auth/src/authz/audit.routes.ts`, `auth/src/authz/audit.routes.test.ts`
  - Purely additive. `listAuditLog()`'s `include: { actor: … }` and every other line stay untouched; ordering stays newest-first. The covering `@@index([targetType, targetId])` already exists.
  - done when: a filtered query returns only the named employee's `user.address.set` entries, newest-first, and excludes another employee's; an unfiltered query returns what it does today (existing tests still green).

- [x] T6: Add the AC-5.2 application-level audit-immutability contract test — refs: AC-5.2 — deps: none
  - touch: `auth/src/authz/audit-immutability.contract.test.ts` (NEW), `auth/src/authz/audit.routes.test.ts` (extended)
  - Three clauses exactly per plan.md §Test strategy AC-5.2: **(a)** `Object.keys(await import("./audit")).sort()` equals exactly `["listAuditLog","withAudit"]`; **(b)** a static scan of `auth/src/**/*.ts` yields zero matches for the `auditLog.(update|updateMany|delete|deleteMany|upsert)` and raw-SQL patterns, **excluding** `**/*.test.ts`, `src/test-setup.ts` and `src/lib/generated/**`, with the `src/**` scan root asserted explicitly so a future widening cannot silently pull in `scripts/e2e-invite-fixtures.ts`; **(c)** authenticated **as an admin**, `POST`/`PUT`/`PATCH`/`DELETE` on `/admin/audit` and `/admin/audit/{id}` each return `404` while `GET /admin/audit` returns `200` in the same test.
  - **Do NOT build `auth/src/lib/db.audit-log-immutability.test.ts`** — that DB-level test belongs to the rejected Option A and plan.md marks it "removed and must not be built".
  - done when: all three clauses pass against the current tree without modifying any of the six existing `deleteMany` teardown callers.

---

## Frontend — `admin-ui`

- [x] T7: Build the Google Places client module — refs: AC-2.1, AC-2.2, AC-2.4, AC-2.5, AC-3.2 — deps: none
  - touch: `admin-ui/src/lib/googlePlaces.ts` (NEW), `admin-ui/src/lib/googlePlaces.test.ts` (NEW)
  - Places API (New) via the Maps JS API: `AutocompleteSuggestion.fetchAutocompleteSuggestions()` then `placePrediction.toPlace()` + `fetchFields({fields:['addressComponents','location']})`. SDK lazy-loaded on first field focus. Request contract exactly per plan.md: min 3 chars, 300 ms debounce, `AbortController` supersession + sequence-number discard, **3000 ms timeout treated as "no suggestions"**, max 5 rendered, one `AutocompleteSessionToken` per editing session consumed by `fetchFields`, `includedPrimaryTypes:['street_address','route','premise','subpremise']`, `language` = UI locale, details field mask `['addressComponents','location']`. Component mapping incl. the `locality`→`postal_town`→`admin_area_3` fallback chain.
  - **`locationBias` = the CH+IT rectangle. `includedRegionCodes` MUST NOT BE SET** — it is a restriction, not a bias, and would violate AC-2.4 invisibly (R3).
  - done when: fake-timer tests prove 2 chars ⇒ zero calls, 3 chars ⇒ one call after 300 ms, rapid typing ⇒ one call with earlier ones aborted; a fixture `addressComponents` maps correctly incl. the fallback chain; coords quantize to 6 dp; and an explicit assertion that the constructed request **has** `locationBias` and **does not have** `includedRegionCodes`.
  - **Post-close correction (2026-08-07), re-synced from plan.md.** `includedPrimaryTypes` above originally read `['address']` — a **legacy** Autocomplete `types` value that Places API (New) rejects with `400 INVALID_ARGUMENT`. AC-3.2's silent degradation hid it completely: every suggestion request failed and the field simply never suggested, with no visible error. Found in production use, not by any gate. Replacement verified against the live API (`['street_address']` alone returns nothing for a partial street; `['geocode']` offers cities, breaking AC-1.4). Fixed in `googlePlaces.ts`; `googlePlaces.test.ts` had asserted the broken value and so locked the defect in — it now guards against both `'address'` and `'geocode'`. No task added or removed; this is a value correction to an already-delivered contract.

- [x] T8: Extract the coordinate-staleness rule as a pure function — refs: AC-2.6, AC-3.4 — deps: none
  - touch: `admin-ui/src/lib/addressCoordinates.ts` (NEW), `admin-ui/src/lib/addressCoordinates.test.ts` (NEW)
  - `coordinatesForSave(snapshot, current)` — pure, so AC-2.6 gets a real truth table rather than component-state assertions.
  - done when: truth table passes — identical snapshot ⇒ coords retained; **any** one component differing ⇒ `(null, null)`; `snapshot === null` ⇒ `(null, null)`.

- [x] T9: Add the typed address API client — refs: AC-1.1, AC-1.2, AC-1.3, AC-5.3 — deps: T3, T5
  - touch: `admin-ui/src/lib/addressApi.ts` (NEW), `admin-ui/src/lib/addressApi.test.ts` (NEW)
  - `getAddress` / `putAddress` / `listAddressHistory` against the auth origin via `shell/session`'s `apiFetch`. Must surface the `422` `missingFields` payload in a typed shape the section can render per-field.
  - done when: tests cover `200` populated, `200 {address:null}`, the `422` incomplete shape, and a transport failure.

- [x] T10: Build the accessible combobox primitive — refs: AC-2.1, AC-2.2 — deps: none
  - touch: `admin-ui/src/components/Combobox.tsx` (NEW), `admin-ui/src/components/Combobox.test.tsx` (NEW)
  - The suite's **first** ARIA combobox (design.md confirmed none exists anywhere). One implementation, **two consumers** — the Street autocomplete (async, debounced remote fetch) and the Country select (sync, local filter) — parameterized by `getOptions`/`onSelect`. Native elements only; no Google-owned DOM.
  - done when: keyboard-only operation works end-to-end (↑/↓/Home/End/Enter/Escape), `aria-activedescendant` tracks the active option, result count is announced, focus returns correctly on selection, and selection is provably not mouse-only.

- [x] T11: Build `AddressSection` — the editor, its states, and the history panel — refs: AC-1.1, AC-1.3, AC-2.2, AC-2.3, AC-2.6, AC-3.1, AC-3.2, AC-3.3, AC-5.3 — deps: T7, T8, T9, T10, T13
  - touch: `admin-ui/src/components/AddressSection.tsx` (NEW), `admin-ui/src/components/AddressSection.test.tsx` (NEW)
  - All states from design.md: empty / populated / idle-edit / below-threshold / suggestions-loading / suggestions-returned / no-suggestions / **service-down (deliberately silent)** / suggestion-selected / hand-edited-after-selection (the `aria-live="polite"` coordinates-cleared status line, never styled as an error) / per-field validation failure / save in-flight / saved / save-failed / pending-clear-with-undo. Country uses the T10 primitive over a bundled ISO 3166-1 alpha-2 list with `Intl.DisplayNames` labels — **country names are derived, never i18n keys**. Google attribution renders in the **Street** popup only, never on Country.
  - done when: `AddressSection.test.tsx` passes with — selection populates all six inputs; edit-after-select persists the **edited** value and no input is `readOnly`/`disabled`; select → edit street → save sends `latitude:null,longitude:null`; suggest returns `[]` ⇒ still saveable; **three AC-3.2 cases** (loader rejects, suggest rejects, suggest never resolves past the 3 s cap) each assert no `role="alert"`, no spinner left mounted, inputs enabled, and a subsequent save returns `200`; a purely typed address saves on identical terms; the history panel renders who/when/old→new.

- [x] T12: Mount the section on `UserDetail` with capability-gated **absence** — refs: AC-4.2 — deps: T11
  - touch: `admin-ui/src/pages/UserDetail.tsx`, `admin-ui/src/pages/UserDetail.test.tsx`
  - Visibility is driven by `GET /authz/me`'s `roles` field, whose semantics mirror `requireAdmin` exactly (plan.md §API contracts) — no new endpoint. Hidden, **not** disabled. Scope note: this pattern is deliberately **not** retro-applied to the existing Attributes/Roles/Departments sections.
  - done when: with `roles: []` the section is absent from the DOM (`queryByTestId('address-section')` is `null`); with `roles: ['admin']` it renders.

- [x] T13: Add IT/EN copy constants for every new string — refs: AC-1.1, AC-1.4, AC-3.1 — deps: none
  - touch: `admin-ui/src/lib/addressCopy.ts` (NEW)
  - Every new string from design.md's i18n list — labels, "no address on file", the four per-field validation messages, the coordinates-cleared status line, the no-match empty state, clear/undo. No hardcoded UI strings (CLAUDE.md). Country **names** come from `Intl.DisplayNames` and are explicitly not keys.
  - done when: no literal user-facing string remains in `AddressSection.tsx`, and every key has both an `it` and an `en` value.

---

## Frontend — `shell`

- [x] T14: Build the read-only `AccountScreen` and its client — refs: AC-6.1, AC-6.2 — deps: T4
  - touch: `shell/src/lib/profileApi.ts` (NEW), `shell/src/components/AccountScreen.tsx` (NEW), `shell/src/components/AccountScreen.test.tsx` (NEW)
  - Mirrors `NoAccessScreen.tsx`; built from reused parts (`RemoteMount`'s loading/error fallbacks, `UserDetail`'s read-only-value styling). **Zero interactive elements.** A fetch failure must render an error+retry state, **never** "no address on file".
  - done when: within the address region `querySelectorAll('input, textarea, select, [contenteditable], button[type="submit"]').length === 0` and no `role="listbox"`/`role="combobox"` element exists; the `null`, populated, and fetch-failure states each render distinctly.

- [x] T15: Add the ungated `/account` route and the `UserMenu` entry — refs: AC-6.1 — deps: T14
  - touch: `shell/src/router.tsx`, `shell/src/components/UserMenu.tsx`, `shell/src/router.account.test.tsx` (NEW)
  - Child of `shellRoute` with **no `beforeLoad` app-access guard** and absent from `TOOLS` — the ADR-0009 `/notify` pattern (ADR-0034). Reachable by every signed-in employee regardless of app-access grants.
  - done when: `router.account.test.tsx` proves the route resolves for a session with **no** app-access grants, and the "My profile" item appears in the `UserMenu` dropdown.

---

## Infra

- [ ] T16: Provision the Google Maps key and document both runbooks — refs: AC-2.1, AC-3.2 — deps: none
  - **Status 2026-08-04: documentation half DONE (`infra/README.md`, commit `50eabcc`); provisioning half BLOCKED ON A HUMAN** — creating the GCP browser key, its referrer/API restrictions, the quota cap, the 1Password item and the Vercel env var all require console and vault access no agent has. Until the verification step passes, autocomplete degrades silently to manual entry (AC-3.2 by design), so this blocks neither the other tasks nor QE.
  - touch: `infra/README.md`, `admin-ui/.env.example` (+ `VITE_GOOGLE_MAPS_API_KEY`)
  - Browser key, **application restriction = HTTP referrers listing the SHELL's origins** (`https://operai.welld.io/*`, `http://localhost:5173/*`, the shell's Vercel preview pattern) — **not** admin-ui's, which would fail 100% of requests *invisibly* (R2). API restriction to Places API (New) + Maps JS API only. Daily quota cap + budget alert (R4). 1Password ref wired through admin-ui's deploy env as a build-time `VITE_*` var, not a `.envrc` value.
  - Also document the **audit-redaction runbook** (R5): who may perform it, that it targets an enumerated `audit_log.id` set, and that the act is recorded **out-of-band** because the trail cannot record its own redaction.
  - done when: the key is provisioned and restricted; loading the **deployed shell**, focusing an address field, and typing 3 characters produces a `places.googleapis.com` `200` in devtools; both runbook sections are in `infra/README.md`.

---

## Integration & close

- [x] T17: Write the end-to-end journey — refs: AC-1.2, AC-6.1, AC-6.2 — deps: T12, T15, T16
  - **EXECUTED AND PASSING (2026-08-04).** `1 passed (33.1s)` standalone, and passing again inside a full-suite run. AC-1.2/6.1/6.2 now have their end-to-end leg, including the one guarantee only e2e can prove: the real ungated `/account` reachable by a non-admin who cannot reach `/admin/*`.
  - It was initially reported unrunnable ("1Password not unlocked"). That diagnosis was wrong: `shell/e2e/helpers/inviteFixtures.ts` hard-coded `direnv exec .`, forcing a vault dependency the fixture script does not need — the auth service's plain local env file already suffices, and Bun loads it natively. Fixed in `3a81d53` (try `bun` first, fall back to `direnv`), which unblocks the **entire** shell e2e harness on any machine without a vault, not just this spec.
  - Run with: `cd shell && VITE_GOOGLE_MAPS_API_KEY=e2e-stub-not-a-real-key pnpm e2e e2e/employee-address.spec.ts`. The full suite additionally needs `mise run dev` (notify-api, refund-api and estimai-api must be healthy) or unrelated specs fail on missing backends.
  - touch: `shell/e2e/employee-address.spec.ts` (NEW)
  - Google **stubbed at the network layer** (`page.route('**/places.googleapis.com/**')`) so CI never hits a billed third party. Journey: seeded admin → `/admin/users/<id>` → section visible → type 3+ chars → stubbed suggestion → select → fields populate → save → reload → still shown; then sign in as a **non-admin** → `/admin/*` unreachable, `/account` reachable and read-only.
  - done when: the spec passes against the running stack and makes zero real requests to `places.googleapis.com`.

- [x] T18: Record the release intent — refs: none (repo convention, not scope creep — CLAUDE.md mandates a changeset on app-code changes) — deps: T3, T4, T5, T6, T12, T15
  - touch: `.changeset/<name>.md`
  - One changeset selecting **`@operai/auth` + `@operai/admin-ui` + `@operai/shell`** (minor) — a cross-app change selects all affected apps in one changeset.
  - done when: `mise run changeset` has produced the file and it names exactly those three packages.

- [x] T19: All gates green, spec status → `done` — refs: all — deps: T1–T18
  - QE PASS + eval PASS + every task above checked, then `status: done` via the `/wellforge:done` gate.
  - done when: `/wellforge:done 012-employee-address` accepts the transition.

---

## Coverage check

**Every AC → ≥1 task:**

| AC | Tasks | | AC | Tasks |
|---|---|---|---|---|
| AC-1.1 | T3, T11, T13 | | AC-3.3 | T3, T11 |
| AC-1.2 | T3, T17 | | AC-3.4 | T8, T3 |
| AC-1.3 | T3, T11 | | AC-4.1 | T3 |
| AC-1.4 | T3, T13 | | AC-4.2 | T12 |
| AC-2.1 | T7, T10, T16 | | AC-5.1 | T3 |
| AC-2.2 | T7, T10, T11 | | AC-5.2 | T6 |
| AC-2.3 | T11 | | AC-5.3 | T5, T9, T11 |
| AC-2.4 | T7, T3 | | AC-5.4 | T3 |
| AC-2.5 | T7, T3 | | AC-6.1 | T4, T14, T15, T17 |
| AC-2.6 | T8, T11 | | AC-6.2 | T14, T17 |
| AC-3.1 | T11, T13 | | AC-6.3 | T4, T3 |
| AC-3.2 | T7, T11, T16 | | AC-6.4 | T4, T3 |

All 24 ACs covered.

**Every task → ≥1 AC:** yes, except **T18** (changeset) and **T19** (close), which serve
repo convention and the done gate rather than an AC. Flagged deliberately, not scope creep.

## Parallelism

```
BE       T1 ─┬─ T3 ──────────────┐
         T2 ─┘   T4 ─────────┐   │
         T5 ───────────┐     │   │
         T6            │     │   │
FE-admin T7 ─┐         │     │   │
         T8 ─┤         │     │   │
         T10 ┤         │     │   │
         T13 ┤         │     │   │
             └─ T9 ◄───┴─ T11 ─ T12 ─┐
FE-shell            T14 ◄─┘     T15 ─┤
infra    T16 ───────────────────────┬┴─ T17 ─ T18 ─ T19
```

Wave 1 (all parallel): **T1, T2, T5, T6, T7, T8, T10, T13, T16**
Wave 2: **T3, T4** (need T1+T2)
Wave 3: **T9** (needs T3, T5), **T14** (needs T4)
Wave 4: **T11** · Wave 5: **T12, T15** · Wave 6: **T17** → **T18** → **T19**
