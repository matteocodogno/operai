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
    notify: 'Notify',
    notifications: 'Notifications',
    myDevices: 'My devices',
    myMeetings: 'My meetings',
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
  /** The confirmation shown when a remote has registered a navigation blocker (specs/021-meetings, AC-2.10). */
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
}

const it: typeof en = {
  tools: {
    estimai: 'EstimAI',
    refund: 'Rimborsi',
    admin: 'Amministrazione',
    inventory: 'Inventario',
    crm: 'CRM',
    meetings: 'Riunioni',
    notify: 'Notifiche',
    notifications: 'Notifiche',
    myDevices: 'I miei dispositivi',
    myMeetings: 'Le mie riunioni',
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
}

/** Exported for the parity test only; components read `strings`. */
export const catalogs = { en, it }

export const strings = selectStrings({ en, it })
