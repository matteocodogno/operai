/**
 * The shell's copy (INC-24, INC-25): every string the suite chrome shows — the
 * header, sidebar, user menu, About dialog, footer, toasts, the remote-loading
 * boundary, /no-access and /account. Components never inline copy; the
 * no-hardcoded-strings test (lib/noHardcodedStrings.test.ts) scans every .tsx
 * under src/ and the parity test (strings.test.ts) keeps the Italian complete.
 *
 * One catalog per language, the Italian typed as the English; the language is
 * resolved once by the library (`selectStrings` → `resolveLocale`), from the
 * `<html lang>` the shell sets at startup (see lib/documentLanguage.ts). Product
 * names stay as they are in both languages (Operai, EstimAI); the refund tool
 * is "Rimborsi" in Italian, its name there.
 */
import { selectStrings } from '@operai/ui'
import type { NotificationSeverity } from './lib/notifications'

const en = {
  /** Tool names as the sidebar, the About dialog and the remote boundary show them. */
  tools: {
    estimai: 'EstimAI',
    refund: 'Refund',
    admin: 'Admin',
    inventory: 'Inventory',
    crm: 'CRM',
    meetings: 'Meetings',
    projects: 'Projects',
    letterheads: 'Letterheads',
    accounting: 'Accounting',
    notify: 'Notify',
    notifications: 'Notifications',
    myDevices: 'My devices',
    myMeetings: 'My meetings',
    // specs/029-time-tracking: the Hours remote's name (the loading/error boundary, the About
    // dialog) and its menu row. Not a sidebar tool: every signed-in user records their own hours.
    hours: 'Hours',
    myHours: 'My hours',
  },
  app: {
    description:
      'AI-assisted software consulting toolsuite — estimation, review, retrospectives, and proposals, all in one place.',
    tagline: 'AI tools built by craftspeople, for craftspeople.',
  },
  layout: {
    skipToContent: 'Skip to content',
    toolNavigation: 'Tool navigation',
    headerPlaceholder: 'Header placeholder — suite chrome (logo, About, user menu, theme toggle) lands in T6.',
    sidebarPlaceholder: 'Sidebar placeholder — tool switcher (EstimAI, Refund) lands in T7.',
    footerPlaceholder: 'Footer placeholder — legal link, version, company info land in T8.',
  },
  /** The confirmation shown when a remote has registered a navigation blocker (specs/20261104-meetings, AC-2.10). */
  floating: {
    // The floating slot (specs/20261104-meetings A13): the frame around a remote's widget, and what shows while it loads
    // or when it cannot load.
    recorder: {
      label: 'Recording in progress',
      moveLabel: 'Move the recorder',
      moveHint: 'Use the arrow keys to move it around the edge of the window.',
      fallback: 'Recording in progress',
      open: 'Open meeting',
    },
  },
  leavePage: {
    title: 'Leave this page?',
    // Shown only if the remote unregistered between the click and the render.
    fallbackBody: 'You have work on this page that has not been saved.',
    leave: 'Leave',
    leaving: 'Leaving…',
    stay: 'Stay',
    close: 'Close',
  },
  logoMenu: {
    trigger: (app: string) => `${app} menu`,
    about: (app: string) => `About ${app}`,
  },
  sidebar: {
    expand: 'Expand sidebar',
    collapse: 'Collapse sidebar',
    collapseShort: 'Collapse',
    /** The pinned group of rarely used tools above Admin (Letterheads). */
    settings: 'Settings',
  },
  theme: {
    system: 'System theme (auto)',
    light: 'Light theme',
    dark: 'Dark theme',
  },
  bell: {
    label: 'Notifications',
    unread: (count: number) => (count === 1 ? '1 unread notification' : `${count} unread notifications`),
  },
  userMenu: {
    accountFallback: 'Account',
    myProfile: 'My profile',
    myDevices: 'My devices',
    myMeetings: 'My meetings',
    myHours: 'My hours',
    signOut: 'Sign out',
  },
  about: {
    title: (app: string) => `About ${app}`,
    close: 'Close',
    version: 'Version',
    author: 'Author',
    components: 'Components',
  },
  footer: {
    legal: 'Legal information',
    version: (version: string) => `v${version}`,
  },
  toast: {
    severity: (label: string) => `Severity: ${label}`,
    severities: {
      info: 'info',
      success: 'success',
      warning: 'warning',
      error: 'error',
    } satisfies Record<NotificationSeverity, string>,
    open: 'Open',
    dismiss: 'Dismiss notification',
  },
  remote: {
    loading: (module: string) => `Loading ${module}…`,
    failed: (module: string) => `${module} couldn't load. Check your connection and try again.`,
    retry: 'Retry',
  },
  routePending: {
    loading: 'Loading…',
  },
  noAccess: {
    title: 'No apps available yet',
    body: 'Ask your administrator to grant you access to a tool.',
  },
  account: {
    title: 'My profile',
    address: 'Home address',
    loading: 'Loading your address…',
    error: "Couldn't load your address.",
    retry: 'Retry',
    none: 'No address on file',
    contactAdmin: 'Contact an admin to update this.',
  },
  push: {
    heading: 'Push notifications',
    description:
      'Get a system notification on this computer when Operai is not open. Push notifications are always in English.',
    loading: 'Loading push notification settings…',
    loadError: "Couldn't load your push notification settings.",
    retry: 'Retry',
    thisBrowser: 'This browser',
    status: { on: 'On', off: 'Off', blocked: 'Blocked', unavailable: 'Not available' },
    turnOn: 'Turn on',
    turningOn: 'Waiting for your browser…',
    turnOff: 'Turn off',
    turningOff: 'Turning off…',
    offHint: 'Your browser will ask for permission to show notifications.',
    onHint: 'This browser shows a notification when Operai is not open and visible.',
    unsupported:
      'Push notifications are not available on this browser. They work on current desktop Chrome, Edge, Firefox and Safari on macOS.',
    blocked:
      "Notifications are blocked for Operai in this browser. Allow them in the browser's site settings, then reload this page.",
    notAllowed:
      "Push notifications weren't turned on because the browser didn't allow notifications. Choose Allow when it asks.",
    enabled: 'Push notifications are on for this browser.',
    disabled: 'Push notifications are off for this browser.',
    errors: {
      generic: "Couldn't change push notifications. Check your connection and try again.",
      deviceLimit: 'You already have 20 devices. Remove one below, then turn this browser on.',
      endpointNotAllowed:
        "This browser's notification service isn't supported, so push notifications can't be turned on here.",
      unavailable: 'Push notifications are switched off right now. Try again later.',
      subscribeFailed:
        "Your browser couldn't set up push notifications. Check that it allows push messaging, then try again.",
      turnOffFailed: "Couldn't turn off push notifications. Try again.",
    },
    devices: {
      title: 'Your devices',
      caption: 'Browsers that receive your push notifications',
      columnBrowser: 'Browser',
      columnSince: 'Turned on',
      columnActions: 'Actions',
      thisBrowser: 'This browser',
      remove: 'Remove',
      removeLabel: (label: string, date: string) => `Remove ${label}, turned on ${date}`,
      emptyTitle: 'No devices yet',
      emptyBody: 'Turn on push notifications in a browser and it will appear here.',
    },
    removeDialog: {
      title: (label: string) => `Remove ${label}?`,
      body: 'It will stop receiving push notifications. You can turn them on again from that browser.',
      bodyThisBrowser: 'This browser will stop receiving push notifications. You can turn them on again at any time.',
      confirm: 'Remove',
      busy: 'Removing…',
      cancel: 'Cancel',
      close: 'Close',
      error: "Couldn't remove this device. Try again.",
    },
    removed: (label: string) => `Removed ${label}.`,
  },
  pushPrompt: {
    title: 'Turn on push notifications?',
    body: 'Get a system notification on this computer when Operai is not open. Your browser will ask for permission next. You can change this at any time in My profile.',
    confirm: 'Turn on',
    busy: 'Waiting for your browser…',
    cancel: 'No thanks',
    close: 'Close',
  },
}

