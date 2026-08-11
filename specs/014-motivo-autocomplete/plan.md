---
spec: 014
status: approved
approved: 2026-08-11
---

# Plan: Motivo autocomplete from the employee's own past mileage lines

## Architecture

### The shape, in one sentence

`refund-api` gains ONE new parameterless, self-scoped read — `GET /line-suggestions?type=travel_km`
— that returns the caller's own `travel_km` trip signatures for the last 24 months, already
grouped, ranked and capped; `refund-ui` fetches that corpus **once per composing session** into
component memory and does the substring matching **in the browser**, so the text the employee
types never leaves the page.

### The three open questions, resolved

**D1 — Transport & computation shape: client-side matching over a server-projected corpus
(Option A), not a per-query server endpoint (Option B).**

The decisive argument is not bandwidth, it is that **AC-2.3's ranking is query-independent**.
Suggestions are ordered by group count desc, then most-recent-date desc — neither signal
depends on what was typed. So the server can compute the entire ranked list once, and the
client's per-keystroke work is a pure, order-preserving substring *filter* + `slice(0, 8)`.
Sending the query to the server on every keystroke buys nothing that a single fetch does not
already buy. Everything else follows from that:

- **Privacy (US-4, AC-4.4).** With Option A the typed motivo fragment is never transmitted at
  all — not in a URL, not in a body. Nothing an intermediary (Railway's access log, a proxy, a
  future CDN) could record. Option B would put fragments of personal free-text on the wire on
  every keystroke burst; `refund-api`'s own logger already drops query strings
  (`src/lib/logger.ts`) but the *hosting provider's* access log does not, so Option B would
  have forced a POST-with-body just to stay compliant with AC-4.4. Option A makes AC-4.4 true
  by construction rather than by log hygiene.
- **AC-4.3 (direct exercise of the mechanism).** The endpoint takes **no caller-controlled
  selector at all** beyond a single-value `type` enum. There is no `q`, no `userId`, no `id` —
  no IDOR surface and no injection surface exists to test. That is the strongest available form
  of AC-4.3.
- **AC-5.2 (silent degradation).** One failure point, and it fires *before* the employee has
  typed anything useful. A failed/timed-out/503'd corpus fetch simply leaves the corpus empty;
  an empty corpus is indistinguishable from "no trips match", which AC-1.6 already specifies as
  "no list, no message". Silent degradation is the *default* code path, not an error branch
  bolted on. With Option B every keystroke is a fresh chance to fail mid-typing, and a slow
  response arriving after the employee has moved on is a live UX hazard.
- **Per-keystroke cost.** Option A: 1 request per composing session (+1 lazily after each
  successful line add, D6). Option B: 3–6 requests per motivo at a 300 ms debounce, each
  paying `jwtMiddleware` + `authzMiddleware` (a possible `auth GET /authz/resolve` round trip,
  ADR-0014) + a grouping query.
- **The counter-argument, weighed and rejected.** "A whole-corpus fetch ships more personal data
  to the client than any single query would." True in volume, but the recipient *is the data
  subject*, and this discloses nothing new: the same caller can already reconstruct the entire
  corpus today from `GET /requests` + `GET /requests/{id}` (which returns every line's
  `motivo`/`km`/`entity`/`date`, verified in `requests.repo.ts` / `requests.service.ts`). The
  new endpoint is a strictly **data-minimised projection** of data the caller already holds
  full read access to: distinct trips only, one representative motivo per trip, one date per
  trip — never the per-line history. Volume is bounded by D5's cap and the response is
  `Cache-Control: no-store` (D7) so it is never written to the browser's disk cache.

**D2 — Debounce 150 ms before the single corpus fetch; in-flight requests are BOTH aborted and
token-guarded; a 5 s client timeout is treated as failure.**

- Matching itself is **not debounced** — it is a synchronous filter over ≤200 in-memory objects,
  sub-millisecond, re-run on every keystroke. Debouncing it would only add lag.
- The 150 ms debounce guards the *network* fetch only, which fires at most once per session (on
  the first query to reach the 2-non-whitespace-character threshold, AC-1.2). It exists to
  absorb a type-two-characters-then-delete-them wobble and React StrictMode's double effect —
  not per-keystroke traffic. It is deliberately shorter than `MileageAmountField`'s 400 ms
  (`refund-ui/src/components/MileageAmountField.tsx`), because that debounce protects a fetch
  that repeats on every edit whereas this one protects a fetch that happens once; a shorter
  window buys time-to-first-suggestion at no traffic cost.
- **Out-of-order handling — both mechanisms, deliberately.** A monotonic `requestTokenRef`
  (the exact precedent in `MileageAmountField`) is the *correctness* mechanism: a resolved
  response whose token is stale is dropped without touching state, so a slow early response can
  never overwrite a fast later one. An `AbortController` is the *resource* mechanism: it
  cancels the socket on unmount, on the field being disabled (type switched away from
  `travel_km`), and on corpus invalidation. Abort alone is insufficient — `fetch` abort races
  with an already-resolved promise — hence both.
- A `setTimeout(5000)` calling `controller.abort()` implements AC-5.2's "does not answer in
  reasonable time". A single `AbortController` + timer is used rather than `AbortSignal.any`
  /`AbortSignal.timeout`, to avoid depending on those in the jsdom test environment.

**D3 — Normalisation happens in APPLICATION CODE on both sides. No `unaccent`, no generated
column, no new index, no migration.**

- Grouping (server) and query matching (client) both need the fold, so it is implemented twice:
  `refund-api/src/requests/normaliseMotivo.ts` and `refund-ui/src/lib/tripSuggestions.ts`.
  This mirrors the already-established `computeMileageAmountCents` precedent (ADR-0025), which
  lives in both apps with a *mirrored canonical vector suite* — the monorepo is deliberately
  mixed pnpm/Bun with no shared workspace package, so a shared module is not available.
  Divergence risk is contained two ways: (i) the response carries the server's
  `normalisedMotivo` for each suggestion, so the client folds **only the query**, never the
  candidates; (ii) an identical canonical vector list is asserted in both test suites (see Test
  strategy, R2).
