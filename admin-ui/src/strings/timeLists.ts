/**
 * strings.timeLists — the Time lists screen: the categories and the two work-type lists people pick
 * from when they record hours (specs/029-time-tracking, design.md S5).
 *
 * The NAMES of the items (a category called "Formazione") are data, shown exactly as typed in both
 * languages (AC-3.8); they never pass through this catalog.
 */
export const en = {
  heading: 'Time lists',
  description: 'Categories and work types people pick from when they record hours.',
  loading: 'Loading time lists…',
  loadError: 'Could not load the time lists.',
  /**
   * The denial. Its own title: the person is on this screen, so they hold Admin access, and the
   * generic "You no longer have admin access." would be untrue.
   */
  forbidden: {
    title: "You can't manage the time lists",
    body: 'Managing the categories and work types needs a permission your role does not have.',
  },
  /** `503 authz_unavailable` (ADR-0014): hours-api could not check the permission, nothing changed. */
  authzUnavailable: {
    title: 'Authorization service unavailable',
    body: 'Your permissions could not be checked just now. Try again in a moment.',
  },
  cards: {
    categories: 'Categories',
    projectWorkTypes: 'Project work types',
    dealWorkTypes: 'Deal work types',
  },
}

export const it: typeof en = {
  heading: 'Elenchi ore',
  description: 'Categorie e tipi di lavoro tra cui si sceglie quando si registrano le ore.',
  loading: 'Caricamento degli elenchi ore…',
  loadError: 'Impossibile caricare gli elenchi ore.',
  forbidden: {
    title: 'Non si possono gestire gli elenchi ore',
    body: 'Gestire categorie e tipi di lavoro richiede un permesso che il proprio ruolo non ha.',
  },
  authzUnavailable: {
    title: 'Servizio di autorizzazione non disponibile',
    body: 'Non è stato possibile verificare i permessi. Riprovare tra un momento.',
  },
  cards: {
    categories: 'Categorie',
    projectWorkTypes: 'Tipi di lavoro per progetto',
    dealWorkTypes: 'Tipi di lavoro per opportunità',
  },
}
