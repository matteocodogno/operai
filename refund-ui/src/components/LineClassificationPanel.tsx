/**
 * LineClassificationPanel — the account and VAT code of ONE WellD CH line on the review page
 * (specs/20261118-refund-accounting-export, design S7, F5, F6, UX-4, UX-13, UX-14; AC-3.1, AC-3.2, AC-3.3, AC-3.6,
 * AC-3.7, AC-3.8, AC-3.9, AC-3.10). It sits in the line row's footer slot; the page decides which lines get one
 * (WellD CH and not rejected: no panel, and no "not applicable" text, for any other line).
 *
 * Everything shown comes from the server's accounting view of the line (`AccountingLine`): the values, whether each
 * is the default or was set by hand, the exchange rate, the CHF amount and the VAT amount. The browser never
 * computes a figure; a save answers with the whole line and the page merges it.
 *
 *   - Editable (`canChange`, state `review` or `post_approval`): two native selects, number first, committed ON CHANGE
 *     (UX-4; no confirmation after approval either, UX-14). The marker (*Default* / *Set by hand*) lives in the
 *     field's hint, so a screen reader hears it. A value that is not set yet reads "Choose …" with "Required to
 *     approve." and is only an error after a refused approval (`missing`). A saved value that has since been
 *     deactivated stays as a disabled "(inactive)" option with a hint.
 *   - While one select saves it shows "Saving…", ignores further changes (`aria-busy`; it is NOT disabled, so it
 *     keeps focus) and shows the chosen value; a refusal puts the last saved value back and says why in an alert
 *     under it: 422 inactive (and the options reload), 403, or anything else. A 409 is the page's: `onConflict`.
 *   - Read-only (no capability for the state, the batch is paid, or the request is the caller's own and they may not
 *     approve it, `selfRestricted`): the same values as plain text with their markers and a sentence saying why; paid
 *     adds a lock icon. A 403 `self_approval_forbidden` on a save turns an editable panel into this one at once.
 *   - Out of scope (`line.inScope === false`, plan.md SR-1): the server sent no account, VAT code or amounts, so the
 *     panel is one short note: no figure, no control.
 *   - Amounts: a CHF line has only the VAT amount, with its rate; a foreign line has the rate used and its month, the
 *     CHF amount and the VAT amount. A missing rate is a *Rate missing* badge, "—" for both amounts (never 0) and, with
 *     `settings:read`, a link to that month in Settings. A VAT code of 0% shows a real `CHF 0.00`.
 *
 * Every select carries `data-classification-field="account" | "vat"` and sits inside the line row, so the page can
 * move focus to the first missing one after a refused approval without this component knowing about it.
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Badge, FactList, Field, Icon, StatusBadge } from '@operai/ui'
import type { Fact } from '@operai/ui'
import { strings } from '../strings'
import type {
  AccountingLine,
  AccountingOptions,
  ClassificationState,
  ClassifyBody,
  LineChf,
} from '../lib/accountingApi'
import { accountText, formatVatRate, vatCodeText } from '../lib/catalogLabels'
import { formatMoney } from '../lib/money'
import { monthLabel } from '../lib/monthLabel'
import { ApiError } from '../lib/refundApi'
import { RATE_MISSING_MEANING } from '../lib/statusMeaning'
import CatalogSelect from './CatalogSelect'

const t = strings.pages.reviewDetail.classification

type FieldName = 'account' | 'vatCode'

/** What an in-scope line without CHF data shows: "—" everywhere, never a figure of our own. */
const NO_CHF: LineChf = { amountCents: null, rateMicros: null, rate: null, rateMonth: null, rateStatus: 'not_applicable' }