- **The fold, exactly and in order.** Step order is load-bearing, not stylistic:
  1. `normalize('NFD')` — decompose precomposed letters into base + combining mark.
  2. strip `/[\u0300-\u036F]/g` — the **Combining Diacritical Marks block (U+0300–U+036F),
     and only that block**.
  3. `toLowerCase()` — locale-**independent**, never `toLocaleLowerCase` (a Turkish locale would
     fold `I` → `ı`, and the two mirrored implementations would then disagree by device locale).
  4. collapse `/\s+/g` to one space — **after** the strip, so a removed mark can never leave two
     spaces adjacent.
  5. `trim()` — after the collapse, so a stripped edge mark cannot leave an edge space behind.
  6. `normalize('NFC')` — re-compose, so `normalisedMotivo` is canonical and byte-stable on the
     wire rather than a decomposed form.

  `"Milano  →  LUGANO "`, `"milano → lugano"` and `"Milano → Lugàno"` all fold to
  `"milano → lugano"`. The fold is idempotent, and it is never display text (AC-2.5).
- **Do NOT "simplify" step 2 to `\p{Diacritic}` (or `\p{Mn}`)** — both are wrong, verified
  empirically at implementation time and pinned as vectors:
  - `\p{Diacritic}` also matches **spacing** characters that are ordinary text — `^` (U+005E),
    `` ` `` (U+0060), `´` (U+00B4), `¨` (U+00A8), `·` (U+00B7). `"Koln · Bonn"` would fold to
    `"koln  bonn"`: a real character deleted and a double space left behind, no longer equal to
    `"Koln Bonn"`.
  - `\p{Diacritic}` **and** `\p{Mn}` also match marks that are **semantic** in non-Latin scripts.
    NFD splits the Japanese dakuten off as U+3099, so stripping it turns `ガ` (ga) into `カ` (ka)
    — a different word. Hebrew niqqud, Arabic harakat and Indic nukta break the same way.

  U+0300–U+036F strips every accent an Italian or Swiss employee can plausibly type
  (à è é ì ò ù, ä ö ü, ç, ñ, å, ș ț) while leaving every other script's meaning intact.
- **Accepted, documented limitations** (each pinned as a vector so it is visible here rather than
  discovered later): letters with **no canonical decomposition** are not folded to a base — `ß`
  does not expand to `ss`, so Swiss `"Strasse"` and German `"Straße"` are different trips;
  Turkish dotless `ı` does not fold to `i`; `ø ł đ` keep their form. All are rare in this corpus,
  and folding them would require a bespoke transliteration table — one more surface on which the
  two mirrored implementations could silently drift.
- **The canonical vector table is a contract artifact, not a test fixture.**
  `MOTIVO_FOLD_VECTORS` — 28 vectors of type
  `MotivoFoldVector = { description, input, expected }` — is a **named export of the module
  itself**, `refund-api/src/requests/normaliseMotivo.ts`, deliberately not a test-only fixture,
  precisely so the UI side can mirror it. `refund-ui/src/lib/tripSuggestions.ts` must implement
  the identical fold **and its suite must assert that identical table**; that mirroring IS the
  mitigation for R2 below, and neither side may be edited alone.
- **`unaccent` is explicitly NOT required.** Requiring it would mean a `CREATE EXTENSION` in a
  migration (a privileged DDL that must be granted on the managed Railway EU instance and in
  every developer's local compose DB and in CI), plus an expression index to make the folded
  comparison sargable, plus an immutability wrapper because `unaccent()` is only `STABLE` and
  therefore not directly indexable. That is a large, environment-coupled cost to move a fold
  that runs over a few hundred rows out of TypeScript. Full-text search (`tsvector`/`pg_trgm`)
  is likewise rejected: FTS is word-prefix oriented and would not satisfy AC-1.4's "anywhere
  within" substring rule without trigram indexing, and neither is remotely justified at this
  corpus size.
- **Query strategy** (see Data model for why no index is added): a Prisma `groupBy` over
  `refund_line` on `(motivo, km, entity)` with `_count` and `_max: { date }`, filtered by
  `type = travel_km`, `date >= cutoff`, and the relation filter `request.ownerUserId = sub`.
  That collapses *exact* triples in SQL; TypeScript then merges triples whose motivo folds
  equal (summing counts, taking the max date, and picking the display motivo from the
  constituent triple with the greatest max date — AC-2.5), sorts, and caps. If Prisma's
  `groupBy` relation-filter support proves inadequate, the equivalent fallback is
  `findMany({ where: { request: { ownerUserId } }, select: {...} })` + full TS grouping — same
  contract, same tests, decided at implementation time (R4).

**D4 — Capability gate: the EXISTING `request:read`. No new catalog resource, no new
permission, no `auth` change of any kind.**

The precedent fork is explicit in the ADR record. ADR-0028 minted a *new* `settings` resource
because "a distribution mailbox is not a rate" — a genuinely different subject with a
different audience that must be separately grantable and separately auditable. ADR-0031 reused
the existing `admin`/`requireAdmin` gate because the new surface was the *same authority over
the same subject*. This case is the ADR-0031 shape, and more strongly: the suggestions endpoint
returns a **projection of the very rows `request:read` already authorises the caller to read**.
A separate `suggestion:read` grant would be revocable independently of `request:read` while
being trivially reconstructible by any holder of `request:read` (enumerate `GET /requests`,
fetch each detail, group client-side) — a permission that cannot actually withhold anything is
worse than no permission, because it implies a control that does not exist.

Two enforcement properties, both deliberate:

- The handler checks `hasCapability(permissions, "request", "read")` → **403** when absent
  (wholesale capability denial with no record to hide — matching `GET /requests` exactly,
  never a 404, ADR-0014 point 3).
- The handler **ignores the grant's conditions entirely** and scopes to the JWT `sub`
  unconditionally. This is what makes AC-4.2 structural rather than incidental: even a caller
  holding an unconditioned/global `request:review` (or a hypothetically unconditioned
  `request:read`) gets exactly their own lines, because widening is not expressible in this
  route's query. ADR-0015's entity-scope predicate is **not** consulted here — it is a review
  concept, and this is a self-scoped read.

`refund:access` (the `GET /rates/effective` gate) was considered and rejected as too weak: it
is the "you can see the refund tool" grant, whereas this returns line-level personal content,
for which `request:read` is the established gate.

### The remaining decisions, numbered for reference

- **D5 — Bounds.** `take: 2000` distinct exact triples on the `groupBy`; the ranked result is
  capped at **200 trip signatures**; the UI shows at most **8** (AC-1.5). Rationale and the
  accepted deviation are in Data model and R1.
- **D6 — The corpus fetch is LAZY and invalidated on add.** Nothing is fetched when
  `travel_km` is merely selected — only when the query first reaches 2 non-whitespace
  characters (so an employee who picks the type and changes their mind costs nothing), and at
  most once per corpus epoch. A successful "Add expense line" bumps the epoch, so the *next*
  threshold crossing refetches and the trip just claimed is immediately suggestible — the
  stated benefit behind AC-2.6's accepted trade-off. Cost is bounded by the number of mileage
  lines actually composed.
- **D7 — The corpus is memory-only and uncacheable.** Response carries
  `Cache-Control: no-store` (a private browser cache MAY otherwise store an `Authorization`-ed
  response to disk, RFC 9111); the client holds it in a component ref/state that dies with the
  composer — never `localStorage`/`sessionStorage`/IndexedDB. ADR-0001's posture, applied to
  personal data, and the spec's explicit non-goal.
- **D8 — The server's ordering is a deterministic TOTAL order.** AC-2.3 fixes only
  `count` desc → `lastUsedOn` desc; three further tiebreaks (`normalisedMotivo` asc, `km` asc,
  `entity` asc) are added so identical-count/identical-date trips cannot flap between
  responses. Additive to AC-2.3, never contradicting it.
- **D9 — No matched-substring highlighting.** No AC asks for it; omitting it keeps the option
  render path pure React text children (no `dangerouslySetInnerHTML`, no injection surface) and
  introduces no further copy.

### Components touched / added

**`refund-api` (new files in the EXISTING `src/requests/` module — co-located with
`lines.*`, `requests.*`, `lifecycle.*`; no new directory, matching tasks T1–T5)**

| File | Role |
|---|---|
| `suggestions.routes.ts` | New `OpenAPIHono` router, `GET /line-suggestions`. `jwtMiddleware` → `authzMiddleware` → `request:read` capability check. `defaultHook` → **400** (matching `rates/effective.routes.ts`'s query-validation convention, not `linesRouter`'s 422-for-bodies). Sets `Cache-Control: no-store`. |
| `suggestions.repo.ts` | The Prisma `groupBy` described in D3. Scoped by `ownerUserId` from the verified `sub` — **never** from any input. Effect-wrapped, `DatabaseError`, matching `requests.repo.ts`. |
| `suggestions.service.ts` | Pure: fold-merge exact triples → trip signatures, rank, cap, map to the wire shape. No DB, no Hono — directly unit-testable. |
| `normaliseMotivo.ts` | The fold (D3) — pure, DB-free, I/O-free — plus the exported `MOTIVO_FOLD_VECTORS` canonical vector table (`MotivoFoldVector[]`, 28 vectors) that `refund-ui` mirrors. Both are module exports, not test fixtures. |
| `suggestions.schemas.ts` | zod-openapi query + response schemas. |
| `src/index.ts` | Register `suggestionsRouter`. **Mounted at top level, NOT under `/requests/…`** — `requestsRouter` is registered first and its `GET /requests/{id}` route would swallow `/requests/line-suggestions` as `id="line-suggestions"` and 404 it. |
| `src/openapi/registry.ts` | New `Suggestions` tag. |

**`refund-ui`**

| File | Role |
|---|---|
| `src/lib/refundApi.ts` | **Additive** change only: `getJson<T>(path, init?: RequestInit)` forwards `init` to `apiFetch` (which already forwards it to `fetch`, verified in `shell/src/lib/session.ts`), so an `AbortSignal` can be passed. Every existing caller is unaffected. |
| `src/lib/suggestionsApi.ts` (new) | `getTripSuggestions(signal): Promise<TripSuggestion[]>` + the `TripSuggestion` type. |
| `src/lib/tripSuggestions.ts` (new) | Pure: `normaliseMotivo`, `queryQualifies` (≥2 non-whitespace chars), `matchTripSuggestions(corpus, query, limit)` (substring filter, order-preserving, `slice(0, 8)`). `normaliseMotivo` must be the **identical fold** shipped in `refund-api/src/requests/normaliseMotivo.ts`, and this file's suite must assert that module's exported `MOTIVO_FOLD_VECTORS` table verbatim — the R2 mitigation. |
| `src/components/MotivoSuggestField.tsx` (new) | The combobox: renders the Motivo `<input>` + the suggestion listbox, owns corpus state/fetch/abort/token/debounce, keyboard navigation, a11y wiring. `enabled=false` → renders the identical input with **no** combobox roles and never fetches. |
| `src/components/ExpenseLineComposer.tsx` | Replaces the raw Motivo `<input>` with `<MotivoSuggestField enabled={showKm} …>`. **Same element id `composer-motivo` and same `data-testid`**, one JSX node in both branches so React preserves the DOM node and focus across type changes. Adds an `onPick` handler setting `{ motivo, km: String(km), entity }` on the draft. |
| `src/strings.ts` | New `components.motivoSuggest` namespace (see AC-5.7 / the proposed spec amendment). |
| `src/components/ExpenseLineRow.tsx` | **Untouched** — AC-1.8 is satisfied structurally, not by a flag. |

**Nothing changes in:** `auth` (no catalog/seed/role change), `notify-api`, `shell` (the
refund-api origin is already on the trusted-origin allowlist), the Prisma schema, or any
migration.

### Interaction sequence (the composing session)

1. Employee opens a `draft` request → `RequestDetailPage` renders `ExpenseLineComposer`.
   `MotivoSuggestField` is mounted with `enabled=false`. **No fetch** (AC-1.1).
2. Employee picks Expense type `travel_km` → `enabled=true`. Still **no fetch** (D6: lazy).
3. Employee types the 2nd non-whitespace character → after 150 ms, one
   `GET /line-suggestions?type=travel_km` via `apiFetch` (Bearer attached, ADR-0001/0006).
4. `refund-api`: `jwtMiddleware` (RS256 + `aud`, ADR-0010) → `authzMiddleware`
   (`auth GET /authz/resolve`, `(sub, perm_epoch)`-cached, **fails closed 503**, ADR-0014) →
   `request:read` capability check → `groupBy` scoped to `sub` → fold-merge → rank → cap 200 →
   `200 { type, suggestions[] }` with `Cache-Control: no-store`.
5. Client stores the array in a ref/state (**memory only** — never `localStorage`/
   `sessionStorage`/IndexedDB; ADR-0001's posture applied to personal data, and the spec's own
   non-goal). Every keystroke thereafter: fold the query → `filter(s => s.normalisedMotivo.includes(q))`
   → `slice(0, 8)` → render. Zero further network.
6. Pick (click / Enter on a highlighted option) → draft `motivo`/`km`/`entity` overwritten
   (AC-3.1/3.4), date untouched (AC-3.2), list closes, focus returns to the input.
   `MileageAmountField` — already a pure function of `(entity, date, km)` props — re-derives
   the amount on its own with no new wiring (AC-3.5). Nothing is saved (AC-3.7).
7. Successful "Add expense line" → the corpus ref is invalidated (D6); the next crossing of
   the 2-character threshold refetches, so a trip just claimed is immediately reusable — the
   stated benefit behind AC-2.6's accepted trade-off.
8. Any failure at 3/4 (network, 400, 403, 503 from a fail-closed `auth`, 5 s timeout) →
   corpus stays empty, no list, **no toast/banner/alert of any kind** (AC-5.2). The exception
   is swallowed at `MotivoSuggestField`'s `.catch()` and never propagates to
   `ExpenseLineComposer`'s error state.

### Where the AC-5.2 ↔ ADR-0014 tension actually lives

`refund-api` **keeps failing closed**: an `auth` outage makes `authzMiddleware` return 503 for
this route exactly as for every other, and no cached/stale permission set is served. Nothing in
this plan weakens ADR-0014. The *client* is the only side that changes posture: `refund-ui`
treats **every** non-2xx and every network/timeout error from this one endpoint as "no
suggestions", with no user-visible surface. This is precisely ADR-0032's standing rule ("silent
graceful degradation is the standing posture for every optional third-party enrichment") applied
to a first-party optional enrichment. It is safe to swallow because the endpoint is
**read-only, derived and non-authoritative** — nothing the employee does depends on it, and a
503 here is always accompanied by a loud 503 on the line-add call the employee is actually
blocked by.

### ADRs honoured

ADR-0001 (in-memory only, never web storage — extended from the JWT to the corpus) ·
ADR-0005/0010 (JWKS + `aud` resource-server verification, unchanged) · ADR-0013 (derived on
read: a suggestion is computed per request, never a stored/scheduled projection — no
materialised "trip" table, no cron) · ADR-0014 (fail-closed authz, capability-absent = 403) ·
ADR-0015 (entity ABAC deliberately **not** applied — self-scoped read) · ADR-0025 (mirrored
pure function + canonical vectors across the api/ui boundary) · ADR-0028 vs ADR-0031 (the
new-permission-vs-reuse fork, resolved to reuse — D4) · ADR-0032 (silent graceful degradation).

## Data model

**No schema change. No migration. No new index. No Postgres extension.** `RefundLine` already
carries every field a trip signature needs (`motivo` NOT NULL, `km`, `entity`, `date`
`@db.Date`, `type`), and `RefundRequest.ownerUserId` carries ownership. A suggestion is a
derived view, never a record (ADR-0013 lineage, and the spec's own Domain language says so).
AC-4.4 ("no new store, log, or record of motivo text is created") is therefore satisfied by
there being nothing to create.

**Query and its index support (D3):**

```sql
-- conceptually, what Prisma groupBy emits
SELECT l.motivo, l.km, l.entity, COUNT(*) AS cnt, MAX(l.date) AS last_used
FROM refund_line l
WHERE l.type = 'travel_km'
  AND l.date >= $cutoff                       -- AC-2.4
  AND l.request_id IN (SELECT id FROM refund_request WHERE owner_user_id = $sub)  -- AC-4.1
