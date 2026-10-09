/**
 * strings.rules — the Depreciation rules screen and the New rule dialog (T37,
 * specs/015-hardware-inventory; design.md T4, F11, § Irreversible actions "New
 * rule", § Error and conflict catalogue; AC-6.1 to AC-6.5). Templates with
 * `{name}` placeholders in `strings.errors` go through `fillTemplate`; money is
 * formatted by the caller with `formatMoney`.
 */
export const rules = {
  heading: 'Depreciation rules',
  loading: 'Loading depreciation rules',
  /** The page's h3 per entity: "Rules for WellD CH". */
  sectionHeading: (entity: string) => `Rules for ${entity}`,
  sectionLoading: (entity: string) => `Loading rules for ${entity}`,
  /** The table caption, also the scroll region's label. */
  caption: (entity: string) => `Depreciation rules for ${entity}`,
  /** The launch seed makes this unreachable; kept for safety. */
  empty: (entity: string) => `No rule is configured for ${entity}.`,
  /** `GET /scope` lists no entity for `ledger:manage`. */
  noEntity: 'No entity is in your scope for depreciation rules. Ask an administrator.',
  retry: 'Retry',

  /** The button names its entity so the two are distinguishable out of context. */
  newRule: (entity: string) => `New rule for ${entity}`,
  /** The polite line after a rule is saved. */
  added: (date: string) => `Rule added. It applies to purchases from ${date}.`,

  columns: {
    effectiveFrom: 'Effective from',
    usefulLife: 'Useful life (years)',
    firstYearShare: 'First-year share',
    threshold: 'Low-value threshold',
    residual: 'Residual value',
    addedBy: 'Added by',
    addedOn: 'Added on',
    status: 'Status',
  },
  firstYearShare: { full: 'Full', half: 'Half' },
  noThreshold: 'None',

  status: {
    inForce: 'In force',
    scheduled: 'Scheduled',
    superseded: 'Superseded',
  },

  dialog: {
    title: (entity: string) => `New depreciation rule for ${entity}`,
    /** "Rule in force: life 3 y, full first year, no threshold, residual 1,00 CHF (since 01.01.2020)". */
    inForce: (summary: string, since: string) => `Rule in force: ${summary} (since ${since})`,
    inForceShare: { full: 'full first year', half: 'half first year' },
    inForceNoThreshold: 'no threshold',
    inForceThreshold: (amount: string) => `threshold ${amount}`,
    inForceSummary: (years: number, share: string, threshold: string, residual: string) =>
      `life ${years} y, ${share}, ${threshold}, residual ${residual}`,
    /** The consequence: assets purchased on or after the date are rescheduled. */
    consequence: (entity: string, date: string) =>
      `From ${date}, every ${entity} asset purchased on or after ${date}, including assets already registered, is scheduled by this rule. Assets purchased earlier keep their schedule. A saved rule cannot be edited or deleted; a correction is a new rule.`,
    dateUnset: 'the effective date',
    acknowledge: 'I understand this rule cannot be changed afterwards.',
    confirm: 'Add rule',
    confirming: 'Adding…',
    required: 'required',
    optional: 'optional',
    fields: {
      effectiveFrom: 'Effective from',
      usefulLife: 'Useful life (years)',
      firstYearShare: 'First-year share',
      thresholdIn: (currency: string) => `Low-value threshold, ${currency}`,
      residualIn: (currency: string) => `Residual value, ${currency}`,
    },
    errors: {
      dateRequired: 'Enter the effective date.',
      dateInvalid: 'Enter a valid effective date.',
      lifeInvalid: 'Useful life must be a whole number of at least 1 year.',
      shareRequired: 'Choose the first-year share.',
      thresholdInvalid: 'Enter a threshold of 0 or more, with at most two decimals, or leave it empty.',
      residualInvalid: 'Enter a residual value of 0 or more, with at most two decimals.',
      /** `fiscal_year_closed` when the server sent no year. */
      yearClosedNoYear: 'The effective date falls in a closed year. Choose a date in an open year.',
    },
  },
} as const
