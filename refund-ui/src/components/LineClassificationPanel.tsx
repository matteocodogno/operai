/**
 * LineClassificationPanel — the account and the optional VAT code of ONE WellD CH line on the review page
 * (specs/20261118-refund-accounting-export, design S7, F5, F6, UX-4, UX-13, UX-14; AC-3.1, AC-3.3, AC-3.6,
 * AC-3.7, AC-3.8, AC-3.9, AC-3.10, AC-3.11, AC-3.13). It sits in the line row's footer slot; the page decides which lines get one
 * (WellD CH and not rejected: no panel, and no "not applicable" text, for any other line).
 *
 * Everything shown comes from the server's accounting view of the line (`AccountingLine`): the values, whether each
 * is the default or was set by hand, the exchange rate, the CHF amount and the VAT amount. The browser never
 * computes a figure; a save answers with the whole line and the page merges it.
 *
 *   - Editable (`canChange`, state `review` or `post_approval`): two native selects, number first, committed ON CHANGE
 *     (UX-4; no confirmation after approval either, UX-14). The account's marker (*Default* / *Set by hand*) lives in
 *     the field's hint, so a screen reader hears it. An account that is not set yet reads "Choose …" with "Required
 *     to approve." and is only an error after a refused approval (`missing`). A saved value that has since been
 *     deactivated stays as a disabled "(inactive)" option with a hint.
 *   - The VAT code is OPTIONAL (T70, specs/20261118 SO-2, SO-3, SO-5; AC-3.3, AC-3.11, AC-3.13): its select always
 *     offers "None", which is what a line without a code shows, and which is what a EUR line shows too (a VAT code
 *     is never pre-set, so there is no VAT marker and no VAT "required"). Choosing a code sends `{ vatCode }`;
 *     choosing None sends `{ vatCode: null }`, which clears it. A line with no code shows no VAT amount (AC-3.8).
 *   - While one select saves it shows "Saving…", ignores further changes (`aria-busy`; it is NOT disabled, so it
 *     keeps focus) and shows the chosen value; a refusal puts the last saved value back and says why in an alert
 *     under it: 422 inactive (and the options reload), 403, or anything else. A 409 is the page's: `onConflict`.
 *   - Read-only (no capability for the state, the batch is paid, or the request is the caller's own and they may not
 *     approve it, `selfRestricted`): the same values as plain text with their markers and a sentence saying why; paid
 *     adds a lock icon. A 403 `self_approval_forbidden` on a save turns an editable panel into this one at once.
 *   - Out of scope (`line.inScope === false`, plan.md SR-1): the server sent no account, VAT code or amounts, so the
 *     panel is one short note: no figure, no control.
 *   - Amounts: a CHF line has only the VAT amount, with its rate; a foreign line has the rate used and its month, the
 *     CHF amount and the VAT amount. A rate that is not there is NOT a failure (UX-20, AC-5.6): before approval a
 *     *No rate yet* badge that says the request can still be approved, after it a *Rate pending* badge that says the
 *     rate is copied at the first export; both with "—" for the CHF and VAT amounts (never 0), and a link to that
 *     month in Accounting when the view says the person may open it (`canOpenRates`), "ask an accounting manager"
 *     otherwise. A VAT code of 0% shows a real `CHF 0.00`.
 *
 * specs/20261119-accounting (T35, T36, RS4; AC-4.1 to AC-4.3, AC-4.9, AC-5.2, AC-5.6, AC-6.1, AC-6.5, AC-6.10, AC-7.3):
 * values are Accounting's numbers and codes, each with Accounting's `state` (UX-18).
 *   - A stored copy that was deactivated, or is no longer in Accounting, stays the selected (disabled) option with a
 *     hint. A TYPE DEFAULT that is no longer usable (before approval, not set by hand) is not a copy yet: the select
 *     reads "Choose…" and the hint says why, so approving without it is refused as `classification_missing`.
 *   - Accounting cannot be read (`accountingUnavailable`): the read-only group with the values as recorded, each
 *     marked *Default (as recorded)* or *Set by hand*, and the sentence that says why. A save refused with 503 puts
 *     the value back, says nothing was changed, and asks the page to read the view again.
 *   - After approval the account, VAT code and rate are kept as booked: one sentence says later changes in Accounting
 *     do not change the line.
 *
 * Every select carries `data-classification-field="account" | "vat"` and sits inside the line row, so the page can
 * move focus to the first missing one after a refused approval without this component knowing about it.
 */

import { useEffect, useRef, useState } from 'react'
import { Badge, FactList, Field, Icon, StatusBadge } from '@operai/ui'
import type { Fact } from '@operai/ui'
import { strings } from '../strings'
import { entryIsUnusable, isAccountingUnavailable } from '../lib/accountingApi'
import type {
  AccountingLine,
  AccountingOptions,
  ClassificationState,
  ClassifyBody,
  EntryState,
  LineChf,
} from '../lib/accountingApi'
import { CATALOG_NONE, accountText, formatVatRate, vatCodeText } from '../lib/catalogLabels'
import { formatMoney } from '../lib/money'
import { monthLabel } from '../lib/monthLabel'
import { ApiError } from '../lib/refundApi'
import { RATE_MISSING_MEANING } from '../lib/statusMeaning'
import CatalogSelect from './CatalogSelect'

