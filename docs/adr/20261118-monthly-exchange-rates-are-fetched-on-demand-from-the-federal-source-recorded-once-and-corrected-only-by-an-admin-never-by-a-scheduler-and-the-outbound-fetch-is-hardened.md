# 20261118 — Monthly exchange rates are fetched on demand from the federal source, recorded once and corrected only by an admin, never by a scheduler, and the outbound fetch is hardened

**Date:** 2026-11-18  
**Status:** Accepted — approved plan of specs/20261118-refund-accounting-export (approved 2026-11-18 under the owner's pre-authorisation of an unattended run; review on the owner's return); decisions D10 and R2 of the plan. Plan ADR candidate 1. The source itself is still to be confirmed by accounting (spec open question 1); the mechanism does not depend on the answer.  
**Deciders:** Matteo Codogno (product owner), by pre-authorisation of the unattended run; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20260714-invitation-lifecycle-derived-expiry-state (no cron for what is needed only when read), ADR 20261118-assignment-reminders-in-process-scheduler-claimed-by-cas (the line this ADR draws against), ADR 20260720-mileage-rate-history-self-auditing-table and ADR 20260722-refund-settings-append-only-self-auditing-store (config that is its own audit trail), ADR 20261118-chf-and-vat-amounts-are-derived-on-read-from-integer-micros-and-basis-points-rounded-once-half-up-and-never-stored (what consumes the rate).

---

## Context

The accounting export converts every non-CHF line of WellD CH to CHF at the **monthly average rate** of the month of the expense date (AC-5.1 to AC-5.7, AC-6.3). Nobody types these rates today beyond the paper register. The plan found a federal source that publishes them: the BAZG (Federal Office for Customs and Border Security) XML endpoint `https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=<YYYY>&m=<MM>`, which on 2026-11-18 returned EUR 0.9246 for March 2026, the register's value. The same check showed that the source also answers for the **current** month and for a **future** month (`m=11` and `m=12` of 2026 returned values), returned nothing for May 2027, and ignores a `?d=` parameter (it returns the current month). A rate is needed only at the moment someone reads a number built from it (an approval screen, a settings page, an export). No action toward a person depends on it. The suite has one in-process scheduler (assignment reminders) and forbids schedulers for state that can be derived on read. The response is an XML document from a third party that we parse, and the host is called from a service holding financial data.

## Decision

We will fetch the monthly averages **on demand** in refund-api (`src/fx/`), never from a scheduler or a Railway cron, record each (currency, month) **once** and never overwrite it, let only an admin change the rate in effect, by appending a correction, and harden the outbound call as below.

1. **Triggers, and only these.** The admin's "Fetch now" (`POST /exchange-rates/fetch`), the Settings card's automatic call when `GET /exchange-rates` says `fetchDue` and the user holds `settings:manage`, and an export that finds a rate missing. There is no tick.
2. **A month is fetchable only when completed plus 5 grace days** (`FX_FETCH_GRACE_DAYS = 5`, Europe/Zurich). The source answers for unfinished months, so "the source returned a value" is not evidence that the value is final.
3. **The call is fixed and bounded** (`bazgSource.ts`): one constant https host (not an env var), `redirect: "error"`, 5 s timeout per call, the months of one trigger fetched in parallel under a 10 s total budget (`FX_FETCH_BUDGET_MS`, plan G6), 512 KiB body cap, no input in the URL beyond a validated year and month. The `REFUND_FX_SOURCE` switch only chooses `bazg` or `off`; it never carries a URL.
4. **The answer is checked before it is believed** (`parse.ts`, pure): a document with `<!DOCTYPE` or `<!ENTITY` is refused (no library resolves entities); the `<monat>` echo must equal the requested month; only the `eur`, `usd` and `gbp` entries are read; unit `1` or `100` is normalised to "per 1 unit"; the parsed rate must be greater than 0 and less than 1000.
5. **Spending is bounded**: no new attempt for a month within 15 minutes of the previous one, single-flight per month in the process, at most 6 months per trigger. One HTTP call covers the three currencies of one month.
6. **Recorded once.** `exchange_rate_entry` is append-only (trigger) and a partial unique index `(currency, month) WHERE origin = 'fetched'` plus `ON CONFLICT DO NOTHING` means a fetched value is never replaced. When a later fetch sees a different value, nothing changes; the difference is written to the attempt log (`discrepancies`) only. No API field or screen shows it yet (plan G8; follow-up FU-S2/F3), so an admin notices it through the log or by comparing with the source.
7. **Rate in effect** = the latest `corrected` row, else the `fetched` row. A correction is a new row with actor and time; the fetched value stays in the history (AC-5.3). A correction wins over any later fetch (AC-5.4).
8. **A failure is data, not an error.** Timeout, HTTP error, parse failure, wrong month or a missing currency write a `exchange_rate_fetch_attempt` row (`outcome failed`, an `errorCode`) and leave every rate untouched. `POST /exchange-rates/fetch` answers 200 with the outcome. In the export path a failed fetch becomes an ordinary "missing rate" blocker, never a 5xx (AC-5.6, AC-6.5, R10).

