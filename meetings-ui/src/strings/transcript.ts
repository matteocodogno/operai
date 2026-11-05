/** Copy for the transcript view (S3b): reading, searching, copying, downloading. */
const en = {
  heading: 'Transcript',
  passagesHeading: 'Passages',
  loading: 'Loading the transcript…',
  searchLabel: 'Search the transcript',
  matches: (n: number) => (n === 1 ? '1 match' : `${n} matches`),
  copy: 'Copy',
  download: 'Download text',
  copied: 'Transcript copied to the clipboard.',
  copyFailed: 'Could not copy. Select the text and copy it yourself.',
  downloadFileName: 'transcript',
  noSpeech: {
    heading: 'No speech detected',
    body: 'Nothing was said in this recording, so there is no transcript. Summaries and questions are not available.',
  },
  empty: {
    heading: 'No transcript',
    body: 'This meeting has no transcript.',
  },
  /**
   * Transcript parts (AC-6.2, AC-6.15): shown only when a later part's label stayed separate. It never
   * says the labels are different people, and never that speakers are "numbered separately".
   */
  parts: {
    banner: (n: number) =>
      `This recording was transcribed in ${n} parts. Speakers could not always be matched between parts, so one person can appear under two labels. Rename them to the same name to merge them.`,
    divider: (n: number, start: string) => `Part ${n} · ${start}`,
  },
  /** The possibly-incomplete notice and its markers (AC-6.12). `ranges` are clock times, `from`/`to`. */
  incomplete: {
    notice: (ranges: { from: string; to: string }[]) =>
      `This transcript may be incomplete. Speech may be missing between ${ranges
        .map((range) => `${range.from} and ${range.to}`)
        .join(', and between ')}. The missing speech is not in the transcript and cannot be recovered from it.`,
    rangesLabel: 'Ranges where speech may be missing',
    marker: (from: string, to: string) => `Possible gap ${from}–${to}`,
    play: 'Play',
  },
  /** A label matched across parts (AC-6.16). `parts` reads like "1–3" or "1, 3". */
  joined: {
    note: (parts: string) => `Matched automatically across parts ${parts}`,
    part: (n: number) => `Part ${n}`,
    separate: 'Separate by part',
    separateLabel: (name: string) => `Separate by part: ${name}`,
  },
  separate: {
    title: 'Separate by part?',
    body: (name: string) =>
      `Each part’s speech gets its own label. They keep the name “${name}” until you rename them. This cannot be undone.`,
    confirm: 'Separate',
    busy: 'Separating…',
    notJoined: 'These labels are already separate.',
  },
  speaker: (index: number) => `Speaker ${index}`,
  unknownSpeaker: 'Unknown speaker',
  formerPerson: 'Former colleague',
  passage: (ordinal: number) => `Passage ${ordinal}`,
  playFrom: (spoken: string) => `Play from ${spoken}`,
  edited: 'Edited',
  citedPassage: 'Cited passage:',
  backToAnswer: 'Back to the answer',
  editSegment: (time: string) => `Edit segment at ${time}`,
  editPassage: (ordinal: number) => `Edit passage ${ordinal}`,
  segmentTextLabel: 'Segment text',
  editHint: 'Summaries made earlier will be marked as based on an earlier version of the transcript.',
  saving: 'Saving…',
  textRequired: 'Enter the text of the segment.',
  textTooLong: 'The text can be at most 10,000 characters.',
  speakersHeading: 'Speakers',
  rename: (name: string) => `Rename ${name}`,
  renameTitle: 'Rename speaker',
  renameDescription: 'The new name applies to every segment of this speaker.',
  renameSubmit: 'Rename',
  whoSpoke: 'Who spoke',
  optionDefault: 'Back to the default name (Speaker n)',
  optionCustom: 'Another name…',
  nameLabel: 'Name',
  nameRequired: 'Enter a name.',
  nameTooLong: 'The name can be at most 100 characters.',
}

