/** Copy for the Ask panel (S3b): the conversation, the composer, the sources. */
const en = {
  loading: 'Loading your conversation…',
  privacy: 'Only you can see your questions and the answers.',
  conversationLabel: 'Your conversation with this meeting',
  empty: {
    heading: 'Ask this meeting a question',
    body: 'Answers use only this meeting’s transcript and show where they come from.',
  },
  you: 'You',
  aiGenerated: 'AI-generated',
  thinking: 'Thinking…',
  failed: 'This question could not be answered.',
  tryAgain: 'Try again',
  sources: 'Sources',
  source: (time: string, speaker: string | null) => (speaker === null ? time : `${time} · ${speaker}`),
  sourcePassage: (ordinal: number) => `Passage ${ordinal}`,
  composer: {
    label: 'Your question',
    hint: 'Press Ctrl+Enter (Cmd+Enter on a Mac) to send. Enter adds a new line.',
    counter: (n: number) => `${n} / 1000`,
    ask: 'Ask',
    asking: 'Asking…',
    required: 'Enter a question.',
    tooLong: 'A question can be at most 1,000 characters.',
    noSpeech: 'No speech was detected, so there is nothing to ask about.',
  },
  rateLimited: (when: string) => `You have reached the limit of AI requests. Try again after ${when}.`,
  clear: {
    button: 'Clear conversation',
    title: 'Clear your conversation?',
    body: 'Only you can see it; this removes it for you and can’t be undone.',
    confirm: 'Clear conversation',
    busy: 'Clearing…',
  },
}

const it: typeof en = {
  loading: 'Caricamento della conversazione…',
  privacy: 'Solo tu puoi vedere le tue domande e le risposte.',
  conversationLabel: 'La tua conversazione con questa riunione',
  empty: {
    heading: 'Fai una domanda a questa riunione',
    body: 'Le risposte usano solo la trascrizione di questa riunione e mostrano da dove vengono.',
  },
  you: 'Tu',
  aiGenerated: 'Generato dall’IA',
  thinking: 'Sto pensando…',
  failed: 'Non è stato possibile rispondere a questa domanda.',
  tryAgain: 'Riprova',
  sources: 'Fonti',
  source: (time: string, speaker: string | null) => (speaker === null ? time : `${time} · ${speaker}`),
  sourcePassage: (ordinal: number) => `Passaggio ${ordinal}`,
  composer: {
    label: 'La tua domanda',
    hint: 'Premi Ctrl+Invio (Cmd+Invio su Mac) per inviare. Invio va a capo.',
    counter: (n: number) => `${n} / 1000`,
    ask: 'Chiedi',
    asking: 'Invio…',
    required: 'Scrivi una domanda.',
    tooLong: 'Una domanda può avere al massimo 1.000 caratteri.',
    noSpeech: 'Non è stato rilevato parlato, quindi non c’è nulla da chiedere.',
  },
  rateLimited: (when: string) => `Hai raggiunto il limite di richieste all’IA. Riprova dopo ${when}.`,
  clear: {
    button: 'Cancella la conversazione',
    title: 'Cancellare la conversazione?',
    body: 'Solo tu puoi vederla; la cancelli per te e non si può annullare.',
    confirm: 'Cancella la conversazione',
    busy: 'Cancellazione…',
  },
}

export const ask = { en, it }
