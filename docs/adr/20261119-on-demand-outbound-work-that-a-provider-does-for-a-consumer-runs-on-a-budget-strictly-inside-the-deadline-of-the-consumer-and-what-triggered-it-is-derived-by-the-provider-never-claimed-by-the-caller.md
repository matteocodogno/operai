# 20261119 — On-demand outbound work that a provider does for a consumer runs on a budget strictly inside the deadline of the consumer, and what triggered it is derived by the provider, never claimed by the caller

**Date:** 2026-11-19  
**Status:** Accepted — approved plan of specs/20261119-accounting (approved 2026-11-19 under the owner's choice of autonomous execution at spec approval, no plan gate; review on the owner's return); decision D4 and risks R4 and R6 of the plan; closes follow-up FU-S5 of specs/20261118-refund-accounting-export (security review S-09). Plan ADR candidate 3, kept as its own record (see "Why this is not folded into the rates amendment").  
**Deciders:** Matteo Codogno (product owner), by choice of autonomous execution; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20261119-accounting-reference-data-belongs-to-accounting-api-which-consumers-read-live-with-no-copy-kept-across-requests-copy-by-natural-key-onto-what-they-book-and-refuse-to-act-when-they-cannot-read-it (the consumer's deadline and its meaning of "unreachable"), ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-outbound-fetch-is-hardened (the work whose budget this bounds, amended 2026-11-19), ADR 20261118-a-pin-ahead-of-the-held-version-forces-one-registry-refresh-at-most-once-a-second-and-100-times-in-10-minutes-per-process-and-any-other-mismatching-pin-is-answered-409-at-once (the same worry, a caller-chosen value must not make a service spend a third party's bounded resource), ADR 20261103-projects-api-reads-crm-companies-with-scoped-service-credential (who may ask).

---

## Context

When refund-api asks accounting-api for the rate of a month that is not yet recorded, accounting-api may have to fetch it from the federal source before it can answer (AC-2.10). The consumer's whole operation, including its token mint, has a deadline of 10 seconds (`ACCOUNTING_DEADLINE_MS`, AC-6.8) and treats anything later as "Accounting unreachable", which refuses an approval (AC-6.1). Left as it was in 20261118, the provider's fetch budget was 10 seconds for up to six months in parallel: a provider that is up and doing exactly what was asked would regularly look dead to its consumer. Separately, 20261118's security review found that the label saying *why* a fetch happened (the attempt log's `trigger`) was supplied by the caller (S-09, FU-S5): harmless while the permission and the actor were server-side, but a label the caller claims is not evidence, and a provider that now accepts calls from a service principal and from users needs the log to say which.

## Decision

We will give the provider's on-demand outbound work for a consumer a **budget strictly inside the consumer's deadline** (`CONSUMER_FETCH_BUDGET_MS = 6000` inside `ACCOUNTING_DEADLINE_MS = 10_000`, with 5 s per call, at most 6 months per call, a 15-minute throttle and single flight per entity and month), assert the relation between the two constants in a test that reads both packages, and **derive the trigger of every attempt on the server** from how the caller authenticated, never from a field the caller sends.

1. **Budget under deadline, with a margin.** The consumer's route answers within about 6.5 s when the provider's work is at its budget, inside 10 s. A missing month that could not be fetched in time is answered `missing` with a reason (`fetch_failed`), not left hanging; the consumer then treats it as a missing rate (a pending copy, or a blocker), which is a correct, named outcome and not an outage.
2. **A test fixes the relation.** `CONSUMER_FETCH_BUDGET_MS + margin < ACCOUNTING_DEADLINE_MS` is asserted across the two packages by a repo-level test that reads both constants. Changing either constant without the other fails the build.
3. **The trigger is derived.** An attempt is logged with `trigger = manager` when the caller is a user holding `accounting:manage` covering the entity, and `consumer` when the caller is a verified service principal on the allowlist. The request body has no `trigger` field; a body that carries one is refused or the field is ignored and never stored.
4. **The consumer bounds what it can cause.** A consumer call asks for 1 to 36 distinct pairs; at most 6 months are attempted per call; only completed months (plus the grace days) are fetched; the host is a constant. A caller cannot widen any of these.

## Failure shape

**A service that is up and working is judged dead because the party waiting for it gave up before it finished; and a party that asks for work can influence how much work is done or how that work is described.** The first: two timeouts that were each reasonable are not nested, so the inner one outlasts the outer and the consumer turns the provider's slowness into the provider's absence, which in this system refuses a business action. The second: a value from the caller (how many, which, and why) is accepted as a fact about the work, so the log can say something the caller wished and the spend can follow the caller's choice.

Where else this shape can appear, including the mirror-image positions:

- **Outer and inner.** Every chain of calls has the rule "each inner deadline fits inside the outer minus a margin": consumer to provider to third party; a browser request to an API to a database; a job runner's lease to the job's own timeout. Recognise it by two timeouts defined in two places with no test that relates them. The mirror is an inner budget so small that normal work always fails; the margin is a choice with a stated reason.
- **Do work and describe work.** The provider decides what the work is called in its own log (who triggered it, why) from what it verified, the way it takes the actor from the token. Any audit or log field that records *why* or *who* and is filled from the request body has this shape, in a read route as much as in a write route.
- **Ask and be asked.** The consumer's side of the same contract also has a bound: how many items it may ask for, how long it waits, how many times it retries (once, inside the same deadline). The provider's bounds protect the third party; the consumer's bounds protect the provider.
- **Fast path and slow path.** A route that is usually a lookup and sometimes does outbound work (here: a recorded rate vs a missing month) must have its slow-path bound written down, because only the slow path can break a deadline, and it will do so on the one day the third party is slow.
- **Time and cost.** A budget in seconds is a bound on time; the provider also needs one on spend toward the third party (the throttle and single flight). Bounding one does not bound the other.
- **Another provider.** Any provider that, on a consumer's request, calls something else (a registry, a PDF source, an AI model, a payments API) is in this position the day it gains a consumer with a deadline.

