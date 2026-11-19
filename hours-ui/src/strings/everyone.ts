/**
 * Everyone's hours: the page's own copy (T22 gave it the heading; T29 the rest). What it shares with My
 * hours — the Filters card, the Totals card, "Load more", the banners that name what could not be read —
 * is in `filters`, `totals`, `entries` and `names`; this file holds the oversight page's own words: the
 * header, the denial and the outage, the flat table of entries and how a person is named.
 *
 * A person's NAME is never in this file: it is shown as `auth` resolved it, in both languages.
 */

const en = {
  heading: "Everyone's hours",
  /** AC-1.6, said once: a holder reads everyone's hours and changes none of them. */
  description: 'Read only. Hours can be changed only by the person who recorded them.',
  /** The permissions have not arrived yet: nothing is asked until they do. */
  loading: 'Loading…',
  /** A person who may not see everyone's hours (a typed address, a grant withdrawn meanwhile; AC-4.2). */
  denied: {
    title: "You can't see everyone's hours",
    body: "Seeing everyone's hours needs a permission you do not have. Ask an administrator for it, then reload the page.",
    back: 'Go to my hours',
  },
  /** `auth` could not say whether the person may (AC-5.4): refused, never allowed, and My hours is unaffected. */
  authUnavailable: {
    title: 'Authorization service unavailable',
    body: "We could not check whether you may see everyone's hours, so nothing is shown. Your own hours are not affected.",
    back: 'Go to my hours',
  },
  /** How a person is named wherever one is listed (the Person column, the Person filter, the person totals). */
  person: {
    /** A name that could not be read (the identities source did not answer, or the account is unknown). */
    unknown: 'Unknown user',
    /** An account that has been deactivated: its name is no longer resolved, the hours stay. */
    deactivated: (name: string) => `${name} (deactivated)`,
  },
  entries: {
    loading: 'Loading hours…',
    empty: {
      title: 'No hours have been recorded in this period',
      body: 'Hours appear here as people record them.',
    },
    error: {
      title: 'Hours could not be loaded',
      body: 'Try again in a moment.',
    },
    /** A Custom range that cannot be sent: nothing was asked, and the date fields say why. */
    invalidPeriod: 'Choose a valid period to see the entries.',
    /** The table's name for assistive technology; the order is the server's, newest day first. */
    caption: 'Entries of everyone, newest day first',
    columns: {
      day: 'Day',
      person: 'Person',
      on: 'On',
      details: 'Details',
      time: 'Time',
    },
    /** The standing note about what the viewer may not read (AC-4.10): read in place, never announced. */
    hidden: {
      label: 'Entries without a visible name',
      body: 'Some projects, deals or meetings are not visible to you, so they show without a name. Their hours are still counted.',
    },
  },
}

const it: typeof en = {
  heading: 'Le ore di tutti',
  description: 'Sola lettura. Le ore possono essere modificate solo da chi le ha registrate.',
  loading: 'Caricamento…',
  denied: {
    title: 'Non puoi vedere le ore di tutti',
    body: 'Per vedere le ore di tutti serve un permesso che non hai. Chiedilo a un amministratore, poi ricarica la pagina.',
    back: 'Vai alle mie ore',
  },
  authUnavailable: {
    title: 'Servizio di autorizzazione non disponibile',
    body: 'Non siamo riusciti a verificare se puoi vedere le ore di tutti, quindi non viene mostrato nulla. Le tue ore non sono interessate.',
    back: 'Vai alle mie ore',
  },
  person: {
    unknown: 'Utente sconosciuto',
    deactivated: (name: string) => `${name} (disattivato)`,
  },
  entries: {
    loading: 'Caricamento delle ore…',
    empty: {
      title: 'Nessuna ora registrata in questo periodo',
      body: 'Le ore compaiono qui man mano che le persone le registrano.',
    },
    error: {
      title: 'Impossibile caricare le ore',
      body: 'Riprova tra un momento.',
    },
    invalidPeriod: 'Scegli un periodo valido per vedere le registrazioni.',
    caption: 'Registrazioni di tutti, dal giorno più recente',
    columns: {
      day: 'Giorno',
      person: 'Persona',
      on: 'Su',
      details: 'Dettagli',
      time: 'Tempo',
    },
    hidden: {
      label: 'Registrazioni senza nome visibile',
      body: 'Alcuni progetti, opportunità o riunioni non sono visibili a te, quindi compaiono senza nome. Le loro ore sono comunque conteggiate.',
    },
  },
}

export const everyone = { en, it }
