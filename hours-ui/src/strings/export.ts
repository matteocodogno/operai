/**
 * The export button and the workbook's headers (T30; design F5; plan § Export file; AC-4.6, AC-5.5).
 *
 * `export` is a reserved word, so this one module exports `exportStrings` instead of `export` (the aggregate
 * still calls the namespace `strings.export`).
 *
 * The placeholder words of the file — what stands in for a name the viewer may not read, whose owner did not
 * answer, or that could not be asked — are NOT here: they are `strings.names`, the same words as on screen, and
 * the kinds of work are `strings.entries.type`, so the file and the screen never disagree (design S1 "Names the
 * viewer cannot read"). `lib/hoursWorkbook` assembles them with these headers. A name, a note or an activity's
 * subject is never in this file: it is written exactly as the server sends it (AC-3.8).
 */

const en = {
  /** The button, in the Entries card of both views. */
  button: 'Export',
  /** The polite status while the pages are read and the file is made. */
  busy: 'Preparing file…',
  ready: 'File ready',
  /** The file is made but a source did not answer: its names are empty or "Name unavailable" in it (AC-4.7). */
  readyNamesMissing: 'File ready. Some names could not be loaded and are missing.',
  /** The alert when a page or the build fails; the same button tries again. One line for every cause. */
  failed: 'The file could not be prepared. Try again.',
  workbook: {
    /** The one sheet's name (a spreadsheet program limits it to 31 characters). */
    sheetName: 'Hours',
    columns: {
      day: 'Day',
      person: 'Person',
      /** A number of hours with decimals (2 h 30 is 2.5), so the column can be summed (D39). */
      hours: 'Hours',
      on: 'On',
      name: 'Name',
      /** The deal the hours count for: an entry on a deal, or on a meeting linked to one (D40). */
      countsForDeal: 'Counts for deal',
      categoryOrWorkType: 'Category or work type',
      activity: 'Activity',
      note: 'Note',
    },
  },
}

const it: typeof en = {
  button: 'Esporta',
  busy: 'Preparazione del file…',
  ready: 'File pronto',
  readyNamesMissing: 'File pronto. Alcuni nomi non sono stati caricati e mancano.',
  failed: 'Impossibile preparare il file. Riprova.',
  workbook: {
    sheetName: 'Ore',
    columns: {
      day: 'Giorno',
      person: 'Persona',
      hours: 'Ore',
      on: 'Su',
      name: 'Nome',
      countsForDeal: "Conta per l'opportunità",
      categoryOrWorkType: 'Categoria o tipo di lavoro',
      activity: 'Attività',
      note: 'Nota',
    },
  },
}

export const exportStrings = { en, it }
