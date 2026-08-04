---
spec: 012
evaluated: 2026-08-04
rubric: default-v2
score: 90
verdict: PASS
---
# Eval report: Employee address — admin-managed, autocomplete-assisted capture

No `specs/012-employee-address/eval.md` exists, so the central rubric
(`gates/configs/eval-rubric.yml`, resolved at
`/Users/matteocodogno/LAB/aiscream/wellforge/gates/configs/eval-rubric.yml`, version
`default-v2`) applies unmodified. `design.md` is present, so the conditional
`design_fidelity` dimension **applies** and all five weights sum to 100 — no
re-normalisation needed.

| Dimension | Weight | Score (/5) | Floor | Weighted | Evidence |
|---|---|---|---|---|---|
| AC satisfaction | 35 | 4 | 4 | 28.0 | All 24 ACs met. AC-4.1 ↔ `userAddress.routes.test.ts:122` (403 on both verbs, colleague **and** own id) — reproduced live on the composed app (`NON-ADMIN GET /admin/users/:id/address -> 403`). AC-1.4 ↔ table-driven `userAddress.routes.test.ts:320` (4 fields × absent/`""`/`"   "`). AC-2.6 ↔ full 6-key truth table `addressCoordinates.test.ts:26`. AC-6.3 ↔ `address.routes.test.ts:216` + observed `PUT /me/address -> 404` RFC 7807 on the composed app. Thin: AC-2.1's suggestion list has **never been observed** in any assembled app (key unprovisioned T16, e2e unrun); AC-5.3's "who" renders a raw cuid (`AddressSection.tsx:115`) |
| Spec fidelity / no drift | 20 | 4 | 3 | 16.0 | Contracts implemented exactly as `plan.md` §API contracts specifies (`affectedUserIds: []` at `userAddress.routes.ts:465`; `formatted` derived never stored, `address.format.ts:38`; no `:id` on `/me/address`). AC-5.2's amendment is honest — I independently confirmed `audit_log` has **zero** triggers, **zero** rules and retains `UPDATE`/`DELETE`/`TRUNCATE` grants, exactly as spec.md:306-316, plan.md:817-831 and ADR-0033 state. Off 5: T13's own done-when ("no literal user-facing string remains in `AddressSection.tsx`") is unmet — 3 literals remain at `AddressSection.tsx:94,115,534` while 6 declared copy keys are dead |
| Test quality | 20 | 4 | 3 | 16.0 | Ran everything: auth `68 pass / 0 fail` on the 4 feature files; admin-ui `401 pass`; shell `208 pass`. Anti-vacuity guards in `audit-immutability.contract.test.ts:118,125-126` (scan root asserted, non-empty, proven to reach `authz/audit.ts`). Adversarial cases present (query-string widening `address.routes.test.ts:197`; whitespace/case no-op `:724`; per-optional-field no-op completeness `:805`). Off 5: `shell/e2e/employee-address.spec.ts` has **never been executed**; AC-3.2 component cases 1 and 2 are byte-identical (`AddressSection.test.tsx:339,351`); T1's five DB CHECKs have no committed test |
| Code quality & conventions | 15 | 4 | 3 | 12.0 | `bun run typecheck` clean; `admin-ui pnpm lint` clean; shell's single lint error is **pre-existing** — proved by linting a `98267d0` worktree (same rule, `router.tsx:439` before → `:469` after). No `.js`/`.jsx` added; computation in pure modules not components; RFC 7807 everywhere; no `dangerouslySetInnerHTML`; mass-assignment closed by zod strip. Off 5: hardcoded UI strings (above) + two contradictory doc comments (`addressCoordinates.ts:16-19` claims eager clearing that `AddressSection.tsx:27-31` explicitly refuses to do; `addressCopy.ts:9-10` names a consumer in a different remote that cannot import it) |
| Design fidelity (UI) | 15 | 4 | 3 | 12.0 | `design.md` is essentially complete: F1–F6, every loading/empty/error/degraded state enumerated (`design.md:186-360`), a ~110-line a11y section, reuse mapped to the real inventory, and the plan↔design country mismatch caught and resolved (`design.md:399`). Realised faithfully — ARIA combobox with keyboard-only proof (`Combobox.test.tsx:157`), silent AC-3.2 state, `aria-live="polite"` coordinate line never styled as an error. Off 5: pending-clear uses `readOnly` with values retained, not design's "shown emptied and disabled"; no save spinner glyph; the history panel ignores the four `address.history.columns.*` keys it declared |
| Trajectory | 10 | 3 | 2 | 6.0 | **No `.forge/runs/*.json` trace exists for 012** (`grep "012-employee-address" .forge/runs/.events.jsonl` → 0). Git history is legible and matches plan.md's own wave order (`39ed2ee`→`96a5a6e`→`e041915`→`70e0a8b`→`f63c2a3`→`56b72eb`→`619e60f`→`01907ae`→`50eabcc`→`6147038`→`621604b`), QE demonstrably ran (`26a2673`, all four findings verified present) and OWASP too (`cf0ed86`). Held to 3, not 4: the canonical trace is absent, and T17 is checked `[x]` although its own done-when ("passes against the running stack") has never been exercised |
| **Total** | 100 | | | **90.0/100** | |

