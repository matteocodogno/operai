# 0025 — Money precision for mileage rates: integer micros + single round-half-up-at-compute-time rule, extending 007's integer-minor-unit posture

**Date:** 2026-07-20
**Status:** Accepted
**Deciders:** wellD
**Project:** Operai

---

## Context

`specs/007-refund-service` established a firm discipline for every monetary amount in refund-api:
integer minor units (cents/rappen) end to end — never `Decimal` or floating point for money.
`specs/009-mileage-rate` introduces a genuinely new kind of numeric value that discipline did not
previously need to cover: a **rate**, not an amount — a per-kilometre monetary figure (e.g. CHF
`0.70`/km) that is itself sub-cent-precision config, multiplied by an integer distance to produce
an integer amount. Two representation questions follow directly: what integer type stores a
value that is inherently a fraction of the minor unit, and what single rounding rule turns
`km × rate` into an exact integer number of cents without drifting between the client's live
preview (`refund-ui`, US-1/AC-1.2) and the server's authoritative, snapshotted computation
(`refund-api`, US-3). Any divergence between the two would surface as a genuinely confusing
production bug: the amount an employee watched update live while drafting would differ from the
amount actually saved at submit — precisely the class of drift 007's integer-minor-unit rule was
already written to prevent for amounts, now at risk again for the new rate/multiplication step
this feature adds in front of it.

## Decision

We will store each mileage rate as an integer `ratePerKmMicros` — an integer count of `1e-6` of
the entity's major currency unit per kilometre — and compute a line's amount as
`amountCents = roundHalfUp(km × ratePerKmMicros / 10_000)`, rounding **exactly once**, at compute
time, using a single canonical function shared (mirrored, with a shared test-vector set) between
refund-api (authoritative) and refund-ui (live preview only).

1. **Rate representation: integer micros.** `ratePerKmMicros` stores `1e-6` of the major currency
   unit per km — CHF `0.70`/km → `700000`. This stays a plain integer, honoring 007's "never
   `Decimal` or float for money" discipline even though a rate is configuration rather than a
   summed transaction amount; gives six decimal places of headroom, comfortably covering any real
   mileage policy value with room to spare; and is an exact power of ten, so conversion to and
   from an admin's decimal-string input (`"0.72"` ↔ `720000`) is always lossless.
2. **Amount computation: a single division, no intermediate rounding.** Both CHF and EUR use a
   2-decimal minor unit, so `km` (integer) `× ratePerKmMicros` (integer) is always an exact
   integer product; the single subsequent division by `10_000` (⇔ `÷1e6` to major units, `×100` to
   cents) and its round-half-up are the *only* rounding operation anywhere in the chain — there is
   no earlier point at which either operand is itself rounded before multiplication.
3. **Rounding rule: round half up** (`Math.floor(x + 0.5)` on a non-negative value; amounts are
   always ≥ 0 since a submittable line requires `km > 0` and `rate > 0`, AC-1.4). Chosen as the
   conventional, easily hand-verified accounting rule a non-technical admin or employee can
   sanity-check against their own back-of-envelope math, over banker's/round-half-even rounding,
   which is more "correct" in aggregate but harder to explain and unnecessary given how rarely a
   sub-cent tie actually occurs at these value ranges.
4. **Where it rounds, and who is authoritative.** Rounding happens at compute time; the resulting
   integer cents is what is stored in `requestedAmountCents` on snapshot (submit) and recomputed
   fresh on every draft read. refund-api's computation is always authoritative. refund-ui
   implements the **identical** rule in a shared `computeMileageAmountCents` function purely for
   live preview while drafting — the server's value always wins on save and on read; the client's
   copy is advisory display only, never trusted as input.

## Options considered

### Option A — Integer micros for the rate, single round-half-up division at compute time, one function shared client/server (chosen)

Described above.

**Pros:**
- Every intermediate value in the computation chain is an exact integer — `km`, `ratePerKmMicros`,
  and their product — so no floating-point representation error can enter anywhere before the
  single, deliberate final rounding step
- A single shared function with a shared test-vector set (including deliberately chosen half-up
  ties) gives refund-api and refund-ui **provably identical** results, closing the client/server
  drift risk (R1) at its source rather than through after-the-fact reconciliation
- Six decimal digits of rate headroom comfortably absorbs any real-world mileage policy value
  without ever forcing a schema change to add precision later
- The micros-to-decimal-string conversion for admin display/input is exact (division/multiplication
  by a power of ten), with no lossy round-trip

**Cons:**
- Micros is a less immediately obvious representation than "cents-per-km" to a first-time reader
  of the schema — the "why not just an integer count of centesimi/rappen per km" question has to
  be answered by this ADR rather than being self-evident from the column name alone
- Requires a small, dedicated serialization layer (`ratePerKmMicros` ↔ the admin-facing
  `ratePerKm` decimal string) that a coarser cents-per-km representation would not need, adding a
  narrow but real bit of conversion surface

### Option B — Store the rate as `Decimal`/floating point in its major-unit form (rejected)

Store `ratePerKm` directly as, e.g., a Prisma `Decimal(10,6)` or a plain JS number in major units.

**Pros:**
- Reads as the most "natural" representation on first glance — the stored value looks exactly
  like what an admin typed

**Cons:**
- Directly violates 007's established "never `Decimal` or float for money" posture, which this
  feature is explicitly extending, not carving an exception into
- A JS `number` is IEEE-754 binary floating point — the exact class of bug (`0.1 + 0.2 !== 0.3`)
  that motivates integer-minor-unit money handling in the first place, now multiplied against an
  integer `km` value at scale
