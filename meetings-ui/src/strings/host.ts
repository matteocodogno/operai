/** The host panel (`./HostMeetings`, S6, F1b): the Meetings card on a host record, and its link dialog. */
const en = {
  panel: {
    title: 'Meetings',
    start: 'Start meeting',
    link: 'Link an existing meeting',
    loading: 'Loading meetings…',
    listLabel: 'Meetings on this record',
    unavailable: {
      title: 'Meetings are unavailable right now',
      body: 'The rest of this page is not affected. Try again in a moment.',
    },
    someHidden: "Some meetings can't be shown right now. Meetings you created or took part in are listed.",
    empty: {
      title: 'No meetings yet',
      body: (entity: string) => `Meetings started from this ${entity} appear here.`,
    },
    row: {
      meta: (date: string, creator: string) => `${date} · ${creator}`,
      summaries: (n: number) => (n === 1 ? '1 summary' : `${n} summaries`),
      unknownCreator: 'Former colleague',
    },
    pagination: {
      label: 'Meetings pages',
      previous: 'Previous',
      next: 'Next',
      status: (page: number, totalPages: number, from: number, to: number, total: number) =>
        `Page ${page} of ${totalPages} — showing ${from}–${to} of ${total}`,
    },
    linked: 'Meeting linked.',
    noticeFailedFallback: 'The linked record could not be notified.',
    noticeTryAgain: 'Try again',
  },
  dialog: {
    title: 'Link an existing meeting',
    search: 'Search by title',
    searchPlaceholder: 'Title contains…',
    choose: 'Meeting to link',
    standalone: 'Standalone',
    missing: 'No longer available',
    moved: (from: string, entity: string) => `It will be moved from ${from} to this ${entity}.`,
    loading: 'Loading your meetings…',
    empty: {
      title: 'No meetings to link',
      body: (entity: string) =>
        `Only meetings you created, that aren't frozen and aren't already on this ${entity}, can be linked.`,
    },
    submit: 'Link meeting',
    busy: 'Linking…',
    errors: {
      cannotLink: "You can't link to this item.",
      unavailable: (entity: string) => `We can't check this ${entity} right now. Try again.`,
      gone: 'That meeting is no longer available.',
    },
    pagination: {
      label: 'Meetings you can link, pages',
      previous: 'Previous',
      next: 'Next',
    },
  },
}

const it: typeof en = {
  panel: {
    title: 'Riunioni',
    start: 'Avvia riunione',
    link: 'Collega una riunione esistente',
    loading: 'Caricamento delle riunioni…',
    listLabel: 'Riunioni su questo elemento',
    unavailable: {
      title: 'Le riunioni non sono disponibili al momento',
      body: 'Il resto della pagina non è interessato. Riprova tra poco.',
    },
    someHidden:
      'Alcune riunioni non si possono mostrare al momento. Sono elencate le riunioni che hai creato o a cui hai partecipato.',
    empty: {
      title: 'Nessuna riunione',
      body: (entity) => `Le riunioni avviate da questo elemento (${entity}) compaiono qui.`,
    },
    row: {
      meta: (date, creator) => `${date} · ${creator}`,
      summaries: (n) => (n === 1 ? '1 riassunto' : `${n} riassunti`),
      unknownCreator: 'Ex collega',
    },
    pagination: {
      label: 'Pagine delle riunioni',
      previous: 'Precedente',
      next: 'Successiva',
      status: (page, totalPages, from, to, total) => `Pagina ${page} di ${totalPages} — ${from}–${to} di ${total}`,
    },
    linked: 'Riunione collegata.',
    noticeFailedFallback: 'Non è stato possibile avvisare il record collegato.',
    noticeTryAgain: 'Riprova',
  },
  dialog: {
    title: 'Collega una riunione esistente',
    search: 'Cerca per titolo',
    searchPlaceholder: 'Il titolo contiene…',
    choose: 'Riunione da collegare',
    standalone: 'Indipendente',
    missing: 'Non più disponibile',
    moved: (from, entity) => `Verrà spostata da ${from} a questo elemento (${entity}).`,
    loading: 'Caricamento delle tue riunioni…',
    empty: {
      title: 'Nessuna riunione da collegare',
      body: (entity) =>
        `Si possono collegare solo le riunioni che hai creato, non bloccate e non già collegate a questo elemento (${entity}).`,
    },
    submit: 'Collega riunione',
    busy: 'Collegamento…',
    errors: {
      cannotLink: 'Non puoi collegare a questo elemento.',
      unavailable: (entity) => `Al momento non riusciamo a controllare questo elemento (${entity}). Riprova.`,
      gone: 'Quella riunione non è più disponibile.',
    },
    pagination: {
      label: 'Riunioni collegabili, pagine',
      previous: 'Precedente',
      next: 'Successiva',
    },
  },
}

export const host = { en, it }
