/**
 * Copy for the meeting page frame (S3): header, banners, the details card, the status panels
 * and the tab labels (T57), and the host-notice failure banner (T59, F11). The host's own
 * wording (`noticeFailed`, `visibilityHint`) is NOT here: it comes from `GET /hosts` (plan G7, G6).
 */
const en = {
  back: 'Back to meetings',
  backMine: 'Back to my meetings',
  fallbackTitle: 'Meeting',
  loading: 'Loading the meeting…',
  notFound: {
    title: 'Meeting not found',
    body: 'It may have been deleted, or you may not have access to it.',
  },
  actions: {
    editDetails: 'Edit details',
    deleteMeeting: 'Delete meeting',
  },
  format: {
    in_person: 'In person',
    online: 'Online',
  },
  source: {
    recorded: 'Recorded',
    uploaded: 'Uploaded',
    text: 'Text',
  },
  language: {
    en: 'English',
    it: 'Italian',
  },
  banners: {
    frozen: "Frozen: its creator's account is deactivated",
    creatorUnknown: "We can't check whether the creator's account is active. Editing is unavailable for now.",
    refreshFailed: 'The meeting could not be reloaded.',
  },
  hostNotice: {
    changedFailed: 'The linked record could not be updated',
    retry: 'Try again',
    saved: 'The linked record was updated',
  },
  saved: {
    details: 'Details saved',
    created: 'Meeting created',
  },
  details: {
    title: 'Details',
    facts: {
      date: 'Date and time',
      format: 'Format',
      language: 'Language',
      source: 'Source',
      creator: 'Creator',
      host: 'Host',
      duration: 'Duration',
      audio: 'Audio',
      consent: 'Consent',
      access: 'Your access',
    },
    deletedUser: 'Deleted user',
    unknownUser: 'Unknown user',
    host: {
      standalone: 'Standalone',
      noLongerAvailable: 'No longer available',
      open: (entity: string, title: string) => `${entity} · ${title}`,
      plain: (app: string, entity: string) => `${app} · ${entity.toLowerCase()}`,
    },
    audio: {
      keptUntil: (date: string) => `Audio kept until ${date}`,
      deleted: 'Audio deleted',
    },
    consent: {
      line: (name: string, date: string, version: string) => `Confirmed by ${name} on ${date}, notice ${version}`,
      none: 'Not confirmed yet',
    },
    access: {
      creator: 'Creator',
      participant: 'Participant',
      viaHost: (label: string) => `Because you can open ${label}`,
    },
  },
  panels: {
    draftEmpty: {
      title: 'Nothing captured yet',
      body: "The creator hasn't added the content yet.",
    },
    recordingInProgress: {
      title: 'Recording in progress',
      body: 'The transcript appears when the recording is finished.',
    },
    processing: {
      title: 'Processing',
      stages: {
        queued: 'Waiting to start',
        preparing: 'Preparing the audio',
        transcribing: 'Transcribing',
      },
      leaveNote: "You can leave this page. We'll notify you when it's ready.",
    },
    failed: {
      title: 'Processing failed',
      reasons: {
        audio_unreadable: 'The audio could not be read.',
        provider_unavailable: 'The transcription service was not available.',
        provider_rejected: 'The transcription service could not process this audio.',
        too_long: 'The audio is longer than the limit.',
      },
      unknownReason: 'Something went wrong while processing the meeting.',
      audioDeleted: "The audio was deleted, so this can't be processed again.",
      retry: 'Try again',
    },
  },
  tabs: {
    label: 'Meeting content',
    summaries: 'Summaries',
    transcript: 'Transcript',
    passages: 'Passages',
    ask: 'Ask the meeting',
  },
  recordingCard: {
    title: 'Recording',
    deleteRecording: 'Delete recording',
  },
}

