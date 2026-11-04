/** Copy for the audio control (S3b) and the Delete recording dialog (S3c). */
const en = {
  label: 'Meeting audio',
  keptUntil: (date: string) => `Audio kept until ${date}`,
  deleted: 'Audio deleted',
  playbackFailed: 'The audio could not be played. Reload the page and try again.',
  deleteRecording: {
    button: 'Delete recording',
    title: 'Delete the recording?',
    body: 'The audio is deleted now and cannot be recovered or played again. The transcript and summaries stay. A failed transcription can no longer be retried.',
    confirm: 'Delete recording',
    busy: 'Deleting…',
  },
}

const it: typeof en = {
  label: 'Audio della riunione',
  keptUntil: (date: string) => `Audio conservato fino al ${date}`,
  deleted: 'Audio eliminato',
  playbackFailed: 'Non è stato possibile riprodurre l’audio. Ricarica la pagina e riprova.',
  deleteRecording: {
    button: 'Elimina la registrazione',
    title: 'Eliminare la registrazione?',
    body: 'L’audio viene eliminato subito e non si potrà più recuperare né riprodurre. La trascrizione e i riassunti restano. Una trascrizione non riuscita non potrà più essere ritentata.',
    confirm: 'Elimina la registrazione',
    busy: 'Eliminazione…',
  },
}

export const audio = { en, it }
