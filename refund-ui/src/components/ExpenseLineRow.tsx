/**
 * ExpenseLineRow — one expense line, in one of four modes (T16/T18,
 * specs/20260716-refund-service/tasks.md; **post-close UX amendment, specs/20260716-refund-service,
 * 2026-07-17** — see `specs/20260716-refund-service/design.md`'s dated amendment
 * note for the full rationale):
 *
 *   - `edit` (Screen R2 `draft` variant): a committed line renders as a
 *     **compact read-only summary row** by default (date, type, motivo,
 *     `formatMoney` amount, `EntityBadge`/`CurrencyBadge`, a small "N files"
 *     attachment indicator when the line has attachments) with native
 *     "Edit" and "Delete" buttons — NOT an always-open field form. Clicking
 *     "Edit" expands the row inline into the full editable field layout
 *     (Date/Type/Motivo/Amount/Entity/Currency, the type-driven `km` field,
 *     and the full `AttachmentList` in upload/remove mode) exactly as this
 *     component always rendered pre-amendment; fields are buffered in local
 *     draft state exactly like `estimai-ui/src/components/
 *     ActivityTable.tsx`'s `EpicCell`/`MLCell` (value diverges from the
 *     committed line until focus leaves the row), then commits as ONE `PUT
 *     /requests/:id/lines/:lineId` carrying the whole line object — not
 *     per-keystroke, not per-field (design.md F1 step 4). Detected via the
 *     row container's own `onBlur` + `e.relatedTarget` (focus landing outside
 *     this row's DOM subtree), not each field's individual blur, so tabbing
 *     between this row's own fields never fires a PUT per field. A **Done**
 *     button collapses the row back to its summary — Done does not introduce
 *     a second save path, it explicitly calls the SAME `commit()` the
 *     blur-outside path uses (a click on a button living inside this row's
 *     own container never satisfies the "focus left the row" blur check), so
 *     an edit made and finished via Done is never silently dropped.
 *     Deleting a committed line now opens a `ConfirmDeleteModal` (overrides
 *     the original no-confirm decision — the user asked for the safety net
 *     post-close) naming the line's type + motivo; a `title` tooltip on the
 *     Edit/Delete buttons remains as a secondary affordance.
 *   - `readOnly` (Screen R2 `submitted`/`rejected` variants, and Screen A2's
 *     own decided-request RO render, T18 F6 step 8): plain text, no inputs,
 *     no delete — editing controls are absent, not disabled (design.md F2
 *     step 3). Shares the same summary presentation `edit` mode's collapsed
 *     row uses (date/type/motivo/badges/amounts), just without Edit/Delete —
 *     these renders were already compact/read-only pre-amendment, this just
 *     makes the visual language explicitly the same one. `AttachmentList`
 *     renders in download-only mode here too — a submitted/decided line's
 *     receipts stay viewable, just not editable (T17: "AttachmentDownloadLink
 *     … used by … the RO employee variants").
 *   - `readOnlyApproved` (Screen R2 `approved` variant, and A2's decided
 *     `approved` render): same as `readOnly` plus the line's finalized
 *     approved total alongside its requested amount (AC-3.2).
 *   - `review` (Screen A2, `submitted`, decidable — T18, design.md F6 step
 *     1-2): same read-only field display as `readOnly` (accounting never
 *     edits date/type/motivo/entity/km — only the employee does, pre-submit)
 *     plus an editable **approved-total input**, visually pre-filled with
 *     `approvedTotalCents ?? requestedAmountCents` (AC-7.1). Write-on-
 *     change-only (design.md F6 step 2): the pre-filled default is never
 *     eagerly `PUT` — a write fires only once the value actually differs
 *     from what was last committed AND the field blurs, mirroring `edit`
 *     mode's own blur-commit convention for the rest of the row. The input
 *     carries a full, row-identity `aria-label` ("Approved total for {date}
 *     · {motivo} · {currency}") per design.md's Accessibility section, since
 *     accounting tabs through many otherwise-identical inputs by role.
 *     **Line rejection (specs/20260716-refund-service amendment, 2026-11-10):** beside the input,
 *     a "Reject line" trigger opens a `ConfirmDialog` that REQUIRES a reason;
 *     a rejected line replaces the input with its reason, who rejected it,
 *     and a "Restore line" action (reversible until the request is decided).
 *   - A rejected line also shows its status badge and reason in
 *     `readOnlyApproved` (the decided record both sides read); its approved
 *     figure is 0, so the amount column already says "nothing paid".
 *
 * `registerRef` lets the parent (`RequestDetailPage`/`ReviewDetailPage`)
 * capture this row's container node so `SubmitValidationSummary`'s jump
 * links can scroll to and focus it (design.md F2 step 1) — the container
 * carries `tabIndex={-1}` for exactly that programmatic-focus target, the
 * same technique `PermissionDenied.tsx`/`NotFoundPage.tsx` use for their own
 * mount-focus. This still works for a collapsed summary row (it focuses the
 * row's own container, the same target it always has); expanding it further
 * is a manual follow-on click, not attempted automatically.
 *
 * A11y (post-close amendment): expanding moves focus to the row's first
 * field (Date); collapsing via Done returns focus to the row's own Edit
 * button — `isFirstRenderRef` skips this focus-management effect on mount so
 * every already-collapsed row doesn't steal focus on initial paint.
 *
 * Debounced auto-save (content-app auto-save, specs/NNN): while `edit` mode
 * is expanded, an in-progress `draft` that's both `isLineDraftComplete` and
 * dirty (differs from `committedRef.current`) auto-commits via the same
 * `commit()` the blur/Done paths already use, `LINE_AUTOSAVE_DEBOUNCE_MS`
 * (1500ms) after the last change — an incomplete/invalid draft never
 * auto-saves, so it can never trigger a spurious 422. The existing
 * blur-outside / Done paths still commit immediately (an "immediate flush"),
 * and `commit()` itself cancels any pending debounce timer at its very start
 * so a flush and a still-pending debounce can never both PUT for the same
 * edit. `onSaveOutcome`, if provided, reports the tone/message of every
 * commit (success or failure) so a page-level toast (`ToastBanner`) can
 * surface it — this row never renders its own toast, to keep "one toast at a
 * time" a property of the page, not each row.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent, ReactNode } from 'react'
import {
  Button,
  ConfirmDialog,
  DateInput,
  Field,
  Icon,
  MoneyInput,
  StatusBadge,
  listRowClassName,
} from '@operai/ui'
import { strings } from '../strings'
import { EXPENSE_TYPES, expenseTypeLabel, requiresKm } from '../lib/expenseTypes'
import type { ExpenseType } from '../lib/expenseTypes'
import type { Entity } from './EntityBadge'
import EntityBadge from './EntityBadge'
import type { Currency } from '../lib/money'
import { describeApprovedAmount, formatMoney, formatRatePerKm } from '../lib/money'
import CurrencyBadge from './CurrencyBadge'
import type { Attachment, LinePayload, RefundLine } from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'
import { formatDate } from '../lib/dates'
import type { LineDraftValue } from '../lib/lineDraft'
import {
  amountToCents,
  centsToAmountInput,
  isLineDraftComplete,
  lineDraftToPayload,
  lineToDraft,
} from '../lib/lineDraft'
import { useLineDraftValidation } from '../lib/useLineDraftValidation'
import AttachmentList from './AttachmentList'
import ConfirmDeleteModal from './ConfirmDeleteModal'
import MileageAmountField from './MileageAmountField'
import { SplitReceiptHint } from './ExpenseLineComposerHint'
import { rowSplitHintId, withSplitHint } from './ExpenseLineComposerHintIds'
import ReceiptNumber from './ReceiptNumber'

export type ExpenseLineRowMode = 'edit' | 'readOnly' | 'readOnlyApproved' | 'review'

/** Debounce delay for a line edit's auto-save (ms) — mirrors estimai-ui's AUTOSAVE_DEBOUNCE_MS. */
const LINE_AUTOSAVE_DEBOUNCE_MS = 1500

