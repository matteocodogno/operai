/** Copy for the upload card (F6, US-3, AC-3.1 to AC-3.3). */
const en = {
  title: 'Upload a recording',
  hint: 'Audio or video, up to 500 MiB and 3 hours. Only the audio is used; no image is kept.',
  fileLabel: 'Recording file',
  choose: 'Choose file',
  clear: 'Remove file',
  empty: 'No file chosen',
  /** The file size next to its name, in the binary units the 500 MiB limit is stated in. `value` is already formatted. */
  size: {
    bytes: (value: string) => `${value} bytes`,
    kib: (value: string) => `${value} KiB`,
    mib: (value: string) => `${value} MiB`,
    gib: (value: string) => `${value} GiB`,
  },
  checking: 'Checking the file…',
  /** AC-3.2: the reason, named, on the field. The first four are also the server's `upload_rejected` reasons. */
  problems: {
    unsupported_type: "This file type isn't supported",
    too_large: 'The file is larger than 500 MiB',
    too_long: 'The recording is longer than 3 hours',
    no_audio: 'The file has no audio track',
    empty: 'The file is empty',
  },
  /** A rejection whose reason this version does not know. */
  rejectedUnknown: 'This file was rejected. Check its type, size and length.',
  /** A draft whose last uploaded file was refused while it was decoded and removed (AC-3.2): says why, then the normal upload follows. */
  refused: {
    title: 'The last file you uploaded was removed',
    reasons: {
      too_long: 'It was longer than 3 hours. Choose a shorter recording to try again.',
    },
    /** A reason this version does not know. */
    unknownReason: 'It could not be accepted. Choose another file to try again.',
  },
  submit: 'Upload and process',
  uploading: 'Uploading…',
  progressLabel: 'Uploading the recording',
  /** The text beside the bar; `value` is a formatted percentage. */
  progress: (value: string) => `${value} uploaded`,
  cancel: 'Cancel upload',
  finishing: 'Upload complete. Starting processing…',
  failed: 'The upload failed. Nothing was processed.',
  cancelled: 'The upload was cancelled. Nothing was processed.',
  retry: 'Try again',
  announcements: {
    started: 'Upload started',
    complete: 'Upload complete, processing started',
  },
}

const it: typeof en = {
  title: 'Carica una registrazione',
  hint: "Audio o video, fino a 500 MiB e 3 ore. Viene usato solo l'audio; nessuna immagine viene conservata.",
  fileLabel: 'File della registrazione',
  choose: 'Scegli file',
  clear: 'Rimuovi file',
  empty: 'Nessun file scelto',
  size: {
    bytes: (value: string) => `${value} byte`,
    kib: (value: string) => `${value} KiB`,
    mib: (value: string) => `${value} MiB`,
    gib: (value: string) => `${value} GiB`,
  },
  checking: 'Controllo del file…',
  problems: {
    unsupported_type: 'Questo tipo di file non è supportato',
    too_large: 'Il file supera i 500 MiB',
    too_long: 'La registrazione dura più di 3 ore',
    no_audio: 'Il file non contiene una traccia audio',
    empty: 'Il file è vuoto',
  },
  rejectedUnknown: 'Questo file è stato rifiutato. Controlla tipo, dimensione e durata.',
  refused: {
    title: "L'ultimo file caricato è stato rimosso",
    reasons: {
      too_long: 'Durava più di 3 ore. Scegli una registrazione più breve per riprovare.',
    },
    unknownReason: 'Non è stato possibile accettarlo. Scegli un altro file per riprovare.',
  },
  submit: 'Carica ed elabora',
  uploading: 'Caricamento…',
  progressLabel: 'Caricamento della registrazione',
  progress: (value: string) => `${value} caricato`,
  cancel: 'Annulla caricamento',
  finishing: "Caricamento completato. Avvio dell'elaborazione…",
  failed: 'Il caricamento non è riuscito. Non è stato elaborato nulla.',
  cancelled: 'Il caricamento è stato annullato. Non è stato elaborato nulla.',
  retry: 'Riprova',
  announcements: {
    started: 'Caricamento avviato',
    complete: 'Caricamento completato, elaborazione avviata',
  },
}

export const upload = { en, it }