export type LineClassificationPanelProps = {
  /** The server's view of the line. `classification` is non-null: the page renders no panel otherwise. */
  line: AccountingLine
  /** "19.03.2026 · Milan–Lugano return": names the group for a screen reader. */
  lineLabel: string
  state: Exclude<ClassificationState, 'none'>
  /** The user holds the capability this state needs (`set-approved-total` before approval, `reclassify` after). */
  canChange: boolean
  /** The active accounts and VAT codes, or `null` while they load (the selects wait, disabled). */
  options: AccountingOptions | null
  /** `settings:read`: "Open exchange rates" is offered when the rate is missing. */
  canOpenRates: boolean
  /** The caller owns this request and may not approve it (the view's `selfRestricted`): read-only, with its own note. */
  selfRestricted?: boolean
  /** The values a refused approval named for this line: shown as an error until a value is chosen. */
  missing?: { account: boolean; vatCode: boolean }
  /** Saves one value and answers with the line as the server now has it (the page merges it). Rejects with the `ApiError`. */
  onClassify: (body: ClassifyBody) => Promise<AccountingLine>
  /** A 409 (locked, or the status changed): the page explains it and reloads. */
  onConflict: (error: ApiError) => void
  /** A 422 said an option was deactivated: load the options again. */
  onOptionsStale: () => void
  /** A 403 `self_approval_forbidden`: the page makes every panel of the request read-only. */
  onSelfRestricted?: () => void
  /** A 404: the line is outside the caller's entity scope (the view was stale): the page loads the view again. */
  onOutOfScope?: () => void
}

type FieldMessage = { field: FieldName; text: string }

