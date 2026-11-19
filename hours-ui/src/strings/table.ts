/**
 * The table view of My hours (specs/20261116-record-hours-in-place T9, T22; design S7 and § Copy; AC-4.6): the card's
 * heading, the Period switch, the navigator, the grid's headers and the names of a cell's buttons, the states and the sentence a
 * screen reader hears when a period arrives. The kind badges, the retired and "not visible" wording, "Recorded on",
 * "Clear filters" and the empty-filter and error sentences are the List's, reused from `entries`, `names`,
 * `filters` and `common`, so the two views of the same hours never word one thing twice.
 *
 * What differs by period is `week` and `month`, two catalogs of one type (`PeriodWords`): a word the month lacks is a compile
 * error, so neither period is worded half. Weekday names are copy, not a date format (the library has no weekday formatter):
 * seven short and seven long, Monday first (WA1), picked by a day's place in its week. The label of a period (a week as two
 * `formatDate`s with an en dash, a month through `formatMonth`) is made by `TableViewModel.periodLabel` and arrives here
 * already made (`label`).
 */

/** One name for each day of the week, Monday first. */
type Week7 = [string, string, string, string, string, string, string]

/** What the table says that differs between its two periods (plan § Copy): a week and a month are worded by one type. */
export type PeriodWords = {
  /** The card's heading: the period's label, "Week 16.11.2026 – 22.11.2026" / "November 2026". */
  title: (label: string) => string
  /** The skeleton's hidden, polite line. */
  loading: string
  /** The previous / this / next buttons, one group (AC-5.5). */
  nav: { label: string; previous: string; current: string; next: string }
  /** The date field's label (AC-5.30): "Show the week of" / "Show the month of". Its description is `table.pick.hint`, shared. */
  pick: { label: string }
  /** No filter is set and the period has no entries (the page header has the action). */
  empty: { title: string }
  /** A save on a day outside the period shown: say so, or the entry looks lost (design F6; the twin of the List's `savedOutsidePeriod`). */
  savedOutside: (date: string) => string
  /**
   * One line between the card's heading and the grid, where the grid scrolls sideways inside the card and nothing else says so
   * (design S7 "Scroll hint"). Seen, not read: it is `aria-hidden`, the scroll region being already labelled.
   */
  scrollHint: string
}

const weekEn: PeriodWords = {
  title: (range) => `Week ${range}`,
  loading: 'Loading your week…',
  nav: {
    label: 'Choose a week',
    previous: 'Previous week',
    current: 'This week',
    next: 'Next week',
  },
  pick: { label: 'Show the week of' },
  empty: { title: 'No hours recorded this week' },
  savedOutside: (date) => `Entry saved. ${date} is outside the week you are viewing.`,
  scrollHint: 'Scroll sideways to see all seven days.',
}

const monthEn: PeriodWords = {
  title: (month) => month,
  loading: 'Loading your month…',
  nav: {
    label: 'Choose a month',
    previous: 'Previous month',
    current: 'This month',
    next: 'Next month',
  },
  pick: { label: 'Show the month of' },
  empty: { title: 'No hours recorded this month' },
  savedOutside: (date) => `Entry saved. ${date} is outside the month you are viewing.`,
  scrollHint: 'Scroll sideways to see every day of the month.',
}