## Failure shape

**A figure that other numbers are computed from is changed, or is believed, without anyone having decided it.** Two ways in. First, the outside party's answer is accepted although it does not answer the question we asked (the wrong or unfinished period, a different unit, a document that carries instructions as well as data) and is then trusted as final. Second, a later read of the same source quietly replaces what an earlier computation already used, so a file that was exported and imported elsewhere can no longer be reproduced and nobody changed anything on purpose. The outside party's *failure* is the third way in: it must not become our failure (a 5xx on an unrelated action) nor become a plausible number (0, 1, last month's value).

Where else this shape can appear, including the mirror-image positions:

- **Inbound and outbound.** The mirror of "a document we parse can carry instructions (entity expansion)" is "a value we send can steer the call (a caller-chosen host, path or redirect)". Any new outbound client has a constant destination and validated parameters; any new parser refuses constructs it does not need. Never put personal data in an outbound request to a third party without its own decision; this call carries only a year and a month.
- **First read and re-read.** Any cache, import or refresh of external reference data (a tariff, a holiday calendar, a VAT rate list, a mileage table) that overwrites in place has this shape. Recognise it by asking whether a number already shown, exported or booked can change without an actor in the history.
- **Fetch and correct.** A human correction must survive the next automatic read; the automatic read must surface the difference rather than win or lose it silently.
- **Period fields.** A source that answers for the current or a future period is "available", not "final". Anything keyed by a period needs a rule for when the period is closed.
- **Schedule and demand.** A scheduler for data nobody reads is the mirror of an on-demand fetch that nobody triggers: the first costs a second runner and a credential, the second can leave a value missing at the moment it is needed. This ADR chooses the second and makes "missing" a visible state (AC-5.5), not a default.
- **Test and live.** A fake source injected in every test hides a real source's behaviour. The recorded real response (2026-03) backs the parser test for that reason.

## Options considered

### Option A — On demand, recorded once, corrections append, hardened client (chosen)

Described above.

**Pros:**
- No new scheduler, runner or credential; the value exists exactly when someone needs it
- A rate cannot change under an exported file without a visible admin action
- The parser and the call are small, pure and testable with a recorded fixture
- A failed source degrades to a named blocker the user can resolve by correcting the rate

**Cons:**
- The first reader of a month waits up to about 10 s (calls in parallel, 10 s total budget, throttled, at most 6 months)
- A month nobody triggers stays missing; the card shows it, and the export lists it
- Depends on one third-party endpoint whose stability we do not control (corrections cover it)

### Option B — An in-process scheduler tick in refund-api (rejected)

**Pros:**
- Rates are present before anyone asks

**Cons:**
- A second scheduler in the suite for data needed only at read time. ADR 20261118-assignment-reminders-in-process-scheduler-claimed-by-cas justified its tick by an action toward a person that must happen when nobody reads anything; nothing here has that property

### Option C — A Railway cron service (rejected)

**Pros:**
- Independent of the API process

**Cons:**
- A second deployable, a second credential and an internal route, for the same reason as B

### Option D — Let the source overwrite on every fetch (rejected)

**Pros:**
- Always the latest published value

**Cons:**
- A file already exported would change under accounting with no one to ask; the source answers for unfinished months, so "latest" is not "final"

### Option E — Admin types every rate by hand (rejected)

**Pros:**
- No outbound call at all

**Cons:**
- The error-prone manual step the feature removes; kept as the **correction** path, not the main one

## Evidence

- Source check, 2026-11-18, recorded in plan R2 and D10: `j=2026&m=03` returned EUR 0.9246 (register value); `m=11` and `m=12` of 2026 returned values; `m=05` of 2027 returned none; `?d=` ignored.
- Planned, not yet run (plan, Test strategy, AC-5.1 to AC-5.7, AC-6.5): unit test of `parse.ts` on the recorded 2026-03 fixture (EUR 924600, USD 780800, GBP 1063500, `<monat>` 2026-03), a DOCTYPE document, a wrong `<monat>`, a missing currency and a unit of 100; int tests with an injected fake source for fetch, correct-then-fetch-again (the correction stays, the discrepancy is logged), timeout and wrong-month failures (no rate row changes, `lastFetch.outcome = "failed"`), and a missing rate blocking the export while compile, mark-paid and discard still succeed; a db test that `exchange_rate_entry` rejects UPDATE and DELETE (AC-5.3). A test that a second `fetched` row for one (currency, month) is refused by the partial unique index is not in the plan's table yet and should be added with the migration.
- Security review surface 3 (plan, Security): SSRF, XXE and entity expansion, size cap and timeout.

## Consequences

**Positive:**
- Every rate used in a file has a recorded origin (fetched with URL, month echo and time, or corrected with actor and time)
- No scheduler, cron or new credential is added to the suite
- A third-party outage shows up as a missing-rate blocker, not as an error elsewhere

**Negative / trade-offs:**
- A discrepancy between the source and a fetched row is only reported, never applied; an admin must act
- `FX_FETCH_GRACE_DAYS = 5` is an estimate of when the source is final, to be confirmed with accounting

**Risks:**
- **The source's meaning of early values is unknown** (plan R2, spec open question 1). Mitigation: completed month plus 5 days, the `<monat>` echo, record once, discrepancies logged, admin correction always available.
- **The endpoint changes shape or disappears.** Mitigation: the parser fails closed with `parse`, the month stays missing, an admin can correct; the URL and the grace constant are the only things to change.
- **Wrong Europe/Zurich month boundary** near midnight on the last day of a month. Mitigation: the "completed" test is on the Europe/Zurich calendar date; a unit vector at the month boundary is not in the plan's test table yet and should be added with `fx.service.ts`.

## Escalation triggers

This decision is revisited when any of these happens:

- accounting names a different official source, or asks for rates of another kind (daily, end-of-month);
- a second service needs external reference data: apply this shape, and extract the client rules (fixed host, no redirect, size cap, no entity resolution) into a shared helper;
- an action toward a person ever depends on a rate being present: then it is a scheduler case under ADR 20261118-assignment-reminders-in-process-scheduler-claimed-by-cas;
- a currency other than EUR, USD and GBP is accepted on a WellD CH line.

## Compliance notes

- GDPR / data-protection impact: none. The outbound request carries a year and a month and no personal data; the stored rows hold no personal data except the admin's user id and email on a correction.
- Data residency: the endpoint is a Swiss federal service and receives nothing personal; the rows live in refund-api's database, in the suite's EU region.
- Audit trail: required (AC-5.2, AC-5.3, AC-5.6). Tier 1 immutability triggers on `exchange_rate_entry` and `exchange_rate_fetch_attempt`.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