const it: typeof en = {
  heading: 'Trascrizione',
  passagesHeading: 'Passaggi',
  loading: 'Caricamento della trascrizione…',
  searchLabel: 'Cerca nella trascrizione',
  matches: (n: number) => (n === 1 ? '1 risultato' : `${n} risultati`),
  copy: 'Copia',
  download: 'Scarica il testo',
  copied: 'Trascrizione copiata negli appunti.',
  copyFailed: 'Impossibile copiare. Seleziona il testo e copialo tu.',
  downloadFileName: 'trascrizione',
  noSpeech: {
    heading: 'Nessun parlato rilevato',
    body: 'In questa registrazione non è stato detto nulla, quindi non c’è una trascrizione. Riassunti e domande non sono disponibili.',
  },
  empty: {
    heading: 'Nessuna trascrizione',
    body: 'Questa riunione non ha una trascrizione.',
  },
  parts: {
    banner: (n: number) =>
      `Questa registrazione è stata trascritta in ${n} parti. Non sempre è stato possibile abbinare i parlanti tra una parte e l’altra, quindi la stessa persona può comparire con due etichette. Rinominale con lo stesso nome per unirle.`,
    divider: (n: number, start: string) => `Parte ${n} · ${start}`,
  },
  incomplete: {
    notice: (ranges: { from: string; to: string }[]) =>
      `Questa trascrizione potrebbe essere incompleta. Potrebbe mancare del parlato tra ${ranges
        .map((range) => `${range.from} e ${range.to}`)
        .join(', e tra ')}. Il parlato mancante non è nella trascrizione e non può essere recuperato da essa.`,
    rangesLabel: 'Intervalli in cui potrebbe mancare del parlato',
    marker: (from: string, to: string) => `Possibile lacuna ${from}–${to}`,
    play: 'Riproduci',
  },
  joined: {
    note: (parts: string) => `Abbinata automaticamente tra le parti ${parts}`,
    part: (n: number) => `Parte ${n}`,
    separate: 'Separa per parte',
    separateLabel: (name: string) => `Separa per parte: ${name}`,
  },
  separate: {
    title: 'Separare per parte?',
    body: (name: string) =>
      `Il parlato di ogni parte ottiene una propria etichetta. Mantengono il nome “${name}” finché non le rinomini. L’operazione non si può annullare.`,
    confirm: 'Separa',
    busy: 'Separazione…',
    notJoined: 'Queste etichette sono già separate.',
  },
  speaker: (index: number) => `Voce ${index}`,
  unknownSpeaker: 'Voce sconosciuta',
  formerPerson: 'Ex collega',
  passage: (ordinal: number) => `Passaggio ${ordinal}`,
  playFrom: (spoken: string) => `Riproduci da ${spoken}`,
  edited: 'Modificato',
  citedPassage: 'Passaggio citato:',
  backToAnswer: 'Torna alla risposta',
  editSegment: (time: string) => `Modifica il segmento delle ${time}`,
  editPassage: (ordinal: number) => `Modifica il passaggio ${ordinal}`,
  segmentTextLabel: 'Testo del segmento',
  editHint: 'I riassunti creati prima saranno segnati come basati su una versione precedente della trascrizione.',
  saving: 'Salvataggio…',
  textRequired: 'Inserisci il testo del segmento.',
  textTooLong: 'Il testo può avere al massimo 10.000 caratteri.',
  speakersHeading: 'Voci',
  rename: (name: string) => `Rinomina ${name}`,
  renameTitle: 'Rinomina la voce',
  renameDescription: 'Il nuovo nome vale per tutti i segmenti di questa voce.',
  renameSubmit: 'Rinomina',
  whoSpoke: 'Chi ha parlato',
  optionDefault: 'Torna al nome predefinito (Voce n)',
  optionCustom: 'Un altro nome…',
  nameLabel: 'Nome',
  nameRequired: 'Inserisci un nome.',
  nameTooLong: 'Il nome può avere al massimo 100 caratteri.',
}

export const transcript = { en, it }
