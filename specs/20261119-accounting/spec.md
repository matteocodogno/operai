---
id: 20261119
slug: accounting
status: approved
rigor: production
created: 2026-11-19
approved: 2026-11-19
---

# Accounting: one module for ledger accounts, VAT codes and monthly exchange rates

## Amendments

- **2026-11-19 (post-approval, autonomous run chosen by the owner; made by the product-owner agent;
  confirmed by the owner, Matteo Codogno, on 2026-11-19):** three wording amendments, proposed by
  the architect in plan.md ("Spec amendments proposed", SA-1 to SA-3, and D27). Status stays
  `approved`; every AC id is unchanged.
  - **SA-1, one-off seed of the initial list.** The Non-goal "Bulk import of accounts or VAT codes"
    allows a one-off, operator-run seed of the WellD CH list that accounting signed off (the
    fallback for the open question on who enters the initial entries); no import feature is
    offered to users.
  - **SA-2, "published".** New domain term "published": a month's average rate counts as
    published from the 5th day of the following month (Europe/Zurich). It is used wherever the
    spec says a rate is published or fetchable: AC-2.1, AC-2.7, AC-2.10.
  - **SA-3, entry no longer found.** AC-4.5 also covers a default or foreign-currency VAT code
    designation whose entry is no longer found in Accounting, not only a deactivated one: shown as
    such, and counts as no default.

- **2026-11-19 (fix round 1, confirmed by the owner, Matteo Codogno, on 2026-11-19):** **SA-4,
  catalog cap.** Each entity holds at most 200 ledger accounts and 50 VAT codes, deactivated ones
  included. Entries are never deleted (AC-1.12), so this is a lifetime limit on additions; an
  addition beyond it is refused and nothing is added. The cap keeps Accounting's answer to its
  consumers under Refund's read limit (security review F-01). It complements AC-1.1 and AC-1.5;
  every AC id is unchanged.

- **Amendment 2026-11-19 (accounting sign-off; decided by the owner):** the company accountant
  **Approved by the owner on 2026-11-19**, with the open questions below accepted as risk on their stated fallbacks. Owner decisions at approval: if AFC offers no automatic channel, keep the existing automatic monthly-average feed as long as its values match AFC's (March 2026 does), naming AFC as the authority, and accounting corrects a month by hand if it ever differs; receipts with several VAT rates are split into several lines by the employee (the expense form says so), and accounting may reject a line that needs splitting.
  answered the open questions of specs/20261118-refund-accounting-export and of this spec, and the
  owner (Matteo Codogno) took four decisions on 2026-11-19 (see the same-dated amendment of
  20261118, which carries the Refund side). Wording by the product-owner agent. Status stays
  `approved`. **This entry changes behaviour of an implemented, unreleased module** (plan, tasks and
  code follow it). No AC id is reused: adjusted ACs say so, and new ACs take the next free number
  in their story. No AC of this spec is retired outright; clauses about the foreign-currency VAT
  code and the default VAT codes are retired inside the ACs that held them, marked inline.
  - **R1, the foreign-currency VAT code and the default VAT codes are retired (Refund).** No VAT
    code is ever pre-set; the VAT code of a Refund line is optional and entered by hand (20261118
    E2). Accounting still keeps VAT codes, but nothing in Refund designates one by default.
    Adjusted: AC-3.7, AC-4.4, AC-4.5, AC-4.6, AC-4.7, AC-5.1, AC-5.2, AC-5.3, AC-6.3, AC-6.9,
    AC-7.4, AC-7.5; the domain terms and the "What stays in Refund" paragraph; the Non-goal "Moving
    Refund's own rules into Accounting". The SA-3 wording about a "foreign-currency VAT code
    designation" no longer has an object. Approval needs only a ledger account for a WellD CH line.
  - **R2, VAT codes in use.** WellD CH holds IPM81 (8.1 %), IPM77 (7.7 %, still needed), IP00
    (0.00 %, instead of the former "no VAT" placeholder), a 2.6 % code (supermarkets: Aldi, Coop,
    Migros), a 3.8 % code (overnight stays in Switzerland: rare, but kept active) and BZM81
    (reverse charge, 8.1 %). "IMP81" was a misspelling of IPM81. The codes of the 2.6 % and 3.8 %
    rates are not yet known: IPM26 and IPM38 until confirmed (open question). New: AC-7.6.
  - **R3, accounts added.** 6701 (default of "Pranzi/cene con clienti"), 6501 "Libri e manuali"
    (default of company manuals), 5902 "Spese viaggi in aereo" (flight), 5903 "Spese viaggi taxi"
    (taxi), 7122 "Spese da riaddebitare a WellD Italia" and 2620.1 "Altri debiti verso soci - CHF
    (CH)" (the last two chosen by hand, never a default). New: AC-7.6. The account for gifts to
    clients is unknown (open question, owner accounting).
  - **R4, the rate source is the Swiss Federal Tax Administration.** The monthly average rates come
    from the AFC/ESTV (Swiss Federal Tax Administration), not from the customs office; the March
    2026 value for EUR, 0.9246, is confirmed. The spec states the authority; how to obtain it is
    for the plan, which must replace the customs-office source it had chosen (its D10 and D27).
    Adjusted: the domain term "Monthly average rate", AC-2.1. New: AC-2.12. The "Published"
    rule (5th day of the following month) is kept until AFC's publication calendar is checked
    (open question).
  - **R5, the export format changes in Refund.** The accounting export becomes a journal file
    (20261118 E6). Adjusted here: AC-5.5 (the Amount is 9.62) and AC-7.2 (the header and columns
    are those of 20261118 as amended).
  - **R6, other.** AI reading of VAT from receipts stays a non-goal (new Non-goal). The Non-goals
    "A journal export or a Bexio integration", "New expense types" and "Carrying 20261118's test or
    staging data" are adjusted.
  - **Summary.** Added: AC-2.12, AC-7.6. Adjusted: AC-2.1, AC-3.7, AC-4.4, AC-4.5, AC-4.6, AC-4.7,
    AC-5.1, AC-5.2, AC-5.3, AC-5.5, AC-6.3, AC-6.9, AC-7.1, AC-7.2, AC-7.4, AC-7.5. Retired
    (clauses only): the foreign-currency VAT code designation and the default VAT code in AC-3.7,
    AC-4.4, AC-4.5, AC-4.6, AC-4.7, AC-6.3, AC-6.9 and AC-7.4. New open questions below.

