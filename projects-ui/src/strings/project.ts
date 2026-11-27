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
    /** A project taken from a won public tender (US-10): it has no purchase order. */
    origin: 'Origin',
    fromTender: 'From a tender',
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
    teams: 'Teams saved.',
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
  meetings: {
    heading: 'Meetings',
    loading: 'Loading meetings…',
    unavailable: 'Meetings cannot be shown right now. Reload the page to try again.',
  },
  /**
   * The ONE "Hours" card (specs/20261112-project-hours D80, design S1): the consumption block first, then hours-ui's panel
   * through the shell seam. `loading` and `unavailable` are the panel's slot while the seam loads and when it fails;
   * the panel's own words (total, breakdown, its own error) are hours-ui's.
   */
  hours: {
    heading: 'Hours',
    loading: 'Loading hours…',
    unavailable: 'Hours are unavailable. Reload the page to try again.',
  },
  /**
   * What the terms sold set against the hours used (US-1). Durations and dates come through the library formatters
   * (AC-3.2); the package kind, man-days, "Estimated man-days", "Max effort" and "Planned man-days" are `terms.details`'.
   * "Over by" takes the place of "Hours left" once a package is exceeded (D81); "Expired" is D83.
   */
  consumption: {
    /** The group's accessible name; never drawn (the card's title is the heading). */
    label: 'Consumption',
    loading: 'Loading consumption…',
    unavailable: {
      title: 'Consumption is unavailable',
      body: 'Operai could not load the hours recorded on this project, so no comparison is shown rather than one that could be too low. Try again in a moment.',
    },
    currentPeriod: 'Current period',
    packagePeriod: 'Package period',
    range: (from: string, to: string) => `${from} – ${to}`,
    since: (from: string) => `From ${from}, no expiry`,
    startsOn: 'Starts on',
    hoursUsedInPeriod: 'Hours used in this period',
    hoursUsed: 'Hours used',
    hoursLeft: 'Hours left',
    overBy: 'Over by',
    expired: 'Expired',
    yearlyNote: 'Hours left in a period do not carry over to the next one.',
    notStartedNote: 'Hours recorded before the start date do not count against the package.',
    manDaysUsed: 'Man-days used',
    fixedPriceNote: 'Counts all the hours recorded on the project. One man-day is 8 hours.',
    timeAndMaterialNote: 'Compared with the total of all positions. One man-day is 8 hours.',
  },
  team: {
    title: 'Team',
    edit: 'Edit people',
    empty: 'No people listed yet.',
    people: { title: 'People', label: 'People listed on this project' },
    teams: {
      title: 'Teams',
      edit: 'Edit teams',
      empty: 'No teams attached.',
      listLabel: 'Attached teams',
      unnamed: 'Team could not be loaded',
      archived: 'Archived',
      archivedNote: 'Archived: it stays on this project until it is removed.',
      counted: (n: number) => (n === 1 ? '1 person counts on this project' : `${n} people count on this project`),
      membersLabel: (name: string) => `Members of ${name}`,
      membersUnavailable: 'Members could not be loaded',
      noMembers: 'This team has no members.',
      deactivated: 'Deactivated',
      noAccess: 'No access to Projects',
      noAccessLegend:
        'People marked “No access to Projects” do not count as on this project until an administrator gives them access.',
      showAll: (n: number) => `Show all ${n} people`,
      showFewer: 'Show fewer',
      unavailable: {
        title: 'Some teams could not be loaded',
        body: 'Their members are not shown. People who are on this project only through a team may be missing from the lists of people, such as the task assignee.',
      },
      // AC-5.6, plan D15: shown instead of `unavailable` when teamsStatus is "rate_limited".
      rateLimited: {
        title: 'Too many requests',
        lead: 'You made too many requests, so teams and their members are not shown for now.',
        retryIn: (minutes: number) => (minutes === 1 ? 'Try again in a minute.' : `Try again in ${minutes} minutes.`),
        retryLater: 'Try again later.',
        consequences:
          'People who are on this project only through a team may be missing from lists of people, such as the task assignee, and may not be offered Record hours on this page. You can still record hours from My hours.',
        stillLimited: 'Checked again. Teams are still not shown.',
      },
      dialog: {
        title: 'Edit teams',
        description:
          'Everyone in an attached team who has access to Projects counts as part of this project: they can record hours, be given tasks and read the project’s linked meetings. This follows the team as it changes.',
        add: 'Attach a team',
        addHint: (n: number, max: number) =>
          `${n} of ${max} teams. Only active teams can be attached; an administrator creates teams in Admin.`,
        narrowHint: 'Type more of the name to narrow the list.',
        limitHint: (max: number) => `A project can have at most ${max} teams. Remove one to attach another.`,
        limitReached: (n: number, max: number) => `${n} of ${max} teams attached`,
        attached: 'Attached teams',
        none: 'No teams attached.',
        unnamed: 'Team that could not be loaded',
        removeHint:
          'Removing a team removes its members from this project, unless they are also listed or in another attached team.',
        removeButton: 'Remove',
        remove: (name: string) => `Remove ${name}`,
        removeUnnamed: (n: number) => `Remove team ${n} that could not be loaded`,
        search: {
          searching: 'Searching teams…',
          noMatch: 'No active team matches, or it is already attached.',
          forbidden: 'You may not attach teams.',
          unavailable: 'Teams could not be searched. Nothing was changed. Try again.',
          count: (n: number) => (n === 1 ? '1 team found' : `${n} teams found`),
        },
        submit: 'Save teams',
        busy: 'Saving…',
        errors: {
          team_archived: (names: string) =>
            `These teams were archived and can no longer be attached: ${names}. Remove them to save.`,
          team_not_found: 'A team you chose no longer exists. Close this dialog and try again.',
          teams_unavailable: 'Teams could not be loaded right now. Nothing was changed. Try again in a moment.',
          // Followed by `rateLimited.retryIn` or `retryLater`: the 429 of PUT …/teams, the one 429 of a project write.
          rate_limited: 'Too many requests, so nothing was changed.',
        },
      },
    },
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
    origin: 'Origine',
    fromTender: 'Da un bando',
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
    teams: 'Team salvati.',
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
  meetings: {
    heading: 'Meeting',
    loading: 'Caricamento dei meeting…',
    unavailable: 'Al momento non è possibile mostrare i meeting. Ricarica la pagina per riprovare.',
  },
  hours: {
    heading: 'Ore',
    loading: 'Caricamento delle ore…',
    unavailable: 'Le ore non sono disponibili. Ricarica la pagina per riprovare.',
  },
  consumption: {
    label: 'Consumo',
    loading: 'Caricamento del consumo…',
    unavailable: {
      title: 'Il consumo non è disponibile',
      body: 'Operai non è riuscito a caricare le ore registrate su questo progetto, quindi non mostra nessun confronto invece di uno che potrebbe essere troppo basso. Riprova tra un momento.',
    },
    currentPeriod: 'Periodo in corso',
    packagePeriod: 'Periodo del pacchetto',
    range: (from: string, to: string) => `${from} – ${to}`,
    since: (from: string) => `Dal ${from}, senza scadenza`,
    startsOn: 'Inizia il',
    hoursUsedInPeriod: 'Ore usate nel periodo',
    hoursUsed: 'Ore usate',
    hoursLeft: 'Ore rimaste',
    overBy: 'Sforato di',
    expired: 'Scaduto',
    yearlyNote: 'Le ore non usate in un periodo non passano a quello successivo.',
    notStartedNote: 'Le ore registrate prima della data di inizio non contano per il pacchetto.',
    manDaysUsed: 'Giornate usate',
    fixedPriceNote: 'Conta tutte le ore registrate sul progetto. Una giornata equivale a 8 ore.',
    timeAndMaterialNote: 'Confrontato con il totale di tutte le posizioni. Una giornata equivale a 8 ore.',
  },
  team: {
    title: 'Team',
    edit: 'Modifica persone',
    empty: 'Ancora nessuna persona in elenco.',
    people: { title: 'Persone', label: 'Persone elencate in questo progetto' },
    teams: {
      title: 'Team',
      edit: 'Modifica team',
      empty: 'Nessun team collegato.',
      listLabel: 'Team collegati',
      unnamed: 'Impossibile caricare il team',
      archived: 'Archiviato',
      archivedNote: 'Archiviato: resta su questo progetto finché non viene rimosso.',
      counted: (n: number) =>
        n === 1 ? '1 persona conta su questo progetto' : `${n} persone contano su questo progetto`,
      membersLabel: (name: string) => `Membri di ${name}`,
      membersUnavailable: 'Impossibile caricare i membri',
      noMembers: 'Questo team non ha membri.',
      deactivated: 'Disattivato',
      noAccess: 'Nessun accesso a Progetti',
      noAccessLegend:
        'Le persone con “Nessun accesso a Progetti” non contano come persone del progetto finché un amministratore non dà loro accesso.',
      showAll: (n: number) => `Mostra tutte le ${n} persone`,
      showFewer: 'Mostra meno',
      unavailable: {
        title: 'Impossibile caricare alcuni team',
        body: 'I loro membri non vengono mostrati. Le persone che sono sul progetto solo tramite un team potrebbero mancare negli elenchi di persone, come l’assegnatario di un’attività.',
      },
      rateLimited: {
        title: 'Troppe richieste',
        lead: 'Hai fatto troppe richieste, quindi per ora i team e i loro membri non vengono mostrati.',
        retryIn: (minutes: number) => (minutes === 1 ? 'Riprova tra un minuto.' : `Riprova tra ${minutes} minuti.`),
        retryLater: 'Riprova più tardi.',
        consequences:
          'Le persone che sono sul progetto solo tramite un team potrebbero mancare negli elenchi di persone, come l’assegnatario di un’attività, e potrebbe non essere offerto loro Registra ore in questa pagina. Si possono comunque registrare le ore da Le mie ore.',
        stillLimited: 'Controllato di nuovo. I team non vengono ancora mostrati.',
      },
      dialog: {
        title: 'Modifica team',
        description:
          'Chi fa parte di un team collegato e ha accesso a Progetti conta come parte di questo progetto: può registrare ore, ricevere attività e leggere i meeting collegati al progetto. Segue il team quando cambia.',
        add: 'Collega un team',
        addHint: (n: number, max: number) =>
          `${n} team su ${max}. Si possono collegare solo team attivi; un amministratore crea i team in Amministrazione.`,
        narrowHint: 'Scrivi altre lettere del nome per restringere l’elenco.',
        limitHint: (max: number) =>
          `Un progetto può avere al massimo ${max} team. Rimuovine uno per collegarne un altro.`,
        limitReached: (n: number, max: number) => `${n} team su ${max} collegati`,
        attached: 'Team collegati',
        none: 'Nessun team collegato.',
        unnamed: 'Team che non è stato possibile caricare',
        removeHint:
          'Rimuovere un team toglie i suoi membri da questo progetto, a meno che siano anche elencati o in un altro team collegato.',
        removeButton: 'Rimuovi',
        remove: (name: string) => `Rimuovi ${name}`,
        removeUnnamed: (n: number) => `Rimuovi il team ${n} che non è stato possibile caricare`,
        search: {
          searching: 'Ricerca dei team…',
          noMatch: 'Nessun team attivo corrisponde, oppure è già collegato.',
          forbidden: 'Non è consentito collegare team.',
          unavailable: 'Impossibile cercare i team. Non è stato modificato nulla. Riprova.',
          count: (n: number) => (n === 1 ? '1 team trovato' : `${n} team trovati`),
        },
        submit: 'Salva team',
        busy: 'Salvataggio…',
        errors: {
          team_archived: (names: string) =>
            `Questi team sono stati archiviati e non possono più essere collegati: ${names}. Rimuovili per salvare.`,
          team_not_found: 'Un team scelto non esiste più. Chiudi questa finestra e riprova.',
          teams_unavailable:
            'Al momento non è possibile caricare i team. Non è stato modificato nulla. Riprova tra poco.',
          rate_limited: 'Troppe richieste: non è stato modificato nulla.',
        },
      },
    },
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