GROUP BY l.motivo, l.km, l.entity;
```

- **No status filter** — every status is eligible (AC-2.6), including `draft`.
- Existing indexes carry it: `refund_request(ownerUserId, status)` (leading column matches) for
  the owner subquery, and `refund_line(requestId)` for the lookup. A user has tens of requests
  and, realistically, low hundreds to low thousands of lifetime lines; `type`/`date` are filtered
  after the index lookup on a row set that small. **Adding `@@index([requestId, type, date])`
  now would be an unjustified migration.** Escalation trigger, recorded so a future author does
  not have to rediscover it: if a single user's lifetime `refund_line` count approaches ~10 000,
  or this endpoint's p95 exceeds ~150 ms, add that composite index — it is a pure addition with
  no data change.
- **Defensive bounds** (D5): `take: 2000` on the `groupBy` (distinct exact triples), and the
  final ranked list is capped at **200 trip signatures**. Both are ~25×–250× the 8 the UI can
  display; an employee with more than 200 *distinct* trips in 24 months does not have the
  repetition problem this feature exists to solve. Recorded as a bounded, documented deviation
  from AC-1.4's "any matching trip" for pathological corpora (R1).
- **24-month window**: `cutoff = Date.UTC(y, m - 24, d)` computed per request from the server
  clock, compared against a `@db.Date` column. UTC is used throughout; the ≤2 h offset between
  UTC and Europe/Rome is immaterial at a 24-month boundary. Feb-29 → Mar-1 normalisation by
  `Date.UTC` is accepted.

## API contracts

### `GET /line-suggestions`

```http
GET /line-suggestions?type=travel_km HTTP/1.1
Authorization: Bearer <RS256 JWT issued by auth, aud=<AUTH_AUDIENCE>>
```

Query (zod-openapi):

```ts
const SuggestionsQuerySchema = z.object({
  // Deliberately a single-member enum, not the full ExpenseType enum: the
  // non-goal "widening to further types is a filtering change, not a redesign"
  // is served by the parameter EXISTING; accepting types whose fill set has not
  // been designed (an amount-bearing type) would ship an untested surface.
  type: z.enum(['travel_km']),
})
```

**200 OK**

```http
Cache-Control: no-store
Content-Type: application/json
```

```json
{
  "type": "travel_km",
  "suggestions": [
    {
      "motivo": "Milano → Lugano  cliente ACME",
      "normalisedMotivo": "milano → lugano cliente acme",
      "km": 62,
      "entity": "welld_ch",
      "count": 14,
      "lastUsedOn": "2026-07-28"
    },
    {
      "motivo": "Aeroporto Malpensa",
      "normalisedMotivo": "aeroporto malpensa",
      "km": 45,
      "entity": "welld_it",
      "count": 14,
      "lastUsedOn": "2026-06-02"
    }
  ]
}
```

```ts
const TripSuggestionSchema = z.object({
  /** The group's MOST RECENT line's motivo, verbatim as typed — never folded (AC-2.5). */
  motivo: z.string(),
  /** The server's fold of `motivo` — the client matches the folded QUERY against this (D3). */
  normalisedMotivo: z.string(),
  km: z.number().int().positive(),
  entity: z.enum(['welld_it', 'welld_ch']),
  /** Lines sharing this trip signature within the 24-month window (AC-1.7/2.3). */
  count: z.number().int().positive(),
  /** The group's most recent expense date, ISO date-only (AC-1.7/2.3). */
  lastUsedOn: z.string(),  // YYYY-MM-DD
})

