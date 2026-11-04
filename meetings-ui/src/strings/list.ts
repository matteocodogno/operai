/** The meetings list (S1), for both entries: `./App` ("Meetings") and `./MyMeetings` ("My meetings"). */
const en = {
  heading: 'Meetings',
  myHeading: 'My meetings',
  newMeeting: 'New meeting',
  loading: 'Loading meetings…',
  filters: {
    title: 'Filter meetings',
    search: 'Search by title',
    searchPlaceholder: 'Title contains…',
    role: 'Role',
    status: 'Status',
    hostApp: 'Linked app',
    all: 'All',
    clear: 'Clear filters',
  },
  role: {
    creator: 'Creator',
    participant: 'Participant',
  },
  table: {
    caption: 'Meetings',
    title: 'Title',
    date: 'Date',
    format: 'Format',
    host: 'Linked to',
    status: 'Status',
    role: 'Role',
  },
  format: {
    in_person: 'In person',
    online: 'Online',
  },
  host: {
    standalone: 'Standalone',
    missing: 'No longer available',
  },
  pagination: {
    label: 'Meetings pages',
    previous: 'Previous',
    next: 'Next',
    status: (page: number, totalPages: number, from: number, to: number, total: number) =>
      `Page ${page} of ${totalPages} — showing ${from}–${to} of ${total}`,
  },
  empty: {
    none: {
      title: 'No meetings yet',
      body: 'Meetings you create or take part in appear here.',
    },
    filtered: {
      title: 'No meetings match',
      body: 'No meeting matches the filters you set. Change or clear them to see more.',
    },
  },
}

const it: typeof en = {
  heading: 'Riunioni',
  myHeading: 'Le mie riunioni',
  newMeeting: 'Nuova riunione',
  loading: 'Caricamento delle riunioni…',
  filters: {
    title: 'Filtra le riunioni',
    search: 'Cerca per titolo',
    searchPlaceholder: 'Il titolo contiene…',
    role: 'Ruolo',
    status: 'Stato',
    hostApp: 'App collegata',
    all: 'Tutti',
    clear: 'Azzera i filtri',
  },
  role: {
    creator: 'Autore',
    participant: 'Partecipante',
  },
  table: {
    caption: 'Riunioni',
    title: 'Titolo',
    date: 'Data',
    format: 'Formato',
    host: 'Collegata a',
    status: 'Stato',
    role: 'Ruolo',
  },
  format: {
    in_person: 'Di persona',
    online: 'Online',
  },
  host: {
    standalone: 'Indipendente',
    missing: 'Non più disponibile',
  },
  pagination: {
    label: 'Pagine delle riunioni',
    previous: 'Precedente',
    next: 'Successiva',
    status: (page, totalPages, from, to, total) => `Pagina ${page} di ${totalPages} — ${from}–${to} di ${total}`,
  },
  empty: {
    none: {
      title: 'Nessuna riunione',
      body: 'Le riunioni che crei o a cui partecipi compaiono qui.',
    },
    filtered: {
      title: 'Nessuna riunione corrisponde',
      body: 'Nessuna riunione corrisponde ai filtri impostati. Cambiali o azzerali per vederne di più.',
    },
  },
}

export const list = { en, it }
