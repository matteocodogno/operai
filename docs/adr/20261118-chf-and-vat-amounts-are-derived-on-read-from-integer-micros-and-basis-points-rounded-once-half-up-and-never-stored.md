# 20261118 — The CHF amount and the VAT amount of a line are derived on read from integer micros and basis points, rounded once each, half up, and never stored

**Date:** 2026-11-18  
**Status:** Accepted — approved plan of specs/20261118-refund-accounting-export (approved 2026-11-18 under the owner's pre-authorisation of an unattended run; review on the owner's return); "Amount rules" and trade-offs of the plan. Plan ADR candidate 4.  
**Deciders:** Matteo Codogno (product owner), by pre-authorisation of the unattended run; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20260720-mileage-rate-money-precision-integer-micros (the rule this extends), ADR 20260714-invitation-lifecycle-derived-expiry-state (derived on read), ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-outbound-fetch-is-hardened (where the rate comes from), ADR 20261118-accounting-classification-is-live-until-approval-then-frozen-and-changing-it-afterwards-needs-request-reclassify-and-is-refused-by-the-database-once-paid (where the VAT code comes from).

---

## Context

Refund keeps every amount as integer cents (specs/20260716-refund-service) and rates as integer micros (ADR 20260720-mileage-rate-money-precision-integer-micros). The accounting export needs two new figures per WellD CH line: the **CHF amount** of a line in EUR, USD or GBP at the monthly average rate (AC-6.3), and the **VAT amount** contained in the CHF amount at the frozen VAT code's rate (AC-3.8, AC-6.4). The same figures appear on the review screen and in the file, and accounting compares the file to the books to the cent. Two inputs can change after approval without touching the line: an admin may **correct** a month's rate (AC-5.3), and a VAT code is immutable but a line can be reclassified while unpaid (AC-3.6). A figure stored at approval would therefore disagree with the corrected rate, and would need a recompute path. The rate of a month can also be missing at the time (AC-5.5, AC-6.5).

## Decision

We will compute both figures on read, in integer arithmetic with `BigInt`, from the line's approved amount, the rate in effect and the frozen VAT code's rate in basis points, round **once** per figure, half up, and store neither.

1. **CHF amount** (`chfCents`): `round(amountCents × rateMicros / 1_000_000)`. For a CHF line it is `amountCents` itself, with no rate. Example: 1040 × 924600 / 1e6 = 961.584, which gives **962** (AC-6.3).
2. **VAT amount** (`vatCents`): `round(chfCents × bp / (10_000 + bp))`, which equals the amount minus the amount divided by (1 + rate) before rounding. It is computed **from the rounded CHF amount**, so the file's VAT is always consistent with the file's CHF column. Example: 2080 × 810 / 10810 = 155.86, which gives **156** (AC-6.4).
3. **Rounding.** Half up on non-negative integers, exactly once per figure, never on an intermediate. Amounts are 0 or greater (a line approved at 0 yields 0.00 and 0.00, AC-6.12).
4. **Rate in effect** for a line is the rate for (line currency, month of `line.date`): the latest corrected entry, else the fetched one. The amount is `approvedTotalCents ?? requestedAmountCents` before approval (D11) and `approvedTotalCents` after.
5. **A missing input is `null`, never a default.** With no rate in effect, `chf.amountCents`, `rate` and `vatAmountCents` are `null` with `rateMissing: true` (AC-3.8) and the export refuses with a blocker (AC-6.5). With no VAT code the VAT amount is `null`. Neither becomes 0, nor a rate of 1.
6. **One module, golden vectors.** `amounts.ts` is pure; `amounts-vectors.json` holds the vectors (including AC-6.3 and AC-6.4) read by the unit tests and by the golden CSV test. The UI shows the server's figures and recomputes nothing.
7. **Rates travel as integers.** `rateMicros` (CHF per 1 unit × 1e6; 0.9246 becomes 924600) in the data and API, with a display string for people. An admin's decimal string `^\d{1,4}(\.\d{1,6})?$` converts losslessly.
8. **Consequence accepted:** after a rate correction, a later export of the same batch differs from an earlier one (AC-6.8, risk R9). The export log's content hash makes the change visible (see ADR 20261118-the-accounting-export-is-generated-on-request-never-stored-and-logged-append-only-with-its-content-hash-and-format-version).

## Failure shape

**A money figure that exists in several places (a screen, a file, a ledger) is computed in each from rounded, stale or partial inputs, so the places disagree by a cent; or a stored copy outlives the input it was computed from and nobody can say which is right; or a missing input turns into a plausible number.** The defect is invisible in any single place and shows when a person compares two. A stored derivation is correct on the day it is written and wrong later, without any write to blame.

Where else this shape can appear, including the mirror-image positions:

- **Gross to net and net to gross.** The formula here extracts VAT from a gross amount. Adding VAT to a net amount is a different division with a different rounding result; a future feature that goes the other way must state its rule and its vectors, not borrow this one.
- **Line and total.** A total computed from unrounded inputs will differ from the sum of the lines in the file. Any future total must be defined as the sum of the per-line rounded figures. This ADR does not add a total; it names the hazard.
- **Preview and authoritative.** A second implementation for a live display (as the mileage rate has) must share the vectors, or the figure watched differs from the figure saved. Here the UI does not compute, which removes the second copy.
- **Store and derive.** Storing a derived value is right when the inputs are frozen at that moment (a snapshot); here one input (the rate) can be corrected afterwards, so the value is derived. Recognise the situation by asking whether an input can change after the value is written and who would recompute.
- **Present and absent.** The mirror of "a missing rate becomes 0" is "a missing rate silently drops the line from the file". Both are refused: the blocker names the (currency, month).
- **Rounding order.** Rounding the converted amount and then the VAT, versus converting the VAT, gives different cents. The order is fixed here and tested; a change is a format-version change.

## Options considered

### Option A — Derived on read, integer arithmetic, one rounding per figure, VAT from the rounded CHF amount (chosen)

Described above.

**Pros:**
- Always consistent with the rate in effect; a correction needs no recompute job
- No float or decimal type for money anywhere; the rule can be checked by hand against the vectors
- The file is self-consistent: its VAT follows from its CHF column

**Cons:**
- The same batch can export different bytes after a rate correction (accepted, logged by hash)
- Every read recomputes (a few multiplications per line; negligible at 253 rows a year)

### Option B — Store the CHF and VAT amounts at approval (rejected)

**Pros:**
- A fixed figure per line

**Cons:**
- Stale after a rate correction (AC-5.3), would need a recompute path and a second source of truth, and the month's rate may not exist at approval time

### Option C — Floating point or a decimal library (rejected)

**Pros:**
- Shorter code

**Cons:**
- Departs from the suite's integer-minor-unit rule (ADR 20260720-mileage-rate-money-precision-integer-micros); float tie cases (x.5) are not exact

### Option D — Banker's rounding (rejected)

**Pros:**
- Unbiased in aggregate

**Cons:**
- Harder for accounting to verify by hand; the suite's rule is half up (same reason as ADR 20260720)

### Option E — VAT computed from the original-currency amount, then converted (rejected)

**Pros:**
- VAT is tied to the receipt's own currency

**Cons:**
- The books receive CHF; VAT from the CHF column keeps the file self-consistent, and the spec defines VAT on the CHF amount (AC-3.8)

## Evidence

- Pattern: integer micros and one rounding at compute time in ADR 20260720-mileage-rate-money-precision-integer-micros.
- Planned, not yet run (plan, Test strategy, AC-3.8, AC-6.3, AC-6.4, AC-6.8, AC-6.12): `amounts-vectors.json` unit tests (1040 EUR at 924600 gives 962; 2080 at 810 bp gives 156), the golden CSV row reading `10.40;0.9246;9.62` and `8.10;1.56`, an accounting-view test with a missing rate (`rateMissing: true`, `vatAmountCents: null`), a line approved at 0 giving `0.00`, and an export-twice test (identical bytes) followed by a correction (different hash).

## Consequences

**Positive:**
- Screen and file cannot disagree, because both call the same pure functions
- A corrected rate takes effect everywhere at once, and the export log shows that the file changed
- No migration, column or backfill for the figures

**Negative / trade-offs:**
- A previously downloaded file can no longer be reproduced after a correction unless the old rate history is read (it is kept: fetched and corrected rows are append-only)
- A payment or booking made from an exported file is not tied to the figure at that moment except by the hash in the export log

**Risks:**
- **Re-export after a correction differs from a file already imported** (R9). Mitigation: allowed by AC-6.8; the log keeps hash and actor per download.
- **Overflow.** Products stay far below 2^53 for realistic amounts, and `BigInt` is used regardless.
- **A future total or a gross-from-net feature reusing these functions** by name. Mitigation: the hazards above, and the vectors file as the place to add its rule.

## Escalation triggers

This decision is revisited when any of these happens:

- accounting needs a VAT total or a CHF total per batch or per employee (define it as the sum of per-line rounded figures, with vectors);
- accounting requires the figures to be frozen once exported, or once the batch is paid (then snapshot at that transition, as for the classification);
- a currency with a number of minor-unit digits other than 2 is accepted;
- accounting's system rounds differently and the file must match it (a format-version change, not an edit).

## Compliance notes

- GDPR / data-protection impact: none. The figures are derived from amounts already held.
- Data residency: no change.
- Audit trail: a rate correction is audited in `exchange_rate_entry` (actor, time, history); the figures themselves have no row of their own, and the export log carries the hash of what was delivered.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
