/** Shared labels: the tool frame, states, banners and generic error copy. */

const en = {
  /** The tool's name: the page's one h1. */
  title: 'Hours',
  loading: 'Loading…',
  retry: 'Retry',
  tryAgain: 'Try again',
  dismiss: 'Dismiss',
  cancel: 'Cancel',
  close: 'Close',
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
  nav: {
    landmarkLabel: 'Hours sections',
    myHours: 'My hours',
    everyone: "Everyone's hours",
  },
  notFound: {
    heading: 'This page does not exist',
    body: 'The link may be wrong.',
    back: 'Back to my hours',
  },
}

const it: typeof en = {
  title: 'Ore',
  loading: 'Caricamento…',
  retry: 'Riprova',
  tryAgain: 'Riprova',
  dismiss: 'Chiudi avviso',
  cancel: 'Annulla',
  close: 'Chiudi',
  none: '—',
  networkError: 'Impossibile raggiungere il server. Controlla la connessione e riprova.',
  unknownError: 'Qualcosa è andato storto. Riprova.',
  loadErrorTitle: 'Caricamento non riuscito',
  authUnavailable: {
    heading: 'Servizio di autorizzazione non disponibile',
    body: 'Al momento non possiamo verificare i tuoi accessi. Non è stato modificato nulla.',
  },
  permissionDenied: {
    heading: 'Non hai accesso a questa sezione',
    body: 'Chiedi il permesso a un amministratore, poi ricarica la pagina.',
  },
  nav: {
    landmarkLabel: 'Sezioni delle ore',
    myHours: 'Le mie ore',
    everyone: 'Le ore di tutti',
  },
  notFound: {
    heading: 'Questa pagina non esiste',
    body: 'Il link potrebbe essere errato.',
    back: 'Torna alle mie ore',
  },
}

export const common = { en, it }
