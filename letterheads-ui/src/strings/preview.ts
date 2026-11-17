/** The live preview of the sample document (design § Copy keys "Preview"; F3, F4, S7). */
const en = {
  title: 'Preview',
  region: 'Preview of the sample document',
  sourceLine:
    'The company details (name, address, VAT number, IBAN, contacts) are the real ones from Legal entities, in the preview language. The body of the page is sample text.',
  sourceLink: 'Edit them in Legal entities',
  sourceAdmin: 'An administrator keeps them in Legal entities.',
  legendMark: '⟦Label⟧',
  legend: 'A detail that is not filled in yet.',
  unavailableTitle: 'The company details could not be read',
  unavailableBody:
    'Every company detail is shown as missing. The sample body and your settings are unaffected. This is only a preview; documents are not made while the details cannot be read.',
  language: 'Preview language',
  it: 'Italian',
  en: 'English',
  pages: (n: number) => (n === 1 ? '1 page' : `${n} pages`),
  updating: 'Updating the preview…',
  failedShort: 'Could not update',
  loading: 'Preparing the preview…',
  pageAlt: (n: number, total: number) => `Page ${n} of ${total}`,
  failedTitle: 'The preview could not be updated',
  failedBody: 'The pages shown are from your last successful preview. Your changes are kept and you can still save.',
  failedFirstBody: 'There is no preview yet. Your changes are kept and you can still save.',
  retry: 'Try again',
  close: 'Close the preview',
}

const it: typeof en = {
  title: 'Anteprima',
  region: 'Anteprima del documento di esempio',
  sourceLine:
    'I dati dell’azienda (ragione sociale, indirizzo, partita IVA, IBAN, contatti) sono quelli reali di Società del gruppo, nella lingua dell’anteprima. Il corpo della pagina è un testo di esempio.',
  sourceLink: 'Modificali in Società del gruppo',
  sourceAdmin: 'Li gestisce un amministratore in Società del gruppo.',
  legendMark: '⟦Etichetta⟧',
  legend: 'Un dato non ancora compilato.',
  unavailableTitle: 'Non è stato possibile leggere i dati dell’azienda',
  unavailableBody:
    'Ogni dato dell’azienda è mostrato come mancante. Il corpo di esempio e le tue impostazioni non cambiano. È solo un’anteprima; i documenti non vengono creati finché i dati non si possono leggere.',
  language: 'Lingua dell’anteprima',
  it: 'Italiano',
  en: 'Inglese',
  pages: (n: number) => (n === 1 ? '1 pagina' : `${n} pagine`),
  updating: 'Aggiornamento dell’anteprima…',
  failedShort: 'Aggiornamento non riuscito',
  loading: 'Preparazione dell’anteprima…',
  pageAlt: (n: number, total: number) => `Pagina ${n} di ${total}`,
  failedTitle: 'Non è stato possibile aggiornare l’anteprima',
  failedBody:
    'Le pagine mostrate sono dell’ultima anteprima riuscita. Le tue modifiche sono conservate e puoi ancora salvare.',
  failedFirstBody: 'Non c’è ancora un’anteprima. Le tue modifiche sono conservate e puoi ancora salvare.',
  retry: 'Riprova',
  close: 'Chiudi l’anteprima',
}

export const preview = { en, it }
