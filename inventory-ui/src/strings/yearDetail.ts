/**
 * strings.yearDetail — the Fiscal year detail screen, `/years/$entity/$year`, its
 * roll-forward statement, per-asset table and Close year dialog (T38, specs/015-
 * hardware-inventory; design.md T6, F12, § Irreversible actions "Close year",
 * § Error and conflict catalogue; AC-8.1, AC-8.4, AC-8.5, AC-8.7). Templates in
 * `strings.errors` go through `fillTemplate`; money is formatted by the caller
 * with `formatMoney`. The XLSX export's copy is added by T39 under `export`.
 */
export const yearDetail = {
  loading: 'Loading fiscal year',
  retry: 'Retry',
  backToYears: 'Back to fiscal years',
  heading: (year: number) => `Fiscal year ${year}`,
  status: { open: 'Open', closed: 'Closed' },
  /** The polite line after a successful close. */
  closedAnnouncement: (year: number) => `Fiscal year ${year} is closed.`,

  notFound: {
    heading: 'Fiscal year not found',
    body: 'This fiscal year does not exist, comes before the first year of this entity, or is outside your entity scope.',
  },

  provisional: 'Provisional: figures change until this year is closed.',
  /** A closed year: no close or reopen control exists anywhere (AC-8.7). The contract carries no "closed by". */
  closedOn: (date: string) => `Closed on ${date}.`,

  close: {
    button: (year: number) => `Close year ${year}`,
    /** The reason an unavailable Close button points at (AC-8.5). */
    blocked: (previousYear: number) => `Close ${previousYear} first.`,
  },

  statement: {
    heading: (currency: string) => `Roll-forward (${currency})`,
    caption: (entity: string, year: number, currency: string) =>
      `Roll-forward of fiscal year ${year} for ${entity}, in ${currency}`,
    columns: { line: 'Line', amount: 'Amount' },
    /** Word + sign: a lone sign is unreliable for a screen reader, so the word is the accessible name. */
    lines: {
      opening: { sign: '', label: 'Opening book value' },
      disposals: { sign: '−', label: 'Less disposals' },
      purchases: { sign: '+', label: 'Plus purchases' },
      depreciation: { sign: '−', label: 'Less depreciation' },
      closing: { sign: '=', label: 'Closing book value' },
    },
  },

  assets: {
    heading: 'Assets',
    caption: (entity: string, year: number) => `Per-asset figures for fiscal year ${year}, ${entity}`,
    empty: 'No assets in this year',
    columns: {
      purchaseDate: 'Purchase date',
      description: 'Description',
      serialNumber: 'Serial number',
      heldBy: 'Held by',
      purchasePrice: 'Purchase price',
      opening: 'Opening',
      purchases: 'Purchases',
      depreciation: 'Depreciation',
      disposals: 'Disposals',
      closing: 'Closing',
    },
    noSerial: '—',
    noHolder: '—',
    holderSystem: 'System',
    holderDeleted: 'Deleted account',
    holderUnknown: 'Unknown',
  },

  /** The XLSX export (T39; design.md F12 step 5, § Accessibility "T6 year detail"; AC-8.8, AC-8.9). */
  export: {
    button: 'Export XLSX',
    /** Polite status while the file is built (the button is `aria-busy`). */
    preparing: 'Preparing file…',
    /** Polite status once the browser has been handed the file. */
    ready: 'File ready',
    /** Alert when the file could not be built or handed over. */
    failed: 'The export could not be prepared. Try again.',
    /** Appended to the file name of an open year, so a provisional file is never mistaken for the final one. */
    fileProvisionalSuffix: 'provisional',
    sheetName: (year: number) => `Fiscal year ${year}`,
    title: (entity: string, year: number, currency: string) => `Fiscal year ${year} - ${entity} (${currency})`,
    /** The mark in the sheet of an open year; a closed year has none. */
    provisional: 'PROVISIONAL: figures change until this year is closed.',
    /** One row per asset (AC-8.8); amounts are in the entity currency, in major units. */
    columns: {
      purchaseDate: 'Purchase date',
      description: 'Description',
      serialNumber: 'Serial number',
      holder: 'Holder',
      purchasePrice: (currency: string) => `Purchase price (${currency})`,
      depreciation: (currency: string) => `Depreciation for the year (${currency})`,
      bookValue: (currency: string) => `Book value at year end (${currency})`,
    },
    rollForwardHeading: (currency: string) => `Roll-forward (${currency})`,
  },

  closeDialog: {
    title: (year: number) => `Close fiscal year ${year}?`,
    /** The consequence after the five lines. */
    consequence: (year: number, entity: string) =>
      `Closing ${year} for ${entity} freezes this statement and every asset's figures. Nothing dated in ${year} or earlier can be changed afterwards: no new assets, edits, disposals or rules. A closed year can never be reopened; corrections are booked in the open year.`,
    acknowledge: 'I understand a closed year cannot be reopened.',
    confirm: (year: number) => `Close ${year}`,
    confirming: 'Closing…',
    guardrailTitle: 'Already closed',
    guardrailAcknowledge: 'OK',
  },
} as const
