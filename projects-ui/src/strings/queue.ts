/** The to-start queue (T12) and taking a deal from it (T13, T31). */
import type { TakeRefusal } from '../lib/errors'

const en = {
  heading: 'To start',
  description: 'Won deals no project has taken yet. Take one to start the work.',
  caption: 'Deals to start',
  filters: 'Filters',
  searchHint: 'Part of a deal title or a company name',
  entity: 'Entity',
  loading: 'Loading the deals to start…',
  emptyTitle: 'Nothing waiting to start',
  emptyBody: 'Every won deal has a project. A deal appears here as soon as it is won in the CRM.',
  noMatchTitle: 'No deal matches these filters',
  noMatchBody: 'Try a different search or clear a filter.',
  truncated: 'There are more deals than can be listed: showing the newest 500. Search or filter to find an older one.',
  crmUnavailable: {
    title: 'The CRM cannot be reached',
    body: 'The deals to start are read from the CRM, which does not answer right now. Try again in a moment.',
  },
  companyUnavailable: 'Company unavailable',
  columns: {
    deal: 'Deal',
    company: 'Company',
    entity: 'Entity',
    won: 'Won',
    estimate: 'Estimate',
  },
  take: {
    actions: {
      column: 'Actions',
      newProject: 'New project',
      newProjectFor: (title: string) => `New project: ${title}`,
    },
    project: {
      title: 'New project from a deal',
      description: (company: string, entity: string) =>
        `A planned project for ${company} (${entity}) with its purchase order, made from this deal. The company and the entity come from the deal.`,
      typeHint: 'The kind of work. It cannot be changed once the project exists.',
      submit: 'Create project',
      busy: 'Creating…',
    },
    terms: {
      legend: 'Purchase order terms',
      estimatedManDaysFromEstimate: 'From the estimate',
    },
    opsManager: {
      label: 'Ops manager',
      hint: 'Gets the purchase order and picks the project manager.',
      allEntities: 'All entities',
      required: 'Choose who receives this purchase order.',
      loading: 'Loading the ops managers…',
      none: 'No ops manager or administrator is available for this entity, so no one can receive this purchase order.',
    },
    /** The referent picker (AC-3.6): shared with the purchase order's referent edit. */
    referent: {
      label: 'Referent',
      hint: 'Optional. The person at the client whom the delivery talks to. You can set it later.',
      none: 'No referent',
      loading: 'Loading the contacts…',
      empty: 'This company has no contacts in the CRM, so there is no referent to choose.',
      loadFailed: 'The contacts could not be loaded.',
      option: (name: string, jobTitle: string | null) => (jobTitle === null ? name : `${name} — ${jobTitle}`),
    },
    /** Each refusal of taking a deal, in its own words (AC-1.11, AC-4.2). */
    errors: {
      deal_not_found: 'This deal no longer exists in the CRM.',
      deal_not_won: 'This deal is no longer won in the CRM, so it cannot be taken.',
      deal_taken: 'A project has just taken this deal.',
      out_of_scope: 'You may not take deals of this entity.',
      forbidden: 'You may not take deals.',
      ops_manager_invalid: 'This person cannot receive the purchase order of this deal. Choose another ops manager.',
      referent_invalid: 'This contact cannot be the referent. Choose another contact, or leave the referent empty.',
      identity_unavailable:
        'The user directory cannot be reached right now, so the ops manager could not be checked. Nothing was created. Try again in a moment.',
      estimated_man_days_from_estimate:
        'The estimated man-days come from the deal’s estimate and cannot be entered here.',
      crm_unavailable: 'The CRM cannot be reached right now. Try again in a moment.',
      estimai_unavailable:
        'EstimAI cannot be reached right now, so the estimate’s man-days could not be read. Nothing was created. Try again in a moment.',
      estimai_unconfigured:
        'EstimAI is not set up for Projects, so the estimate’s man-days could not be read. Nothing was created. Ask an administrator.',
    } as Record<TakeRefusal, string>,
  },
}

