# 20261118 — The accounting export is generated on request and never stored, every download is logged append-only with its content hash and format version before the file leaves, and the CSV dialect lives in one module

**Date:** 2026-11-18  
**Status:** Accepted — approved plan of specs/20261118-refund-accounting-export (approved 2026-11-18 under the owner's pre-authorisation of an unattended run; review on the owner's return); decisions D3 and D8 of the plan. Plan ADR candidate 5. **The dialect values (separator, decimal mark, encoding, headers) are a provisional default** awaiting accounting's answer (spec open question 3); the structure of the decision does not depend on them.  
**Deciders:** Matteo Codogno (product owner), by pre-authorisation of the unattended run; the architect proposed it in the plan  
**Project:** operai  
**Relates to:** ADR 20260719-refund-batch-pdf-generation-pdf-lib (pure, deterministic rendering), ADR 20260716-immutable-financial-audit-trail-refund (append-only logs), ADR 20260716-entity-scoped-abac-refund-api (scope), ADR 20261118-chf-and-vat-amounts-are-derived-on-read-from-integer-micros-and-basis-points-rounded-once-half-up-and-never-stored (why the file can change between two downloads).

---

## Context

A compiled or paid batch must leave Refund as a CSV that accounting imports into WellD CH's books (AC-6.1 to AC-6.12): one row per approved, non-rejected WellD CH line, with employee, receipt number, CHF amount, account, VAT code and VAT amount. WellD Italia lines are left out and counted. The file contains personal and financial data (names, reasons, amounts) and is the basis of bookkeeping entries, yet the amounts in it are derived on read, so the same batch can export different content after a rate correction (AC-6.8). The reason text and names are typed by employees and will be opened in a spreadsheet. The target system's CSV dialect is not known (open question 3). The batch PDF already exists as a pure, deterministic output (ADR 20260719-refund-batch-pdf-generation-pdf-lib), but a CSV for books is a different artefact: it leaves the system and is acted on elsewhere.

## Decision

We will generate the CSV **on request** from current data, never store it, write an append-only `refund_batch_export` row (actor, batch, row count, excluded count, SHA-256 of the bytes, format version) **before** the body is returned, refuse the download when anything blocks, and keep every dialect choice in one module.

1. **Generated, not stored.** `GET /batches/{id}/accounting-export/csv` recomputes the rows, so the file always agrees with the current classification and rates. The file is small, so there is no object-storage copy to go stale or to leak.
2. **Logged before delivery, as proof of what left.** The log row is written first; if that write fails the answer is 500 and no file is sent. A download writes a row; the summary route (`GET …/accounting-export`) writes none (AC-6.10). The row stores the hash, so two downloads of one batch with different content are visible (R9).
3. **Deterministic bytes.** Rows are sorted by employee name (code-point order, not locale), then `ownerUserId`, `receiptYear`, `receiptSeq` and line id; there is no timestamp or random value in the file; the filename is `refund-accounting-<cutoff date>-<batchId>.csv` and carries no personal data. Same data gives the same bytes and the same hash (AC-6.8).
4. **All-or-nothing.** If any blocker exists (a missing rate, an unclassified line, an unnumbered line), the route answers 409 `accounting_export_blocked` with the blockers; there is no partial file. A `discarded` batch answers 409 `batch_discarded` (AC-6.9). A batch with no WellD CH line yields a file with the header row only (AC-6.7).
5. **One module for the dialect.** `exportFormat.ts` holds separator (`;`), decimal mark (`.`), encoding (UTF-8 with BOM), line ending (CRLF), date format (ISO), header labels (English) and `FORMAT_VERSION = 1`. Changing the dialect is a constants edit plus a version bump, shown in the log and checked by a golden-file test (R4).
6. **Text is data, not formulas.** Every text cell beginning with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'`; quoting follows RFC 4180 (a field with `;`, `"`, CR or LF, or a leading or trailing space, is quoted and `"` doubled). The guard sits in `export.ts` over every text column, not per field.
7. **Narrower scope than batch reads.** Besides `request:review`, the caller's scope must cover `welld_ch` (global, or entity = `welld_ch`), else 403 `accounting_export_out_of_scope` (D8, AC-6.11). Batch reads stay unscoped; the export is WellD CH's books.
8. **A missing rate gets one bounded attempt** to fetch before the blockers are computed (ADR 20261118-monthly-exchange-rates-are-fetched-on-demand-from-the-federal-source-recorded-once-and-corrected-only-by-an-admin-never-by-a-scheduler-and-the-outbound-fetch-is-hardened); a failure is a blocker, never a 5xx.

## Failure shape

**Data leaves the system and is acted upon elsewhere, and either nobody can later say exactly what left, or the receiver treats part of the data as instructions.** The first: a discrepancy in the books weeks later cannot be traced because the file was not kept, its content depended on state that has since moved, and the record of the download is missing or was written after delivery. The second: a name or a free-text reason that begins with `=` becomes a formula in the spreadsheet that opens it, so data typed by one person runs as code for another. Both are properties of the boundary, not of the file format.

Where else this shape can appear, including the mirror-image positions:

