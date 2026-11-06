import type { PurchaseOrderRefusal } from '../lib/errors'

/**
 * The purchase order (PO) of a project made from a won deal (specs/022; ledger D38): its card on the
 * project page — the deal, the "no longer won" notice, the estimate, the ops-manager, the referent (read
 * live from the CRM, AC-3.8 – AC-3.10, and its edit, AC-3.7), the Bexio order id. The pick of the project
 * manager is in `strings/project.ts`.
 */
const en = {
  title: 'Purchase order',
  saved: {
    bexio: 'Bexio order saved.',
    referent: 'Referent saved.',
  },
  card: {
    deal: 'Deal',
    dealUnavailable: 'Deal title unavailable',
    estimate: 'Estimate',
    openEstimate: 'Open the estimate',
    opsManager: 'Ops manager',
    dealNotWon: {
      title: 'The deal is no longer won',
      body: 'It was reopened in the CRM. This purchase order is unchanged.',
    },
  },
  referent: {
    title: 'Referent',
    name: 'Name',
    jobTitle: 'Job title',
    email: 'Email',
    phone: 'Phone',
    none: 'No referent',
    unavailable: 'Referent unavailable',
    set: 'Set referent',
    change: 'Change referent',
    dialog: {
      title: 'Referent',
      description:
        'The person at the client whom the delivery talks to. Their details are read from the CRM each time this page is opened.',
      hint: 'The contacts of this project’s company. Choose “No referent” to clear it.',
      submit: 'Save referent',
      busy: 'Saving…',
      /** The picker's own wording for a contact list that could not be read (not the take form's). */
      loadFailed: 'The contacts could not be loaded.',
      /** Each refusal of the referent routes, in its own words. `referent_invalid` is one message for every reason (T18). */
      errors: {
        referent_invalid:
          'This contact cannot be the referent of this purchase order. Choose another contact, or clear the referent.',
        crm_unavailable: 'The CRM cannot be reached right now. Nothing was changed. Try again in a moment.',
        out_of_scope: 'You may not change the purchase orders of this entity.',
        purchase_order_not_found: 'This project has no purchase order.',
      } as Record<PurchaseOrderRefusal, string>,
    },
  },
  bexio: {
    label: 'Bexio order',
    hint: 'The order administration opened in Bexio. Free text, up to 64 characters; leave empty to clear it.',
    save: 'Save',
    saving: 'Saving…',
    tooLong: 'Use at most 64 characters.',
    none: 'Not set',
  },
}

const it: typeof en = {
  title: 'Ordine d’acquisto',
  saved: {
    bexio: 'Ordine Bexio salvato.',
    referent: 'Referente salvato.',
  },
  card: {
    deal: 'Trattativa',
    dealUnavailable: 'Titolo della trattativa non disponibile',
    estimate: 'Stima',
    openEstimate: 'Apri la stima',
    opsManager: 'Responsabile OPS',
    dealNotWon: {
      title: 'La trattativa non è più vinta',
      body: 'È stata riaperta nel CRM. Questo ordine d’acquisto resta invariato.',
    },
  },
  referent: {
    title: 'Referente',
    name: 'Nome',
    jobTitle: 'Ruolo',
    email: 'Email',
    phone: 'Telefono',
    none: 'Nessun referente',
    unavailable: 'Referente non disponibile',
    set: 'Imposta referente',
    change: 'Cambia referente',
    dialog: {
      title: 'Referente',
      description:
        'La persona presso il cliente con cui parla la delivery. I suoi dati sono letti dal CRM a ogni apertura di questa pagina.',
      hint: 'I contatti dell’azienda di questo progetto. Scegli “Nessun referente” per toglierlo.',
      submit: 'Salva referente',
      busy: 'Salvataggio…',
      loadFailed: 'Non è stato possibile caricare i contatti.',
      errors: {
        referent_invalid:
          'Questo contatto non può essere il referente di questo ordine d’acquisto. Scegli un altro contatto, oppure togli il referente.',
        crm_unavailable:
          'Al momento non è possibile raggiungere il CRM. Non è stato modificato nulla. Riprova tra un attimo.',
        out_of_scope: 'Non puoi modificare gli ordini d’acquisto di questa entità.',
        purchase_order_not_found: 'Questo progetto non ha un ordine d’acquisto.',
      },
    },
  },
  bexio: {
    label: 'Ordine Bexio',
    hint: 'L’ordine aperto dall’amministrazione in Bexio. Testo libero, al massimo 64 caratteri; lascia vuoto per cancellarlo.',
    save: 'Salva',
    saving: 'Salvataggio…',
    tooLong: 'Usa al massimo 64 caratteri.',
    none: 'Non impostato',
  },
}

export const purchaseOrder = { en, it }