const SuggestionsResponseSchema = z.object({
  type: z.literal('travel_km'),
  suggestions: z.array(TripSuggestionSchema),   // 0..200, pre-ranked
})
```

**Ordering (server-guaranteed, total and deterministic):** `count` desc → `lastUsedOn` desc →
`normalisedMotivo` asc → `km` asc → `entity` asc. AC-2.3 fixes only the first two; the last
three are added so the output is a total order (stable snapshots for tests, no flapping between
identical-count/identical-date trips). The client's filter preserves this order, which is what
makes AC-1.7's "never shows a lower count than a suggestion listed below it" hold by
construction rather than by a re-sort.

**Errors** — RFC 7807 Problem JSON throughout (`{type,title,status,detail,instance}`):

| Status | When | Notes |
|---|---|---|
| 400 | `type` missing or not `travel_km` | router `defaultHook`, mirrors `GET /rates/effective` |
| 401 | missing/invalid/expired Bearer JWT, bad `aud` | `jwtMiddleware`, bodyless (existing convention) |
| 403 | caller lacks `request:read` | `detail: "You do not have permission to read refund requests"` — same wording as `GET /requests`. No `code` extension member. |
| 503 | `auth GET /authz/resolve` unreachable/non-2xx | `authzMiddleware`, fail-closed (ADR-0014). Unchanged behaviour. |

**No 404 exists on this route** — there is no record to address, therefore no existence to
leak, therefore no ADR-0005/0037-style 403-vs-404 question to answer.

**Not present, deliberately:** any `q`/query-text parameter; any `userId`/`ownerUserId`
parameter; any pagination cursor; any request body (it is a GET, so no `bodyLimit` is needed —
contrast `requestsRouter`/`linesRouter`).

### Client contract (`refund-ui/src/lib/suggestionsApi.ts`)

```ts
export type TripSuggestion = {
  motivo: string
  normalisedMotivo: string
  km: number
  entity: Entity
  count: number
  lastUsedOn: string
}

