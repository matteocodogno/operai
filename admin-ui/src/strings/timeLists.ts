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
    /** The same failure on a change the person asked for: what they most need to know is that it did not happen. */
    actionBody: 'Your permissions could not be checked just now. Nothing was changed.',
  },
  /** Any other failure of a change. */
  failed: 'Something went wrong. Nothing was changed.',
  /** `404 not_found` on a change: no route deletes an item, so only a database reset gets here. */
  gone: 'That item no longer exists, so the lists were reloaded.',
  cards: {
    categories: 'Categories',
    projectWorkTypes: 'Project work types',
    dealWorkTypes: 'Deal work types',
  },
  columns: {
    requiresNote: 'Entries need a note',
    status: 'Status',
  },
  yes: 'Yes',
  no: 'No',
  /**
   * What the success banner says. Names are data: shown exactly as typed, in the viewer's language
   * around them. The Italian wording needs the noun's gender, hence one sentence per kind of item.
   */
  done: {
    /** One sentence per list: the banner sits above all three cards, so it says which list the item went to. */
    added: {
      categories: (name: string) => `Category “${name}” added.`,
      project: (name: string) => `Project work type “${name}” added.`,
      deal: (name: string) => `Deal work type “${name}” added.`,
    },
    renamed: (name: string) => `Renamed to “${name}”.`,
    /** Only the note flag of a category changed: say what that means, not just that something did. */
    noteRequired: (name: string) => `“${name}” updated: entries now need a note.`,
    noteOptional: (name: string) => `“${name}” updated: entries no longer need a note.`,
    retired: {
      category: (name: string) => `“${name}” retired. Entries that have it keep it. You can restore it from this list.`,
      workType: (name: string) => `“${name}” retired. Entries that have it keep it. You can restore it from this list.`,
    },
    restored: {
      category: (name: string) => `“${name}” restored. People can pick it again.`,
      workType: (name: string) => `“${name}” restored. People can pick it again.`,
    },
  },
  /** The Add / Rename form. The name being typed is data and never passes through here. */
  dialog: {
    addTitle: {
      categories: 'Add category',
      project: 'Add project work type',
      deal: 'Add deal work type',
    },
    renameTitle: {
      categories: 'Rename category',
      project: 'Rename project work type',
      deal: 'Rename deal work type',
    },
    nameHint: 'Shown exactly as you type it, in English and Italian.',
    requiresNote: 'Entries in this category need a note',
    nameTooLong: 'Use 80 characters at most.',
    nameNullCharacter: 'The name can’t contain a null character. Remove it.',
    /** `409 name_taken`: names are unique per list, ignoring case, and retired items count. */
    nameTaken: {
      category: 'A category with this name already exists. It may be retired.',
      workType: 'A work type with this name already exists in this list. It may be retired.',
    },
    /** A failure that is not about the name: the same words as the page's own states. */
    forbidden:
      "You can't manage the time lists. Managing the categories and work types needs a permission your role does not have.",
    authzUnavailable:
      'Authorization service unavailable. Your permissions could not be checked just now. Nothing was changed.',
  },
  /** Row buttons: the visible word, and the accessible name that says which item (the name is data). */
  row: {
    rename: 'Rename',
    retire: 'Retire',
    restore: 'Restore',
    retiring: 'Retiring…',
    restoring: 'Restoring…',
    renameOf: (name: string) => `Rename ${name}`,
    retireOf: (name: string) => `Retire ${name}`,
    restoreOf: (name: string) => `Restore ${name}`,
    retiringOf: (name: string) => `Retiring ${name}`,
    restoringOf: (name: string) => `Restoring ${name}`,
  },
  /** Per list: what the card says about itself. The ITEM names are data and never pass through here. */
  list: {
    categories: {
      add: 'Add category',
      empty: {
        title: 'No categories yet',
        body: 'Add one so people can record hours on work that is not in Operai.',
      },
      footnote: 'Entries keep their category, so it can be retired and restored but not deleted.',
    },
    project: {
      add: 'Add work type',
      empty: { title: 'No work types yet', body: 'Entries can be recorded without one.' },
      footnote: 'Entries keep their work type, so it can be retired and restored but not deleted.',
    },
    deal: {
      add: 'Add work type',
      empty: { title: 'No work types yet', body: 'Entries can be recorded without one.' },
      footnote: 'Entries keep their work type, so it can be retired and restored but not deleted.',
    },
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
    actionBody: 'Non è stato possibile verificare i permessi. Non è stato modificato nulla.',
  },
  failed: 'Qualcosa è andato storto. Non è stato modificato nulla.',
  gone: 'Quell’elemento non esiste più, quindi gli elenchi sono stati ricaricati.',
  cards: {
    categories: 'Categorie',
    projectWorkTypes: 'Tipi di lavoro per progetto',
    dealWorkTypes: 'Tipi di lavoro per opportunità',
  },
  columns: {
    requiresNote: 'Richiede una nota',
    status: 'Stato',
  },
  yes: 'Sì',
  no: 'No',
  done: {
    added: {
      categories: (name) => `Categoria “${name}” aggiunta.`,
      project: (name) => `Tipo di lavoro per progetto “${name}” aggiunto.`,
      deal: (name) => `Tipo di lavoro per opportunità “${name}” aggiunto.`,
    },
    renamed: (name) => `Nome cambiato in “${name}”.`,
    noteRequired: (name) => `“${name}” aggiornata: ora le registrazioni richiedono una nota.`,
    noteOptional: (name) => `“${name}” aggiornata: le registrazioni non richiedono più una nota.`,
    retired: {
      category: (name) =>
        `“${name}” ritirata. Le registrazioni che la hanno la conservano. Si può ripristinare da questo elenco.`,
      workType: (name) =>
        `“${name}” ritirato. Le registrazioni che lo hanno lo conservano. Si può ripristinare da questo elenco.`,
    },
    restored: {
      category: (name) => `“${name}” ripristinata. Si può scegliere di nuovo.`,
      workType: (name) => `“${name}” ripristinato. Si può scegliere di nuovo.`,
    },
  },
  dialog: {
    addTitle: {
      categories: 'Aggiungi categoria',
      project: 'Aggiungi tipo di lavoro per progetto',
      deal: 'Aggiungi tipo di lavoro per opportunità',
    },
    renameTitle: {
      categories: 'Rinomina categoria',
      project: 'Rinomina tipo di lavoro per progetto',
      deal: 'Rinomina tipo di lavoro per opportunità',
    },
    nameHint: 'Mostrato esattamente come lo si scrive, in inglese e in italiano.',
    requiresNote: 'Le registrazioni di questa categoria richiedono una nota',
    nameTooLong: 'Usare al massimo 80 caratteri.',
    nameNullCharacter: 'Il nome non può contenere un carattere nullo. Rimuoverlo.',
    nameTaken: {
      category: 'Esiste già una categoria con questo nome. Potrebbe essere ritirata.',
      workType: 'Esiste già un tipo di lavoro con questo nome in questo elenco. Potrebbe essere ritirato.',
    },
    forbidden:
      'Non si possono gestire gli elenchi ore. Gestire categorie e tipi di lavoro richiede un permesso che il proprio ruolo non ha.',
    authzUnavailable:
      'Servizio di autorizzazione non disponibile. Non è stato possibile verificare i permessi. Non è stato modificato nulla.',
  },
  row: {
    rename: 'Rinomina',
    retire: 'Ritira',
    restore: 'Ripristina',
    retiring: 'Ritiro…',
    restoring: 'Ripristino…',
    renameOf: (name) => `Rinomina ${name}`,
    retireOf: (name) => `Ritira ${name}`,
    restoreOf: (name) => `Ripristina ${name}`,
    retiringOf: (name) => `Ritiro di ${name}`,
    restoringOf: (name) => `Ripristino di ${name}`,
  },
  list: {
    categories: {
      add: 'Aggiungi categoria',
      empty: {
        title: 'Ancora nessuna categoria',
        body: 'Aggiungerne una permette di registrare ore su lavoro che non è in Operai.',
      },
      footnote: 'Le registrazioni conservano la loro categoria: si può ritirare e ripristinare, non eliminare.',
    },
    project: {
      add: 'Aggiungi tipo di lavoro',
      empty: { title: 'Ancora nessun tipo di lavoro', body: 'Le ore si possono registrare anche senza.' },
      footnote: 'Le registrazioni conservano il loro tipo di lavoro: si può ritirare e ripristinare, non eliminare.',
    },
    deal: {
      add: 'Aggiungi tipo di lavoro',
      empty: { title: 'Ancora nessun tipo di lavoro', body: 'Le ore si possono registrare anche senza.' },
      footnote: 'Le registrazioni conservano il loro tipo di lavoro: si può ritirare e ripristinare, non eliminare.',
    },
  },
}
