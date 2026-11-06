/**
 * notify-ui's copy (INC-24, INC-25): every string the notification center
 * shows. Components never inline copy; lib/noHardcodedStrings.test.ts scans
 * every .tsx under src/ and strings.test.ts keeps the Italian complete.
 *
 * One catalog per language, the Italian typed as the English; the language is
 * resolved once for the whole suite by the library (`selectStrings` →
 * `resolveLocale`), from the `<html lang>` the shell sets at startup. Product
 * names stay as they are (EstimAI); the refund tool is "Rimborsi" in Italian.
 */
import { selectStrings } from '@operai/ui'
import type { NotificationOriginApp, NotificationSeverity } from './lib/severity'

const en = {
  toolTitle: 'Notifications',
  center: {
    title: 'Inbox',
    markAllRead: 'Mark all as read',
    listLabel: 'Notifications',
    loading: 'Loading your notifications',
    loaded: (count: number) => (count === 1 ? '1 notification loaded' : `${count} notifications loaded`),
    loadFailed: 'Could not load your notifications',
    loadFailedDetail: 'Could not load your notifications.',
    retry: 'Retry',
    emptyTitle: 'Nothing here yet',
    emptyBody: 'You’ll see notifications from EstimAI, Refund, and the rest of the suite here as they happen.',
  },
  item: {
    newPrefix: 'New:',
    newTag: 'New',
    severity: (label: string) => `Severity: ${label}`,
  },
  severities: {
    info: 'Info',
    success: 'Success',
    warning: 'Warning',
    error: 'Error',
  } satisfies Record<NotificationSeverity, string>,
  originApps: {
    estimai: 'EstimAI',
    refund: 'Refund',
    admin: 'Admin',
    inventory: 'Inventory',
    crm: 'CRM',
    projects: 'Projects',
  } satisfies Record<NotificationOriginApp, string>,
  notFound: {
    title: 'Page not found',
    body: 'This notification page doesn’t exist.',
  },
}

const it: typeof en = {
  toolTitle: 'Notifiche',
  center: {
    title: 'Posta in arrivo',
    markAllRead: 'Segna tutte come lette',
    listLabel: 'Notifiche',
    loading: 'Caricamento delle notifiche',
    loaded: (count: number) => (count === 1 ? '1 notifica caricata' : `${count} notifiche caricate`),
    loadFailed: 'Impossibile caricare le notifiche',
    loadFailedDetail: 'Impossibile caricare le notifiche.',
    retry: 'Riprova',
    emptyTitle: 'Ancora nessuna notifica',
    emptyBody:
      'Qui compariranno, man mano che arrivano, le notifiche di EstimAI, Rimborsi e degli altri strumenti della suite.',
  },
  item: {
    newPrefix: 'Nuova:',
    newTag: 'Nuova',
    severity: (label: string) => `Gravità: ${label}`,
  },
  severities: {
    info: 'Informazione',
    success: 'Operazione riuscita',
    warning: 'Avviso',
    error: 'Errore',
  },
  originApps: {
    estimai: 'EstimAI',
    refund: 'Rimborsi',
    admin: 'Amministrazione',
    inventory: 'Inventario',
    crm: 'CRM',
    projects: 'Progetti',
  },
  notFound: {
    title: 'Pagina non trovata',
    body: 'Questa pagina delle notifiche non esiste.',
  },
}

/** Exported for the parity test only; components read `strings`. */
export const catalogs = { en, it }

export const strings = selectStrings({ en, it })
