---
id: 20261118
slug: refund-accounting-export
status: approved
rigor: production
created: 2026-11-18
approved: 2026-11-18
---

# Refund accounting: ledger accounts, VAT, receipt numbers and the batch export

## Problem

Refund now carries an expense from the employee's request to a paid monthly batch, but the
accounting team still re-keys every approved expense into a hand-kept register
(`Recap_RS_2026.numbers`: 253 rows in 2026) to give it a ledger account, a VAT code, the VAT
amount, a receipt number and, for euro receipts, a CHF equivalent at the monthly average rate.
That second register is where the errors live: VAT codes spelled two ways, VAT sometimes empty
and sometimes zero, receipt numbers missing, duplicated or carrying the wrong year, totals
sometimes computed and sometimes typed. The batch Refund produces today is a PDF for payroll;
nothing in it can be imported into the books. Accounting needs every approved expense to leave
Refund already classified, numbered and converted, so the register can be retired for WellD CH.

## Domain language

Extends specs/20260716-refund-service (request, expense line, expense type, entity, currency,
approved total, accounting, decision), specs/20260719-refund-monthly-processing (batch,
compiled, paid, discarded) and specs/20260720-mileage-rate (effective-dated, append-only
settings). New terms:

- **ledger account** — an account of WellD CH's chart of accounts that an expense is booked
  to, identified by its number (e.g. `5905`) and carrying a name (e.g. "Spese rimborsi
  chilometrici (viaggi)"). Only the accounts admitted for refunds are listed in Refund.
- **default account** — the ledger account an expense type is booked to unless accounting
  says otherwise, configured per expense type for WellD CH.
- **VAT code** — a code from a managed list (e.g. `IMP81`, `IMP77`, and a "no VAT" code) that
  carries one fixed VAT rate (8.1 %, 7.7 %, 0 %). A code's rate never changes; a new rate is a
  new code.
- **default VAT code** — the VAT code an expense type gets unless accounting says otherwise,
  configured per expense type for WellD CH.
- **classification** — a line's ledger account and VAT code together.
- **VAT amount** — the VAT contained in a line's CHF amount: `amount − amount / (1 + rate)`,
  rounded to the cent.
- **monthly average rate** — the official average exchange rate of a foreign currency (EUR,
  USD, GBP) to CHF for one calendar month, taken from an official source and correctable by an
  admin.
- **CHF amount** — a line's approved total in CHF: the approved total itself for a CHF line,
  or the approved total × the monthly average rate of the month of the line's expense date for
  a line in another currency, rounded to the cent.
- **receipt number** — the human-readable number of an approved expense line, in the form
  `<initials><YY>/<NNN>` (e.g. `MC26/014`): the employee's initials, the last two digits of the
  year of the expense date, and a three-digit sequence that counts per employee and per year.
- **accounting export** — a file produced from a batch with one row per approved WellD CH
  expense line, carrying its receipt number, classification, CHF amount and VAT amount.

## User stories

### US-1: Admin manages the ledger accounts and VAT codes Refund may use

As a refund admin, I want to keep the list of ledger accounts and VAT codes Refund may use, so
that every expense is booked to an account and a VAT code that exist in the books.

**Acceptance criteria:**
- AC-1.1: Given the Settings tab, when an admin adds a ledger account with a number and a
  name, then it appears in the list of accounts and can be chosen as a default account or as a
  line's account.
- AC-1.2: Given an existing ledger account, when an admin tries to add another account with
  the same number, then the addition is refused with a message naming the duplicate number.
- AC-1.3: Given a ledger account, when an admin deactivates it, then it can no longer be chosen
  for a new classification, and every line already classified with it keeps it unchanged.
- AC-1.4: Given the Settings tab, when an admin adds a VAT code with a code, a label and a rate
  between 0 % and 100 %, then it appears in the list of VAT codes; adding a code that already
  exists is refused.
- AC-1.5: Given an existing VAT code, when an admin tries to change its rate, then no such edit
  is offered; the admin can only deactivate the code and add a new one.
- AC-1.6: Given a deactivated VAT code, when accounting classifies a line, then that code is
  not offered, and lines already carrying it keep it unchanged.
- AC-1.7: Given a user without the refund admin capability, when they try to add, deactivate
  or view the management of accounts or VAT codes, then the action is denied.
- AC-1.8: Given any addition or deactivation of an account or VAT code, when it is saved, then
  the audit trail records who did it, when, and the before/after state.

### US-2: Admin sets the default classification of each expense type

As a refund admin, I want each expense type to have a default ledger account and a default VAT
code for WellD CH, so that accounting only intervenes on the exceptions.

**Acceptance criteria:**
- AC-2.1: Given the Settings tab, when an admin sets the default account and the default VAT
  code of an expense type, then the change is saved with who made it and when, and the previous
  default stays visible in the history.
- AC-2.2: Given the twelve expense types, when the Settings tab is opened, then each type shows
  its current default account and default VAT code, or that it has none.
- AC-2.3: Given a default classification that changes, when the change is saved, then the
  classification of every line already approved is unchanged (see AC-3.5).
- AC-2.4: Given only active accounts and VAT codes, when an admin chooses a default, then only
  active accounts and codes are offered.

### US-3: Accounting reviews and corrects each line's classification

As an accounting user, I want each WellD CH line I review to arrive already classified and to be
able to correct it, so that I book exceptions without re-keying the rule.

**Acceptance criteria:**
- AC-3.1: Given a submitted request with a WellD CH line in CHF, when accounting opens it, then
  the line shows the default account and default VAT code of its expense type, marked as
  defaults.
- AC-3.2: Given a submitted request with a WellD CH line in a currency other than CHF, when
  accounting opens it, then the line shows the default account of its expense type and the "no
  VAT" code, marked as defaults.
- AC-3.3: Given a WellD CH line under review, when accounting changes its account or VAT code
  to another active one, then the line keeps the chosen value, it is no longer marked as a
  default, and the audit trail records who changed what from which value to which value.
- AC-3.4: Given a WellD CH line whose expense type has no default account or no default VAT
  code, and that accounting has not classified, when accounting tries to approve the request,
  then the approval is refused and names the lines left without an account or a VAT code.
- AC-3.5: Given a request, when accounting approves it, then every WellD CH line that is not
  rejected keeps the account and VAT code it showed at that moment, whatever later changes to
  the defaults.
- AC-3.6: Given an approved line whose batch is not paid, when accounting changes its account
  or VAT code, then the change is saved and audited as in AC-3.3, and the approved total and
  the decision stay unchanged.
- AC-3.7: Given a line in a paid batch, when accounting tries to change its classification,
  then the change is refused.
- AC-3.8: Given a WellD CH line with a classification, when accounting looks at it, then its
  VAT amount is shown, computed on its CHF amount when that amount is known.
- AC-3.9: Given a WellD Italia line, when accounting opens it, then no account and no VAT code
  are shown or required, and its approval works exactly as before this feature.
- AC-3.10: Given an employee looking at their own request, in any status, then no account, VAT
  code or VAT amount is shown to them.

### US-4: Every approved line gets a receipt number

As an accounting user, I want each approved expense to carry a receipt number Refund assigns,
so that the books, the receipts and the employee all refer to the same number.

**Acceptance criteria:**
- AC-4.1: Given a request being approved, when the approval is saved, then each line that is
  not rejected receives a receipt number, and rejected lines receive none.
- AC-4.2: Given the employee Matteo Codogno and a line with an expense date in 2026, when it is
  numbered, then its number starts with `MC26/`.
- AC-4.3: Given an employee and a year, when lines are numbered, then the sequence starts at
  `001` for the first numbered line of that employee whose expense date falls in that year and
  increases by one for each following one, with no gaps and no repeats.
- AC-4.4: Given a request with several lines being approved, when they are numbered, then they
  are numbered in order of expense date, and lines with the same expense date in the order they
  were added to the request.
- AC-4.5: Given a request with lines whose expense dates fall in two different years, when it
  is approved, then each line is numbered in the sequence of its own expense year.
- AC-4.6: Given two employees with the same initials, when their lines are numbered, then each
  employee has a sequence of their own, and the employee's name appears next to the number
  wherever numbers are listed for accounting.
- AC-4.7: Given a numbered line, then its number never changes and is never reused, including
  when its classification changes, when its batch is discarded, and when it is compiled into a
  later batch.
- AC-4.8: Given an employee whose name gives no initials, when a line is numbered, then the
  initials are taken from the email address before the `@` (first letter of the first two
  parts separated by a dot, or the first two letters otherwise).
- AC-4.9: Given a numbered line, when the employee, accounting or the batch PDF shows it, then
  its receipt number is shown.
- AC-4.10: Given two approvals of the same employee saved at the same moment, when they are
  numbered, then no two lines receive the same number.

### US-5: Admin keeps the monthly average exchange rates

As a refund admin, I want the official monthly average rates of EUR, USD and GBP to CHF to be
fetched for me and to be able to correct them, so that the export converts at the rate the
books use without anyone typing it.

**Acceptance criteria:**
- AC-5.1: Given a calendar month whose official average rate has been published, when Refund
  fetches the rates, then the rate of each of EUR, USD and GBP for that month is recorded with
  its source and the moment it was fetched.
- AC-5.2: Given the Settings tab, when an admin opens the exchange rates, then each month shows
  the rate in effect for each currency and whether it was fetched or corrected by hand.
- AC-5.3: Given a month's rate, when an admin enters a correction, then the correction becomes
  the rate in effect, the previous value stays in the history, and the audit trail records who
  corrected it, when, and from which value to which.
- AC-5.4: Given a month whose rate an admin corrected, when the rates are fetched again, then
  the correction stays in effect.
- AC-5.5: Given a month and currency with no published rate, when an admin opens the exchange
  rates, then that month and currency are shown as missing.
- AC-5.6: Given the official source unreachable, when Refund tries to fetch the rates, then the
  rates already recorded are unchanged and the admin can see that the last fetch failed and
  when.
- AC-5.7: Given a user without the refund admin capability, when they try to correct a rate,
  then the action is denied.

### US-6: Accounting exports a batch for the books

As an accounting user, I want to download, from a batch, a file with one row per approved
WellD CH expense, so that I can import it into the accounting system instead of re-keying it.

**Acceptance criteria:**
- AC-6.1: Given a compiled or paid batch, when accounting asks for its accounting export, then
  they receive a CSV file with a header row and one row per approved, not rejected WellD CH line
  of the requests in the batch.
- AC-6.2: Given an export, then each row carries, in this order: employee name, receipt number,
  expense date, expense type, reason (`motivo`), km (empty when not a mileage line), currency,
  approved total in that currency, exchange rate used (empty for CHF), CHF amount, account
  number, account name, VAT code, VAT rate, VAT amount in CHF, batch identifier.
- AC-6.3: Given a line in EUR dated 2026-03-02 with an approved total of 10.40 and an EUR rate
  in effect for March 2026 of 0.9246, when it is exported, then its CHF amount is 9.62.
- AC-6.4: Given a CHF line of 20.80 classified with a VAT code at 8.1 %, when it is exported,
  then its VAT amount is 1.56.
- AC-6.5: Given a batch with a line in a foreign currency whose expense month has no rate in
  effect for that currency, when accounting asks for the export, then the export is refused and
  lists each missing currency and month; compiling, paying and discarding the batch are not
  affected.
- AC-6.6: Given a batch containing WellD Italia lines, when it is exported, then those lines do
  not appear, and the export screen states how many WellD Italia lines were left out.
- AC-6.7: Given a batch whose WellD CH lines are all rejected or absent, when accounting asks
  for the export, then they receive a file with the header row only.
- AC-6.8: Given the same batch exported twice with no change in between to its lines'
  classification or to the rates in effect, then the two files are identical.
- AC-6.9: Given a discarded batch, when accounting asks for its export, then no export is
  offered.
- AC-6.10: Given an export, when it is downloaded, then the audit trail records who exported
  which batch and when.
- AC-6.11: Given a user without the capability that compiles batches, when they ask for an
  export, then it is denied.
- AC-6.12: Given an approved total of 0 on a line that is not rejected, when it is exported,
  then the row is present with a CHF amount and VAT amount of 0.00.

### US-7: Lines approved before this feature

As an accounting user, I want requests approved before this feature to be handled predictably,
so that the first batches after the release still export.

**Acceptance criteria:**
- AC-7.1: Given a WellD CH line approved before this feature, when the feature is released,
  then it receives the current default classification of its expense type and a receipt
  number, numbered by the rules of US-4 in order of expense date, and the audit trail records
  both as done by the system.
- AC-7.2: Given a WellD CH line approved before this feature whose expense type has no default
  at release time, when its batch is exported, then the export is refused and lists those lines
  until accounting classifies them (AC-3.6).

## Non-goals

- **WellD Italia accounts and VAT.** Only WellD CH's chart of accounts is in hand; Italian
  lines are reviewed, approved, compiled and paid as today and are left out of the export.
- **Converting reimbursed amounts.** What the employee is paid stays in the line's own currency,
  and the batch PDF and its per-currency subtotals are unchanged. The CHF amount exists only for
  the accounting export and the VAT amount.
- **Sending the export to Bexio or any accounting system.** This spec produces a file; a direct
  integration is a follow-up.
- **An aggregated export** (one row per account × VAT code). Accounting aggregates on import.
- **New expense types.** The twelve types stay as they are; missing categories (lodging,
  internal meals, software licences, transport passes, taxi, flights) are a follow-up in
  docs/refund-accounting-backlog.md.
- **Recharging expenses to WellD Italia or settling debts to a shareholder** (accounts 7122 and
  2620.1) as dedicated flows. Accounting can still pick those accounts on a line if an admin
  lists them.
- **Receipt numbers that are unique across employees.** Two employees with the same initials
  can hold the same number; the employee's name always goes with it (AC-4.6).
- **Numbering rejected lines, drafts or submitted lines.** Numbers exist only from approval.
- **Showing accounts, VAT or numbers' meaning to employees** beyond the number itself.
- **Importing the 2026 register** (`Recap_RS_2026.numbers`) into Refund.
- **Choosing the exchange rate by any date other than the expense date's month.**

## Constraints

*Decisions taken with the user on 2026-11-18, captured verbatim for the plan.*

- Accounts and VAT codes cover **only WellD CH** in this spec.
- The accounting export gives the **CHF equivalent** of non-CHF lines; this narrows, for the
  accounting export only, the "no currency conversion" non-goal of specs/20260716-refund-service
  and specs/20260719-refund-monthly-processing, which otherwise stands.
- Monthly average rates are **fetched from an official source**, with manual correction
  possible.
- If a rate is missing, the **export is blocked**; the batch can still be compiled and paid.
- The export has **one row per expense line**.
- The receipt number is **per line, assigned at approval**, formatted as **initials + year of
  the expense date** + per-employee, per-year sequence (`MC26/014`).
- Classification comes **from the expense type's default, and accounting can change it during
  review**, with an audit trail; the employee does not see it.
- The CSV export comes first; a Bexio integration comes later.
- Follows the immutable financial audit trail of ADR 20260716-immutable-financial-audit-trail-refund
  and ADR 20260719-refund-batch-audit-trail-extension, and the suite's Italian/English UI copy
  requirement.

## Open questions

*Approved by the user on 2026-11-18 with every open question below accepted as risk: the
plan proceeds on the stated fallback in each, and accounting answers them before release.*


- [ ] Which official source provides the monthly average rates (e.g. the Federal Tax
  Administration's monthly averages), and does its rate match the one the register uses today
  (EUR 0.9246 for March 2026)? — owner: accounting
- [ ] Should each employee's 2026 sequence start after the numbers already issued by hand in the
  register (e.g. `MC26/081`), so numbers do not collide with paper-era receipts? — owner:
  accounting
- [ ] Separator, decimal mark and encoding the accounting system expects when importing the
  CSV. — owner: accounting
- [ ] Initial list of admitted accounts and the default account and VAT code of each of the
  twelve expense types (a draft can be read off the register). — owner: accounting
- [ ] Should changing a line's classification after approval (AC-3.6) be limited to a
  stricter capability than reviewing? — owner: product (Matteo Codogno)