export type LineSaveOutcome = { tone: 'success' | 'error'; message: string }

export type ExpenseLineRowProps = {
  line: RefundLine
  mode: ExpenseLineRowMode
  /** Required in `edit` mode — performs `PUT /requests/:id/lines/:lineId`. */
  onCommit?: (payload: LinePayload) => Promise<void>
  /** Required in `edit` mode — performs `DELETE /requests/:id/lines/:lineId`. */
  onDelete?: () => Promise<void>
  /** `edit` mode only — reports every field-edit commit's outcome (debounced auto-save OR blur/Done flush), for a page-level toast. Delete/attachment mutations do not report here. */
  onSaveOutcome?: (outcome: LineSaveOutcome) => void
  /** Lets the parent capture this row's container node for jump-to-on-validation-error focus. */
  registerRef?: (node: HTMLDivElement | null) => void
  /** Required in `edit` mode — the full mint→upload→confirm sequence for one file (`lib/attachmentsApi.ts`). */
  onUploadAttachment?: (file: File) => Promise<Attachment>
  /** Required in `edit` mode — removes a persisted attachment (draft-only, no confirm). */
  onRemoveAttachment?: (attachmentId: string) => Promise<void>
  /** Required in every mode — mints a short-lived signed GET for one attachment (`lib/attachmentsApi.ts`). */
  onDownloadAttachment: (attachmentId: string) => Promise<{ url: string }>
  /** Required in `review` mode — `PUT .../lines/:lineId/approved-total`, fired only on an actual edit (see this file's `review` mode doc above). */
  onApprovedTotalChange?: (cents: number) => Promise<void>
  /** `review` mode — `POST .../lines/:lineId/reject` with the required reason. Without it, no "Reject line" control is offered. */
  onRejectLine?: (reason: string) => Promise<void>
  /** `review` mode — `DELETE .../lines/:lineId/reject`, taking the rejection back. */
  onRestoreLine?: () => Promise<void>
  /**
   * Read-only family only (`readOnly`, `readOnlyApproved`, `review`): content the page puts at the foot of the row,
   * under the attachments. The review page uses it for the line's classification panel
   * (specs/20261118-refund-accounting-export, design component #29); the row knows nothing about what it holds.
   */
  footer?: ReactNode
}

