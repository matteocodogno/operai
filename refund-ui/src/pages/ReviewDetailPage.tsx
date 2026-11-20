import { useCallback, useEffect, useRef, useState } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { useSession, usePermissions } from 'shell/session'
import type { Permission } from 'shell/session'
import { Banner, Button, Card, ErrorSummary, Icon, PageHeader, Skeleton, VisuallyHidden, useFocusOnMount } from '@operai/ui'
import { ownerDisplay, strings } from '../strings'
import * as requestsApi from '../lib/requestsApi'
import type { RefundLine, RefundRequestDetail } from '../lib/requestsApi'
import * as reviewApi from '../lib/reviewApi'
import * as attachmentsApi from '../lib/attachmentsApi'
import * as accountingApi from '../lib/accountingApi'
import type {
  AccountingLine,
  ClassificationMissingLine,
  ClassifyBody,
  RequestAccounting,
} from '../lib/accountingApi'
import { useLoadedResource } from '../lib/useLoadedResource'
import { ApiError } from '../lib/refundApi'
import { formatDate, formatDateTime } from '../lib/dates'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import GuardrailDialog from '../components/GuardrailDialog'
import ApproveDialog from '../components/ApproveDialog'
import RejectDialog from '../components/RejectDialog'
import ExpenseLineRow from '../components/ExpenseLineRow'
import LinesCard from '../components/LinesCard'
import LineClassificationPanel from '../components/LineClassificationPanel'
import SubtotalsPanel from '../components/SubtotalsPanel'
import RequestStatusBadge from '../components/RequestStatusBadge'
import RequestExportLink from '../components/RequestExportLink'
import MonthlyProcessingNote from '../components/MonthlyProcessingNote'

const route = getRouteApi('/review/$id')

/**
 * ReviewDetailPage — Screen A2 ("Review detail & decide",
 * `/refund/review/$id` — T18, specs/20260716-refund-service/tasks.md,
 * design.md "Screen A2"/F6). Replaces T14's placeholder. `GET /requests/:id`
 * is the SAME route the employee side uses (`requestsApi.get`) — plan.md's
 * contract table gives it accounting-specific semantics (whole-request, all
 * lines, entity-scope-gated 404), not a separate accounting endpoint.
 *
 *   - `submitted` (decidable): full RO line list in `review` mode (read-only
 *     fields + download-only attachments + an editable approved-total
 *     input per line, AC-6.1/6.5/7.1), `SubtotalsPanel` (requested-only —
 *     no approved figures exist yet), Approve/Reject actions.
 *   - `approved`/`rejected` (decided, AC-6.3): renders the EXACT SAME
 *     read-only variant `RequestDetailPage` already built for the employee's
 *     own approved/rejected detail (design.md F6 step 8: "accounting's
 *     'inspect a past decision' need is met by the SAME read-only render
 *     path"), plus the "Requested by" identity line every A2 render shows.
 *   - `paid` (T13, specs/20260719-refund-monthly-processing/tasks.md, design.md
 *     F4 step 4): structured IDENTICALLY to `approved` (full
 *     `readOnlyApproved` line list, `SubtotalsPanel showApproved`) PLUS a
 *     "Paid on `<date>` by `<email>`" line, MINUS `MonthlyProcessingNote` —
 *     this REPLACES the generic `readOnly` fallback branch that previously
 *     (silently, incidentally) already covered `paid` before this feature
 *     existed, without a `paidAt`/`paidBy` line (design.md Gap #7).
 *   - L    — SkeletonListRows while `GET /requests/:id` is in flight.
 *   - Err  — ErrorBanner + Retry.
 *   - NF   — neutral "doesn't exist or you don't have access" on a 404
 *            (out-of-scope deep link, AC-6.4, or a genuinely nonexistent
 *            id) — never "permission denied" (would leak existence).
 *   - G    — a 409 on approved-total/approve/reject surfaces
 *            GuardrailDialog; acknowledging has already reloaded the
 *            record underneath.
 *
 * Mutations never merge partial responses into local state — every
 * successful approved-total edit re-fetches the full record via
 * `GET /requests/:id` (`reloadRequest`), mirroring `RequestDetailPage`'s own
 * convention (plan.md R7: money/subtotal math is never re-derived
 * client-side).
 *
 * Approve/Reject success navigates back to Screen A1 with a one-shot
 * `confirmation` search param (design.md F6 steps 4-5: "returned to Screen
 * A1 … with an aria-live confirmation") — see router.tsx's `validateSearch`
 * on the `/review` route and ReviewQueuePage's own read-and-strip of it.
 *
 * Self-approval control (specs/20260721-self-approval-control, plan.md D5,
 * ADR 20260721-self-approval-condition-and-403-exception): the Approve button is PASSIVELY disabled (`aria-disabled` +
 * `title`, never hidden — the suite's house pattern, mirrors admin-ui's
 * UserDetail.tsx "You can't delete your own account") when the caller owns
 * this request (their `sub`, from `shell/session`'s `useSession()`, matches
 * `request.owner.userId`) AND their resolved `request:approve` grant
 * (`shell/session`'s `usePermissions()`) carries the
 * `{key:"self-approval",match:"deny"}` attribute. This is convenience
 * only — refund-api's 403 is the actual, authoritative control; a stale
 * client computation can never let a denied approve through, only
 * (worst case) show an enabled button the server still rejects, which
 * `errorMessageFor`'s `self_approval_forbidden` mapping below handles.
 *
 * Line rejection (specs/20260716-refund-service amendment, 2026-11-10): each line in `review`
 * mode can be rejected on its own, with a required reason, and restored
 * until the request is decided. When EVERY line is rejected, Approve is
 * passively disabled the same way (refund-api answers 409
 * `all_lines_rejected`): such a request must be rejected as a whole.
 */

