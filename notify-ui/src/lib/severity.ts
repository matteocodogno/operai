/**
 * Severity + origin-app lookups for the notification center (T15,
 * specs/005-notification-center/tasks.md, design.md "Screens & states →
 * Notification center page" / "Component inventory").
 *
 * Labels come from the strings module (INC-24) and the icons are library
 * `Icon` names, not Unicode glyphs (INC-31).
 *
 * `SEVERITY_META` maps notify-api's severity enum (notifications.schemas.ts
 * `SeveritySchema`, shell/src/lib/notifications.ts `NotificationSeverity`) to
 * an aria-hidden glyph + an accessible label + a design-token accent color —
 * AC-2.2 requires severity to be "visually distinct" and design.md's
 * Accessibility section requires it never be color-alone (icon + sr-only
 * label always accompany the color). A fresh, small NEW module (design.md
 * Component inventory: "Severity icon/color mapping ... NEW"), built from
 * the same design tokens (`--acc`/`--grn`/`--org`/`--red`) `shell/tokens.css`
 * already defines — same *pattern* as estimai-ui's `healthWarnings.ts`
 * `WARNING_META` (code → icon/colorClass/copy lookup), not importable here
 * (different domain, different remote, ADR-0006).
 *
 * `ORIGIN_APP_LABELS` maps notify-api's `originApp` enum (notify-api's
 * `ORIGIN_APPS`) to the suite's human-facing tool names (AC-2.2/2.3 "origin
 * app") — mirrors `shell/src/lib/tools.ts`'s `TOOLS[].label` values (not
 * importable across the Module Federation boundary either), kept small and
 * in sync by hand since there is no shared package between notify-ui and the
 * shell.
 */

import { resolveLocale, type IconName } from '@operai/ui'
import { strings } from '../strings'

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'

export interface SeverityMeta {
  /** aria-hidden library icon rendered next to the title. */
  icon: IconName
  /** Human-readable label — read by assistive tech as "Severity: <label>". */
  label: string
  /** Token utility for the icon's accent colour (design.md's severity table; ADR-0051). */
  iconClassName: string
}

export const SEVERITY_META: Record<NotificationSeverity, SeverityMeta> = {
  info: { icon: 'info', label: strings.severities.info, iconClassName: 'text-acc' },
  success: { icon: 'check-circle', label: strings.severities.success, iconClassName: 'text-grn' },
  warning: { icon: 'alert', label: strings.severities.warning, iconClassName: 'text-org' },
  error: { icon: 'x-circle', label: strings.severities.error, iconClassName: 'text-red' },
}

export type NotificationOriginApp = 'estimai' | 'refund' | 'admin' | 'inventory' | 'crm' | 'meetings'

export const ORIGIN_APP_LABELS: Record<NotificationOriginApp, string> = strings.originApps

/** Falls back to the raw id for a not-yet-known origin app rather than throwing (forward-compat: a new tool id shipped before this lookup is updated should still render, not crash the center). */
export function originAppLabel(originApp: string): string {
  return (ORIGIN_APP_LABELS as Record<string, string>)[originApp] ?? originApp
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * The title and body in the reader's language (ADR-0065, AC-12.5): the Italian variant when
 * `<html lang>` is `it` and the notification carries a complete one, the default text otherwise.
 * A missing or half-empty variant degrades to the default, never to a blank row or a mixed pair.
 * Read at render time, so it follows the current `<html lang>`. Lives here, not in
 * `notificationsApi`, because that module is the one the page tests replace wholesale.
 */
export function localizedText(notification: {
  title: string
  body: string
  it?: { title: string; body: string } | null
}): { title: string; body: string } {
  const italian = notification.it
  if (resolveLocale() === 'it' && italian && isText(italian.title) && isText(italian.body)) {
    return { title: italian.title, body: italian.body }
  }
  return { title: notification.title, body: notification.body }
}
