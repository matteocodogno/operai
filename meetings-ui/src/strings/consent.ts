/**
 * Copy for the consent card (F3; AC-4.1, AC-4.2): the versioned notice, the announcement to read
 * aloud or paste, and the attestation. The legal wording belongs to the data-protection lead (O3):
 * ANY change to `statements` or `announcementText` bumps `version`, which is what the server stores
 * with the attestation (AC-4.3) and checks (409 `notice_outdated`).
 */
const en = {
  /** The notice version posted with the attestation. Identical in every language: it names the legal text, not a translation. */
  version: '2026-11-01',
  title: 'Consent to record',
  intro: 'Before any audio is captured, confirm that:',
  /** The five statements AC-4.1 requires, in this order. */
  statements: [
    'Everyone present has been told that this meeting is recorded and has agreed to it.',
    'The audio is transcribed and summarised by AI, and processed in the EU or Switzerland.',
    'The result can be read by you and by the participants you add. If you link a record and allow it, people who can open that record can read it too.',
    'The audio is kept for 30 days and then deleted. The transcript and summaries stay until the meeting is deleted.',
    'A recording banner shown by Zoom, Teams or Meet does not cover recording made with this tool.',
  ],
  announcementTitle: 'Announcement',
  announcementHint: 'Read it aloud at the start, or paste it in the meeting chat.',
  announcementText:
    'This meeting is being recorded. The audio will be transcribed and summarised by AI, processed in the EU or Switzerland, and the result will be available to me and to the participants. If anyone objects, please say so now and I will stop the recording.',
  copyAnnouncement: 'Copy announcement',
  copied: 'Announcement copied',
  copyFailed: 'The announcement could not be copied. Select the text and copy it.',
  confirmLabel: 'I have read this notice, and everyone present has been told and has agreed',
  continue: 'Continue',
  busy: 'Saving…',
  outdated: {
    message: 'The consent notice has changed. Reload the page to read it again.',
    reload: 'Reload',
  },
}

const it: typeof en = {
  version: '2026-11-01',
  title: 'Consenso alla registrazione',
  intro: 'Prima di acquisire qualsiasi audio, conferma che:',
  statements: [
    'Tutte le persone presenti sono state informate che la riunione viene registrata e hanno dato il proprio consenso.',
    "L'audio viene trascritto e riassunto da un'IA ed elaborato nell'UE o in Svizzera.",
    'Il risultato può essere letto da te e dai partecipanti che aggiungi. Se colleghi un record e lo consenti, possono leggerlo anche le persone che possono aprire quel record.',
    "L'audio viene conservato per 30 giorni e poi eliminato. La trascrizione e i riassunti restano finché la riunione non viene eliminata.",
    'Il banner di registrazione mostrato da Zoom, Teams o Meet non copre la registrazione fatta con questo strumento.',
  ],
  announcementTitle: 'Annuncio',
  announcementHint: "Leggilo ad alta voce all'inizio, oppure incollalo nella chat della riunione.",
  announcementText:
    "Questa riunione viene registrata. L'audio sarà trascritto e riassunto da un'IA, elaborata nell'UE o in Svizzera, e il risultato sarà disponibile a me e ai partecipanti. Se qualcuno non è d'accordo, lo dica ora e interromperò la registrazione.",
  copyAnnouncement: "Copia l'annuncio",
  copied: 'Annuncio copiato',
  copyFailed: 'Non è stato possibile copiare l’annuncio. Seleziona il testo e copialo.',
  confirmLabel: 'Ho letto questa informativa, e tutte le persone presenti sono state informate e hanno acconsentito',
  continue: 'Continua',
  busy: 'Salvataggio…',
  outdated: {
    message: "L'informativa sul consenso è cambiata. Ricarica la pagina per leggerla di nuovo.",
    reload: 'Ricarica',
  },
}

export const consent = { en, it }