**Verdict: PASS** — 90.0 ≥ `pass_score` 80, and every applicable dimension is at or
above its floor (`ac_satisfaction` 4 = floor 4; `trajectory` 3 > floor 2).

## Findings

### 1. Hardcoded user-facing strings survive in `AddressSection.tsx` (code_quality, spec_fidelity)
CLAUDE.md's "no hardcoded strings that appear in the UI" and T13's own done-when are
both violated at three sites:

- `admin-ui/src/components/AddressSection.tsx:94` — `return 'Could not load this address.'`
- `admin-ui/src/components/AddressSection.tsx:115` — `actorUserId ?? 'Deleted user'`
- `admin-ui/src/components/AddressSection.tsx:534` — `Powered by Google`

The first is the one that bites: it is the fallback rendered for **both** the address
load failure and the history load failure, so an Italian-locale admin sees English at
exactly the moment something has gone wrong. `addressCopy.ts` already declares
`address.saveError` with both `it`/`en` values and nothing uses it. Six declared keys
are dead in total (`address.saveError`, the four `address.history.columns.*`,
`account.contactAdmin`). The `'Deleted user'` literal mirrors the pre-existing
`AuditPage.tsx:58-59` verbatim, and the Google attribution is a placeholder that
`design.md` itself routes to a branding-asset follow-up — so two of the three are
defensible; the first is not. T13 is nonetheless marked `[x]`.

### 2. The e2e journey has never run — T17's checkbox overstates its state (test_quality, trajectory)
`shell/e2e/employee-address.spec.ts` is committed and checked `[x]`, with a done-when of
"the spec passes against the running stack". It has never been executed: `op whoami`
returns `account is not signed in`, so the `auth` service its fixtures depend on cannot
start here. I verified the spec is *credible* — every selector it uses exists
(`Combobox.tsx:216,253` produce `address-street-combobox` and
`address-street-combobox-option-<id>`; `UserDetail.tsx:357` produces
`admin-user-detail-page`; `seedUserSession`/`applySessionCookie` exist at
`shell/e2e/helpers/adminSession.ts:27,56`) — but credible is not verified. The impact is
bounded because the `/account` un-gated guarantee, which plan.md called "the one thing
only e2e can prove", is in fact proven at integration level by
`shell/src/router.account.test.tsx:144` (zero granted apps → `AccountScreen` mounts), and
I independently reproduced the AC-1.2 persist/round-trip and AC-6.1/6.3 behaviour against
the composed `auth` app. Compare T16, which is honestly left `[ ]` with a "BLOCKED ON A
HUMAN" note — T17 deserved the same treatment.

### 3. AC-2.1 has no observable behaviour anywhere (ac_satisfaction)
T16's Google key is unprovisioned in every environment, and the e2e that stubs the SDK
never ran, so no assembled build of this feature has ever produced a suggestion list.
AC-2.1's evidence is entirely unit-level (`googlePlaces.test.ts:187-233` — debounce,
threshold, supersession). This is the single largest reason `ac_satisfaction` is 4 and
not 5. It is not a defect: AC-3.2's graceful degradation is the tested default, so an
unprovisioned key means the feature behaves exactly as specified rather than breaking.

