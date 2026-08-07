---
spec: 012
status: approved
approved: 2026-08-04
---

# Plan: Employee address — admin-managed, autocomplete-assisted capture

> **Audit posture — resolved at the plan gate (2026-08-04).** The AC-5.2 drift
> raised by this plan's first draft (`auth`'s `audit_log` has no database-level
> immutability) was decided by the user in favour of **amending the spec**:
> AC-5.2 now requires **application-level immutability only**, and `audit_log` is
> reused **entirely unchanged**. No trigger, no FK change, no rework of existing
> audit code or test teardown. See
> `## Data model → Audit mechanism: verification and the AC-5.2 resolution`.

---

## Architecture

### Shape

Three apps change; no new service, no new datastore, no new remote.

| App | What it gains |
|---|---|
| `auth` | A new 1:1 `employee_address` table owned by the User profile; an admin read/write pair under the existing `/admin/users/*` gate; a self-only `GET /me/address`; a filter on the existing audit read route. **`audit_log` and the `AuditLog` model are not modified at all.** |
| `admin-ui` | An **Address** section on the existing `UserDetail` screen (Screen C2), with Google Places (New) suggestion-assisted entry and an inline change-history panel. Its first `import.meta.env.VITE_*` variable (the Maps browser key). |
| `shell` | A new, un-gated `/account` route ("My profile") rendering the employee's own read-only address, reached from the existing `UserMenu` dropdown. |

Nothing is added to `refund-api`, `refund-ui`, `notify-api`, or `estimai-*`.

### Interaction flow

```
 admin-ui  UserDetail ▸ AddressSection
    │  (usePermissions/getMe → roles.includes('admin'))  ── AC-4.2: render or don't
    │  shell/session apiFetch  ──────────────────────────▶  auth  GET/PUT /admin/users/:id/address
    │  shell/session apiFetch  ──────────────────────────▶  auth  GET /admin/audit?targetType=user&targetId=…
    │  (lazy, on first focus) Maps JS API ───────────────▶  Google Places API (New)
    │        AutocompleteSuggestion.fetchAutocompleteSuggestions()
    │        place.fetchFields({addressComponents, location})
    ▼
 shell  /account ▸ AccountScreen
       shell/session apiFetch  ─────────────────────────▶  auth  GET /me/address
```

### Why this shape

- **`auth` owns the data.** Settled by the spec's Constraints. This is a deliberate
  departure from **ADR-0023** (which kept refund-domain mileage-rate data *out* of
  `auth`): a home address is an identity/profile attribute of the person, not
  refund-domain data. ⇒ ADR candidate #1.
- **The authorization gate is the existing `admin` role gate, not a new catalog
  permission.** Verified in code: every `/admin/*` route in `auth` is gated by
  `requireAdmin` (`auth/src/auth/auth.middleware.ts`), a **direct `user_role`
  membership check** against `ADMIN_ROLE_NAME` — *not* a `catalog_resource`/
  `catalog_action` permission. There is no `user:edit` catalog entry; `auth`'s
  catalogs (`auth/src/authz/catalogs/estimai.ts`, `refund.ts`) declare only the
  estimai and refund resources. So "the EXISTING admin user-management capability
  that already governs editing users, roles, and departments" = **`requireAdmin`
  / direct membership of the `admin` role**. This satisfies the Constraint's "no
  new catalog permission is introduced" literally — nothing is added to the
  catalog at all. (Deliberate contrast with **ADR-0028**, which *did* mint a new
  `settings` catalog resource — that was for a **refund-api** surface, which has
  no `requireAdmin` equivalent and must resolve capabilities over HTTP per
  ADR-0014. `auth` is the authority itself and needs no such indirection.)
- **The admin UI is the existing Users section**, per the Constraints — a new
  section on `admin-ui/src/pages/UserDetail.tsx`, alongside Attributes / Direct
  roles / Departments, each of which is already an independently-saved block.
  Same pattern, one more block.
- **The self-view lives in the `shell`, not in any remote** — see
  `## Architecture → Where US-6 lives` below.
- **admin-ui reaches `auth` exactly as it already does**: `shell/session`'s
  `apiFetch` + `getAuthBaseUrl()` (`admin-ui/src/lib/adminApi.ts`'s established
  contract, ADR-0001/ADR-0006). No new transport, no new trusted origin (the auth
  origin is already trusted in `shell/src/lib/session.ts`). The
  `getRefundApiBaseUrl()` precedent from ADR-0023 is **not** needed here — that
  exists because admin-ui calls a *sibling resource server*; this feature calls
  `auth`, whose origin admin-ui already sources from the shell.

### Where US-6 lives — the scope-relevant call

