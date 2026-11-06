/** The project page: details, state actions, project manager and team (T13); the awaiting state and the pick of its project manager (T30, T32). */
const en = {
  back: 'Back to projects',
  loading: 'Loading project…',
  notFoundTitle: 'Project not found',
  notFoundBody: 'It may have been removed, or the link is wrong.',
  readOnly: 'You can read this project but not change it.',
  dealNotWon: {
    title: 'The deal is no longer won',
    body: (titles: string) => `Reopened in the CRM: ${titles}. The project and its purchase order are unchanged.`,
  },
  details: {
    title: 'Details',
    edit: 'Edit details',
    type: 'Type',
    entity: 'wellD entity',
    company: 'Company',
    internal: 'Internal',
    companyUnavailable: 'Company unavailable',
    projectManager: 'Project manager',
    awaitingProjectManager: 'Awaiting project manager',
    startDate: 'Starts',
    endDate: 'Ends',
    openEnded: 'Open-ended',
  },
  actions: {
    label: 'Project actions',
    start: 'Start project',
    hold: 'Put on hold',
    resume: 'Resume',
    close: 'Close project',
    reopen: 'Reopen',
    cancel: 'Cancel project',
    working: 'Working…',
    startBlocked: 'Waiting for a project manager: the ops manager of the purchase order has to pick one first.',
  },
  awaiting: {
    title: 'Awaiting project manager',
    body: (opsManager: string) =>
      `${opsManager} is the ops manager of this project’s purchase order and picks its project manager. The project cannot start until then.`,
    seePurchaseOrder: 'See the purchase order',
    pick: 'Pick project manager',
  },
  pickDialog: {
    title: 'Pick project manager',
    description:
      'Choose who manages this project. Once it has one, anyone who manages the projects of its entity can change it, but it cannot be left without.',
    label: 'Project manager',
    hint: 'Only people with access to Projects can be chosen.',
    submit: 'Set project manager',
    busy: 'Saving…',
    errors: {
      not_ops_manager:
        'Only the ops manager of this purchase order, or an administrator, can pick the project manager.',
      not_project_user: 'This person has no access to Projects. Choose someone who does.',
      identity_unavailable:
        'The user directory cannot be reached right now, so the person could not be checked. Nothing was changed. Try again in a moment.',
      out_of_scope: 'You may not change projects of this entity.',
    },
  },
  cancelDialog: {
    title: 'Cancel this project?',
    body: 'A cancelled project is final: it cannot be reopened or changed afterwards.',
    confirm: 'Cancel project',
    busy: 'Cancelling…',
    keep: 'Keep project',
  },
  saved: {
    state: (label: string) => `The project is now ${label}.`,
    details: 'Project saved.',
    team: 'Team saved.',
    projectManager: 'Project manager picked.',
  },
  errors: {
    title: 'The change was not made',
    invalid_transition: 'The project cannot move to that state from where it is now. Reload to see its current state.',
    awaiting_project_manager:
      'This project is waiting for its project manager. The ops manager of its purchase order must pick one before it can start.',
    out_of_scope: 'You may not change projects of this entity.',
  },
  editDialog: {
    title: 'Edit project',
    name: 'Name',
    projectManager: 'Project manager',
    projectManagerHint: 'Only people with access to Projects can be chosen.',
    projectManagerAwaiting: 'This project has no project manager yet: the ops manager of its purchase order picks one.',
    submit: 'Save',
    busy: 'Saving…',
  },
  team: {
    title: 'Team',
    edit: 'Edit team',
    empty: 'No team members yet.',
    dialog: {
      title: 'Edit team',
      add: 'Add a team member',
      addHint: 'Only people with access to Projects can be added.',
      members: 'Team members',
      none: 'Nobody yet.',
      removeButton: 'Remove',
      remove: (name: string) => `Remove ${name}`,
      submit: 'Save team',
      busy: 'Saving…',
      tooMany: 'A team has at most 100 members.',
    },
    errors: {
      not_project_user: (names: string) =>
        `These people have no access to Projects: ${names}. Remove them, or ask an administrator for access.`,
      identity_unavailable:
        'The user directory cannot be reached right now. Nothing was changed. Try again in a moment.',
    },
  },
}