## Problem

Refund's accounting reference data (ledger accounts, VAT codes and monthly average exchange
rates, specs/20261118-refund-accounting-export) lives inside Refund. Only Refund can use it, and
only people with Refund's settings rights can see or keep it. Other modules will need the same
data (Inventory for purchases and depreciation, CRM and Projects for Bexio orders, future
supplier invoices), and each one that kept its own copy would drift from the others, as the
hand-kept register did. The accounting team also has no place of its own to keep the chart of
accounts, the VAT codes and the rates of each legal entity. Today Refund reads the data live, so a
later change to it can alter an expense line that was already approved and an export already
given to the books. 20261118 is implemented but not released, so the data can be moved before
anyone depends on where it lives.

## Domain language

Extends specs/20261118-refund-accounting-export (ledger account, VAT code, default account,
~~default VAT code~~, ~~foreign-currency VAT code~~ *(both retired 2026-11-19: no VAT code is ever
pre-set)*, classification, VAT amount, monthly average rate, CHF amount, receipt number,
accounting export), specs/20260716-refund-service (entity, expense
line, approved total) and specs/20260713-auth-roles-permissions (role, capability, entity
condition). New or refined terms:

- **Accounting** (capital A) — the suite module that keeps accounting reference data and shows
  it in its own app. Lower-case "accounting" keeps its meaning in Refund: the team and role that
  review and classify expenses.
- **Reference data** — the ledger accounts, VAT codes and monthly average exchange rates kept in
  Accounting.
- **Entity** — a legal entity of the group: WellD CH or WellD Italia, as Refund already names
  them. Each entity has an **own currency**: CHF for WellD CH, EUR for WellD Italia.
- **Ledger account** — as in 20261118, now belonging to exactly one entity and identified by its
  number within that entity. The same number in two entities is two different accounts.
- **VAT code** — as in 20261118, now belonging to exactly one entity and identified by its code
  within that entity. A code's rate never changes. In Refund a line's VAT code is optional and
  never pre-set (20261118); the codes in use for WellD CH are in AC-7.6.
- **Monthly average rate** *(amended 2026-11-19)* — the average exchange rate of a foreign currency
  to the entity's own currency for one calendar month. For WellD CH: EUR, USD and GBP to CHF, from
  the monthly average rates of the Swiss Federal Tax Administration (AFC/ESTV), not from the
  customs office. The **rate in effect** is the latest correction if there is one, otherwise the
  fetched rate. The entity's own currency has no rate.
- **Published** — a month's average rate counts as published from the 5th day
  of the following month (Europe/Zurich), because the source answers provisional values before
  that. Before that day the rate is not fetchable and is shown as missing. *(The rule was set for
  the customs-office source; it stands until AFC's publication calendar is checked, open
  question.)*
- **Active / deactivated** — whether an entry is offered for new use. A deactivated entry stays
  in the lists, with its history, and can be reactivated.
- **Option** — an active entry offered to a person who has to choose one.
- **Accounting read / Accounting manage** — the two capabilities of Accounting, each grantable
  with the entity condition. **Accounting manager**: a person who holds Accounting manage for an
  entity. **Accounting reader**: a person who holds Accounting read but not manage.
- **Consumer** — a module of the suite that reads Accounting's data. Refund is the only consumer
  in this spec.
- **Copy** *(amended 2026-11-19)* — the values Refund records on a line when it is classified or
  approved: ledger account number and name, the VAT code and VAT rate when the line has a VAT code
  and, for a line in a currency other than CHF, the exchange rate used with its month. A copy never
  changes when Accounting changes. The CHF amount and the VAT amount of a line are computed from
  its copy, as in 20261118.
- **Rate pending** — the state of an approved WellD CH line in a currency other than CHF whose
  expense month had no rate in effect at approval, so no exchange rate has been copied yet.
- **Unreachable** — Accounting does not answer in time, answers with an error, or answers with
  something Refund cannot read.

## Relationship to specs/20261118-refund-accounting-export

Refund consumes Accounting. 20261118 stays the spec of Refund's accounting behaviour and is
amended on 2026-11-19 (entry in its Amendments, wording only, status and AC ids unchanged) to
refer to this spec. *(It is amended again on 2026-11-19, accounting sign-off, with changes of
behaviour: see both Amendments sections.)*

**What moves here.**
- **US-1 and AC-1.1 to AC-1.11 of 20261118** (add, deactivate and reactivate ledger accounts and
  VAT codes, unique, rate never changes, audit) move to US-1 here, with the entity dimension:
  its AC-1.1 is AC-1.1 here, AC-1.2 is AC-1.3, AC-1.3 is AC-1.4, AC-1.4 is AC-1.5 and AC-1.6,
  AC-1.5 is AC-1.7, AC-1.6 is AC-1.8, AC-1.7 (who may manage) is AC-3.4, AC-1.8 is AC-1.13, and
  AC-1.9 to AC-1.11 keep their numbers. AC-1.2 and AC-1.12 here are new (field limits; no edit or
  delete). The consumer side of AC-1.3, AC-1.6, AC-1.9 and AC-1.10 (what a line already
  classified with a deactivated or reactivated entry keeps) stays in Refund and is restated in
  AC-5.3.
