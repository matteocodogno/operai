# 0041 — Typed-query autocomplete matches client-side over a server-projected, pre-ranked personal corpus: the query text never leaves the browser, and text folding lives in application code, never in Postgres

**Date:** 2026-08-11
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/014-motivo-autocomplete` is the suite's first typed-query autocomplete: while an employee
composes a `travel_km` expense line, the Motivo field must propose past trips drawn **exclusively
from that employee's own expense lines** (US-4), matched as a normalised, accent- and
case-insensitive substring occurring **anywhere** within a past motivo (AC-1.4), ranked by how
many past lines each trip signature groups and then by that group's most recent expense date
(AC-2.3), capped at 8 displayed (AC-1.5), over a 24-month window (AC-2.4).

Motivo is free text that routinely names clients, sites and destinations. Combined with distance
and date, an employee's motivo history is a **partial movement history of an identified person**
under GDPR — the spec's own Security framing. Two acceptance criteria push directly on the
mechanism's shape rather than its output: AC-4.4 requires that "no new store, log, or record of
motivo text is created" by the interaction, and AC-4.3 requires that the backing mechanism,
"exercised directly rather than through the composer," never returns another user's line — a
textbook OWASP A01 requirement on a brand-new authenticated endpoint. AC-5.2 additionally
requires that any failure of the mechanism degrade **silently** to an ordinary text input, while
`refund-api` is an authorization-enforcing resource server that fails **closed** (ADR-0014) — a
tension that has to be resolved somewhere.

The spec left three questions explicitly open for this plan: whether matching happens server-side
per query or client-side over a fetched corpus; debounce and out-of-order handling; and whether
the accent-insensitive normalisation happens in the SQL query, in a generated/indexed column, or
in application code. The suite has no prior art for any of them — this is its first search-shaped
feature, and whatever is chosen here is what the next one will copy.

## Decision

We will fetch the caller's **entire ranked suggestion corpus once per composing session** from
one new parameterless, self-scoped read, and perform all query matching **in the browser**, so
that the typed query text is never transmitted at all; and we will implement the normalisation
fold in **application code on both sides**, taking no PostgreSQL extension, full-text-search or
trigram dependency.

1. **One parameterless projection endpoint.** `refund-api` gains
   `GET /line-suggestions?type=travel_km`, returning the caller's own `travel_km` trip signatures
   for the last 24 months — already grouped, ranked and capped — as
   `{ motivo, normalisedMotivo, km, entity, count, lastUsedOn }[]`. It accepts **no `q`, no
   `userId`, no `id`, no cursor** — a single-member enum is its entire input surface. `refund-ui`
   fetches it lazily (only once the query first reaches AC-1.2's 2-non-whitespace-character
   threshold), holds it in component memory, and thereafter filters synchronously on every
   keystroke with zero further network traffic.
2. **The trigger condition that makes this correct, stated so it can be reused or refused.**
   Client-side matching over a server-projected corpus is the right shape when **(a) the ranking
   signal is query-independent** — AC-2.3 orders by group count then recency, neither of which
   depends on what was typed, so the server can rank once and the client's per-keystroke work is
   a pure order-preserving *filter* — **(b) the corpus is per-user and small**, and **(c) the
   recipient of the whole corpus is the data subject themselves.** If any of the three stops
   holding, this decision must be revisited (see the escalation trigger, Decision point 7). When
   the ranking signal *is* query-dependent (fuzzy, phonetic or semantic matching — all explicit
   Non-goals here), sending the query to the server is unavoidable and this ADR does not apply.
3. **Privacy by construction, not by log hygiene.** With the query never leaving the page, AC-4.4
   is true *structurally*: there is no motivo fragment on the wire, in a URL, in a body, or in any
   intermediary's access log (Railway's, a proxy's, a future CDN's). `refund-api`'s own
   `src/lib/logger.ts` already logs path-only and deliberately drops query strings, but the
   hosting provider's access log does not — a per-query endpoint would have needed a
   POST-with-body purely to stay compliant with AC-4.4, i.e. compliance by discipline instead of
   by construction. Likewise AC-4.3: with no caller-controlled selector of any kind, there is no
   IDOR surface and no injection surface to test. That is the strongest available form of both
   criteria, not merely a passing one.
4. **Data minimisation on the response.** The endpoint returns **distinct trip signatures**, not
   the underlying lines: one representative motivo per group (the most recent line's text
   verbatim, AC-2.5), one km, one entity, one count, one date. The per-line history is never
   transmitted. The response is `Cache-Control: no-store` (a private browser cache may otherwise
   write an `Authorization`-ed response to disk, RFC 9111), and the client holds it in a
   component ref that dies with the composer — **never** `localStorage`, `sessionStorage` or
   IndexedDB. This extends ADR-0001's posture (never write a credential to web storage) from the
   JWT to personal data.
5. **A suggestion is derived on read, never a record.** No table, no materialised "trip"
   projection, no migration, no new index, no scheduled job — the query is a `groupBy` over
   existing `refund_line` rows scoped by `request.ownerUserId = sub`. This is ADR-0013's
   derived-state posture (`expired` is computed, never written by a sweep) applied to a read
   projection, and it is *why* AC-4.4 is satisfiable at all: there is nothing to create.
6. **Normalisation folds in application code, on both sides, asymmetrically.** The fold is
   `trim` → collapse internal whitespace runs → `normalize('NFD')` + strip `\p{Diacritic}` →
   `toLowerCase()` (locale-independent, never `toLocaleLowerCase`). It is implemented in
   `refund-api/src/suggestions/normaliseMotivo.ts` (for grouping) and
   `refund-ui/src/lib/tripSuggestions.ts` (for the query), with an **identical canonical vector
   list asserted in both test suites** — the mirrored-rule-plus-shared-test-vectors discipline
   ADR-0025 established for `computeMileageAmountCents`, made necessary again by the same cause
   (a deliberately mixed pnpm/Bun monorepo with no shared workspace package). Unlike ADR-0025's
   symmetric mirroring, this one is **asymmetric by design**: the response carries the server's
   `normalisedMotivo` for each suggestion, so the client folds only the *query* and never a
   candidate. The candidate side therefore has exactly one implementation, which bounds the blast
   radius of any divergence to query-side folding alone.
7. **The escalation trigger that flips this decision.** Move to a per-query server endpoint when
   any of: the 200-signature cap needs raising (i.e. real corpora are outgrowing a whole-corpus
   transfer); the corpus stops being strictly per-user (any team/department/shared trip history —
   which would also invalidate the "recipient is the data subject" argument entirely and require
   its own authorization decision, see ADR-0042); or matching becomes query-dependent
   (fuzzy/semantic). Separately, and independently of the transport shape: add
   `@@index([requestId, type, date])` on `refund_line` if a single user's lifetime line count
   approaches ~10 000 or this endpoint's p95 exceeds ~150 ms — a pure additive migration,
   deliberately not made now.
8. **The server keeps failing closed; only the client changes posture.** `authzMiddleware` still
   returns 503 on an `auth` outage for this route exactly as for every other — nothing here
   weakens ADR-0014. It is `refund-ui` that treats **every** non-2xx, network error and 5 s
   timeout from this one endpoint as "no suggestions", with no toast, banner or alert (AC-5.2).
   That is ADR-0032's silent-graceful-degradation posture applied to a *first-party* optional
   enrichment for the first time, and it follows the same organising principle ADR-0039 named for
   `estimai-api`: an authorization decision fails closed, a non-authoritative enrichment fails
   soft. It is safe to swallow precisely because the endpoint is read-only, derived and
   non-authoritative — and because a 503 here is always accompanied by a loud 503 on the line-add
   call the employee is actually blocked by.

## Options considered

### Option A — Client-side matching over a server-projected, pre-ranked corpus; folding in application code (chosen)

Described above. One request per composing session (plus one after each successful line add);
per-keystroke work is a synchronous filter over ≤200 in-memory objects.

**Pros:**
- The typed query text never exists outside the browser — AC-4.4 holds by construction, with no
  reliance on the hosting provider's log configuration, and no future logging change can break it
- No caller-controlled selector exists at all, so AC-4.3's "exercised directly" requirement has
  no parameter to attack: no IDOR surface, no injection surface, nothing to fuzz
- Silent degradation (AC-5.2) is the **default code path**, not an error branch: an empty corpus
  is indistinguishable from "nothing matches", which AC-1.6 already specifies as "no list, no
  message" — there is exactly one failure point and it fires before the employee has typed
  anything useful
- Per-keystroke cost is zero; a per-query design would pay `jwtMiddleware` + `authzMiddleware`
  (possibly a live `auth GET /authz/resolve` round trip, ADR-0014) + a grouping query 3–6 times
  per motivo at a 300 ms debounce
- Ordering is guaranteed once, server-side, as a deterministic total order; the client's
  order-preserving filter makes AC-1.7's "never shows a lower count than a suggestion below it"
  hold by construction rather than by a client-side re-sort that could drift from the server's

**Cons:**
- Ships the employee's whole (capped) trip corpus to the browser rather than only the handful of
  rows a given query would have matched — more personal data in transit and in page memory than
  the strictly minimal alternative, even though the recipient is the data subject
- The 200-signature cap is a real, bounded deviation from AC-1.4's "any matching trip": a
  pathological corpus (>200 distinct trips in 24 months) can hide a genuinely matching rare trip
  that ranks below the cap
- Corpus staleness within a long composing session is possible (a line added in another tab is
  invisible until the next invalidation), accepted rather than solved — no polling, no SSE
- The fold now exists in two codebases, kept in step only by mirrored canonical test vectors and
  review, with no compiler-enforced link between them

### Option B — Per-query server-side endpoint: send the typed fragment, match and rank in SQL (rejected)

`GET`/`POST /line-suggestions?q=…` debounced per keystroke, matching server-side and returning
only the ≤8 rows to display.

**Pros:**
- Strictly minimal data transfer — only matching rows ever reach the browser
- No cap-induced blind spot: the full corpus is always searched, so AC-1.4 holds unconditionally
- One implementation of the fold (server-side only), with no cross-codebase mirroring to keep
  correct
- Naturally handles a corpus far larger than any single response could carry, and is the correct
  shape the moment ranking becomes query-dependent

**Cons:**
- Puts fragments of personal free text on the wire on every keystroke burst — recordable by the
  hosting provider's access log, any proxy, or a future CDN. AC-4.4 would then hold only by
  log-hygiene discipline (forcing a POST-with-body purely to keep the text out of a URL), which
  is exactly the class of guarantee that silently breaks when infrastructure changes
- Reintroduces a caller-controlled selector, and with it a real AC-4.3 attack surface to design
  and test against, in exchange for nothing the corpus fetch does not already provide — because
  AC-2.3's ranking is query-independent, per-query computation buys no ranking fidelity at all
- Every keystroke becomes a fresh opportunity to fail mid-typing, and a slow response arriving
  after the employee has moved on is a live UX hazard; silent degradation becomes an error branch
  to maintain rather than the default path
- 3–6× the authenticated request volume per composed motivo, each paying the full
  `jwtMiddleware` + `authzMiddleware` chain
- **Rejected** for this feature's shape — but explicitly named as the escalation target if any of
  Decision point 2's three conditions stops holding

### Option C — Push the fold into PostgreSQL with the `unaccent` extension plus an expression index (rejected)

`CREATE EXTENSION unaccent`, an `IMMUTABLE` wrapper function, and an expression index over
`lower(unaccent(motivo))` to make the folded comparison sargable.

**Pros:**
- One authoritative implementation of the fold, in the database, with no cross-codebase mirroring
- The comparison becomes indexable, which would matter at a corpus size far beyond this one

**Cons:**
- `CREATE EXTENSION` is privileged DDL that must be granted on the managed Railway EU instance
  **and** present in every developer's local compose database **and** in CI — an
  environment-coupled dependency for every future contributor, introduced by a migration that can
  fail in exactly the environments hardest to debug
- `unaccent()` is only `STABLE`, not `IMMUTABLE`, so it cannot be indexed directly — an
  `IMMUTABLE` wrapper function must be authored and maintained, a well-known foot-gun if the
  extension's behaviour ever changes under it
- The whole apparatus exists to move a string fold that runs over a few hundred rows out of
  TypeScript — a large, permanent, environment-coupled cost for no measurable gain at this scale
- **Rejected:** disproportionate. This is the suite's first fork on the question, and the rule it
  sets is deliberate: **text folding for matching is application-code work until a measured query
  problem proves otherwise.**

### Option D — Full-text search (`tsvector`) or trigram matching (`pg_trgm`) (rejected)

**Pros:**
- The conventional answer for text search at scale, and the one a future contributor will reach
  for by reflex

**Cons:**
- `tsvector` FTS is lexeme/word-prefix oriented and would **not** satisfy AC-1.4's "occurs
  anywhere within" substring rule — `lug` matching mid-token inside `Lugano` is precisely what FTS
  does not do without trigram indexing bolted on top
- `pg_trgm` would satisfy it, but carries the same `CREATE EXTENSION` environment coupling as
  Option C plus an index whose maintenance cost is real, to search a per-user corpus of a few
  hundred rows
- Both are the right tools for a corpus orders of magnitude larger than this one, and the wrong
  tool for one bounded by a single employee's own history
- **Rejected:** over-engineering, and in the FTS case an outright acceptance-criterion mismatch

### Option E — Materialise a per-user "trip" table, maintained on line write (rejected)

Maintain a denormalised `employee_trip` table (signature, count, last-used) updated whenever a
line is created, edited or deleted, and read it directly.

**Pros:**
- Cheapest possible read; grouping cost paid once at write time rather than on every fetch
- Would scale to a corpus size at which the `groupBy` genuinely becomes expensive

**Cons:**
- Directly contradicts ADR-0013's established posture (derived state computed on read, never
  written and never swept) and the spec's own Domain language, which defines a suggestion as "a
  live, derived view over the employee's own past expense lines … never a stored object"
- Creates exactly the artefact AC-4.4 forbids: a **new store of motivo text**, with its own GDPR
  retention, erasure and drift obligations, and a reconciliation problem on every line
  edit/delete/status change
- Solves a performance problem that does not exist at this corpus size
- **Rejected** on all three counts

## Consequences

**Positive:**
- The strongest available form of AC-4.3 and AC-4.4: no query text on the wire, no
  caller-controlled selector, no new store, no new log, no migration. Neither criterion depends on
  a configuration setting, a logging policy, or anyone's future discipline
- Silent degradation (AC-5.2) is achieved without weakening `refund-api`'s fail-closed
  authorization posture (ADR-0014) — the client changes posture, the server does not; the
  authorization-fails-closed / enrichment-fails-soft split ADR-0039 named is applied inside
  `refund-api`'s consumer for the first time
- Per-keystroke network cost is exactly zero, and the whole feature adds one request per composing
  session to a service that gates every route on a live `auth` resolve
- The suite gets a stated, reusable rule for its first search-shaped feature — including an
  explicit refusal of the Postgres text-search stack — instead of an undocumented precedent that
  the next author has to reverse-engineer from a route handler

**Negative / trade-offs:**
- The employee's whole capped corpus is transferred and held in page memory, which is more
  personal data in flight than a per-query design would move. Accepted because the recipient is
  the data subject and the projection discloses **nothing new**: the same caller can already
  reconstruct the identical corpus from `GET /requests` + `GET /requests/{id}`, which return every
  line's motivo, km, entity and date. It is a strictly data-minimised re-shaping of data the
  caller already holds full read access to — but it does mean any future change that widens who
  can call this endpoint changes its privacy profile substantially, not marginally
- The 200-signature cap can hide a genuinely matching rare trip (plan risk R1) — a bounded,
  documented deviation from AC-1.4 for pathological corpora. It bites only after ranking, so what
  is dropped is by definition the least-used and least-recent trips, and an employee with >200
  *distinct* trips in 24 months does not have the repetition problem this feature exists to solve
- The fold lives in two codebases with no compiler-enforced link; only mirrored canonical vectors
  and review keep them in step. The asymmetry (server folds candidates, client folds only the
  query) bounds but does not eliminate the divergence risk
- An XSS anywhere in the shell or a remote can now exfiltrate the whole corpus in one call instead
  of enumerating requests — a marginal delta over the pre-existing enumeration path, named rather
  than mitigated further
- Corpus staleness inside a long composing session is accepted; only the case the employee can
  actually observe (a line they just added) is fixed, by invalidating on successful add

**Risks:**
- **A future contributor "optimises" by adding a `q` parameter.** Adding query text to this
  endpoint silently destroys every structural property Decision points 3 and 4 buy, and does so
  invisibly — nothing fails, the tests still pass, the text simply starts appearing in access
  logs. Mitigation: the schema test asserts the query object accepts **only** `type`; this ADR
  names the parameter's absence as a load-bearing property, not an omission.
- **Cap pressure is treated as a constant to bump rather than as a signal.** Raising 200 to 2000
  is a one-line change that would quietly turn a bounded corpus transfer into an unbounded one.
  Mitigation: Decision point 7 names cap pressure as the *escalation trigger to Option B*, not as
  a tuning knob.
- **The fold diverges between the two implementations** (plan risk R2), silently losing matches or
  mis-grouping. Mitigation: candidates are folded server-side only; an identical canonical vector
  list (casing, `à/è/ù/ö`, leading/trailing/internal whitespace, the `→` glyph, empty-after-trim,
  Turkish `İ`) is asserted in both suites in the ADR-0025 tradition.
- **A future search feature cargo-cults "no Postgres text search" past its case.** Options C and D
  are rejected *at this corpus size and for this substring rule*, not in principle. Mitigation:
  Decision point 6 and Option C state the rule with its condition attached — application-code
  folding until a measured query problem proves otherwise.
- **`auth` outage renders suggestions silently absent** (plan risk R6). Correct and intended, and
  explicitly documented here so a future reader does not "fix" the silence into a toast that
  AC-5.2 forbids.

## Compliance notes

- GDPR / nLPD impact: **medium** — motivo free text plus distance and date constitutes a partial
  movement history of an identified employee. No new personal data is collected, stored or logged
  by this decision; the endpoint is a minimised projection of data the caller already reads today.
  The design choices that carry the compliance weight are: query text never transmitted (nothing
  new is loggable anywhere), `Cache-Control: no-store` (never written to a browser disk cache),
  memory-only client retention (never web storage), and no new table or record (AC-4.4).
- Data residency: unaffected — the data never leaves `refund-api`'s existing EU-region PostgreSQL
  database and its EU-region deployment; no third party is involved at any point, and the
  browser-direct posture of ADR-0032 does not apply here (there is no third party to call).
- Audit trail: not required and deliberately not added. A read of one's own derived history is not
  a financial or governance event; adding a record of it would create exactly the motivo-text
  store AC-4.4 forbids. This is the opposite outcome to ADR-0018/0022's append-only financial
  audit trail, for the opposite reason.

This decision applies ADR-0013's derived-on-read posture to a read projection (no stored trip
table, no sweep), extends ADR-0001's never-web-storage rule from the JWT to personal data,
reuses ADR-0025's mirrored-rule-with-shared-canonical-vectors discipline for the fold (in an
asymmetric variant that keeps one implementation of the candidate side), and applies ADR-0032's
silent-graceful-degradation posture to a first-party enrichment for the first time — while
leaving ADR-0014's fail-closed server posture entirely intact, on the authorization-fails-closed /
decoration-fails-soft split ADR-0039 articulated. The authorization gate for the endpoint this
ADR introduces is decided separately in **ADR-0042**.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
