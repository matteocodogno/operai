---
id: 20261118
slug: refund-accounting-export
status: in-progress
rigor: production
created: 2026-11-18
approved: 2026-11-18
---

# Refund accounting: ledger accounts, VAT, receipt numbers and the batch export

## Amendments

- **2026-11-18 (post-approval, unattended run, user pre-authorised):** two amendments proposed
  by the architect in plan.md, plus two clarifications. **These amendments were made by the
  product-owner agent during the unattended run, under the user's pre-authorisation; they were
  confirmed by the owner (Matteo Codogno) on 2026-11-19.** Existing AC ids are unchanged; new ACs take the next free number in their story.
  - **A1, reactivation.** An admin can reactivate a deactivated ledger account or VAT code,
    audited like deactivation. Reactivation is the path back after AC-1.4's refusal of a
    duplicate code. New: AC-1.9, AC-1.10, AC-1.11 (reactivating an already active entry is
    refused). Adjusted: AC-1.2, AC-1.4 (the duplicate refusal stays, and also covers a
    deactivated entry), AC-1.7 and AC-1.8 (reactivation added to the denied and audited
    actions). New Non-goal: editing or deleting accounts and VAT codes.
  - **A2, foreign-currency VAT code.** New domain term "foreign-currency VAT code" (see Domain
    language). AC-3.2 now refers to it. New: AC-2.5 to AC-2.8 (designating it, active codes
    only, what happens when none is usable, admin only). Adjusted: AC-2.3 (designation changes
    do not touch approved lines), AC-3.2, AC-3.4 (a non-CHF line with no usable
    foreign-currency VAT code blocks approval), AC-7.1 and AC-7.2 (same rule for pre-release
    lines in another currency); the US-2 story sentence mentions it. New Non-goal: a
    different VAT code per foreign currency. New open question: which code is designated at
    release. **(Superseded by the amendment of 2026-11-19 (accounting sign-off) below: the
    foreign-currency VAT code is retired.)**
  - **Clarification, batch identifier.** The "batch identifier" in AC-6.2 is the batch's
    identifier as shown in Refund. Adjusted: AC-6.2 (wording only). **(The batch identifier is no
    longer a column of the export: see the amendment of 2026-11-19 (accounting sign-off).)**
  - **Clarification, pre-release WellD Italia lines.** WellD Italia lines approved before
    this feature stay unnumbered. New: AC-7.3 and a Non-goal.
- **2026-11-19 (decided by the owner, Matteo Codogno, in an interview; wording by the
  product-owner agent):** the accounting reference data moves out of Refund into a new
  Accounting module, before this feature is released (specs/20261119-accounting). Wording only:
  the status and every AC id are unchanged, and nothing here changes what a Refund user sees
  except where specs/20261119-accounting says so.
  - **US-1 and US-5 move to specs/20261119-accounting.** Ledger accounts, VAT codes and monthly
    average exchange rates are kept there, per legal entity, by accounting managers through new
    Accounting capabilities (read / manage) instead of Refund's `settings:read` /
    `settings:manage`. AC-1.1 to AC-1.11 and AC-5.1 to AC-5.7 are marked "(moved to
    specs/20261119-accounting)" inline and are specified and verified there; "admin" in them reads
    "accounting manager". The domain terms ledger account, VAT code and monthly average rate keep
    their meaning but are now kept in Accounting.
  - **Refund's reference data comes from Accounting, with copies frozen at approval.** The accounts
    and VAT codes that Refund offers (AC-2.4, AC-2.6, and the choices of AC-3.3, marked inline)
    are Accounting's active WellD CH entries. When a line is classified or approved, Refund
    records a copy of its account number and name, its VAT code and rate and, for a line in a
    currency other than CHF, the exchange rate used, so that approved lines and exports never
    change when Accounting changes or is unreachable (extends AC-3.5, AC-6.3, AC-6.8). When
    Accounting cannot be reached or lacks data, Refund refuses the approval or the export with a
    clear message rather than book incomplete data (extends AC-3.4, AC-6.5). Refund keeps the
    per-type defaults, the foreign-currency VAT code designation, line classification, receipt
    numbering and the batch export. **(The foreign-currency VAT code designation and the per-type
    default VAT codes are retired by the amendment of 2026-11-19 (accounting sign-off) below.)**
  - **The Settings tabs move.** The "Accounts and VAT" and "Exchange rates" views leave Refund's
    Settings and live only in the Accounting app. Refund's Settings keeps the per-type defaults
    and the foreign-currency VAT code designation (chosen among Accounting's active WellD CH
    entries) and links to the Accounting app. **(Now: the per-type default accounts only.)**
  - **Open questions 1, 4 and 6** keep their owner (accounting); the answers to 1 and 4 are
    entered in Accounting, the answer to 6 in Refund's Settings.