- **US-5 and AC-5.1 to AC-5.7 of 20261118** (monthly average rates: fetched, corrected, missing
  shown, fetch failure shown) move to US-2 here: its AC-5.1 is AC-2.1, AC-5.2 is AC-2.3, AC-5.3
  is AC-2.4, AC-5.4 is AC-2.6, AC-5.5 is AC-2.7, AC-5.6 is AC-2.8, and AC-5.7 is AC-3.4 (with
  AC-2.9). AC-2.2, AC-2.5, AC-2.9, AC-2.10 and AC-2.11 here are new. "Admin" becomes
  "accounting manager" and the Settings tab becomes the Accounting app.
- **The option sources of AC-2.4 and AC-2.6 of 20261118** (which accounts and VAT codes an admin
  may choose as defaults and as the foreign-currency VAT code) are now Accounting's active
  WellD CH entries (AC-4.4 here); likewise the options of AC-3.3 (AC-4.1 here). *(Since 2026-11-19
  only the default accounts are chosen: AC-2.5 and AC-2.6 of 20261118 are retired.)*
- **Refund's Settings tabs "Accounts and VAT" and "Exchange rates"** disappear from Refund
  (AC-4.6) and live only in the Accounting app.
- **Capabilities.** The accounts, VAT codes and rates are no longer behind Refund's
  `settings:read` / `settings:manage`; they are behind Accounting read / manage (US-3).

**What stays in Refund, unchanged for users.** Per-type default account (AC-2.1 to AC-2.3,
AC-2.8 of 20261118; the default VAT code and the foreign-currency VAT code designation are retired
since 2026-11-19), line classification and review (US-3), receipt numbers (US-4), the batch
accounting export (US-6) and the treatment of lines approved before the release (US-7). What
changes in them is only what US-4 to US-7 here say: where options come from, copies frozen at
approval, and refusals when Accounting is unreachable or lacks data.

**What is adjusted in them.**
- AC-3.5 of 20261118 (lines keep the account and VAT code they showed at approval) now also
  covers the exchange rate and is stated through copies (AC-5.1 to AC-5.3 here).
- AC-6.3 and AC-6.8 of 20261118 (rate used; identical exports): the rate is the copied rate, and
  the export stays identical whatever happens in Accounting (AC-5.4, AC-5.5 here).
- AC-6.5 of 20261118 (missing rate blocks the export) stands; AC-6.6 and AC-6.7 here add the case
  where Accounting is unreachable.
- G5 of its plan (exchange rates readable and correctable only by Refund admins) is resolved by
  US-3: the accounting role holds Accounting read and manage.

**Still open in 20261118 and not repeated here:** its open questions about the initial list of
accounts and default accounts (partly answered 2026-11-19, residual question in 20261118; the
entries are entered in Accounting, AC-7.6). Its question on the official rate source is answered
(R4); its question on the foreign-currency VAT code is closed (retired). The questions that
concern data kept here are repeated below.

## User stories

### US-1: Accounting manager keeps the ledger accounts and VAT codes of each entity

As an accounting manager, I want to keep the chart of accounts and the VAT codes of each entity
in one place, so that every module books to an account and a VAT code that exist in that
entity's books.

**Acceptance criteria:**
- AC-1.1: Given the Accounting app and an entity for which the person holds Accounting manage,
  when they add a ledger account with a number and a name, then it appears, active, in that
  entity's list of ledger accounts and is offered to consumers as an option for that entity.
- AC-1.2: Given an account to add, when the number is empty, is not digits separated by single
  dots (for example `5905`, `2620.1`) or is longer than 20 characters, or when the name is empty
  or only blanks or longer than 120 characters, then nothing is saved and the person is told which
  value is wrong. Leading and trailing blanks are removed before the check.
- AC-1.3: Given an existing ledger account of an entity, active or deactivated, when an accounting
  manager tries to add another account with the same number in the same entity, then the addition
  is refused with a message naming the duplicate number; the same number in another entity is
  accepted. Given two accounting managers adding the same number to the same entity at the same
  moment, then exactly one account is created and the other person gets the duplicate message.
- AC-1.4: Given a ledger account, when an accounting manager deactivates it, then it is no longer
  offered as an option to any consumer, and it stays in the list marked deactivated.
- AC-1.5: Given the Accounting app and an entity, when an accounting manager adds a VAT code with
  a code, a label and a rate between 0 % and 100 % with at most two decimals (for example 8.1),
  then it appears, active, in that entity's list of VAT codes and is offered to consumers as an
  option for that entity. The code is made of capital letters, digits, `_` and `-`, 1 to 16
  characters (lower case is converted to capital letters); the label is 1 to 80 characters. A
  value outside these limits is refused, nothing is saved, and the person is told which value.
- AC-1.6: Given an existing VAT code of an entity, active or deactivated, when an accounting
  manager tries to add a code equal to it (ignoring case) in the same entity, then the addition
  is refused with a message naming the duplicate code and pointing to reactivation (AC-1.10);
  the same code in another entity is accepted. The concurrent case of AC-1.3 applies here too.
- AC-1.7: Given an existing VAT code, when an accounting manager looks for a way to change its
  rate, then none is offered, and a request to change it is refused; the manager can only
  deactivate the code and add a new one.
- AC-1.8: Given a deactivated VAT code, then it is not offered as an option to any consumer.
- AC-1.9: Given a deactivated ledger account, when an accounting manager reactivates it, then it
  is listed active with the same number and name and is offered again as an option.
- AC-1.10: Given a deactivated VAT code, when an accounting manager reactivates it, then it is
  listed active with the same code, label and rate and is offered again as an option.
