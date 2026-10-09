/**
 * strings.ledger — the Ledger block of the asset detail page, its schedule table
 * and the Dispose dialog (T34, specs/015-hardware-inventory; design.md § T2
 * ledger region, F9, F10, § Irreversible actions, § Error and conflict
 * catalogue). Templates with `{name}` placeholders go through `fillTemplate`;
 * money is always formatted by the caller with `formatMoney`.
 */
export const ledger = {
  heading: 'Ledger',

  bookValue: 'Book value today',
  /** "In force from 01.01.2026". */
  ruleEffective: (date: string) => `In force from ${date}`,
  /** "Rule applied: life 3 y, full first year, no threshold, residual 1,00 CHF". */
  ruleApplied: (years: number, share: string, threshold: string, residual: string) =>
    `Rule applied: life ${years} y, ${share}, ${threshold}, residual ${residual}`,
  firstYearShare: { full: 'full first year', half: 'half first year' },
  noThreshold: 'no threshold',
  threshold: (amount: string) => `threshold ${amount}`,

  schedule: {
    caption: 'Depreciation schedule',
    regionLabel: 'Depreciation schedule table',
    columns: {
      year: 'Year',
      depreciation: 'Depreciation',
      bookValue: 'Book value at year end',
      state: 'State',
    },
    closed: 'Closed',
    open: 'Open',
    /** The last row of a disposed asset: "Disposed 01.10.2026". */
    disposedRow: (date: string) => `Disposed ${date}`,
    disposedState: 'Disposed',
    noDepreciation: '—',
  },

  disposal: {
    heading: 'Disposal',
    date: 'Disposed on',
    reason: 'Reason',
    salePrice: 'Sale price',
  },

  dispose: {
    action: 'Dispose...',
    /** Why Dispose is not available; `aria-describedby` target. */
    pendingReason: (name: string) =>
      `Cancel the pending assignment to ${name} first. Only an inventory manager can do that.`,
    /** Who the reason names when the assignee has no display name. */
    assigneeFallback: 'the selected person',
    done: 'Asset disposed.',
    conflictTitle: 'This asset changed',

    dialog: {
      title: (description: string) => `Dispose of ${description}?`,
      /** The consequence, without the holder sentence. */
      consequence: (description: string, entity: string, date: string, bookValue: string) =>
        `${description} comes off ${entity}'s books on ${date}. Its book value becomes ${bookValue}, and it can no longer be assigned, repaired or edited. This cannot be undone.`,
      /** The consequence when the asset has a holder. */
      consequenceWithHolder: (description: string, entity: string, date: string, bookValue: string, holder: string) =>
        `${description} comes off ${entity}'s books on ${date}. Its book value becomes ${bookValue}, it is removed from ${holder}, and it can no longer be assigned, repaired or edited. This cannot be undone.`,
      /** The date is not chosen yet (or invalid): the consequence names no date. */
      dateUnset: 'the chosen date',
      acknowledge: 'I understand this cannot be undone.',
      confirm: 'Dispose asset',
      confirming: 'Disposing…',
      fields: {
        date: 'Disposal date',
        reason: 'Reason',
        /** The currency is part of the label: "Sale price, CHF". */
        salePriceIn: (currency: string) => `Sale price, ${currency}`,
        optional: 'optional',
      },
      errors: {
        dateRequired: 'Enter the disposal date.',
        reasonRequired: 'Choose a reason.',
        salePriceInvalid: 'Enter a price of 0 or more, with at most two decimals.',
        /** `fiscal_year_closed` when the server sent no year. */
        yearClosedNoYear: 'The disposal date falls in a closed year. Choose a date in an open year.',
      },
    },
  },
} as const
