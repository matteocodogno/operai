---
spec: 009
status: approved
---

# Plan: Mileage rate — computed amounts for travel-km expense lines

## Architecture

### Where each responsibility lives (and why this shape)

The feature has three concerns that pull toward different services. The load-bearing
decision is **rate persistence + resolution + computation belong in refund-api, not
auth**, because the effective rate is resolved on *every* draft read and *every* live
recompute (AC-1.2/1.3) — making it a cross-service call into auth on each keystroke-driven
recompute would be a hot-path dependency with no upside. refund-api already owns the money
domain (integer minor units, per-currency subtotals, the batch PDF) and already resolves
authorization live from auth (ADR-0014); the rate is one more thing it resolves locally, in
its own database, in the same query layer that reads the lines it computes against. This
mirrors ADR-0004's precedent that the service owning a domain owns its persistence.

Three surfaces, and the component that owns each:

1. **auth service — catalog + seed only (no rate data, no rate API).** auth's job is
   limited to *declaring the permission* that gates rate management: `refund`'s catalog
   (`auth/src/authz/catalogs/refund.ts`) gains a new `rate` resource with `read`/`manage`
   actions, and the seed (`auth/src/authz/seed.ts`) grants `rate:read`+`rate:manage` to the
   `admin` and `refund-admin` system roles. Nothing else in auth changes. This keeps the
   admin-ui role composer (which reads `GET /admin/catalog`, the full catalog across every
   app) automatically able to compose the new permission into any role, with zero admin-ui
   composer code change (ADR-0007 §7 — catalog is the single source of truth for grantable
   pairs).

2. **refund-api — the rate service (sole owner of data + logic).** New `rates/` feature module
   (routes/service/repo/schemas, mirroring `requests/` and `batches/`): rate-entry persistence
   (append-only), effective-rate resolution (latest `validFrom ≤ date`, per entity), the pure
   `km × rate` computation with rounding, the submit-time snapshot, and the read-time live
   recompute. Rate-management routes are gated by refund-api's existing `authzMiddleware` /
   `hasCapability` (ADR-0014) against the new `rate:read`/`rate:manage` capability resolved
   from `GET /authz/resolve` — the *same* machinery that already gates `/review/*`, no new
   secret, no new trust relationship. This ownership is unchanged by hosting the screen in
   admin-ui (see the call-path decision below).

3. **admin-ui — the rate MANAGEMENT screen (per plan-gate direction).** The rate management
   screen (per-entity history, add-entry form, in-effect highlight, audit list) is a NEW
   section inside **admin-ui** (the Admin tool), alongside Roles/Departments/Users, gated
   client-side on the `rate:manage` capability admin-ui already resolves from `GET /authz/me`.
   admin-ui becomes a cross-service caller: a new `ratesApi.ts` (mirroring `adminApi.ts`) calls
   refund-api's `/rates` endpoints. See the "admin-ui → refund-api call path" decision below
   for the chosen wiring.

4. **refund-ui — the employee/accounting line UX only (no management screen).** The employee
   mileage line (`ExpenseLineComposer` / `ExpenseLineRow`) hides amount/currency and shows the
   `km × rate = amount` breakdown; the accounting review view (`ReviewDetailPage` /
   `ExpenseLineRow` `review` mode) shows the applied rate + valid-from. refund-ui does **not**
   host any rate management surface — it only calls the employee-facing `GET /rates/effective`
   read (unchanged).

### Decision — admin-ui → refund-api call path (evaluated A vs B; chosen: A, refined)

The rate data, resolution, and money computation MUST stay server-authoritative in refund-api
(the money domain; refund-api never trusts a client-sent mileage amount, and it already
resolves authz live per ADR-0014). Hosting the screen in admin-ui therefore makes admin-ui a
cross-service caller. Options evaluated:

- **(A) admin-ui calls refund-api `/rates` directly.** Rate table + all logic stay in
  refund-api; admin-ui gains a Bearer cross-origin call to refund-api, gated on
  `rate:read`/`rate:manage`. Smallest change to the money design; cost is one new cross-origin
  dependency from admin-ui.
- **(B) proxy `/rates` through auth `/admin`** (auth re-exposes rate CRUD and forwards to
  refund-api). **Rejected:** it puts the auth service in the money path, duplicates the surface
  across two services, and requires either JWT-forwarding or the internal service token into a
  financial endpoint — exactly the ownership/logic split the constraint forbids, for no benefit
  over (A).

