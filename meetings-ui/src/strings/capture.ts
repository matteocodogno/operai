/**
 * Copy for the recording panel and capture options (S5, F4) and the interrupted panel (F5).
 * Quoted ACs read exactly as in design.md § Copy keys plan: indicator.recording / paused,
 * save.notSaved, interrupted.process / discard.
 */
const en = {
  /** Card title while a recording is running. */
  heading: 'Recording',
  options: {
    title: 'Record this meeting',
    sourceLabel: 'What to record',
    micOnly: 'Microphone only',
    micAndTab: 'Microphone and the audio of a shared browser tab',
    tabHint: 'Choose the tab with your meeting and tick "Share tab audio".',
    unsupportedTab:
      "This browser can't capture the other participants' audio. Uploading a recording of the meeting gives a better result.",
    micOnlyWarning: 'With the microphone only, remote voices are captured only if they play through your speakers.',
  },
  start: 'Start recording',
  starting: 'Starting…',
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop and save',
  indicator: { recording: 'Recording', paused: 'Paused' },
  elapsed: 'Elapsed time',
  save: {
    allSaved: 'All audio saved',
    saving: 'Saving…',
    /** The status line while chunks wait; `seconds` is already formatted. */
    notSavedLine: (seconds: string) => `Audio not yet saved (about ${seconds} s waiting)`,
    /** The banner: AC-2.9. */
    notSaved: 'Audio not yet saved. It survives only while this tab stays open.',
    progressLabel: 'Saving audio',
    progress: (done: string, total: string) => `Saving audio: ${done} of ${total}`,
    stalled: 'Some audio could not be saved. Keep this tab open while we retry.',
  },
  /** The browser refused the microphone (AC-2.3): what to change, and the alternatives are offered below. */
  denied: {
    title: 'Microphone access is blocked',
    body: "Allow the microphone for this site in your browser's address bar or settings, then choose Start recording again. Nothing was recorded.",
  },
  noDevice: {
    title: 'No microphone found',
    body: 'Connect a microphone, then choose Start recording again. Nothing was recorded.',
  },
  micUnavailable: {
    title: "The microphone can't be used",
    body: 'Another app may be using it. Close that app, then choose Start recording again. Nothing was recorded.',
  },
  tabCancelled: {
    title: 'No tab was shared',
    body: 'Choose Start recording again and pick the tab with your meeting, or record the microphone only.',
  },
  recorderFailed: {
    title: "The recording couldn't start",
    body: 'Your browser reported a problem with the recorder. Try again, or upload a recording instead.',
  },
  unsupported: {
    title: "This browser can't record",
    body: 'Recording needs a recent browser. Upload a recording of the meeting instead, or paste text.',
    insecure: 'Recording needs a secure (https) connection. Upload a recording of the meeting instead, or paste text.',
  },
  alternatives: {
    upload: 'Upload a recording instead',
    text: 'Paste text instead',
    textNote: 'Pasting text needs no consent confirmation, so the confirmation is removed.',
  },
  tabEnded: 'The meeting audio is no longer being captured. Your microphone is still recording.',
  restored: 'Connection restored. Saving audio.',
  limitWarning: 'This recording stops by itself in 10 minutes (limit 3 hours).',
  autoStopped: 'The recording reached 3 hours, was stopped and is being saved.',
  micLost: {
    title: 'The microphone stopped',
    body: 'Reconnect it and choose Resume, or stop and save what was captured.',
  },
  resumeFailed: {
    denied: 'Microphone access is blocked. Allow it for this site, then choose Resume.',
    no_device: 'No microphone found. Connect one, then choose Resume.',
    other: "The microphone can't be used. Close other apps using it, then choose Resume.",
  },
  /** The recording ended abnormally: the server refused, or the meeting went away. */
  failed: {
    title: 'The recording stopped',
    body: 'Audio that was not yet saved was lost. What was saved before is kept.',
    refresh: 'Refresh',
  },
  gone: { title: 'This meeting is no longer available', body: 'It may have been deleted. The recording was stopped.' },
  empty: 'Nothing was recorded. The meeting is a draft again.',
  /** Another tab or device holds the recording (S3a). */
  elsewhere: {
    body: 'This meeting is being recorded in another tab or on another device. If that tab was closed, the status changes to Interrupted after about 2 minutes.',
    refresh: 'Refresh',
  },
  /** The shell's confirmation when leaving the tool while recording (AC-2.10). */
  leaveMessage:
    'A recording is in progress or audio is not yet saved. Leaving stops the recording and saves what was captured.',
  announcements: {
    started: 'Recording started',
    paused: 'Recording paused',
    resumed: 'Recording resumed',
    stopped: 'Recording stopped. Saving audio.',
    saved: 'Recording saved, processing started',
  },
  /** The interrupted panel (F5, AC-2.8, AC-2.9). */
  interrupted: {
    title: (duration: string) => `Recording interrupted. Saved audio: ${duration}.`,
    titleEmpty: 'Recording interrupted. No audio was saved.',
    lostAtLeast: (duration: string) => `At least ${duration} of audio captured while offline was lost.`,
    lostUnknown: 'Some audio recorded while offline may have been lost.',
    process: 'Process what was captured',
    processing: 'Processing…',
    discard: 'Discard',
    discardTitle: 'Discard the captured audio?',
    discardBody: "The meeting returns to draft and the audio is deleted now. This can't be undone.",
    discardConfirm: 'Discard audio',
    discarding: 'Discarding…',
    expired: "The captured audio was deleted after 30 days and can't be processed.",
    observer: 'This recording was interrupted. Its creator can choose to process what was captured.',
  },
}