- AC-1.11: Given a ledger account or VAT code already in the state asked for (reactivating an
  active one, deactivating a deactivated one), when an accounting manager asks, then the action is
  refused with a message saying it is already in that state, and nothing is recorded in the
  audit trail. Given two managers deactivating the same entry at the same moment, then one
  deactivation is recorded and the other gets this message.
- AC-1.12: Given any ledger account or VAT code, then neither the app nor a direct request offers
  a way to change its number, name, code, label, rate or entity, or to delete it; only
  deactivation and reactivation change it after creation.
- AC-1.13: Given any addition, deactivation or reactivation, when it is saved, then the audit
  trail records who did it, when, the entity, and the before and after state; and an audit entry
  cannot be edited or deleted through the app or its requests.

### US-2: Accounting manager keeps the monthly average exchange rates of each entity

As an accounting manager, I want the official monthly average rates to be fetched for me and to
be able to correct them, so that every module converts at the rate the books use without anyone
typing it.

**Acceptance criteria:**
- AC-2.1 *(adjusted 2026-11-19: the source is the Swiss Federal Tax Administration)*: Given WellD
  CH and a calendar month whose official average rate has been published (from
  the 5th day of the following month, Europe/Zurich), when Accounting fetches the rates, then the
  rate of each of EUR, USD and GBP to CHF for that month, as published by the Swiss Federal Tax
  Administration (AFC/ESTV), is recorded for WellD CH with its source and the moment it was
  fetched.
- AC-2.2: Given a month and currency whose rate has already been fetched, when the rates are
  fetched again, then the recorded rate is unchanged.
- AC-2.3: Given an Accounting reader or manager of an entity, when they open its exchange rates,
  then each month, newest first, from January 2026 to the last completed month shows, for each
  foreign currency, the rate in effect and whether it was fetched or corrected by hand; a month
  earlier than January 2026 also appears once a rate for it has been recorded or asked for
  (AC-2.10).
- AC-2.4: Given a month's rate, when an accounting manager enters a correction, then the
  correction becomes the rate in effect, the previous value stays in the history of that rate, and
  the audit trail records who corrected it, when, the entity, and from which value to which.
- AC-2.5: Given a correction to enter, when the value is not greater than 0, is 1000 or more, has
  more than six decimals, is for a month that has not ended, or is for the entity's own currency,
  then it is refused with a message saying why, and nothing is recorded or audited.
- AC-2.6: Given a month whose rate an accounting manager corrected, when the rates are fetched
  again, then the correction stays in effect.
- AC-2.7: Given a month and currency with no published rate (a month before the 5th day of the
  following month counts as not published), when someone opens the exchange rates, then that month
  and currency are shown as missing; no value is estimated or taken from another month.
- AC-2.8: Given the official source unreachable, when Accounting tries to fetch the rates, then
  the rates already recorded are unchanged, and whoever can open the exchange rates can see that
  the last fetch failed and when.
- AC-2.9: Given an accounting manager, when they ask for a fetch ("Fetch now"), then the fetch of
  AC-2.1 is attempted for the months that have no recorded rate; a person without Accounting
  manage cannot ask for it (AC-3.4).
- AC-2.10: Given a consumer asking for the rate in effect of a month and currency with no recorded
  rate, when the official rate has been published (from the 5th day of the following month,
  Europe/Zurich), then Accounting fetches and records it as in AC-2.1 and answers with it; when it
  cannot, or the month is not yet published, the answer says the rate is missing. The consumer's
  own user needs no Accounting capability for this.
- AC-2.11: Given rates are per entity, then a fetch, a correction or a missing rate of WellD CH
  changes nothing of another entity. WellD Italia has no official source in this spec: its
  exchange rates screen says so, and no fetch is attempted for it.
- AC-2.12: Given the monthly average rate of the Swiss Federal Tax Administration (AFC/ESTV) for
  EUR for March 2026, when Accounting fetches it, then the rate recorded for WellD CH is 0.9246,
  the value the books use and accounting confirmed; a source that gives another value for that
  month is not the reference.

### US-3: Accounting read and manage are separate capabilities, granted by entity

As an administrator, I want the right to see and the right to change accounting reference data
to be separate, per entity, and granted in the admin GUI like every other capability, so that the
accounting role can keep the data and everyone else sees only what they need.

**Acceptance criteria:**
- AC-3.1: Given the permission catalog, then it has Accounting read and Accounting manage, each
  supporting the entity condition, granted through roles in the existing admin GUI like every
  other capability.
- AC-3.2: Given a person who holds Accounting manage for an entity, then they can also read
  everything Accounting read gives for that entity.
- AC-3.3: Given the release of Accounting, then the accounting role and the admin role hold
  Accounting read and Accounting manage (the accounting role's with the entity condition, as its
  Refund grants have it), and no other role holds either until an administrator grants it.
- AC-3.4: Given a person without Accounting manage for an entity (an accounting reader, or anyone
  else), when they try to add, deactivate or reactivate an account or VAT code, to correct a
  rate, or to ask for a fetch, then the action is denied, nothing changes and nothing is
  audited.
- AC-3.5: Given a grant limited to one entity, then the person's lists show only that entity's
  entries, and a direct attempt to read or change an entry of another entity is refused as if the
  entry did not exist.
- AC-3.6: Given a person with neither capability for any entity, when they open the Accounting
  app or ask for its data directly, then access is denied and no reference data is exposed.
- AC-3.7 *(adjusted 2026-11-19: the foreign-currency VAT code designation is retired)*: Given a
  person who holds Refund's `settings:read` or `settings:manage` and no Accounting
  capability, when they try to read or change accounts, VAT codes or rates, then it is denied;
  and a person who holds Accounting manage and no Refund settings capability cannot change
  Refund's per-type default accounts.