/** Resolves to [] on ANY failure is NOT this function's job — it throws ApiError/DOMException
 *  like every other refundApi call; MotivoSuggestField is the single place that swallows
 *  (AC-5.2), so a future non-composer caller does not silently inherit the swallow. */
export const getTripSuggestions = (signal: AbortSignal): Promise<TripSuggestion[]>
```

### Pure client matching contract (`refund-ui/src/lib/tripSuggestions.ts`)

```ts
export const normaliseMotivo = (raw: string): string
export const queryQualifies = (raw: string): boolean          // ≥2 non-whitespace chars (AC-1.2/1.3)
export const matchTripSuggestions = (
  corpus: readonly TripSuggestion[],
  rawQuery: string,
  limit = 8,                                                   // AC-1.5
): TripSuggestion[]                                            // order-preserving filter + slice
```

### Component contract (`MotivoSuggestField`)

```ts
type MotivoSuggestFieldProps = {
  id: string                       // 'composer-motivo' — label association preserved
  value: string
  onChange: (motivo: string) => void
  /** Fires only on an explicit pick; the parent overwrites motivo+km+entity (AC-3.1/3.4). */
  onPick: (s: TripSuggestion) => void
  /** true only when the composer's expense type is travel_km (AC-1.1). */
  enabled: boolean
  disabled: boolean                // form-submitting
  /** Bumped by the parent after a successful add → invalidates the cached corpus (D6). */
  corpusEpoch: number
}
```

**DOM / ARIA contract (AC-5.6)** — ARIA 1.2 combobox-with-listbox:

- input: `role="combobox"`, `aria-expanded={open}`, `aria-controls="composer-motivo-listbox"`,
  `aria-autocomplete="list"`, `aria-activedescendant={activeOptionId | undefined}`,
  `autoComplete="off"`. When `enabled=false`, **none** of these attributes are rendered.
- list: `<ul role="listbox" id="composer-motivo-listbox">` with
  `<li role="option" id="composer-motivo-option-{i}" aria-selected={i===active}>`.
- one `aria-live="polite"` sr-only status node announcing the available-count on change
  (`strings.components.motivoSuggest.available(n)`), never the option text itself.
- each option's accessible content carries all five AC-1.7 facts (motivo, km, entity label,
  count, last-used date).
- **No matched-substring highlighting** (D9) — no injection surface, no extra copy.

**Keyboard (AC-5.3/5.4/5.5)**

| Key | Open list, `active >= 0` | Open list, `active === -1` | Closed |
|---|---|---|---|
| ArrowDown | `active++` (clamp) | `active = 0` | opens if the query qualifies + matches |
| ArrowUp | `active--` (to −1) | no-op | no-op |
| Enter | `preventDefault()` → pick (**form must NOT submit**) | **no `preventDefault`** — today's behaviour, i.e. the form submits (AC-5.4) | unchanged |
| Escape | close, keep text, `active = -1`, set `dismissed` | same | no-op |
| Tab / blur / outside pointerdown | close, text unchanged (AC-5.5) | same | — |

`active` resets to −1 on every query change. `dismissed` (Escape) clears on the next value
change, so typing re-opens the list.

## Test strategy

Levels available, verified in-repo:
**api-unit / api-int** — `bun test` in `refund-api`; route-integration tests run the real Hono
app against the real compose Postgres with `jwtMiddleware` + `resolveClient` mocked
(`src/test-support/testAuth.ts`), cleaned via `truncateRefundTables()`.
**ui-unit / ui-comp** — Vitest in `refund-ui`; component tests opt into jsdom per-file
(`@vitest-environment jsdom`) with `@testing-library/react`.
**e2e** — Playwright in **`shell/e2e/`** (a federated remote has no standalone authed
bootstrap); new spec `shell/e2e/motivo-autocomplete.spec.ts`, seeding grants via
`helpers/refundFixtures.ts`'s `grantRefundEmployee`.

The mapping is **total** — all 32 ACs are mapped.

| AC | Level | What proves it |
|---|---|---|
| AC-1.1 | ui-comp | Select each non-`travel_km` type (and the no-type default): `suggestionsApi.getTripSuggestions` mock **not called**, no `role="combobox"`, no listbox in the DOM. |
| AC-1.2 | ui-comp | type=`travel_km`, type `"lu"`: after the debounce, one fetch; listbox rendered beneath the field with the matching options. |
| AC-1.3 | ui-comp | From an open list, reduce to `"l"`, to `""`, and to `"   "`: list closes, `aria-expanded="false"`, no options in the DOM (three cases). |
| AC-1.4 | ui-unit + api-unit | `matchTripSuggestions`: `"lug"` matches `"Milano → Lugano client visit"` (mid-string); `"LUG"`, `"lùg"` match too; `"xyz"` does not. `normaliseMotivo` canonical vectors asserted **identically** in both apps' suites (R2). |
| AC-1.5 | ui-unit + ui-comp | 30-match corpus → `matchTripSuggestions` returns exactly 8; the rendered listbox has 8 `role="option"` nodes. |
| AC-1.6 | ui-comp | Corpus loaded, query matches nothing: no listbox, no `role="alert"`/`role="status"` message, input still editable. |
| AC-1.7 | ui-comp + api-int | Option node exposes motivo, km, entity label, count and last-used date; api-int asserts `count`/`lastUsedOn` are present and correct per group. ui-unit asserts the rendered sequence's `count` is non-increasing. |
| AC-1.8 | ui-comp | `ExpenseLineRow` in edit mode on a `travel_km` line: typing in `row-{id}-motivo` triggers no fetch and renders no combobox/listbox (structural — the component is not touched). |
| AC-2.1 | api-int + api-unit | Seed 5 lines with equal folded motivo/km/entity across 3 requests → exactly one suggestion, `count: 5`. |
| AC-2.2 | api-int | Same motivo, different `km` → 2 suggestions; same motivo, different `entity` → 2 suggestions; never merged. |
| AC-2.3 | api-int + api-unit | Ranking: count desc, then `lastUsedOn` desc. Unit also pins the full deterministic total order (D8 tiebreaks). |
| AC-2.4 | api-int | A line dated 25 months ago is absent AND does not raise the count of an otherwise-identical in-window group; a line dated 23 months ago is present. |
| AC-2.5 | api-int | Group of `"milano lugano"` (older) + `"Milano  →  LUGANO"` (most recent) → `motivo` is the most recent line's exact text; `normalisedMotivo` is folded; the displayed text is never the folded form. |
| AC-2.6 | api-int | Seed one line in each of `draft`/`submitted`/`approved`/`rejected`/`paid` → all five contribute to counts and appear. |
| AC-3.1 | ui-comp | Pick → `composer-motivo` = suggestion motivo, `composer-km` = `String(km)`, `composer-entity` = entity. |
| AC-3.2 | ui-comp | Set date to a non-default value, pick → `composer-date` unchanged. |
| AC-3.3 | ui-comp + ui-unit | After a pick, no `composer-currency`/`composer-amount` node exists; `lineDraftToPayload` output for the resulting draft has no `currency`/`requestedAmountCents` keys (existing `lineDraft.test.ts` invariant re-asserted). |
| AC-3.4 | ui-comp | Pre-fill motivo/km/entity with different values, then pick → all three are **overwritten**. |
| AC-3.5 | ui-comp | Pick → listbox closes; the mocked `ratesApi.getEffectiveRate` is re-invoked with the picked entity (proving the amount re-derives). |
| AC-3.6 | ui-comp | After a pick, edit motivo/km/entity → values change, no `readOnly`/`disabled` attribute present. |
| AC-3.7 | ui-comp + e2e | Pick → `onAdd` not called, no POST; the line appears only after "Add expense line". |
| AC-4.1 | api-int | Two seeded owners with overlapping motivos → caller A's response contains none of B's motivo/km/entity, and B's lines do not inflate A's counts. |
| AC-4.2 | api-int | Caller holding `request:review` with **global** entity scope (unconditioned grant) → response is still exactly their own lines. |
| AC-4.3 | api-int | Matrix of resolve fixtures (employee / accounting-`welld_it` / accounting-global / `request:read` only / no refund grants) called directly against the router: never another user's data; missing `request:read` → 403 (never 200, never 404); no parameter exists through which another subject could be addressed (asserted by the schema test — the query accepts only `type`). |
| AC-4.4 | api-int + design | Row counts of `refund_line`/`refund_request`/`refund_audit_entry`/`refund_setting`/`mileage_rate` are byte-identical before and after a suggestions call; captured `console` output during the call contains no motivo text. Structurally: the typed query never reaches the server at all (D1), and no table/migration is added. |
| AC-5.1 | ui-comp + e2e | Novel motivo, zero matches: compose and add a `travel_km` line end to end; the typed text is never altered/completed in place. |
| AC-5.2 | ui-comp + e2e | `getTripSuggestions` rejecting with 500 / 503 / `ApiError(403)` / an abort-timeout: no `role="alert"`, no toast, no listbox, and the line still adds. e2e aborts the `**/line-suggestions*` route via `page.route` and completes the add. |
| AC-5.3 | ui-comp | ArrowDown/ArrowUp move `aria-activedescendant`; Enter with a highlight picks **and** `onAdd` is not called (form not submitted); Escape closes and leaves the typed text byte-identical. |
| AC-5.4 | ui-comp | List open, `active === -1`, Enter → no pick; the form's submit path runs exactly as with no list (assert `onAdd` called when the draft is complete). |
| AC-5.5 | ui-comp | `blur` to another field, and a pointerdown outside the list → closed, text unchanged. |
| AC-5.6 | ui-comp | Roles/attributes asserted: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-autocomplete`, `aria-activedescendant`, `role="listbox"`/`role="option"`/`aria-selected`; the polite status node's text changes with the option count. Full journey driven by keyboard only in e2e. |
| AC-5.7 | ui-unit | New `refund-ui/src/lib/noHardcodedStrings.test.ts` (ported from `estimai-ui`'s) over the new files: every non-technical literal must come from `strings.ts`. **The Italian half is blocked on the spec amendment below.** |

**e2e journey (`shell/e2e/motivo-autocomplete.spec.ts`)** — one happy path + one degradation
path: seed a refund employee, create a request and seed ≥3 past mileage lines through the real
API, open a new draft, choose Travel by car, type 3 characters, assert the list, navigate and
pick with the keyboard only, assert the three filled fields and the recomputed amount, add the
line; then `page.route(...).abort()` the suggestions call and assert the composer still works
with no error surface.

## Risks

| # | Risk | Mitigation / early check |
|---|---|---|
| R1 | The 200-signature cap can hide a genuinely matching rare trip — a bounded deviation from AC-1.4's "any matching trip". | Cap is 25× the display limit and applies only after ranking, so what is dropped is by definition the least-used, least-recent trips. Early check: QE seeds a >200-signature corpus and confirms graceful behaviour (top 200, no error). Raising the cap is a one-constant change; if it ever needs to be, that is the signal to move to Option B. |
| R2 | The fold diverges between `refund-api` (grouping) and `refund-ui` (query) → matches silently disappear or groups mismatch. | The response carries `normalisedMotivo`, so the client folds **only the query** — the candidate side has exactly one implementation. An identical canonical vector list (casing, accents `à/è/ù/ö`, leading/trailing/internal whitespace, the `→` glyph, an empty-after-trim string, a Turkish `İ`) is asserted in both suites, in the ADR-0025 mirrored-vector tradition. |
| R3 | Enter-key interception regresses the composer's existing submit-on-Enter behaviour. | AC-5.3 and AC-5.4 tests are written as a pair and both assert on `onAdd`; `preventDefault` is called on exactly one branch. |
| R4 | Prisma `groupBy` with a relation filter (`request: { ownerUserId }`) may not generate the expected SQL, or may be unexpectedly slow. | The contract is expressed in `suggestions.service.ts` (pure) and the route tests, both agnostic to how the repo obtains rows; the documented fallback is `findMany` + full TS grouping. Early check: implement and run the api-int suite against real Postgres before any UI work starts. |
| R5 | Corpus staleness within a long composing session (a line added in another tab, or by nobody). | Accepted. Invalidate-on-add (D6) covers the case the employee can actually observe. No polling, no SSE. |
| R6 | An `auth` outage makes suggestions vanish with no explanation (fail-closed 503 → silent client). | Correct and intended (AC-5.2). Not a new failure mode: the same outage already 503s the line-add call the employee is blocked by, which *does* surface an error. Explicitly documented so a future reader does not "fix" the silence. |
| R7 | AC-5.7 requires Italian copy; `refund-ui/src/strings.ts` is English-only with no locale seam. | **Spec amendment proposed below.** Unresolved at plan time — it changes what "done" means for one AC and must be settled at the plan gate, not discovered at QE. |
| R8 | `getJson`'s new optional `init` parameter touches a file every domain module imports. | Purely additive with a default; TypeScript build + the existing `refundApi.test.ts` are the guard. |
| R9 | An XSS anywhere in the shell or a remote could exfiltrate the whole corpus in one call instead of enumerating requests. | Marginal delta — the same script can already call `GET /requests` + `GET /requests/{id}`. Corpus is memory-only, `no-store`, and dies with the component. Named for the owasp pass rather than mitigated further. |

## Security

**YES — security-sensitive.** Three independent reasons: (1) it reads **personal data** — motivo
free-text that routinely names clients, sites and destinations, plus distances and dates, i.e. a
partial movement history of an identified employee under GDPR; (2) US-4 is an explicit
**access-control** user story whose AC-4.3 is textbook OWASP **A01: Broken Access Control** —
"exercised directly rather than through the composer, it never returns another user's line";
(3) it adds a **new authenticated endpoint on an authorization-enforcing resource server**
(ADR-0014), where a mis-wired capability check or a missing `sub` scope is a cross-employee
data leak.

Not special-category data and not a payment/credential surface — the standard `owasp-reviewer`
tier is appropriate; no frontier-tier escalation is requested.

**Surfaces to review, named so the pass is not a discovery exercise:**

1. `refund-api/src/requests/suggestions.routes.ts` + `suggestions.repo.ts` — that
   `ownerUserId` comes **only** from the verified JWT `sub`; that no input can widen scope
   (the route accepts exactly one enum parameter); that the `request:read` check precedes the
   query; that permission *conditions* are ignored so a global/review grant cannot widen the
   result (AC-4.2); that `authzMiddleware` still fails closed.
2. The **denial taxonomy** on the new route: 403 for capability-absent, 400 for a bad `type`,
   no 404 path — verify no information is disclosed by the difference (there is no record to
   probe for).
3. **Logging & residency**: no motivo text or query text may enter any log; the request has no
   query text at all by design (D1); `src/lib/logger.ts`'s path-only posture must not be
   bypassed by a route-local `console.log`. Data stays in the EU-region deployment; nothing new
   is transmitted to any third party.
4. **`Cache-Control: no-store`** on the response, and the client-side guarantee that the corpus
   is held in memory only — never `localStorage`/`sessionStorage`/IndexedDB (ADR-0001's posture,
   and the spec's explicit non-goal).
5. `refund-ui/src/components/MotivoSuggestField.tsx` — motivo text is rendered as React text
   children only (no `dangerouslySetInnerHTML`, no match highlighting, D9); the swallow-all
   `catch` must not also swallow a developer error into a broken silent state.
6. `refundApi.getJson`'s new `init` parameter — confirm it cannot be used to override the
   `Authorization` header or `credentials` in a way that changes `apiFetch`'s trusted-origin
   contract (ADR-0001).

## Spec amendment proposed (AC-5.7) — needs the user's decision at this gate

AC-5.7 requires new copy "in both Italian and English". **`refund-ui` has no Italian.**
`refund-ui/src/strings.ts` is a single English `en` dictionary; its own header records this as a
deliberate specs/007 Gate-2 decision ("centralize every string here … but ship ENGLISH ONLY — no
i18n *library*, no runtime locale switch", with the key-path shape kept i18n-ready). No Operai
frontend ships a second locale and none has an i18n library. Adding Italian for this feature's
~8 strings alone would produce a UI that is Italian in the suggestion list and English
everywhere else — worse than either consistent option, and not what the AC intends.

**Proposed amended AC-5.7:**

> AC-5.7: Given any text this feature adds to the UI, when it is displayed, then it comes from
> the app's centralised copy module (`refund-ui/src/strings.ts`), following that module's
> existing English-only, i18n-ready key-path convention — no hardcoded user-facing string is
> introduced. Bilingual (Italian + English) rollout remains a separate, app-wide concern
> tracked outside this feature.

If the user rejects the amendment, the alternative is in scope but much larger and should be its
own spec: introduce a `Record<Locale, Strings>` dictionary + `getStrings(locale)` seam + locale
detection/switch in the shell, and translate **all ~575 lines** of `refund-ui/src/strings.ts` —
roughly the size of this entire feature, and it would drag `admin-ui`/`estimai-ui`/`notify-ui`
along for consistency. No other AC in this spec is affected either way.

## ADR candidates

Two decisions here constrain future work beyond this feature. Neither is written by this plan.

1. **"Typed-query autocomplete matches client-side over a server-projected, pre-ranked personal
   corpus — the query text never leaves the browser."** The reusable rule and its trigger
   condition (applicable when the ranking signal is query-independent and the per-user corpus is
   small), the data-minimisation framing (distinct trips, not raw lines), the memory-only +
   `no-store` posture, and the named escalation to a per-query server endpoint (corpus cap
   pressure, or a corpus that stops being per-user). It should also record the sub-decision that
   **text folding for matching happens in application code, never via a Postgres `unaccent`/
   `pg_trgm`/FTS dependency** — the suite's first fork on that question, and the one a future
   search feature will reach for.
2. **"A derived projection over data the caller can already read through an existing gate reuses
   that gate."** The third data point on the new-permission-vs-reuse axis after ADR-0028 (new
   `settings` resource: different subject, must be separately grantable) and ADR-0031 (reuse
   `requireAdmin`: same authority, same subject), stated as a decision rule with the test
   "could a holder of the existing grant reconstruct this by hand? then a new permission
   withholds nothing and lies about a control that does not exist." It should also record that
   this route ignores the grant's *conditions* entirely and is self-scoped by construction, so
   a review/global grant can never widen it (AC-4.2).

Candidate 2 may reasonably be folded into candidate 1 as a second decision point if the caller
prefers a single ADR; they are independent enough to stand alone. The suite is at ADR-0040 —
numbers are for `adr-writer` to assign.
