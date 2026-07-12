/**
 * SystemBadge — marks a seed/system role as not deletable (T15,
 * specs/004-auth-roles-permissions, design.md Screen A1: "System roles show
 * a lock glyph + 'System' badge").
 *
 * NEW, small component, but follows the existing glyph-or-icon-plus-text
 * badge convention already established in-repo by
 * `estimai-ui/src/components/ImportOfferModal.tsx`'s `StatusBadge` and
 * `WarningBadge` — colour is never the only signal (design.md
 * "Accessibility — contrast": "System/condition badges use --org (amber)
 * … exactly as WarningBadge/StatusBadge already do").
 *
 * Used on Screen A1 (Roles list) next to `employee`/`admin`/`accounting`/`hr`
 * and on Screen A2's header for the same roles — always paired with a
 * disabled Delete button carrying the same explanatory `title` (design.md:
 * "disabled Delete button with title='System roles can't be deleted'").
 */

export default function SystemBadge() {
  return (
    <span
      data-testid="system-badge"
      title="System roles can't be deleted"
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color: 'var(--org)', backgroundColor: 'color-mix(in srgb, var(--org) 10%, transparent)' }}
    >
      <span aria-hidden="true">🔒</span>
      <span>System</span>
    </span>
  )
}