type PageState =
  | { status: 'loading' }
  | { status: 'notFound' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; request: RefundRequestDetail }

type DecisionDialogState =
  | { open: false }
  | { open: true; kind: 'approve'; deciding: boolean; error: string | null }
  | { open: true; kind: 'reject'; deciding: boolean; error: string | null }

type GuardrailState = { title: string; message: string } | null

/** The free-form condition shape `request.approve`'s grant carries (ADR 20260713-authz-hand-rolled-rbac-abac-epoch-claims) — only the one attribute shape this feature reads. */
type ConditionAttribute = { key: string; match: string }
type RuleConditions = { attributes?: ConditionAttribute[] }

/**
 * True iff the caller's resolved permission set grants `request:approve`
 * with the self-approval deny attribute (specs/20260721-self-approval-control, plan.md D1: an
 * OPPOSITE-polarity `match:"deny"` sentinel — deliberately its own check,
 * never routed through any entity/scope-matching logic, mirroring
 * refund-api's `approveSelfRestricted` predicate).
 */
const approveSelfRestricted = (permissions: Permission[]): boolean =>
  permissions.some((permission) => {
    if (permission.resource !== 'request' || permission.action !== 'approve') return false
    const conditions = permission.conditions as RuleConditions | undefined
    return Boolean(conditions?.attributes?.some((attr) => attr.key === 'self-approval' && attr.match === 'deny'))
  })

/** A line gets a classification panel when it is WellD CH and not rejected (UX-13); every other line gets nothing. */
const hasPanel = (line: RefundLine): boolean => line.entity === 'welld_ch' && (line.rejection ?? null) === null

/** The line as the review page names it: "19.03.2026 · Milan–Lugano return". */
const lineLabelOf = (line: RefundLine): string => `${formatDate(line.date)} · ${line.motivo}`

const errorMessageFor = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) {
    if (error.code === 'self_approval_forbidden') return strings.pages.reviewDetail.decide.selfApprovalForbiddenError
    if (error.code === 'all_lines_rejected') return strings.pages.reviewDetail.decide.allLinesRejectedTooltip
    // Approvals are off until the release script has run: nothing to fix on the page, said where the person is.
    if (error.code === 'accounting_release_pending') return strings.pages.reviewDetail.classification.releasePending
    // Accounting cannot be read (AC-6.1, AC-6.2): nothing was approved, and the dialog says so and stays open.
    if (accountingApi.isAccountingUnavailable(error)) return strings.accountingUnavailable.approve
    return error.detail ?? error.title
  }
  return fallback
}

