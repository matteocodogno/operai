/** Copy for the Edit details dialog (S3c, F7b). */
const en = {
  title: 'Edit details',
  submit: 'Save',
  busy: 'Saving…',
  fields: {
    title: 'Title',
    startsAt: 'Date and time',
    format: 'Format',
    language: 'Language',
    source: 'Source',
  },
  languageFixed: 'The language is fixed once processing has started',
  sourceFixed: 'The source cannot change once audio or text has been added',
  sourceOptions: {
    recorded: 'Record in the browser',
    uploaded: 'Upload a recording',
    text: 'Paste text',
  },
  textClearsConsent: 'Pasting text needs no consent confirmation, so the confirmation is removed.',
  consentAskedAgain: 'Recording or uploading needs a consent confirmation. You will be asked for it next.',
  hostVisible: {
    label: (host: string) => `Also visible to people who can open ${host}`,
    /** The label with the host's own continuation phrase ("… and can see deal financials"). */
    labelWithHint: (host: string, hint: string) => `Also visible to people who can open ${host} ${hint}`,
  },
  removeLink: 'Remove link',
  removeLinkHint: "To link a different record, use that record's meetings panel.",
  errors: {
    titleRequired: 'Enter a title',
    titleTooLong: 'Use at most 200 characters',
    startsAtInvalid: 'Enter a valid date and time',
  },
}

const it: typeof en = {
  title: 'Modifica dettagli',
  submit: 'Salva',
  busy: 'Salvataggio…',
  fields: {
    title: 'Titolo',
    startsAt: 'Data e ora',
    format: 'Formato',
    language: 'Lingua',
    source: 'Sorgente',
  },
  languageFixed: "La lingua è fissata dopo l'avvio dell'elaborazione",
  sourceFixed: "La sorgente non si può cambiare dopo l'aggiunta di audio o testo",
  sourceOptions: {
    recorded: 'Registra nel browser',
    uploaded: 'Carica una registrazione',
    text: 'Incolla un testo',
  },
  textClearsConsent: 'Incollare un testo non richiede la conferma del consenso, quindi la conferma viene rimossa.',
  consentAskedAgain: 'Registrare o caricare richiede la conferma del consenso. Ti verrà chiesta subito dopo.',
  hostVisible: {
    label: (host: string) => `Visibile anche a chi può aprire ${host}`,
    labelWithHint: (host: string, hint: string) => `Visibile anche a chi può aprire ${host} ${hint}`,
  },
  removeLink: 'Rimuovi collegamento',
  removeLinkHint: 'Per collegare un altro record, usa il pannello riunioni di quel record.',
  errors: {
    titleRequired: 'Inserisci un titolo',
    titleTooLong: 'Usa al massimo 200 caratteri',
    startsAtInvalid: 'Inserisci una data e un’ora valide',
  },
}

export const editDetails = { en, it }
