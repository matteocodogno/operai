/**
 * strings.common — copy shared by every admin screen: the generic actions, the
 * shared states (loading, permission denied, not found), the shared dialogs
 * (delete confirmation, guardrail), pagination and the entity names.
 */
export const en = {
  actions: {
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    delete: 'Delete',
    deleting: 'Deleting…',
    create: 'Create',
    creating: 'Creating…',
    retry: 'Retry',
    dismiss: 'Dismiss',
    ok: 'OK',
    edit: 'Edit',
    remove: 'Remove',
    removing: 'Removing…',
    add: 'Add',
    adding: 'Adding…',
    search: 'Search',
    searching: 'Searching…',
    clear: 'Clear',
  },
  fields: {
    name: 'Name',
    description: 'Description',
    email: 'Email',
    entity: 'Entity',
    jobTitle: 'Job title',
    roles: 'Roles',
    departments: 'Departments',
  },
  /** A cell or value with nothing to show. */
  emptyValue: '—',
  /** The "no value" option of a select. */
  noneOption: '— none —',
  actionsColumn: 'Actions',
  loading: 'Loading…',
  nameRequired: 'Name is required.',
  deleteFailed: 'Delete failed. Try again.',
  effectiveImmediately: 'Effective immediately — no separate publish step.',
  cannotDeleteSelf: "You can't delete your own account",
  /** Appended, visually hidden, to a disabled button's name: " — <reason>". */
  disabledReason: (reason: string) => ` — ${reason}`,
  entities: {
    welld_ch: 'WellD CH',
    welld_it: 'WellD Italia',
  },
  permissionDenied: {
    title: 'You no longer have admin access.',
    body: 'If this is unexpected, contact your administrator.',
  },
  notFound: {
    title: 'Page not found',
    body: 'This admin section doesn’t exist. Use the navigation above to pick Roles, Departments, Teams, Users or Audit.',
  },
  confirmDelete: {
    body: (name: string) => `‘${name}’ will be permanently deleted. This cannot be undone.`,
    untitled: 'Untitled',
  },
  guardrail: {
    lastAdminRoleTitle: "Can't remove the last administrator",
    lastAdminRoleMessage:
      'This is the last administrator — removing this role would leave nobody able to manage access. Assign another admin first.',
    lastAdminDeleteTitle: "Can't delete this user",
    lastAdminDeleteMessage:
      'This is the last administrator — deleting this user would leave nobody able to manage access. Assign another admin first.',
  },
  pagination: {
    label: 'Pagination',
    previous: 'Previous',
    next: 'Next',
    status: (page: number, totalPages: number, start: number, end: number, total: number) =>
      `Page ${page} of ${totalPages} — Showing ${start}–${end} of ${total}`,
    statusEmpty: (page: number, totalPages: number) => `Page ${page} of ${totalPages} — Showing 0 of 0`,
  },
}

export const it: typeof en = {
  actions: {
    save: 'Salva',
    saving: 'Salvataggio…',
    cancel: 'Annulla',
    delete: 'Elimina',
    deleting: 'Eliminazione…',
    create: 'Crea',
    creating: 'Creazione…',
    retry: 'Riprova',
    dismiss: 'Chiudi',
    ok: 'OK',
    edit: 'Modifica',
    remove: 'Rimuovi',
    removing: 'Rimozione…',
    add: 'Aggiungi',
    adding: 'Aggiunta…',
    search: 'Cerca',
    searching: 'Ricerca…',
    clear: 'Cancella',
  },
  fields: {
    name: 'Nome',
    description: 'Descrizione',
    email: 'Email',
    entity: 'Società',
    jobTitle: 'Qualifica',
    roles: 'Ruoli',
    departments: 'Reparti',
  },
  emptyValue: '—',
  noneOption: '— nessuna —',
  actionsColumn: 'Azioni',
  loading: 'Caricamento…',
  nameRequired: 'Il nome è obbligatorio.',
  deleteFailed: 'Eliminazione non riuscita. Riprovare.',
  effectiveImmediately: 'Effettivo subito, senza un passaggio di pubblicazione.',
  cannotDeleteSelf: 'Non è possibile eliminare il proprio account',
  disabledReason: (reason: string) => ` — ${reason}`,
  entities: {
    welld_ch: 'WellD CH',
    welld_it: 'WellD Italia',
  },
  permissionDenied: {
    title: 'L’accesso all’amministrazione non è più disponibile.',
    body: 'Se non è previsto, contattare l’amministratore.',
  },
  notFound: {
    title: 'Pagina non trovata',
    body: 'Questa sezione di amministrazione non esiste. Usare la navigazione in alto per scegliere Ruoli, Reparti, Team, Utenti o Audit.',
  },
  confirmDelete: {
    body: (name: string) => `‘${name}’ sarà eliminato definitivamente. L’operazione non è reversibile.`,
    untitled: 'Senza titolo',
  },
  guardrail: {
    lastAdminRoleTitle: 'Impossibile rimuovere l’ultimo amministratore',
    lastAdminRoleMessage:
      'Questo è l’ultimo amministratore: rimuovendo questo ruolo nessuno potrebbe più gestire gli accessi. Nominare prima un altro amministratore.',
    lastAdminDeleteTitle: 'Impossibile eliminare questo utente',
    lastAdminDeleteMessage:
      'Questo è l’ultimo amministratore: eliminando questo utente nessuno potrebbe più gestire gli accessi. Nominare prima un altro amministratore.',
  },
  pagination: {
    label: 'Paginazione',
    previous: 'Precedente',
    next: 'Successiva',
    status: (page: number, totalPages: number, start: number, end: number, total: number) =>
      `Pagina ${page} di ${totalPages} — ${start}–${end} di ${total}`,
    statusEmpty: (page: number, totalPages: number) => `Pagina ${page} di ${totalPages} — 0 di 0`,
  },
}
