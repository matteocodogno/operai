/**
 * strings.assets — the Assets list (T1) and its filter bar (T29,
 * specs/015-hardware-inventory; design.md § T1, F7 and Resolutions Q5).
 * Message values with `{name}` placeholders go through `fillTemplate`.
 */
export const assets = {
  heading: 'Assets',
  registerAction: 'Register asset',

  filters: {
    landmarkLabel: 'Filter assets',
    search: 'Search',
    searchPlaceholder: 'Description or serial number',
    status: 'Status',
    category: 'Category',
    entity: 'Entity',
    holder: 'Holder',
    toVerify: 'To verify',
    invoiceRef: 'Invoice reference',
    /** The "no selection" option of every select. */
    any: 'Any',
    holderAny: 'Any holder',
    /** A `holderUserId` in the URL that the directory does not list (e.g. a deleted account). */
    holderUnknown: 'Unknown user',
    holderLoading: 'Loading users…',
    clear: 'Clear filters',
  },

  /** Polite line after each change: "Showing 24 assets - more available". */
  shown: (count: number, hasMore: boolean) =>
    `Showing ${count} ${count === 1 ? 'asset' : 'assets'}${hasMore ? ' - more available' : ''}`,
  /** Caption of the table; the page appends the active filters. */
  caption: 'Assets',
  captionFilters: (summary: string) => `Assets, filtered by ${summary}`,
  captionFilterItem: (label: string, value: string) => `${label} ${value}`,
  captionToVerify: 'to verify',
  regionLabel: 'Assets table',

  columns: {
    description: 'Description',
    entity: 'Entity',
    status: 'Status',
    holder: 'Held by',
    purchased: 'Purchased',
    price: 'Price',
    bookValue: 'Book value',
  },
  invoiceRefPrefix: 'invoice',
  toVerifyChip: 'To verify',
  awaitingConfirmation: 'Awaiting confirmation',
  noHolder: '—',
  holderDeleted: 'Deleted account',
  holderUnknown: 'Unknown',
  holderSystem: 'System',
  noBookValue: '—',

  loading: 'Loading assets',
  loadMore: 'Load more',
  loadingMore: 'Loading more…',
  moreLoaded: (count: number) => `${count} more ${count === 1 ? 'asset' : 'assets'} loaded`,

  empty: {
    manager: 'No assets yet.',
    accountant: 'No assets in your scope yet.',
    scopeNote: 'Assets of an entity you are not scoped to are not shown.',
    filtered: 'No assets match these filters.',
    nothingToVerify: 'Nothing left to verify.',
  },

  /** Status line after a registration (state carried from the register page). */
  registered: (count: number) => `${count} ${count === 1 ? 'asset' : 'assets'} registered.`,
} as const