export default function ReviewDetailPage() {
  const { id } = route.useParams()
  const navigate = useNavigate()
  const t = strings.pages.reviewDetail

  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [guardrail, setGuardrail] = useState<GuardrailState>(null)
  const [decisionDialog, setDecisionDialog] = useState<DecisionDialogState>({ open: false })
  // The lines a refused approval (409 `classification_missing`) named, until the next attempt (AC-3.4, S8).
  const [refusal, setRefusal] = useState<ClassificationMissingLine[] | null>(null)
  // A new object each time the summary should take focus to its first missing select.
  const [focusFirstMissing, setFocusFirstMissing] = useState<object | null>(null)
  // The not-found heading takes focus when that state replaces the page (INC-30).
  const headingRef = useFocusOnMount<HTMLHeadingElement>(pageState.status === 'notFound')
  const rowNodesRef = useRef(new Map<string, HTMLDivElement>())
  const linesTitle = strings.pages.requestDetail.lines.sectionHeading

  // specs/20260721-self-approval-control (plan.md D5) — passive UI reflection only.
  const currentUserId = useSession().data?.user?.id
  const { permissions } = usePermissions()
  const isOwner =
    pageState.status === 'loaded' && Boolean(currentUserId) && pageState.request.owner.userId === currentUserId
  const selfApprovalBlocked = isOwner && approveSelfRestricted(permissions)
  const allLinesRejected =
    pageState.status === 'loaded' &&
    pageState.request.lines.length > 0 &&
    pageState.request.lines.every((line) => (line.rejection ?? null) !== null)
  const approveDisabled = selfApprovalBlocked || allLinesRejected
  const approveDisabledReason = selfApprovalBlocked
    ? t.decide.selfApprovalTooltip
    : allLinesRejected
      ? t.decide.allLinesRejectedTooltip
      : undefined

  // ---------------------------------------------------------------------------
  // Classification (specs/20261118-refund-accounting-export): the accounting view and the options
  // ---------------------------------------------------------------------------

  const hasPermission = (resource: string, action: string) =>
    permissions.some((permission) => permission.resource === resource && permission.action === action)
  const request = pageState.status === 'loaded' ? pageState.request : null
  // Only a submitted, approved or paid request is classified, and only when it has a line a panel can show on.
  const classifiable =
    request !== null &&
    (request.status === 'submitted' || request.status === 'approved' || request.status === 'paid') &&
    request.lines.some(hasPanel)
  const [ownerRefusedFor, setOwnerRefusedFor] = useState<string | null>(null)
  const accounting = useLoadedResource(() => accountingApi.getRequestAccounting(id), classifiable)
  const accountingState = accounting.status === 'loaded' && accounting.data.requestId === id ? accounting.data : null
  // Whether the person may open Accounting's exchange rates for WellD CH is the server's call, not a settings grant (AC-7.3, G8b).
  const canOpenRates = accountingState?.viewer.canOpenAccountingRates ?? false
  const classificationState = accountingState?.classificationState ?? 'none'
  // The caller owns this request and may not approve it (SR-2): the view says so, and a 403 `self_approval_forbidden`
  // on a save says it too, before the view is reloaded. Either way nothing on the page is editable.
  const selfRestricted = (accountingState?.selfRestricted ?? false) || ownerRefusedFor === id
  // The capability the state needs; the panel also gets `selfRestricted`, which makes it read-only with its own note.
  const holdsClassificationCapability =
    classificationState === 'review'
      ? hasPermission('request', 'set-approved-total')
      : classificationState === 'post_approval'
        ? hasPermission('request', 'reclassify')
        : false
  // Accounting could not be read when the view was built: every value is as recorded and nothing can be changed (AC-6.5).
  const viewUnavailable = accountingState?.accounting === 'unavailable'
  // Something can be changed (so the options are worth loading) only when the caller is not barred from their own
  // request, and only while Accounting can be read.
  const canChangeClassification = holdsClassificationCapability && !selfRestricted && !viewUnavailable
  // The options are needed only to change something, and are loaded once for the page.
  const options = useLoadedResource(accountingApi.getAccountingOptions, canChangeClassification)
  const reloadAccounting = accounting.reload
  const reloadOptions = options.reload
  // The options answered 503: the same state as the view saying so (the page banner appears, no select is offered).
  const optionsUnreadable = options.status === 'error' && accountingApi.isAccountingUnavailable(options.error)
  const accountingUnreadable = viewUnavailable || optionsUnreadable
  // A 404 is "outside your scope / no such request", like a 403: nothing to retry.
  const classificationHidden =
    classifiable &&
    (accounting.status === 'forbidden' ||
      (accounting.status === 'error' && accounting.error instanceof ApiError && accounting.error.status === 404))
  const accountingLoadFailed =
    classifiable &&
    !classificationHidden &&
    (accounting.status === 'error' || (canChangeClassification && options.status === 'error' && !optionsUnreadable))
  const accountingLoading = classifiable && !classificationHidden && !accountingLoadFailed && accountingState === null

  // Retry of the unavailable banner (UX-23): the banner and its button go when Accounting can be read, so focus returns
  // to the "Lines" heading and the result is said politely, whichever way it went.
  const [retryFrom, setRetryFrom] = useState<{ data: RequestAccounting | null } | null>(null)
  const linesAnchorRef = useRef<HTMLDivElement>(null)
  const retrySettled =
    retryFrom !== null &&
    ((accounting.status === 'loaded' && accounting.data !== retryFrom.data) || accounting.status === 'error') &&
    !(canChangeClassification && options.status === 'loading')
  const retryRecovered = retrySettled && accountingState !== null && !accountingUnreadable
  const retryAnnouncement = !retrySettled
    ? ''
    : retryRecovered
      ? strings.settings.defaults.recovered
      : strings.settings.defaults.stillUnavailable
  // One Retry moves focus once: a later reload that happens to find Accounting readable again must not pull it.
  const retryFocused = useRef<object | null>(null)
  useEffect(() => {
    if (!retryRecovered || retryFrom === null || retryFocused.current === retryFrom) return
    retryFocused.current = retryFrom
    // A heading is not focusable by itself: it takes focus for this one move (a stable anchor, UX-23).
    const heading = linesAnchorRef.current?.querySelector<HTMLElement>('[data-testid="review-detail-lines-heading"]')
    if (heading) {
      heading.tabIndex = -1
      heading.focus()
    }
  }, [retryRecovered, retryFrom])

  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setPageState({ status: 'loading' })
      })
      .then(() => requestsApi.get(id))
      .then((request) => {
        if (!cancelled) setPageState({ status: 'loaded', request })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 404) {
          setPageState({ status: 'notFound' })
        } else {
          setPageState({ status: 'error', message: errorMessageFor(error, t.loadErrorFallback) })
        }
      })

    return () => {
      cancelled = true
    }
  }, [id, reloadToken, t.loadErrorFallback])

  const handleRetry = useCallback(() => {
    setReloadToken((n) => n + 1)
  }, [])

  const reloadRequest = useCallback(async () => {
    try {
      const fresh = await requestsApi.get(id)
      setPageState({ status: 'loaded', request: fresh })
    } catch {
      // Best-effort — the last known-good state stays on screen; explicit Retry remains available.
    }
  }, [id])

  const registerRowRef = useCallback(
    (lineId: string) => (node: HTMLDivElement | null) => {
      if (node) rowNodesRef.current.set(lineId, node)
      else rowNodesRef.current.delete(lineId)
    },
    [],
  )

  // ---------------------------------------------------------------------------
  // Approved-total edits — same "swallow 409 behind GuardrailDialog, rethrow
  // anything else" contract as RequestDetailPage's `runLineMutation`.
  // ---------------------------------------------------------------------------

  const runReviewMutation = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action()
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
          reloadAccounting()
          await reloadRequest()
          return
        }
        throw err
      }
      // The CHF and VAT figures follow the approved total, and a rejected line gains or loses its panel.
      reloadAccounting()
      await reloadRequest()
    },
    [reloadRequest, reloadAccounting, t.guardrail.message, t.guardrail.title],
  )

  const handleApprovedTotalChange = useCallback(
    (lineId: string, cents: number) => runReviewMutation(() => reviewApi.setApprovedTotal(id, lineId, cents)),
    [id, runReviewMutation],
  )

  const handleRejectLine = useCallback(
    (lineId: string, reason: string) => runReviewMutation(() => reviewApi.rejectLine(id, lineId, reason)),
    [id, runReviewMutation],
  )

  const handleRestoreLine = useCallback(
    (lineId: string) => runReviewMutation(() => reviewApi.restoreLine(id, lineId)),
    [id, runReviewMutation],
  )

  const handleDownloadAttachment = useCallback(
    (lineId: string, attachmentId: string) => attachmentsApi.getDownloadUrl(id, lineId, attachmentId),
    [id],
  )

  /** Saves one value and merges the line the server answers with (never a client-side figure). */
  const handleClassify = useCallback(
    async (lineId: string, body: ClassifyBody): Promise<AccountingLine> => {
      const saved = await accountingApi.classifyLine(id, lineId, body)
      accounting.replace((current: RequestAccounting) => ({
        ...current,
        lines: current.lines.map((line) => (line.lineId === saved.lineId ? saved : line)),
      }))
      return saved
    },
    [id, accounting],
  )

  /** 409 on a classification: a paid batch has its own sentence, any other means the status moved on. */
  const handleClassificationConflict = useCallback(
    (error: ApiError) => {
      setGuardrail(
        error.code === 'classification_locked'
          ? { title: t.classification.lockedGuardrail.title, message: t.classification.lockedGuardrail.message }
          : { title: t.guardrail.title, message: t.guardrail.message },
      )
      reloadAccounting()
      void reloadRequest()
    },
    [t, reloadAccounting, reloadRequest],
  )

  /** 403 `self_approval_forbidden` on a save: every panel of this request reads only, and the view loads again. */
  const handleSelfRestricted = useCallback(() => {
    setOwnerRefusedFor(id)
    reloadAccounting()
  }, [id, reloadAccounting])

  const handleClassificationRetry = useCallback(() => {
    reloadAccounting()
    reloadOptions()
  }, [reloadAccounting, reloadOptions])

  /** Retry of the "Accounting cannot be read" banner: remembers what it started from, so the next answer is "the result". */
  const handleAccountingRetry = useCallback(() => {
    setRetryFrom({ data: accountingState })
    reloadAccounting()
    reloadOptions()
  }, [accountingState, reloadAccounting, reloadOptions])

  /** A save was refused with 503: the value is back, and the view is read again so the page says why (AC-6.5). */
  const handleAccountingUnavailable = useCallback(() => {
    reloadAccounting()
  }, [reloadAccounting])

  /** The footer of one line row: its panel, or the skeleton while the view loads, or nothing. */
  const renderClassification = (line: RefundLine) => {
    if (!hasPanel(line) || !classifiable) return undefined
    if (accountingLoading) {
      return (
        <div className="mt-1 border-t border-rule pt-3" aria-hidden="true" data-testid={`classification-${line.id}-loading`}>
          <Skeleton height={14} width="40%" />
          <div className="mt-2">
            <Skeleton height={32} />
          </div>
        </div>
      )
    }
    const accountingLine = accountingState?.lines.find((candidate) => candidate.lineId === line.id)
    // A line out of scope (SR-1) has no classification either, and still gets its note.
    if (!accountingState || !accountingLine) return undefined
    if (accountingLine.inScope && accountingLine.classification === null) return undefined
    if (accountingState.classificationState === 'none') return undefined
    return (
      <LineClassificationPanel
        line={accountingLine}
        lineLabel={lineLabelOf(line)}
        state={accountingState.classificationState}
        // An options 403 (`accounting_out_of_scope`) means the review scope does not cover WellD CH: nothing to pick from.
        // While Accounting cannot be read the options are not asked for, and the panel says that, not "no capability".
        canChange={holdsClassificationCapability && (selfRestricted || accountingUnreadable || options.status !== 'forbidden')}
        selfRestricted={selfRestricted}
        options={options.status === 'loaded' ? options.data : null}
        canOpenRates={canOpenRates}
        accountingUnavailable={accountingUnreadable}
        missing={missingFor(line.id)}
        onClassify={(body) => handleClassify(line.id, body)}
        onConflict={handleClassificationConflict}
        onOptionsStale={reloadOptions}
        onSelfRestricted={handleSelfRestricted}
        onOutOfScope={reloadAccounting}
        onAccountingUnavailable={handleAccountingUnavailable}
      />
    )
  }

  // The accounts a refused approval named that are STILL missing: it shrinks as accounting chooses them, and a line
  // the page no longer has (a race) is dropped. Approval needs an account and nothing else (AC-3.4, AC-3.11, AC-8.4):
  // a VAT code is optional, so the summary never lists one, whatever a refusal's `missing` carries.
  // A line the caller may not see (SR-1) cannot be fixed from here, but the refusal still names it: it gets a row
  // (field `outOfScope`) that is counted and stays until the next attempt, so an approval never fails silently (A-1).
  type MissingField = 'account' | 'outOfScope'
  const missingItems: { lineId: string; field: MissingField; text: string }[] = []
  if (refusal !== null && pageState.status === 'loaded' && accountingState !== null) {
    for (const line of pageState.request.lines) {
      const named = refusal.find((entry) => entry.lineId === line.id)
      const accountingLine = accountingState.lines.find((entry) => entry.lineId === line.id)
      if (!named || !accountingLine) continue
      const label = lineLabelOf(line)
      if (!accountingLine.inScope) {
        missingItems.push({ lineId: line.id, field: 'outOfScope', text: t.classification.missingSummary.outOfScope(label) })
        continue
      }
      const classification = accountingLine.classification
      if (!classification) continue
      // A type default that is deactivated or gone is not a value (before approval, not set by hand): the panel reads it as missing too.
      const gone = (reference: { state: accountingApi.EntryState } | null, isDefault: boolean) =>
        reference === null ||
        (accountingState.classificationState === 'review' && isDefault && accountingApi.entryIsUnusable(reference.state))
      if (named.missing.includes('account') && gone(classification.account, classification.accountIsDefault)) {
        missingItems.push({ lineId: line.id, field: 'account', text: t.classification.missingSummary.account(label) })
      }
    }
  }
  // SG-3: the title counts the lines this approver can fix (an account to choose); the out-of-scope rows keep their
  // own guidance row and are counted apart, never as "need an account".
  const accountItemCount = missingItems.filter((item) => item.field === 'account').length
  const outOfScopeItemCount = missingItems.length - accountItemCount
  const missingFor = (lineId: string) => ({
    account: missingItems.some((item) => item.lineId === lineId && item.field === 'account'),
  })

  /** Moves focus to the select of one missing account; the panel's select carries `data-classification-field`. */
  const focusMissing = useCallback((lineId: string, field: MissingField) => {
    const row = rowNodesRef.current.get(lineId)
    if (field === 'outOfScope') {
      // The line's own note (`tabIndex=-1`): the one place that says why nothing can be chosen here.
      row?.querySelector<HTMLElement>(`[data-testid="classification-${lineId}-out-of-scope"]`)?.focus()
      return
    }
    row
      ?.querySelector<HTMLSelectElement>('select[data-classification-field="account"]')
      ?.focus()
  }, [])

  const summaryFocusRef = useRef<HTMLDivElement>(null)
  const firstFocusTargetRef = useRef<{ lineId: string; field: MissingField } | null>(null)
  const hasMissingItemsRef = useRef(false)
  useEffect(() => {
    // The first select a person can act on; none (only out-of-scope lines named) means the summary itself.
    const firstSelect = missingItems.find((item) => item.field !== 'outOfScope')
    firstFocusTargetRef.current = firstSelect ? { lineId: firstSelect.lineId, field: firstSelect.field } : null
    hasMissingItemsRef.current = missingItems.length > 0
  })
  useEffect(() => {
    // After the dialog has closed and gone: its own focus return has already happened.
    if (focusFirstMissing === null) return
    if (firstFocusTargetRef.current) {
      focusMissing(firstFocusTargetRef.current.lineId, firstFocusTargetRef.current.field)
    } else if (hasMissingItemsRef.current) {
      summaryFocusRef.current?.focus()
    }
  }, [focusFirstMissing, focusMissing])

  /** Above the lines: the one loading line, the one load failure, or the "not available" note. */
  const classificationNotice = classifiable ? (
    <>
      {accountingLoading && <VisuallyHidden live>{t.classification.loading}</VisuallyHidden>}
      {accountingLoadFailed && (
        <ErrorBanner message={t.classification.loadError} onRetry={handleClassificationRetry} />
      )}
      {classificationHidden && (
        <Banner tone="info" live="off" data-testid="classification-unavailable">
          {t.classification.unavailable404}
        </Banner>
      )}
      {/* One banner for the whole page, not one error per line (UX-19); below it every line reads as recorded. */}
      {accountingUnreadable && !classificationHidden && (
        <Banner
          tone="warning"
          live="polite"
          title={t.classification.accountingUnavailablePage.title}
          onRetry={handleAccountingRetry}
          retryLabel={strings.components.errorBanner.defaultRetryLabel}
          retryTestId="classification-accounting-retry"
          data-testid="classification-accounting-unavailable"
        >
          {t.classification.accountingUnavailablePage.body}
        </Banner>
      )}
      <VisuallyHidden live data-testid="classification-retry-result">
        {retryAnnouncement}
      </VisuallyHidden>
      {/* A focus target for the case where no select can take focus; a plain wrapper, so the alert is unchanged. */}
      <div
        ref={summaryFocusRef}
        tabIndex={missingItems.length > 0 ? -1 : undefined}
        className={missingItems.length > 0 ? 'outline-none' : 'hidden'}
        data-testid="classification-missing-summary-focus"
      >
        <ErrorSummary
          title={
            accountItemCount > 0
              ? t.classification.missingSummary.titleAccounts(accountItemCount)
              : t.classification.missingSummary.titleOutOfScope(outOfScopeItemCount)
          }
          hint={
            accountItemCount === 0
              ? t.classification.missingSummary.hintOutOfScope
              : outOfScopeItemCount > 0
                ? `${t.classification.missingSummary.hintAccounts} ${t.classification.missingSummary.alsoOutOfScope(outOfScopeItemCount)}`
                : t.classification.missingSummary.hintAccounts
          }
          items={missingItems.map((item) => ({ id: `${item.lineId}:${item.field}`, text: item.text }))}
          onGo={(itemId) => {
            const at = itemId.lastIndexOf(':')
            focusMissing(itemId.slice(0, at), itemId.slice(at + 1) as MissingField)
          }}
          testId="classification-missing-summary"
        />
      </div>
    </>
  ) : null

  // ---------------------------------------------------------------------------
  // Approve / Reject (design.md F6 steps 4-6)
  // ---------------------------------------------------------------------------

  const handleApproveOpen = useCallback(() => {
    if (approveDisabled) return // defensive — the button is already disabled for this owner+restriction combination
    setDecisionDialog({ open: true, kind: 'approve', deciding: false, error: null })
  }, [approveDisabled])

  const handleRejectOpen = useCallback(() => {
    setDecisionDialog({ open: true, kind: 'reject', deciding: false, error: null })
  }, [])

  const handleDialogCancel = useCallback(() => {
    setDecisionDialog({ open: false })
  }, [])

  const handleApproveConfirm = useCallback(async () => {
    if (pageState.status !== 'loaded') return
    const employeeName = ownerDisplay(pageState.request.owner)
    setRefusal(null)
    setDecisionDialog((prev) => (prev.open ? { ...prev, deciding: true, error: null } : prev))
    try {
      await reviewApi.approve(id)
      setDecisionDialog({ open: false })
      void navigate({ to: '/review', search: { confirmation: t.decide.approveConfirmation(employeeName) } })
    } catch (err) {
      // Told apart by `error.code`, never by status alone (G2): each 409 here means something different.
      const missingLines = accountingApi.classificationMissingLines(err)
      if (missingLines !== null && missingLines.length > 0) {
        // Nothing to confirm any more: the values to fix are on the page, which a dialog would cover (UX-5).
        // The request and the accounting view load again, so a line the page no longer has is settled first.
        setDecisionDialog({ open: false })
        setRefusal(missingLines)
        setFocusFirstMissing({})
        reloadAccounting()
        await reloadRequest()
      } else if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.code !== 'all_lines_rejected' &&
        err.code !== 'accounting_release_pending' &&
        missingLines === null
      ) {
        setDecisionDialog({ open: false })
        setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
        await reloadRequest()
      } else {
        // `accounting_release_pending` and `all_lines_rejected` say their own sentence in the dialog, which stays
        // open (nothing on the page can fix either); so does a refusal that names no usable line.
        setDecisionDialog((prev) =>
          prev.open ? { ...prev, deciding: false, error: errorMessageFor(err, t.decide.genericError) } : prev,
        )
      }
    }
  }, [pageState, id, navigate, t, reloadRequest, reloadAccounting])

  const handleRejectConfirm = useCallback(
    async (motivation: string) => {
      if (pageState.status !== 'loaded') return
      const employeeName = ownerDisplay(pageState.request.owner)
      setDecisionDialog((prev) => (prev.open ? { ...prev, deciding: true, error: null } : prev))
      try {
        await reviewApi.reject(id, motivation)
        setDecisionDialog({ open: false })
        void navigate({ to: '/review', search: { confirmation: t.decide.rejectConfirmation(employeeName) } })
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setDecisionDialog({ open: false })
          setGuardrail({ title: t.guardrail.title, message: t.guardrail.message })
          await reloadRequest()
        } else {
          setDecisionDialog((prev) =>
            prev.open ? { ...prev, deciding: false, error: errorMessageFor(err, t.decide.genericError) } : prev,
          )
        }
      }
    },
    [pageState, id, navigate, t, reloadRequest],
  )

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section aria-labelledby="refund-review-detail-heading" data-testid="refund-review-detail-page">
      <span className="sr-only" data-testid="refund-review-detail-id">
        {id}
      </span>

      {guardrail && (
        <GuardrailDialog title={guardrail.title} message={guardrail.message} onAcknowledge={() => setGuardrail(null)} />
      )}

      {/* Title block and the archive export share one row, the export pushed
          right as a secondary action (ADR 20260908-request-archive-export-refund-api-reads-attachment-bytes). It sits in the header rather
          than in the body because it acts on the WHOLE request, not on the
          section it would otherwise have been wedged between. Rendered only
          for an approved request, matching the endpoint's archivable-status
          gate, so the control never appears where it would 409. */}
      <PageHeader
        title={pageState.status === 'notFound' ? t.notFound.heading : t.heading}
        titleId="refund-review-detail-heading"
        headingRef={pageState.status === 'notFound' ? headingRef : undefined}
        focusableHeading={pageState.status === 'notFound'}
        status={pageState.status === 'loaded' && <RequestStatusBadge status={pageState.request.status} />}
        back={
          pageState.status !== 'notFound' && (
            <Link to="/review" className="link inline-flex items-center gap-1" data-testid="review-detail-back">
              <Icon name="arrow-left" />
              {t.notFound.backLink}
            </Link>
          )
        }
        actions={
          pageState.status === 'loaded' &&
          pageState.request.status === 'approved' && <RequestExportLink requestId={pageState.request.id} />
        }
      />

      {/* The status must be STATED, not inferred (the badge beside the title);
          who asked and who decided follow the header, as the queue row does. */}
      <div className="-mt-2 min-w-0">
        {pageState.status === 'loaded' && (
          <p className="mt-1 text-sm text-soft" data-testid="review-detail-requested-by">
            {t.requestedByLabel(pageState.request.owner)}
          </p>
        )}

        {/* Decision stamp — the counterpart to the paid branch's "Paid on X
          by Y", which approved and rejected were missing. Sits beside the
          "Requested by" line because it answers the same kind of question
          about the same record: who, and when. A `paid` request shows this
          AND its payout line — two different events, by two different
          people. Rendered only when both halves are present rather than
          printing "by undefined" over a partial record. */}
        {pageState.status === 'loaded' &&
          pageState.request.decidedAt !== null &&
          pageState.request.decidedBy !== null && (
            <p
              className={`mt-1 text-sm ${pageState.request.status === 'rejected' ? 'text-red-text' : 'text-grn-text'}`}
              data-testid="review-detail-decision-line"
            >
              {pageState.request.status === 'rejected'
                ? t.decision.rejectedLine(formatDate(pageState.request.decidedAt), pageState.request.decidedBy.email)
                : t.decision.approvedLine(formatDate(pageState.request.decidedAt), pageState.request.decidedBy.email)}
            </p>
          )}
      </div>

      <div ref={linesAnchorRef} className="mt-4 flex flex-col gap-4">
        {pageState.status === 'loading' && (
          <>
            <VisuallyHidden live>{t.loadingAnnouncement}</VisuallyHidden>
            <SkeletonListRows />
          </>
        )}

        {pageState.status === 'error' && <ErrorBanner message={pageState.message} onRetry={handleRetry} />}

        {pageState.status === 'notFound' && (
          <div data-testid="review-detail-not-found">
            <p className="text-sm text-soft">{t.notFound.body}</p>
            <Link to="/review" data-testid="review-detail-not-found-back" className="link mt-3 inline-block text-sm">
              {t.notFound.backLink}
            </Link>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'submitted' && (
          <div data-testid="review-detail-decidable" className="flex flex-col gap-4">
            <SubtotalsPanel subtotals={pageState.request.subtotals} />

            {classificationNotice}
            <LinesCard title={linesTitle(pageState.request.lines.length)} headingTestId="review-detail-lines-heading">
              {pageState.request.lines.map((line) => (
                <ExpenseLineRow
                  key={line.id}
                  line={line}
                  mode="review"
                  onApprovedTotalChange={(cents) => handleApprovedTotalChange(line.id, cents)}
                  onRejectLine={(reason) => handleRejectLine(line.id, reason)}
                  onRestoreLine={() => handleRestoreLine(line.id)}
                  onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                  registerRef={registerRowRef(line.id)}
                  footer={renderClassification(line)}
                />
              ))}
            </LinesCard>

            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                onClick={handleApproveOpen}
                aria-disabled={approveDisabled}
                title={approveDisabledReason}
                data-testid="review-detail-approve"
              >
                {t.decide.approveButton}
                {approveDisabledReason && <span className="sr-only"> — {approveDisabledReason}</span>}
              </Button>
              <Button variant="danger" onClick={handleRejectOpen} data-testid="review-detail-reject">
                {t.decide.rejectButton}
              </Button>
            </div>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'approved' && (
          <div data-testid="review-detail-approved" className="flex flex-col gap-4">
            {/* The monthly-processing note sits directly under the totals, as a
                footnote to them: it answers "when does this figure get paid".
                It used to be a bordered accent panel at the very bottom of the
                page — the loudest thing on screen, saying the same sentence on
                every approved request forever. */}
            <SubtotalsPanel subtotals={pageState.request.subtotals} showApproved footnote={<MonthlyProcessingNote />} />
            {classificationNotice}
            <LinesCard title={linesTitle(pageState.request.lines.length)} headingTestId="review-detail-lines-heading">
              {pageState.request.lines.map((line) => (
                <ExpenseLineRow
                  key={line.id}
                  line={line}
                  mode="readOnlyApproved"
                  onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                  registerRef={registerRowRef(line.id)}
                  footer={renderClassification(line)}
                />
              ))}
            </LinesCard>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'rejected' && (
          <div data-testid="review-detail-rejected" className="flex flex-col gap-4">
            <Card
              title={strings.pages.requestDetail.rejected.motivationHeading}
              data-testid="review-detail-rejection-motivation"
            >
              <p className="text-sm">{pageState.request.rejectionMotivation}</p>
            </Card>
            <SubtotalsPanel subtotals={pageState.request.subtotals} />
            <LinesCard title={linesTitle(pageState.request.lines.length)} headingTestId="review-detail-lines-heading">
              {pageState.request.lines.map((line) => (
                <ExpenseLineRow
                  key={line.id}
                  line={line}
                  mode="readOnly"
                  onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                  registerRef={registerRowRef(line.id)}
                />
              ))}
            </LinesCard>
          </div>
        )}

        {pageState.status === 'loaded' && pageState.request.status === 'paid' && (
          <div data-testid="review-detail-paid" className="flex flex-col gap-4">
            {pageState.request.paidAt && pageState.request.paidBy && (
              <p className="text-sm text-grn-text" data-testid="review-detail-paid-line">
                {t.paid.paidLine(formatDateTime(pageState.request.paidAt), pageState.request.paidBy)}
              </p>
            )}
            <SubtotalsPanel subtotals={pageState.request.subtotals} showApproved />
            {classificationNotice}
            <LinesCard title={linesTitle(pageState.request.lines.length)} headingTestId="review-detail-lines-heading">
              {pageState.request.lines.map((line) => (
                <ExpenseLineRow
                  key={line.id}
                  line={line}
                  mode="readOnlyApproved"
                  onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                  registerRef={registerRowRef(line.id)}
                  footer={renderClassification(line)}
                />
              ))}
            </LinesCard>
          </div>
        )}

        {pageState.status === 'loaded' &&
          pageState.request.status !== 'submitted' &&
          pageState.request.status !== 'approved' &&
          pageState.request.status !== 'rejected' &&
          pageState.request.status !== 'paid' && (
            <LinesCard title={linesTitle(pageState.request.lines.length)} testId="review-detail-readonly-fallback">
              {pageState.request.lines.map((line) => (
                <ExpenseLineRow
                  key={line.id}
                  line={line}
                  mode="readOnly"
                  onDownloadAttachment={(attachmentId) => handleDownloadAttachment(line.id, attachmentId)}
                  registerRef={registerRowRef(line.id)}
                />
              ))}
            </LinesCard>
          )}
      </div>

      {decisionDialog.open && decisionDialog.kind === 'approve' && pageState.status === 'loaded' && (
        <ApproveDialog
          employeeName={ownerDisplay(pageState.request.owner)}
          isDeciding={decisionDialog.deciding}
          errorMessage={decisionDialog.error}
          onConfirm={() => void handleApproveConfirm()}
          onCancel={handleDialogCancel}
        />
      )}

      {decisionDialog.open && decisionDialog.kind === 'reject' && pageState.status === 'loaded' && (
        <RejectDialog
          employeeName={ownerDisplay(pageState.request.owner)}
          isDeciding={decisionDialog.deciding}
          errorMessage={decisionDialog.error}
          onConfirm={(motivation) => void handleRejectConfirm(motivation)}
          onCancel={handleDialogCancel}
        />
      )}
    </section>
  )
}