- **Export and import.** The mirror of "our data becomes their instruction" is "their file becomes our instruction". A future import of a CSV must treat every cell as data, and must know that this export prefixes some text with `'`. The guard is part of the format, so it is part of the format version.
- **Log before and after.** An audit row written after the response can be lost with the process, leaving a delivered file with no record. The rule is: record, then deliver; a failed record means no delivery. The same order holds for any outbound send, print or hand-off that matters later.
- **Other outbound artefacts.** Any new report, PDF or feed built from the same rows (a payroll file, a VAT return) carries personal and financial data across the same boundary and needs the same three answers: who may pull it (scope, not just capability), what proves what was delivered, and whether any text cell can be read as an instruction by its consumer.
- **Whole and part.** A file with some rows silently left out because they could not be computed looks complete. Exclusions must be counted and shown (the Italia lines), and blockers must stop the file.
- **Stored and generated.** Storing the delivered file solves "what left" but creates a second copy of personal data with its own retention and a risk of serving a stale one; generating it needs the hash instead. The choice must be made explicitly for every export.
- **Format drift.** A dialect change that is not versioned changes what "the same export" means. Header labels, separators and the date format are part of the contract with the receiver.
- **Capability and scope.** A capability that lets one person act on every entity's batches must be narrowed when the output belongs to one entity; check both the verb and the object.

## Options considered

### Option A — Generate on request, log hash and version before delivery, one dialect module (chosen)

Described above.

**Pros:**
- Always consistent with corrections; no copy of personal data at rest
- The log proves what was delivered, by hash, even when the file is not kept
- A dialect change is one deliberate diff, and the golden-file test shows it
- The injection guard cannot be forgotten for a new column, because it applies to every text cell

**Cons:**
- A downloaded file cannot be retrieved from the system later; re-generation can differ after a correction (the log shows it)
- The log row is written even when the download fails on the network after delivery began (accepted: it proves the system produced it, not that the client received it)
- A leading `'` in a name or reason is visible in the spreadsheet cell

### Option B — Store the generated CSV in the bucket at first download (rejected)

**Pros:**
- A fixed artefact per batch that can be re-served

**Cons:**
- A second copy of personal data to retain and protect; it goes stale when a rate or classification is corrected, and then either lies or needs invalidation rules

### Option C — Log after the response, or log only on success of delivery (rejected)

**Pros:**
- No failure path in the request

**Cons:**
- A delivered file may have no record; the rule must be "record, then deliver"

### Option D — A partial file with the blocked lines marked (rejected)

**Pros:**
- Accounting gets something

**Cons:**
- A file that looks complete but is not, imported into books; the blockers are a short list the user can resolve

### Option E — Per-field injection guards, or none because the file is internal (rejected)

**Pros:**
- No visible `'`

**Cons:**
- Every future column would need remembering, and names and reasons are typed by employees and opened in a spreadsheet by accounting

### Option F — Dialect constants spread over the code (rejected)

**Pros:**
- Nothing to build

**Cons:**
- Open question 3 will change them; one place makes that a small, versioned change

## Evidence

- Pattern: ADR 20260719-refund-batch-pdf-generation-pdf-lib (a pure renderer fed all its inputs); append-only log with immutability trigger as in ADR 20260716-immutable-financial-audit-trail-refund.
- Planned, not yet run (plan, Test strategy, AC-6.1 to AC-6.12, Security surfaces 1 and 2): a golden CSV compared byte for byte (header, order, quoting, BOM, CRLF); export twice gives identical bytes and hashes, and a rate correction gives a different hash; compiled and paid batches export, a discarded one answers 409 on both routes; blockers answer 409 with the list while compile, mark-paid and discard still succeed; a batch with only Italia or rejected lines gives the header only and the right `excludedLineCount`; a download writes a `refund_batch_export` row and a summary writes none; immutability of that table; a `welld_it`-scoped reviewer gets 403 `accounting_export_out_of_scope`; and unit tests of the guard on `= + - @`, TAB and CR. A test that a failing log write returns 500 with no body is not in the plan's table yet and should be added with the route. The `owasp-reviewer` pass is required (plan, Security).

## Consequences

**Positive:**
- Every file that left has an actor, a time, a row count and a hash on record, and none of the file's content is kept
- Accounting cannot import a half-computed file
- Changing to the real dialect is a one-module change

**Negative / trade-offs:**
- The dialect may need a second iteration once accounting answers; imports done with `formatVersion 1` stay valid by their log row
- Extra scope check on the export, so a WellD Italia-scoped accountant cannot export (intended)

**Risks:**
- **CSV dialect wrong for the accounting system** (R4, open question 3). Mitigation: one module, versioned, golden-file test.
- **Re-export differs after a correction** (R9). Mitigation: allowed by AC-6.8; the hash shows it.
- **Personal data in a downloaded file** that the system no longer controls. Mitigation: scope check, capability, no PII in the filename or logs (the request logger records the path only).
- **Outbound fetch inside the export request** (R10). Mitigation: bounded; see the FX ADR.

## Escalation triggers

This decision is revisited when any of these happens:

- accounting answers open question 3 (change `exportFormat.ts`, bump `FORMAT_VERSION`, record the version in the next ADR amendment);
- someone needs to re-download the exact bytes of an earlier export (then store the file, with a retention rule, and keep the hash as a check);
- a second export (another entity, another format, another system) is built: promote the dialect module and the injection guard to a shared helper, and apply the three answers above;
- the file is ever imported back or sent automatically instead of downloaded by a person.

## Compliance notes

- GDPR / data-protection impact: medium. The file carries employees' names, free-text reasons and amounts to a role that already sees them, outside the system's control once downloaded. Mitigations: capability plus entity scope, no PII in the filename or logs, a log row per download (actor, time, hash) and no stored copy. Purpose: bookkeeping of reimbursed expenses.
- Data residency: no change for the generating service (EU region); once downloaded, the file is in the hands of the accounting team. Needs review if the accounting system is hosted outside the EU.
- Audit trail: required (AC-6.10). Tier 1: `refund_batch_export` is append-only by trigger.

---

*This ADR was generated during a WellForge spec-driven session. Review and amend before committing.*
