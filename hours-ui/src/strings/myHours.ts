/** My hours: the page's own copy. T22 gave it the heading; T24 adds the description, T25, T27, T28 and T30 the rest. */

const en = {
  heading: 'My hours',
  /** AC-1.4, said once: nothing is wrong with a day that adds up to more than a working day. */
  description:
    'Time worked on two things at once counts in full on each, so a day can add up to more than a working day.',
}

const it: typeof en = {
  heading: 'Le mie ore',
  description:
    'Il tempo dedicato a due attività nello stesso momento conta per intero su ciascuna, quindi una giornata può risultare più lunga di una giornata lavorativa.',
}

export const myHours = { en, it }