- AC-3.8: Given a suite service with the right to read Accounting (Refund in this spec), when it
  asks for the accounts, VAT codes (each with its active state) or the rates in effect of an
  entity, then it gets the same data an Accounting reader of that entity gets. A service without
  that right, and a request that is not authenticated, are refused. That right never allows a
  service to change anything.
- AC-3.9: Given a Refund reviewer or a Refund admin who holds no Accounting capability, then they
  cannot open the Accounting app or ask for its data (AC-3.6), and they see the active options
  they need to choose from only through Refund (AC-4.1, AC-4.4).

### US-4: Refund offers and shows what Accounting holds

As an accounting user and as a Refund admin, I want Refund to offer only Accounting's active
WellD CH accounts and VAT codes, so that every classification and every default points to an
entry that exists in the books, without anyone retyping it in Refund.

**Acceptance criteria:**
- AC-4.1: Given a person who reviews Refund requests with a scope covering WellD CH, when they
  classify a WellD CH line, then they are offered the active WellD CH ledger accounts (number and
  name) and VAT codes (code, label, rate) of Accounting, whether or not they hold an Accounting
  capability, and nothing else of Accounting: no deactivated entry, no history, no who-added, no
  exchange-rate list.
- AC-4.2: Given a person who reviews Refund requests with a scope that does not cover WellD CH,
  then they are offered no WellD CH account or VAT code.
- AC-4.3: Given a line being classified by hand, when the person picks an entry that is
  deactivated, unknown, or of an entity other than WellD CH (also by a direct request), then the
  classification is refused and the line is unchanged.
- AC-4.4 *(adjusted 2026-11-19: only the default account; the default VAT code and the
  foreign-currency VAT code are retired)*: Given Refund's Settings and a Refund admin choosing the
  default account of an expense type, when the choice opens, then only active WellD CH accounts of
  Accounting are offered, whether or not the admin holds an Accounting capability; choosing a
  deactivated, unknown or non-WellD CH account (also by a direct request) is refused and nothing
  changes.
- AC-4.5 *(adjusted 2026-11-19: the fourteen types; the default VAT code and the designation are
  retired)*: Given the fourteen expense types, when Refund's Settings is opened, then each shows
  its default account (number and name), or that it has none. A default whose account has since
  been deactivated in Accounting, or is no longer found there, is shown as such (deactivated, or
  not found) with a note that a new choice is needed, and counts as no default for new
  classifications (AC-6.3).
- AC-4.6 *(adjusted 2026-11-19: no foreign-currency VAT code)*: Given Refund's Settings, then it
  has no "Accounts and VAT" and no "Exchange rates" view; it keeps the general settings and the
  per-type default accounts, and shows a link to the Accounting app to those who may open it, and
  to the others the name of the app and that accounting managers keep the data.
- AC-4.7 *(adjusted 2026-11-19: the account only)*: Given a change of a default account, when it is
  saved, then the history in Refund keeps who and when and shows the account number and name as
  they were at the time of the change, so the history reads the same whatever happens in
  Accounting.
- AC-4.8: Given a change saved in Accounting at time T (an entry added, deactivated or
  reactivated, a rate corrected or fetched), then Refund offers and uses it for anything it starts
  later than T + 60 seconds.
- AC-4.9: Given WellD Italia, then Refund offers no Accounting entry for a WellD Italia line, and
  its lines are reviewed and approved as before (AC-3.9 of 20261118), whatever Accounting holds
  for WellD Italia.

### US-5: Refund keeps its own copy of what it booked

As an accounting user, I want every classified and approved line to keep the account, VAT code
and exchange rate it was booked with, so that a later change in Accounting, or Accounting being
down, never alters an approved line or an export.

**Acceptance criteria:**
- AC-5.1 *(adjusted 2026-11-19: the VAT code is copied only when the line has one)*: Given a
  request with WellD CH lines that are not rejected, when accounting approves it,
  then each such line holds a copy of its ledger account number and name and, when it has a VAT
  code, that code and its VAT rate, and for a line in a currency other than CHF whose expense
  month has a rate in effect, the rate and its month. For a line classified by hand the copy is
  the one recorded when it was classified (AC-5.2); for a line on its default account it is taken
  from Accounting during this approval. A line without a VAT code holds none, and is not refused
  for that. The audit trail records the copied values.
- AC-5.2 *(adjusted 2026-11-19: the VAT code may be set, changed or cleared)*: Given a WellD CH
  line under review, or approved in a batch that is not paid, when accounting classifies it by
  hand, then at that moment the copy of the chosen account's number and name, or of the chosen VAT
  code and rate (or the absence of one, when it is cleared), is recorded on the line, and the
  audit trail records who changed what from which value to which.
- AC-5.3 *(adjusted 2026-11-19: the VAT code, if any)*: Given an approved line, when afterwards in
  Accounting its account or VAT code is deactivated or reactivated, or a rate is fetched or
  corrected, then the line's account number and name, VAT code and rate (if it has one), exchange
  rate, CHF amount and VAT amount (if it has a VAT code), as Refund shows them and as the export
  carries them, are unchanged.
- AC-5.4: Given a batch whose WellD CH lines all hold their copies, when accounting exports it,
  then the file is built from the copies, is produced while Accounting is unreachable, and two
  exports of the same batch are identical whatever changed in Accounting between them.