const it: typeof en = {
  heading: 'Registrazione',
  options: {
    title: 'Registra questa riunione',
    sourceLabel: 'Cosa registrare',
    micOnly: 'Solo il microfono',
    micAndTab: 'Microfono e audio di una scheda del browser condivisa',
    tabHint: 'Scegli la scheda con la tua riunione e seleziona "Condividi audio scheda".',
    unsupportedTab:
      "Questo browser non può registrare l'audio degli altri partecipanti. Caricare una registrazione della riunione dà un risultato migliore.",
    micOnlyWarning: 'Con il solo microfono, le voci a distanza vengono registrate solo se escono dagli altoparlanti.',
  },
  start: 'Avvia registrazione',
  starting: 'Avvio…',
  pause: 'Pausa',
  resume: 'Riprendi',
  stop: 'Termina e salva',
  indicator: { recording: 'In registrazione', paused: 'In pausa' },
  elapsed: 'Tempo trascorso',
  save: {
    allSaved: 'Tutto l’audio è salvato',
    saving: 'Salvataggio…',
    notSavedLine: (seconds: string) => `Audio non ancora salvato (circa ${seconds} s in attesa)`,
    notSaved: 'Audio non ancora salvato. Resta disponibile solo finché questa scheda rimane aperta.',
    progressLabel: 'Salvataggio dell’audio',
    progress: (done: string, total: string) => `Salvataggio dell’audio: ${done} di ${total}`,
    stalled: "Non è stato possibile salvare parte dell'audio. Tieni aperta questa scheda mentre riproviamo.",
  },
  denied: {
    title: "L'accesso al microfono è bloccato",
    body: 'Consenti il microfono per questo sito nella barra degli indirizzi o nelle impostazioni del browser, poi scegli di nuovo Avvia registrazione. Non è stato registrato nulla.',
  },
  noDevice: {
    title: 'Nessun microfono trovato',
    body: 'Collega un microfono, poi scegli di nuovo Avvia registrazione. Non è stato registrato nulla.',
  },
  micUnavailable: {
    title: 'Impossibile usare il microfono',
    body: "Potrebbe essere in uso da un'altra app. Chiudila, poi scegli di nuovo Avvia registrazione. Non è stato registrato nulla.",
  },
  tabCancelled: {
    title: 'Nessuna scheda condivisa',
    body: 'Scegli di nuovo Avvia registrazione e seleziona la scheda con la tua riunione, oppure registra solo il microfono.',
  },
  recorderFailed: {
    title: 'Impossibile avviare la registrazione',
    body: 'Il browser ha segnalato un problema con il registratore. Riprova, oppure carica una registrazione.',
  },
  unsupported: {
    title: 'Questo browser non può registrare',
    body: 'La registrazione richiede un browser recente. Carica invece una registrazione della riunione, oppure incolla il testo.',
    insecure:
      'La registrazione richiede una connessione sicura (https). Carica invece una registrazione della riunione, oppure incolla il testo.',
  },
  alternatives: {
    upload: 'Carica invece una registrazione',
    text: 'Incolla invece il testo',
    textNote: 'Incollare il testo non richiede la conferma del consenso, quindi la conferma viene rimossa.',
  },
  tabEnded: "L'audio della riunione non viene più registrato. Il microfono sta ancora registrando.",
  restored: 'Connessione ripristinata. Salvataggio dell’audio in corso.',
  limitWarning: 'Questa registrazione si interrompe da sola tra 10 minuti (limite 3 ore).',
  autoStopped: 'La registrazione ha raggiunto le 3 ore, è stata interrotta ed è in corso di salvataggio.',
  micLost: {
    title: 'Il microfono si è fermato',
    body: 'Ricollegalo e scegli Riprendi, oppure termina e salva quanto registrato.',
  },
  resumeFailed: {
    denied: "L'accesso al microfono è bloccato. Consentilo per questo sito, poi scegli Riprendi.",
    no_device: 'Nessun microfono trovato. Collegane uno, poi scegli Riprendi.',
    other: 'Impossibile usare il microfono. Chiudi le altre app che lo usano, poi scegli Riprendi.',
  },
  failed: {
    title: 'La registrazione si è interrotta',
    body: "L'audio non ancora salvato è andato perso. Quanto era già salvato viene conservato.",
    refresh: 'Aggiorna',
  },
  gone: {
    title: 'Questa riunione non è più disponibile',
    body: 'Potrebbe essere stata eliminata. La registrazione è stata interrotta.',
  },
  empty: 'Non è stato registrato nulla. La riunione è di nuovo una bozza.',
  elsewhere: {
    body: 'Questa riunione è in registrazione in un’altra scheda o su un altro dispositivo. Se quella scheda è stata chiusa, lo stato diventa Interrotta dopo circa 2 minuti.',
    refresh: 'Aggiorna',
  },
  leaveMessage:
    "Una registrazione è in corso oppure c'è audio non ancora salvato. Uscendo, la registrazione si interrompe e quanto registrato viene salvato.",
  announcements: {
    started: 'Registrazione avviata',
    paused: 'Registrazione in pausa',
    resumed: 'Registrazione ripresa',
    stopped: 'Registrazione terminata. Salvataggio dell’audio in corso.',
    saved: 'Registrazione salvata, elaborazione avviata',
  },
  interrupted: {
    title: (duration: string) => `Registrazione interrotta. Audio salvato: ${duration}.`,
    titleEmpty: 'Registrazione interrotta. Nessun audio è stato salvato.',
    lostAtLeast: (duration: string) => `Almeno ${duration} di audio registrato offline sono andati persi.`,
    lostUnknown: "Parte dell'audio registrato offline potrebbe essere andata persa.",
    process: 'Elabora quanto registrato',
    processing: 'Elaborazione…',
    discard: 'Scarta',
    discardTitle: "Scartare l'audio registrato?",
    discardBody: "La riunione torna in bozza e l'audio viene eliminato subito. L'operazione non può essere annullata.",
    discardConfirm: "Scarta l'audio",
    discarding: 'Eliminazione…',
    expired: "L'audio registrato è stato eliminato dopo 30 giorni e non può essere elaborato.",
    observer: "Questa registrazione è stata interrotta. Chi l'ha creata può scegliere di elaborare quanto registrato.",
  },
}

export const capture = { en, it }
