/**
 * Severity + origin-app lookups for the notification center (T15,
 * specs/005-notification-center/tasks.md, design.md "Screens & states →
 * Notification center page" / "Component inventory").
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

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'

export interface SeverityMeta {
  /** aria-hidden glyph rendered next to the title. */
  icon: string
  /** Human-readable label — read by assistive tech as "Severity: <label>". */
  label: string
  /** CSS custom property token for the accent color (design.md's severity table). */
  token: string
}

export const SEVERITY_META: Record<NotificationSeverity, SeverityMeta> = {
  info: { icon: 'ⓘ', label: 'Info', token: 'var(--acc)' },
  success: { icon: '✓', label: 'Success', token: 'var(--grn)' },
  warning: { icon: '⚠', label: 'Warning', token: 'var(--org)' },
  error: { icon: '✕', label: 'Error', token: 'var(--red)' },
}

export type NotificationOriginApp = 'estimai' | 'refund' | 'admin'

export const ORIGIN_APP_LABELS: Record<NotificationOriginApp, string> = {
  estimai: 'EstimAI',
  refund: 'Refund',
  admin: 'Admin',
}

/** Falls back to the raw id for a not-yet-known origin app rather than throwing (forward-compat: a new tool id shipped before this lookup is updated should still render, not crash the center). */
export function originAppLabel(originApp: string): string {
  return (ORIGIN_APP_LABELS as Record<string, string>)[originApp] ?? originApp
}
