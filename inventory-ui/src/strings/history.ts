/**
 * strings.history — the History section of the asset detail page (T36, specs/015-
 * hardware-inventory; design.md F13, § T2 History, § Accessibility "T2 detail";
 * AC-11.1, AC-11.3, AC-11.4). One label per `AssetEventAction` and per field the
 * typed `changes` carry; an action or field a newer server adds renders as its raw
 * name (the component falls back), so a deploy skew never blanks the timeline.
 * Holder and actor names reuse `strings.assets.holder*`.
 */
export const history = {
  heading: 'History',
  loading: 'Loading history',
  empty: 'No history yet.',
  /** The Retry label of the local error banner. */
  retry: 'Retry',

  /** "Anna Rossi" -> "by Anna Rossi". */
  by: (actor: string) => `by ${actor}`,
  /** A deleted account whose name is still known: "Gone Person (deleted account)". */
  deletedNamed: (name: string) => `${name} (deleted account)`,
  /** The value of a field that was empty before / is empty after. */
  none: 'none',
  yes: 'Yes',
  no: 'No',
  /** One change: "Holder: Anna Rossi → none". */
  change: (field: string, from: string, to: string) => `${field}: ${from} → ${to}`,

  action: {
    registered: 'Registered',
    received: 'Marked as received',
    edited: 'Edited',
    assignment_created: 'Assignment offered',
    assignment_confirmed: 'Assignment confirmed',
    assignment_declined: 'Assignment declined',
    assignment_cancelled: 'Assignment cancelled',
    returned: 'Returned',
    repair_started: 'Sent for repair',
    repair_finished: 'Repair finished',
    marked_lost: 'Marked lost',
    marked_found: 'Marked found',
    disposed: 'Disposed',
    invoice_file_linked: 'Invoice file linked',
    verified: 'Marked as verified',
    fiscal_year_closed: 'Fiscal year closed',
    imported: 'Imported',
  },

  field: {
    holder: 'Holder',
    status: 'Status',
    category: 'Category',
    description: 'Description',
    serialNumber: 'Serial number',
    locationNote: 'Location / note',
    supplier: 'Supplier',
    invoiceRef: 'Invoice reference',
    invoiceFile: 'Invoice file',
    toVerify: 'To verify',
    purchaseDate: 'Purchase date',
    purchasePriceCents: 'Purchase price',
    disposedOn: 'Disposed on',
    reason: 'Reason',
    salePriceCents: 'Sale price',
    year: 'Fiscal year',
  },
} as const