const en = {
  /** The Table | List switch under the page header (design S6, AC-5.1): a tab list of two views of the same page, Table first. */
  view: {
    label: 'View of your hours',
    table: 'Table',
    list: 'List',
  },
  /** The Period switch of the table view (design S7, AC-5.26, AC-5.27): the group's label and its two radios. */
  period: {
    label: 'Period',
    week: 'Week',
    month: 'Month',
  },
  week: weekEn,
  month: monthEn,
  /**
   * The date field's description, one for both periods (design G16): the field's limit stated for a reader, since a screen
   * reader does not describe the days the picker greys. Not drawn; it is not part of `PeriodWords`.
   */
  pick: {
    hint: 'Up to today.',
  },
  weekday: {
    short: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as Week7,
    long: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as Week7,
  },
  /** A badge on today's column header: the calendar's, never about the hours (AC-5.11). */
  today: 'Today',
  grid: {
    /** Names the table and its scroll region; `label` is the period's. */
    caption: (label: string) => `Hours by project, deal, meeting and other work, ${label}`,
    /** The last column's header and the last row's header (the day totals). */
    total: 'Total',
  },
  /**
   * The accessible name of a cell's button: it carries the row and the day, since a button is reached out of the table. Only a
   * cell that holds hours is a button: an empty cell is not a control and has no name (AC-5.32).
   */
  cell: {
    /** A cell that holds hours (AC-5.15). `day`: "Thursday 19 November 2026". */
    open: (duration: string, on: string, day: string, entries: number) =>
      `${duration} on ${on}, ${day}, ${entries === 1 ? '1 entry' : `${entries} entries`}`,
  },
  /**
   * The cell dialog (design S8; AC-5.15–AC-5.18): the entries of one row on one day. The title is the row's kind and name,
   * the description its day and what the cell holds. The Close button, the list's label ("Entries on <date>") and the
   * entries' own words are the List's, reused from `common` and `entries`.
   */
  cellDialog: {
    /** `kind`: "Project", "Other work"; `name`: the row's name as the row writes it ("Not visible to you" included). */
    title: (kind: string, name: string) => `${kind}: ${name}`,
    /** `day`: "Wednesday 18 November 2026"; `total`: the cell's figure, "6 h 30". */
    description: (day: string, entries: number, total: string) =>
      `${day} · ${entries === 1 ? '1 entry' : `${entries} entries`}, ${total}`,
    add: 'Add hours',
  },
  /** Polite, when a period (or its filters) has arrived. `total` is spoken ("38 hours, 30 minutes"). */
  announce: (label: string, total: string) => `${label}: ${total} in total.`,
  announceEmpty: (label: string) => `${label}: no hours recorded.`,
  /** The body of the empty period, whichever period it is. */
  empty: {
    body: 'Record the hours you worked and they appear here, by project and day.',
  },
}

const weekIt: PeriodWords = {
  title: (range) => `Settimana ${range}`,
  loading: 'Caricamento della tua settimana…',
  nav: {
    label: 'Scegli una settimana',
    previous: 'Settimana precedente',
    current: 'Questa settimana',
    next: 'Settimana successiva',
  },
  pick: { label: 'Mostra la settimana del' },
  empty: { title: 'Nessuna ora registrata in questa settimana' },
  savedOutside: (date) => `Registrazione salvata. Il ${date} è fuori dalla settimana che stai guardando.`,
  scrollHint: 'Scorri di lato per vedere tutti e sette i giorni.',
}

const monthIt: PeriodWords = {
  title: (month) => month,
  loading: 'Caricamento del tuo mese…',
  nav: {
    label: 'Scegli un mese',
    previous: 'Mese precedente',
    current: 'Questo mese',
    next: 'Mese successivo',
  },
  pick: { label: 'Mostra il mese del' },
  empty: { title: 'Nessuna ora registrata in questo mese' },
  savedOutside: (date) => `Registrazione salvata. Il ${date} è fuori dal mese che stai guardando.`,
  scrollHint: 'Scorri di lato per vedere tutti i giorni del mese.',
}

const it: typeof en = {
  view: {
    label: 'Vista delle tue ore',
    table: 'Tabella',
    list: 'Elenco',
  },
  period: {
    label: 'Periodo',
    week: 'Settimana',
    month: 'Mese',
  },
  week: weekIt,
  month: monthIt,
  pick: {
    hint: 'Fino a oggi.',
  },
  weekday: {
    short: ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'] as Week7,
    long: ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'] as Week7,
  },
  today: 'Oggi',
  grid: {
    caption: (label: string) => `Ore per progetto, opportunità, riunione e altro lavoro, ${label}`,
    total: 'Totale',
  },
  cell: {
    open: (duration: string, on: string, day: string, entries: number) =>
      `${duration} su ${on}, ${day}, ${entries === 1 ? '1 registrazione' : `${entries} registrazioni`}`,
  },
  cellDialog: {
    title: (kind: string, name: string) => `${kind}: ${name}`,
    description: (day: string, entries: number, total: string) =>
      `${day} · ${entries === 1 ? '1 registrazione' : `${entries} registrazioni`}, ${total}`,
    add: 'Aggiungi ore',
  },
  announce: (label: string, total: string) => `${label}: ${total} in totale.`,
  announceEmpty: (label: string) => `${label}: nessuna ora registrata.`,
  empty: {
    body: 'Registra le ore lavorate e compaiono qui, per progetto e giorno.',
  },
}

export const table = { en, it }
