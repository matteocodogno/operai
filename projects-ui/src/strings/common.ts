/** Shared labels: states, dialogs, banners, generic field copy. */
type PageStatus = { page: number; totalPages: number; rangeStart: number; rangeEnd: number; total: number }

const en = {
  loading: 'Loading…',
  retry: 'Retry',
  dismiss: 'Dismiss',
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save',
  saving: 'Saving…',
  edit: 'Edit',
  reload: 'Reload',
  none: '—',
  any: 'Any',
  choose: 'Choose…',
  search: 'Search',
  networkError: 'The server could not be reached. Check your connection and try again.',
  unknownError: 'Something went wrong. Try again.',
  loadErrorTitle: 'Could not load',
  saveError: 'The changes could not be saved. Your input is kept; try again.',
  authUnavailable: {
    heading: 'Authorization service unavailable',
    body: 'We cannot verify your access right now. Nothing was changed.',
  },
  permissionDenied: {
    heading: 'You do not have access to this',
    body: 'Ask an administrator for the permission, then reload the page.',
  },
  staleWrite: {
    title: 'This record has changed',
    body: 'Someone else changed this record. Reload to see their changes, then try again.',
  },
  pagination: {
    label: 'Pages',
    previous: 'Previous',
    next: 'Next',
    status: ({ page, totalPages, rangeStart, rangeEnd, total }: PageStatus) =>
      `Page ${page} of ${totalPages} — showing ${rangeStart}–${rangeEnd} of ${total}`,
  },
  validation: {
    required: 'This field is required.',
    tooLong: (max: number) => `Use at most ${max} characters.`,
    date: 'Enter a valid date.',
    fixErrors: 'Some fields need attention.',
  },
}

const it: typeof en = {
  loading: 'Caricamento…',
  retry: 'Riprova',
  dismiss: 'Chiudi avviso',
  cancel: 'Annulla',
  close: 'Chiudi',
  save: 'Salva',
  saving: 'Salvataggio…',
  edit: 'Modifica',
  reload: 'Ricarica',
  none: '—',
  any: 'Tutti',
  choose: 'Scegli…',
  search: 'Cerca',
  networkError: 'Impossibile raggiungere il server. Controlla la connessione e riprova.',
  unknownError: 'Qualcosa è andato storto. Riprova.',
  loadErrorTitle: 'Caricamento non riuscito',
  saveError: 'Non è stato possibile salvare le modifiche. I dati inseriti restano; riprova.',
  authUnavailable: {
    heading: 'Servizio di autorizzazione non disponibile',
    body: 'Al momento non possiamo verificare i tuoi accessi. Non è stato modificato nulla.',
  },
  permissionDenied: {
    heading: 'Non hai accesso a questa sezione',
    body: 'Chiedi il permesso a un amministratore, poi ricarica la pagina.',
  },
  staleWrite: {
    title: 'Questo record è cambiato',
    body: 'Qualcun altro ha modificato questo record. Ricarica per vedere le modifiche, poi riprova.',
  },
  pagination: {
    label: 'Pagine',
    previous: 'Precedente',
    next: 'Successiva',
    status: ({ page, totalPages, rangeStart, rangeEnd, total }: PageStatus) =>
      `Pagina ${page} di ${totalPages} — elementi ${rangeStart}–${rangeEnd} di ${total}`,
  },
  validation: {
    required: 'Campo obbligatorio.',
    tooLong: (max: number) => `Usa al massimo ${max} caratteri.`,
    date: 'Inserisci una data valida.',
    fixErrors: 'Alcuni campi richiedono attenzione.',
  },
}

export const common = { en, it }