const it: typeof en = {
  back: 'Torna ai progetti',
  loading: 'Caricamento del progetto…',
  notFoundTitle: 'Progetto non trovato',
  notFoundBody: 'Potrebbe essere stato rimosso, oppure il link non è corretto.',
  readOnly: 'Puoi leggere questo progetto ma non modificarlo.',
  dealNotWon: {
    title: 'La trattativa non è più vinta',
    body: (titles: string) => `Riaperta nel CRM: ${titles}. Il progetto e il suo ordine d’acquisto restano invariati.`,
  },
  details: {
    title: 'Dettagli',
    edit: 'Modifica dettagli',
    type: 'Tipo',
    entity: 'Entità wellD',
    company: 'Azienda',
    internal: 'Interno',
    companyUnavailable: 'Azienda non disponibile',
    projectManager: 'Project manager',
    awaitingProjectManager: 'In attesa del project manager',
    startDate: 'Inizio',
    endDate: 'Fine',
    openEnded: 'Senza scadenza',
  },
  actions: {
    label: 'Azioni sul progetto',
    start: 'Avvia progetto',
    hold: 'Metti in pausa',
    resume: 'Riprendi',
    close: 'Chiudi progetto',
    reopen: 'Riapri',
    cancel: 'Annulla progetto',
    working: 'Operazione in corso…',
    startBlocked:
      'In attesa di un project manager: il responsabile OPS dell’ordine d’acquisto deve prima sceglierne uno.',
  },
  awaiting: {
    title: 'In attesa del project manager',
    body: (opsManager: string) =>
      `${opsManager} è il responsabile OPS dell’ordine d’acquisto di questo progetto e ne sceglie il project manager. Il progetto non può partire prima.`,
    seePurchaseOrder: 'Vedi l’ordine d’acquisto',
    pick: 'Scegli il project manager',
  },
  pickDialog: {
    title: 'Scegli il project manager',
    description:
      'Scegli chi gestisce questo progetto. Una volta scelto, chiunque gestisca i progetti della sua entità può cambiarlo, ma non può restare senza.',
    label: 'Project manager',
    hint: 'Si possono scegliere solo persone con accesso a Progetti.',
    submit: 'Imposta project manager',
    busy: 'Salvataggio…',
    errors: {
      not_ops_manager:
        'Solo il responsabile OPS di questo ordine d’acquisto, o un amministratore, può scegliere il project manager.',
      not_project_user: 'Questa persona non ha accesso a Progetti. Scegline una che ce l’ha.',
      identity_unavailable:
        'L’elenco degli utenti al momento non è raggiungibile, quindi non si è potuta verificare la persona. Non è stato modificato nulla. Riprova tra un attimo.',
      out_of_scope: 'Non puoi modificare i progetti di questa entità.',
    },
  },
  cancelDialog: {
    title: 'Annullare questo progetto?',
    body: 'Un progetto annullato è definitivo: non si può più riaprire né modificare.',
    confirm: 'Annulla progetto',
    busy: 'Annullamento…',
    keep: 'Mantieni progetto',
  },
  saved: {
    state: (label: string) => `Il progetto è ora: ${label}.`,
    details: 'Progetto salvato.',
    team: 'Team salvato.',
    projectManager: 'Project manager scelto.',
  },
  errors: {
    title: 'La modifica non è stata applicata',
    invalid_transition:
      'Dallo stato attuale il progetto non può passare a quello richiesto. Ricarica per vedere lo stato corrente.',
    awaiting_project_manager:
      'Questo progetto attende il suo project manager. Il responsabile OPS del suo ordine d’acquisto deve sceglierne uno prima che possa partire.',
    out_of_scope: 'Non puoi modificare i progetti di questa entità.',
  },
  editDialog: {
    title: 'Modifica progetto',
    name: 'Nome',
    projectManager: 'Project manager',
    projectManagerHint: 'Si possono scegliere solo persone con accesso a Progetti.',
    projectManagerAwaiting:
      'Questo progetto non ha ancora un project manager: lo sceglie il responsabile OPS del suo ordine d’acquisto.',
    submit: 'Salva',
    busy: 'Salvataggio…',
  },
  team: {
    title: 'Team',
    edit: 'Modifica team',
    empty: 'Ancora nessun membro nel team.',
    dialog: {
      title: 'Modifica team',
      add: 'Aggiungi un membro',
      addHint: 'Si possono aggiungere solo persone con accesso a Progetti.',
      members: 'Membri del team',
      none: 'Nessuno per ora.',
      removeButton: 'Rimuovi',
      remove: (name: string) => `Rimuovi ${name}`,
      submit: 'Salva team',
      busy: 'Salvataggio…',
      tooMany: 'Un team ha al massimo 100 membri.',
    },
    errors: {
      not_project_user: (names: string) =>
        `Queste persone non hanno accesso a Progetti: ${names}. Rimuovile, oppure chiedi l’accesso a un amministratore.`,
      identity_unavailable:
        'L’elenco degli utenti al momento non è raggiungibile. Non è stato modificato nulla. Riprova tra poco.',
    },
  },
}

export const project = { en, it }