const it: typeof en = {
  back: 'Torna alle riunioni',
  backMine: 'Torna alle mie riunioni',
  fallbackTitle: 'Riunione',
  loading: 'Caricamento della riunione…',
  notFound: {
    title: 'Riunione non trovata',
    body: 'Potrebbe essere stata eliminata oppure potresti non avere accesso.',
  },
  actions: {
    editDetails: 'Modifica dettagli',
    deleteMeeting: 'Elimina riunione',
  },
  format: {
    in_person: 'Di persona',
    online: 'Online',
  },
  source: {
    recorded: 'Registrata',
    uploaded: 'Caricata',
    text: 'Testo',
  },
  language: {
    en: 'Inglese',
    it: 'Italiano',
  },
  banners: {
    frozen: "Bloccata: l'account di chi l'ha creata è disattivato",
    creatorUnknown:
      "Non possiamo verificare se l'account di chi ha creato la riunione è attivo. Per ora la modifica non è disponibile.",
    refreshFailed: 'Non è stato possibile ricaricare la riunione.',
  },
  hostNotice: {
    changedFailed: 'Non è stato possibile aggiornare il record collegato',
    retry: 'Riprova',
    saved: 'Il record collegato è stato aggiornato',
  },
  saved: {
    details: 'Dettagli salvati',
    created: 'Riunione creata',
  },
  details: {
    title: 'Dettagli',
    facts: {
      date: 'Data e ora',
      format: 'Formato',
      language: 'Lingua',
      source: 'Sorgente',
      creator: 'Creata da',
      host: 'Collegata a',
      duration: 'Durata',
      audio: 'Audio',
      consent: 'Consenso',
      access: 'Il tuo accesso',
    },
    deletedUser: 'Utente eliminato',
    unknownUser: 'Utente sconosciuto',
    host: {
      standalone: 'Autonoma',
      noLongerAvailable: 'Non più disponibile',
      open: (entity: string, title: string) => `${entity} · ${title}`,
      plain: (app: string, entity: string) => `${app} · ${entity.toLowerCase()}`,
    },
    audio: {
      keptUntil: (date: string) => `Audio conservato fino al ${date}`,
      deleted: 'Audio eliminato',
    },
    consent: {
      line: (name: string, date: string, version: string) => `Confermato da ${name} il ${date}, informativa ${version}`,
      none: 'Non ancora confermato',
    },
    access: {
      creator: 'Creatore',
      participant: 'Partecipante',
      viaHost: (label: string) => `Perché puoi aprire ${label}`,
    },
  },
  panels: {
    draftEmpty: {
      title: 'Ancora nulla di acquisito',
      body: 'Chi ha creato la riunione non ha ancora aggiunto il contenuto.',
    },
    recordingInProgress: {
      title: 'Registrazione in corso',
      body: 'La trascrizione compare quando la registrazione è terminata.',
    },
    processing: {
      title: 'Elaborazione',
      stages: {
        queued: 'In attesa di iniziare',
        preparing: "Preparazione dell'audio",
        transcribing: 'Trascrizione',
      },
      leaveNote: 'Puoi lasciare questa pagina. Ti avviseremo quando è pronta.',
    },
    failed: {
      title: 'Elaborazione non riuscita',
      reasons: {
        audio_unreadable: "Non è stato possibile leggere l'audio.",
        provider_unavailable: 'Il servizio di trascrizione non era disponibile.',
        provider_rejected: 'Il servizio di trascrizione non è riuscito a elaborare questo audio.',
        too_long: "L'audio supera la durata massima.",
      },
      unknownReason: "Qualcosa è andato storto durante l'elaborazione della riunione.",
      audioDeleted: "L'audio è stato eliminato: non può essere elaborato di nuovo.",
      retry: 'Riprova',
    },
  },
  tabs: {
    label: 'Contenuto della riunione',
    summaries: 'Riassunti',
    transcript: 'Trascrizione',
    passages: 'Brani',
    ask: 'Chiedi alla riunione',
  },
  recordingCard: {
    title: 'Registrazione',
    deleteRecording: 'Elimina registrazione',
  },
}

export const meeting = { en, it }