export default function LineClassificationPanel({
  line,
  lineLabel,
  state,
  canChange,
  options,
  canOpenRates,
  selfRestricted = false,
  missing,
  onClassify,
  onConflict,
  onOptionsStale,
  onSelfRestricted,
  onOutOfScope,
}: LineClassificationPanelProps) {
  const classification = line.classification
  // The select that is saving, and the value it was changed to (shown until the server answers).
  const [pending, setPending] = useState<{ field: FieldName; value: string } | null>(null)
  const [errorMessage, setErrorMessage] = useState<FieldMessage | null>(null)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  // A save was refused with 403 `self_approval_forbidden`: read-only from now on, even before the page reports it.
  const [refusedAsOwner, setRefusedAsOwner] = useState(false)
  // The reason sentence of the read-only group. The select that had focus is gone after a refused save (A-2), so
  // the reason takes focus: the sentence is read, and the keyboard position stays inside this panel.
  const whyRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (refusedAsOwner) whyRef.current?.focus()
  }, [refusedAsOwner])

  if (!line.inScope) {
    return (
      <p
        className="mt-1 border-t border-rule pt-3 text-xs text-soft outline-none focus-visible:outline-2"
        tabIndex={-1}
        data-testid={`classification-${line.lineId}-out-of-scope`}
      >
        {t.outOfScope}
      </p>
    )
  }
  if (classification === null) return null

  const locked = state === 'locked'
  const ownRequest = selfRestricted || refusedAsOwner
  const editable = canChange && !locked && !ownRequest

  const handleChange = async (field: FieldName, value: string) => {
    if (pending !== null || value === '') return
    const current = field === 'account' ? classification.account?.number : classification.vatCode?.code
    if (value === current) return
    setPending({ field, value })
    setErrorMessage(null)
    setSavedMessage(null)
    try {
      const saved = await onClassify(field === 'account' ? { accountNumber: value } : { vatCode: value })
      const savedClassification = saved.classification
      if (field === 'account' && savedClassification?.account) {
        setSavedMessage(t.savedAccount(accountText(savedClassification.account)))
      } else if (field === 'vatCode' && savedClassification?.vatCode) {
        setSavedMessage(t.savedVat(vatCodeText(savedClassification.vatCode)))
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined
      if (error instanceof ApiError && error.status === 409) {
        onConflict(error)
      } else if (code === 'ledger_account_inactive' || code === 'ledger_account_not_found') {
        setErrorMessage({ field: 'account', text: code === 'ledger_account_inactive' ? t.accountInactive : t.accountUnknown })
        onOptionsStale()
      } else if (code === 'vat_code_inactive' || code === 'vat_code_not_found') {
        setErrorMessage({ field: 'vatCode', text: code === 'vat_code_inactive' ? t.vatInactive : t.vatUnknown })
        onOptionsStale()
      } else if (code === 'self_approval_forbidden') {
        // Not an error under the select: the whole panel turns read-only and says why. The select reverts by itself.
        setRefusedAsOwner(true)
        onSelfRestricted?.()
      } else if (error instanceof ApiError && error.status === 404) {
        setErrorMessage({ field, text: t.lineOutOfScope })
        onOutOfScope?.()
      } else if (error instanceof ApiError && error.status === 403) {
        setErrorMessage({ field, text: t.forbidden })
      } else {
        setErrorMessage({ field, text: t.saveError })
      }
    } finally {
      setPending(null)
    }
  }

  const marker = (isDefault: boolean) => (
    <Badge tone={isDefault ? 'neutral' : 'accent'}>{isDefault ? t.defaultMarker : t.handMarker}</Badge>
  )

  // ---------------------------------------------------------------------------
  // The amounts: the server's figures, "—" for one it could not give (never 0)
  // ---------------------------------------------------------------------------

  const chf = line.chf ?? NO_CHF
  const isForeign = line.currency !== 'CHF'
  const rateMonthText = monthLabel(chf.rateMonth ?? line.date.slice(0, 7))
  const facts: Fact[] = []
  if (isForeign) {
    facts.push({
      id: 'rate',
      term: t.rate,
      value: chf.rateStatus === 'missing' || chf.rateStatus === 'pending' ? (
        <span className="flex flex-col items-start gap-1" data-testid={`classification-${line.lineId}-rate-missing`}>
          <StatusBadge status={RATE_MISSING_MEANING}>{t.rateMissing}</StatusBadge>
          <span className="text-xs text-soft">
            {t.rateMissingHelp(line.currency, rateMonthText)}
            {!canOpenRates && ` ${strings.pages.batchDetail.accountingExport.blocked.askAdmin}`}
          </span>
          {canOpenRates && (
            <Link
              to="/settings"
              search={{ section: 'exchange-rates', month: chf.rateMonth ?? line.date.slice(0, 7) }}
              className="link text-xs"
            >
              {t.openRates}
            </Link>
          )}
        </span>
      ) : chf.rate !== null ? (
        <span className="font-mono" data-testid={`classification-${line.lineId}-rate`}>
          {t.rateValue(chf.rate, rateMonthText)}
        </span>
      ) : (
        t.unavailable
      ),
    })
    facts.push({
      id: 'chf',
      term: t.chfAmount,
      value: (
        <span className="font-mono tabular-nums" data-testid={`classification-${line.lineId}-chf`}>
          {chf.amountCents === null ? t.unavailable : formatMoney(chf.amountCents, 'CHF')}
        </span>
      ),
    })
  }
  const vatAmount =
    line.vatAmountCents === null
      ? t.unavailable
      : isForeign || classification.vatCode === null
        ? formatMoney(line.vatAmountCents, 'CHF')
        : t.vatAmountValue(formatMoney(line.vatAmountCents, 'CHF'), formatVatRate(classification.vatCode.ratePercent))
  facts.push({
    id: 'vat',
    term: t.vatAmount,
    value: (
      <span className="font-mono tabular-nums" data-testid={`classification-${line.lineId}-vat-amount`}>
        {vatAmount}
      </span>
    ),
  })
  const amounts = <FactList items={facts} testId={`classification-${line.lineId}-amounts`} />

  // ---------------------------------------------------------------------------
  // Read-only: the values as plain text, with why
  // ---------------------------------------------------------------------------

  if (!editable) {
    const valueText = (text: string | null, isDefault: boolean, inactive: boolean) =>
      text === null ? (
        t.unavailable
      ) : (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span>{inactive ? t.inactiveOption(text) : text}</span>
          {marker(isDefault)}
        </span>
      )
    return (
      <div
        role="group"
        aria-label={t.groupLabel(lineLabel)}
        className="mt-1 flex flex-col gap-3 border-t border-rule pt-3"
        data-testid={`classification-${line.lineId}`}
        data-mode={locked ? 'locked' : 'readOnly'}
      >
        <p className="text-xs font-medium text-soft">{t.legend}</p>
        <FactList
          items={[
            {
              id: 'account',
              term: t.account,
              value: valueText(
                classification.account ? accountText(classification.account) : null,
                classification.accountIsDefault,
                classification.account?.state === 'deactivated',
              ),
            },
            {
              id: 'vatCode',
              term: t.vatCode,
              value: valueText(
                classification.vatCode ? vatCodeText(classification.vatCode) : null,
                classification.vatCodeIsDefault,
                classification.vatCode?.state === 'deactivated',
              ),
            },
          ]}
          testId={`classification-${line.lineId}-values`}
        />
        {amounts}
        <p
          ref={whyRef}
          role="status"
          tabIndex={-1}
          className="flex items-center gap-1.5 text-xs text-soft outline-none focus-visible:outline-2"
          data-testid={`classification-${line.lineId}-why`}
        >
          {locked && <Icon name="lock" />}
          {locked ? t.locked : ownRequest && canChange ? t.selfRestricted : t.readOnly}
        </p>
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Editable
  // ---------------------------------------------------------------------------

  const shown = (field: FieldName, saved: string): string => (pending?.field === field ? pending.value : saved)
  const selectsLocked = options === null

  const accountRef = classification.account
  const vatRef = classification.vatCode
  const accountOptions = options?.ledgerAccounts ?? []
  const vatOptions = options?.vatCodes ?? []

  const fieldHint = (field: FieldName) => {
    const reference = field === 'account' ? accountRef : vatRef
    if (pending?.field === field) return t.saving
    if (reference === null) return t.required
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {marker(field === 'account' ? classification.accountIsDefault : classification.vatCodeIsDefault)}
        {reference.state === 'deactivated' && (
          <span>{field === 'account' ? t.inactiveCurrentAccount : t.inactiveCurrentVat}</span>
        )}
        {reference.state === 'not_found' && (
          <span>{field === 'account' ? t.notFoundCurrentAccount : t.notFoundCurrentVat}</span>
        )}
      </span>
    )
  }

  const fieldError = (field: FieldName): string | undefined => {
    if (errorMessage?.field === field) return errorMessage.text
    const reference = field === 'account' ? accountRef : vatRef
    const refused = field === 'account' ? missing?.account : missing?.vatCode
    if (refused && reference === null) return field === 'account' ? t.missingAccount : t.missingVatCode
    return undefined
  }

  const accountValue = shown('account', accountRef?.number ?? '')
  const vatValue = shown('vatCode', vatRef?.code ?? '')

  return (
    <fieldset
      aria-label={t.groupLabel(lineLabel)}
      className="mt-1 flex min-w-0 flex-col gap-3 border-0 border-t border-rule p-0 pt-3"
      data-testid={`classification-${line.lineId}`}
      data-mode="editable"
    >
      <legend className="text-xs font-medium text-soft">{t.legend}</legend>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={t.account}
          hint={fieldHint('account')}
          error={fieldError('account')}
          errorRole="alert"
          required
          testId={`classification-${line.lineId}-account-field`}
        >
          {(control) => (
            <CatalogSelect
              {...control}
              kind="account"
              options={accountOptions}
              current={accountRef}
              value={accountValue}
              onChange={(value) => void handleChange('account', value)}
              placeholder={accountValue === '' ? t.chooseAccount : undefined}
              disabled={selectsLocked}
              aria-busy={pending?.field === 'account' || undefined}
              data-classification-field="account"
              data-testid={`classification-${line.lineId}-account`}
            />
          )}
        </Field>
        <Field
          label={t.vatCode}
          hint={fieldHint('vatCode')}
          error={fieldError('vatCode')}
          errorRole="alert"
          required
          testId={`classification-${line.lineId}-vat-code-field`}
        >
          {(control) => (
            <CatalogSelect
              {...control}
              kind="vatCode"
              options={vatOptions}
              current={vatRef}
              value={vatValue}
              onChange={(value) => void handleChange('vatCode', value)}
              placeholder={vatValue === '' ? t.chooseVatCode : undefined}
              disabled={selectsLocked}
              aria-busy={pending?.field === 'vatCode' || undefined}
              data-classification-field="vat"
              data-testid={`classification-${line.lineId}-vat-code`}
            />
          )}
        </Field>
      </div>

      <p role="status" className="min-h-0 text-xs text-soft" data-testid={`classification-${line.lineId}-saved`}>
        {savedMessage}
      </p>

      {amounts}

      {state === 'review' && <p className="text-xs text-soft">{t.follows}</p>}
    </fieldset>
  )
}
