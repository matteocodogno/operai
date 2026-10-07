import { useId, useState } from 'react'
import IrreversibleActionDialog from './IrreversibleActionDialog'
import { ApiError } from '../lib/api'
import { formatDate } from '../lib/dates'
import { amountToCents, formatMoney } from '../lib/money'
import { createRule } from '../lib/rulesApi'
import { toInventoryError, validationField } from '../lib/types'
import type { Currency, Entity, FirstYearShare, Rule, RuleInput } from '../lib/types'
import { strings } from '../strings'
import { fillTemplate } from '../strings/errors'

/**
 * NewRuleDialog — "New rule for {entity}" (T37, specs/015-hardware-inventory;
 * design.md F11, § Irreversible actions "New rule", § Error and conflict
 * catalogue; AC-6.2, AC-6.3, AC-6.4, AC-6.5): an `IrreversibleActionDialog` whose
 * form holds the effective date, the useful life (whole years, at least 1), the
 * first-year share (Full / Half), the optional low-value threshold and the
 * residual value, with the rule now in force shown beside it for comparison.
 *
 * The consequence states what the server will do: from the date, every asset of
 * the entity purchased on or after it — including assets already registered — is
 * rescheduled by this rule; earlier ones keep their schedule; a saved rule can
 * never be edited or deleted. Saving needs the acknowledgement (Confirm is
 * disabled until it is ticked).
 *
 * The shared dialog cannot disable Confirm for an invalid form, so the form is
 * validated on Confirm, with a message naming the field and nothing sent
 * (AC-6.4). Money is parsed to integer cents by `amountToCents` (a negative or
 * three-decimal value is invalid); this component never computes with it. A 422
 * carrying a `field` is shown under that field, `fiscal_year_closed` under the
 * date (AC-6.3); 503 and network failures keep the dialog open with every typed
 * value. On success the saved rule goes to the page, which closes the dialog.
 */

export type NewRuleDialogProps = {
  entity: Entity
  /** The rule currently in force, shown beside the form; null when the entity has none. */
  inForceRule: Rule | null
  onSaved: (rule: Rule) => void
  onCancel: () => void
}

type FieldKey = 'date' | 'life' | 'share' | 'threshold' | 'residual'
type FieldErrors = Partial<Record<FieldKey, string>>

/** Server field names (plan.md `RuleInput`) -> form fields. */
const SERVER_FIELDS: Record<string, FieldKey> = {
  effectiveFrom: 'date',
  usefulLifeYears: 'life',
  firstYearShare: 'share',
  lowValueThresholdCents: 'threshold',
  residualCents: 'residual',
}

/** AC-1.2: CHF for `welld_ch`, EUR for `welld_it`. Display only. */
const CURRENCY_OF: Record<Entity, Currency> = { welld_ch: 'CHF', welld_it: 'EUR' }
const SHARES: readonly FirstYearShare[] = ['full', 'half']
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const unavailable = `${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`

