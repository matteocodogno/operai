/**
 * strings.disposalReasons — the label of each `DisposalReason` wire value
 * (design.md § Irreversible actions: `lost` is labelled "Written off as lost").
 * Filled by T32 because the detail page's disposal banner (T32) and the dispose
 * dialog (T34) both need it and no task's `touch:` list owned it (reported as
 * drift on T32, as T29 did for `categories`).
 */
export const disposalReasons = {
  sold: 'Sold',
  ceded_to_employee: 'Ceded to an employee',
  scrapped: 'Scrapped',
  returned_to_vendor: 'Returned to the vendor',
  lost: 'Written off as lost',
} as const
