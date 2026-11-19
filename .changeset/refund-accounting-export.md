---
'@operai/refund-api': minor
'@operai/refund-ui': minor
'@operai/auth': minor
---

Refund books WellD CH expenses for accounting. Every approved WellD CH line gets a ledger account and a VAT code (the expense type's default, changeable line by line until the request is paid), a receipt number such as MC26/001 (the employee's initials, the year of the expense date, a running number), and a CHF amount from the monthly average exchange rate. An administrator sets the default account and VAT code of each expense type and the VAT code for foreign-currency lines in Settings, choosing among the entries kept in Accounting (the Accounting module, see `accounting-module.md`, holds the ledger accounts, the VAT codes and the monthly rates); accounting downloads a CSV of a compiled or paid batch from the batch page. Approval is refused, with the missing values listed, for a line that has no account or VAT code. Auth declares the new `request:reclassify` permission, granted like `request:approve`.

Deploy in this order: auth first (refund-api checks `request:reclassify`, and until auth declares it changing a classification after approval answers 403); the shell with `formatMonth` (the `@operai/ui` changeset) before refund-ui, which shows month names with it; then refund-api, with its migration, together with accounting-api (refund-api needs `ACCOUNTING_INTERNAL_URL` and reads the lists from there; the order and the variables are in `accounting-module.md`). Approvals answer 409 `accounting_release_pending` until `bun run accounting:release` has run once against the refund database, which is after Accounting holds WellD CH's list, so run it right after refund-api is live and Accounting is seeded (`--dry-run` first; `--offsets` only if accounting supplies starting numbers). The script is not in refund-api's Docker image: run it from a checkout, as for `settings:seed` (infra/README.md).

An old batch PDF that is generated again after the stored copy is gone now shows receipt numbers on its lines; the stored copy of a PDF that exists is served unchanged.