const it: typeof en = {
  heading: 'Da avviare',
  description:
    'Le trattative vinte che nessun progetto ha ancora preso in carico. Prendine una per far partire il lavoro.',
  caption: 'Trattative da avviare',
  filters: 'Filtri',
  searchHint: 'Parte del titolo di una trattativa o del nome di un’azienda',
  entity: 'Entità',
  loading: 'Caricamento delle trattative da avviare…',
  emptyTitle: 'Niente in attesa di avvio',
  emptyBody: 'Ogni trattativa vinta ha un progetto. Una trattativa compare qui appena viene vinta nel CRM.',
  noMatchTitle: 'Nessuna trattativa corrisponde ai filtri',
  noMatchBody: 'Prova una ricerca diversa o togli un filtro.',
  truncated:
    'Le trattative sono più di quelle elencabili: sono mostrate le 500 più recenti. Cerca o filtra per trovarne una più vecchia.',
  crmUnavailable: {
    title: 'Impossibile raggiungere il CRM',
    body: 'Le trattative da avviare sono lette dal CRM, che al momento non risponde. Riprova tra un attimo.',
  },
  companyUnavailable: 'Azienda non disponibile',
  columns: {
    deal: 'Trattativa',
    company: 'Azienda',
    entity: 'Entità',
    won: 'Vinta il',
    estimate: 'Stima',
  },
  take: {
    actions: {
      column: 'Azioni',
      newProject: 'Nuovo progetto',
      newProjectFor: (title: string) => `Nuovo progetto: ${title}`,
    },
    project: {
      title: 'Nuovo progetto da una trattativa',
      description: (company: string, entity: string) =>
        `Un progetto pianificato per ${company} (${entity}) con il suo ordine d’acquisto, creato da questa trattativa. L’azienda e l’entità vengono dalla trattativa.`,
      typeHint: 'Il tipo di lavoro. Non si può cambiare dopo la creazione del progetto.',
      submit: 'Crea progetto',
      busy: 'Creazione…',
    },
    terms: {
      legend: 'Termini dell’ordine d’acquisto',
      estimatedManDaysFromEstimate: 'Dalla stima',
    },
    opsManager: {
      label: 'Responsabile OPS',
      hint: 'Riceve l’ordine d’acquisto e sceglie il project manager.',
      allEntities: 'Tutte le entità',
      required: 'Scegli chi riceve questo ordine d’acquisto.',
      loading: 'Caricamento dei responsabili OPS…',
      none: 'Nessun responsabile OPS né amministratore è disponibile per questa entità, quindi nessuno può ricevere questo ordine d’acquisto.',
    },
    referent: {
      label: 'Referente',
      hint: 'Facoltativo. La persona presso il cliente con cui parla la delivery. Puoi impostarlo dopo.',
      none: 'Nessun referente',
      loading: 'Caricamento dei contatti…',
      empty: 'Questa azienda non ha contatti nel CRM, quindi non c’è un referente da scegliere.',
      loadFailed: 'Non è stato possibile caricare i contatti.',
      option: (name: string, jobTitle: string | null) => (jobTitle === null ? name : `${name} — ${jobTitle}`),
    },
    errors: {
      deal_not_found: 'Questa trattativa non esiste più nel CRM.',
      deal_not_won: 'Questa trattativa non è più vinta nel CRM, quindi non può essere presa in carico.',
      deal_taken: 'Un progetto ha appena preso in carico questa trattativa.',
      out_of_scope: 'Non puoi prendere in carico trattative di questa entità.',
      forbidden: 'Non puoi prendere in carico trattative.',
      ops_manager_invalid:
        'Questa persona non può ricevere l’ordine d’acquisto di questa trattativa. Scegli un altro responsabile OPS.',
      referent_invalid:
        'Questo contatto non può essere il referente. Scegli un altro contatto, oppure lascia vuoto il referente.',
      identity_unavailable:
        'L’elenco degli utenti al momento non è raggiungibile, quindi non si è potuto verificare il responsabile OPS. Non è stato creato nulla. Riprova tra un attimo.',
      estimated_man_days_from_estimate:
        'I giorni-uomo stimati arrivano dalla stima della trattativa e non si inseriscono qui.',
      crm_unavailable: 'Al momento non è possibile raggiungere il CRM. Riprova tra un attimo.',
      estimai_unavailable:
        'Al momento non è possibile raggiungere EstimAI, quindi i giorni-uomo della stima non si sono potuti leggere. Non è stato creato nulla. Riprova tra un attimo.',
      estimai_unconfigured:
        'EstimAI non è configurato per Progetti, quindi i giorni-uomo della stima non si sono potuti leggere. Non è stato creato nulla. Chiedi a un amministratore.',
    },
  },
}

export const queue = { en, it }