const it: typeof en = {
  tools: {
    estimai: 'EstimAI',
    refund: 'Rimborsi',
    admin: 'Amministrazione',
    inventory: 'Inventario',
    crm: 'CRM',
    meetings: 'Riunioni',
    projects: 'Progetti',
    letterheads: 'Carte intestate',
    accounting: 'Contabilità',
    notify: 'Notifiche',
    notifications: 'Notifiche',
    myDevices: 'I miei dispositivi',
    myMeetings: 'Le mie riunioni',
    hours: 'Ore',
    myHours: 'Le mie ore',
  },
  app: {
    description:
      'Suite di strumenti con IA per la consulenza software — stime, revisioni, retrospettive e proposte, tutto in un unico posto.',
    tagline: 'Strumenti di IA costruiti da artigiani, per artigiani.',
  },
  layout: {
    skipToContent: 'Vai al contenuto',
    toolNavigation: 'Navigazione strumenti',
    headerPlaceholder:
      'Segnaposto intestazione — gli elementi della suite (logo, Informazioni, menu utente, tema) arrivano con T6.',
    sidebarPlaceholder: 'Segnaposto barra laterale — il selettore degli strumenti (EstimAI, Rimborsi) arriva con T7.',
    footerPlaceholder: 'Segnaposto piè di pagina — note legali, versione e dati aziendali arrivano con T8.',
  },
  floating: {
    recorder: {
      label: 'Registrazione in corso',
      moveLabel: 'Sposta il registratore',
      moveHint: 'Usa i tasti freccia per spostarlo lungo il bordo della finestra.',
      fallback: 'Registrazione in corso',
      open: 'Apri la riunione',
    },
  },
  leavePage: {
    title: 'Uscire da questa pagina?',
    fallbackBody: 'In questa pagina ci sono dati non ancora salvati.',
    leave: 'Esci',
    leaving: 'Uscita…',
    stay: 'Resta',
    close: 'Chiudi',
  },
  logoMenu: {
    trigger: (app: string) => `Menu ${app}`,
    about: (app: string) => `Informazioni su ${app}`,
  },
  sidebar: {
    expand: 'Espandi barra laterale',
    collapse: 'Comprimi barra laterale',
    collapseShort: 'Comprimi',
    settings: 'Impostazioni',
  },
  theme: {
    system: 'Tema di sistema (automatico)',
    light: 'Tema chiaro',
    dark: 'Tema scuro',
  },
  bell: {
    label: 'Notifiche',
    unread: (count: number) => (count === 1 ? '1 notifica non letta' : `${count} notifiche non lette`),
  },
  userMenu: {
    accountFallback: 'Account',
    myProfile: 'Il mio profilo',
    myDevices: 'I miei dispositivi',
    myMeetings: 'Le mie riunioni',
    myHours: 'Le mie ore',
    signOut: 'Esci',
  },
  about: {
    title: (app: string) => `Informazioni su ${app}`,
    close: 'Chiudi',
    version: 'Versione',
    author: 'Autore',
    components: 'Componenti',
  },
  footer: {
    legal: 'Note legali',
    version: (version: string) => `v${version}`,
  },
  toast: {
    severity: (label: string) => `Gravità: ${label}`,
    severities: {
      info: 'informazione',
      success: 'operazione riuscita',
      warning: 'avviso',
      error: 'errore',
    },
    open: 'Apri',
    dismiss: 'Chiudi notifica',
  },
  remote: {
    loading: (module: string) => `Caricamento di ${module}…`,
    failed: (module: string) => `Impossibile caricare ${module}. Verificare la connessione e riprovare.`,
    retry: 'Riprova',
  },
  routePending: {
    loading: 'Caricamento…',
  },
  noAccess: {
    title: 'Nessuno strumento disponibile',
    body: "Chiedere all'amministratore l'accesso a uno strumento.",
  },
  account: {
    title: 'Il mio profilo',
    address: 'Indirizzo di residenza',
    loading: "Caricamento dell'indirizzo…",
    error: "Impossibile caricare l'indirizzo.",
    retry: 'Riprova',
    none: 'Nessun indirizzo registrato',
    contactAdmin: 'Per aggiornarlo, rivolgersi a un amministratore.',
  },
  push: {
    heading: 'Notifiche push',
    description:
      'Ricevi una notifica di sistema su questo computer quando Operai non è aperto. Le notifiche push sono sempre in inglese.',
    loading: 'Caricamento delle impostazioni delle notifiche push…',
    loadError: 'Impossibile caricare le impostazioni delle notifiche push.',
    retry: 'Riprova',
    thisBrowser: 'Questo browser',
    status: { on: 'Attive', off: 'Disattivate', blocked: 'Bloccate', unavailable: 'Non disponibili' },
    turnOn: 'Attiva',
    turningOn: 'In attesa del browser…',
    turnOff: 'Disattiva',
    turningOff: 'Disattivazione…',
    offHint: 'Il browser chiederà il permesso di mostrare le notifiche.',
    onHint: 'Questo browser mostra una notifica quando Operai non è aperto e visibile.',
    unsupported:
      'Le notifiche push non sono disponibili su questo browser. Funzionano su Chrome, Edge, Firefox e Safari per computer (macOS) aggiornati.',
    blocked:
      'Le notifiche sono bloccate per Operai in questo browser. Consentile dalle impostazioni del sito nel browser, poi ricarica questa pagina.',
    notAllowed:
      'Le notifiche push non sono state attivate perché il browser non ha consentito le notifiche. Scegli Consenti quando lo chiede.',
    enabled: 'Le notifiche push sono attive su questo browser.',
    disabled: 'Le notifiche push sono disattivate su questo browser.',
    errors: {
      generic: 'Impossibile modificare le notifiche push. Controlla la connessione e riprova.',
      deviceLimit: 'Hai già 20 dispositivi. Rimuovine uno qui sotto, poi attiva questo browser.',
      endpointNotAllowed:
        'Il servizio di notifiche di questo browser non è supportato, quindi qui non si possono attivare le notifiche push.',
      unavailable: 'Le notifiche push sono disattivate al momento. Riprova più tardi.',
      subscribeFailed:
        'Il browser non è riuscito a configurare le notifiche push. Controlla che consenta i messaggi push e riprova.',
      turnOffFailed: 'Impossibile disattivare le notifiche push. Riprova.',
    },
    devices: {
      title: 'I tuoi dispositivi',
      caption: 'Browser che ricevono le tue notifiche push',
      columnBrowser: 'Browser',
      columnSince: 'Attivo dal',
      columnActions: 'Azioni',
      thisBrowser: 'Questo browser',
      remove: 'Rimuovi',
      removeLabel: (label, date) => `Rimuovi ${label}, attivo dal ${date}`,
      emptyTitle: 'Nessun dispositivo',
      emptyBody: 'Attiva le notifiche push in un browser e comparirà qui.',
    },
    removeDialog: {
      title: (label) => `Rimuovere ${label}?`,
      body: 'Smetterà di ricevere notifiche push. Potrai riattivarle da quel browser.',
      bodyThisBrowser: 'Questo browser smetterà di ricevere notifiche push. Potrai riattivarle in qualsiasi momento.',
      confirm: 'Rimuovi',
      busy: 'Rimozione…',
      cancel: 'Annulla',
      close: 'Chiudi',
      error: 'Impossibile rimuovere questo dispositivo. Riprova.',
    },
    removed: (label) => `${label} rimosso.`,
  },
  pushPrompt: {
    title: 'Attivare le notifiche push?',
    body: 'Ricevi una notifica di sistema su questo computer quando Operai non è aperto. Subito dopo il browser ti chiederà il permesso. Puoi cambiare idea in qualsiasi momento dal tuo profilo.',
    confirm: 'Attiva',
    busy: 'In attesa del browser…',
    cancel: 'No, grazie',
    close: 'Chiudi',
  },
}

/** Exported for the parity test only; components read `strings`. */
export const catalogs = { en, it }

export const strings = selectStrings({ en, it })