const t = strings.pages.reviewDetail.classification

type FieldName = 'account' | 'vatCode'

/** The Accounting month view for WellD CH (AC-7.3). A plain `href`: the link leaves this tool (UX-17). */
const accountingRatesHref = (month: string): string =>
  `/accounting/exchange-rates?entity=welld_ch&month=${encodeURIComponent(month)}`

/** What an in-scope line without CHF data shows: "—" everywhere, never a figure of our own. */
const NO_CHF: LineChf = { amountCents: null, rateMicros: null, rate: null, rateMonth: null, rateStatus: 'not_applicable' }

/**
 * A default that is not a copy yet (before approval, not set by hand) and whose entry is deactivated or gone has
 * nothing to keep: it reads as missing, with the reason (G8a). After approval, or when set by hand, the value is the
 * line's own and stays selected, marked.
 */
const isUnusableDefault = (
  reference: { state: EntryState } | null,
  isDefault: boolean,
  state: LineClassificationPanelProps['state'],
): boolean => reference !== null && state === 'review' && isDefault && entryIsUnusable(reference.state)

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
  /** The view's `viewer.canOpenAccountingRates` (AC-7.3): "Open exchange rates" is offered when the rate is not there. */
  canOpenRates: boolean
  /** Accounting could not be read (the view says so, or the options answered 503): read-only, values as recorded (AC-6.5). */
  accountingUnavailable?: boolean
  /** The caller owns this request and may not approve it (the view's `selfRestricted`): read-only, with its own note. */
  selfRestricted?: boolean
  /** What a refused approval named for this line: the account, shown as an error until one is chosen (AC-3.4). */
  missing?: { account: boolean }
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
  /** A 503 `accounting_unavailable` on a save: the value is back, and the page reads the view again (AC-6.5). */
  onAccountingUnavailable?: () => void
}

type FieldMessage = { field: FieldName; text: string }

