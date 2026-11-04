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
  speaker: (index: number) => `Speaker ${index}`,
  unknownSpeaker: 'Unknown speaker',
  formerPerson: 'Former colleague',
  passage: (ordinal: number) => `Passage ${ordinal}`,
  playFrom: (spoken: string) => `Play from ${spoken}`,
  edited: 'Edited',
  citedPassage: 'Cited passage:',
  backToAnswer: 'Back to the answer',
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
  speaker: (index: number) => `Voce ${index}`,
  unknownSpeaker: 'Voce sconosciuta',
  formerPerson: 'Ex collega',
  passage: (ordinal: number) => `Passaggio ${ordinal}`,
  playFrom: (spoken: string) => `Riproduci da ${spoken}`,
  edited: 'Modificato',
  citedPassage: 'Passaggio citato:',
  backToAnswer: 'Torna alla risposta',
}

export const transcript = { en, it }
