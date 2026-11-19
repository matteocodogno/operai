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
 * The whole catalog of design § Copy keys (T27): the frame, the entity names, the ledger accounts and VAT codes cards
 * with their dialogs (the 20261118 keys moved from refund-ui under their new names, UX-3, UX-4, UX-6, UX-7), the exchange
 * rates card (UX-9 to UX-11, UX-13), and the failure ladder (UX-15). Keys the table does not name, because the sentence it
 * gives has to be reachable by a key, are listed in `strings.test.ts` (`EXTRA_KEYS`) with their reason, so a stray key
 * is noticed. No other task edits this file: a missing key is a small follow-up commit here, serialized.
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
  // Proper names, the same in both languages (as refund-ui's `badges.entity`).
  entity: {
    welld_ch: 'WellD CH',
    welld_it: 'WellD Italia',
    label: 'Entity',
    showing: (entity: string) => `Showing ${entity}`,
    lost: (was: string, now: string) => `You no longer have access to ${was}. Showing ${now}.`,
  },
  common: {
    dismiss: 'Dismiss',
    retry: 'Retry',
    cancel: 'Cancel',
    close: 'Close',
    permissionDenied: {
      heading: 'No access to Accounting',
      body: 'Ask an administrator to give you access.',
    },
    authUnavailable: {
      heading: 'Authorization service unavailable',
      body: 'We cannot verify your access right now. Nothing was changed.',
    },
    forbidden: "You don't have permission to do this.",
    genericError: 'Could not save. Try again.',
    accessChanged: 'Your access to Accounting changed. The page was updated.',
    // UX-4: the reader's one sentence per card; `what` is one of `readOnlyWhat`.
    readOnly: (what: string) => `You can view this list. Accounting managers ${what}.`,
    // Not in design § Copy keys: the three values of `what` (the table gives them as prose), so a card never inlines one.
    readOnlyWhat: {
      accounts: 'add and deactivate accounts',
      vatCodes: 'add and deactivate VAT codes',
      rates: 'fetch and correct rates',
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
  status: {
    active: 'Active',
    inactive: 'Inactive',
  },
  accounts: {
    title: (entity: string) => `Ledger accounts — ${entity}`,
    description: (entity: string) => `The chart of accounts of ${entity}. Other modules book to these accounts.`,
    caption: (entity: string) => `${entity} ledger accounts`,
    loading: 'Loading ledger accounts…',
    loadError: 'Could not load the ledger accounts.',
    empty: {
      title: (entity: string) => `Nothing entered yet for ${entity}`,
      bodyManage: "Add the entity's ledger accounts with Add account.",
      bodyRead: 'Accounting managers enter them.',
    },
    columns: { number: 'Number', name: 'Name', status: 'Status', actions: 'Actions' },
    add: 'Add account',
    addDialog: {
      title: (entity: string) => `Add ledger account — ${entity}`,
      description: 'The number and name cannot be edited later. An account can be deactivated and reactivated.',
      number: 'Account number',
      numberHint: 'Digits separated by single dots, up to 20 characters. For example 5905 or 2620.1.',
      name: 'Account name',
      busy: 'Adding…',
    },
    errors: {
      numberEmpty: 'Enter an account number.',
      numberFormat: 'Use digits separated by single dots, such as 5905 or 2620.1.',
      numberTooLong: 'The number can have up to 20 characters.',
      nameEmpty: 'Enter a name.',
      nameTooLong: 'The name can have up to 120 characters.',
      nameFormat: 'The name cannot contain control characters.',
      // T53: the entity holds the most it may (409 `catalog_full`), nothing was added; deactivated ones count.
      catalogFull: (limit: number, entity: string) =>
        `${entity} already has the most accounts it can hold (${limit}, deactivated ones included). Nothing was added. Use an existing account instead.`,
      duplicate: (number: string, entity: string) => `Account ${number} already exists in ${entity}.`,
      duplicateInactive: (number: string) =>
        `Account ${number} already exists but is deactivated. Reactivate it from the list.`,
      alreadyActive: (number: string) => `Account ${number} is already active.`,
      alreadyInactive: (number: string) => `Account ${number} is already deactivated.`,
    },
    added: (number: string) => `Account ${number} added`,
    deactivated: (number: string) => `Account ${number} deactivated`,
    reactivated: (number: string) => `Account ${number} reactivated`,
    deactivate: 'Deactivate',
    reactivate: 'Reactivate',
    deactivateLabel: (number: string) => `Deactivate account ${number}`,
    reactivateLabel: (number: string) => `Reactivate account ${number}`,
    deactivateDialog: {
      title: (number: string) => `Deactivate account ${number}?`,
      // UX-7: neutral, names no consumer.
      body: 'No module can choose it any more. What was already booked with it keeps it. A module that uses it as a default needs another one. You can reactivate it at any time.',
      confirm: 'Deactivate',
      busy: 'Deactivating…',
    },
  },
  vatCodes: {
    title: (entity: string) => `VAT codes — ${entity}`,
    description: (entity: string) => `The VAT codes of ${entity}. Each carries one fixed rate.`,
    caption: (entity: string) => `${entity} VAT codes`,
    loading: 'Loading VAT codes…',
    loadError: 'Could not load the VAT codes.',
    empty: {
      title: (entity: string) => `Nothing entered yet for ${entity}`,
      bodyManage: "Add the entity's VAT codes with Add VAT code.",
      bodyRead: 'Accounting managers enter them.',
    },
    // Status and Actions are not in design § Copy keys (it names Code, Label and VAT rate); the list has the same two columns.
    columns: { code: 'Code', label: 'Label', rate: 'VAT rate', status: 'Status', actions: 'Actions' },
    add: 'Add VAT code',
    addDialog: {
      title: (entity: string) => `Add VAT code — ${entity}`,
      description: 'The rate cannot be changed later: a new rate needs a new code.',
      code: 'Code',
      codeHint: 'Letters, digits, - and _ (up to 16). Saved in capitals.',
      label: 'Label',
      rate: 'VAT rate (%)',
      rateHint: 'Between 0 and 100, up to 2 decimals.',
      busy: 'Adding…',
    },
    errors: {
      codeEmpty: 'Enter a code.',
      codeFormat: 'Use letters, digits, - or _ only.',
      codeTooLong: 'The code can have up to 16 characters.',
      labelEmpty: 'Enter a label.',
      labelTooLong: 'The label can have up to 80 characters.',
      labelFormat: 'The label cannot contain control characters.',
      catalogFull: (limit: number, entity: string) =>
        `${entity} already has the most VAT codes it can hold (${limit}, deactivated ones included). Nothing was added. Use an existing code instead.`,
      rateInvalid: 'Enter a rate between 0 and 100, with up to 2 decimals.',
      duplicate: (code: string, entity: string) => `VAT code ${code} already exists in ${entity}.`,
      duplicateInactive: (code: string) =>
        `VAT code ${code} already exists but is deactivated. Reactivate it from the list.`,
      alreadyActive: (code: string) => `VAT code ${code} is already active.`,
      alreadyInactive: (code: string) => `VAT code ${code} is already deactivated.`,
    },
    added: (code: string) => `VAT code ${code} added`,
    deactivated: (code: string) => `VAT code ${code} deactivated`,
    reactivated: (code: string) => `VAT code ${code} reactivated`,
    deactivate: 'Deactivate',
    reactivate: 'Reactivate',
    deactivateLabel: (code: string) => `Deactivate VAT code ${code}`,
    reactivateLabel: (code: string) => `Reactivate VAT code ${code}`,
    deactivateDialog: {
      title: (code: string) => `Deactivate VAT code ${code}?`,
      body: 'No module can choose it any more. What was already booked with it keeps it. A module that uses it as a default needs another one. Its rate never changes. You can reactivate it at any time.',
      confirm: 'Deactivate',
      busy: 'Deactivating…',
    },
  },
  fx: {
    title: (entity: string) => `Exchange rates — ${entity}`,
    caption: (entity: string) => `${entity} monthly average exchange rates`,
    description: (own: string) =>
      `${own} for 1 unit of the foreign currency, monthly average. Other modules convert at these rates.`,
    // UX-13: not the lists' "nothing entered yet"; nothing can be fetched or kept for this entity yet (AC-2.11).
    noSource: {
      title: (entity: string) => `No official source for ${entity} yet`,
      body: 'Exchange rates are not fetched or kept for this entity yet. They will be added when its source is chosen.',
    },
    source: {
      term: 'Source',
      bazg: 'Monthly average rates for VAT of the Swiss Federal Tax Administration (AFC/ESTV), served by the BAZG',
    },
    loading: 'Loading exchange rates…',
    loadError: 'Could not load the exchange rates.',
    empty: { title: 'No months to show yet', body: 'No completed month has rates to show.' },
    columns: { month: 'Month' },
    origin: { fetched: 'Fetched', corrected: 'Corrected', missing: 'Missing' },
    correct: 'Correct',
    correctLabel: (currency: string, month: string) => `Correct the ${currency} rate for ${month}`,
    cellLabel: (currency: string, month: string, rate: string, origin: string) =>
      `${currency}, ${month}: ${rate}, ${origin}`,
    cellMissingLabel: (currency: string, month: string) => `${currency}, ${month}: missing`,
    fetchNow: 'Fetch now',
    fetching: 'Fetching…',
    checking: 'Checking for new rates…',
    fetchedOk: (n: number) => (n === 1 ? 'Recorded the rates for 1 month.' : `Recorded the rates for ${n} months.`),
    nothingNew: 'No new rates to record.',
    notFetchable: (month: string) => `The rates for ${month} are not published yet.`,
    throttled: 'The rates were checked a moment ago. Try again in a few minutes.',
    deferred: (n: number) =>
      n === 1
        ? '1 more month is still to fetch. Fetch again to continue.'
        : `${n} more months are still to fetch. Fetch again to continue.`,
    disabled: 'Automatic fetching is turned off in this environment. Enter the rates by hand.',
    disabledReader: 'Automatic fetching is turned off in this environment.',
    fetchError: 'Could not fetch the rates. Try again.',
    // UX-9: the outcome in words, not only a time (closes A-7 of 20261118).
    lastFetch: {
      term: 'Last fetch',
      never: 'No fetch yet',
      ok: (at: string) => `${at} — succeeded`,
      failed: (at: string) => `${at} — failed`,
      disabled: (at: string) => `${at} — switched off`,
      throttled: (at: string) => `${at} — checked a moment ago`,
      notFetchable: (at: string) => `${at} — not published yet`,
      failedTitle: 'The last fetch failed',
      failedBody: (at: string, reason: string) => `On ${at}: ${reason}. The rates already recorded are unchanged.`,
    },
    // Moved verbatim from refund-ui's `exchangeRates.reason`.
    reason: {
      timeout: 'the official source did not answer in time',
      http: 'the official source returned an error',
      parse: 'the answer could not be read',
      monthMismatch: 'the answer was for a different month',
      currencyMissing: 'a currency was missing from the answer',
      unknown: 'an unknown error occurred',
    },
    // UX-11: a deep-linked month the table does not list (AC-7.3).
    deepLink: {
      notListed: (month: string) =>
        `${month} is not in the list. A month is listed once it has ended; its rate is published a few days later.`,
    },
    // UX-10: the 20261118 sentence about re-exporting is false now (AC-5.3, AC-5.5), and the limit is AC-2.5's.
    correction: {
      title: (currency: string, month: string) => `Correct rate — ${currency} · ${month}`,
      description:
        'Anything booked from now on uses this rate. What was already booked with the previous rate keeps it. The previous value is kept in the audit trail.',
      rate: (currency: string, own: string) => `Rate (${own} per 1 ${currency})`,
      hint: 'Greater than 0 and below 1000, up to 6 decimals.',
      inEffect: (rate: string, origin: string) => `In effect: ${rate} (${origin})`,
      rateInvalid: 'Enter a rate greater than 0 and below 1000, with up to 6 decimals.',
      monthNotCompleted: 'This month is not finished yet; its rate cannot be corrected.',
      notConvertible: "This currency has no rate: it is the entity's own currency.",
      save: 'Save correction',
      busy: 'Saving…',
      saved: (currency: string, month: string) => `${currency} rate for ${month} corrected`,
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
  entity: {
    welld_ch: 'WellD CH',
    welld_it: 'WellD Italia',
    label: 'Entità',
    showing: (entity: string) => `Visualizzazione di ${entity}`,
    lost: (was: string, now: string) => `Non si ha più accesso a ${was}. Visualizzazione di ${now}.`,
  },
  common: {
    dismiss: 'Chiudi',
    retry: 'Riprova',
    cancel: 'Annulla',
    close: 'Chiudi',
    permissionDenied: {
      heading: 'Nessun accesso a Contabilità',
      body: 'Rivolgersi a un amministratore per ottenere l’accesso.',
    },
    authUnavailable: {
      heading: 'Servizio di autorizzazione non disponibile',
      body: 'Al momento non è possibile verificare gli accessi. Non è stato modificato nulla.',
    },
    forbidden: 'Non si dispone dei permessi per questa operazione.',
    genericError: 'Impossibile salvare. Riprovare.',
    accessChanged: 'L’accesso a Contabilità è cambiato. La pagina è stata aggiornata.',
    readOnly: (what: string) => `È possibile vedere questo elenco. Spetta ai responsabili della contabilità ${what}.`,
    readOnlyWhat: {
      accounts: 'aggiungere e disattivare i conti',
      vatCodes: 'aggiungere e disattivare i codici IVA',
      rates: 'recuperare e correggere i tassi',
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
  status: {
    active: 'Attivo',
    inactive: 'Disattivato',
  },
  accounts: {
    title: (entity: string) => `Conti contabili — ${entity}`,
    description: (entity: string) => `Il piano dei conti di ${entity}. Gli altri moduli registrano su questi conti.`,
    caption: (entity: string) => `Conti contabili di ${entity}`,
    loading: 'Caricamento dei conti contabili…',
    loadError: 'Impossibile caricare i conti contabili.',
    empty: {
      title: (entity: string) => `Ancora nulla inserito per ${entity}`,
      bodyManage: 'Aggiungere i conti contabili dell’entità con Aggiungi conto.',
      bodyRead: 'Li inseriscono i responsabili della contabilità.',
    },
    columns: { number: 'Numero', name: 'Nome', status: 'Stato', actions: 'Azioni' },
    add: 'Aggiungi conto',
    addDialog: {
      title: (entity: string) => `Aggiungi conto contabile — ${entity}`,
      description:
        'Numero e nome non possono essere modificati in seguito. Un conto può essere disattivato e riattivato.',
      number: 'Numero del conto',
      numberHint: 'Cifre separate da un solo punto, fino a 20 caratteri. Per esempio 5905 o 2620.1.',
      name: 'Nome del conto',
      busy: 'Aggiunta…',
    },
    errors: {
      numberEmpty: 'Inserire un numero di conto.',
      numberFormat: 'Usare cifre separate da un solo punto, come 5905 o 2620.1.',
      numberTooLong: 'Il numero può avere al massimo 20 caratteri.',
      nameEmpty: 'Inserire un nome.',
      nameTooLong: 'Il nome può avere al massimo 120 caratteri.',
      nameFormat: 'Il nome non può contenere caratteri di controllo.',
      catalogFull: (limit: number, entity: string) =>
        `${entity} ha già il numero massimo di conti consentito (${limit}, compresi quelli disattivati). Non è stato aggiunto nulla. Usare un conto esistente.`,
      duplicate: (number: string, entity: string) => `Il conto ${number} esiste già in ${entity}.`,
      duplicateInactive: (number: string) => `Il conto ${number} esiste già ma è disattivato. Riattivarlo dall’elenco.`,
      alreadyActive: (number: string) => `Il conto ${number} è già attivo.`,
      alreadyInactive: (number: string) => `Il conto ${number} è già disattivato.`,
    },
    added: (number: string) => `Conto ${number} aggiunto`,
    deactivated: (number: string) => `Conto ${number} disattivato`,
    reactivated: (number: string) => `Conto ${number} riattivato`,
    deactivate: 'Disattiva',
    reactivate: 'Riattiva',
    deactivateLabel: (number: string) => `Disattiva il conto ${number}`,
    reactivateLabel: (number: string) => `Riattiva il conto ${number}`,
    deactivateDialog: {
      title: (number: string) => `Disattivare il conto ${number}?`,
      body: 'Nessun modulo potrà più sceglierlo. Quanto è già stato registrato con questo conto lo mantiene. Un modulo che lo usa come predefinito dovrà sceglierne un altro. Si può riattivare in qualsiasi momento.',
      confirm: 'Disattiva',
      busy: 'Disattivazione…',
    },
  },
  vatCodes: {
    title: (entity: string) => `Codici IVA — ${entity}`,
    description: (entity: string) => `I codici IVA di ${entity}. Ognuno ha un’aliquota fissa.`,
    caption: (entity: string) => `Codici IVA di ${entity}`,
    loading: 'Caricamento dei codici IVA…',
    loadError: 'Impossibile caricare i codici IVA.',
    empty: {
      title: (entity: string) => `Ancora nulla inserito per ${entity}`,
      bodyManage: 'Aggiungere i codici IVA dell’entità con Aggiungi codice IVA.',
      bodyRead: 'Li inseriscono i responsabili della contabilità.',
    },
    columns: { code: 'Codice', label: 'Descrizione', rate: 'Aliquota IVA', status: 'Stato', actions: 'Azioni' },
    add: 'Aggiungi codice IVA',
    addDialog: {
      title: (entity: string) => `Aggiungi codice IVA — ${entity}`,
      description: 'L’aliquota non può essere modificata in seguito: una nuova aliquota richiede un nuovo codice.',
      code: 'Codice',
      codeHint: 'Lettere, cifre, - e _ (fino a 16). Salvato in maiuscolo.',
      label: 'Descrizione',
      rate: 'Aliquota IVA (%)',
      rateHint: 'Tra 0 e 100, fino a 2 decimali.',
      busy: 'Aggiunta…',
    },
    errors: {
      codeEmpty: 'Inserire un codice.',
      codeFormat: 'Usare solo lettere, cifre, - o _.',
      codeTooLong: 'Il codice può avere al massimo 16 caratteri.',
      labelEmpty: 'Inserire una descrizione.',
      labelTooLong: 'La descrizione può avere al massimo 80 caratteri.',
      labelFormat: 'La descrizione non può contenere caratteri di controllo.',
      catalogFull: (limit: number, entity: string) =>
        `${entity} ha già il numero massimo di codici IVA consentito (${limit}, compresi quelli disattivati). Non è stato aggiunto nulla. Usare un codice esistente.`,
      rateInvalid: 'Inserire un’aliquota tra 0 e 100, con al massimo 2 decimali.',
      duplicate: (code: string, entity: string) => `Il codice IVA ${code} esiste già in ${entity}.`,
      duplicateInactive: (code: string) =>
        `Il codice IVA ${code} esiste già ma è disattivato. Riattivarlo dall’elenco.`,
      alreadyActive: (code: string) => `Il codice IVA ${code} è già attivo.`,
      alreadyInactive: (code: string) => `Il codice IVA ${code} è già disattivato.`,
    },
    added: (code: string) => `Codice IVA ${code} aggiunto`,
    deactivated: (code: string) => `Codice IVA ${code} disattivato`,
    reactivated: (code: string) => `Codice IVA ${code} riattivato`,
    deactivate: 'Disattiva',
    reactivate: 'Riattiva',
    deactivateLabel: (code: string) => `Disattiva il codice IVA ${code}`,
    reactivateLabel: (code: string) => `Riattiva il codice IVA ${code}`,
    deactivateDialog: {
      title: (code: string) => `Disattivare il codice IVA ${code}?`,
      body: 'Nessun modulo potrà più sceglierlo. Quanto è già stato registrato con questo codice lo mantiene. Un modulo che lo usa come predefinito dovrà sceglierne un altro. La sua aliquota non cambia mai. Si può riattivare in qualsiasi momento.',
      confirm: 'Disattiva',
      busy: 'Disattivazione…',
    },
  },
  fx: {
    title: (entity: string) => `Tassi di cambio — ${entity}`,
    caption: (entity: string) => `Tassi di cambio medi mensili di ${entity}`,
    description: (own: string) =>
      `${own} per 1 unità di valuta estera, media mensile. Gli altri moduli convertono con questi tassi.`,
    noSource: {
      title: (entity: string) => `Ancora nessuna fonte ufficiale per ${entity}`,
      body: 'I tassi di cambio di questa entità non vengono ancora recuperati né conservati. Saranno aggiunti quando verrà scelta la fonte.',
    },
    source: {
      term: 'Fonte',
      bazg: 'Corsi medi mensili IVA dell’Amministrazione federale delle contribuzioni (AFC), forniti dall’UDSC',
    },
    loading: 'Caricamento dei tassi di cambio…',
    loadError: 'Impossibile caricare i tassi di cambio.',
    empty: { title: 'Ancora nessun mese da mostrare', body: 'Nessun mese concluso ha tassi da mostrare.' },
    columns: { month: 'Mese' },
    origin: { fetched: 'Recuperato', corrected: 'Corretto', missing: 'Mancante' },
    correct: 'Correggi',
    correctLabel: (currency: string, month: string) => `Correggi il tasso ${currency} di ${month}`,
    cellLabel: (currency: string, month: string, rate: string, origin: string) =>
      `${currency}, ${month}: ${rate}, ${origin}`,
    cellMissingLabel: (currency: string, month: string) => `${currency}, ${month}: mancante`,
    fetchNow: 'Recupera ora',
    fetching: 'Recupero…',
    checking: 'Verifica di nuovi tassi…',
    fetchedOk: (n: number) => (n === 1 ? 'Registrati i tassi di 1 mese.' : `Registrati i tassi di ${n} mesi.`),
    nothingNew: 'Nessun nuovo tasso da registrare.',
    notFetchable: (month: string) => `I tassi di ${month} non sono ancora pubblicati.`,
    throttled: 'I tassi sono stati controllati poco fa. Riprovare tra qualche minuto.',
    deferred: (n: number) =>
      n === 1
        ? 'Resta ancora 1 mese da recuperare. Recuperare di nuovo per continuare.'
        : `Restano ancora ${n} mesi da recuperare. Recuperare di nuovo per continuare.`,
    disabled: 'Il recupero automatico è disattivato in questo ambiente. Inserire i tassi a mano.',
    disabledReader: 'Il recupero automatico è disattivato in questo ambiente.',
    fetchError: 'Impossibile recuperare i tassi. Riprovare.',
    lastFetch: {
      term: 'Ultimo recupero',
      never: 'Ancora nessun recupero',
      ok: (at: string) => `${at} — riuscito`,
      failed: (at: string) => `${at} — non riuscito`,
      disabled: (at: string) => `${at} — disattivato`,
      throttled: (at: string) => `${at} — controllo appena eseguito`,
      notFetchable: (at: string) => `${at} — non ancora pubblicato`,
      failedTitle: 'L’ultimo recupero non è riuscito',
      failedBody: (at: string, reason: string) => `Il ${at}: ${reason}. I tassi già registrati non sono cambiati.`,
    },
    reason: {
      timeout: 'la fonte ufficiale non ha risposto in tempo',
      http: 'la fonte ufficiale ha restituito un errore',
      parse: 'non è stato possibile leggere la risposta',
      monthMismatch: 'la risposta riguardava un altro mese',
      currencyMissing: 'mancava una valuta nella risposta',
      unknown: 'si è verificato un errore sconosciuto',
    },
    deepLink: {
      notListed: (month: string) =>
        `${month} non è nell’elenco. Un mese compare quando è concluso; il suo tasso viene pubblicato qualche giorno dopo.`,
    },
    correction: {
      title: (currency: string, month: string) => `Correggi tasso — ${currency} · ${month}`,
      description:
        'Tutto ciò che viene registrato da ora in poi usa questo tasso. Quanto è già stato registrato con il tasso precedente lo mantiene. Il valore precedente resta nel registro di audit.',
      rate: (currency: string, own: string) => `Tasso (${own} per 1 ${currency})`,
      hint: 'Maggiore di 0 e inferiore a 1000, fino a 6 decimali.',
      inEffect: (rate: string, origin: string) => `In vigore: ${rate} (${origin})`,
      rateInvalid: 'Inserire un tasso maggiore di 0 e inferiore a 1000, con al massimo 6 decimali.',
      monthNotCompleted: 'Questo mese non è ancora concluso: il suo tasso non può essere corretto.',
      notConvertible: 'Questa valuta non ha un tasso: è la valuta propria dell’entità.',
      save: 'Salva correzione',
      busy: 'Salvataggio…',
      saved: (currency: string, month: string) => `Tasso ${currency} di ${month} corretto`,
    },
  },
}

/** The catalog for the person's language, resolved once by @operai/ui (`resolveLocale`). */
export const strings = selectStrings({ en, it })
