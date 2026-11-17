/**
 * strings.legalEntities — the Legal entities section (AC-8.2): the page, the
 * entity and view tabs, the form, the refusal / conflict / restore sentences
 * and the history. Functions take counts and names; components never
 * concatenate. Italian uses the spec's vocabulary ("Società del gruppo").
 */

/** The language of an address, as problem sentences name it. */
export type AddressLang = 'it' | 'en'

export const en = {
  page: {
    heading: 'Legal entities',
    description: 'The legal details every tool prints on its documents, kept once for the whole group.',
  },
  status: {
    complete: 'Complete',
    incomplete: 'Incomplete',
    needsCorrection: 'Needs correction',
    notMoved: 'Not moved yet',
    readOnly: 'Read-only',
  },
  tabs: {
    entities: 'Legal entities',
    views: (entity: string) => `Views of ${entity}`,
  },
  tab: {
    unsaved: 'Unsaved changes',
    readOnly: (entity: string) => `${entity} is read-only`,
  },
  entity: {
    toCorrect: (list: string) => `To correct before the next save: ${list}.`,
    version: (n: number, who: string, when: string) => `Version ${n} · saved by ${who} · ${when}`,
    moved: (when: string) => `Version 1 · moved from the CRM by the system · ${when}`,
    notMoved: 'The details have not been moved into the registry yet. They can be edited once the move has run.',
  },
  views: {
    details: 'Details',
    history: 'History',
  },
  value: {
    legalName: 'Legal name',
    vat: 'VAT number',
    iban: 'IBAN',
    addressIt: 'Address (Italian)',
    addressEn: 'Address (English)',
    contactsIt: 'Contacts line (Italian)',
    contactsEn: 'Contacts line (English)',
    notFilled: 'Not filled in',
    empty: 'Empty',
  },
  form: {
    group: {
      company: 'Company',
      address: 'Address',
      contacts: 'Contacts line',
    },
    ibanHint: 'Spaces and lower case are fine; it is saved without spaces and shown in groups of four. Optional.',
    contactsHint: 'Printed on the letterhead, for example phone and email. Up to 200 characters. Optional.',
  },
  address: {
    line: (k: number) => `Line ${k}`,
    count: (n: number, limit: number) => `${n} / ${limit}`,
    hint: 'Up to 4 lines of 120 characters. An empty line is left out and the lines after it move up. Line 1 is required in both languages.',
  },
  bar: {
    dirty: 'Unsaved changes. Every tool uses a saved version within a minute.',
    clean: 'No changes',
    saving: 'Saving…',
    save: (n: number) => `Save as version ${n}`,
    nothingToSave: 'There is nothing to save.',
    reloadFirst: 'A newer version exists. Choose how to continue.',
  },
  saved: (n: number) => `Version ${n} saved. Every tool uses it within a minute.`,
  noop: (n: number) => `Nothing changed. These details are already version ${n}, so no new version was made.`,
  refused: {
    title: (n: number) => (n === 1 ? 'Nothing was saved. 1 value needs your attention.' : `Nothing was saved. ${n} values need your attention.`),
    hint: 'Correct them and save again. Select one to go to it.',
  },
  problem: {
    required: (v: string) => `Enter the ${v}.`,
    tooLong: (limit: number, n: number) => `Too long: at most ${limit} characters, you have ${n}.`,
    tooManyLines: (n: number) => `Too many lines: at most 4, you have ${n}.`,
    tooManyLinesMoved: 'Too many lines: at most 4. Join it to a line above or remove it. (Kept as moved from the CRM.)',
    lineBreak: 'Use one line: remove the line break.',
    controlChar: 'Remove the special character (a tab or control character).',
    ibanFormat: 'An IBAN starts with two letters and two digits, then letters and digits only.',
    ibanCheck: 'The check digits do not match. Check it for a typing mistake.',
    line: (lang: AddressLang, k: number, text: string) =>
      `Line ${k} of the ${lang === 'it' ? 'Italian' : 'English'} address: ${text}`,
  },
  conflict: {
    title: 'A newer version was saved',
    body: (who: string, n: number, when: string, values: string) =>
      `${who} saved version ${n} on ${when} (changed: ${values}) while you were editing. Your changes are still in this form but were not saved.`,
    reapply: (n: number) => `Reapply my changes to version ${n}`,
    discard: (n: number) => `Discard my changes and load version ${n}`,
    applied: (n: number, flagged: string, next: number) =>
      `Your changes were applied to version ${n}. ${flagged} to review, then save as version ${next}.`,
    alsoChanged: (n: number, who: string, theirs: string) =>
      `Also changed in version ${n} by ${who}: “${theirs}”. Yours is kept.`,
    useTheirs: 'Use theirs',
    takenFromTheirs: (n: number) => `Taken from version ${n} (you had not changed it).`,
  },
  lost: {
    title: (entity: string) => `You can no longer change ${entity}`,
    body: 'Your changes were not saved. The details are now read-only.',
  },
  saveFailed: {
    title: 'The details could not be saved',
    body: 'Nothing changed. Your changes are still here. Try again.',
  },
  leave: {
    title: 'Leave without saving?',
    body: (entities: string) => `Your changes to ${entities} have not been saved and will be lost.`,
    keep: 'Keep editing',
    discard: 'Discard changes',
  },
  readOnly: {
    note: (entity: string) =>
      `You can read these details but not change them. An administrator grants who may change ${entity}.`,
  },
  incomplete: {
    title: 'These details are incomplete',
    body: (list: string, entity: string) =>
      `Missing: ${list}. Offers and contracts for ${entity} are refused until they are filled in and saved.`,
  },
  toCorrect: {
    title: 'These details need correction',
  },
  history: {
    caption: (entity: string) => `Versions of ${entity}`,
    version: 'Version',
    savedBy: 'Saved by',
    savedAt: 'Saved on',
    changed: 'What changed',
    actions: 'Actions',
    restoreBlocked:
      'This version cannot be restored: it is missing a required value or holds one today’s rules refuse. Open it to see which.',
    current: 'Current',
    restoredFrom: (m: number) => `Restored from version ${m}`,
    sameAs: (m: number) => `Same details as version ${m}`,
    system: 'System',
    moved: 'Moved from the CRM',
    open: (n: number) => `Open version ${n}`,
    restore: (n: number) => `Restore version ${n}`,
    empty: 'No versions yet',
  },
  version: {
    title: (n: number) => `Viewing version ${n} (read-only)`,
    body: (who: string, when: string, current: number) =>
      `Saved by ${who} on ${when}. The current version is ${current}.`,
    back: 'Back to history',
    restore: 'Restore this version',
    notCurrent: 'Not current',
    blocked: (list: string, entity: string) =>
      `This version cannot be restored: ${list}. Restoring it would make ${entity} incomplete again.`,
    notFound: 'This version does not exist.',
  },
  restore: {
    title: (n: number) => `Restore version ${n}?`,
    body: (n: number, next: number, current: number) =>
      `This creates version ${next} with the same details as version ${n} and makes it the current one. Version ${current} and the rest of the history stay as they are.`,
    changes: (list: string) => `Compared with the current version, these change: ${list}.`,
    confirm: (n: number) => `Restore version ${n}`,
    busy: 'Restoring…',
    done: (next: number, n: number) => `Version ${next} created from version ${n}`,
    refused: (n: number, list: string) => `Version ${n} cannot be restored: ${list}. Nothing changed.`,
    conflict: 'A newer version was saved meanwhile. The history was reloaded; check it and try again.',
    failed: (n: number) => `Version ${n} was not restored. Nothing changed. Try again.`,
  },
  load: {
    failed: 'The legal entities could not be loaded',
  },
  sections: {
    loading: 'Loading…',
    failed: 'The sections could not be loaded',
  },
}