- **Amendment 2026-11-19 (accounting sign-off; decided by the owner):** the company accountant
  answered the open questions of this spec and of specs/20261119-accounting, and the owner
  (Matteo Codogno) decided four points on 2026-11-19: the account for gifts to clients, the
  VAT code being optional, the 2026 receipt numbering, and the shape of the accounting export.
  Wording by the product-owner agent. **Unlike the earlier entries, this one changes the
  behaviour of a feature that is implemented but not released** (plan, tasks and code follow
  it); the status stays `in-progress`. No AC id is reused: retired ACs stay in place marked
  "(retired 2026-11-19: reason)", adjusted ACs say so, and new ACs take the next free number in
  their story. Reference data (the lists of accounts and VAT codes, the rate source) is kept in
  Accounting and amended in specs/20261119-accounting by an entry of the same date. **(The file
  format left open here was settled by the accountant's sample file: see the entry "sync with the
  sample file" below.)**
  - **E1, expense types and accounts.** The expense type "Rappresentanza – Pasti"
    (`representation_meals`) is renamed "Pranzi/cene con clienti" (default account 6701).
    "Rappresentanza – Regali" is kept, with no default account: accounting picks the account by
    hand. "Manualistica societaria" (company manuals) has the default account 6501 "Libri e
    manuali". Two types are added, flight (account 5902 "Spese viaggi in aereo") and taxi (5903
    "Spese viaggi taxi"), so there are fourteen types; this extends the twelve fixed types of
    specs/20260716-refund-service. The accounts 7122 "Spese da riaddebitare a WellD Italia" and
    2620.1 "Altri debiti verso soci - CHF (CH)" join the WellD CH list and are chosen by hand when
    relevant, never as a default. New: US-8 (AC-8.1 to AC-8.5). Adjusted: AC-2.2 and the
    Non-goals "New expense types" and "Recharging expenses...".
  - **E2, the VAT code is optional and never pre-set.** No VAT code is ever pre-set by default,
    for CHF and foreign-currency lines alike: accounting enters it by hand after checking the
    receipt (a foreign receipt is not "no Swiss VAT" by default: for example a foreign supplier
    invoice paid in USD takes the reverse-charge code BZM81 unless the supplier is
    VAT-registered in Switzerland). The VAT code of a line is optional: it may stay blank and
    never blocks approval or export. It is a reference for the manual entry in the accounting
    system, because the import file cannot carry VAT. One VAT code per line; a receipt with
    several rates (for example Migros 8.1 % and 2.6 %) is split into several lines if needed.
    **Retired:** the per-type default VAT codes and the foreign-currency VAT code designation
    (the A2 amendment above): AC-2.5, AC-2.6, AC-2.7, AC-3.2, and the domain terms "default VAT
    code" and "foreign-currency VAT code". Approval requires only a ledger account for a WellD CH
    line. The VAT amount is shown only when a VAT code is set. New: AC-3.11, AC-3.12, AC-3.13.
    Adjusted: US-2 and US-3 story sentences, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.8, AC-3.1,
    AC-3.3, AC-3.4, AC-3.5, AC-3.8, AC-7.1, AC-7.2, and AC-1.10 (moved to Accounting; wording).
  - **E3, VAT codes in use.** IPM81 (8.1 %), IPM77 (7.7 %, still needed), IP00 (0.00 %, instead of
    "NOVAT"; a blank VAT code is also allowed), a reduced-rate code at 2.6 % (supermarkets:
    Aldi, Coop, Migros), a reduced-rate code at 3.8 % (overnight stays in Switzerland: rare, but
    kept active) and BZM81 (reverse charge, 8.1 %). The register's spelling "IMP81" was wrong:
    IPM is correct. The codes for 2.6 % and 3.8 % are not yet known (named IPM26 and IPM38 until
    confirmed: open question). The list lives in Accounting (specs/20261119-accounting, AC-7.6).
  - **E4, receipt numbers.** Each employee's counter restarts from 1 every year, so in 2027 it
    restarts from 1 (already the rule of AC-4.3). For 2026 each employee's sequence continues
    after the last number issued by hand in the 2026 register. New: AC-4.11, AC-4.12, AC-4.13,
    AC-7.4. Adjusted: AC-4.3. The receipt number still exists on every approved line and is still
    shown as before (AC-4.9).
  - **E5, exchange-rate source.** The March 2026 value (EUR 0.9246) is confirmed. The reference
    source is the Swiss Federal Tax Administration (AFC/ESTV) monthly average rates, not the customs
    office. The spec names the authority; the technical way to obtain it is for the plan (see
    specs/20261119-accounting, AC-2.1 and AC-2.12). Closes open question 1.
  - **E6, the accounting export is a journal file (replaces the 16-column CSV).** One row per
    approved WellD CH expense line, with: Date (`yyyy-mm-dd`), Description (employee name, reason
    (`motivo`), for a line in a foreign currency the original currency and amount and the CHF
    equivalent, and the receipt number), Debit account (the line's ledger account), Credit
    account (always 5832 "Rimborso spese effettive"), Amount (the CHF equivalent only) and
    Currency (always CHF). The file has a Tax column the accounting system cannot import: VAT is
    not carried. The exact header names, column order, separator, encoding and date and decimal
    formats wait for the accountant's sample file (open question). Kept: one row per line, the
    export blocked when a CHF amount cannot be computed, identical re-export, audit of downloads.
    **Retired:** the 16-column list of AC-6.2 (employee name, receipt number, expense type, km,
    currency, approved total, exchange rate, account name, VAT code, VAT rate, VAT amount and batch
    identifier are no longer columns) and AC-6.4 (VAT amount in the export). Adjusted: US-6 story
    sentence, AC-6.1, AC-6.2, AC-6.3 (the 9.62 example stays valid, as the Amount), AC-6.5,
    AC-6.12. New: AC-6.13, AC-6.14, AC-6.15. The batch identifier is no longer in the file; who
    exported which batch and when stays in the audit trail (AC-6.10).
  - **E7, receipt scanning stays out.** Reading the VAT code or amount from the receipt with AI
    stays a non-goal here (backlog item 8, docs/refund-accounting-backlog.md); a future feature
    will have to handle receipts with several VAT rates. New Non-goals.
  - **Summary.** Added: AC-3.11, AC-3.12, AC-3.13, AC-4.11, AC-4.12, AC-4.13, AC-6.13, AC-6.14,
    AC-6.15, AC-7.4, AC-8.1 to AC-8.5. Adjusted: AC-1.10, AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.8,
    AC-3.1, AC-3.3, AC-3.4, AC-3.5, AC-3.8, AC-4.3, AC-6.1, AC-6.2, AC-6.3, AC-6.5, AC-6.12,
    AC-7.1, AC-7.2. Retired: AC-2.5, AC-2.6, AC-2.7, AC-3.2, AC-6.4. Open questions: 1, 2, 3 and 6
    closed, 4 closed in part; new ones below.
- **Amendment 2026-11-19 (sync with the sample file; owner-approved scope):** the accountant's
  sample import file (a spreadsheet template of the accounting system, Accrio) arrived, and the
  architect's plan (its "Accounting sign-off delta") read it. This entry brings the spec in line
  with what the sample fixes; it adds no new decision of the owner. Wording by the
  product-owner agent; status unchanged. No AC id is reused.
  - **F1, the export is a spreadsheet workbook, not a CSV.** A single workbook (XLSX) with one
    sheet named `Sheet 1`, one header row, then one row per line. The headers are exactly `Date |
    Description | Debit | Credit | Amount | Currency | Tax | Note`, in this order. **Tax and Note
    are present and empty on every row**; the Note column is the template's own and is empty, so
    "no other column" now allows it. Date is a date, Debit, Credit and Amount are numbers, so the
    accounting system reads them as such. Separator, encoding and line ending have no object in a
    workbook. Adjusted: AC-6.1, AC-6.2, AC-6.14 (no longer provisional). New: AC-6.17 (an account
    number that a number cannot hold exactly stays text, unchanged).
  - **F2, row order.** Rows are ordered by Date, latest first, as in the template, with fixed
    tie-breakers so that the same lines always give the same file. New: AC-6.16.
  - **F3, the formula guard for a workbook.** Text from people always stays text in its cell and
    is never a formula; the leading-quote device of the CSV era is gone. Adjusted: AC-6.15.
  - **F4, the Description pattern (provisional).** `<reason> [<receipt number>] <name>`, and for a
    line in another currency `<reason> [<receipt number>] [EUR 10.40 = CHF 9.62] <name>`. The name
    is the employee's name, or the email when the account has none. A line break or other control
    character in the reason or the name appears as one space (this answers the earlier question on
    line breaks). Order and separators stay a question for the accountant, because the sample's
    rows were all in CHF and predate receipt numbers. Adjusted: AC-6.13.
  - **F5, an empty baseline list counts as available.** A list stating that no employee has a
    hand-issued 2026 number is a valid list; only a missing list stops the release numbering
    (AC-7.4, and AC-4.12 for the employee not in the list). Adjusted: AC-7.4.
  - **F6, open questions.** Closed by the sample: the sample file itself, the header names, column
    order and Tax column, the row order, the line-break question. New follow-ups for the
    accountant: a trial import of the golden file into Accrio; accounts seen in the 2025 template
    but not in the signed-off list (5803, 6199, 6305, 6721, and a row whose Debit is "2").
  - *F7 and F8 were added after the owner's approval of the sign-off scope; the owner (Matteo Codogno)
    confirmed both on 2026-11-20.*
  - **F7, whitespace in the Description and text cells.** Control characters, line breaks and runs
    of spaces in the reason and the name become a single space, and the ends are trimmed (the
    plan's choice, friendly to the accounting system); everything else stays exactly as written
    and is never a formula. Adjusted: AC-6.13, AC-6.15.
  - **F8, the 2026 baseline follows the employee's addresses.** The hand-issued baseline applies to
    an employee by any email address their account has used; an address changed before the
    employee had filed anything in Refund needs a baseline row of its own (security finding
    N-01). Adjusted: AC-4.11.
  - **Summary.** Added: AC-6.16, AC-6.17. Adjusted: AC-4.11, AC-6.1, AC-6.2, AC-6.13, AC-6.14,
    AC-6.15, AC-7.4. Retired: none.

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
*(Since the amendment of 2026-11-19, the VAT code and amount that Refund keeps on a line are a
reference for accounting's manual entry, not part of what is imported.)*

## Domain language

Extends specs/20260716-refund-service (request, expense line, expense type, entity, currency,
approved total, accounting, decision), specs/20260719-refund-monthly-processing (batch,
compiled, paid, discarded) and specs/20260720-mileage-rate (effective-dated, append-only
settings). New terms:

- **expense type** *(amended 2026-11-19)* — one of the fixed categories of a line. There are now
  fourteen: the twelve of specs/20260716-refund-service plus **flight** and **taxi**. The type
  `representation_meals` is named "Pranzi/cene con clienti" (formerly "Rappresentanza – Pasti");
  `representation_gifts` keeps "Rappresentanza – Regali".
- **ledger account** — an account of WellD CH's chart of accounts that an expense is booked
  to, identified by its number (e.g. `5905`) and carrying a name (e.g. "Spese rimborsi
  chilometrici (viaggi)"). Only the accounts admitted for refunds are listed in Refund.
- **default account** — the ledger account an expense type is booked to unless accounting
  says otherwise, configured per expense type for WellD CH. An expense type may have none
  ("Rappresentanza – Regali").
- **VAT code** *(amended 2026-11-19)* — a code from a managed list (in use: `IPM81` 8.1 %,
  `IPM77` 7.7 %, `IP00` 0.00 %, a 2.6 % and a 3.8 % reduced-rate code, `BZM81` reverse charge
  8.1 %) that carries one fixed VAT rate. A code's rate never changes; a new rate is a new code.
  The VAT code of a line is **optional**: no code is ever pre-set, accounting enters it by hand
  after checking the receipt, it may stay blank, and a line has at most one. It is a reference for
  the manual entry in the accounting system; it never blocks approval or export. The register's
  spelling "IMP81" was wrong: `IPM81` is correct.
- **default VAT code** — *(retired 2026-11-19: no VAT code is ever pre-set by default)* the VAT
  code an expense type gets unless accounting says otherwise, configured per expense type for
  WellD CH.
- **foreign-currency VAT code** — *(retired 2026-11-19: a foreign receipt is not "no Swiss VAT" by
  default; accounting enters the code, for example `BZM81` for a foreign supplier invoice not
  VAT-registered in Switzerland)* the VAT code, designated once for WellD CH in Settings, that a
  WellD CH line in a currency other than CHF got by default.
- **classification** *(amended 2026-11-19)* — a line's ledger account (required for a WellD CH
  line to be approved) and, optionally, its VAT code.
- **VAT amount** *(amended 2026-11-19)* — when a line has a VAT code, the VAT contained in the
  line's CHF amount: `amount − amount / (1 + rate)`, rounded to the cent. A line without a VAT
  code has no VAT amount. It is shown to accounting only and is not part of the accounting export.
- **monthly average rate** *(amended 2026-11-19)* — the average exchange rate of a foreign
  currency (EUR, USD, GBP) to CHF for one calendar month, as published by the Swiss Federal Tax
  Administration (AFC/ESTV, "monthly average rates"), correctable by hand. The customs office is
  not the reference.
- **CHF amount** — a line's approved total in CHF: the approved total itself for a CHF line,
  or the approved total × the monthly average rate of the month of the line's expense date for
  a line in another currency, rounded to the cent.
- **receipt number** *(amended 2026-11-19)* — the human-readable number of an approved expense
  line, in the form `<initials><YY>/<NNN>` (e.g. `MC26/014`): the employee's initials, the last
  two digits of the year of the expense date, and a three-digit sequence that counts per employee
  and per year. The sequence restarts from 1 every year; for 2026 it continues after the
  employee's last number issued by hand (AC-4.11).
- **last hand-issued number** — an employee's highest 2026 sequence number written by hand in the
  2026 register (e.g. 81 for `MC26/081`), the point after which Refund continues in 2026.
- **accounting export** *(redefined 2026-11-19; format settled by the sample file)* — a workbook
  (XLSX, one sheet `Sheet 1`) produced from a batch with one journal row per approved WellD CH
  expense line: Date, Description, Debit, Credit, Amount, Currency, and the empty Tax and Note
  columns (AC-6.2). It replaces the 16-column CSV first specified here.
- **credit account** — the account every journal row of the accounting export is credited to:
  always 5832 "Rimborso spese effettive".

## User stories

### US-1: Admin manages the ledger accounts and VAT codes Refund may use *(moved to specs/20261119-accounting)*

As a refund admin, I want to keep the list of ledger accounts and VAT codes Refund may use, so
that every expense is booked to an account and a VAT code that exist in the books.

**Acceptance criteria:**
- AC-1.1 *(moved to specs/20261119-accounting)*: Given the Settings tab, when an admin adds a ledger account with a number and a
  name, then it appears in the list of accounts and can be chosen as a default account or as a
  line's account.
- AC-1.2 *(moved to specs/20261119-accounting)*: Given an existing ledger account, active or deactivated, when an
  admin tries to add another account with the same number, then the addition is refused with a
  message naming the duplicate number.
- AC-1.3 *(moved to specs/20261119-accounting)*: Given a ledger account, when an admin deactivates it, then it can no longer be chosen
  for a new classification, and every line already classified with it keeps it unchanged.
- AC-1.4 *(moved to specs/20261119-accounting)*: Given the Settings tab, when an admin adds a VAT code with a code,
  a label and a rate between 0 % and 100 %, then it appears in the list of VAT codes; adding a
  code that already exists, active or deactivated, is refused (reactivation, AC-1.10, is the
  way back to a deactivated code).
- AC-1.5 *(moved to specs/20261119-accounting)*: Given an existing VAT code, when an admin tries to change its rate, then no such edit
  is offered; the admin can only deactivate the code and add a new one.
- AC-1.6 *(moved to specs/20261119-accounting)*: Given a deactivated VAT code, when accounting classifies a line, then that code is
  not offered, and lines already carrying it keep it unchanged.
- AC-1.7 *(moved to specs/20261119-accounting)*: Given a user without the refund admin capability, when they try to
  add, deactivate, reactivate or view the management of accounts or VAT codes, then the action
  is denied.
- AC-1.8 *(moved to specs/20261119-accounting)*: Given any addition, deactivation or reactivation of an account or
  VAT code, when it is saved, then the audit trail records who did it, when, and the
  before/after state.
- AC-1.9 *(moved to specs/20261119-accounting)*: Given a deactivated ledger account, when an admin reactivates it,
  then it is listed as active with the same number and name, it can again be chosen as a
  default account or as a line's account, and the classification of every existing line is
  unchanged.
- AC-1.10 *(moved to specs/20261119-accounting; adjusted 2026-11-19: there is no default VAT
  code and no foreign-currency VAT code any more)*: Given a deactivated VAT code, when an admin
  reactivates it, then it is listed as active with the same code, label and rate, it can again be
  chosen as a line's VAT code, and the classification of every existing line is unchanged.
- AC-1.11 *(moved to specs/20261119-accounting)*: Given a ledger account or VAT code that is already active, when
  an admin tries to reactivate it, then the action is refused with a message saying it is
  already active, and nothing is recorded in the audit trail.

### US-2: Admin sets the default ledger account of each expense type

*(Story sentence amended 2026-11-19: the default VAT code and the foreign-currency VAT code are
retired.)*

As a refund admin, I want each expense type to have a default ledger account for WellD CH, so
that accounting only intervenes on the exceptions.

**Acceptance criteria:**
- AC-2.1 *(adjusted 2026-11-19: the account only)*: Given the Settings tab, when an admin sets the
  default account of an expense type, then the change is saved with who made it and when, and the
  previous default stays visible in the history.
- AC-2.2 *(adjusted 2026-11-19: fourteen types; the account only)*: Given the fourteen expense
  types, when the Settings tab is opened, then each type shows its current default account, or
  that it has none.
- AC-2.3 *(adjusted 2026-11-19: the account only)*: Given a default account that changes, when the
  change is saved, then the classification of every line already approved is unchanged (see
  AC-3.5).
- AC-2.4 *(options now come from Accounting, specs/20261119-accounting; adjusted 2026-11-19: accounts only)*: Given only active accounts, when an admin chooses a default account, then only
  active accounts are offered.
- AC-2.5 *(retired 2026-11-19: the foreign-currency VAT code no longer exists; no VAT code is ever
  pre-set)*: Given the Settings tab, when an admin designates a VAT code as the
  foreign-currency VAT code, then the change is saved with who made it and when, the previous
  designation stays visible in the history, and the Settings tab shows the code currently
  designated, or that none is.
- AC-2.6 *(retired 2026-11-19: the foreign-currency VAT code no longer exists; was: options from Accounting, specs/20261119-accounting)*: Given an inactive VAT code, when an admin designates the
  foreign-currency VAT code, then only active codes are offered, and an attempt to designate an
  inactive one is refused.
- AC-2.7 *(retired 2026-11-19: the foreign-currency VAT code no longer exists; a VAT code never blocks approval)*: Given a foreign-currency VAT code that is not designated, or whose
  designated code is deactivated, when accounting opens a WellD CH line in a currency other than
  CHF, then the line shows the default account of its expense type and no VAT code, so AC-3.4
  applies unless accounting classifies the line.
- AC-2.8 *(adjusted 2026-11-19: now covers the default accounts)*: Given a user without the
  refund admin capability, when they try to set or view the management of the default accounts,
  then the action is denied.

### US-3: Accounting reviews and corrects each line's classification

*(Story sentence amended 2026-11-19: the account arrives pre-filled, the VAT code is entered by
hand and optional.)*

As an accounting user, I want each WellD CH line I review to arrive with its default ledger
account and to be able to correct it and to enter a VAT code when the receipt calls for one, so
that I book exceptions without re-keying the rule.

**Acceptance criteria:**
- AC-3.1 *(adjusted 2026-11-19: no VAT code is pre-set, in CHF or in any other currency)*: Given a
  submitted request with a WellD CH line, in CHF or in any other currency, when accounting opens
  it, then the line shows the default account of its expense type, marked as default (or no
  account if the type has none), and no VAT code.
- AC-3.2 *(retired 2026-11-19: no foreign-currency VAT code; the currency of a line no longer
  changes how it is classified, see AC-3.1 and AC-3.13)*: Given a submitted request with a WellD CH line in a currency other
  than CHF, when accounting opens it, then the line shows the default account of its expense
  type and the foreign-currency VAT code, marked as defaults.
- AC-3.3 *(options now come from Accounting, specs/20261119-accounting; adjusted 2026-11-19: the VAT code is set, changed or cleared)*: Given a WellD CH line under review, when accounting changes its account
  to another active one, or sets, changes or clears its VAT code (choosing among the active codes,
  or none), then the line keeps the chosen value, an account changed this way is no longer marked
  as a default, and the audit trail records who changed what from which value to which value (a
  blank VAT code is recorded as "none").
- AC-3.4 *(adjusted 2026-11-19: only the account is required)*: Given a WellD CH line that has no
  default account and that accounting has not classified with an account, when accounting tries
  to approve the request, then the approval is refused and names the lines left without an
  account. A line without a VAT code never makes the approval refused.
- AC-3.5 *(adjusted 2026-11-19: the VAT code may be absent)*: Given a request, when accounting
  approves it, then every WellD CH line that is not rejected keeps the account and the VAT code
  (or the absence of one) it showed at that moment, whatever later changes to the defaults.
- AC-3.6: Given an approved line whose batch is not paid, when accounting changes its account
  or VAT code, then the change is saved and audited as in AC-3.3, and the approved total and
  the decision stay unchanged.
- AC-3.7: Given a line in a paid batch, when accounting tries to change its classification,
  then the change is refused.
- AC-3.8 *(adjusted 2026-11-19: shown only when a VAT code is set)*: Given a WellD CH line with a
  VAT code, when accounting looks at it, then its VAT amount is shown, computed on its CHF amount
  when that amount is known (for example a CHF line of 20.80 with a VAT code at 8.1 % shows 1.56,
  and one with `IP00` shows 0.00). Given a WellD CH line without a VAT code, then no VAT amount
  is shown.
- AC-3.9: Given a WellD Italia line, when accounting opens it, then no account and no VAT code
  are shown or required, and its approval works exactly as before this feature.
- AC-3.10: Given an employee looking at their own request, in any status, then no account, VAT
  code or VAT amount is shown to them.
- AC-3.11: Given a WellD CH line with no VAT code, in CHF or in any other currency, when
  accounting approves the request or the batch is exported, then neither is refused or held back
  for that reason, and the line is approved and exported like any other.
- AC-3.12: Given a WellD CH line, then it carries at most one VAT code; no way is offered to give
  it two. A receipt with several VAT rates (for example 8.1 % and 2.6 %) is entered as several
  lines, one per rate, if the rates are to be kept.
- AC-3.13: Given a WellD CH line in a currency other than CHF, when accounting opens it, then no
  VAT code is pre-set and the line is not treated as having no Swiss VAT; accounting may enter any
  active VAT code, including the reverse-charge code `BZM81`, after checking the receipt.

### US-4: Every approved line gets a receipt number

As an accounting user, I want each approved expense to carry a receipt number Refund assigns,
so that the books, the receipts and the employee all refer to the same number.

**Acceptance criteria:**
- AC-4.1: Given a request being approved, when the approval is saved, then each line that is
  not rejected receives a receipt number, and rejected lines receive none.
- AC-4.2: Given the employee Matteo Codogno and a line with an expense date in 2026, when it is
  numbered, then its number starts with `MC26/`.
- AC-4.3 *(adjusted 2026-11-19: the 2026 starting point and the 2027 restart)*: Given an employee
  and a year, when lines are numbered, then the sequence starts at `001` for the first numbered
  line of that employee whose expense date falls in that year, except in 2026 where AC-4.11
  applies, and increases by one for each following one, with no gaps and no repeats.
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
- AC-4.11 *(adjusted 2026-11-19: the baseline follows the employee's addresses)*: Given an
  employee whose last hand-issued number in the 2026 register is N (for example `MC26/081`), when
  the first line of that employee with an expense date in 2026 is numbered, then it receives N + 1
  (`MC26/082`), and the following 2026 lines continue by one with no gaps and no repeats. The
  baseline applies to the employee by any email address their account has used: an employee whose
  address changed after filing in Refund still continues after N. When an address was changed
  before the employee had filed anything in Refund, Refund holds no link between the two
  addresses, and the baseline list needs a row for the current address as well.
- AC-4.12: Given an employee for whom no last hand-issued number is recorded, when their first
  line with an expense date in 2026 is numbered, then it receives `001`; and given a line with an
  expense date in a year other than 2026, then no hand-issued number is taken into account.
- AC-4.13: Given an employee whose 2026 sequence reached 142, when the first line of that
  employee with an expense date in 2027 is numbered, then it receives `001` (for example
  `MC27/001`), whatever the 2026 sequence reached.

### US-5: Admin keeps the monthly average exchange rates *(moved to specs/20261119-accounting)*

As a refund admin, I want the official monthly average rates of EUR, USD and GBP to CHF to be
fetched for me and to be able to correct them, so that the export converts at the rate the
books use without anyone typing it.

**Acceptance criteria:**
- AC-5.1 *(moved to specs/20261119-accounting; the official source is the Swiss Federal Tax Administration (AFC/ESTV), amended 2026-11-19)*: Given a calendar month whose official average rate has been published, when Refund
  fetches the rates, then the rate of each of EUR, USD and GBP for that month is recorded with
  its source and the moment it was fetched.
- AC-5.2 *(moved to specs/20261119-accounting)*: Given the Settings tab, when an admin opens the exchange rates, then each month shows
  the rate in effect for each currency and whether it was fetched or corrected by hand.
- AC-5.3 *(moved to specs/20261119-accounting)*: Given a month's rate, when an admin enters a correction, then the correction becomes
  the rate in effect, the previous value stays in the history, and the audit trail records who
  corrected it, when, and from which value to which.
- AC-5.4 *(moved to specs/20261119-accounting)*: Given a month whose rate an admin corrected, when the rates are fetched again, then
  the correction stays in effect.
- AC-5.5 *(moved to specs/20261119-accounting)*: Given a month and currency with no published rate, when an admin opens the exchange
  rates, then that month and currency are shown as missing.
- AC-5.6 *(moved to specs/20261119-accounting)*: Given the official source unreachable, when Refund tries to fetch the rates, then the
  rates already recorded are unchanged and the admin can see that the last fetch failed and
  when.
- AC-5.7 *(moved to specs/20261119-accounting)*: Given a user without the refund admin capability, when they try to correct a rate,
  then the action is denied.

### US-6: Accounting exports a batch for the books

*(Story sentence amended 2026-11-19: a journal file.)*

As an accounting user, I want to download, from a batch, a file with one journal row per approved
WellD CH expense, so that I can import it into the accounting system instead of re-keying it.

**Acceptance criteria:**
- AC-6.1 *(adjusted 2026-11-19: a workbook, not a CSV; the file is the journal file of AC-6.2)*:
  Given a compiled or paid batch, when accounting asks for its accounting export, then they
  receive an XLSX workbook with one sheet named `Sheet 1`, a header row and one row per approved,
  not rejected WellD CH line of the requests in the batch.
- AC-6.2 *(adjusted 2026-11-19: replaces the 16-column list, retired: employee name, receipt
  number, expense date, expense type, reason, km, currency, approved total, exchange rate, CHF
  amount, account number, account name, VAT code, VAT rate, VAT amount and batch identifier; the
  sample file fixed the headers)*:
  Given an export, then its header row is exactly `Date`, `Description`, `Debit`, `Credit`,
  `Amount`, `Currency`, `Tax`, `Note`, in this order, and each row carries: Date (the line's
  expense date, a date shown as `yyyy-mm-dd`), Description (AC-6.13), Debit (the number of the
  line's ledger account), Credit (always `5832`, "Rimborso spese effettive"), Amount (the line's
  CHF amount, and only that: never the amount in another currency), Currency (always `CHF`), Tax
  and Note (AC-6.14). Date is a date, and Debit, Credit and Amount are numbers (AC-6.17 for an
  account number a number cannot hold), so that the accounting system reads them as such. No other
  column exists: in particular no VAT code, VAT rate, VAT amount, exchange rate, km, expense type
  or batch identifier.
- AC-6.3 *(adjusted 2026-11-19: the CHF amount is the row's Amount)*: Given a line in EUR dated
  2026-03-02 with an approved total of 10.40 and an EUR rate in effect for March 2026 of 0.9246,
  when it is exported, then its CHF amount, which is the Amount of its row, is 9.62.
- AC-6.4 *(retired 2026-11-19: the import file cannot carry VAT; the VAT amount stays on screen,
  AC-3.8)*: Given a CHF line of 20.80 classified with a VAT code at 8.1 %, when it is exported,
  then its VAT amount is 1.56.
- AC-6.5 *(adjusted 2026-11-19: wording, the CHF amount cannot be computed)*: Given a batch with a
  line in a foreign currency whose CHF amount cannot be computed because its expense month has no
  rate in effect for that currency, when accounting asks for the export, then the export is
  refused and lists each missing currency and month; compiling, paying and discarding the batch
  are not affected.
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
- AC-6.12 *(adjusted 2026-11-19: no VAT amount in the file)*: Given an approved total of 0 on a
  line that is not rejected, when it is exported, then the row is present with an Amount of 0.00.
- AC-6.13 *(adjusted 2026-11-19: the provisional pattern; whitespace made uniform)*: Given a row,
  then its Description contains the line's reason (`motivo`), the line's receipt number and the
  employee's name (the email address when the account has no name), in the provisional pattern
  `<reason> [<receipt number>] <name>` (for example `Cancelleria [MC26/001] Matteo Codogno`); for
  a line in a currency other than CHF it also contains the original currency and approved total
  and the CHF equivalent, as `<reason> [<receipt number>] [EUR 10.40 = CHF 9.62] <name>` for the
  line of AC-6.3. For a line in CHF it contains no currency and no second amount. In the reason
  and the name, every line break, other control character and run of spaces appears as a single
  space and the ends are trimmed, so a Description is always a single line without double
  spaces. The order and separators of the elements are provisional until the accountant answers
  (open question).
- AC-6.14 *(adjusted 2026-11-19: confirmed by the sample file, no longer provisional; Note added)*:
  Given an export, then the Tax column and the Note column are present, in the positions of
  AC-6.2, and empty on every row, so that the file lines up with what the accounting system
  expects and VAT is not carried.
- AC-6.15 *(adjusted 2026-11-19: reworded for a workbook; whitespace as in AC-6.13)*: Given a name
  or a reason that starts with `=`, `+`, `-` or `@`, or that contains a character with a meaning
  in a spreadsheet file (for example `<`, `>`, `&`, a quote), when it is exported, then it is in
  its cell as text and no cell of the workbook is ever a formula. Apart from the whitespace
  changes of AC-6.13 (line breaks, other control characters and runs of spaces become a single
  space, the ends are trimmed), the text is exactly as written, and the row keeps its eight cells
  and adds, merges or splits no row or column.
- AC-6.16: Given an export, then its rows are ordered by Date, the latest first; rows with the same
  Date follow a fixed order (by the Description's employee name, then by employee, receipt year
  and receipt sequence, then by line), so that the same lines always give the same file (AC-6.8).
- AC-6.17: Given a Debit account number that a number cannot hold exactly (for example `2620.10`,
  which would become `2620.1`), when it is exported, then it appears unchanged as text, never
  rounded or reformatted; a plain account number such as `5905` or `2620.1` is a number.

### US-7: Lines approved before this feature

As an accounting user, I want requests approved before this feature to be handled predictably,
so that the first batches after the release still export.

**Acceptance criteria:**
- AC-7.1 *(adjusted 2026-11-19: the account only, no VAT code)*: Given a WellD CH line approved
  before this feature, when the feature is released, then it receives the current default
  account of its expense type and a receipt number, numbered by the rules of US-4 (AC-4.11
  included) in order of expense date, and the audit trail records both as done by the system. It
  receives no VAT code.
- AC-7.2 *(adjusted 2026-11-19: the account only)*: Given a WellD CH line approved before this
  feature that has no default account at release time, when its batch is exported, then the export
  is refused and lists those lines until accounting classifies them (AC-3.6).
- AC-7.3: Given a WellD Italia line approved before this feature, when the
  feature is released and afterwards, then it receives no receipt number and no classification,
  and it is left out of the accounting export as in AC-6.6.
- AC-7.4 *(adjusted 2026-11-19: an empty list counts as available)*: Given the release, when the
  list of last hand-issued numbers (AC-4.11) is missing, then no line approved before this feature
  is numbered and the run reports why; running it again once the list is available is safe, and no
  number is consumed meanwhile. A list that states that no employee has a hand-issued 2026 number
  (a list with no employee) is available: the lines are numbered from `001` (AC-4.12).

### US-8: Expense types and default accounts signed off by accounting

As an accounting user, I want the expense types to match the categories accounting books to, so
that flights, taxis, meals with clients and company manuals reach the right account without
anyone choosing it each time.

**Acceptance criteria:**
- AC-8.1: Given an employee entering a line, when the expense types are offered, then there are
  fourteen, the twelve of specs/20260716-refund-service plus flight and taxi, each with an Italian
  and an English label, for a line of either entity.
- AC-8.2: Given the expense type formerly named "Rappresentanza – Pasti", then it is named
  "Pranzi/cene con clienti" wherever a type's name is shown (entry, review, Settings, batch PDF),
  and every request line that already carries it keeps it, shown under the new name.
- AC-8.3: Given the Settings tab at release, then the default accounts are: "Pranzi/cene con
  clienti" 6701; "Manualistica societaria" 6501 "Libri e manuali"; flight 5902 "Spese viaggi in
  aereo"; taxi 5903 "Spese viaggi taxi"; "Rappresentanza – Regali" none. The defaults of the other
  types are those of the initial list entered by accounting (open question).
- AC-8.4: Given a WellD CH line of type "Rappresentanza – Regali" for which accounting has not
  chosen an account, when accounting tries to approve the request, then the approval is refused
  and names the line (AC-3.4); no account is suggested, and once accounting has chosen any active
  account by hand, the approval is accepted.
- AC-8.5: Given the accounts 7122 "Spese da riaddebitare a WellD Italia" and 2620.1 "Altri debiti
  verso soci - CHF (CH)" when they are active in Accounting, then accounting can choose either on
  any WellD CH line as in AC-3.3, no expense type has either as its default, and no line is given
  either automatically.

## Non-goals

- **WellD Italia accounts and VAT.** Only WellD CH's chart of accounts is in hand; Italian
  lines are reviewed, approved, compiled and paid as today and are left out of the export.
- **Numbering WellD Italia lines approved before this feature.** Only WellD CH lines get a
  receipt number retroactively (AC-7.1); Italian lines are numbered only when approved after
  the release (AC-4.1).
- **Converting reimbursed amounts.** What the employee is paid stays in the line's own currency,
  and the batch PDF and its per-currency subtotals are unchanged. The CHF amount exists only for
  the accounting export and the on-screen VAT amount.
- **Sending the export to Bexio or any accounting system.** This spec produces a file; a direct
  integration is a follow-up.
- **An aggregated export** (one row per account × VAT code). Accounting aggregates on import.
- **New expense types** *(amended 2026-11-19)*. Flight and taxi are added (US-8); the other
  missing categories (lodging 5909, internal meals 6720, software licences 6405, public-transport
  pass contribution 5808) stay a follow-up in docs/refund-accounting-backlog.md.
- **Recharging expenses to WellD Italia or settling debts to a shareholder** (accounts 7122 and
  2620.1) **as dedicated flows** *(amended 2026-11-19)*. The two accounts are now in the list and
  accounting chooses them by hand (AC-8.5); no flow derives them, proposes them or reports on
  them.
- **Receipt numbers that are unique across employees.** Two employees with the same initials
  can hold the same number; the employee's name always goes with it (AC-4.6).
- **Numbering rejected lines, drafts or submitted lines.** Numbers exist only from approval.
- **Showing accounts, VAT or numbers' meaning to employees** beyond the number itself.
- **Importing the 2026 register** (`Recap_RS_2026.numbers`) into Refund. Only one number per
  employee, the last hand-issued one (AC-4.11), is taken from it.
- **Choosing the exchange rate by any date other than the expense date's month.**
- **Editing or deleting a ledger account or VAT code.** Deactivation and reactivation are the
  only changes after creation; a wrong rate means a new code (AC-1.5).
- **A different VAT code per foreign currency.** *(Retired 2026-11-19: there is no
  foreign-currency VAT code; the VAT code is entered by hand on each line.)*
- **Pre-setting a VAT code in any way**, by expense type, currency, country, supplier or
  history: the code is entered by accounting after checking the receipt.
- **Making the VAT code mandatory, or checking it** against the receipt, the rate, the supplier's
  Swiss VAT registration or the reverse-charge rule. Accounting decides; nothing validates it.
- **Carrying VAT in the accounting export.** The accounting system's import cannot read it; the
  VAT code and amount are a reference for manual entry.
- **Reading the VAT code or amount from the receipt (AI receipt scanning).** A future feature
  (backlog item 8, docs/refund-accounting-backlog.md); it will have to handle receipts with
  several VAT rates, which this spec handles only by splitting into lines (AC-3.12).
- **Splitting a multi-rate receipt automatically** or giving a line several VAT codes or a VAT
  breakdown.
- **The former 16-column export, and a CSV or any other format of the export** *(amended
  2026-11-19)*, and any column for batch identifier, km, exchange rate, account name or expense
  type. The batch identifier is traceable through the audit trail (AC-6.10) only. The file is the
  workbook of AC-6.1; no second format, no several sheets, no formulas.
- **Choosing the credit account** per line, per batch or per entity: it is always 5832.
- **Continuing hand-issued numbers of a year other than 2026**, and any check that the numbers
  Refund issues do not collide with other paper numbers beyond the one starting point per
  employee (AC-4.11).
- **Converting test or staging data** that carries the former default VAT codes, the
  foreign-currency VAT code or the former spellings (`IMP81`, `NOVAT`): this feature is not
  released, so production has none; such environments are re-entered.

## Constraints

*Decisions taken with the user on 2026-11-18, captured verbatim for the plan.*

- Accounts and VAT codes cover **only WellD CH** in this spec.
- The accounting export gives the **CHF equivalent** of non-CHF lines; this narrows, for the
  accounting export only, the "no currency conversion" non-goal of specs/20260716-refund-service
  and specs/20260719-refund-monthly-processing, which otherwise stands.
- Monthly average rates are **fetched from an official source**, with manual correction
  possible. *(2026-11-19: the official source is the Swiss Federal Tax Administration, AFC/ESTV.)*
- If a rate is missing, the **export is blocked**; the batch can still be compiled and paid.
- The export has **one row per expense line**.
- The receipt number is **per line, assigned at approval**, formatted as **initials + year of
  the expense date** + per-employee, per-year sequence (`MC26/014`).
- Classification comes **from the expense type's default, and accounting can change it during
  review**, with an audit trail; the employee does not see it. *(2026-11-19: the default is the
  account only; the VAT code is never pre-set.)*
- The CSV export comes first; a Bexio integration comes later. *(2026-11-19: the file is an XLSX
  workbook in the accounting system's template, F1.)*
- Follows the immutable financial audit trail of ADR 20260716-immutable-financial-audit-trail-refund
  and ADR 20260719-refund-batch-audit-trail-extension, and the suite's Italian/English UI copy
  requirement.

*Decisions taken by the owner (Matteo Codogno) on 2026-11-19 after the accountant's answers,
captured verbatim for the plan.*

- The type "Rappresentanza – Regali" is kept, with **no default account**; accounting picks the
  account by hand.
- The VAT code on a line is **optional**: no default, it may stay blank, it never blocks approval
  nor export; it is a reference for the manual entry in the accounting system, because the import
  file cannot carry VAT. **One VAT code per line.**
- For 2026 each employee's receipt sequence **continues after the last number issued by hand in
  the 2026 register**; in 2027 every counter restarts from 1.
- The accounting export is **one journal row per approved WellD CH expense line**: Date
  (`yyyy-mm-dd`), Description, Debit account (the line's ledger account), Credit account (always
  5832 "Rimborso spese effettive"), Amount (CHF equivalent only), Currency (always CHF). The
  accountant's sample file settles the exact format. *(Settled 2026-11-19: see the entry "sync
  with the sample file".)*
- The reference source of the monthly average rates is the **Swiss Federal Tax Administration
  (AFC/ESTV)**, not the customs office.

## Open questions

*Approved by the user on 2026-11-18 with every open question below accepted as risk: the
plan proceeds on the stated fallback in each, and accounting answers them before release.
Answered or decided on 2026-11-19 (accounting sign-off) where marked.*

- [x] Which official source provides the monthly average rates (e.g. the Federal Tax
  Administration's monthly averages), and does its rate match the one the register uses today
  (EUR 0.9246 for March 2026)? — owner: accounting — **answered 2026-11-19: the Swiss Federal Tax
  Administration (AFC/ESTV) monthly averages, not the customs office; EUR 0.9246 for March 2026
  is confirmed.**
- [x] Should each employee's 2026 sequence start after the numbers already issued by hand in the
  register (e.g. `MC26/081`), so numbers do not collide with paper-era receipts? — owner:
  accounting — **decided 2026-11-19 by the owner: yes for 2026 (AC-4.11); in 2027 every counter
  restarts from 1 (AC-4.13). The list of last numbers is a new question below.**
- [x] Separator, decimal mark and encoding the accounting system expects when importing the
  CSV. — owner: accounting — **superseded 2026-11-19: the export is a journal file (US-6), and
  the sample file shows it is a workbook, which has no separator, decimal mark or encoding to
  choose (F1).**
- [x] Initial list of admitted accounts and the default account and VAT code of each of the
  twelve expense types (a draft can be read off the register). — owner: accounting —
  **answered in part 2026-11-19: the changes of E1 to E3 (6701, 6501, 5902, 5903, 7122, 2620.1,
  the VAT codes; no default VAT code at all). The confirmation of the remaining defaults is a new
  question below.**
- [ ] Should changing a line's classification after approval (AC-3.6) be limited to a
  stricter capability than reviewing? — owner: product (Matteo Codogno)
- [x] Which VAT code is the foreign-currency VAT code at release (the register's "no VAT"
  code, whose real name is not known)? — owner: accounting — **closed 2026-11-19: there is no
  foreign-currency VAT code any more; `IP00` is the 0.00 % code and the VAT code may be blank.**
- [x] Confirm amendments A1/A2 and the ACs they added or adjusted — owner: Matteo Codogno — confirmed 2026-11-19 (A2 then superseded the same day, see the amendment of 2026-11-19 (accounting sign-off))
- [x] Decisions on the account for gifts to clients, the optional VAT code, the 2026 receipt
  numbering and the export format — owner: Matteo Codogno — **decided 2026-11-19 (entry in
  Amendments, Constraints)**
- [ ] Which ledger account do gifts to clients ("Rappresentanza – Regali") belong to? Until
  answered the type has no default and accounting picks the account by hand (AC-8.4). — owner:
  accounting
- [x] The accountant's sample file of the import format: header names, column order including
  the position of the Tax column, encoding, formats, line ending, line breaks in the Description
  and the order of the rows. — owner: Matteo Codogno to supply the sample; accounting to confirm
  — **answered 2026-11-19 by the sample file: a workbook, headers `Date | Description | Debit |
  Credit | Amount | Currency | Tax | Note`, Tax before Note, typed date and amount cells, rows by
  Date descending, no line breaks in the Description (F1, F2, F4). Still open, below: the
  Description's maximum length and pattern.**
- [x] The Tax column: present and empty on every row (fallback, AC-6.14) or left out of the
  file? — owner: accounting — **answered 2026-11-19 by the sample file: present and empty, with
  the empty Note column after it (AC-6.14).**
- [ ] The Description: its maximum length in the accounting system, and whether the provisional
  pattern `<reason> [<receipt number>] [<currency> <amount> = CHF <amount>] <name>` of AC-6.13 is
  acceptable (the receipt number is in it because without it a row cannot be traced to the paper
  receipt; the sample's rows were all in CHF and predate receipt numbers). Fallback: the pattern
  as written. — owner: accounting
- [ ] Trial import: does the accounting system (Accrio) accept the golden workbook of the export
  as it is, including a detail the sample does not show (for example whether its table object or
  its cell styles matter)? Needed before release. — owner: accounting
- [ ] Accounts seen in the 2025 template but not in the signed-off list: 5803, 6199, 6305, 6721,
  and a row whose Debit is "2". Which of them are accounts that refunds may be booked to (to add
  to Accounting's WellD CH list), and is the row with "2" an error? Fallback: none is added.
  — owner: accounting
- [ ] The list of each employee's last hand-issued 2026 number from the register (the highest
  sequence per employee, whatever the duplicates `FR26/002` or wrong-year numbers `LG25/…` the
  register holds, and under the initials Refund will use, AC-4.8), needed before the release
  (AC-7.4). An employee not in the list starts at `001` (AC-4.12). Where an employee changed
  email address before filing anything in Refund, the list names the current address too
  (AC-4.11). — owner: accounting
- [ ] Confirm the remaining default accounts of the draft list: km 5905, train 5901, other public
  transport 5904, motorway 5906, parking 5907, office material 6101, stationery 6101, postal 6104,
  telephone 6102. — owner: accounting
- [ ] Reverse charge: the VAT amount of AC-3.8 is computed as VAT contained in the amount, which
  is not what reverse charge (`BZM81`) means. Fallback: the same formula for every code, as a
  reference only, since it is never exported. Should it differ for `BZM81`, or not be shown? —
  owner: accounting
- [ ] Who splits a receipt with several VAT rates into lines (AC-3.12): the employee when entering
  it, or accounting during review (which today cannot add lines)? Fallback: the employee,
  and nothing is enforced. — owner: Matteo Codogno
- [ ] Italian and English labels of the new types flight and taxi (fallback "spese di viaggio
  (aereo)" and "spese di viaggio (taxi)", in the pattern of the paper form) and the English label
  of "Pranzi/cene con clienti". — owner: Matteo Codogno
- [ ] The VAT codes of the 2.6 % and 3.8 % rates (fallback names `IPM26` and `IPM38`): see
  specs/20261119-accounting. — owner: accounting
