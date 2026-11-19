/**
 * The Record hours button other tools embed (specs/20261116-record-hours-in-place T2; design S1-S3 and § Copy; AC-4.6): its
 * accessible name on a task row and the message after a save. The button's visible label is the one My hours already
 * has (`entry.record`), and the sentence under the dialog's title is the dialog's own (`entry.fixed`), so the two
 * places that record hours never word one thing twice. The names it shows — a project, a deal, a task, a category — are
 * never in this file: they are shown exactly as their owners hold them.
 */

const en = {
  /** The accessible name of a task row's button, so a list of them read out of context tells the rows apart (WCAG 2.5.3: it contains the visible label). */
  buttonOn: (task: string) => `Record hours on ${task}`,
  /** After a save, where the person acted: "2 h 30 recorded on Alpenstrom — portale clienti." (`duration` in the short form). */
  recorded: (duration: string, name: string) => `${duration} recorded on ${name}.`,
  /** The same for hours that went to no project, deal or meeting (a CRM task about a company, AC-3.5). */
  recordedOther: (duration: string, category: string) => `${duration} recorded on other work: ${category}.`,
  /** What the host could not name reads as these, never a blank and never an id (plan R10). */
  thisProject: 'this project',
  thisDeal: 'this deal',
  /** The link inside the message: a shell transition to My hours (design S3). */
  seeInMyHours: 'See in My hours',
}

const it: typeof en = {
  buttonOn: (task: string) => `Registra ore su ${task}`,
  // The verb is in the person ("Hai registrato"), so nothing agrees with the duration: a participle after it ("registrate",
  // feminine plural) suits "ore" but not "1 h" or "30 min" (design § Copy, QE observation).
  recorded: (duration: string, name: string) => `Hai registrato ${duration} su ${name}.`,
  recordedOther: (duration: string, category: string) => `Hai registrato ${duration} su altro lavoro: ${category}.`,
  thisProject: 'questo progetto',
  thisDeal: 'questa opportunità',
  seeInMyHours: 'Vedi in Le mie ore',
}

export const recordHours = { en, it }