**The `shell` owns the employee self-view.** A new route `/account`, child of
`shellRoute`, with **no `beforeLoad` app-access guard** — structurally identical
to `/notify` (`shell/src/router.tsx`'s `notifyRoute`, ADR-0009) and for the
identical reason:

1. **An employee may hold zero app grants.** `createToolAccessBeforeLoad` sends
   such a user to `/no-access`. If the self-view lived in `admin-ui` (admin-only),
   `refund-ui`, or any other remote, an employee without that tool's `access`
   grant could never reach their own personal data — which defeats the GDPR
   transparency purpose the spec states outright (US-6). Only a shell route is
   reachable by *every* signed-in user, unconditionally.
2. Identity/session is the shell's domain under **ADR-0006**; the address is an
   identity attribute served by `auth`, the same service `shell/session` already
   talks to.
3. It is **not** listed in `shell/src/lib/tools.ts`'s `TOOLS`, so it never appears
   in the permission-filtered Sidebar — exactly like `/notify`. Entry point is a
   new "My profile" item in the existing `UserMenu` dropdown (which already shows
   the user's name/email — this *is* "the suite's existing view of their own
   profile" AC-6.1 refers to; nothing else in the suite qualifies).

**Honest trade-off:** this makes the shell render a *data* screen for the first
time (today it renders chrome + `NoAccessScreen`). That mildly broadens ADR-0006's
"the shell owns shared chrome + session". Accepted, bounded: the screen is
read-only, identity-scoped, and calls exactly one endpoint. ⇒ ADR candidate #4.
**Rejected alternative:** a new `profile-ui` remote — enormously
disproportionate for one read-only paragraph, and it would inherit the same
app-access problem unless also un-gated.

### Files

```
auth/
  prisma/schema.prisma                                (+ EmployeeAddress model ONLY — AuditLog untouched)
  prisma/migrations/<ts>_employee_address/            (new table + CHECKs; nothing else)
  src/admin/userAddress.routes.ts                     NEW  admin read/write
  src/admin/userAddress.routes.test.ts                NEW
  src/profile/address.routes.ts                       NEW  GET /me/address
  src/profile/address.routes.test.ts                  NEW
  src/profile/address.format.ts                       NEW  formatted-address derivation (pure)
  src/profile/address.format.test.ts                  NEW
  src/profile/address.schema.ts                       NEW  zod shapes shared by both routers
  src/authz/audit.ts                                  (+ optional targetType/targetId/action filter — NOTHING else)
  src/authz/audit.routes.ts                           (+ filter query params)
  src/authz/audit.routes.test.ts                      (+ AC-5.2 verb-absence cases, AC-5.3 filter cases)
  src/authz/audit-immutability.contract.test.ts       NEW  AC-5.2 (application-level)
  src/index.ts                                        (+ 2 router registrations)

admin-ui/
  src/components/AddressSection.tsx                   NEW  the editor (+ history panel)
  src/components/AddressSection.test.tsx              NEW
  src/lib/addressApi.ts                               NEW  typed client (auth origin)
  src/lib/addressApi.test.ts                          NEW
  src/lib/googlePlaces.ts                             NEW  loader + suggest/details + mapping
  src/lib/googlePlaces.test.ts                        NEW
  src/lib/addressCoordinates.ts                       NEW  the pure AC-2.6 rule
  src/lib/addressCoordinates.test.ts                  NEW
  src/lib/addressCopy.ts                              NEW  IT/EN copy constants
  src/pages/UserDetail.tsx                            (+ mount AddressSection)
  .env.example                                        (+ VITE_GOOGLE_MAPS_API_KEY)

shell/
  src/components/AccountScreen.tsx                    NEW  (mirrors NoAccessScreen.tsx)
  src/components/AccountScreen.test.tsx               NEW
  src/components/UserMenu.tsx                         (+ "My profile" item)
  src/lib/profileApi.ts                               NEW  getMyAddress()
  src/router.tsx                                      (+ /account route)
  src/router.account.test.tsx                         NEW
  e2e/employee-address.spec.ts                        NEW

infra/README.md                                       (+ Google Maps key provisioning + referrer restriction
                                                       + audit-redaction runbook note, see R5)
```

Release: one Changesets entry selecting **`@operai/auth` + `@operai/admin-ui` +
`@operai/shell`** (minor), per CLAUDE.md's cross-app-change rule.

---

## Data model

### `EmployeeAddress` — a 1:1 table, not columns on `User`, not JSONB

```prisma
/// Employee home address (specs/012). One current address per user, or none —
/// the ROW's existence is the "address on file" flag (Domain language). There
/// is deliberately no history table: superseded values live only in `audit_log`
/// (US-5). Cascades on user delete; production deletion is soft (ADR-0012), so
/// this only ever fires for hard deletes (tests/fixtures).
model EmployeeAddress {
  userId String @id
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  // The four REQUIRED structured components (AC-1.4). NOT NULL *is* the
  // "all four or none" guarantee — see rationale below.
  countryCode String // ISO 3166-1 alpha-2, upper-case; CHECK ~ '^[A-Z]{2}$'
  city        String
  street      String
  houseNumber String // a STRING: "12b", "1/A", "s.n.c." are all real

  // OPTIONAL components — never a reason a save is rejected (AC-1.4).
  postalCode String?
  region     String? // canton / state / province / administrative_area_level_1

  // Coordinates — captured ONLY from a selected suggestion (AC-2.5), cleared on
  // a subsequent hand-edit (AC-2.6). Both-or-neither, enforced by CHECK.
  latitude  Decimal? @db.Decimal(9, 6)
  longitude Decimal? @db.Decimal(9, 6)

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  // Plain column, deliberately NOT a FK — same reasoning as
  // User.deletedByUserId: the authoritative record is the audit_log row.
  updatedByUserId String?

  @@map("employee_address")
}
```

`User` gains exactly one line: `address EmployeeAddress?`.

> **Scope guarantee.** The `AuditLog` model is **not touched**: no new column, no
> changed FK, no changed `onDelete` behaviour, no relation change. `audit_log`
> keeps `actorUserId` with `ON DELETE SET NULL` and its `actor` relation exactly
> as they are today.

**Migration** (`prisma/migrations/<ts>_employee_address/migration.sql`) — the
**only** migration this feature adds. Additive, no backfill, no rewrite of `user`,
**no statement touching `audit_log`**:

```sql
CREATE TABLE "employee_address" (
    "userId"          TEXT NOT NULL,
    "countryCode"     TEXT NOT NULL,
    "city"            TEXT NOT NULL,
    "street"          TEXT NOT NULL,
    "houseNumber"     TEXT NOT NULL,
    "postalCode"      TEXT,
    "region"          TEXT,
    "latitude"        DECIMAL(9,6),
    "longitude"       DECIMAL(9,6),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,
    CONSTRAINT "employee_address_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Hand-appended raw SQL (Prisma cannot express CHECKs), same convention as
-- refund-api's migrations and auth's own invitation partial index.

-- AC-1.4: a required component may not be blank/whitespace either.
ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_required_nonblank"
  CHECK (btrim("city") <> '' AND btrim("street") <> '' AND btrim("houseNumber") <> '');

ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_country_alpha2"
  CHECK ("countryCode" ~ '^[A-Z]{2}$');

-- AC-2.5/2.6: coordinates are a pair or nothing.
ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_coords_paired"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL));

ALTER TABLE "employee_address" ADD CONSTRAINT "employee_address_coords_range"
  CHECK ("latitude" IS NULL
         OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180));
```

#### Why a 1:1 table — and what was rejected

The spec's Constraint ("new fields alongside the entity/department/job-title
attributes `auth` already records") settles **which service owns the data and
that it is a profile attribute**. Physical schema is a plan decision; a 1:1
user-owned table *is* the User profile. Reasons:

1. **"All four required or none", atomically, at the DB level.** With a separate
   table this is `NOT NULL` — the strongest, simplest possible expression. With
   columns on `user` it would need a 9-clause `CHECK ((a IS NULL AND b IS NULL
   AND …) OR (a IS NOT NULL AND b IS NOT NULL AND …))` that must be hand-edited
   correctly every time a component is added. `NOT NULL` cannot be got wrong.
2. **"No address on file" vs. partially-populated is structural**, not a
   convention: row absent = none; row present = complete by construction. There
   is no representable partial state.
3. **Least exposure of PII by default.** Address columns on `user` would be
   returned by any future `db.user.findMany()` that forgets a `select` — and
   `user` is read on every session resolution and in `GET /admin/users`. In a
   separate table the address is invisible unless a caller explicitly `include`s
   it. For home addresses under GDPR that default matters.
4. **`user` is a better-auth-managed table.** It already carries five
   Operai-added columns; adding nine more of unrelated PII increases friction on
   any future better-auth schema regeneration. Keeping the address out of it
   keeps that seam clean.
5. Clearing (AC-1.3) is a single `delete` — no multi-column null-out that could
   partially fail.

**Rejected — columns on `User`:** loses (1)–(4); the only gain is avoiding one
join on two low-traffic endpoints. Not worth it.

**Rejected — a JSONB blob on `User`** (the ADR-0004 shape): ADR-0004's JSONB is
right for an *opaque, client-owned document* (an estimate). This is the opposite:
six server-validated, individually-required scalar fields with per-field
validation messages (AC-1.4 must name *which* field is missing) and DB-level
completeness/range invariants. JSONB gives up every constraint in the migration
above and buys nothing.

**Rejected — an append-only address-history table** (the ADR-0024/ADR-0027
shape): explicitly forbidden by both the spec's Non-goals ("no admin-browsable
history of prior addresses beyond whatever the audit trail preserves") and its
Constraints ("does NOT introduce a new, dedicated self-auditing table").

#### `formatted` is derived, never stored

The spec's Domain language defines the formatted address as **"derived from its
structured components"**. It is therefore computed on read, never persisted — a
stored copy could drift from its components, the exact failure class ADR-0019
avoids (regenerable cache, not source of truth) and ADR-0013 establishes as this
suite's posture.

One implementation only: `auth/src/profile/address.format.ts`.

```ts
formatAddress(a: AddressComponents, locale: 'it' | 'en'): string
// segments, joined with ", ", empty segments dropped:
//   1. `${street} ${houseNumber}`
//   2. [postalCode, city].filter(Boolean).join(' ')     // CH/IT order: "8001 Zürich"
//   3. region ?? —
//   4. regionDisplayName(countryCode, locale)           // Intl.DisplayNames
// Fallback: if Intl.DisplayNames is unavailable or returns undefined, emit the
// raw `countryCode`. Never throws.
```

`locale` is negotiated from the request's `Accept-Language` header (`it` → `it`,
anything else → `en`). `Accept-Language` is a CORS-safelisted request header the
browser sends automatically, so no client change is needed. The client **never**
composes this string — one implementation, zero drift.

#### Money/precision note

Coordinates are **not** money; ADR-0025's integer-micros rule does not apply.
`DECIMAL(9,6)` gives ~0.11 m resolution and covers both ranges (`180.000000` = 9
digits). Transported as JSON numbers (a double represents 6 dp exactly at these
magnitudes); the server quantizes any inbound value to 6 dp before storing.

---

### Audit mechanism: verification and the AC-5.2 resolution

**The facility.** `auth/src/authz/audit.ts` — `withAudit({ affectedUserIds,
mutate, entry })` opens one Prisma transaction, runs the domain mutation, writes
one `audit_log` row (`actorUserId`, `action`, `targetType`, `targetId`,
`summary`, `data`, `createdAt`), and bumps `permissionEpoch` for the affected
users. Read side: `listAuditLog()` + `GET /admin/audit`
(`auth/src/authz/audit.routes.ts`), `requireAdmin`-gated, reverse-chronological,
paginated. **This feature reuses all of it verbatim.**

| AC | Existing mechanism | Verdict |
|---|---|---|
| **AC-5.1** actor / timestamp / employee / old→new | `actorUserId`, `createdAt`, `targetType:'user'` + `targetId:<employeeId>`, `data:{before,after}` — the exact shape `PATCH /admin/users/:id` already writes for `user.update_attributes` | ✅ **satisfied, no change** |
| **AC-5.3** chronological history viewable | `GET /admin/audit` exists and is admin-gated, but has **no filter parameters** — it can only page the whole trail. Needs additive `?targetType=&targetId=&action=` query params; the covering index `@@index([targetType, targetId])` already exists | ✅ **satisfiable — small additive change**, no mechanism change |
| **AC-5.4** no-op writes nothing | Route-level concern: read-before-write compare, then skip `withAudit` entirely. (Note: today's `PATCH /admin/users/:id` writes unconditionally — the address route must not copy that.) Mirrors specs/011's read-before-append (ADR-0027) | ✅ **satisfiable in the new route** |
| **AC-5.2** immutability | **Application-level only**, as amended 2026-08-04. Satisfied as-is: `audit.ts` exports no mutating function, `audit.routes.ts` registers no mutating verb, and **no production code path** updates or deletes an audit row | ✅ **satisfied by the amended AC — see below** |

#### The finding that led to the amendment (retained — the evidence is correct and worth keeping)

The first draft of this plan raised AC-5.2 as **DRIFT**, on the following
verified evidence, preserved here so no future reader has to rediscover it:

- **`audit_log` has no database-level immutability.**
  `grep -riE "trigger|rule|revoke|raise exception"` across **all three** existing
  `auth/prisma/migrations/*/migration.sql` files returns **zero** matches. The
  table is created with columns, three indexes and one FK — nothing more.
- Its immutability is **by convention**: `auth/src/authz/audit.ts`'s module
  comment states *"There is deliberately no update/delete path for `audit_log`
  anywhere in this module"*, and `audit.routes.ts` states *"There is
  intentionally no PATCH/PUT/DELETE route anywhere in this router"*.
- The application's Prisma client nonetheless retains full `UPDATE`/`DELETE`
  rights on the table, and **six call sites exercise them today** — all of them
  test or fixture teardown: `authz/audit.test.ts`, `auth/auth.config.test.ts`
  (×2), `invitations/invitations.routes.test.ts`, `admin/users.routes.test.ts`,
  and `scripts/e2e-invite-fixtures.ts` (which also hard-deletes users).
- This is a weaker tier than the suite's **ADR-0018** pattern (append-only at the
  *database* level via a raising `BEFORE UPDATE/DELETE` trigger), reused verbatim
  by **ADR-0024** (`mileage_rate`) and **ADR-0027** (`refund_setting`).
  `auth`'s `audit_log` predates all three and never received it.

#### Resolution — decided by the user at the plan gate, 2026-08-04

**Option C was chosen: amend the spec.** AC-5.2 now requires **application-level
immutability only**. `audit_log` is reused **entirely unchanged**.

Concretely, and bindingly for whoever implements this:

- **No** immutability trigger, and **no** migration touching `audit_log`.
- **No** change to `AuditLog.actorUserId` — it keeps its FK and `ON DELETE SET
  NULL`.
- **No** change to `listAuditLog()`'s `include: { actor: … }` — it stays exactly
  as it is. (The batched-lookup rework proposed in the first draft existed *only*
  to make the FK survive a trigger; with no trigger, it has no purpose.)
- **No** rework of the six test/fixture teardown paths — `db.auditLog.deleteMany`
  in tests and fixtures stays.
- The specs/004 + specs/006 audit trail is **not** retroactively hardened.
- The only change this feature makes to the audit area is the **additive read
  filter** on `GET /admin/audit` for AC-5.3.

**Options considered and declined:**

- **Option A — add the ADR-0018 trigger to `audit_log`.** Declined by the user.
  It would have required dropping the `actorUserId` FK (an `ON DELETE SET NULL`
  cascade is an `UPDATE`, which the trigger would abort — silently turning
  `SetNull` into `Restrict` and making any user with audit history physically
  undeletable), reworking `listAuditLog()`, and rewriting six teardown paths;
  and it would have retroactively hardened the entire specs/004+006 trail, well
  beyond this feature's scope. **This plan does not instruct anyone to build it.**
  The analysis is preserved, in full, in **ADR candidate #3** as the documented
  escalation path should the assurance level ever need raising.
- **Option B — a new sibling `employee_address_audit` table with its own
  trigger.** Declined: directly contradicts the spec's Constraints ("reuses the
  existing audit mechanism … does NOT introduce a new, dedicated self-auditing
  table in the shape of ADR-0024 or ADR-0027").

**Accepted residual:** the address-change trail — which now carries *personal
data*, not only authorization changes — is protected by convention and tests, not
by the database. Tracked as **R1** (integrity / tamper-evidence) and **R5** (the
GDPR-erasure face of the same fact), and named explicitly for the owasp review.

---

## API contracts

All errors are RFC 7807 Problem JSON (`type`/`title`/`status`/`detail`/`instance`),
per the service-wide convention, with a `code` extension member where a caller
must distinguish causes (precedent: ADR-0026's `self_approval_forbidden`,
ADR-0029's `accounting_distribution_email_unconfigured`). Dates are ISO 8601.

### Status-code posture — does ADR-0005's "not yours = 404" apply?

**No.** ADR-0005/ADR-0014's 404-instead-of-403 rule is a *record-level ownership*
rule in resource servers, to avoid leaking a record's existence. Here the denial
is a **role gate on a surface**, and `requireAdmin` already answers that case
with a documented, deliberate **403** ("there is nothing about a specific
resource's existence to hide; every authenticated user knows `/admin/*` exists"
— `auth/src/auth/auth.middleware.ts`). This feature does not deviate from the
surrounding admin API:

| Case | Status |
|---|---|
| No session | `401` |
| Authenticated, not an `admin` | `403` (`requireAdmin`) |
| Admin, `:id` unknown **or soft-deleted** | `404` (mirrors every other `/admin/users/:id` route) |
| Admin, four-field completeness fails | `422` + `code: "address_incomplete"` + `missingFields` |
| Malformed JSON / wrong types / over-length | `400` (router `defaultHook`) |

### Shared shapes

```ts
type AddressInput = {
  countryCode: string   // required, /^[A-Z]{2}$/ after upper-casing
  city:        string   // required, trimmed, 1..200
  street:      string   // required, trimmed, 1..200
  houseNumber: string   // required, trimmed, 1..32
  postalCode?: string | null   // optional, trimmed, 1..32
  region?:     string | null   // optional, trimmed, 1..200
  latitude?:   number | null   // optional, -90..90,  quantized to 6dp
  longitude?:  number | null   // optional, -180..180, quantized to 6dp
}

type AddressView = AddressInput & {
  formatted: string            // derived server-side (see Data model)
  updatedAt: string            // ISO 8601
}

type AdminAddressView = AddressView & { updatedByUserId: string | null }
```

> **Validation split — deliberate, and load-bearing for AC-1.4.** The zod schema
> validates **shape/type/length only**; all four required components are declared
> `.optional()` there. The four-field completeness check is **handler logic**,
> after trimming. Reason: if the zod schema declared them required, an *absent*
> field would produce a `400` from the router `defaultHook` while a *blank* field
> would produce the handler's `422` — two different errors for the same user
> mistake. With the split, absent / `""` / `"   "` all produce **one** uniform
> `422` naming exactly which of the four is missing, which is what AC-1.4 asks
> for.

### Admin surface

Mounted in a new `auth/src/admin/userAddress.routes.ts`, exporting
`userAddressRouter`, which **must** carry its own gate line:

```ts
userAddressRouter.use("/admin/users/*", sessionMiddleware, requireAuth, requireAdmin);
```

(Kept out of the already-1168-line `users.routes.ts` for file hygiene; the cost
is that the gate must be re-declared. `userAddress.routes.test.ts` asserts a
non-admin gets `403` on **both** routes, so a forgotten middleware line can never
ship — this is the single highest-consequence mistake available in this feature.)

#### `GET /admin/users/{id}/address`

```jsonc
// 200
{ "userId": "usr_…", "address": null }
// or
{ "userId": "usr_…",
  "address": {
    "countryCode": "CH", "city": "Zürich", "street": "Bahnhofstrasse",
    "houseNumber": "12b", "postalCode": "8001", "region": "Zürich",
    "latitude": 47.370200, "longitude": 8.539700,
    "formatted": "Bahnhofstrasse 12b, 8001 Zürich, Zürich, Switzerland",
    "updatedAt": "2026-08-03T09:12:44.123Z",
    "updatedByUserId": "usr_admin"
  } }
```
`401` / `403` / `404`.

#### `PUT /admin/users/{id}/address`

One endpoint for set **and** clear — no separate `DELETE`. AC-1.3 frames clearing
as *a save*, an explicit `null` is unambiguous (unlike all-empty strings), and a
single write path means one audit path and one no-op check instead of two.
Mirrors specs/011's nullable-value clear (ADR-0027).

```jsonc
// request
{ "address": { /* AddressInput */ } }   // set or replace
{ "address": null }                      // AC-1.3 — intentional clear
```

```jsonc
// 200 — same body as GET
// 422 — AC-1.4
{ "type": "https://httpstatuses.com/422", "title": "Unprocessable Entity",
  "status": 422,
  "detail": "Address is incomplete: city, houseNumber are required.",
  "instance": "/admin/users/usr_…/address",
  "code": "address_incomplete",
  "missingFields": ["city", "houseNumber"] }
```

Handler algorithm:

1. `requireAdmin` (middleware).
2. Load target: `404` if absent **or** `deletedAt !== null` (matches every other
   `/admin/users/:id` route's soft-delete posture).
3. Load current `employee_address` row (the "before" value).
4. If `address === null` → target state is "no address on file".
   Else: trim every string, upper-case `countryCode`, quantize coords to 6 dp;
   run the four-field completeness check → `422` + `missingFields` on failure.
   Coordinates: if exactly one of lat/lng is present → treat both as absent
   (the DB CHECK is the backstop, but the API normalizes rather than 400s).
5. **AC-5.4 no-op guard:** semantic-compare before vs. after across all eight
   fields (`null` and absent are the same value; `Decimal` compared numerically).
   Identical ⇒ **return `200` with the unchanged body, write nothing, no audit
   row, no `updatedAt` bump.**
6. Otherwise, inside `withAudit` (**used exactly as it exists today — no change
   to `audit.ts` beyond the AC-5.3 read filter**):
   - `tx.employeeAddress.upsert(...)` or `tx.employeeAddress.deleteMany({where:{userId}})`
   - `entry = { actorUserId, action: "user.address.set", targetType: "user",
     targetId: id, summary: \`Updated address for ${email}\`,
     data: { before: <components|null> + formatted(en), after: <same> } }`
   - **`affectedUserIds: []`** — an address change does not change permissions.
     `withAudit` already skips the epoch bump for an empty array (verified), so
     no consumer's permission cache is needlessly invalidated. This is the one
     place this feature deliberately diverges from every other `withAudit`
     caller, and it is correct.

   The audit `data` snapshot carries the structured components **and** an
   English-locale `formatted` rendering. An audit record is a stable historical
   fact and must not be re-rendered per viewer locale.

#### `GET /admin/audit?targetType=&targetId=&action=&page=&pageSize=` — AC-5.3

Additive optional filters on the **existing** route — the only change this
feature makes to the audit area. `listAuditLog()` gains an optional `where` built
from them (covering index `@@index([targetType, targetId])` already exists); its
`include: { actor: … }` and every other line stay untouched. admin-ui's Address
section calls it with `targetType=user&targetId=<id>&action=user.address.set`.
Ordering stays newest-first, consistent with the existing `/audit` screen.

### Employee self surface — AC-6.1/6.2/6.3/6.4

New `auth/src/profile/address.routes.ts`:

```
GET /me/address     sessionMiddleware + requireAuth   (NO requireAdmin)
```

```jsonc
// 200
{ "address": null }
{ "address": { "countryCode": "CH", "city": "…", "street": "…", "houseNumber": "…",
               "postalCode": "…", "region": "…",
               "latitude": 47.3702, "longitude": 8.5397,
               "formatted": "…", "updatedAt": "2026-08-03T09:12:44.123Z" } }
// 401
```

Three structural guarantees, deliberately baked into the URL shape:

- **AC-6.4 — no `:id` parameter exists.** The handler resolves `c.get("user")!.id`
  and nothing else. There is no request a caller can construct that names another
  employee. This is the exact rationale `/authz/me` already documents ("there is
  no `:id` — a caller can only ever resolve their OWN"). Asking for a colleague's
  address via the admin route hits `requireAdmin` → `403`.
- **AC-6.3 — no write verb exists at `/me/address`.** `PUT`/`POST`/`PATCH`/
  `DELETE` fall through to `app.notFound()` → RFC 7807 `404`. Attempting the
  admin route on one's own id hits `requireAdmin` → `403` (AC-4.1 explicitly
  covers "including their OWN"). Both paths are tested.
- **`updatedByUserId` is deliberately omitted** from this response — the data
  subject's transparency right does not extend to learning which admin edited
  their record. Least exposure.

A soft-deleted user cannot reach this endpoint at all (ADR-0012 revokes sessions
and blocks re-sign-in), so no extra `deletedAt` branch is needed; a defensive
`404` on `deletedAt !== null` is added anyway.

---

## Google Maps autocomplete — the API surface, and where the key lives

### Which API surface

**Places API (New)**, via the Maps JavaScript API:

- Suggestions: `google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions()`
- Details: `placePrediction.toPlace()` then `place.fetchFields({ fields: ['addressComponents','location'] })`

**Place Details is mandatory, not optional** — autocomplete returns only
predictions (text + placeId). AC-2.2 needs the structured components and AC-2.5
needs lat/lng; both come only from Details.

**Rejected — the legacy `Autocomplete` / `AutocompleteService` classes:** Google
closed them to new customers from 1 March 2025; building new code on them is
building on a dead surface.

**Rejected — the `PlaceAutocompleteElement` web component:** it renders
Google-owned DOM inside our page, which fights this repo's design-system and
a11y posture (design.md: "every new interactive element is a native
`<button>/<select>/<input>/<a>`"), and makes AC-2.3 ("pre-fills, never locks")
and AC-3.2 ("no stuck-loading state") behaviours Google's to define rather than
ours to test. We keep our own `<input>` + `<ul role="listbox">` and call the
service directly.

### Browser-direct, **not** an `auth` proxy — decision and rationale

**Decision: the admin's browser calls Google directly**, with a referrer-restricted,
API-restricted, quota-capped browser key. `auth` gains **no** new endpoint, **no**
new outbound dependency, and **no** new secret.

Weighed against an `auth`-side proxy:

| | Browser-direct (chosen) | `auth` proxies |
|---|---|---|
| **Key exposure** | Public key. Restricted by HTTP referrer + API-restriction (Places API New only) + daily quota cap + budget alert. Risk is **quota/billing theft, not data** | Secret, server-side, IP-restricted. Genuinely better on this axis |
| **Session-token billing** | The JS SDK mints and consumes `AutocompleteSessionToken` correctly by construction — N keystroke calls + 1 Details call bill as **one** "Autocomplete (per session)" SKU | We must generate a UUID, thread it through every proxied call, and terminate it on Details **by hand**. Get it wrong and billing silently flips to per-request |
| **AC-3.2 (never block/hang)** | A Google outage is purely client-side: `AbortController` + a 3 s cap, degrade to manual entry. **Zero server impact** | A Google outage/timeout consumes `auth` connections. **The identity service on the critical path of the entire suite degrades because a maps API is slow.** Unacceptable failure mode |
| **Responsibility** | admin-ui owns its own third-party UX dependency | `auth` — the identity/session/authorization service — becomes a third-party text-search proxy. Exactly the responsibility creep **ADR-0023** pushed back on, and a free authenticated Places proxy for any signed-in user unless separately rate-limited |
| **GDPR** | Google sees the typed fragment **and** the admin's IP/browser context | Google sees the typed fragment from an EU server IP. Marginally better; **both** transfer the address text to Google either way |

The GDPR delta is the proxy's only real win, and it is a *marginal* one — the
address text reaches Google in both designs; only the admin's IP differs.
Mitigations that close most of that gap without a proxy:

- The Maps SDK is **lazy-loaded on first focus of the address field**, never at
  app load — an admin who never opens the address section causes zero contact
  with Google, and the SDK cannot observe them elsewhere in the suite.
- Only the typed fragment is sent. No user id, no employee identity, no email.
- The section is only rendered for admins (AC-4.2), so the surface is a handful
  of wellD staff.

**Residual risks R2/R4/R6 below track the key-restriction and quota exposure.**

### Configuration

| Var | Where | Notes |
|---|---|---|
| `VITE_GOOGLE_MAPS_API_KEY` | **`admin-ui`** — its `.env.example`, `.env.local`, and its Vercel project env | admin-ui's **first** `import.meta.env.VITE_*`. A remote's own Vite build inlines its own env, so this works exactly like the shell's `VITE_AUTH_URL`. |

**Rejected — putting the key in `shell/session` behind a `getGoogleMapsApiKey()`**
mirroring ADR-0023's `getRefundApiBaseUrl()`: that precedent exists for **service
origins the shell configures for the whole suite**. A third-party credential used
by exactly one component of one remote does not belong in a module every remote
imports.

**Google Cloud console setup** (new `infra/README.md` section; the existing
`GOOGLE_CLIENT_ID/_SECRET` OAuth item lives in 1Password → `AIScream / OperAI -
GOOGLE OAuth`, a new sibling item holds this key):

1. Enable **"Places API (New)"** *specifically* (not the legacy "Places API") and
   **"Maps JavaScript API"** on the wellD Cloud project.
2. Create a **browser key**. **Application restriction = HTTP referrers.**
3. **⚠ The referrer list must contain the SHELL's origins, not admin-ui's.**
   admin-ui runs as a federated remote *inside the shell's document*, so the
   `Referer` on every Google call is the **top-level** URL:
   `https://operai.welld.io/*` (production) + `http://localhost:5173/*` (dev) +
   the shell's Vercel preview pattern. Listing admin-ui's own origin instead
   fails **100 %** of requests — and, because AC-3.2 makes the feature degrade
   silently, it fails *invisibly*. See risk **R2**.
4. **API restriction:** this key may call **Places API (New) + Maps JavaScript
   API only**. Never the OAuth credentials, never an unrestricted key.
5. Set a **daily quota cap** and a **budget alert** on the project.
6. 1Password reference wired through `admin-ui`'s deploy env (the key is not a
   `.envrc`/direnv value — it is a build-time frontend var, like every other
   `VITE_*`).

### Request contract — spelled out, not left to feel

`admin-ui/src/lib/googlePlaces.ts` exports a small, fully unit-testable module.

| Parameter | Value | Why |
|---|---|---|
| **Minimum characters** | **3** (after trim). Below 3 ⇒ no request, suggestions cleared | AC-2.1 "at least a few characters" |
| **Debounce** | **300 ms** of input idleness | one request per pause, not per keystroke |
| **In-flight supersession** | Every pending request is aborted (`AbortController`) when a newer keystroke fires; a stale response is discarded by request-sequence number | no out-of-order suggestion flicker |
| **Per-request timeout** | **3000 ms** ⇒ treated as "no suggestions" | AC-3.2: never a hanging spinner |
| **Max rendered** | 5 | |
| **Session token** | One `AutocompleteSessionToken` per editing session; minted on first keystroke, passed to every `fetchAutocompleteSuggestions`, **consumed** by the terminating `place.fetchFields`; a new token after each selection or after 3 min idle | correct per-session billing |
| **`includedPrimaryTypes`** | `['street_address','route','premise','subpremise']` | excludes businesses/POIs. A **type** filter — not geographic |

> **Correction (2026-08-07).** This row originally read `['address']`, which is a
> **legacy** Autocomplete `types` value that Places API (New) rejects outright:
> `400 INVALID_ARGUMENT — "Invalid included_primary_types 'address'"`. Because
> AC-3.2 mandates silent degradation, the failure was invisible — every
> suggestion request 400'd and the field simply never suggested anything, with no
> error shown. `googlePlaces.test.ts` asserted the legacy value, so it locked the
> defect in rather than catching it; a unit test can prove the request *shape*
> but never that Google accepts it. Replacement verified against the live API:
> `['street_address']` alone returns nothing for a partial street query, and
> `['geocode']` offers cities (which can never satisfy AC-1.4's house-number
> rule), so the four street-level types above are the correct set. AC-2.4 was
> re-verified — a UK address still resolves.
| **`locationBias`** | rectangle `{ west: 5.9, south: 35.4, east: 18.6, north: 47.9 }` (covers CH + IT incl. Sicily/Sardinia) | **AC-2.4** |
| **`includedRegionCodes`** | **MUST NOT BE SET.** ⚠ | See below |
| **`language`** | the UI locale (`it`/`en`) | |
| **Details field mask** | `['addressComponents','location']` **only** | minimal billing tier; nothing else is needed |

> **⚠ `includedRegionCodes` is a RESTRICTION, not a bias.** Setting
> `includedRegionCodes: ['CH','IT']` would make every non-CH/IT address
> **unreachable**, directly violating AC-2.4 ("the admin can still scroll to and
> select an address in ANY other country; the ranking bias never prevents a
> non-CH/IT address from being entered and saved"). Only `locationBias` is
> permitted. `googlePlaces.test.ts` asserts the constructed request object
> contains `locationBias` and **does not** contain `includedRegionCodes` — a
> regression test for the single easiest way to break this feature's most subtle
> AC.

### Component mapping (AC-2.2)

| Our field | Google `addressComponents` | Notes |
|---|---|---|
| `countryCode` | `country` → `shortText` | ISO alpha-2 |
| `city` | `locality` → `postal_town` → `administrative_area_level_3` → `administrative_area_level_2` (first present) `longText` | IT comune is often `administrative_area_level_3` |
| `street` | `route` → `longText` | |
| `houseNumber` | `street_number` → `longText` | **often absent** — see below |
| `postalCode` | `postal_code` → `longText` | optional |
| `region` | `administrative_area_level_1` → `longText` | optional |
| `latitude`/`longitude` | `place.location.lat()` / `.lng()`, quantized to 6 dp | AC-2.5 |

**Known, tested edge case:** a route-level prediction carries **no
`street_number`**. The field is left empty, the admin types it, and until they do
the save returns `422 missingFields:["houseNumber"]`. That is exactly AC-1.4's
required behaviour, and it is asserted in both `googlePlaces.test.ts` and
`AddressSection.test.tsx` so nobody "fixes" it later by silently accepting an
incomplete address.

### AC-2.6 — the coordinate-staleness rule, as a contract

Expressed as a **pure function**, so it has a real unit test rather than living
in scattered component state:

```ts
// admin-ui/src/lib/addressCoordinates.ts
coordinatesForSave(
  current:  AddressComponents,          // what's in the form right now
  snapshot: AddressComponents | null,   // components as they were when the suggestion was applied
  coords:   { lat: number; lng: number } | null,
): { latitude: number; longitude: number } | { latitude: null; longitude: null }
// Returns the coords ONLY when `snapshot !== null` and every one of the six
// component values is byte-identical to `current`. Otherwise (null, null).
```

Belt **and** braces: the editor also clears `coords` from state eagerly the moment
any component input's `onChange` produces a value differing from the snapshot, so
the UI cannot even hold a stale pair; `coordinatesForSave` is the single decision
point at submit. AC-3.4 falls out for free — never having selected a suggestion
means `snapshot === null` ⇒ `(null, null)`.

**Honest limitation:** the server cannot verify this — it has no way to know
whether the components were hand-edited after a lookup. Bounded consequence: a
client bug yields plausible-but-stale coordinates on a record with **no
downstream consumer at all** (Non-goals: coordinates drive nothing in this
feature). Tracked as **R7**.

### Failure modes (AC-3.1/3.2)

| Failure | Behaviour |
|---|---|
| SDK script fails to load (key missing/invalid/blocked, offline) | The section renders as a **plain manual form with no suggestion affordance at all** — no error banner, no retry loop, one `console.warn`. Fully editable, fully savable. |
| Suggestion request errors / times out / rate-limited (`OVER_QUERY_LIMIT`) | Suggestion list is emptied and hidden. **No error surfaced**, no spinner left running, input never disabled. |
| Details fetch fails after a selection | The prediction's text is dropped, components are left as typed, **no coordinates recorded**, no error. Admin completes by hand. |
| `auth` `PUT` fails | *That* is a real error — surfaced inline exactly like the existing Attributes/Roles/Departments save errors on this page. Never conflated with a suggestion failure. |

The last row is the AC-3.2 invariant made structural: suggestion failures write
to a separate state slot from save failures, and only the save slot can render an
error.

---

## Test strategy

Every AC below maps to a concrete, named test. Levels: **unit** (pure function /
isolated module), **integration** (real Hono app + real Postgres for `auth`;
React Testing Library + mocked module boundary for UI), **e2e** (Playwright
against the running suite, `shell/e2e`).

> **Count note:** the spec contains **24** ACs (US-1: 4, US-2: 6, US-3: 4, US-4: 2,
> US-5: 4, US-6: 4), not 22. All 24 are mapped.

| AC | Level | Owning suite / file | What proves it |
|---|---|---|---|
| **AC-1.1** admin sees formatted address or "no address on file" | integration + integration(UI) | `auth/src/admin/userAddress.routes.test.ts`; `admin-ui/src/components/AddressSection.test.tsx` | `GET` returns `address: null` for an untouched user and a populated `AddressView` (with correct `formatted`) after a set; the section renders the formatted string, and the "no address on file" copy for `null` |
| **AC-1.2** save persists, survives reload | integration | `auth/src/admin/userAddress.routes.test.ts` | `PUT` then a **fresh** `GET` returns byte-identical components; a second `PUT` replaces in place (still exactly one row for that `userId`) |
| **AC-1.3** intentional clear → "no address on file" | integration + integration(UI) | same two files | `PUT {"address":null}` on a populated user ⇒ `200 {address:null}`, row gone, **and** an audit row written (distinguishing a clear from a validation failure, which writes none) |
| **AC-1.4** four-field completeness names the missing field(s); postal/region never a reason | integration | `auth/src/admin/userAddress.routes.test.ts` | Table-driven: each of the four absent / `""` / `"   "` ⇒ `422` + `code:"address_incomplete"` + exact `missingFields`; and a save with **both** `postalCode` and `region` omitted ⇒ `200` |
| **AC-2.1** live suggestions from a few chars, no reload, no search button | unit | `admin-ui/src/lib/googlePlaces.test.ts` | Fake timers: 2 chars ⇒ zero calls; 3 chars ⇒ one call after 300 ms; rapid typing ⇒ one call, earlier ones aborted |
| **AC-2.2** selection pre-fills all components + formatted | unit + integration(UI) | `googlePlaces.test.ts`; `AddressSection.test.tsx` | Fixture `addressComponents` → mapped object (incl. the `locality`→`postal_town`→`admin_area_3` fallback chain); selecting a suggestion populates all six inputs |
| **AC-2.3** hand-edits after a selection are what persist | integration(UI) | `AddressSection.test.tsx` | Select suggestion, edit `city`, save ⇒ the request body carries the **edited** value; no input is `readOnly`/`disabled` after selection |
| **AC-2.4** CH/IT ranked first, any country still selectable | unit | `googlePlaces.test.ts` | Asserts the request object **has** `locationBias` (the CH+IT rect) and **does not have** `includedRegionCodes`; plus an integration assertion that a `FR` address saves normally (`auth/src/admin/userAddress.routes.test.ts`) |
| **AC-2.5** selection captures lat/lng | unit + integration | `googlePlaces.test.ts`; `userAddress.routes.test.ts` | Details fixture → coords quantized to 6 dp; `PUT` with coords round-trips through `GET` |
| **AC-2.6** hand-edit after selection discards coords | **unit** | `admin-ui/src/lib/addressCoordinates.test.ts` | `coordinatesForSave` truth table: identical snapshot ⇒ coords; any one component differing ⇒ `(null,null)`; `snapshot===null` ⇒ `(null,null)`. Plus an `AddressSection.test.tsx` case: select → edit street → save ⇒ body has `latitude:null,longitude:null` |
| **AC-3.1** no suggestions ⇒ manual entry still saves | integration(UI) | `AddressSection.test.tsx` | Suggest returns `[]` ⇒ inputs remain editable, save succeeds |
| **AC-3.2** service down/slow/rate-limited ⇒ no broken or stuck state, save unaffected | integration(UI) | `AddressSection.test.tsx` | Three cases — loader rejects, suggest rejects, suggest never resolves past the 3 s cap. Each asserts: no `role="alert"` rendered, no busy/spinner element left mounted, inputs enabled, and a subsequent save returns `200` |
| **AC-3.3** never touching suggestions ⇒ accepted on identical terms | integration + integration(UI) | `userAddress.routes.test.ts`; `AddressSection.test.tsx` | A purely typed address produces the same `200` and the same stored row as a suggestion-derived one |
| **AC-3.4** manual save succeeds with no coordinates | unit + integration | `addressCoordinates.test.ts`; `userAddress.routes.test.ts` | `snapshot===null` ⇒ `(null,null)`; `PUT` with both coords null ⇒ `200`, row has `latitude IS NULL` |
| **AC-4.1** server denies a non-admin view/change — **including their own** | **integration** | `auth/src/admin/userAddress.routes.test.ts` | A signed-in non-admin gets `403` on `GET` **and** `PUT`, both against a colleague's id **and against their own id**. Also: no session ⇒ `401` |
| **AC-4.2** section not shown at all to a non-capable viewer | integration(UI) | `admin-ui/src/pages/UserDetail.test.tsx` | With `getMe()` returning `roles: []`, the address section is **absent from the DOM** (`queryByTestId('address-section')` is `null`) — not merely disabled; with `roles:['admin']` it renders |
| **AC-5.1** audit captures actor/timestamp/employee/old→new | integration | `auth/src/admin/userAddress.routes.test.ts` | After set / change / clear, the `audit_log` row has `actorUserId`, `createdAt`, `targetType:'user'`, `targetId:<employee>`, `data.before`, `data.after`; `before` is `null` on first set and `after` is `null` on clear |
| **AC-5.2** immutable at the **application** level (AC as amended 2026-08-04) | **unit (source/module contract) + integration (HTTP)** | `auth/src/authz/audit-immutability.contract.test.ts` (**NEW**) **and** `auth/src/authz/audit.routes.test.ts` (**extended**) | **(a) Module surface — "the audit module exposes no update/delete path":** `Object.keys(await import("./audit")).sort()` equals exactly `["listAuditLog","withAudit"]`. **(b) Production source — "no production code path updates or deletes an audit record":** a static scan of `auth/src/**/*.ts` yields **zero** matches for `/\bauditLog\s*\.\s*(update\|updateMany\|delete\|deleteMany\|upsert)\b/` and for `/(UPDATE\|DELETE\|TRUNCATE)\s+(FROM\s+)?["']?audit_log/i`, **excluding** `**/*.test.ts`, `src/test-setup.ts`, and `src/lib/generated/**` (the Prisma client, which necessarily *defines* those delegate methods). `scripts/**` and `prisma/generated/**` fall outside the `src/**` scan root; the test asserts that root explicitly so a future widening cannot silently pull in `scripts/e2e-invite-fixtures.ts`. **Test and fixture teardown is expressly OUT OF SCOPE of this assertion** — the six existing `deleteMany` callers are exempt by construction, per the amended AC. **(c) API surface — "no mutating verb":** authenticated **as an admin** (so a 404 proves route-absence rather than being masked by the auth gate), `POST`/`PUT`/`PATCH`/`DELETE` on both `/admin/audit` and `/admin/audit/{id}` each return `404` RFC 7807 Problem JSON, while `GET /admin/audit` in the same test returns `200` — proving the 404s are method-specific, not a broken path |
| **AC-5.3** chronological history viewable per employee | integration + integration(UI) | `auth/src/authz/audit.routes.test.ts` (extended); `AddressSection.test.tsx` | Filtered `GET /admin/audit?targetType=user&targetId=…&action=user.address.set` returns only that employee's address changes, newest first, and excludes another employee's; the history panel renders who/when/old→new |
| **AC-5.4** no-op save writes no audit row | integration | `auth/src/admin/userAddress.routes.test.ts` | `PUT` the identical address twice ⇒ exactly **one** audit row; `updatedAt` unchanged by the second call. Covers the "identical but differently whitespaced/cased `countryCode`" case too |
| **AC-6.1** employee sees own address or "no address on file" | integration + integration(UI) | `auth/src/profile/address.routes.test.ts`; `shell/src/components/AccountScreen.test.tsx` | `GET /me/address` returns the caller's own record; the screen renders `formatted`, or the "no address on file" copy for `null`. **Separate case:** a *fetch failure* renders an error+retry state, **never** "no address on file" |
| **AC-6.2** self-view is read-only in its entirety | integration(UI) | `shell/src/components/AccountScreen.test.tsx` | Within the address region, `querySelectorAll('input, textarea, select, [contenteditable], button[type="submit"]').length === 0`, and no element with `role="listbox"`/`role="combobox"` |
| **AC-6.3** server denies an employee changing their own address | **integration** | `auth/src/profile/address.routes.test.ts` + `auth/src/admin/userAddress.routes.test.ts` | `PUT`/`POST`/`PATCH`/`DELETE /me/address` ⇒ `404` Problem JSON (no such route); `PUT /admin/users/<own id>/address` as a non-admin ⇒ `403` |
| **AC-6.4** employee cannot view a colleague's address | **integration** | `auth/src/profile/address.routes.test.ts` + `auth/src/admin/userAddress.routes.test.ts` | `GET /me/address` returns strictly the caller's row for two distinct fixture users (no parameter exists to ask otherwise); `GET /admin/users/<other id>/address` as a non-admin ⇒ `403` |

### AC-5.2 — what the test does and does not prove

Stated honestly, because the owasp reviewer will read it:

- **(a)** and **(c)** are *complete* proofs of their clauses: the module's runtime
  export surface and the app's live HTTP method surface are both exhaustively
  checkable.
- **(b)** is a **tripwire, not a proof.** A static regex cannot rule out an
  indirect mutation (e.g. a dynamic `db[model].delete(...)`). It catches the
  failure mode actually worth defending against — someone adding
  `auditLog.deleteMany` to a route or service module.
- The application's DB role **retains** `UPDATE`/`DELETE` grants on `audit_log`.
  Anyone with database access, or anyone willing to edit this test alongside their
  code, can still alter the trail. **That residual is the amended AC's accepted
  position**, not an oversight. Tracked as **R1**.

### e2e (`shell/e2e/employee-address.spec.ts`)

One journey, Google **stubbed at the network layer** (`page.route('**/places.googleapis.com/**')`)
so the suite never hits a billed third party in CI:

1. Seeded admin session → `/admin/users/<id>` → address section visible.
2. Type 3+ chars → stubbed suggestion appears → select → fields populate.
3. Save → reload → address still shown (AC-1.2 end-to-end through the real stack).
4. Sign in as a **non-admin** employee → `/admin/*` is not reachable; `/account`
   **is** reachable and shows the address, read-only (AC-6.1/6.2 + the un-gated
   route guarantee, which is the one thing only e2e can prove).

### Mapping completeness check

Re-run after the AC-5.2 amendment: **all 24 ACs are mapped**, each with a level
and a named owning file, and **every one of them is now passable against the real
codebase**. The previous draft's `auth/src/lib/db.audit-log-immutability.test.ts`
(written to fail until the drift was resolved) is **removed and must not be
built**. Nothing was silently downgraded: AC-5.2's test was rewritten to match
the amended AC, which the user approved explicitly.

---

## Risks

| # | Risk | Mitigation / early check |
|---|---|---|
| **R1** | **Audit assurance for `audit_log` is application-level only** — a deliberate, user-decided (2026-08-04) departure from the suite's DB-level tier (ADR-0018/0024/0027), now applied to a table that carries **personal-data** changes, not just authorization changes. There is no tamper-evidence: a code change, a Prisma console, or direct DB access can silently alter or erase an employee's address history | Accepted by decision, not by omission. `audit-immutability.contract.test.ts` (AC-5.2) is the regression tripwire; no production path mutates `audit_log` today. The two-tier posture is recorded in **ADR candidate #3** so a future engineer does not assume suite-wide uniformity, and the escalation path (the ADR-0018 trigger + its `actorUserId` FK consequence) is documented there with the analysis already done |
| **R2** | **Google referrer restriction must list the SHELL's origins**, because admin-ui runs inside the shell's document. Get it wrong ⇒ 100 % of suggestion requests 403 — and AC-3.2 makes that failure **silent** | Explicit in the `infra/README.md` section. Early check: after provisioning, load the **deployed shell**, open an address field, confirm a `places.googleapis.com` 200 in devtools. A dev-only `console.warn` on `REQUEST_DENIED` makes the silent failure visible to developers |
| **R3** | `includedRegionCodes` is one autocomplete keystroke away from `locationBias` and would violate AC-2.4 invisibly (non-CH/IT addresses simply never appear) | `googlePlaces.test.ts` asserts the request object **lacks** `includedRegionCodes`. Called out as a MUST-NOT in the API-contract table |
| **R4** | The browser key is public; referrer restrictions are spoofable by a non-browser client ⇒ quota/billing theft | API-restriction to Places API (New) only, hard **daily quota cap**, budget alert. Accepted residual: this is a **billing** risk, not a data one — the key grants nothing but address lookups |
| **R5** | **GDPR erasure vs. the audit trail — the tension is INVERTED by the AC-5.2 decision.** With no DB-level guard, a subject-erasure request *can* now be honoured by redacting or removing the `data.before/after` payloads of the affected `audit_log` rows. That is a genuine operational **benefit** over Option A, which would have made those values permanently unremovable (exactly as ADR-0018 intends for financial records). The residual problem is **procedural, not technical**: no redaction procedure exists today, so an ad-hoc `UPDATE`/`DELETE` by an operator leaves no record of who redacted what, when, or why — and the same missing guard makes an *unauthorised* redaction equally invisible (that side is **R1**) | Document a short audit-redaction runbook alongside the existing operational notes in `infra/README.md`: who may perform it, that it targets a specific enumerated `audit_log.id` set, and that the act itself is recorded **out-of-band** (ticket / DPA log) — the trail cannot record its own redaction. Flag to the owasp reviewer as a **process gap with a technical enabler**, not a code defect |
| **R6** | Places API (New) must be enabled *specifically*; a project with only the legacy "Places API" enabled returns `REQUEST_DENIED` for the new endpoints | Early check, before any UI work: enable both APIs and verify one `places:autocomplete` call succeeds with the provisioned key |
| **R7** | AC-2.6 is enforced **client-side only**; the server cannot detect stale coordinates | Bounded: coordinates have **no downstream consumer** (Non-goals). Contained in one pure, unit-tested function rather than component state |
| **R8** | `Intl.DisplayNames({type:'region'})` availability in Bun's ICU for the country segment of `formatted` | `address.format.test.ts` asserts both a real name **and** the raw-code fallback path. The function never throws |
| **R9** | A route-level Google prediction supplies no `street_number`, so a "successful" selection still can't be saved | Expected and asserted (AC-1.4 / AC-2.2 tests). The UI focuses the empty `houseNumber` field after such a selection |
| **R10** | `admin-ui`'s first `VITE_*` env var must be set on its **Vercel project**, not the shell's; a missing value silently disables suggestions | `.env.example` documents it; the loader's absence path is the tested graceful-degradation path (AC-3.2), so a missed env var degrades rather than breaks. Listed in the `infra/README.md` variable reference |
| **R11** | `admin-ui` has no i18n runtime; the Constraints require IT + EN copy | Copy lives in one `admin-ui/src/lib/addressCopy.ts` module with `{ it, en }` pairs (the shape `auth/src/invite/invite.routes.ts` already uses). Introducing an i18n runtime for admin-ui is out of scope and flagged as a pre-existing, app-wide gap — **not** created by this feature |
| **R12** | `userAddressRouter` re-declares its own `requireAdmin` gate (it is a new file, not part of `usersRouter`); omitting that one line silently exposes every employee's home address | The AC-4.1 test asserts `403` for a non-admin on **both** verbs. This is the single highest-consequence line in the feature and is called out in the API-contract section |

---

## Security

**SECURITY-SENSITIVE: YES.** Schedule an `owasp-reviewer` pass in parallel with QE.
Because this is **personal data of employees under GDPR/nLPD** (home addresses,
plus geolocation) in a **regulated-adjacent internal tool**, escalate that review
to the **frontier tier**. The AC-5.2 amendment does **not** lower that bar — if
anything it raises the value of the review, since the trail recording changes to
this personal data is now protected by convention and tests rather than by the
database.

Every one of the standard triggers is present:

- **PII / personal data** — an employee's home address and coordinates. Special
  care: this is data about *staff*, held by their *employer*.
- **A new authorization gate on a new write path** — `PUT /admin/users/:id/address`
  mutates one user's personal data on behalf of another.
- **A third-party API** — Google Places (New), reached from the browser with a
  public key, receiving the address text as it is typed.
- **A cross-privilege read boundary** — the same underlying record is exposed
  through an admin-gated route *and* a self-only route with different fields.
- **A deliberately application-level-only audit trail** that now carries
  personal-data changes (decided 2026-08-04; see R1 / R5).

### Surfaces to review, named

| Surface | Focus |
|---|---|
| `auth PUT /admin/users/{id}/address` | **A01 Broken access control** — is `requireAdmin` actually applied to this new router (R12)? Soft-deleted target handling. Mass-assignment: only the eight declared fields are read from the body. |
| `auth GET /admin/users/{id}/address` | A01 — same gate; `404` vs `403` posture consistency. |
| `auth GET /me/address` | **A01** — strictly self-scoped by construction (no `:id`); verify no query/header can widen it. **A03** — verify `updatedByUserId` is genuinely absent from this response. |
| `auth GET /admin/audit?targetType&targetId&action` | A01 (admin-gated) + **A03 injection** — the filters are Prisma-parameterized `where` values, never string-interpolated SQL. |
| **`auth` audit trail: `audit_log` + its `data` payload** | **A09 security-logging & monitoring failures — the headline item for this review.** The before/after snapshot now embeds employee home addresses in a table with **no database-level immutability** (deliberate, user-decided 2026-08-04). Assess: (i) is the application-level guarantee — no mutating export, no mutating route, no production mutation path, enforced by `audit-immutability.contract.test.ts` — adequate for personal-data change history? (ii) the absence of tamper-evidence (**R1**); (iii) the absence of a documented redaction procedure for subject-erasure requests (**R5**). The escalation path (ADR-0018 trigger + the `actorUserId` FK consequence) is fully analysed in ADR candidate #3 if the reviewer judges the current tier insufficient. |
| `admin-ui AddressSection` + `googlePlaces.ts` | **A02/A05** — key restriction posture; **data minimization** (lazy load, fragment-only payloads); XSS on rendering Google-returned strings (React escapes by default — verify no `dangerouslySetInnerHTML`); the suggestion list's a11y/keyboard semantics. |
| `admin-ui` build/deploy env | **A05 misconfiguration** — the key must be referrer- and API-restricted and quota-capped **before** first production deploy. |
| `shell AccountScreen` + `/account` route | **A01** — the route is deliberately **un-gated for app-access** (by design, mirroring `/notify`); confirm it is still under `_authed` and that the screen can render only the caller's own data. |
| `shell/src/lib/profileApi.ts` | Confirm it goes through `apiFetch` (trusted-origin Bearer attach, ADR-0001) and never through bare `fetch`. |

### Data residency

Satisfied without change: the address is persisted only in `auth`'s existing
EU-region PostgreSQL. **No new datastore, no new region, no new secret in `auth`.**
The one *outbound* transfer to a non-EU processor is the Google Places lookup —
address text only, from the admin's browser, with no user identifier attached,
and only while an admin is actively typing in the address field. That transfer is
a Constraint of this feature ("Address autocomplete is provided via Google Maps"),
is minimized as described above, and is called out here explicitly so the review
assesses it rather than discovers it.

---

## ADR candidates

*Written by the `adr-writer` agent, not here. Listed in the order they should be
decided.*

1. **Employee address is an `auth`-owned identity/profile attribute, stored in a
   1:1 `employee_address` table** — an explicit, reasoned **departure from
   ADR-0023** (which kept refund-domain data out of `auth`). Fixes for the future:
   what belongs in `auth` vs. a domain service (test: "is this an attribute *of
   the person*, or data *about a domain transaction*?"); that `NOT NULL` on a 1:1
   table is this suite's way to express "all-or-none required component groups";
   and that a derived rendering (`formatted`) is computed on read, never stored
   (ADR-0013/ADR-0019 lineage). Also records that the admin gate is the **existing
   `admin` role / `requireAdmin`**, with **no new catalog permission** — the
   deliberate counterpoint to ADR-0028.

2. **Google Places API (New), browser-direct with a referrer-restricted key —
   never proxied through `auth`.** Fixes: no third-party proxy inside the identity
   service, ever (it would put a third party's latency on the suite's critical
   path); a federated remote's Google referrer restriction is the **shell's**
   origin; `locationBias` for regional preference and **never**
   `includedRegionCodes`, which is a restriction; graceful silent degradation is
   the required posture for every optional third-party enrichment in this suite.

3. **The Operai suite deliberately runs TWO tiers of audit assurance.**
   *(Replaces the first draft's Option-A-conditional candidate, which no longer
   applies.)*

   - **Tier 1 — database-level immutability**, via a raising
     `BEFORE UPDATE/DELETE` trigger, for financial and governance records:
     `refund_audit_entry` (ADR-0018), `mileage_rate` (ADR-0024),
     `refund_setting` (ADR-0027).
   - **Tier 2 — application-level immutability only**, for `auth`'s `audit_log`:
     the audit module exports no mutating function, the audit router registers no
     mutating verb, and no production code path mutates the table — with
     `auth/src/authz/audit-immutability.contract.test.ts` as the regression
     tripwire. Test and fixture teardown are **expressly exempt**.

   **Decided by the user at specs/012's plan gate, 2026-08-04**, when this feature
   extended `audit_log`'s contents from authorization changes to **employee
   personal data** and thereby forced the question. The corresponding AC (012's
   AC-5.2) was amended to match rather than the code being changed to meet it.

   **The escalation path, recorded so it is inherited rather than rediscovered.**
   Raising `audit_log` to Tier 1 means adding the ADR-0018 trigger verbatim — and
   it carries one non-obvious prerequisite: `AuditLog.actorUserId` is
   `ON DELETE SET NULL`, and an FK-initiated `SET NULL` is an **`UPDATE`** that a
   `BEFORE UPDATE` trigger will abort. Left in place it silently converts
   `SetNull` into `Restrict`, making any user with audit history physically
   undeletable. The fix is to drop the FK and keep `actorUserId` as a plain,
   unconstrained column — the precedent already exists one model away
   (`User.deletedByUserId`: *"deliberately NOT a FK relation, so a deleted actor
   never blocks referential integrity here"*) and in `RefundAuditEntry`
   (`actorUserId`/`actorEmail` as plain columns). `listAuditLog()`'s
   `include: { actor }` would then become a batched `user.findMany` lookup
   (response shape unchanged, so `AuditPage` is unaffected), and six existing
   test/fixture teardown paths would need rework
   (`authz/audit.test.ts`, `auth/auth.config.test.ts` ×2,
   `invitations/invitations.routes.test.ts`, `admin/users.routes.test.ts`,
   `scripts/e2e-invite-fixtures.ts`). **Triggers for revisiting:** a
   regulatory/DPA requirement for tamper-evident personal-data change history, or
   `audit_log` gaining financial-decision records.

   **Recommendation: YES — write this ADR** (rather than leaving it as a plan/risk
   note only). It is not "a decision to change nothing": the status quo was
   previously *unexamined*, and this decision makes it *examined, deliberate, and
   scoped to a table that now holds personal data*. The specific failure mode an
   ADR prevents is concrete — a future engineer reading ADR-0018 (which states it
   is "the reusable pattern for future financial/governance records in the suite")
   will reasonably infer suite-wide uniformity, and will then either wrongly
   harden `audit_log` (rediscovering the FK trap and six broken teardown paths
   from scratch) or, worse, wrongly *rely* on a database guarantee that does not
   exist. This repo already uses ADRs for exactly this shape — **ADR-0026**
   records an exception to ADR-0005/0014's 404 posture, **ADR-0029** amends
   ADR-0021 — and only `docs/adr/` and its CLAUDE.md mirror are read by people who
   are not already inside `specs/012/`. R1/R5 are necessary but not sufficient:
   they are discoverable only from this feature's folder.

4. **The shell may own identity-scoped, non-tool screens** (`/account`),
   extending ADR-0006's "shell owns shared chrome + session" and mirroring
   ADR-0009's un-gated `/notify` placement. Fixes the rule for the future: any
   screen that **every signed-in user must be able to reach regardless of
   app-access grants** belongs to the shell, is a child of `shellRoute` with no
   `beforeLoad` access guard, and is absent from `TOOLS`.

---

*Plan approved by the user at the plan gate on 2026-08-04, conditional on the
AC-5.2 resolution recorded above. The Product Owner is amending `spec.md`'s AC-5.2
in parallel to require application-level immutability only; this plan is written
against that amended AC.*
