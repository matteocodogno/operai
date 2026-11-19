/**
 * The entries by day on My hours (T25; design S1 "Entries", F4): the card, a row, a day's total, Load more,
 * the banners that say what a source or a permission left out, and the deal-filter-unavailable state
 * (AC-4.11), which Everyone's hours (T29) shows with the same words. The words for a name the viewer cannot
 * read are in `names.ts`, shared with the export.
 */

const en = {
  title: 'Entries',
  loading: 'Loading your hours…',
  /** No filter is applied: nothing was recorded in the period (the page header has the action). */
  empty: {
    title: 'No hours recorded in this period',
    body: 'Record the hours you worked and they appear here, by day.',
  },
  /** A filter is applied: "Clear filters" is `strings.filters.clear`. */
  emptyFiltered: {
    title: 'No entries match these filters',
    body: 'Change or clear the filters to see more.',
  },
  error: {
    title: 'Your hours could not be loaded',
    body: 'Try again in a moment.',
  },
  /** A Custom range that cannot be sent: nothing was asked, and the date fields say why. */
  invalidPeriod: 'Choose a valid period to see your entries.',
  /** The label of the list of one day: "Entries on 12 November 2026". */
  dayList: (date: string) => `Entries on ${date}`,
  dayTotal: 'Day total',
  /** The day totals are a separate read: when it fails the list stays and the headings show no total. */
  dayTotalsError: 'Day totals could not be loaded.',
  /** The kind of work a row is on (a neutral badge, always shown, even when the name is withheld). */
  type: {
    project: 'Project',
    deal: 'Deal',
    meeting: 'Meeting',
    none: 'Other work',
  },
  /** How an entry is named in the Edit and Delete buttons when the viewer cannot read its name. */
  onPhrase: {
    project: { hidden: 'a project not visible to you', unavailable: 'a project whose name is unavailable' },
    deal: { hidden: 'a deal not visible to you', unavailable: 'a deal whose name is unavailable' },
    meeting: { hidden: 'a meeting not visible to you', unavailable: 'a meeting whose name is unavailable' },
    none: (category: string) => `other work (${category})`,
  },
  edit: 'Edit',
  /** `aria-label`s that name the entry: "Edit 4 h on Project Alpha, 12.11.2026". */
  editEntry: (duration: string, on: string, date: string) => `Edit ${duration} on ${on}, ${date}`,
  deleteEntry: (duration: string, on: string, date: string) => `Delete ${duration} on ${on}, ${date}`,
  loadMore: 'Load more',
  loadingMore: 'Loading more…',
  /** Polite, after a page arrives; the running count makes two equal pages read differently. */
  loadedMore: (added: number, shown: number) => `${added} more entries loaded, ${shown} shown`,
  loadMoreError: 'More entries could not be loaded. Try again.',
  /** A name that was "retired" from the lists, kept on the entries that carry it (AC-3.4). */
  retired: (name: string) => `${name} (retired)`,
  banners: {
    /** One persistent note when a source did not answer; `sources` is the list in words (`names.sources`). */
    unavailable: (sources: string) =>
      `Hours are complete; these names could not be loaded and show as unavailable: ${sources}.`,
    /** Grouping by deal while the meeting → deal link did not answer. */
    dealGrouping:
      "Meeting hours can't be placed under their deal right now, so they are shown in one separate row. The total is unchanged.",
    /** A standing fact, not news: read in place, never announced. */
    hidden: {
      label: 'Entries without a visible name',
      body: "Some entries are on a project, deal or meeting you can't open, so they show without a name. Their hours are still counted.",
    },
  },
  /** AC-4.11: Meetings cannot say which meetings belong to the filtered deal, so nothing is shown. */
  dealFilterUnavailable: {
    title: "Hours on this deal can't be shown right now",
    body: 'Operai could not check which meetings belong to this deal, so a list or total would be incomplete. Nothing is shown until it can. Try again in a moment.',
    clear: 'Clear the deal filter',
  },
}

const it: typeof en = {
  title: 'Registrazioni',
  loading: 'Caricamento delle tue ore…',
  empty: {
    title: 'Nessuna ora registrata in questo periodo',
    body: 'Registra le ore lavorate e compaiono qui, giorno per giorno.',
  },
  emptyFiltered: {
    title: 'Nessuna registrazione corrisponde a questi filtri',
    body: 'Modifica o rimuovi i filtri per vederne di più.',
  },
  error: {
    title: 'Impossibile caricare le tue ore',
    body: 'Riprova tra un momento.',
  },
  invalidPeriod: 'Scegli un periodo valido per vedere le tue registrazioni.',
  dayList: (date: string) => `Registrazioni del ${date}`,
  dayTotal: 'Totale del giorno',
  dayTotalsError: 'Impossibile caricare i totali dei giorni.',
  type: {
    project: 'Progetto',
    deal: 'Opportunità',
    meeting: 'Riunione',
    none: 'Altro lavoro',
  },
  onPhrase: {
    project: { hidden: 'un progetto non visibile a te', unavailable: 'un progetto il cui nome non è disponibile' },
    deal: {
      hidden: "un'opportunità non visibile a te",
      unavailable: "un'opportunità il cui nome non è disponibile",
    },
    meeting: { hidden: 'una riunione non visibile a te', unavailable: 'una riunione il cui nome non è disponibile' },
    none: (category: string) => `altro lavoro (${category})`,
  },
  edit: 'Modifica',
  editEntry: (duration: string, on: string, date: string) => `Modifica ${duration} su ${on}, ${date}`,
  deleteEntry: (duration: string, on: string, date: string) => `Elimina ${duration} su ${on}, ${date}`,
  loadMore: 'Carica altre',
  loadingMore: 'Caricamento…',
  loadedMore: (added: number, shown: number) => `Caricate altre ${added} registrazioni, ${shown} mostrate`,
  loadMoreError: 'Impossibile caricare altre registrazioni. Riprova.',
  retired: (name: string) => `${name} (archiviata)`,
  banners: {
    unavailable: (sources: string) =>
      `Le ore sono complete; questi nomi non sono stati caricati e risultano non disponibili: ${sources}.`,
    dealGrouping:
      'Al momento le ore delle riunioni non possono essere attribuite alla loro opportunità, quindi compaiono in una riga separata. Il totale non cambia.',
    hidden: {
      label: 'Registrazioni senza nome visibile',
      body: "Alcune registrazioni riguardano un progetto, un'opportunità o una riunione che non puoi aprire, quindi compaiono senza nome. Le loro ore sono comunque conteggiate.",
    },
  },
  dealFilterUnavailable: {
    title: 'Al momento non è possibile mostrare le ore di questa opportunità',
    body: 'Operai non è riuscito a verificare quali riunioni appartengono a questa opportunità, quindi un elenco o un totale sarebbero incompleti. Non viene mostrato nulla finché non è possibile. Riprova tra un momento.',
    clear: 'Rimuovi il filtro opportunità',
  },
}

export const entries = { en, it }
