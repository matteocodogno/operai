/** strings.audit — the Audit log. */
export const en = {
  heading: 'Audit',
  description:
    'A read-only, reverse-chronological history of every authorization change (roles, departments, teams, and user assignments) and every legal entity change. Nothing here can be edited or deleted.',
  loadError: 'Could not load the audit log.',
  empty: {
    title: 'No changes yet',
    body: 'No authorization changes recorded yet.',
  },
  tableLabel: 'Audit log',
  columns: {
    expand: 'Expand',
    timestamp: 'Timestamp',
    actor: 'Actor',
    action: 'Action',
    target: 'Target',
    summary: 'Summary',
  },
  unknownUser: 'Unknown user',
  deletedUser: 'Deleted user',
  target: (type: string, id: string) => `${type} · ${id}`,
  showDetails: (summary: string) => `Show details for ${summary}`,
  hideDetails: (summary: string) => `Hide details for ${summary}`,
  before: 'Before',
  after: 'After',
  notRecorded: '(not recorded)',
}

export const it: typeof en = {
  heading: 'Audit',
  description:
    'Cronologia in sola lettura, dalla più recente, di ogni modifica alle autorizzazioni (ruoli, reparti, team e assegnazioni degli utenti) e ogni modifica alle società del gruppo. Nulla qui può essere modificato o eliminato.',
  loadError: 'Impossibile caricare il registro di audit.',
  empty: {
    title: 'Ancora nessuna modifica',
    body: 'Non è stata ancora registrata alcuna modifica alle autorizzazioni.',
  },
  tableLabel: 'Registro di audit',
  columns: {
    expand: 'Espandi',
    timestamp: 'Data e ora',
    actor: 'Autore',
    action: 'Azione',
    target: 'Oggetto',
    summary: 'Riepilogo',
  },
  unknownUser: 'Utente sconosciuto',
  deletedUser: 'Utente eliminato',
  target: (type: string, id: string) => `${type} · ${id}`,
  showDetails: (summary: string) => `Mostra i dettagli di ${summary}`,
  hideDetails: (summary: string) => `Nascondi i dettagli di ${summary}`,
  before: 'Prima',
  after: 'Dopo',
  notRecorded: '(non registrato)',
}
