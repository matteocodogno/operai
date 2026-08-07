/**
 * ConflictBanner — US-4's non-dismissable recovery surface for a 409/428
 * save conflict (T18, specs/013-estimate-sharing/tasks.md; design.md S4).
 *
 * A **new** component, not an extension of `ToastBanner.tsx` — that
 * component's contract (message + at most one optional dismiss) cannot
 * express two action buttons or "never dismissable, never auto-dismisses"
 * without breaking its two existing call sites (the save error/success
 * toasts). This banner replaces that toast zone entirely while a conflict is
 * active (`EstimatorApp.tsx` renders it instead of, never alongside,
 * `ToastBanner` — `EstimatorContext.tsx`'s autosave effect already clears
 * `saveError`/`showSavedToast` the moment it enters `conflict`).
 *
 * Copy (design.md S4, `strings.conflict.*`):
 *   - 409, attributable   — "{Name} saved changes to this estimate since you
 *     opened it." + a reassurance line ("nothing has been overwritten").
 *   - 409, unattributable — `lastModifiedBy` is absent, or its identity
 *     resolution failed (`status: "unknown"`, best-effort per plan.md) —
 *     the generic "Someone else saved changes…" + the same reassurance line.
 *   - 428 (no prior version to compare against) — a different framing since
 *     there is no "who": "This tab needs to reload…". No reassurance line —
 *     design.md lists it only for the 409 shapes.
 *
 * Accessibility (design.md "## Accessibility" → ConflictBanner):
 *   - `role="alert"` (assertive — an unsaved-work risk must interrupt,
 *     unlike the existing success toast's `role="status"`).
 *   - **Never** a dismiss "×" — the component's core behavioral difference
 *     from `ToastBanner`; must not be "fixed" by adding one later.
 *   - Does NOT steal focus on appear (no focus-management effect at all,
 *     deliberately) — the user may be mid-keystroke in a cell, and forcibly
 *     moving focus would itself risk losing an in-progress edit.
 *   - "Reload latest" is the visually primary button (solid/accented);
 *     "Save as a copy instead" is secondary (ghost/outlined) — keyboard/AT
 *     users encounter the safer, non-destructive default first in DOM/tab
 *     order, both real `<button>`s reachable by Tab from wherever focus
 *     currently sits in the editor.
 */

import { strings } from '../strings'
import { formatIdentity } from '../lib/identity'
import type { ConflictInfo } from '../context/EstimatorContext'

export type ConflictBannerProps = {
  conflict: ConflictInfo
  /** "Reload latest" — a route invalidate → remount (T18, plan.md). */
  onReloadLatest: () => void
  /** "Save as a copy instead" — a POST /estimates of the local content. */
  onSaveAsCopy: () => void
}

export default function ConflictBanner({ conflict, onReloadLatest, onSaveAsCopy }: ConflictBannerProps) {
  const isStaleClient = conflict.status === 428
  const lastModifiedBy = conflict.lastModifiedBy

  // "Attributable" means a usable resolved identity is available — design.md
  // draws the line at `lastModifiedBy` identity resolution having failed
  // (`status: "unknown"`, plan.md's best-effort contract), not merely at
  // `lastModifiedBy` being present/absent (428 never carries one at all).
  const isAttributable = lastModifiedBy !== undefined && lastModifiedBy.status !== 'unknown'

  const title = isStaleClient
    ? strings.conflict.title428
    : isAttributable && lastModifiedBy
      ? strings.conflict.title409(formatIdentity(lastModifiedBy))
      : strings.conflict.title409Unknown

  return (
    <div
      role="alert"
      data-testid="conflict-banner"
      className="flex items-center justify-between gap-4 flex-wrap px-5.5 py-2.5 border-l-2 border-org bg-org/10 text-sm text-text"
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <p className="font-medium">{title}</p>
        {!isStaleClient && <p className="text-muted text-[12px]">{strings.conflict.reassurance}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onReloadLatest}
          className="py-1.5 px-3 text-[12px] font-medium bg-acc text-white hover:bg-acc/90 transition-colors"
        >
          {strings.conflict.reloadButton}
        </button>
        <button
          type="button"
          onClick={onSaveAsCopy}
          className="py-1.5 px-3 text-[12px] font-medium border border-rule text-muted hover:text-text hover:border-text/40 transition-colors"
        >
          {strings.conflict.saveAsCopyButton}
        </button>
      </div>
    </div>
  )
}
