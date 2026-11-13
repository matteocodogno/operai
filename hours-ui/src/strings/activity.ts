/**
 * The activity field of the entry dialog (T26): the select's label and options, and the one line it says
 * for each state (design S2 § Activity field). The dialog's own copy (`This activity does not belong to the
 * chosen project / deal.`, what a refused save says) is passed in from `entry.ts`, never worded here.
 */

const en = {
  label: 'Activity',
  /** The first option of every state: the field is optional. */
  none: 'No activity',
  /** Before a project or a deal is chosen. */
  chooseFirst: {
    project: 'Choose a project first.',
    deal: 'Choose a deal first.',
  },
  /** The select's text, the hint and the polite status while the read is out. */
  loading: 'Loading activities…',
  /** "Showing the latest N": N is what was loaded (a page is 100 at most), and the older ones cannot be chosen. */
  latest: (count: number) =>
    count === 1
      ? "Showing the latest activity. Older ones can't be chosen here."
      : `Showing the latest ${count} activities. Older ones can't be chosen here.`,
  /** The hint and the polite status when the read failed (404, 503, network); the field is optional. */
  loadFailed: 'Activities could not be loaded. You can save without one.',
  /** The activity types activities-api knows, as a prefix of an option. */
  type: {
    note: 'Note',
    call: 'Call',
    meeting: 'Meeting',
    email: 'Email',
    task: 'Task',
  },
  /** An option: "Type · subject". */
  option: (type: string, subject: string) => `${type} · ${subject}`,
  /** The edited entry's current activity when its name did not come with the view. */
  currentHidden: 'Not visible to you',
  currentUnavailable: 'Name unavailable',
}

const it: typeof en = {
  label: 'Attività',
  none: 'Nessuna attività',
  chooseFirst: {
    project: 'Scegli prima un progetto.',
    deal: "Scegli prima un'opportunità.",
  },
  loading: 'Caricamento attività…',
  latest: (count: number) =>
    count === 1
      ? "Viene mostrata l'ultima attività. Quelle più vecchie non si possono scegliere qui."
      : `Vengono mostrate le ultime ${count} attività. Quelle più vecchie non si possono scegliere qui.`,
  loadFailed: 'Impossibile caricare le attività. Puoi salvare anche senza.',
  type: {
    note: 'Nota',
    call: 'Telefonata',
    meeting: 'Riunione',
    email: 'Email',
    task: 'Attività',
  },
  option: (type: string, subject: string) => `${type} · ${subject}`,
  currentHidden: 'Non visibile a te',
  currentUnavailable: 'Nome non disponibile',
}

export const activity = { en, it }
