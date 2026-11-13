/**
 * The Totals card of My hours (T24); Everyone's hours (T29) adds Person as a grouping (the words for a
 * person's name are in `everyone`). Group names that come from the data (a project, a deal, a category, as the viewer may read them) are never in this file:
 * they are shown exactly as the server sends them (AC-3.8).
 */

const en = {
  title: 'Totals',
  total: 'Total',
  groupBy: {
    label: 'Group by',
    person: 'Person',
    project: 'Project',
    deal: 'Deal',
    category: 'Category',
    month: 'Month',
  },
  /** The table's caption names the grouping (screen readers read it). */
  caption: {
    person: 'Hours by person',
    project: 'Hours by project',
    deal: 'Hours by deal',
    category: 'Hours by category',
    month: 'Hours by month',
  },
  columnTime: 'Time',
  loading: 'Loading totals…',
  /** Read politely when the totals arrive; the figure is in the `spoken` style ("2 hours, 30 minutes"). */
  announce: (spokenTotal: string) => `${spokenTotal} in total`,
  announceEmpty: 'No entries match',
  empty: 'Nothing to total.',
  /** A Custom range that cannot be sent: the card says why nothing is shown, the date fields say what. */
  invalidPeriod: 'Choose a valid period to see the totals.',
  error: {
    title: 'Totals could not be loaded',
    body: 'Try again in a moment.',
  },
  /**
   * The merged rows (design S1 "Names the viewer cannot read"): what the viewer may not read, or whose
   * owner did not answer, is ONE row each, however many items it holds.
   */
  rows: {
    project: {
      hidden: 'Projects not visible to you',
      unavailable: 'Projects whose name is unavailable',
      none: 'Not on a project',
    },
    deal: {
      hidden: 'Deals not visible to you',
      unavailable: 'Deals whose name is unavailable',
      dealUnknown: 'Meetings whose deal is unknown right now',
      none: 'Not on a deal',
    },
    category: {
      none: 'On a project, deal or meeting',
    },
    /** A group this build has no words for (a server one step ahead), so the hours still show. */
    other: 'Other hours',
  },
  /** A named group whose name did not come (the plan always sends one; this keeps the row readable). */
  nameUnavailable: 'Name unavailable',
  retired: (name: string) => `${name} (retired)`,
}

const it: typeof en = {
  title: 'Totali',
  total: 'Totale',
  groupBy: {
    label: 'Raggruppa per',
    person: 'Persona',
    project: 'Progetto',
    deal: 'Opportunità',
    category: 'Categoria',
    month: 'Mese',
  },
  caption: {
    person: 'Ore per persona',
    project: 'Ore per progetto',
    deal: 'Ore per opportunità',
    category: 'Ore per categoria',
    month: 'Ore per mese',
  },
  columnTime: 'Tempo',
  loading: 'Caricamento dei totali…',
  announce: (spokenTotal: string) => `${spokenTotal} in totale`,
  announceEmpty: 'Nessuna registrazione corrisponde',
  empty: 'Niente da sommare.',
  invalidPeriod: 'Scegli un periodo valido per vedere i totali.',
  error: {
    title: 'Impossibile caricare i totali',
    body: 'Riprova tra un momento.',
  },
  rows: {
    project: {
      hidden: 'Progetti non visibili a te',
      unavailable: 'Progetti il cui nome non è disponibile',
      none: 'Non su un progetto',
    },
    deal: {
      hidden: 'Opportunità non visibili a te',
      unavailable: 'Opportunità il cui nome non è disponibile',
      dealUnknown: 'Riunioni la cui opportunità al momento non è nota',
      none: "Non su un'opportunità",
    },
    category: {
      none: "Su un progetto, un'opportunità o una riunione",
    },
    other: 'Altre ore',
  },
  nameUnavailable: 'Nome non disponibile',
  retired: (name: string) => `${name} (archiviata)`,
}

export const totals = { en, it }