const ENTITY_OPTIONS: Entity[] = ['welld_it', 'welld_ch']
const CURRENCY_OPTIONS: Currency[] = ['EUR', 'CHF', 'USD', 'GBP']

const draftsEqual = (a: LineDraftValue, b: LineDraftValue): boolean =>
  a.date === b.date &&
  a.type === b.type &&
  a.motivo === b.motivo &&
  a.amount === b.amount &&
  a.entity === b.entity &&
  a.currency === b.currency &&
  a.km === b.km

const typeLabel = (type: ExpenseType): string => expenseTypeLabel(type)

export default function ExpenseLineRow({
  line,
  mode,
  onCommit,
  onDelete,
  onSaveOutcome,
  registerRef,
  onUploadAttachment,
  onRemoveAttachment,
  onDownloadAttachment,
  onApprovedTotalChange,
  onRejectLine,
  onRestoreLine,
  footer,
}: ExpenseLineRowProps) {
  const t = strings.pages.requestDetail.lines
  const composerStrings = strings.pages.requestDetail.composer
  const badgeStrings = strings.badges.entity
  const currencyStrings = strings.badges.currency
  const reviewStrings = strings.pages.reviewDetail.approvedTotal
  const rejectStrings = strings.pages.reviewDetail.lineReject

  const [draft, setDraft] = useState<LineDraftValue>(() => lineToDraft(line))
  const committedRef = useRef<LineDraftValue>(lineToDraft(line))
  const containerRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kmStatus, setKmStatus] = useState('')
  const [deleting, setDeleting] = useState(false)
  // INC-16: per-field errors (touched + blurred, or a Done / leave-the-row
  // attempt on an invalid draft), shared with the composer.
  const validation = useLineDraftValidation(draft, containerRef)

  // `edit` mode only — collapsed (summary) vs. expanded (full field form),
  // and the line-delete confirm modal (post-close amendment).
  const [expanded, setExpanded] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const isFirstRenderRef = useRef(true)

  // `edit` mode, expanded, only — the debounced auto-save timer (content-app
  // auto-save). `commit()` itself clears this at its very start, so an
  // immediate flush (blur-outside / Done) always cancels a still-pending
  // debounce before it can also PUT the same edit.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // `review` mode only — the approved-total input's own local draft +
  // "last committed cents" (write-on-change-only comparison base).
  const approvedTotalDefaultCents = line.approvedTotalCents ?? line.requestedAmountCents
  const [approvedDraft, setApprovedDraft] = useState<string>(() => centsToAmountInput(approvedTotalDefaultCents))
  const approvedCommittedRef = useRef<number>(approvedTotalDefaultCents)
  const [approvedSaving, setApprovedSaving] = useState(false)
  const [approvedError, setApprovedError] = useState<string | null>(null)

  // `review` mode only — the line-rejection dialog (reason required) and the
  // restore action (specs/20260716-refund-service amendment, 2026-11-10).
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectReasonError, setRejectReasonError] = useState<string | undefined>(undefined)
  const [rejectReasonTouched, setRejectReasonTouched] = useState(false)
  const rejectReasonRef = useRef<HTMLTextAreaElement>(null)
  const [rejectBusy, setRejectBusy] = useState(false)
  const [rejectError, setRejectError] = useState<string | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  const setContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node
    registerRef?.(node)
  }

  // Focus management on expand/collapse (A11y) — skips the initial mount so
  // every already-collapsed row doesn't steal focus on first paint.
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }
    if (mode !== 'edit') return
    if (expanded) firstFieldRef.current?.focus()
    else editButtonRef.current?.focus()
  }, [expanded, mode])

  const commitApprovedTotal = async () => {
    const cents = amountToCents(approvedDraft)
    if (cents === null) {
      setApprovedError(reviewStrings.invalidAmount)
      return
    }
    setApprovedError(null) // a corrected value clears the error even when it needs no write
    if (cents === approvedCommittedRef.current) return // untouched (or reverted to the default) — no write (design.md F6 step 2)
    setApprovedSaving(true)
    setApprovedError(null)
    try {
      await onApprovedTotalChange?.(cents)
      approvedCommittedRef.current = cents
    } catch (err) {
      setApprovedError(err instanceof ApiError ? (err.detail ?? err.title) : reviewStrings.updateError)
    } finally {
      setApprovedSaving(false)
    }
  }

  const openRejectDialog = () => {
    setRejectReason('')
    setRejectReasonError(undefined)
    setRejectReasonTouched(false)
    setRejectError(null)
    setRejectOpen(true)
  }

  const confirmRejectLine = async () => {
    const reason = rejectReason.trim()
    if (reason.length === 0) {
      // A submit that fails validation moves focus to the invalid field
      // (design-system.md § Forms).
      setRejectReasonError(rejectStrings.reasonRequired)
      rejectReasonRef.current?.focus()
      return
    }
    setRejectBusy(true)
    setRejectError(null)
    try {
      await onRejectLine?.(reason)
      setRejectOpen(false)
    } catch (err) {
      setRejectError(err instanceof ApiError ? (err.detail ?? err.title) : rejectStrings.updateError)
    } finally {
      setRejectBusy(false)
    }
  }

  const restoreLine = async () => {
    setRestoreBusy(true)
    setRestoreError(null)
    try {
      await onRestoreLine?.()
    } catch (err) {
      setRestoreError(err instanceof ApiError ? (err.detail ?? err.title) : rejectStrings.updateError)
    } finally {
      setRestoreBusy(false)
    }
  }

  const commit = useCallback(async () => {
    // An immediate flush (blur-outside / Done) and the debounced auto-save
    // both funnel through this one function — cancel any still-pending
    // debounce timer first so a flush can never be followed by a redundant
    // late PUT for the same edit.
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = undefined
    }
    if (!isLineDraftComplete(draft) || draftsEqual(draft, committedRef.current)) return
    setSaving(true)
    setError(null)
    try {
      await onCommit?.(lineDraftToPayload(draft))
      committedRef.current = draft
      onSaveOutcome?.({ tone: 'success', message: t.savedToast })
    } catch (err) {
      const message = err instanceof ApiError ? (err.detail ?? err.title) : t.updateError
      setError(message)
      onSaveOutcome?.({ tone: 'error', message })
    } finally {
      setSaving(false)
    }
  }, [draft, onCommit, onSaveOutcome, t.savedToast, t.updateError])

  // Debounced auto-save (content-app auto-save): while expanded, a complete
  // AND dirty draft auto-commits LINE_AUTOSAVE_DEBOUNCE_MS after the last
  // change. An incomplete/invalid draft is never scheduled — never a
  // spurious 422. Re-runs (and so re-debounces) on every keystroke because
  // `draft` — and therefore `commit`, which closes over it — changes
  // identity each time.
  useEffect(() => {
    if (mode !== 'edit' || !expanded) return
    if (!isLineDraftComplete(draft) || draftsEqual(draft, committedRef.current)) return
    debounceTimerRef.current = setTimeout(() => void commit(), LINE_AUTOSAVE_DEBOUNCE_MS)
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = undefined
      }
    }
  }, [draft, mode, expanded, commit])

  const handleRowBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return
    // Leaving the row with an edited but invalid draft is a save attempt that
    // cannot go through: show every error (focus stays where the person went).
    if (!draftsEqual(draft, committedRef.current)) validation.validate({ focus: false })
    void commit()
  }

  const handleTypeChange = (value: string) => {
    const nextType = value as ExpenseType
    const wasKm = requiresKm(draft.type as ExpenseType)
    const willBeKm = requiresKm(nextType)
    setDraft((prev) => ({ ...prev, type: nextType, km: willBeKm ? prev.km : '' }))
    if (willBeKm && !wasKm) setKmStatus(composerStrings.kmFieldAdded)
    else if (!willBeKm && wasKm) setKmStatus(composerStrings.kmFieldRemoved)
  }

  const handleEditClick = () => {
    setExpanded(true)
  }

  const handleDoneClick = () => {
    // INC-16: an invalid draft cannot be saved, so Done does not collapse it
    // (that would silently drop the edit): it shows every error and moves
    // focus to the first invalid field instead.
    if (!validation.validate({ focus: true })) return
    // Done never introduces a second save path — it calls the SAME commit()
    // the blur-outside path uses. A click on a button that lives inside this
    // row's own container never satisfies handleRowBlur's "focus left the
    // row" check, so without this an edit finished via Done would silently
    // never be saved.
    void commit()
    setExpanded(false)
  }

  const handleDeleteClick = () => {
    setDeleteError(null)
    setDeleteConfirmOpen(true)
  }

  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false)
    setDeleteError(null)
  }

  const handleDeleteConfirm = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await onDelete?.()
      setDeleteConfirmOpen(false)
    } catch (err) {
      setDeleteError(err instanceof ApiError ? (err.detail ?? err.title) : t.deleteError)
    } finally {
      setDeleting(false)
    }
  }

  // -------------------------------------------------------------------------
  // Shared summary content (date/type/badges/motivo/amounts) — reused by the
  // read-only-family render (`readOnly`/`readOnlyApproved`/`review`) AND
  // `edit` mode's collapsed summary row, so committed lines read as the same
  // presentation everywhere they aren't the live editable form.
  // -------------------------------------------------------------------------

  // specs/20260720-mileage-rate — `line.mileage` is present (non-null) only for a
  // travel_km line; `?? null` also covers pre-feature test fixtures that
  // predate this field entirely (`RefundLine.mileage` is optional exactly
  // for that reason, see requestsApi.ts's own doc comment).
  const mileage = line.mileage ?? null
  // AC-2.2: no rate configured for this line's (entity, date) — only ever
  // true for a still-draft/withdrawn-to-draft line (a submitted+ line always
  // had a rate in effect at submit time, and is then frozen, per Decision 1).
  const mileageBlocked = mileage !== null && !mileage.rateInEffect
  // Computed unconditionally so the collapsed/expanded branches below cannot
  // disagree about whether accounting changed this line. Shares its rule with
  // SubtotalsPanel via lib/money.ts — a per-line row and the totals card
  // showing different answers for the same request would be worse than either
  // being wrong alone.
  const approvedAmount = describeApprovedAmount(line.requestedAmountCents, line.approvedTotalCents, line.currency)
  // A line refused on its own (specs/20260716-refund-service amendment, 2026-11-10). Shown to the
  // reviewer while deciding and on the decided record; a still-submitted
  // request's employee view (`readOnly`) does not show an unfinished review.
  const rejection = line.rejection ?? null
  const showRejection = rejection !== null && (mode === 'review' || mode === 'readOnlyApproved')

  /**
   * AMOUNTS ARE A COLUMN, not a value embedded in a sentence.
   *
   * Everything descriptive stays left and wraps; the money sits in a fixed
   * right-hand column with `tabular-nums`, so an accountant can run their eye
   * straight down a request and check it sums to the total. Previously the
   * figure sat inline after its label, inside a wrapping row shared with the
   * applied-rate pair — so its horizontal position moved with the length of
   * whatever preceded it, and no two rows lined up.
   *
   * `tabular-nums` alongside `font-mono` is belt-and-braces, and deliberately
   * so. DM Mono is a true monospace, so equal digit advance is already
   * guaranteed while it loads and renders — but the stack falls back to
   * `monospace` and, on a system where that resolves to something
   * proportional-ish, the column would quietly stop being a column. The
   * numeric variant makes the alignment a property of the markup rather than
   * of which font happened to load.
   *
   * An adjusted line puts the approved figure in the column and hangs the
   * "requested … · −…" note beneath it, rather than appending a parenthetical
   * that would shove every figure to a different x.
   */
  const amountColumn = (
    <dl className="shrink-0 text-right text-sm">
      <dt className="text-2xs text-soft">{mode === 'readOnlyApproved' ? t.approvedLabel : t.requestedLabel}</dt>
      <dd
        className={`font-mono tabular-nums ${mode === 'readOnlyApproved' ? 'text-grn-text' : 'text-text'}`}
        data-testid={mode === 'readOnlyApproved' ? `row-${line.id}-approved-amount` : `row-${line.id}-requested-amount`}
        data-changed={mode === 'readOnlyApproved' ? (approvedAmount.changed ? 'true' : 'false') : undefined}
      >
        {mileageBlocked
          ? t.mileageBlockedAmount
          : mode === 'readOnlyApproved'
            ? approvedAmount.approved
            : formatMoney(line.requestedAmountCents, line.currency)}
      </dd>
      {mode === 'readOnlyApproved' && approvedAmount.changed && !mileageBlocked && (
        <dd className="font-mono tabular-nums text-2xs text-soft" data-testid={`row-${line.id}-approved-delta`}>
          {t.approvedDeltaNote(approvedAmount.requested, approvedAmount.delta)}
        </dd>
      )}
    </dl>
  )

  const summaryCore = (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-soft">{formatDate(line.date)}</span>
          {/* Never in `edit` mode (design S9); nothing at all for an unnumbered line. */}
          {mode !== 'edit' && <ReceiptNumber value={line.receiptNumber} />}
          <span className="text-text">{typeLabel(line.type)}</span>
          <EntityBadge entity={line.entity} />
          <CurrencyBadge currency={line.currency} />
          {showRejection && (
            <StatusBadge status="failed" data-testid={`row-${line.id}-rejected-badge`}>
              {t.rejectedBadge}
            </StatusBadge>
          )}
          {line.km !== null && (
            <span className="text-soft">
              {mileage?.appliedRate
                ? t.kmWithRate(line.km, formatRatePerKm(mileage.appliedRate.ratePerKm, mileage.appliedRate.currency))
                : t.kmValue(line.km)}
            </span>
          )}
        </div>
        <p className="text-sm text-text">{line.motivo}</p>
        {showRejection && rejection && (
          <dl className="flex flex-col gap-0.5 text-sm" data-testid={`row-${line.id}-rejection`}>
            <dt className="text-xs font-medium text-red-text">{t.rejectionReasonLabel}</dt>
            <dd className="text-text" data-testid={`row-${line.id}-rejection-reason`}>
              {rejection.reason}
            </dd>
          </dl>
        )}
        {/* specs/20260720-mileage-rate AC-6.4 — the applied rate + valid-from.
            `appliedRate` is non-null only once a travel_km line has ever been
            submitted under this feature (Decision 1); a legacy pre-feature
            submitted line omits this pair entirely (graceful degradation —
            amount only, no breakdown). Stays on the DESCRIPTIVE side: it is
            provenance for how the amount was reached, not a figure anyone
            sums, so it must not sit in the money column. */}
        {mileage?.appliedRate && (
          <dl className="flex flex-wrap items-center gap-1.5 text-sm">
            <dt className="text-soft">{t.rateAppliedLabel}</dt>
            <dd className="font-mono text-text">
              {t.rateAppliedValue(
                formatRatePerKm(mileage.appliedRate.ratePerKm, mileage.appliedRate.currency),
                formatDate(mileage.appliedRate.validFrom),
              )}
            </dd>
          </dl>
        )}
      </div>

      {amountColumn}
    </div>
  )

  // -------------------------------------------------------------------------
  // `edit` mode, collapsed — compact read-only summary row + Edit/Delete
  // -------------------------------------------------------------------------

  if (mode === 'edit' && !expanded) {
    return (
      <div
        ref={setContainerRef}
        tabIndex={-1}
        data-testid={`expense-line-row-${line.id}`}
        className={`${listRowClassName} flex-col items-stretch gap-2 outline-none`}
      >
        {summaryCore}

        <div className="flex items-center justify-between gap-3 pt-1 border-t border-rule">
          {line.attachments.length > 0 ? (
            <span
              data-testid={`row-${line.id}-attachments-indicator`}
              className="inline-flex items-center gap-1 text-2xs text-soft"
            >
              <Icon name="paperclip" /> {t.attachmentsIndicator(line.attachments.length)}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              ref={editButtonRef}
              variant="secondary"
              size="sm"
              onClick={handleEditClick}
              aria-label={t.editLineLabel(line.motivo)}
              title={t.editLineTitle}
              data-testid={`row-${line.id}-edit`}
            >
              {t.editButton}
            </Button>
            {/* The trigger, not the act: the confirm dialog carries the danger button. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDeleteClick}
              aria-label={t.deleteLineLabel(line.motivo)}
              title={t.deleteLineTitle}
              data-testid={`row-${line.id}-delete`}
            >
              {t.deleteButton}
            </Button>
          </div>
        </div>

        {deleteConfirmOpen && (
          <ConfirmDeleteModal
            entityLabel={t.deleteLineConfirmEntityLabel}
            itemName={line.motivo}
            title={t.deleteLineConfirmTitle}
            body={<p>{t.deleteLineConfirmBody(typeLabel(line.type), line.motivo)}</p>}
            isDeleting={deleting}
            errorMessage={deleteError}
            onConfirm={() => void handleDeleteConfirm()}
            onCancel={handleDeleteCancel}
            testIdPrefix={`row-${line.id}-delete-confirm`}
          />
        )}
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Read-only render (submitted / approved / rejected / accounting review)
  // -------------------------------------------------------------------------

  if (mode === 'readOnly' || mode === 'readOnlyApproved' || mode === 'review') {
    return (
      <div
        ref={setContainerRef}
        tabIndex={-1}
        data-testid={`expense-line-row-${line.id}`}
        className={`${listRowClassName} flex-col items-stretch gap-2 outline-none`}
      >
        {summaryCore}

        {mode === 'review' && rejection !== null && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-2xs text-soft" data-testid={`row-${line.id}-rejected-by`}>
              {rejectStrings.rejectedBy(rejection.rejectedBy.email)}
            </span>
            <div className="flex items-center gap-2">
              {restoreError && (
                <span role="alert" className="text-xs text-red-text" data-testid={`row-${line.id}-restore-error`}>
                  {restoreError}
                </span>
              )}
              {onRestoreLine && (
                <Button
                  variant="secondary"
                  size="sm"
                  busy={restoreBusy}
                  onClick={() => void restoreLine()}
                  aria-label={rejectStrings.restoreButtonLabel(line.motivo)}
                  data-testid={`row-${line.id}-restore`}
                >
                  {rejectStrings.restoreButton}
                </Button>
              )}
            </div>
          </div>
        )}

        {mode === 'review' && rejection === null && (
          <div className="flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="text-xs font-medium text-soft">
              {reviewStrings.label}
            </span>
            {/* A bare control in a dense row: the compact base size, no skin of its own (INC-17). */}
            <MoneyInput
              aria-label={reviewStrings.ariaLabel(formatDate(line.date), line.motivo, line.currency)}
              aria-invalid={approvedError ? true : undefined}
              aria-describedby={approvedError ? `row-${line.id}-approved-total-error` : undefined}
              value={approvedDraft}
              disabled={approvedSaving}
              onChange={(e) => setApprovedDraft(e.target.value)}
              onBlur={() => void commitApprovedTotal()}
              data-testid={`row-${line.id}-approved-total`}
              className="w-28"
            />
            {approvedSaving && <span className="text-2xs text-soft">{reviewStrings.savingLabel}</span>}
            {approvedError && (
              <span
                id={`row-${line.id}-approved-total-error`}
                role="alert"
                data-testid={`row-${line.id}-approved-total-error`}
                className="text-xs text-red-text"
              >
                {approvedError}
              </span>
            )}
            {onRejectLine && (
              /* Chosen by meaning (design-system.md § Buttons): refusing money is
                 a rejection, the same `danger` as the request-level Reject. */
              <Button
                variant="danger"
                size="sm"
                className="ml-auto"
                aria-haspopup="dialog"
                onClick={openRejectDialog}
                aria-label={rejectStrings.rejectButtonLabel(line.motivo)}
                data-testid={`row-${line.id}-reject`}
              >
                {rejectStrings.rejectButton}
              </Button>
            )}
          </div>
        )}

        {rejectOpen && (
          <ConfirmDialog
            title={rejectStrings.dialogTitle}
            confirmLabel={rejectStrings.confirmLabel}
            busyLabel={rejectStrings.busyLabel}
            cancelLabel={rejectStrings.cancelLabel}
            closeLabel={rejectStrings.closeLabel}
            busy={rejectBusy}
            error={rejectError}
            onConfirm={() => void confirmRejectLine()}
            onCancel={() => setRejectOpen(false)}
            testIdPrefix={`row-${line.id}-reject-dialog`}
            fields={
              <Field
                label={rejectStrings.reasonLabel}
                hint={rejectStrings.reasonHelp}
                error={rejectReasonError}
                required
              >
                {(control) => (
                  <textarea
                    {...control}
                    ref={rejectReasonRef}
                    rows={3}
                    maxLength={2000}
                    value={rejectReason}
                    onChange={(e) => {
                      setRejectReason(e.target.value)
                      setRejectReasonTouched(true)
                      if (rejectReasonError) setRejectReasonError(undefined)
                    }}
                    onBlur={() => {
                      // Validate on blur of a TOUCHED field only — leaving an
                      // untouched empty field is not yet an error.
                      if (rejectReasonTouched && rejectReason.trim().length === 0) {
                        setRejectReasonError(rejectStrings.reasonRequired)
                      }
                    }}
                    data-testid={`row-${line.id}-reject-reason`}
                  />
                )}
              </Field>
            }
          >
            <p>
              {rejectStrings.dialogBody(
                typeLabel(line.type),
                line.motivo,
                formatMoney(line.requestedAmountCents, line.currency),
              )}
            </p>
          </ConfirmDialog>
        )}

        <AttachmentList
          lineId={line.id}
          attachments={line.attachments}
          mode="readOnly"
          onDownload={onDownloadAttachment}
        />

        {footer}
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // `edit` mode, expanded — the full editable field layout
  // -------------------------------------------------------------------------

  const showKm = draft.type !== '' && requiresKm(draft.type as ExpenseType)
  // SG-2 / SG-1 (specs/20261118-refund-accounting-export design "Sign-off round sync"): the split-receipt hint
  // follows the composer's rules — WellD CH with an Amount, never mileage; one sentence after the Entity, in an
  // always-mounted polite live region, describing both the Entity select and the Amount input.
  const splitHintId = rowSplitHintId(line.id)
  const showSplitHint = draft.entity === 'welld_ch' && !showKm

  return (
    <div
      ref={setContainerRef}
      tabIndex={-1}
      onBlur={handleRowBlur}
      data-testid={`expense-line-row-${line.id}`}
      className={`${listRowClassName} flex-col items-stretch gap-3 outline-none`}
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Field label={composerStrings.dateLabel} error={validation.errorFor('date')} required>
          {(control) => (
            <DateInput
              {...control}
              ref={firstFieldRef}
              value={draft.date}
              onChange={(e) => setDraft((prev) => ({ ...prev, date: e.target.value }))}
              onBlur={validation.touch('date')}
              data-testid={`row-${line.id}-date`}
            />
          )}
        </Field>

        <Field label={composerStrings.typeLabel} error={validation.errorFor('type')} required>
          {(control) => (
            <select
              {...control}
              value={draft.type}
              onChange={(e) => handleTypeChange(e.target.value)}
              onBlur={validation.touch('type')}
              data-testid={`row-${line.id}-type`}
            >
              {EXPENSE_TYPES.map((option) => (
                <option key={option.id} value={option.id}>
                  {expenseTypeLabel(option.id)}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label={composerStrings.motivoLabel} error={validation.errorFor('motivo')} required>
          {(control) => (
            <input
              {...control}
              type="text"
              value={draft.motivo}
              onChange={(e) => setDraft((prev) => ({ ...prev, motivo: e.target.value }))}
              onBlur={validation.touch('motivo')}
              data-testid={`row-${line.id}-motivo`}
            />
          )}
        </Field>

        {/* specs/20260720-mileage-rate AC-1.1: for travel_km, Amount is replaced by the
            read-only computed breakdown (MileageAmountField) — not merely disabled. */}
        {showKm ? (
          <div className="flex flex-col gap-1">
            <MileageAmountField entity={draft.entity} date={draft.date} km={draft.km} />
          </div>
        ) : (
          <Field label={composerStrings.amountLabel} error={validation.errorFor('amount')} required>
            {(control) => (
              <MoneyInput
                {...withSplitHint(control, splitHintId, showSplitHint)}
                value={draft.amount}
                onChange={(e) => setDraft((prev) => ({ ...prev, amount: e.target.value }))}
                onBlur={validation.touch('amount')}
                data-testid={`row-${line.id}-amount`}
              />
            )}
          </Field>
        )}

        <Field label={composerStrings.entityLabel} error={validation.errorFor('entity')} required>
          {(control) => (
            <select
              {...withSplitHint(control, splitHintId, showSplitHint)}
              value={draft.entity}
              onChange={(e) => setDraft((prev) => ({ ...prev, entity: e.target.value as Entity }))}
              onBlur={validation.touch('entity')}
              data-testid={`row-${line.id}-entity`}
            >
              {ENTITY_OPTIONS.map((entity) => (
                <option key={entity} value={entity}>
                  {badgeStrings[entity]}
                </option>
              ))}
            </select>
          )}
        </Field>

        {/* specs/20260720-mileage-rate AC-1.6: for travel_km, currency is entity-designated,
            never independently selectable — the select is absent, not disabled. */}
        {!showKm && (
          <Field label={composerStrings.currencyLabel} error={validation.errorFor('currency')} required>
            {(control) => (
              <select
                {...control}
                value={draft.currency}
                onChange={(e) => setDraft((prev) => ({ ...prev, currency: e.target.value as Currency }))}
                onBlur={validation.touch('currency')}
                data-testid={`row-${line.id}-currency`}
              >
                {CURRENCY_OPTIONS.map((currency) => (
                  <option key={currency} value={currency}>
                    {currencyStrings[currency]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        {/* A distance is a quantity, not money: it stays `type="number"` (INC-17). */}
        {showKm && (
          <Field
            label={composerStrings.kmLabel}
            hint={composerStrings.kmHelp}
            error={validation.errorFor('km')}
            required
          >
            {(control) => (
              <input
                {...control}
                type="number"
                min="1"
                step="1"
                className="input-figure"
                value={draft.km}
                onChange={(e) => setDraft((prev) => ({ ...prev, km: e.target.value }))}
                onBlur={validation.touch('km')}
                data-testid={`row-${line.id}-km`}
              />
            )}
          </Field>
        )}
      </div>

      <SplitReceiptHint id={splitHintId} shown={showSplitHint} text={composerStrings.splitReceiptHint} />

      <p aria-live="polite" className="sr-only" data-testid={`row-${line.id}-km-status`}>
        {kmStatus}
      </p>

      {saving && <p className="text-2xs text-soft">{t.savingLabel}</p>}
      {error && (
        <p role="alert" data-testid={`row-${line.id}-error`} className="form-error">
          {error}
        </p>
      )}

      <div className="flex items-start justify-between gap-3 pt-1 border-t border-rule">
        <AttachmentList
          lineId={line.id}
          attachments={line.attachments}
          mode="edit"
          onUpload={onUploadAttachment}
          onRemove={onRemoveAttachment}
          onDownload={onDownloadAttachment}
        />
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={handleDoneClick}
          aria-label={t.doneLabel(draft.motivo || line.motivo)}
          title={t.doneTitle}
          data-testid={`row-${line.id}-done`}
        >
          {t.doneButton}
        </Button>
      </div>
    </div>
  )
}
