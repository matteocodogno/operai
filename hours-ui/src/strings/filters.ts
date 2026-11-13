/**
 * The Filters card of My hours (T24); Everyone's hours (T29) adds the Person filter's words here.
 * The names of categories and work types are never in this file: they are shown exactly as the
 * administrator typed them, in both languages (AC-3.8).
 */

const pickerMessages = (noun: { none: string; forbidden: string; one: string; many: (n: number) => string }) => ({
  searching: 'Searching…',
  noMatch: noun.none,
  forbidden: noun.forbidden,
  unavailable: 'The search is unavailable. Try again.',
  count: (n: number) => (n === 1 ? noun.one : noun.many(n)),
})

const en = {
  title: 'Filters',
  landmarkLabel: 'Hours filters',
  clear: 'Clear filters',
  period: {
    label: 'Period',
    options: {
      thisWeek: 'This week',
      lastWeek: 'Last week',
      thisMonth: 'This month',
      lastMonth: 'Last month',
      thisYear: 'This year',
      custom: 'Custom range',
    },
  },
  from: 'From',
  to: 'To',
  /** The Custom range's field errors; nothing is sent while one shows. */
  rangeErrors: {
    fromRequired: 'Choose a start date.',
    toRequired: 'Choose an end date.',
    toBeforeFrom: 'The end date cannot be before the start date.',
    tooLong: 'The period cannot be longer than 366 days.',
  },
  project: {
    label: 'Project',
    messages: pickerMessages({
      none: 'No projects match.',
      forbidden: "You can't search projects.",
      one: '1 project',
      many: (n) => `${n} projects`,
    }),
  },
  deal: {
    label: 'Deal',
    messages: pickerMessages({
      none: 'No deals match.',
      forbidden: "You can't search deals.",
      one: '1 deal',
      many: (n) => `${n} deals`,
    }),
  },
  category: {
    label: 'Category',
    any: 'All categories',
    retired: (name: string) => `${name} (retired)`,
  },
  workType: {
    label: 'Work type',
    any: 'All work types',
    projectGroup: 'Project work types',
    dealGroup: 'Deal work types',
    retired: (name: string) => `${name} (retired)`,
  },
  /** The two lists come from one read; while it runs the selects say so, and when it fails the card does. */
  listsLoading: 'Loading…',
  listsError: {
    title: 'Categories and work types could not be loaded',
    body: 'You can still filter by period, project and deal.',
  },
}

const it: typeof en = {
  title: 'Filtri',
  landmarkLabel: 'Filtri delle ore',
  clear: 'Azzera i filtri',
  period: {
    label: 'Periodo',
    options: {
      thisWeek: 'Questa settimana',
      lastWeek: 'Settimana scorsa',
      thisMonth: 'Questo mese',
      lastMonth: 'Mese scorso',
      thisYear: "Quest'anno",
      custom: 'Intervallo personalizzato',
    },
  },
  from: 'Dal',
  to: 'Al',
  rangeErrors: {
    fromRequired: 'Scegli la data di inizio.',
    toRequired: 'Scegli la data di fine.',
    toBeforeFrom: 'La data di fine non può precedere quella di inizio.',
    tooLong: 'Il periodo non può superare 366 giorni.',
  },
  project: {
    label: 'Progetto',
    messages: {
      searching: 'Ricerca in corso…',
      noMatch: 'Nessun progetto corrisponde.',
      forbidden: 'Non puoi cercare i progetti.',
      unavailable: 'La ricerca non è disponibile. Riprova.',
      count: (n: number) => (n === 1 ? '1 progetto' : `${n} progetti`),
    },
  },
  deal: {
    label: 'Opportunità',
    messages: {
      searching: 'Ricerca in corso…',
      noMatch: 'Nessuna opportunità corrisponde.',
      forbidden: 'Non puoi cercare le opportunità.',
      unavailable: 'La ricerca non è disponibile. Riprova.',
      count: (n: number) => (n === 1 ? '1 opportunità' : `${n} opportunità`),
    },
  },
  category: {
    label: 'Categoria',
    any: 'Tutte le categorie',
    retired: (name: string) => `${name} (archiviata)`,
  },
  workType: {
    label: 'Tipo di lavoro',
    any: 'Tutti i tipi di lavoro',
    projectGroup: 'Tipi di lavoro dei progetti',
    dealGroup: 'Tipi di lavoro delle opportunità',
    retired: (name: string) => `${name} (archiviato)`,
  },
  listsLoading: 'Caricamento…',
  listsError: {
    title: 'Impossibile caricare categorie e tipi di lavoro',
    body: 'Puoi comunque filtrare per periodo, progetto e opportunità.',
  },
}

export const filters = { en, it }