export default function NewRuleDialog({ entity, inForceRule, onSaved, onCancel }: NewRuleDialogProps) {
  const t = strings.rules.dialog
  const baseId = useId()
  const currency = CURRENCY_OF[entity]
  const entityName = strings.common.entity[entity]
  const [date, setDate] = useState('')
  const [life, setLife] = useState('')
  const [share, setShare] = useState<FirstYearShare | ''>('')
  const [threshold, setThreshold] = useState('')
  const [residual, setResidual] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const clear = (key: FieldKey) =>
    setErrors((previous) => {
      if (previous[key] === undefined) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })

  const fieldMessage = (key: FieldKey): string => {
    switch (key) {
      case 'date':
        return t.errors.dateInvalid
      case 'life':
        return t.errors.lifeInvalid
      case 'share':
        return t.errors.shareRequired
      case 'threshold':
        return t.errors.thresholdInvalid
      case 'residual':
        return t.errors.residualInvalid
    }
  }

  /** The request body, or the per-field errors; nothing is sent while any exists. */
  const parse = (): { input: RuleInput } | { errors: FieldErrors } => {
    const found: FieldErrors = {}
    if (date === '') found.date = t.errors.dateRequired
    else if (!DATE_ONLY.test(date)) found.date = t.errors.dateInvalid

    const lifeYears = /^\d+$/.test(life.trim()) ? Number(life.trim()) : null
    if (lifeYears === null || lifeYears < 1) found.life = t.errors.lifeInvalid
    if (share === '') found.share = t.errors.shareRequired

    const thresholdCents = threshold.trim() === '' ? null : amountToCents(threshold)
    if (threshold.trim() !== '' && thresholdCents === null) found.threshold = t.errors.thresholdInvalid
    const residualCents = amountToCents(residual)
    if (residualCents === null) found.residual = t.errors.residualInvalid

    if (Object.keys(found).length > 0 || lifeYears === null || share === '' || residualCents === null) {
      return { errors: found }
    }
    return {
      input: {
        entity,
        effectiveFrom: date,
        usefulLifeYears: lifeYears,
        firstYearShare: share,
        lowValueThresholdCents: thresholdCents,
        residualCents,
      },
    }
  }

  const fail = (error: unknown) => {
    const known = toInventoryError(error)
    if (known?.code === 'fiscal_year_closed') {
      const year = known.extras.year
      return setErrors({
        date:
          year === undefined
            ? t.errors.yearClosedNoYear
            : fillTemplate(strings.errors.fiscal_year_closed, { year, entity: entityName }),
      })
    }
    if (error instanceof ApiError) {
      if (error.status === 422) {
        const key = SERVER_FIELDS[validationField(error) ?? '']
        if (key !== undefined) return setErrors({ [key]: fieldMessage(key) })
        return setGeneralError(strings.errors.validation)
      }
      if (error.status === 503) return setGeneralError(unavailable)
      return setGeneralError(error.detail ?? strings.errors.unknown)
    }
    return setGeneralError(strings.errors.network)
  }

  const submit = async () => {
    setGeneralError(null)
    const parsed = parse()
    if ('errors' in parsed) return setErrors(parsed.errors)
    setErrors({})
    setSubmitting(true)
    try {
      onSaved(await createRule(parsed.input))
    } catch (error) {
      fail(error)
    } finally {
      setSubmitting(false)
    }
  }

  const money = (cents: number) => formatMoney(cents, currency)
  const inForceSummary =
    inForceRule === null
      ? null
      : strings.rules.dialog.inForce(
          t.inForceSummary(
            inForceRule.usefulLifeYears,
            t.inForceShare[inForceRule.firstYearShare],
            inForceRule.lowValueThresholdCents === null
              ? t.inForceNoThreshold
              : t.inForceThreshold(money(inForceRule.lowValueThresholdCents)),
            money(inForceRule.residualCents),
          ),
          formatDate(inForceRule.effectiveFrom),
        )

  const ids = {
    date: `${baseId}-date`,
    life: `${baseId}-life`,
    share: `${baseId}-share`,
    threshold: `${baseId}-threshold`,
    residual: `${baseId}-residual`,
  }
  const inputClass = 'border px-2 py-1.5 text-sm w-full'
  const inputStyle = { borderColor: 'var(--rule)', backgroundColor: 'var(--ink)', color: 'var(--text)' }
  const labelStyle = { color: 'var(--soft)' }
  const describe = (key: FieldKey) => (errors[key] !== undefined ? `${ids[key]}-error` : undefined)
  const invalid = (key: FieldKey) => (errors[key] !== undefined ? true : undefined)
  const errorText = (key: FieldKey) =>
    errors[key] === undefined ? null : (
      <p id={`${ids[key]}-error`} className="text-xs" style={{ color: 'var(--red)' }}>
        {errors[key]}
      </p>
    )

  return (
    <IrreversibleActionDialog
      title={t.title(entityName)}
      consequence={t.consequence(entityName, date === '' || !DATE_ONLY.test(date) ? t.dateUnset : formatDate(date))}
      acknowledgeLabel={t.acknowledge}
      confirmLabel={t.confirm}
      confirmingLabel={t.confirming}
      isConfirming={submitting}
      errorMessage={generalError}
      onConfirm={() => void submit()}
      onCancel={onCancel}
      testIdPrefix="new-rule"
    >
      {inForceSummary !== null && (
        <p data-testid="new-rule-in-force" className="text-xs" style={labelStyle}>
          {inForceSummary}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.date} className="text-xs" style={labelStyle}>
          {t.fields.effectiveFrom} ({t.required})
        </label>
        <input
          id={ids.date}
          type="date"
          value={date}
          aria-required="true"
          aria-invalid={invalid('date')}
          aria-describedby={describe('date')}
          onChange={(event) => {
            setDate(event.target.value)
            clear('date')
          }}
          className={inputClass}
          style={inputStyle}
        />
        {errorText('date')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.life} className="text-xs" style={labelStyle}>
          {t.fields.usefulLife} ({t.required})
        </label>
        <input
          id={ids.life}
          inputMode="numeric"
          value={life}
          aria-required="true"
          aria-invalid={invalid('life')}
          aria-describedby={describe('life')}
          onChange={(event) => {
            setLife(event.target.value)
            clear('life')
          }}
          className={inputClass}
          style={inputStyle}
        />
        {errorText('life')}
      </div>

      <div
        role="radiogroup"
        aria-labelledby={`${ids.share}-label`}
        aria-describedby={describe('share')}
        className="flex flex-col gap-1"
      >
        <span id={`${ids.share}-label`} className="text-xs" style={labelStyle}>
          {t.fields.firstYearShare} ({t.required})
        </span>
        {SHARES.map((value) => (
          <label key={value} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
            <input
              type="radio"
              name={ids.share}
              value={value}
              checked={share === value}
              onChange={() => {
                setShare(value)
                clear('share')
              }}
            />
            {strings.rules.firstYearShare[value]}
          </label>
        ))}
        {errorText('share')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.threshold} className="text-xs" style={labelStyle}>
          {t.fields.thresholdIn(currency)} ({t.optional})
        </label>
        <input
          id={ids.threshold}
          inputMode="decimal"
          value={threshold}
          aria-invalid={invalid('threshold')}
          aria-describedby={describe('threshold')}
          onChange={(event) => {
            setThreshold(event.target.value)
            clear('threshold')
          }}
          className={inputClass}
          style={inputStyle}
        />
        {errorText('threshold')}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={ids.residual} className="text-xs" style={labelStyle}>
          {t.fields.residualIn(currency)} ({t.required})
        </label>
        <input
          id={ids.residual}
          inputMode="decimal"
          value={residual}
          aria-required="true"
          aria-invalid={invalid('residual')}
          aria-describedby={describe('residual')}
          onChange={(event) => {
            setResidual(event.target.value)
            clear('residual')
          }}
          className={inputClass}
          style={inputStyle}
        />
        {errorText('residual')}
      </div>
    </IrreversibleActionDialog>
  )
}
