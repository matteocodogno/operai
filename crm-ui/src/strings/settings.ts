/** The Settings tab: letterhead and standard terms per entity (specs/20261101-crm-sales-flow O2). */
const en = {
  heading: 'Settings',
  description: 'The letterhead and standard terms printed on offers, one profile per wellD entity you manage deals for.',
  /** With the letterhead service on: the letterhead is set up in Letterheads, no longer here (specs/20261116-letterhead-service AC-10.11). */
  descriptionService:
    'The issuer details and standard terms printed on offers, one profile per wellD entity you manage deals for.',
  loading: 'Loading the settings…',
  emptyTitle: 'No entity to set up',
  emptyBody: 'You do not manage deals for any entity.',
  profile: (entity: string) => `${entity} profile`,
  /** The note where the legal fields were (specs/20261117-legal-entities AC-6.1, D5): the registry keeps them. */
  legalNote: 'Legal name, address, VAT number and IBAN are kept in Legal entities, not here.',
  legalNoteLink: 'Open Legal entities',
  legalNoteAdmin:
    'Legal name, address, VAT number and IBAN are kept on the Legal entities page (Admin). An administrator keeps them.',
  fields: {
    termsEn: 'Standard terms (English)',
    termsIt: 'Standard terms (Italian)',
    termsHint: 'Printed when an offer is generated without its own terms.',
    placeOfIssue: 'Place of issue',
    placeOfIssueHint: 'Printed beside the date of an offer. Leave empty for the default, Lugano.',
  },
  save: 'Save profile',
  saving: 'Saving…',
  saved: (entity: string) => `${entity} profile saved.`,
  updated: (date: string) => `Last saved ${date}`,
  numbering: {
    title: (entity: string) => `${entity} offer numbering`,
    loading: 'Loading the numbering…',
    year: 'Year',
    next: 'Next offer number',
    nextHint: (example: string, lowest: number) =>
      lowest > 1
        ? `The next new offer is numbered ${example}. Offers already use the numbers below ${lowest}, so it cannot go lower.`
        : `The next new offer is numbered ${example}. Set it to continue from the document system.`,
    invalid: 'Enter a whole number from 1 to 9999.',
    used: (lowest: number) => `An offer already uses that number. Use ${lowest} or more.`,
    unsaved: (saved: string, typed: string) =>
      `Not saved yet. Until you save, the next new offer is still ${saved}; after saving it will be ${typed}.`,
    save: 'Save numbering',
    saved: (entity: string, example: string) => `${entity}: the next new offer is ${example}.`,
  },
}

const it: typeof en = {
  heading: 'Impostazioni',
  description: "L'intestazione e le condizioni standard stampate sulle offerte, un profilo per ogni società wellD di cui gestisci le opportunità.",
  descriptionService:
    "I dati dell'emittente e le condizioni standard stampati sulle offerte, un profilo per ogni società wellD di cui gestisci le opportunità.",
  loading: 'Caricamento delle impostazioni…',
  emptyTitle: 'Nessuna società da configurare',
  emptyBody: 'Non gestisci opportunità per nessuna società.',
  profile: (entity: string) => `Profilo ${entity}`,
  legalNote: 'Ragione sociale, indirizzo, partita IVA e IBAN sono nelle Società del gruppo, non qui.',
  legalNoteLink: 'Apri Società del gruppo',
  legalNoteAdmin:
    'Ragione sociale, indirizzo, partita IVA e IBAN si trovano nella pagina Società del gruppo (Amministrazione). Li gestisce un amministratore.',
  fields: {
    termsEn: 'Condizioni standard (inglese)',
    termsIt: 'Condizioni standard (italiano)',
    termsHint: "Stampate quando un'offerta viene generata senza condizioni proprie.",
    placeOfIssue: 'Luogo di emissione',
    placeOfIssueHint: "Stampato accanto alla data dell'offerta. Lascia vuoto per il valore predefinito, Lugano.",
  },
  save: 'Salva profilo',
  saving: 'Salvataggio…',
  saved: (entity: string) => `Profilo ${entity} salvato.`,
  updated: (date: string) => `Ultimo salvataggio ${date}`,
  numbering: {
    title: (entity: string) => `Numerazione offerte ${entity}`,
    loading: 'Caricamento della numerazione…',
    year: 'Anno',
    next: 'Prossimo numero di offerta',
    nextHint: (example: string, lowest: number) =>
      lowest > 1
        ? `La prossima nuova offerta avrà il numero ${example}. Le offerte usano già i numeri sotto ${lowest}, quindi non si può scendere oltre.`
        : `La prossima nuova offerta avrà il numero ${example}. Impostalo per continuare dal sistema documentale.`,
    invalid: 'Inserisci un numero intero da 1 a 9999.',
    used: (lowest: number) => `Un'offerta usa già quel numero. Usa ${lowest} o più.`,
    unsaved: (saved: string, typed: string) =>
      `Non ancora salvato. Finché non salvi, la prossima nuova offerta resta ${saved}; dopo il salvataggio sarà ${typed}.`,
    save: 'Salva numerazione',
    saved: (entity: string, example: string) => `${entity}: la prossima nuova offerta sarà ${example}.`,
  },
}

export const settings = { en, it }
