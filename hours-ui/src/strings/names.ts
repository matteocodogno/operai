/**
 * The words for what a viewer may not read or what could not be loaded (T25; design S1 "Names the viewer
 * cannot read", AC-4.10, AC-4.7). Shared by the screen and the export file, so the two never disagree:
 * `hidden`, `unavailable` and `unknown` are also the export's cell words (T30 reads them from here).
 *
 * A name of the data (a project, a deal, a meeting, an activity's subject) is never in this file: it is shown
 * exactly as the server sends it (AC-3.8), and only when the viewer may read it. These are the sentences
 * around it and the placeholders that stand in for it. No catalog entry takes an id.
 */

const en = {
  /** In place of a name the viewer may not read — on a row, and as an export cell. */
  hidden: 'Not visible to you',
  /** In place of a name whose owner did not answer. */
  unavailable: 'Name unavailable',
  /** The export's "Counts for deal" cell for a meeting whose deal could not be read (AC-4.7). */
  unknown: 'Unknown',
  /** A meeting row's line (AC-2.6): the deal its hours count for. */
  countsForDeal: (name: string) => `Counts for deal ${name}`,
  countsForHiddenDeal: 'Counts for a deal that is not visible to you',
  countsForUnavailableDeal: 'Counts for a deal whose name is unavailable',
  /**
   * The one "unknown" line of a meeting row, for the deal AND the project: both come from the one read of the meeting's host, so they
   * are unknown together, and two lines (or one that is half wrong) would be noise (specs/20261112-project-hours design S4). The key
   * keeps the deal's name; `countsForProjectLine` says nothing for an unknown project.
   */
  countsForUnknownDeal: 'The deal or project these hours count for is unknown right now',
  /** A meeting row's line (specs/20261112-project-hours AC-4.4, AC-4.7): the project its hours count for. */
  countsForProject: (name: string) => `Counts for project ${name}`,
  countsForHiddenProject: 'Counts for a project that is not visible to you',
  countsForUnavailableProject: 'Counts for a project whose name is unavailable',
  /** The activity an entry points at (AC-2.7). */
  activity: (subject: string) => `Activity: ${subject}`,
  activityHidden: 'Activity: not visible to you',
  activityUnavailable: 'Activity: name unavailable',
  /** The sources a read could not ask, in the words of the banner that names them. */
  sources: {
    identities: "people's names",
    projects: 'project names',
    crm: 'deal names',
    activities: 'activity subjects',
    meetings: 'meeting titles',
    // The two codes always come together (one read of the meetings' hosts) and say one thing: the banner names it once.
    'meeting-deals': 'the deal or project that meeting hours count for',
    'meeting-projects': 'the deal or project that meeting hours count for',
  },
}

const it: typeof en = {
  hidden: 'Non visibile a te',
  unavailable: 'Nome non disponibile',
  unknown: 'Non noto',
  countsForDeal: (name: string) => `Conta per l'opportunità ${name}`,
  countsForHiddenDeal: "Conta per un'opportunità non visibile a te",
  countsForUnavailableDeal: "Conta per un'opportunità il cui nome non è disponibile",
  countsForUnknownDeal: "L'opportunità o il progetto a cui contano queste ore al momento non è noto",
  countsForProject: (name: string) => `Conta per il progetto ${name}`,
  countsForHiddenProject: 'Conta per un progetto non visibile a te',
  countsForUnavailableProject: 'Conta per un progetto il cui nome non è disponibile',
  activity: (subject: string) => `Attività: ${subject}`,
  activityHidden: 'Attività: non visibile a te',
  activityUnavailable: 'Attività: nome non disponibile',
  sources: {
    identities: 'i nomi delle persone',
    projects: 'i nomi dei progetti',
    crm: 'i nomi delle opportunità',
    activities: 'gli oggetti delle attività',
    meetings: 'i titoli delle riunioni',
    'meeting-deals': "l'opportunità o il progetto a cui contano le ore delle riunioni",
    'meeting-projects': "l'opportunità o il progetto a cui contano le ore delle riunioni",
  },
}

export const names = { en, it }