- AC-5.5 *(adjusted 2026-11-19: the CHF amount is the row's Amount)*: Given a line in EUR dated
  2026-03-02 with an approved total of 10.40, approved with a copied EUR rate of 0.9246 for March
  2026, when Accounting later corrects the March EUR rate to 0.9300 and the batch is exported,
  then the Amount of its row in the export is 9.62.
- AC-5.6: Given a WellD CH line in a currency other than CHF, when it is approved and its expense
  month has no rate in effect, then the approval is not refused for that reason, and the line is
  marked "rate pending" with no CHF amount and no VAT amount shown. At the first accounting export
  of its batch that succeeds, the rate in effect at that moment is copied onto the line and the
  audit trail records who exported and when; the line is then as in AC-5.3. A refused export
  copies nothing to any line.
- AC-5.7: Given an approved line in a batch that is not paid, when accounting changes its account
  or VAT code, then only that part of the copy changes; the copied exchange rate, the approved
  total and the decision stay unchanged; and the change is refused once the batch is paid, as in
  AC-3.7 of 20261118.

### US-6: Refund refuses rather than book incomplete data

As an accounting user, I want Refund to stop with a clear message when Accounting cannot be
reached or lacks what a line needs, so that nothing is approved or exported half-classified.

**Acceptance criteria:**
- AC-6.1: Given Accounting unreachable, when accounting approves a request with at least one
  WellD CH line that is not rejected, then the approval is refused with a message saying that
  Accounting's reference data cannot be read now and to try again later.
- AC-6.2: Given any refused approval or classification (AC-6.1, AC-6.3, AC-6.5), then the request
  stays as it was and can be approved later: no receipt number is consumed, no copy is recorded,
  no decision is recorded, and no audit entry of an approval is written.
- AC-6.3 *(adjusted 2026-11-19: only the account; the default VAT code, the foreign-currency VAT
  code and AC-2.7 of 20261118 are retired)*: Given Accounting reachable and a WellD CH line with
  no default account (none set, or its account deactivated or not of WellD CH) that accounting has
  not classified, when accounting tries to approve, then the approval is refused and names the
  lines left without an account. A line without a VAT code does not make it refused. If
  Accounting is also unreachable, AC-6.1 applies.
- AC-6.4: Given a request with no WellD CH line that is not rejected (WellD Italia lines only, or
  every WellD CH line rejected), when accounting approves it, then the approval works as before
  and does not depend on Accounting, including while it is unreachable.
- AC-6.5: Given Accounting unreachable, when accounting opens a WellD CH line under review or
  approved in an unpaid batch, then the line shows what it holds, no options are offered, and a
  note says that Accounting cannot be read; an attempt to classify or reclassify it is refused
  with the message of AC-6.1 and the line is unchanged.
- AC-6.6: Given a batch with a WellD CH line that needs Accounting at export (a line with rate
  pending) and Accounting unreachable, when accounting asks for the export, then it is refused
  with a message saying that Accounting cannot be read, not as a missing rate; compiling, paying
  and discarding the batch are not affected, and the export log gets no entry.
- AC-6.7: Given Accounting reachable and a line in a foreign currency with rate pending whose
  expense month still has no rate in effect, when accounting asks for the export, then it is
  refused and lists each missing currency and month (AC-6.5 of 20261118); compiling, paying and
  discarding the batch are not affected.
- AC-6.8: Given Accounting that does not answer within 10 seconds, or answers with an error or
  with data Refund cannot read, then it counts as unreachable in AC-6.1 to AC-6.6, AC-6.9 and
  AC-7.4.
- AC-6.9 *(adjusted 2026-11-19: no designation)*: Given Accounting unreachable, when a Refund
  admin opens Refund's Settings, then the page opens, shows each default account as recorded
  (number and name) with a note that Accounting cannot be read, and offers no new choice.
- AC-6.10: Given any refusal in this story, then the message names the cause (Accounting cannot be
  read, or which lines and values are missing) and what to do, exists in Italian and English, and
  contains no address, identifier or internal error text.

### US-7: Nothing else changes for Refund users, and the release

As an accounting user, I want Refund to behave as 20261118 approved except where Accounting makes
a difference, so that the move costs the team nothing to relearn.

**Acceptance criteria:**
- AC-7.1 *(adjusted 2026-11-19: as amended)*: Given the stories of 20261118 that stay in Refund
  (US-2, US-3, US-4, US-6, US-7), then every one of its ACs holds for users as approved there (as
  amended on 2026-11-19), except the places this spec changes:
  where options come from (AC-4.1 to AC-4.4), copies and "rate pending" (US-5), refusals (US-6),
  who may see and correct rates (US-3), and AC-7.3 and AC-7.4 here.
- AC-7.2 *(adjusted 2026-11-19: the columns are those of the amended 20261118)*: Given a batch
  with the same lines, the same copies and the same rates, then the export
  file has the same header, the same columns in the same order (AC-6.2 of 20261118, as amended
  2026-11-19) and the same values as 20261118 specifies, and the receipt numbering is unchanged
  (AC-4.1 to AC-4.13 of 20261118); an employee still sees no account, VAT code or VAT amount on
  their own request (AC-3.10 of 20261118).
- AC-7.3: Given an export blocked by a missing rate, when it is shown, then a person who holds
  Accounting read is given a link to that month in the Accounting app, and anyone else is told to
  ask an accounting manager.
- AC-7.4 *(adjusted 2026-11-19: the account only, no VAT code)*: Given WellD CH lines approved
  before the release, when the release of Refund's
  accounting features runs, then AC-7.1 and AC-7.2 of 20261118 apply with Accounting as the
  source: each line gets the copy of the current default account of its expense type (no VAT code),
  and a line in another currency also the exchange rate if one is in effect, otherwise it is "rate
  pending" (AC-5.6). If Accounting is unreachable when the release runs, nothing is numbered or
  classified and the run reports why; running it again later is safe. WellD Italia lines
  approved before the release are left as AC-7.3 of 20261118 says.
- AC-7.5 *(adjusted 2026-11-19: only the ledger accounts are needed to approve)*: Given the
  release of Refund's accounting features, then Accounting is already live and
  holds WellD CH's ledger accounts and VAT codes entered by accounting (AC-7.6); if it holds no
  account, or none of the default accounts, every WellD CH approval is refused as in AC-6.3 and the
  release report lists the lines left unclassified (AC-7.2 of 20261118). An empty VAT code list
  refuses nothing.
- AC-7.6: Given the release of Refund's accounting features, then Accounting holds, active, for
  WellD CH: the ledger accounts 5902 "Spese viaggi in aereo", 5903 "Spese viaggi taxi", 6501
  "Libri e manuali", 6701 (named as in WellD CH's chart of accounts), 7122 "Spese da riaddebitare a
  WellD Italia" and 2620.1 "Altri debiti verso soci - CHF (CH)"; and the VAT codes IPM81 (8.1 %),
  IPM77 (7.7 %), IP00 (0.00 %), BZM81 (8.1 %, reverse charge), a code at 2.6 % named IPM26 and a
  code at 3.8 % named IPM38 until accounting confirms their names. No code named IMP81 or NOVAT
  exists. The rest of the chart of accounts is the list accounting signed off (SA-1).

### US-8: The Accounting app is a tool of the suite

As a person who may see accounting reference data, I want an Accounting tool in the suite like the
other tools, so that I find it where I find the others, in my language.

**Acceptance criteria:**
- AC-8.1: Given a person who holds Accounting read or manage for at least one entity, then
  Accounting appears in the tool menu and opens at `/accounting`; a person who holds neither does
  not see it in the menu and is denied if they open the address (AC-3.6).
- AC-8.2: Given the app, when a person who holds the capability for several entities uses it, then
  every list names its entity and they can switch between their entities; a person limited to one
  entity sees that entity.
- AC-8.3: Given an entity with no entries (WellD Italia at the release), when its lists are
  opened, then they show that nothing has been entered yet, not an error.
- AC-8.4: Given the app, then all its words exist in Italian and English and follow the person's
  language, and it has no WCAG 2.1 AA violation found by the suite's automated check, every
  control has a visible label, refused values are announced with focus moved to the first one, and
  everything is usable with the keyboard alone.

## Non-goals

- **Loading WellD Italia data.** The model carries WellD Italia from day one, but no Italian
  chart of accounts, VAT codes or rates are loaded now, and no official source for Italian rates
  is chosen; both come with a later spec.
- **A journal export or a Bexio integration** *(adjusted 2026-11-19)*. Accounting keeps reference
  data only; the accounting export is produced by Refund (20261118, a journal file since the
  amendment of 2026-11-19), not by Accounting.
- **Inventory, CRM, Projects or supplier invoices consuming Accounting.** Later specs; only
  Refund consumes Accounting here (the service read of AC-3.8 is built so they can).
- **Editing or deleting accounts and VAT codes.** Deactivation and reactivation are the only
  changes after creation (AC-1.12); a wrong rate or a wrong name means a new entry.
- **New expense types** *(adjusted 2026-11-19)*. The fourteen types are those of 20261118 (flight
  and taxi added by its amendment of 2026-11-19); no other type is added here.
- **A screen for browsing the audit trail or an entry's history.** 20261118 had none for accounts
  and VAT codes either (it recorded the audit, AC-1.8); changes are recorded (AC-1.13, AC-2.4),
  not displayed beyond the active state and the origin of each rate.
- **Bulk import of accounts or VAT codes**. The initial WellD CH list is
  entered in the app, or loaded once, on the release day, by an operator-run seed of the list that
  accounting signed off; no import feature is offered to users.
- **Moving Refund's own rules into Accounting** *(adjusted 2026-11-19)*. Per-type default
  accounts, line classification, receipt numbering and the batch export stay in Refund. The
  foreign-currency VAT code designation and the default VAT codes no longer exist.
- **Carrying 20261118's test or staging data into Accounting** *(adjusted 2026-11-19)*. 20261118 is
  not released, so production has none; environments with such data are re-entered, including
  data with the former code names (IMP81, NOVAT).
- **Approving or exporting from last-known data when Accounting is unreachable.** Refund refuses
  (US-6) rather than use a stale copy of Accounting's lists; only copies already recorded on
  lines are used.
- **Refreshing or re-rating a frozen line after a rate correction.** An approved line keeps the
  rate it was copied with (AC-5.3); see the open question on a wrong rate.
- **Telling a manager, or notifying anyone, which modules use an entry** when it is deactivated
  or when a fetch fails. Failures and deactivated defaults are visible (AC-2.8, AC-4.5), not
  notified.
- **Other kinds of rate.** Daily, closing or cross rates between two foreign currencies; only the
  monthly average of a foreign currency to the entity's own currency.
- **Changing what an employee is reimbursed.** Amounts paid stay in the line's own currency, as
  in 20261118.
- **Reading VAT from receipts and VAT logic.** AI receipt scanning (backlog item 8,
  docs/refund-accounting-backlog.md), which would read the VAT code from the document and will have
  to handle receipts with several VAT rates, is a future feature; Accounting only keeps the list of
  VAT codes and never decides which applies to an expense, nor flags a reverse-charge case.
- **A type or flag on a VAT code** (reverse charge, reduced rate, exempt). A code has a code, a
  label and a rate; its meaning is in its label.

## Constraints

*Decisions taken by the owner (Matteo Codogno) in an interview on 2026-11-19, captured verbatim
for the plan.*

1. Accounting is its own service plus its own app in the suite (route /accounting, in the tool
   menu), like the other tools.
2. v1 scope: reference data only — chart of accounts (ledger accounts), VAT codes, monthly
   average exchange rates. Refund consumes them. Refund keeps: type→account/VAT defaults, the
   foreign-currency VAT code designation, line classification, receipt numbering, batch export. A
   journal export / Bexio integration is a non-goal. *(2026-11-19, accounting sign-off: the VAT
   defaults and the foreign-currency VAT code designation are retired; see Amendments.)*
3. Modelled per legal entity from day one (WellD CH, WellD Italia: an account and a VAT code
   belong to one entity; exchange rates are per entity's own currency — CH: foreign→CHF from the
   official Swiss monthly averages, as today); only WellD CH data is loaded now; Italy can be
   added without a model change. *(2026-11-19, accounting sign-off: the official source is the
   Swiss Federal Tax Administration, AFC/ESTV.)*
4. Managed by the accounting role through new Accounting capabilities (read / manage), with the
   entity condition; an admin grants them in the existing admin GUI. (Today Refund uses
   settings:read/manage — that moves.)
5. The Accounts/VAT and Exchange-rates views leave Refund's Settings and live only in the
   Accounting app; Refund's Settings keeps the per-type defaults and the foreign-currency VAT code
   designation (choosing among Accounting's active WellD CH entries) and links to the Accounting
   app. *(2026-11-19, accounting sign-off: the per-type default accounts only.)*

*Carried from specs/20261118-refund-accounting-export, which still apply:* monthly average rates
come from an official source with manual correction possible; a missing rate blocks the export,
and the batch can still be compiled and paid; the suite's Italian/English UI copy requirement.

*Decision taken by the owner (Matteo Codogno) on 2026-11-19 after the accountant's answers,
captured verbatim for the plan:* the reference source of the monthly average rates is the Swiss
Federal Tax Administration (AFC/ESTV), not the customs office. The VAT code on a Refund line is
optional with no default (20261118).

## Open questions

*Approved by the owner on 2026-11-19. Questions 1–3 were answered by the owner at approval (recommended option each: approve with the rate pending; read access as proposed; no deactivation warning in v1). The remaining questions are accepted as risk: the plan proceeds on the fallback stated in each, and accounting answers them before release.*

- [x] A missing rate at approval. The owner's rule is that Refund refuses the approval when
  Accounting lacks data, but the official average of the current month is published only after it
  ends, and 20261118 decided that a missing rate blocks the export only, so that the batch can be
  compiled and paid. Reading both, this spec does not refuse the approval for a missing rate: the
  line is "rate pending" and the rate is copied at the first successful export (AC-5.6). The
  alternative is to refuse the approval, which would hold back reimbursements of foreign-currency
  expenses of the current month until the rate exists. Confirm the reading. — owner: Matteo
  Codogno — **answered 2026-11-19: approve, the rate stays pending and is frozen at the first successful export (AC-5.6 as written)**
- [x] Read-only access. This spec lets Refund reviewers and Refund admins choose among Accounting's
  active WellD CH entries through Refund, with no Accounting capability (AC-4.1, AC-4.4, AC-3.9),
  and reserves Accounting read to people who need to open the Accounting app (the accounting role
  and admins at release, AC-3.3). Confirm, or name who else should hold Accounting read at release
  (for example Refund admins, or finance staff). — owner: Matteo Codogno — **answered 2026-11-19: as proposed**
- [x] Deactivating an entry that Refund uses as a default or as the foreign-currency VAT code stops
  approvals of the lines it serves until a Refund admin chooses a new one (AC-4.5, AC-6.3).
  Should Accounting warn the manager before deactivating such an entry? Fallback: no warning
  (Accounting does not know its consumers' use); Refund's Settings shows the problem. — owner:
  Matteo Codogno — **answered 2026-11-19: no warning in v1**
- [ ] A wrong rate found after approval. A line keeps its copied rate (AC-5.3); a correction in
  Accounting changes only lines approved afterwards. Is there a need to re-rate approved lines of
  an unpaid batch? Fallback: no; the rate is corrected before approval, or the line is handled in
  the books. — owner: accounting
- [ ] Limits proposed here and carried from the implementation of 20261118: account number up to
  20 characters (widened from the CH shape to leave room for other charts), VAT rate with two
  decimals (AC-1.2, AC-1.5), a correction of 0 < rate < 1000 with up to six decimals (AC-2.5),
  freshness of 60 seconds (AC-4.8) and an answer within 10 seconds (AC-6.8). Confirm or give the
  right values. — owner: accounting
- [ ] Who enters WellD CH's initial accounts and VAT codes in Accounting before the Refund release
  (AC-7.5), from the list answered in 20261118's open question 4 (partly answered 2026-11-19, now
  in AC-7.6)? — owner: accounting
- [ ] WellD Italia, for a later spec: the official source of its rates to EUR (CHF, USD, GBP), its
  chart of accounts and VAT codes, and who holds Accounting manage for it. Not needed to approve
  this spec. — owner: accounting
- [ ] The codes and labels of the VAT codes at 2.6 % (supermarkets: Aldi, Coop, Migros) and 3.8 %
  (overnight stays in Switzerland), and the labels of all six codes in use (AC-7.6). Fallback: the
  names IPM26 and IPM38, labels written by the operator from the rates. — owner: accounting
- [ ] Publication of the AFC monthly averages: from which day of the following month are they
  final (the "published" rule of the 5th day was set for the customs-office source), and in what
  form can they be obtained? If there is no way to obtain them automatically, is the entry by hand
  of a month's rate by an accounting manager acceptable (today only a correction of a recorded rate
  is offered, AC-2.4)? Fallback: the 5th-day rule stays, and a missing rate blocks the export
  (AC-6.7 of 20261118). — owner: accounting (publication calendar), Matteo Codogno (hand entry)
- [ ] The account for gifts to clients ("Rappresentanza – Regali"): once known, it is entered in
  Accounting (AC-7.6) and the owner decides whether it becomes the type's default; until then the
  type has none (20261118, AC-8.4). — owner: accounting
