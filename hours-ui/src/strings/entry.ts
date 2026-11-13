/**
 * The entry dialog (T27: record; T28 adds edit and the delete confirmation) and the words around it on My
 * hours: the "Record hours" action and the confirmation after a save (design S2, F1, F3). The names of
 * categories and work types, of projects, deals and meetings are never in this file: they are shown exactly
 * as their owners hold them (AC-3.8).
 *
 * Every refusal a screen can word is here once: `errors` is what the dialog says for each client rule and
 * each code of plan § Errors that can come back from a save (design S2 "Error surfaces").
 */

/** The three pickers say the same five things; only the noun changes. */
const pickerMessages = (noun: { none: string; forbidden: string; one: string; many: (n: number) => string }) => ({
  searching: 'Searching…',
  noMatch: noun.none,
  forbidden: noun.forbidden,
  unavailable: 'The search is unavailable. Try again.',
  count: (n: number) => (n === 1 ? noun.one : noun.many(n)),
})

const en = {
  /** The page's one primary action, which opens the dialog. */
  record: 'Record hours',
  /** The confirmation, where the person acted (INC-19). */
  saved: 'Entry saved.',
  /** The saved day is outside the period the list shows: say so, or the entry looks lost (design F1). */
  savedOutsidePeriod: (date: string) => `Entry saved. ${date} is outside the period you are viewing.`,
  dialog: {
    recordTitle: 'Record hours',
    save: 'Save entry',
    saving: 'Saving…',
  },
  fields: {
    day: 'Day',
    duration: {
      label: 'Duration',
      hint: 'In steps of 30 minutes, up to 24 hours.',
      /** The first option while nothing is chosen: it is never offered as a choice. */
      placeholder: 'Choose a duration',
    },
    on: {
      label: 'What was it on',
      options: {
        project: 'Project',
        deal: 'Deal',
        meeting: 'Meeting',
        none: 'Other work',
      },
    },
    project: {
      label: 'Project',
      hint: 'You can record hours on projects where you are the project manager or on the team.',
      messages: pickerMessages({
        none: 'No projects match.',
        forbidden: "You can't search projects.",
        one: '1 project',
        many: (n) => `${n} projects`,
      }),
    },
    deal: {
      label: 'Deal',
      hint: 'You can record hours on deals you own, are the technical contact of, or take part in through an activity.',
      messages: pickerMessages({
        none: 'No deals match.',
        forbidden: "You can't search deals.",
        one: '1 deal',
        many: (n) => `${n} deals`,
      }),
    },
    meeting: {
      label: 'Meeting',
      hint: 'You can record hours on meetings you created or take part in.',
      messages: pickerMessages({
        none: 'No meetings match.',
        forbidden: "You can't search meetings.",
        one: '1 meeting',
        many: (n) => `${n} meetings`,
      }),
    },
    category: {
      label: 'Category',
      placeholder: 'Choose a category',
      loading: 'Loading categories…',
      loadFailed: 'Categories could not be loaded.',
      /** Every category is retired, or none was ever made: Save is blocked until an administrator adds one. */
      noneAvailable: 'No categories are available. Ask whoever manages the time lists.',
    },
    workType: {
      label: 'Work type',
      none: 'No work type',
      loading: 'Loading work types…',
      loadFailed: 'Work types could not be loaded. You can save without one.',
    },
    note: {
      label: 'Note',
      /** `n` counts Unicode code points, as the server's limit does (plan § Entries). */
      counter: (count: number, max: number) => `${count} of ${max}`,
      /** The category chosen needs a note (AC-3.6): shown with the required marker. */
      needed: 'This category needs a note.',
    },
  },
  /** The lists could not be read: the category and work type selects cannot be filled until they are. */
  listsRetry: 'Try again',
  errors: {
    dayRequired: 'Choose a day.',
    /** Not a day on the calendar (30 February): the browser's field cannot hold one, so this is a backstop. */
    dayInvalid: 'Choose a real calendar day.',
    /** Before the product's floor (plan § Entries "A day"): a mistyped year would be saved and then missing from every period. */
    dayTooEarly: (floor: string) => `The day cannot be before ${floor}.`,
    /** `future_day` (AC-1.3), the client rule and the server's refusal alike. */
    dayFuture: 'The day cannot be after today.',
    durationRequired: 'Choose a duration.',
    onRequired: 'Choose what the hours were on.',
    projectRequired: 'Choose a project from the list.',
    dealRequired: 'Choose a deal from the list.',
    meetingRequired: 'Choose a meeting from the list.',
    categoryRequired: 'Choose a category.',
    /** AC-1.7: the limit is 1000 characters, counted as the server counts them. */
    noteTooLong: 'The note can be at most 1000 characters.',
    /** AC-3.6: a blank note is no note. Not the hint's words ("needs a note"): the error says what to do. */
    noteRequired: 'Add a note: this category needs one.',
    /** A category or work type retired, removed or not allowed since the lists were read; the lists are read again. */
    noLongerAvailable: 'No longer available — choose another.',
    /** `activity_not_allowed` (AC-2.7). */
    activityNotAllowed: {
      project: 'This activity does not belong to the chosen project.',
      deal: 'This activity does not belong to the chosen deal.',
    },
    /** `not_on_project` (AC-2.2): on the project picker. */
    notOnProject: 'You are not the project manager or on the team of this project.',
    /** `not_involved_in_deal` (AC-2.3): on the deal picker. */
    notInvolvedInDeal: 'You are not the owner or technical contact of this deal, and not on one of its activities.',
    /**
     * A 404 on the picker (AC-2.10): the same words for a record that is gone and one the person may not read,
     * so the screen cannot be used to tell which.
     */
    targetGone: {
      project: 'This project is no longer available to you. Choose another.',
      deal: 'This deal is no longer available to you. Choose another.',
      meeting: 'This meeting is no longer available to you. Choose another.',
    },
    /** `host_unavailable` (AC-2.11): the check failed closed, nothing was saved. */
    hostUnavailable: {
      project:
        'Operai could not check that you may record hours on this project. Nothing was saved. Try again in a moment.',
      deal: 'Operai could not check that you may record hours on this deal. Nothing was saved. Try again in a moment.',
      meeting:
        'Operai could not check that you may record hours on this meeting. Nothing was saved. Try again in a moment.',
    },
    /** Anything else: a 400, a network failure, a code this build does not know. */
    generic: 'Something went wrong. Nothing was saved.',
  },
}

