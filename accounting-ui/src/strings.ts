/**
 * strings — every user-facing string of accounting-ui, in English and Italian (AC-8.4).
 *
 * Convention (design § Copy keys; the `strings.ts` rule of operai-ui/docs/design-system.md § Copy): one catalog per
 * language, `en` first and `it: typeof en` so a missing key does not compile, and
 * `strings = selectStrings({ en, it })`, resolved once by @operai/ui. A sentence with a value in it is a FUNCTION,
 * because word order around the value differs between the languages. Sentence case; Italian in the impersonal form the
 * suite already uses ("Impossibile…", "Inserire…", "Riprovare."). `n === 1` plurals are written inside the function.
 * `strings.test.ts` checks `catalogGaps(en, it)` is `[]`; `lib/noHardcodedStrings.test.ts` scans every `.tsx` under
 * `src/` for inline copy. Months come from `formatMonth`, numbers from `formatNumber`, dates from `formatDateTime`.
 *
 * This is the SKELETON (T26): the keys the copied frame pieces (`LoadState`, `PermissionDenied`, `NotFoundPage`, `Saved`)
 * and the router need, under the names design § Copy keys gives them. T27 writes the whole catalog into this file.
 * Past about 500 lines it splits into a `strings/` folder, as letterheads-ui's does.
 */
import { selectStrings } from '@operai/ui'

/** The English catalog: the reference every other language is checked against. */
export const en = {
  appTitle: 'Accounting',
  nav: {
    landmarkLabel: 'Accounting sections',
    ledgerAccounts: 'Ledger accounts',
    vatCodes: 'VAT codes',
    exchangeRates: 'Exchange rates',
    loading: 'Loading Accounting…',
  },
  common: {
    dismiss: 'Dismiss',
    retry: 'Retry',
    permissionDenied: {
      heading: 'No access to Accounting',
      body: 'Ask an administrator to give you access.',
    },
    authUnavailable: {
      heading: 'Authorization service unavailable',
      body: 'We cannot verify your access right now. Nothing was changed.',
    },
    // Not in design § Copy keys: the frame's "other failure" banner (design AS1) needs a title, and a sentence for a
    // failure that carries no Problem detail (a network failure, a body that is not a Problem).
    loadErrorTitle: 'Could not load',
    networkError: 'The server could not be reached. Check your connection and try again.',
    unknownError: 'Something went wrong. Try again.',
    notFound: {
      heading: 'This page does not exist',
      body: 'The link may be wrong.',
      back: 'Back to ledger accounts',
    },
  },
}

/** The Italian catalog: typed as the English, so a missing key does not compile. */
export const it: typeof en = {
  appTitle: 'Contabilità',
  nav: {
    landmarkLabel: 'Sezioni di Contabilità',
    ledgerAccounts: 'Conti contabili',
    vatCodes: 'Codici IVA',
    exchangeRates: 'Tassi di cambio',
    loading: 'Caricamento di Contabilità…',
  },
  common: {
    dismiss: 'Chiudi',
    retry: 'Riprova',
    permissionDenied: {
      heading: 'Nessun accesso a Contabilità',
      body: 'Rivolgersi a un amministratore per ottenere l’accesso.',
    },
    authUnavailable: {
      heading: 'Servizio di autorizzazione non disponibile',
      body: 'Al momento non è possibile verificare gli accessi. Non è stato modificato nulla.',
    },
    loadErrorTitle: 'Caricamento non riuscito',
    networkError: 'Impossibile raggiungere il server. Controllare la connessione e riprovare.',
    unknownError: 'Qualcosa è andato storto. Riprovare.',
    notFound: {
      heading: 'Questa pagina non esiste',
      body: 'Il link potrebbe essere errato.',
      back: 'Torna ai conti contabili',
    },
  },
}

/** The catalog for the person's language, resolved once by @operai/ui (`resolveLocale`). */
export const strings = selectStrings({ en, it })
