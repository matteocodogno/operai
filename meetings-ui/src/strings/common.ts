/** Shared labels: states, dialogs, banners, generic field copy. T54 adds the problem-code messages. */
const en = {
  loading: 'Loading…',
  retry: 'Retry',
  reload: 'Reload',
  dismiss: 'Dismiss',
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save',
  edit: 'Edit',
  delete: 'Delete',
  copy: 'Copy',
  none: '—',
  networkError: 'The server could not be reached. Check your connection and try again.',
  unknownError: 'Something went wrong. Try again.',
  loadErrorTitle: 'Could not load',
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
}

const it: typeof en = {
  loading: 'Caricamento…',
  retry: 'Riprova',
  reload: 'Ricarica',
  dismiss: 'Chiudi avviso',
  cancel: 'Annulla',
  close: 'Chiudi',
  save: 'Salva',
  edit: 'Modifica',
  delete: 'Elimina',
  copy: 'Copia',
  none: '—',
  networkError: 'Impossibile raggiungere il server. Controlla la connessione e riprova.',
  unknownError: 'Qualcosa è andato storto. Riprova.',
  loadErrorTitle: 'Impossibile caricare',
  authUnavailable: {
    heading: 'Servizio di autorizzazione non disponibile',
    body: 'Al momento non possiamo verificare il tuo accesso. Non è stato modificato nulla.',
  },
  permissionDenied: {
    heading: 'Non hai accesso a questa pagina',
    body: 'Chiedi il permesso a un amministratore, poi ricarica la pagina.',
  },
  staleWrite: {
    title: 'Questo elemento è cambiato',
    body: 'Qualcun altro ha modificato questo elemento. Ricarica per vedere le modifiche, poi riprova.',
  },
}

export const common = { en, it }