## Why this is not folded into the rates amendment

The plan allowed folding this into amendment A1 of the exchange-rates ADR. It is kept as its own record because the rule is about how deadlines nest between any consumer and any provider, and about who may name a trigger; the rates are only its first case. An amendment to a rates-specific ADR would be found by someone changing rates, not by someone writing the next provider that fetches on demand. A1 therefore records what changed for the rates and points here for the rule. The consumer-read ADR keeps its own failure shape (a decision made from something other than what the owner says now) and does not absorb this one (a provider judged dead by a consumer, and a caller-claimed label).

## Options considered

### Option A — A provider budget strictly inside the consumer deadline, a test relating them, and a server-derived trigger (chosen)

Described above.

**Pros:**
- A reachable provider answers in time: a slow third party becomes a `missing` rate with a reason, not an outage
- The relation is a build failure if someone edits one number
- The log's trigger is evidence, because the server wrote it from the verified principal

**Cons:**
- Six seconds may not be enough for six months from a slow source: some months stay missing for the consumer on the first ask, and the throttle delays the next attempt by 15 minutes (a manager can fetch or enter the rate)
- Two constants in two services that must stay related

### Option B — Keep the provider's 10 s budget and raise the consumer's deadline (rejected)

**Pros:**
- No change to the provider

**Cons:**
- Every approval could wait longer than AC-6.8 allows; the spec fixes the 10 s; the next chain would nest the same way

### Option C — The provider answers at once and fetches in the background (rejected)

**Pros:**
- The consumer never waits

**Cons:**
- A second runner for data needed only at read time (the 20261118 rejection of a scheduler applies); the consumer still has to decide what to do with "not yet"

### Option D — Accept the trigger label from the caller (the 20261118 behaviour, rejected)

**Pros:**
- No code

**Cons:**
- The log can claim a trigger the caller did not have; with two kinds of caller, the label is the only thing that tells the log which one acted

## Evidence

- **Executed and green, 2026-11-19** (specs/20261119-accounting/qe-report.md (re-test after fix round 1: accounting-api 655 pass, refund-api 1799 pass, auth 1497 pass, 0 fail, also with `--randomize` and on databases migrated from zero)): `accounting-api/src/rates/rates.service.test.ts` (a source hanging 30 s answered `missing`/`fetch_failed` in under 7 s; the manager's 10 s budget; 36 pairs over 12 months attempt at most 6 months; a second call within 15 minutes is throttled with no outbound call; the attempt carries `consumer` and `system:refund-api`, or `manager`), `accounting-api/src/budgets.cross-package.test.ts` (`CONSUMER_FETCH_BUDGET_MS` + 1 s < refund-api's `ACCOUNTING_DEADLINE_MS`), `accounting-api/src/rates/rates.routes.test.ts` (a body carrying `trigger` → 422 `invalid_request`, nothing attempted) and `contract.refund-client.test.ts` (a consumer-triggered fetch through the real client).
- As planned before implementation (kept for the record): an int test with a fake source that hangs for 30 s, answered `missing` in under 7 s; the cross-package constants test; 36 pairs over 12 months attempting at most 6 months; a second call within 15 minutes throttled with no outbound call; an attempt row carrying `consumer` and actor `system:refund-api` for a consumer call, and `manager` for a manager's call, whatever the body says.

## Consequences

**Positive:**
- A reachable Accounting is not mistaken for an unreachable one
- The attempt log is trustworthy about who triggered what, and a consumer cannot widen what it causes

**Negative / trade-offs:**
- A cold month asked by the consumer can come back `missing` on the first ask under a slow source

**Risks:**
- **Timeouts compose badly again** after a later edit (R6). Mitigation: the cross-package constants test.
- **A consumer can trigger outbound fetches** (R4). Mitigation: only `system:refund-api`, at most 36 pairs and 6 months per call, completed months only, throttle and single flight per entity and month, fixed host.

## Escalation triggers

This decision is revisited when any of these happens:

- logs show consumer calls regularly answered `missing` with `fetch_failed` for months the source does have: raise the budgets together, or have the manager's auto-fetch warm the months;
- a second provider with on-demand outbound work for a consumer is built: apply the nesting rule and the derived trigger, and consider a shared helper for the budget;
- the consumer's deadline changes (the spec's 10 s): the budget moves with it, in the same change;
- a consumer other than refund-api is added to the allowlist: its deadline is a new input to this decision.

## Compliance notes

- GDPR / data-protection impact: none. The attempt log carries the trigger, the month, the outcome and an error code; the actor's id is already in the audit rows.
- Data residency: no change; the outbound call carries a year and a month to a Swiss federal service.
- Audit trail: required, and strengthened: the attempt log's trigger is derived by the server.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