export default function LineClassificationPanel({
  line,
  lineLabel,
  state,
  canChange,
  options,
  canOpenRates,
  accountingUnavailable = false,
  selfRestricted = false,
  missing,
  onClassify,
  onConflict,
  onOptionsStale,
  onSelfRestricted,
  onOutOfScope,
  onAccountingUnavailable,
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
  // A save of THIS panel was refused with 503: when the view then says Accounting cannot be read, the select that
  // had focus is gone, so the reason takes it (A-2). Only this panel, not every panel of the page.
  const focusReasonWhenUnavailable = useRef(false)
  useEffect(() => {
    if (accountingUnavailable && focusReasonWhenUnavailable.current) {
      focusReasonWhenUnavailable.current = false
      whyRef.current?.focus()
    }
  }, [accountingUnavailable])

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
  const editable = canChange && !locked && !ownRequest && !accountingUnavailable

  const handleChange = async (field: FieldName, value: string) => {
    if (pending !== null || value === '') return
    const current = field === 'account' ? classification.account?.number : (classification.vatCode?.code ?? CATALOG_NONE)
    if (value === current) return
    setPending({ field, value })
    setErrorMessage(null)
    setSavedMessage(null)
    try {
      const saved = await onClassify(
        field === 'account' ? { accountNumber: value } : { vatCode: value === CATALOG_NONE ? null : value },
      )
      const savedClassification = saved.classification
      if (field === 'account' && savedClassification?.account) {
        setSavedMessage(t.savedAccount(accountText(savedClassification.account)))
      } else if (field === 'vatCode' && savedClassification?.vatCode) {
        setSavedMessage(t.savedVat(vatCodeText(savedClassification.vatCode)))
      } else if (field === 'vatCode' && savedClassification?.vatCode === null) {
        setSavedMessage(t.savedVatNone)
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
      } else if (isAccountingUnavailable(error)) {
        // Nothing changed: the select shows what is saved again, the alert says so, and the view is read again.
        setErrorMessage({ field, text: strings.accountingUnavailable.classify })
        focusReasonWhenUnavailable.current = true
        onAccountingUnavailable?.()
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
    <Badge tone={isDefault ? 'neutral' : 'accent'}>
      {isDefault ? (accountingUnavailable ? t.defaultRecorded : t.defaultMarker) : t.handMarker}
    </Badge>
  )

  // ---------------------------------------------------------------------------
  // The amounts: the server's figures, "—" for one it could not give (never 0)
  // ---------------------------------------------------------------------------

  const chf = line.chf ?? NO_CHF
  const isForeign = line.currency !== 'CHF'
  const rateMonthText = monthLabel(chf.rateMonth ?? line.date.slice(0, 7))
  const facts: Fact[] = []
  if (isForeign) {
    const rateMonth = chf.rateMonth ?? line.date.slice(0, 7)
    const noRate = chf.rateStatus === 'missing' || chf.rateStatus === 'pending'
    const pending = chf.rateStatus === 'pending'
    facts.push({
      id: 'rate',
      term: t.rate,
      value: noRate ? (
        <span
          className="flex flex-col items-start gap-1"
          data-testid={`classification-${line.lineId}-rate-${pending ? 'pending' : 'missing'}`}
        >
          <StatusBadge status={RATE_MISSING_MEANING}>{pending ? t.ratePending : t.rateNotYet}</StatusBadge>
          <span className="text-xs text-soft">
            {pending ? t.ratePendingHelp(line.currency, rateMonthText) : t.rateNotYetHelp(line.currency, rateMonthText)}
          </span>
          {canOpenRates ? (
            <a href={accountingRatesHref(rateMonth)} className="link text-xs" data-testid={`classification-${line.lineId}-open-rates`}>
              {t.openRates}
            </a>
          ) : (
            <span className="text-xs text-soft" data-testid={`classification-${line.lineId}-ask-manager`}>
              {t.askManager}
            </span>
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
  // The VAT amount exists only with a code (AC-3.8): without one the fact says so and shows no figure, whatever the
  // server sent. With a code but no amount (the CHF amount is unknown) it is "—", never 0.
  const vatAmount =
    classification.vatCode === null
      ? t.vatAmountNone
      : line.vatAmountCents === null
        ? t.unavailable
        : isForeign
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
    // The suffix names what Accounting says; `unverified` (and, when it cannot be read, anything) claims nothing.
    const valueText = (text: string | null, marked: boolean | null, state: EntryState, none: string = t.unavailable) =>
      text === null ? (
        none
      ) : (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span>
            {accountingUnavailable
              ? text
              : state === 'deactivated'
                ? t.inactiveOption(text)
                : state === 'not_found'
                  ? t.notFoundOption(text)
                  : text}
          </span>
          {marked !== null && marker(marked)}
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
                classification.account?.state ?? 'active',
              ),
            },
            {
              id: 'vatCode',
              term: t.vatCode,
              value: valueText(
                classification.vatCode ? vatCodeText(classification.vatCode) : null,
                null,
                classification.vatCode?.state ?? 'active',
                t.vatNone,
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
          {locked
            ? t.locked
            : ownRequest && canChange
              ? t.selfRestricted
              : accountingUnavailable && canChange
                ? t.accountingUnavailableLine
                : t.readOnly}
        </p>
        {state === 'post_approval' && !accountingUnavailable && <p className="text-xs text-soft">{t.frozen}</p>}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Editable
  // ---------------------------------------------------------------------------

  const shown = (field: FieldName, saved: string): string => (pending?.field === field ? pending.value : saved)
  const selectsLocked = options === null

  // A default that cannot be used any more is "missing", with its reason; any other stored value stays as it is.
  const accountDefaultGone = isUnusableDefault(classification.account, classification.accountIsDefault, state)
  const accountRef = accountDefaultGone ? null : classification.account
  // The VAT code is a hand copy or none, never a default: whatever is stored stays, as it is.
  const vatRef = classification.vatCode
  const accountOptions = options?.ledgerAccounts ?? []
  const vatOptions = options?.vatCodes ?? []

  const fieldHint = (field: FieldName) => {
    if (pending?.field === field) return t.saving
    if (field === 'vatCode') {
      // No marker and no "required": only a stored copy that Accounting has since deactivated or lost is worth a word.
      if (vatRef === null || (vatRef.state !== 'deactivated' && vatRef.state !== 'not_found')) return undefined
      return vatRef.state === 'deactivated' ? t.inactiveCurrentVat : t.notFoundCurrentVat
    }
    if (accountRef === null) {
      const unusable = classification.account
      if (!accountDefaultGone || unusable === null) return t.required
      return unusable.state === 'not_found'
        ? t.defaultNotFound(t.defaultWhat.account)
        : t.defaultDeactivated(t.defaultWhat.account)
    }
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {marker(classification.accountIsDefault)}
        {accountRef.state === 'deactivated' && <span>{t.inactiveCurrentAccount}</span>}
        {accountRef.state === 'not_found' && <span>{t.notFoundCurrentAccount}</span>}
      </span>
    )
  }

  const fieldError = (field: FieldName): string | undefined => {
    if (errorMessage?.field === field) return errorMessage.text
    if (field === 'account' && missing?.account && accountRef === null) return t.missingAccount
    return undefined
  }

  const accountValue = shown('account', accountRef?.number ?? '')
  const vatValue = shown('vatCode', vatRef?.code ?? CATALOG_NONE)

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
              noneLabel={t.vatNone}
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
      {state === 'post_approval' && <p className="text-xs text-soft">{t.frozen}</p>}
    </fieldset>
  )
}