export const it: typeof en = {
  page: {
    heading: 'Società del gruppo',
    description: 'I dati legali che ogni strumento stampa sui suoi documenti, tenuti una sola volta per tutto il gruppo.',
  },
  status: {
    complete: 'Completa',
    incomplete: 'Incompleta',
    needsCorrection: 'Da correggere',
    notMoved: 'Non ancora portata',
    readOnly: 'Sola lettura',
  },
  tabs: {
    entities: 'Società del gruppo',
    views: (entity: string) => `Viste di ${entity}`,
  },
  tab: {
    unsaved: 'Modifiche non salvate',
    readOnly: (entity: string) => `${entity} è in sola lettura`,
  },
  entity: {
    toCorrect: (list: string) => `Da correggere prima del prossimo salvataggio: ${list}.`,
    version: (n: number, who: string, when: string) => `Versione ${n} · salvata da ${who} · ${when}`,
    moved: (when: string) => `Versione 1 · portata dal CRM dal sistema · ${when}`,
    notMoved: 'I dati non sono ancora stati portati nel registro. Si potranno modificare dopo il trasferimento.',
  },
  views: {
    details: 'Dati',
    history: 'Cronologia',
  },
  value: {
    legalName: 'Ragione sociale',
    vat: 'Partita IVA',
    iban: 'IBAN',
    addressIt: 'Indirizzo (italiano)',
    addressEn: 'Indirizzo (inglese)',
    contactsIt: 'Riga contatti (italiano)',
    contactsEn: 'Riga contatti (inglese)',
    notFilled: 'Non compilato',
    empty: 'Vuoto',
  },
  form: {
    group: {
      company: 'Società',
      address: 'Indirizzo',
      contacts: 'Riga contatti',
    },
    ibanHint:
      'Spazi e maiuscole/minuscole non contano; viene salvato senza spazi e mostrato a gruppi di quattro. Facoltativo.',
    contactsHint: 'Stampata sulla carta intestata, per esempio telefono ed email. Fino a 200 caratteri. Facoltativa.',
  },
  address: {
    line: (k: number) => `Riga ${k}`,
    count: (n: number, limit: number) => `${n} / ${limit}`,
    hint: 'Fino a 4 righe di 120 caratteri. Una riga vuota viene tralasciata e le righe dopo salgono. La Riga 1 è obbligatoria in entrambe le lingue.',
  },
  bar: {
    dirty: 'Modifiche non salvate. Ogni strumento usa una versione salvata entro un minuto.',
    clean: 'Nessuna modifica',
    saving: 'Salvataggio…',
    save: (n: number) => `Salva come versione ${n}`,
    nothingToSave: 'Non c’è nulla da salvare.',
    reloadFirst: 'Esiste una versione più recente. Scegli come proseguire.',
  },
  saved: (n: number) => `Versione ${n} salvata. Ogni strumento la usa entro un minuto.`,
  noop: (n: number) =>
    `Nulla è cambiato. Questi dati sono già la versione ${n}, quindi non è stata creata una nuova versione.`,
  refused: {
    title: (n: number) =>
      n === 1
        ? 'Non è stato salvato nulla. 1 valore richiede la tua attenzione.'
        : `Non è stato salvato nulla. ${n} valori richiedono la tua attenzione.`,
    hint: 'Correggili e salva di nuovo. Scegline uno per andarci.',
  },
  problem: {
    required: (v: string) => `Inserisci ${v}.`,
    tooLong: (limit: number, n: number) => `Troppo lungo: al massimo ${limit} caratteri, ne hai ${n}.`,
    tooManyLines: (n: number) => `Troppe righe: al massimo 4, ne hai ${n}.`,
    tooManyLinesMoved: 'Troppe righe: al massimo 4. Uniscila a una riga sopra o eliminala. (Mantenuta com’era nel CRM.)',
    lineBreak: 'Usa una sola riga: togli l’a capo.',
    controlChar: 'Togli il carattere speciale (una tabulazione o un carattere di controllo).',
    ibanFormat: 'Un IBAN inizia con due lettere e due cifre, poi solo lettere e cifre.',
    ibanCheck: 'Le cifre di controllo non corrispondono. Controlla di non aver sbagliato a digitare.',
    line: (lang: AddressLang, k: number, text: string) =>
      `Riga ${k} dell’indirizzo ${lang === 'it' ? 'italiano' : 'inglese'}: ${text}`,
  },
  conflict: {
    title: 'È stata salvata una versione più recente',
    body: (who: string, n: number, when: string, values: string) =>
      `${who} ha salvato la versione ${n} il ${when} (cambiato: ${values}) mentre modificavi. Le tue modifiche sono ancora in questo modulo ma non sono state salvate.`,
    reapply: (n: number) => `Riapplica le mie modifiche alla versione ${n}`,
    discard: (n: number) => `Scarta le mie modifiche e carica la versione ${n}`,
    applied: (n: number, flagged: string, next: number) =>
      `Le tue modifiche sono state applicate alla versione ${n}. ${flagged} da controllare, poi salva come versione ${next}.`,
    alsoChanged: (n: number, who: string, theirs: string) =>
      `Cambiato anche nella versione ${n} da ${who}: «${theirs}». Il tuo valore è mantenuto.`,
    useTheirs: 'Usa il suo',
    takenFromTheirs: (n: number) => `Preso dalla versione ${n} (non l’avevi cambiato).`,
  },
  lost: {
    title: (entity: string) => `Non puoi più modificare ${entity}`,
    body: 'Le tue modifiche non sono state salvate. I dati sono ora in sola lettura.',
  },
  saveFailed: {
    title: 'Non è stato possibile salvare i dati',
    body: 'Nulla è cambiato. Le tue modifiche sono ancora qui. Riprova.',
  },
  leave: {
    title: 'Uscire senza salvare?',
    body: (entities: string) => `Le tue modifiche a ${entities} non sono state salvate e andranno perse.`,
    keep: 'Continua a modificare',
    discard: 'Scarta le modifiche',
  },
  readOnly: {
    note: (entity: string) =>
      `Puoi leggere questi dati ma non modificarli. Un amministratore stabilisce chi può modificare ${entity}.`,
  },
  incomplete: {
    title: 'Questi dati sono incompleti',
    body: (list: string, entity: string) =>
      `Mancano: ${list}. Le offerte e i contratti di ${entity} sono rifiutati finché non sono compilati e salvati.`,
  },
  toCorrect: {
    title: 'Questi dati vanno corretti',
  },
  history: {
    caption: (entity: string) => `Versioni di ${entity}`,
    version: 'Versione',
    savedBy: 'Salvata da',
    savedAt: 'Salvata il',
    changed: 'Cosa è cambiato',
    actions: 'Azioni',
    restoreBlocked:
      'Questa versione non può essere ripristinata: manca un valore obbligatorio o ne contiene uno che le regole attuali rifiutano. Aprila per vedere quale.',
    current: 'Corrente',
    restoredFrom: (m: number) => `Ripristinata dalla versione ${m}`,
    sameAs: (m: number) => `Stessi dati della versione ${m}`,
    system: 'Sistema',
    moved: 'Portata dal CRM',
    open: (n: number) => `Apri la versione ${n}`,
    restore: (n: number) => `Ripristina la versione ${n}`,
    empty: 'Nessuna versione',
  },
  version: {
    title: (n: number) => `Stai guardando la versione ${n} (sola lettura)`,
    body: (who: string, when: string, current: number) =>
      `Salvata da ${who} il ${when}. La versione corrente è la ${current}.`,
    back: 'Torna alla cronologia',
    restore: 'Ripristina questa versione',
    notCurrent: 'Non corrente',
    blocked: (list: string, entity: string) =>
      `Questa versione non può essere ripristinata: ${list}. Ripristinarla renderebbe di nuovo incompleta ${entity}.`,
    notFound: 'Questa versione non esiste.',
  },
  restore: {
    title: (n: number) => `Ripristinare la versione ${n}?`,
    body: (n: number, next: number, current: number) =>
      `Questo crea la versione ${next} con gli stessi dati della versione ${n} e la rende quella corrente. La versione ${current} e il resto della cronologia restano come sono.`,
    changes: (list: string) => `Rispetto alla versione corrente cambiano: ${list}.`,
    confirm: (n: number) => `Ripristina la versione ${n}`,
    busy: 'Ripristino in corso…',
    done: (next: number, n: number) => `Versione ${next} creata dalla versione ${n}`,
    refused: (n: number, list: string) => `La versione ${n} non può essere ripristinata: ${list}. Nulla è cambiato.`,
    conflict: 'Nel frattempo è stata salvata una versione più recente. La cronologia è stata ricaricata; controllala e riprova.',
    failed: (n: number) => `La versione ${n} non è stata ripristinata. Nulla è cambiato. Riprova.`,
  },
  load: {
    failed: 'Non è stato possibile caricare le società del gruppo',
  },
  sections: {
    loading: 'Caricamento…',
    failed: 'Non è stato possibile caricare le sezioni',
  },
}
