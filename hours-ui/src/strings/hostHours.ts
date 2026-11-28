/**
 * The hours panel other tools embed on a project page and a deal page (specs/20261112-project-hours T13; design S3 and § Copy; AC-2.1,
 * AC-2.2, AC-3.2): the total, the line that says what it includes, the closed "breakdown" disclosure and its two tables, and the
 * words of its empty and failed states. What the panel reuses from the other areas is not repeated here: the column and caption of the
 * person table (`totals`), the "(retired)" suffix (`entries`), the note about names that could not be loaded (`entries` and
 * `names.sources`), "Retry" (`common`) and how a person is named (`everyone.person`). A work type's or a person's NAME is never in this
 * file: it is shown as the server sends it.
 */

const en = {
  /** The accessible name of the panel's group, which takes focus after a Retry (the page names the record in its heading). */
  regionLabel: {
    project: 'Hours on this project',
    deal: 'Hours on this deal',
  },
  loading: 'Loading hours…',
  /** All time, on purpose: the period's figure is the consumption block's (projects-ui). */
  total: 'Total recorded',
  /** Always shown under the total: the hours recorded on the meetings linked to the record count in it (AC-4.3). */
  includesMeetings: {
    project: 'Includes the hours recorded on meetings linked to this project.',
    deal: 'Includes the hours recorded on meetings linked to this deal.',
  },
  /** The disclosure's button; the breakdown is on the page, one click away, and closed on every load. */
  show: 'Show breakdown',
  hide: 'Hide breakdown',
  byWorkType: {
    heading: 'By work type',
    caption: 'Hours by work type',
    column: 'Work type',
    /** The entries without a work type, the meetings' included. */
    none: 'Without a work type',
  },
  byPerson: {
    heading: 'By person',
  },
  /** No hours yet: the total reads "0 min" and this sentence replaces the inclusion line; there is nothing to disclose. */
  empty: {
    project: 'No hours recorded yet. Hours recorded on this project, or on meetings linked to it, appear here.',
    deal: 'No hours recorded yet. Hours recorded on this deal, or on meetings linked to it, appear here.',
  },
  /** The read failed (Meetings could not say what is linked, the owner did not answer, the record is not readable, no network): no figure at all. */
  error: {
    title: 'Hours are unavailable',
    body: 'Operai could not load these hours, so no figure is shown rather than one that could be too low. Try again in a moment.',
  },
  /** The per-person right could not be checked: the table is withheld (fail closed) and this says why a table a person expected is missing. */
  peopleUnavailable: 'The breakdown by person could not be checked right now, so it is not shown.',
}

const it: typeof en = {
  regionLabel: {
    project: 'Ore su questo progetto',
    deal: 'Ore su questa opportunità',
  },
  loading: 'Caricamento delle ore…',
  total: 'Totale registrato',
  includesMeetings: {
    project: 'Comprende le ore registrate sulle riunioni collegate a questo progetto.',
    deal: 'Comprende le ore registrate sulle riunioni collegate a questa opportunità.',
  },
  show: 'Mostra dettaglio',
  hide: 'Nascondi dettaglio',
  byWorkType: {
    heading: 'Per tipo di lavoro',
    caption: 'Ore per tipo di lavoro',
    column: 'Tipo di lavoro',
    none: 'Senza tipo di lavoro',
  },
  byPerson: {
    heading: 'Per persona',
  },
  empty: {
    project:
      'Nessuna ora registrata finora. Le ore registrate su questo progetto, o sulle riunioni collegate, compaiono qui.',
    deal: 'Nessuna ora registrata finora. Le ore registrate su questa opportunità, o sulle riunioni collegate, compaiono qui.',
  },
  error: {
    title: 'Le ore non sono disponibili',
    body: 'Operai non è riuscito a caricare queste ore, quindi non mostra nessuna cifra invece di una che potrebbe essere troppo bassa. Riprova tra un momento.',
  },
  peopleUnavailable: 'Al momento non è stato possibile verificare il dettaglio per persona, quindi non viene mostrato.',
}

export const hostHours = { en, it }