### 4. AC-5.2 clause (b) is a weaker tripwire than it needed to be (test_quality)
`audit-immutability.contract.test.ts:129-138` scans **line by line**, so
`db.auditLog` followed by `.deleteMany(...)` on the next line, or a computed
`db["auditLog"]`, evades it. plan.md:824-827 and ADR-0033 both disclose the tripwire's
limits honestly and this is not an overclaim anywhere — but scanning `content` instead of
`lines[i]` was one line of code away and would have closed the multi-line evasion.
Clauses (a) and (c) are genuinely exhaustive, and the test's anti-vacuity guards
(`:118`, `:125-126`) are exactly right.

### 5. AC-5.3's "who" is an opaque id in the UI (ac_satisfaction, design_fidelity)
`listAuditLog()` already returns `actor: { id, name, email }`
(`auth/src/authz/audit.ts:173-175`), but `AddressHistoryEntry`
(`admin-ui/src/lib/addressApi.ts:63-72`) drops `actor`, so the history panel renders a
raw cuid. This matches the pre-existing `AuditPage.tsx` exactly, so it is
convention-preserving rather than new drift — but "then they see … who" is thinly served
by `cm3x9f8…j2`, and the data to do better is already on the wire.

### 6. Handled well — worth recording, not defects
- **The AC-5.2 drift was handled with unusual honesty.** I verified the code side myself:
  `pg_trigger` on the auth DB is empty, `pg_rewrite` has only Postgres internals, and the
  app role holds `INSERT/SELECT/UPDATE/DELETE/TRUNCATE` on `audit_log`. That is precisely
  what spec.md, plan.md, ADR-0033 and the contract test all say. Nothing was silently
  downgraded, and the test asserts the amended AC and not one clause more.
- **The four QE findings are all genuinely fixed**, verified by execution, not by reading:
  `PUT` with `countryCode:"CHE"` returns `422 code:"address_country_invalid"` on the
  composed app (was a 500); the no-op guard now has per-field completeness tests for
  `postalCode`, `region` and the coordinate pair (`userAddress.routes.test.ts:805`);
  `"My profile"` is `it`/`en` (`UserMenu.tsx` COPY); the Playwright env var is wired
  (`playwright.config.ts:202-215`).
- **The OWASP CSP fix is correct and load-bearing** — `shell/vercel.json` now allows
  `maps.googleapis.com` in `script-src` and both Google hosts in `connect-src`; without
  it AC-3.2's silent degradation would have hidden a 100 %-broken autocomplete in
  production. (Forward note: `img-src` still lacks `maps.gstatic.com`, which the branded
  attribution asset will need when it lands.)
- **All five DB CHECKs exist and bite.** Verified directly against the live schema:
  `employee_address_country_alpha2`, `employee_address_required_nonblank`,
  `employee_address_coords_paired`, `employee_address_coords_range` and the
  `ON DELETE CASCADE` FK are all present, and three separate violating `INSERT`s were
  rejected with SQLSTATE `23514`.
- **The 4 failing `auth` tests are not this feature's.** `bun test` gives `400 pass / 4
  fail`; all four are in `authz/seed.test.ts` and `invitations/invitations.routes.test.ts`
  — neither file is in the feature diff, and both fail on local DB state pollution
  (`Received length: 3` where a fresh DB gives 0; a unique-constraint collision on
  `invitation.email`).

## Recommended next step

**PASS** — spec 012 may move to `done` via `/wellforge:done 012-employee-address`, with
two caveats the gate should record rather than silently absorb:

1. **T16 remains genuinely open** (`[ ]`, blocked on GCP console + 1Password + Vercel
   access). Until it closes, address autocomplete is inert in every environment and
   AC-2.1 is satisfied only in unit tests. The graceful-degradation posture makes this
   safe to ship, not safe to forget.
2. **T17 should be un-checked or re-qualified.** Running
   `VITE_GOOGLE_MAPS_API_KEY=e2e-stub-not-a-real-key pnpm e2e` from `shell/` once the
   1Password vault is unlocked is the cheapest way to convert the feature's only
   full-stack proof from "written" to "passing".

Neither is a FAIL condition. The one thing worth fixing in passing, if 012 is reopened
for any reason, is finding 1 — replacing `AddressSection.tsx:94`'s hardcoded fallback
with the `address.saveError` key that already exists.