- A `Decimal` type avoids the float bug but introduces a library/serialization dependency the rest
  of the schema does not otherwise use, and still requires an explicit rounding-mode decision at
  the multiplication step — it does not actually simplify anything Option A doesn't already handle
  with a plain integer
- Rejected: reintroduces exactly the precision-risk class 007's money discipline was written to
  eliminate, for no offsetting benefit

### Option C — Store the rate in cents-per-km (2-decimal precision) instead of micros (rejected)

Store, e.g., `70` for CHF `0.70`/km, matching the minor-unit granularity amounts already use.

**Pros:**
- Uses the exact same minor-unit granularity as every other money value in the schema — no new
  scale to learn

**Cons:**
- Loses precision the moment a real-world rate needs more than two decimal digits (e.g. a
  hypothetical CHF `0.685`/km, or a rate expressed to match a published per-mile/per-km policy
  figure with finer granularity) — a plausible future policy value the schema should not need a
  migration to accommodate
- Offers no lossless round-trip from an admin's arbitrary-precision decimal input beyond two
  places — any finer-grained value the admin types would have to be silently truncated or
  rejected, a worse UX than micros' effectively unconstrained headroom
- Rejected: trades away real precision headroom for a superficial consistency with amount
  granularity that the rate, as *config* rather than a *summed transaction value*, doesn't
  actually need to share

### Option D — Round half to even (banker's rounding) instead of round half up (rejected)

Use IEEE-754-style round-half-to-even at the single rounding step instead of round-half-up.

**Pros:**
- Statistically unbiased in aggregate over a large number of rounding events, avoiding a
  systematic upward drift banker's rounding is specifically designed to prevent

**Cons:**
- Meaningfully harder for a non-technical admin or employee to explain or manually verify against
  their own arithmetic — round-half-up is the rule most people already assume by default
- The stakes of the bias round-half-to-even guards against are negligible here: a single sub-cent
  tie on an individual mileage line, not a high-volume aggregation where systematic drift would
  compound meaningfully
- Rejected: optimizes for a statistical property this feature's scale doesn't need, at the cost of
  the intuitive-explainability property that actually matters for a config an admin sets by hand
  and an employee reads on their own claim

### Option E — Round the rate to a coarser precision before multiplying by `km`, rather than rounding only the final product (rejected)

E.g., round `ratePerKmMicros` down to cents-per-km first, then multiply by `km`.

**Pros:**
- Would make the intermediate "rate in use" value itself display-friendly at every step

**Cons:**
- Introduces a second rounding point into the chain, meaning error can now accumulate across two
  roundings instead of the single, bounded final rounding Option A performs — for a large `km`
  value, an intermediate rounding error is amplified by the multiplication rather than contained
  to at most one cent of final drift
- Directly undermines the "one canonical rule, one rounding point" property Decision 4 of ADR-0023
  and the client/server-parity guarantee both depend on
- Rejected: strictly worse numerical behavior than rounding once at the end, for no benefit

## Consequences

**Positive:**
- Exact integer arithmetic holds throughout the entire computation chain — no floating-point
  representation error is possible at any step before the single, deliberate final rounding
- refund-api and refund-ui are **provably** identical on every input, verified by one shared
  test-vector set (including deliberately chosen half-up ties) exercised by both services' unit
  tests — R1 (client/server rounding drift) is closed at the design level, not patched around
  after the fact
- Six decimal digits of rate headroom means no plausible future mileage-policy value will ever
  require a schema migration purely for precision reasons
- Extends 007's integer-minor-unit money discipline to a genuinely new value shape (a sub-cent
  rate, not a summed amount) without carving out an exception to that discipline, keeping "never
  `Decimal` or float for money" a suite-wide rule with no asterisk

**Negative / trade-offs:**
- Micros is a less self-evident representation than "cents-per-km" on first read — a future
  contributor modifying rate logic must consult this ADR (or the inline comment it justifies) to
  understand why the column holds `700000` rather than `70` for CHF `0.70`
- A small, dedicated conversion layer (`ratePerKmMicros` ↔ the admin-facing decimal string) exists
  purely because of this representation choice, and must be kept correct in both directions
  (display and parse) wherever the admin UI reads or writes a rate

**Risks:**
- **Client/server rounding drift (plan Risk R1).** Mitigated as designed: one canonical rule
  (this ADR), implemented once conceptually and mirrored in exactly two places (refund-api,
  refund-ui), exercised by a single shared test-vector set covering ordinary values and
  deliberately chosen half-up ties; the server value is always authoritative on save and read, so
  even a hypothetical implementation divergence could never persist an incorrect amount — only
  momentarily mis-preview one.
- **Conversion-layer bugs in the micros ↔ decimal-string round-trip.** A mistake in the admin-ui
  parse/format layer could misrepresent a typed rate. Mitigated by the conversion being an exact
  power-of-ten operation (multiply/divide by `1e6`), with no floating-point step involved, and
  covered by the same unit-test surface as the rounding rule itself.

## Compliance notes

Not applicable — this decision concerns only the numeric representation and rounding of a
non-personal, policy-configuration value (a per-kilometre rate). It carries no data-protection,
residency, or audit-trail dimension of its own; the audit and residency posture for the table this
value is stored in is recorded in ADR-0024.

This decision **extends** `specs/007-refund-service`'s integer-minor-unit money-handling posture
(never `Decimal` or float for any monetary value in refund-api) to a new value shape a rate
introduces, and defines the exact numeric representation stored by ADR-0024's `MileageRate` table
and consumed by ADR-0023's resolution-and-computation model — the three ADRs from this feature are
designed together and should be read as a set.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
