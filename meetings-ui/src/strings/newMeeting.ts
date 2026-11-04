/** The new meeting page (S2, F1, F2). */
const en = {
  heading: 'New meeting',
  back: 'Back to meetings',
  detailsTitle: 'Details',
  linkedTo: 'Linked to',
  loadingHost: 'Looking up the linked record…',
  fields: {
    title: 'Title',
    titleHint: 'Up to 200 characters.',
    format: 'Format',
    startsAt: 'Date and time',
    startsAtHint: 'Now by default. It can be in the past.',
    language: 'Language',
    languageHint: 'The transcript is not translated.',
    source: 'Source',
  },
  format: {
    in_person: 'In person',
    online: 'Online',
  },
  language: {
    en: 'English',
    it: 'Italian',
  },
  source: {
    recorded: 'Record in the browser',
    recordedHint: 'Asks you to confirm consent before recording.',
    uploaded: 'Upload a recording',
    uploadedHint: 'Asks you to confirm consent before uploading.',
    text: 'Paste text',
    textHint: 'Notes or a transcript you already have.',
  },
  errors: {
    titleRequired: 'Enter a title.',
    titleTooLong: 'Use at most 200 characters.',
    startsAtInvalid: 'Enter a valid date and time.',
    summary: 'Some fields need attention. Nothing was created.',
  },
  submit: 'Create meeting',
  submitting: 'Creating…',
  cancel: 'Cancel',
  host: {
    notFound: {
      title: "We can't find that item, or you can't open it",
      body: 'It may have been deleted, or you may not have access to it. You can still start a meeting that is not linked to anything.',
      standalone: 'Start a standalone meeting',
    },
    unavailable: {
      title: (entity: string) => `We can't check the ${entity} right now`,
      body: 'The meeting was not created. Try again, or start it without linking.',
      standalone: 'Start without linking',
    },
  },
}

const it: typeof en = {
  heading: 'Nuova riunione',
  back: 'Torna alle riunioni',
  detailsTitle: 'Dettagli',
  linkedTo: 'Collegata a',
  loadingHost: 'Ricerca del record collegato…',
  fields: {
    title: 'Titolo',
    titleHint: 'Al massimo 200 caratteri.',
    format: 'Formato',
    startsAt: 'Data e ora',
    startsAtHint: 'Adesso per impostazione predefinita. Può essere nel passato.',
    language: 'Lingua',
    languageHint: 'La trascrizione non viene tradotta.',
    source: 'Sorgente',
  },
  format: {
    in_person: 'Di persona',
    online: 'Online',
  },
  language: {
    en: 'Inglese',
    it: 'Italiano',
  },
  source: {
    recorded: 'Registra nel browser',
    recordedHint: 'Ti chiede di confermare il consenso prima di registrare.',
    uploaded: 'Carica una registrazione',
    uploadedHint: 'Ti chiede di confermare il consenso prima del caricamento.',
    text: 'Incolla un testo',
    textHint: 'Appunti o una trascrizione che hai già.',
  },
  errors: {
    titleRequired: 'Inserisci un titolo.',
    titleTooLong: 'Usa al massimo 200 caratteri.',
    startsAtInvalid: 'Inserisci una data e un’ora valide.',
    summary: 'Alcuni campi richiedono attenzione. Non è stato creato nulla.',
  },
  submit: 'Crea riunione',
  submitting: 'Creazione…',
  cancel: 'Annulla',
  host: {
    notFound: {
      title: 'Non troviamo questo elemento, oppure non puoi aprirlo',
      body: 'Potrebbe essere stato eliminato oppure potresti non avere accesso. Puoi comunque avviare una riunione non collegata a nulla.',
      standalone: 'Avvia una riunione indipendente',
    },
    unavailable: {
      title: (entity: string) => `Al momento non riusciamo a controllare questo elemento (${entity})`,
      body: 'La riunione non è stata creata. Riprova, oppure avviala senza collegarla.',
      standalone: 'Avvia senza collegare',
    },
  },
}

export const newMeeting = { en, it }