**Chosen: (A), refined so admin-ui ships no new build env var.** admin-ui's existing
`adminApi.ts` already imports `apiFetch` + `getAuthBaseUrl` from the federated `shell/session`
module and deliberately does NOT read its own `import.meta.env` (a remote ships no env vars —
see `adminApi.ts`'s own header comment; the shell owns each configured service origin). The new
`ratesApi.ts` follows the identical pattern: it obtains refund-api's origin from a shell-owned
getter (`getRefundApiBaseUrl()`, the refund-api analogue of the existing `getAuthBaseUrl()`;
the shell already knows refund-api's origin because refund-ui calls it) and uses the same
`shell/session` `apiFetch`, which already treats refund-api as a trusted origin and attaches
the Bearer JWT + does the 401 refresh-retry-redirect. So the *only* genuinely new pieces are:
(i) a small `getRefundApiBaseUrl()` export on `shell/session` (one-line, mirrors the auth one),
and (ii) refund-api's `ALLOWED_ORIGINS`/CORS allowlist gaining admin-ui's origin (for any
context where the browser Origin making the call is admin-ui's own — standalone/dev/preview;
when admin-ui runs composed inside the shell, the host origin is already allowed because
refund-ui calls refund-api from it). This is preferred over the coordinator's literal
"new `VITE_REFUND_API_URL` in admin-ui" framing precisely because remotes carry no env — the
base URL must come from the shell, exactly as auth's already does.

**Why refund-api still owns the data + logic (unchanged from the prior plan):** effective-rate
resolution runs on every draft read and every live recompute; the submit-time snapshot must be
computed where the money lives and never trust a client value. Moving any of that out of
refund-api — or splitting the rate table across services — is explicitly out of bounds and
brings no benefit. admin-ui hosts the *screen*; refund-api remains the sole *owner* of rate
storage, resolution, and computation.

### Interaction flow

- **Admin rate management (US-4/US-5):** from **admin-ui**'s Mileage Rates section (gated on
  `rate:manage`), the admin's browser calls refund-api `GET /rates` (history/audit) and
  `POST /rates` (append) via `shell/session` `apiFetch` (Bearer JWT, cross-origin to
  refund-api). refund-api enforces `rate:read`/`rate:manage` server-side and appends one
  immutable `MileageRate` row per add. The write never touches any line (ADR-0013): submitted
  lines are frozen because nothing rewrites them; draft lines pick it up on their next
  read/edit.
- **Employee drafting (AC-1.2/1.3, US-2):** in **refund-ui**, `ExpenseLineComposer`/
  `ExpenseLineRow`, on every km/entity/date change, calls refund-api
  `GET /rates/effective?entity=&date=` (debounced) to get the current per-km rate, computes
  `km × rate` client-side with the canonical rounding rule, and renders the breakdown live. On
  line save (`POST`/`PUT .../lines`) refund-api itself re-resolves and writes the computed cents
  to `requestedAmountCents` server-side (the client value for a travel_km amount is ignored —
  never trusted, see Security). On request *read* (`GET /requests/:id`), refund-api
  **recomputes** each draft travel_km line's amount and effective rate from *current* config, so
  a rate change with no edit is reflected on next load (AC-3.2, ADR-0013 derived-on-read).
- **Submit (US-3, the snapshot):** inside the existing submit transaction
  (`lifecycle.repo.ts`), refund-api re-resolves each travel_km line's effective rate, and if
  every line has a rate in effect and `km > 0`, writes `requestedAmountCents` + the applied-
  rate snapshot columns and flips status to `submitted`. A line with no rate in effect
  (AC-2.2) or `km ≤ 0` (AC-1.4) refuses submission with the offending line ids (reusing 007's
  `ValidationError { fields.offendingLineIds }` shape).
- **Review & batch (US-6):** because computed amounts land in the existing
  `requestedAmountCents` integer column, 007's per-currency subtotals (`computeSubtotals`) and
  008's batch PDF/totals read them unchanged — *no downstream code special-cases mileage*
  (AC-6.2/6.3). The line response gains the applied-rate detail for AC-6.4/1.8 display only.

### ADRs this plan rests on / extends

- **ADR-0004** — service-owns-its-persistence precedent (rate data lives in refund-api's DB).
- **ADR-0007** — catalog is the sole source of grantable permissions; new `rate` resource
  declared once in refund's catalog, resolved live (identity+epoch JWT, `/authz/resolve`).
- **ADR-0013** — derived-not-scheduled: effective rate computed on read, never a cron that
  "activates" an entry on its `validFrom` (spec Non-goal, verbatim).
- **ADR-0014** — refund-api is the authorization-enforcing resource server; rate routes gate
  on live-resolved capability, fail-closed on an auth outage (503) exactly as today.
- **ADR-0015** — entity-scoped ABAC. **We deliberately do NOT entity-scope rate management**
  (see Decision 2) — the contrast with accounting's entity condition is intentional and
  called out so the divergence is a decision, not an oversight.
- **ADR-0018** — DB-level append-only immutability. The new `MileageRate` table carries the
  *same* raising `BEFORE UPDATE/DELETE` trigger pattern as `refund_audit_entry`.
- **ADR-0022** — audit-trail-extension posture. Rate history is its *own* append-only table
  (it is not request-scoped, so it cannot extend `RefundAuditEntry`, which is FK'd to a
  request) — but it reuses the identical immutability mechanism (Decision in Data model).

---

## Decisions (the three spec Open Questions, resolved)

### Decision 1 — Snapshot moment: **pinned at the request's transition to `submitted`, never during draft.**

A travel_km line's computed amount is **never persisted as authoritative during draft** — it
is a derived value (server recomputes on read, client recomputes on edit). It is written and
frozen exactly once, inside the submit transaction, alongside the applied-rate snapshot
columns. Withdraw-to-draft (007 AC-2.2) **clears** the snapshot columns back to null, so the
line returns to live mode; the next submit re-snapshots against whatever is effective then.

**Why this over "pin at each draft save":** AC-3.2 requires a withdrawn-to-draft line (with
no further edit) to recompute live after a rate change. If the amount were pinned at draft
save, that stored value would go stale on a rate change with no edit — and since rate changes
never touch lines (ADR-0013, no cron), the stored value and the required live display would
diverge, forcing a reconciliation hack. Snapshot-at-submit makes both ACs fall out with no
special case: **draft ⇒ always derived-on-read (nothing stored can go stale); submitted ⇒
frozen (submit is the only writer, and it is the last write).** AC-3.1's "already-fixed amount
does not change under a rate change" holds trivially because *no rate-change code path writes
to any line*; the withdrawn-line nuance in AC-3.1 is satisfied by "re-submission re-snapshots,"
which is exactly this model.

**Blast-radius note:** `requestedAmountCents` stays a non-null `Int` (unchanged 007 column).
For a draft travel_km line it holds the last server-computed value as a denormalized cache
that the read path *overwrites* with a fresh recompute — so downstream 007/008 code that reads
the column is never handed a null, while the authoritative freeze is still the submit-time
write, marked by the applied-rate columns being non-null. The alternative (make the column
nullable for draft mileage lines) was rejected: it ripples into `isLineComplete`, `mapLine`,
`computeSubtotals`, and the batch PDF for no behavioral gain.

### Decision 2 — Permission: **a NEW catalog permission (`rate` resource, `read`+`manage` actions), global admin-only, unconditioned.**

A new `rate` resource is declared in refund's catalog with two actions:
- `rate:read` — view rate history + audit (AC-4.1/4.3/5.3),
- `rate:manage` — append a rate entry (AC-4.2), which implies read.

Both are **unconditioned** (no `entity` condition), granted to the `admin` and `refund-admin`
system roles in the seed.

**Why new, not a reused capability:** reusing an existing admin capability would conflate rate
management with unrelated grants and make it un-auditable/un-revocable in isolation. A distinct
capability follows the established pattern exactly (declare in catalog → enforce in refund-api →
compose in admin-ui) and costs almost nothing.

**Why global, not entity-scoped (contrast with ADR-0015):** admin is a global role in this
suite, there are exactly two entities, and rate-setting is a rare, high-trust policy action.
Entity-scoping (`can set CH but not IT`) would add a condition and a per-entity resolution path
to gate a two-row config surface managed by global admins — complexity with no product driver.
The entity is a field on each rate entry's body, not a scope on the capability. (`accounting`'s
entity condition exists because *many* users each see *their own* entity's requests; rate
management has neither property.)

`GET /rates/effective` (the employee live-recompute endpoint) is **not** gated by `rate:read`
— it exposes only non-sensitive policy data the employee already sees as `km × rate`. It is
gated by authentication + `refund:access` (any refund user), so a drafting employee can resolve
the rate without holding an admin capability.

### Decision 3 — Rounding/precision: **rate stored as integer *micros* of the major unit; amount = round-half-up(`km × rate`) to the entity currency's minor unit (cents); rounded at compute time, stored on snapshot.**

- **Rate representation:** stored as `ratePerKmMicros` — an integer count of `1e-6` major
  currency units per km (the well-known "micros" money scale). CHF `0.70`/km → `700000`. This
  gives 6 decimal places of headroom, comfortably covers any real mileage rate, stays
  **integer** (honoring 007's "never Decimal or float for money" posture — the rate is config,
  not a summed amount, but the same discipline applies), and is an exact power of ten so
  conversion to/from the admin's decimal input is lossless.
- **Amount computation:** both CHF and EUR use a 2-decimal minor unit (rappen / centesimi), so
  the computed amount is an integer number of cents:
  `amountCents = roundHalfUp(km × ratePerKmMicros / 10_000)`
  (because `ratePerKmMicros / 1e6` = major units, `× 100` = cents, i.e. `/ 1e4`). `km` and
  `ratePerKmMicros` are integers, so `km × ratePerKmMicros` is an exact integer; the single
  division + round-half-up is the only rounding in the whole chain (no intermediate rounding).
- **Rounding rule:** **round half up** (`Math.floor(x + 0.5)` on a non-negative value; amounts
  are always ≥ 0 since `km > 0` and rate > 0). Chosen as the conventional, easily-explained
  accounting rule; banker's/half-even rounding was rejected as surprising to non-technical
  admins and employees and unnecessary given the low stakes of a single sub-cent tie.
- **Where it rounds:** at compute time. The rounded integer cents is what is stored in
  `requestedAmountCents` on snapshot. refund-api is authoritative; refund-ui implements the
  **identical** rule (a shared `computeMileageAmountCents` mirrored in `refund-ui/src/lib/`)
  purely for live preview, and the server value always wins on save/read (see Risk R1).

---

## Data model

All changes are in **refund-api** (Prisma + PostgreSQL). Migrations are **additive** — a new
migration folder, never an edit to an existing one.

### New table: `MileageRate` (rate entry — append-only, doubles as its own audit trail)

```prisma
model MileageRate {
  id              String   @id @default(cuid())
  entity          Entity                       // welld_it | welld_ch (reuses 007's enum)
  currency        Currency                     // set server-side from entity (welld_ch→CHF, welld_it→EUR); stored explicitly for snapshot/display provenance
  ratePerKmMicros Int                          // > 0, integer micros of the major unit (Decision 3)
  validFrom       DateTime @db.Date            // effective-from; may be past/present/future (AC-4.8)
  createdByUserId String                       // JWT sub of the admin who added it (AC-5.1)
  createdByEmail  String                       // snapshot for the audit/history UI (AC-5.1/5.3)
  createdAt       DateTime @default(now())     // when added (distinct from validFrom)

  @@index([entity, validFrom])                 // effective-rate resolution: latest validFrom ≤ D per entity
  @@index([entity, createdAt])                 // chronological history/audit listing (AC-4.1/5.3)
  @@map("mileage_rate")
}
```

**Immutability (AC-4.7/5.2, ADR-0018):** the migration adds the *same* raising
`BEFORE UPDATE/DELETE` trigger pattern already used for `refund_audit_entry` — a
`mileage_rate_immutable()` function that `RAISE EXCEPTION`s, wired as
`mileage_rate_no_update` / `mileage_rate_no_delete` triggers. No update/delete route is ever
written for this model. Append-only is enforced at the database, not merely by absent routes.

**The rate table IS its own audit trail (decision, US-5).** AC-5.1 requires an audit entry
capturing actor, timestamp, entity, value, and valid-from on every rate add — *every one of
those fields already lives on the `MileageRate` row itself*, and AC-5.3's "chronological list
of every rate change" is exactly `SELECT … ORDER BY createdAt`. A rate entry is never edited
or superseded in place (policy change = a new row), so the append-only rate table *is* the
complete, immutable change history — no separate audit table, and no rows in
`RefundAuditEntry` (which is FK'd `requestId NOT NULL` and cannot represent a non-request-
scoped event). This is the deliberate ADR-0022 parallel: same immutability mechanism, separate
table because the domain object differs.

### Changed table: `RefundLine` — three new nullable snapshot columns

```prisma
// added to model RefundLine:
appliedRateMicros    Int?                              // per-km rate frozen at submit; null while draft / never-submitted / non-travel_km / pre-feature legacy
appliedRateValidFrom DateTime?    @db.Date             // valid-from of the applied rate entry (AC-6.4 display)
appliedRateEntryId   String?                           // soft provenance ref to the MileageRate row applied
appliedRate          MileageRate? @relation(fields: [appliedRateEntryId], references: [id], onDelete: Restrict)
```

- All three are **null while draft** (Decision 1) and set together inside the submit
  transaction; **cleared to null on withdraw-to-draft**.
- Non-travel_km lines: always null.
- **Legacy pre-feature submitted travel_km lines: permanently null** (this migration never
  backfills already-submitted lines — spec Non-goal, AC-1.7). The review UI must render a null
  `appliedRate` gracefully (show the stored amount, no rate breakdown) — see Risk R3.
- `onDelete: Restrict` on the FK is consistent with the append-only posture (a MileageRate that
  a line references can never be deleted — and MileageRate is never deleted anyway).
- `currency` on a travel_km line is now **entity-designated** (server forces CHF/EUR from
  `entity` on every travel_km write; the client cannot choose it — AC-1.6). Non-travel_km lines
  keep 007's independent currency field unchanged (AC-1.5).

### Migration steps (one additive migration)

1. `CREATE TABLE mileage_rate` + its two indexes.
2. `CREATE FUNCTION mileage_rate_immutable()` + `mileage_rate_no_update`/`_no_delete` triggers.
3. `ALTER TABLE refund_line ADD COLUMN appliedRateMicros / appliedRateValidFrom /
   appliedRateEntryId` (all nullable) + FK to `mileage_rate` (`ON DELETE RESTRICT`).

No data migration for existing rows (draft travel_km lines recompute on next read/save;
submitted lines are never touched).

### auth service — no schema change

Only `catalogs/refund.ts` (declaration) and `seed.ts` (grants) change. The catalog is
registered via the existing idempotent `upsertAppCatalog` full-replace on the next deploy seed.

---

## API contracts

All refund-api routes; RFC 7807 Problem JSON on error; dates ISO 8601 (`YYYY-MM-DD` for
date-only). Money amounts are integer minor units (cents), consistent with 007. The
management endpoints (`GET`/`POST /rates`) are called **cross-origin from admin-ui** via
`shell/session` `apiFetch` (Bearer JWT attached, refund-api a trusted origin); refund-api's
CORS `ALLOWED_ORIGINS` must include admin-ui's origin (see the call-path decision + Risk R8).
Authorization is enforced **server-side** regardless of which UI calls — the endpoints and
their gates are identical whether hit from admin-ui, a script, or curl.

### Rate management (gated by `rate:read` / `rate:manage`)

**`GET /rates`** → 200 — full history for both entities, current-in-effect flagged (AC-4.1/4.3;
also serves the audit view AC-5.3). `403` if the caller lacks `rate:read`.
```jsonc
{
  "entities": [
    {
      "entity": "welld_ch",
      "currency": "CHF",
      "currentEntryId": "clr_abc",          // in effect as of today, or null if none
      "entries": [                          // chronological, oldest→newest
        {
          "id": "clr_abc",
          "ratePerKmMicros": 700000,
          "ratePerKm": "0.70",              // decimal string, for display only
          "validFrom": "2026-01-01",
          "createdAt": "2026-07-20T09:12:00.000Z",
          "createdByEmail": "admin@welld.ch",
          "inEffectToday": true
        }
      ]
    },
    { "entity": "welld_it", "currency": "EUR", "currentEntryId": null, "entries": [] }
  ]
}
```

**`POST /rates`** → 201 — append one rate entry (AC-4.2). `403` without `rate:manage`; `422`
on a non-positive value or missing/invalid `validFrom` (AC-4.5). **No `PUT`/`PATCH`/`DELETE`
route exists** for a rate entry (AC-4.7 — append-only, also enforced at the DB).
```jsonc
// request
{ "entity": "welld_ch", "ratePerKm": "0.72", "validFrom": "2026-08-01" }
// server derives currency from entity; ignores any client-sent currency; sets
// ratePerKmMicros = round(0.72 * 1e6); createdBy* from the JWT.
// response: 201 { the created entry, same shape as an `entries[]` item }
```

**`GET /rates/effective?entity={welld_ch|welld_it}&date=YYYY-MM-DD`** → 200 — resolve the rate
in effect for one (entity, date), for the drafting client's live recompute (AC-1.2/1.3/2.1).
Gated by `refund:access` only (non-sensitive), called from **refund-ui** (unchanged origin).
`400` on a bad entity/date.
```jsonc
// in effect:
{ "entity": "welld_ch", "date": "2026-07-15", "currency": "CHF",
  "inEffect": true, "ratePerKmMicros": 700000, "ratePerKm": "0.70", "validFrom": "2026-01-01" }
// none configured for that (entity, date) — AC-2.2:
{ "entity": "welld_it", "date": "2026-07-15", "currency": "EUR", "inEffect": false }
```

### Existing request/line/review responses — additive change only

The `RefundLine` response (`mapLine`) gains a nested `mileage` object, present only for
travel_km lines (`null` otherwise). This is the single carrier for AC-1.8 breakdown, AC-2.2
block, AC-6.4 review display, and AC-3.x freeze state:
```jsonc
"mileage": {
  "km": 240,
  "rateInEffect": true,                 // false ⇒ UI shows "no rate configured", submit blocked (AC-2.2)
  "appliedRate": {                      // the frozen snapshot once submitted; the LIVE effective rate while draft; null if !rateInEffect or legacy
    "ratePerKmMicros": 700000, "ratePerKm": "0.70", "validFrom": "2026-01-01", "currency": "CHF"
  },
  "computedAmountCents": 16800,         // 240km × CHF0.70/km = CHF168.00 = 16800 rappen; = requestedAmountCents when rateInEffect; null if !rateInEffect
  "snapshotted": true                   // true once the request has ever been submitted (frozen); false while draft (live)
}
```
`requestedAmountCents` continues to carry the money for every line (= `computedAmountCents` for
an in-effect travel_km line) so `computeSubtotals` (007) and the batch PDF (008) need **no
change** (AC-6.2/6.3). The `POST`/`PUT .../lines` request body for a travel_km line **omits
amount/currency** (server-derived); a client-sent `requestedAmountCents`/`currency` on a
travel_km line is ignored, not honored (Security A04).

### Submit (`POST /requests/:id/submit`) — extended precondition + snapshot

Unchanged route; the service (`lifecycle.repo.ts`) additionally, inside the existing
transaction: resolves each travel_km line's effective rate; if any is not in effect (AC-2.2)
or `km ≤ 0` (AC-1.4), fails `422` with `fields.offendingLineIds` (007's existing shape);
otherwise writes `requestedAmountCents` + `appliedRate*` for each travel_km line, then flips to
`submitted`. Withdraw (`POST /requests/:id/withdraw`) additionally clears `appliedRate*` on
every travel_km line in the same transaction (Decision 1).

---

## Test strategy

Every AC mapped to a level. `unit` = pure function (Vitest, no DB/HTTP); `integration` =
refund-api route + Prisma against a test DB (existing `test-support/` harness); `component` =
UI component (Vitest + Testing Library) — **admin-ui** for the management screen (US-4/US-5),
**refund-ui** for the employee/accounting line UX (US-1/US-2/US-6); `e2e` = Playwright across
the running stack.

| AC | Level | What proves it |
|---|---|---|
| AC-1.1 hide amount/currency, show computed | component (refund-ui) | `ExpenseLineRow` travel_km render: amount/currency inputs absent, computed-amount display present |
| AC-1.2 live recompute on km change | component (refund-ui) | change km → breakdown updates from mocked `GET /rates/effective`, no save |
| AC-1.3 recompute on entity/date change | component (refund-ui) | change entity/date → re-fetch + recompute |
| AC-1.4 km ≤ 0 blocks submit | unit + integration | `isLineComplete` unchanged (unit); submit route 422 with offending id (integration) |
| AC-1.5 non-travel_km unchanged | component (refund-ui) | other type renders manual amount/currency exactly as 007 |
| AC-1.6 currency = entity currency, not selectable | unit + integration | server forces CHF/EUR on travel_km write (integration); currency select absent for travel_km (component) |
| AC-1.7 pre-existing draft line adopts computed UI; ever-submitted untouched | integration | draft travel_km read recomputes/overrides stored amount; a submitted line's stored amount/currency unchanged after read |
| AC-1.8 breakdown shown (km, rate, amount) | component (refund-ui) | breakdown renders all three, never amount alone |
| AC-2.1 latest validFrom ≤ date resolution | unit + integration | `resolveEffectiveRate` pure vectors (unit); `GET /rates/effective` picks the right entry (integration) |
| AC-2.2 no rate → shown + submit blocked | component + integration | `rateInEffect:false` renders the message (refund-ui component); submit 422 (integration) |
| AC-2.3 two entities independent | unit + integration | resolver: configuring welld_ch never affects welld_it resolution |
| AC-2.4 re-evaluate on entity/date edit | integration | draft read after date edit flips a line in/out of `rateInEffect` |
| AC-3.1 submitted line frozen under rate change | integration | submit → add backdated rate → re-read: `requestedAmountCents`/`appliedRate*` unchanged |
| AC-3.2 never-submitted / withdrawn-to-draft recomputes live | integration | draft (or withdrawn) line read after a rate change returns the new computed amount; withdraw clears `appliedRate*` |
| AC-3.3 approved/rejected/paid shows snapshot, never recomputed | integration | decided request read returns stored snapshot even after a rate change |
| AC-4.1 per-entity history, chronological | integration + component (admin-ui) | `GET /rates` ordering/grouping (integration); admin-ui Mileage Rates section renders per-entity history from mocked `ratesApi` (component) |
| AC-4.2 add entry → persisted + resolvable | integration + component (admin-ui) | `POST /rates` then resolution ≥ validFrom uses it (integration); admin-ui add-entry form submits via `ratesApi` (component) |
| AC-4.3 in-effect entry distinguished | unit + integration + component (admin-ui) | `inEffectToday`/`currentEntryId` computed (unit/integration); admin-ui highlights the current entry (component) |
| AC-4.4 future validFrom not retroactive | unit + integration | resolver ignores a future entry for an earlier date |
| AC-4.5 non-positive / bad date rejected | integration + component (admin-ui) | `POST /rates` 422, nothing persisted (integration); admin-ui form surfaces the 422 message (component) |
| AC-4.6 unauthorized denied (UI + API) | integration + component (admin-ui) | `POST`/`GET /rates` 403 without capability (integration); admin-ui hides the Mileage Rates section/route without `rate:manage` (component, mirrors admin-ui's existing `PermissionDenied` gating) |
| AC-4.7 no edit/delete, by anyone | integration + unit | no update/delete route exists; DB trigger raises on a direct `UPDATE`/`DELETE` (a `db.*-immutability` test mirroring `db.audit-immutability.test.ts`) |
| AC-4.8 backdated entry accepted, resolvable, never disturbs snapshots | integration | past validFrom accepted; changes a draft line's computed amount; leaves a submitted line frozen |
| AC-5.1 audit captures actor/ts/entity/value/validFrom | integration | created `MileageRate` row carries all five fields |
| AC-5.2 audit immutable | unit/integration | same DB-trigger test as AC-4.7 |
| AC-5.3 audit history list (both entities) | integration + component (admin-ui) | `GET /rates` returns full chronological set with `createdByEmail` (integration); admin-ui audit list renders it (component) |
| AC-6.1 approved-total editable, computed not a ceiling/floor | integration | review set-approved-total above/below computed succeeds (007 path unchanged) |
| AC-6.2 mileage in same per-currency subtotal | unit | `computeSubtotals` includes a travel_km line in its currency group (no special case) |
| AC-6.3 mileage in batch totals/PDF, no special handling | integration | compile a batch with a travel_km line; totals/PDF include its snapshot amount |
| AC-6.4 review shows applied rate + valid-from | component (refund-ui) + integration | `review`-mode row renders `appliedRate.ratePerKm`+`validFrom`; response carries them; legacy null renders gracefully |
| Rounding rule (Decision 3) | unit | `computeMileageAmountCents` shared vectors incl. half-up ties; refund-api and refund-ui produce identical results |
| Snapshot happy path + withdraw-clears (Decision 1) | integration | submit writes snapshot; withdraw nulls it; resubmit re-snapshots |
| Catalog/seed grants (auth) | unit/integration | refund catalog includes `rate:read`/`rate:manage`; seed grants them to `admin`/`refund-admin` |
| admin-ui→refund-api client wiring | unit (admin-ui) | `ratesApi.ts` uses `shell/session` `apiFetch` + `getRefundApiBaseUrl()` (mirrors `adminApi.test.ts`); base URL from the shell, not `import.meta.env` |

**AC→test mapping is total** — every AC-1.1 … AC-6.4 appears above with at least one level; the
admin ACs (US-4/US-5) are now exercised in **admin-ui component + refund-api integration**
(not refund-ui), and the three Decisions each have dedicated coverage. One follow-up e2e (not a
per-AC gap): a Playwright path exercising admin-adds-rate-in-admin-ui →
employee-drafts-and-submits-in-refund-ui → accounting-reviews, to prove the cross-service flow
end to end.

---

## Risks

- **R1 — Client/server rounding drift.** refund-ui previews `km × rate` live; refund-api
  computes authoritatively. If the two rounding implementations diverge, the previewed amount
  differs from the saved one. *Mitigation:* one canonical rule (Decision 3), a single shared
  test-vector set exercised by BOTH refund-api and refund-ui unit tests, and the server value
  always overwrites on save/read (the preview is advisory only).
- **R2 — Draft cache staleness.** `requestedAmountCents` on a draft travel_km line is a
  denormalized cache that can lag a rate change. *Mitigation:* the read path always recomputes
  for draft travel_km lines (Decision 1) and submit re-resolves — the stale cache is never the
  authoritative value at any decision point.
- **R3 — Legacy pre-feature submitted lines have null `appliedRate`.** AC-6.4's review display
  and AC-1.7 both intersect here. *Mitigation:* the `mileage.appliedRate: null` case is an
  explicit, tested render (show the amount, omit the rate breakdown); the migration never
  backfills submitted rows (spec Non-goal).
- **R4 — Currency reclassification of legacy draft lines.** A travel_km draft created under 007
  may carry `currency: USD/GBP`; forcing entity-designated currency on the next write can move
  it between per-currency subtotal groups. *Mitigation:* this is exactly AC-1.7's superseding
  behavior; covered by an integration test asserting the subtotal regroups as intended.
- **R5 — Rate added between last draft save and submit.** *Mitigation:* submit re-resolves at
  submit time, so the snapshot always uses the rate effective at the freezing instant, never a
  stale draft-save resolution.
- **R6 — Seed grant reaches production admins.** Adding `rate:manage` to the `admin` role via
  seed silently empowers every existing admin. *Mitigation:* intended (rate management is an
  admin function); the grant is idempotent and auditable, and the DB-level immutability trigger
  bounds the blast radius (no admin can rewrite history).
- **R7 — Migration trigger portability.** The raw-SQL trigger must survive `prisma migrate` on
  the EU-region Postgres. *Mitigation:* copy the proven `refund_audit_entry` trigger shape
  verbatim (same migration mechanism already in production).
- **R8 — admin-ui → refund-api cross-origin dependency (new, from the plan-gate direction).**
  Hosting the screen in admin-ui adds a second cross-origin backend dependency to admin-ui and
  a new browser origin that refund-api must trust. Three concrete failure modes and their
  mitigations: (a) **CORS** — refund-api's `ALLOWED_ORIGINS` must include admin-ui's origin, or
  the management calls fail with an opaque CORS error; mitigation: add admin-ui's origin to the
  refund-api allowlist per environment (a devops/env task, verified in the e2e), noting the
  composed-shell path already works because the host origin is allowed. (b) **Base-URL
  resolution** — admin-ui ships no env vars, so a `getRefundApiBaseUrl()` must be exported by
  `shell/session` and configured on the shell; mitigation: mirror the existing `getAuthBaseUrl()`
  exactly, unit-tested in `ratesApi.test.ts`. (c) **Bearer attachment** — `apiFetch` only
  attaches the JWT to trusted origins; mitigation: refund-api is already a trusted origin for
  the suite's apiFetch (refund-ui uses it), so no change beyond (b). Residual coupling
  (admin-ui now depends on refund-api being reachable to render one section) is accepted as the
  cost of the gate's stated preference; the section degrades to an error banner (admin-ui's
  existing `ErrorBanner`) if refund-api is unreachable, not a broken tool.

---

## Security

**Security-sensitive? YES.** This feature is financial computation + admin authorization + an
immutable audit trail — three of the highest-signal triggers. The orchestrator should schedule
an **owasp-reviewer pass in parallel with QE** (not left to discovery). This is internal-tool,
two-entity, non-PII financial policy config (not regulated-client data), so the standard tier
is appropriate — frontier escalation is not required.

Specific surfaces to review:

- **refund-api `POST /rates` (A01 Broken Access Control) — still the primary target.** An authz
  bypass lets an attacker set the reimbursement rate — direct financial impact. Authorization is
  enforced **server-side in refund-api** via `authzMiddleware`/`hasCapability` on every write,
  **regardless of which UI calls it** — hosting the screen in admin-ui does NOT move the trust
  boundary. Verify `rate:manage` is required, fails closed on an auth outage (503, ADR-0014),
  and that `createdBy*` comes from the JWT, never the body. admin-ui's client-side `rate:manage`
  gate is UX only, never the security control.
- **refund-api CORS allowlist gains admin-ui's origin (A05 Security Misconfiguration).** The new
  origin entry must be scoped to admin-ui's exact origin(s) per environment — not a wildcard,
  and not a broadening of the credentialed-CORS policy. Verify `ALLOWED_ORIGINS` feeds only the
  Hono CORS layer here (rate routes are not better-auth session-mutating), and that adding
  admin-ui does not inadvertently widen better-auth `trustedOrigins`. CORS is a defense-in-depth
  layer, never the authorization control (which is the Bearer/JWKS + capability check above).
- **Submit-time snapshot & line writes (A04 Insecure Design / A08 Data Integrity).** Verify the
  travel_km amount and currency are **always server-computed/derived** and a client-supplied
  `requestedAmountCents`/`currency` on a travel_km line is *ignored*, never trusted — an
  employee must not be able to submit a hand-picked mileage amount.
- **`MileageRate` immutability (A08 Integrity Failures).** Verify the DB-level
  `BEFORE UPDATE/DELETE` trigger blocks history rewrites even via direct DB access, and that no
  update/delete route exists (AC-4.7/5.2).
- **New catalog permission wiring (A01 privilege escalation).** Verify `rate:read`/`rate:manage`
  are declared once, granted only to intended roles, and that `GET /rates/effective`'s laxer
  `refund:access` gate exposes only non-sensitive policy data (no history, no actor identity).
- **`GET /rates/effective` (A01/A05).** Confirm it leaks nothing beyond the effective per-km
  rate for a chosen (entity, date) — no createdBy, no full history.

---

## ADR candidates

Invoke the `adr-writer` agent for these (do not write them here):

1. **Per-entity effective-dated mileage rate model + snapshot-at-submit.** The core, future-
   constraining decision: rate persistence/resolution in refund-api (not auth), effective rate
   derived-on-read (ADR-0013 lineage), and the amount frozen exactly at `submitted` with
   withdraw-clears-and-re-snapshots semantics (Decision 1). This is the reusable template for
   any future policy-driven computed amount in the suite. Includes the sub-decision that the
   management *screen* lives in admin-ui while refund-api remains the sole *owner* of the data
   + logic — i.e. admin-ui's first cross-service backend call, base URL sourced from the shell.
2. **Rate history as its own append-only, self-auditing table (ADR-0018/0022 extension).** Why a
   non-request-scoped immutable record gets its *own* table with the same DB-trigger mechanism
   rather than extending `RefundAuditEntry`, and why the append-only rate table *is* its audit
   trail (no separate audit table) — a pattern future non-request-scoped governance records will
   follow.
3. **Money precision for rates: integer *micros* alongside integer minor-unit amounts.** The
   sub-cent-rate representation (micros) and the single round-half-up-at-compute-time rule that
   bridges micros-rate × integer-km → integer-cents — extends 007's money-handling posture and
   binds every future rate-like config. (Could be folded into #1 if the caller prefers one ADR.)

The new non-entity-scoped `rate` catalog permission (Decision 2) is a deliberate contrast with
ADR-0015 but is adequately recorded inside candidate #1 — it does not need its own ADR.

## Spec amendment proposed

None. All three Open Questions were the architect's to resolve and are resolved above; no spec
statement was found to be wrong or under-specified during planning.