const it: typeof en = {
  record: 'Registra ore',
  saved: 'Registrazione salvata.',
  savedOutsidePeriod: (date: string) => `Registrazione salvata. Il ${date} è fuori dal periodo che stai guardando.`,
  dialog: {
    recordTitle: 'Registra ore',
    save: 'Salva registrazione',
    saving: 'Salvataggio…',
  },
  fields: {
    day: 'Giorno',
    duration: {
      label: 'Durata',
      hint: 'A intervalli di 30 minuti, fino a 24 ore.',
      placeholder: 'Scegli una durata',
    },
    on: {
      label: 'Su cosa hai lavorato',
      options: {
        project: 'Progetto',
        deal: 'Opportunità',
        meeting: 'Riunione',
        none: 'Altro lavoro',
      },
    },
    project: {
      label: 'Progetto',
      hint: 'Puoi registrare ore sui progetti di cui sei project manager o in cui fai parte del team.',
      messages: {
        searching: 'Ricerca in corso…',
        noMatch: 'Nessun progetto corrisponde.',
        forbidden: 'Non puoi cercare i progetti.',
        unavailable: 'La ricerca non è disponibile. Riprova.',
        count: (n: number) => (n === 1 ? '1 progetto' : `${n} progetti`),
      },
    },
    deal: {
      label: 'Opportunità',
      hint: "Puoi registrare ore sulle opportunità di cui sei responsabile o referente tecnico, o a cui partecipi tramite un'attività.",
      messages: {
        searching: 'Ricerca in corso…',
        noMatch: 'Nessuna opportunità corrisponde.',
        forbidden: 'Non puoi cercare le opportunità.',
        unavailable: 'La ricerca non è disponibile. Riprova.',
        count: (n: number) => (n === 1 ? '1 opportunità' : `${n} opportunità`),
      },
    },
    meeting: {
      label: 'Riunione',
      hint: 'Puoi registrare ore sulle riunioni che hai creato o a cui partecipi.',
      messages: {
        searching: 'Ricerca in corso…',
        noMatch: 'Nessuna riunione corrisponde.',
        forbidden: 'Non puoi cercare le riunioni.',
        unavailable: 'La ricerca non è disponibile. Riprova.',
        count: (n: number) => (n === 1 ? '1 riunione' : `${n} riunioni`),
      },
    },
    category: {
      label: 'Categoria',
      placeholder: 'Scegli una categoria',
      loading: 'Caricamento categorie…',
      loadFailed: 'Impossibile caricare le categorie.',
      noneAvailable: 'Nessuna categoria disponibile. Chiedi a chi gestisce gli elenchi delle ore.',
    },
    workType: {
      label: 'Tipo di lavoro',
      none: 'Nessun tipo di lavoro',
      loading: 'Caricamento tipi di lavoro…',
      loadFailed: 'Impossibile caricare i tipi di lavoro. Puoi salvare anche senza.',
    },
    note: {
      label: 'Nota',
      counter: (count: number, max: number) => `${count} su ${max}`,
      needed: 'Questa categoria richiede una nota.',
    },
  },
  listsRetry: 'Riprova',
  errors: {
    dayRequired: 'Scegli un giorno.',
    dayInvalid: 'Scegli un giorno che esista nel calendario.',
    dayTooEarly: (floor: string) => `Il giorno non può essere precedente al ${floor}.`,
    dayFuture: 'Il giorno non può essere successivo a oggi.',
    durationRequired: 'Scegli una durata.',
    onRequired: 'Scegli su cosa hai lavorato.',
    projectRequired: "Scegli un progetto dall'elenco.",
    dealRequired: "Scegli un'opportunità dall'elenco.",
    meetingRequired: "Scegli una riunione dall'elenco.",
    categoryRequired: 'Scegli una categoria.',
    noteTooLong: 'La nota può contenere al massimo 1000 caratteri.',
    noteRequired: 'Aggiungi una nota: questa categoria la richiede.',
    noLongerAvailable: 'Non più disponibile — scegline un altro.',
    activityNotAllowed: {
      project: 'Questa attività non appartiene al progetto scelto.',
      deal: "Questa attività non appartiene all'opportunità scelta.",
    },
    notOnProject: 'Non sei il project manager né fai parte del team di questo progetto.',
    notInvolvedInDeal:
      'Non sei il responsabile né il referente tecnico di questa opportunità e non partecipi a una sua attività.',
    targetGone: {
      project: 'Questo progetto non è più disponibile per te. Scegline un altro.',
      deal: "Questa opportunità non è più disponibile per te. Scegline un'altra.",
      meeting: "Questa riunione non è più disponibile per te. Scegline un'altra.",
    },
    hostUnavailable: {
      project:
        'Operai non è riuscito a verificare che tu possa registrare ore su questo progetto. Non è stato salvato nulla. Riprova tra un momento.',
      deal: 'Operai non è riuscito a verificare che tu possa registrare ore su questa opportunità. Non è stato salvato nulla. Riprova tra un momento.',
      meeting:
        'Operai non è riuscito a verificare che tu possa registrare ore su questa riunione. Non è stato salvato nulla. Riprova tra un momento.',
    },
    generic: 'Qualcosa è andato storto. Non è stato salvato nulla.',
  },
}

export const entry = { en, it }
