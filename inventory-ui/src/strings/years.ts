/**
 * strings.years — the Fiscal years list screen, `/years` (T38, specs/015-hardware-
 * inventory; design.md T5, F12; AC-8.1). The year detail, the roll-forward
 * statement and the Close year dialog keep their copy in `yearDetail.ts`.
 */
export const years = {
  heading: 'Fiscal years',
  loading: 'Loading fiscal years',
  /** The page's h3 per entity: "Fiscal years for WellD CH". */
  sectionHeading: (entity: string) => `Fiscal years for ${entity}`,
  sectionLoading: (entity: string) => `Loading fiscal years for ${entity}`,
  /** The table caption, also the scroll region's label. */
  caption: (entity: string) => `Fiscal years for ${entity}, newest first`,
  empty: (entity: string) => `No fiscal years yet. A year appears once ${entity} has assets.`,
  /** `GET /scope` lists no entity for `ledger:manage`. */
  noEntity: 'No entity is in your scope for fiscal years. Ask an administrator.',
  retry: 'Retry',

  columns: {
    year: 'Year',
    status: 'Status',
    closedOn: 'Closed on',
    open: 'Details',
  },
  status: { open: 'Open', closed: 'Closed' },
  notClosed: '—',
  /** The row's link: visible text "Open", named with the year and entity out of context. */
  openLink: 'Open',
  openLinkLabel: (year: number, entity: string) => `Open fiscal year ${year} for ${entity}`,
} as const
