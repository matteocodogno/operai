/**
 * strings.errors — one message per API Problem JSON `code` (the list is
 * `INVENTORY_ERROR_CODES` in lib/types.ts; a test asserts there is no gap) plus
 * the status-only failures of design.md § Error and conflict catalogue.
 *
 * A message with a `{name}` placeholder is a template: fill it with
 * `fillTemplate`. The values are the typed extras the plan documents for that
 * code (`serialNumber`, `year`, `from`) or page context (`entity`, `name`,
 * `date`, `asset`, `n`). Templates are plain strings, not functions, so that
 * the whole catalogue stays data a test can walk.
 */

/** Replaces each `{key}` with its value; a key with no value stays visible rather than printing "undefined". */
export const fillTemplate = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = values[key]
    return value === undefined ? placeholder : String(value)
  })

export const errors = {
  // --- API codes (INVENTORY_ERROR_CODES) -----------------------------------
  serial_count_mismatch: 'Enter one serial number per unit, or leave the serial numbers empty.',
  serial_conflict: 'Serial number {serialNumber} is already used by an active asset of this entity.',
  fiscal_year_closed: '{year} is closed for {entity}. Choose a date in an open year.',
  invalid_transition: 'This asset is now {from}; someone else changed it. The page has been refreshed.',
  assignment_pending: 'This asset has a pending assignment to {name}. Cancel it first.',
  asset_disposed: 'This asset has been disposed of and can no longer be changed.',
  assignment_not_pending: 'This assignment is no longer open.',
  unknown_user: 'That person can no longer receive devices.',
  disposed_before_purchase: 'The disposal date cannot be before the purchase date ({date}).',
  sale_price_not_allowed: 'A sale price can only be recorded when the asset is sold. Change the reason or clear the price.',
  previous_year_open: 'Close {year} first.',
  already_closed: '{year} is already closed.',
  nothing_to_close: '{year} has no assets to close.',
  invoice_ref_mismatch: '{asset} has a different invoice reference and was not linked.',
  upload_not_found: 'The upload did not complete. Try again.',

  // --- Variants of a code, by where it is shown -----------------------------
  /** `fiscal_year_closed` on the edit dialog's price / purchase date: a banner, not a field error. */
  fiscal_year_closed_edit: 'Price and purchase date cannot change because {year} is closed.',

  // --- Status-only failures (no `code`) --------------------------------------
  validation: 'Check the highlighted fields and try again.',
  tooLarge: 'This file is larger than 10 MiB.',
  unsupportedType: 'Only PDF, JPEG or PNG files can be uploaded.',
  tooManyLookups: 'Too many lookups. Try again in {n} seconds.',
  tooManyLookupsNoDelay: 'Too many lookups. Try again shortly.',
  network: 'Could not reach the server. Check your connection and try again.',
  unknown: 'Something went wrong. Try again.',
} as const
