import { Button, DateInput, Field } from '@operai/ui'
import { MAX_POSITIONS } from '../lib/terms'
import type { PositionForm, TermsErrors, TermsForm } from '../lib/terms'
import type { HourPackageKind, ProjectType } from '../lib/types'
import { strings } from '../strings'

const HOUR_KINDS: readonly HourPackageKind[] = ['capacity', 'yearly']

type Props = {
  terms: TermsForm
  errors: TermsErrors
  onChange: (patch: Partial<TermsForm>) => void
  /** Prefix of the fields' `data-testid`s: `${testIdPrefix}-deadline`, `-estimated`, `-sla`, … */
  testIdPrefix: string
}

/**
 * TermsFields — the terms inputs of a project, by its type (specs/021
 * AC-2.3 – AC-2.8): fixed price (deadline, estimated man-days, max effort),
 * maintenance and SaaS (an optional SLA, prefilled 1 / 3, and an optional hour
 * package; maintenance terms need one of the two), time and material (1 to
 * 50 positions), nothing for `internal`. Shared by the terms form (terms of a
 * hand-made project, or edited) and the take of a deal (specs/022). The
 * caller owns the form state and the checks (`lib/terms.ts`); errors are
 * keyed by the server's dotted field names.
 *
 * `estimatedManDaysReadOnly`: terms made from a deal with an estimate take
 * their man-days from the estimate and cannot be given them (AC-3.1); the input is
 * replaced by this text, read-only.
 */
export default function TermsFields({
  type,
  estimatedManDaysReadOnly,
  ...props
}: Props & { type: ProjectType; estimatedManDaysReadOnly?: string }) {
  if (type === 'fixed_price') return <FixedPriceFields {...props} estimatedReadOnly={estimatedManDaysReadOnly} />
  if (type === 'maintenance' || type === 'saas') return <SlaAndHoursFields {...props} />
  if (type === 't_and_m') return <PositionFields {...props} />
  return null
}

/** The start and end date of terms, as a take and the terms form ask them. */
export function TermsDateFields({
  startDate,
  endDate,
  errors,
  onStartDateChange,
  onEndDateChange,
  testIdPrefix,
}: {
  startDate: string
  endDate: string
  errors: TermsErrors
  onStartDateChange: (value: string) => void
  onEndDateChange: (value: string) => void
  testIdPrefix: string
}) {
  const t = strings.terms.form
  return (
    <>
      <Field label={t.startDate} required error={errors['startDate']} testId={`${testIdPrefix}-startDate`}>
        {(control) => (
          <DateInput {...control} value={startDate} onChange={(event) => onStartDateChange(event.target.value)} />
        )}
      </Field>
      <Field label={t.endDate} hint={t.endDateHint} error={errors['endDate']} testId={`${testIdPrefix}-endDate`}>
        {(control) => (
          <DateInput {...control} value={endDate} onChange={(event) => onEndDateChange(event.target.value)} />
        )}
      </Field>
    </>
  )
}

function FixedPriceFields({
  terms,
  errors,
  onChange,
  testIdPrefix,
  estimatedReadOnly,
}: Props & { estimatedReadOnly?: string }) {
  const t = strings.terms.form
  return (
    <>
      <Field label={t.deadline} required error={errors['terms.deadline']} testId={`${testIdPrefix}-deadline`}>
        {(control) => (
          <DateInput
            {...control}
            value={terms.deadline}
            onChange={(event) => onChange({ deadline: event.target.value })}
          />
        )}
      </Field>
      <Field
        label={t.estimatedManDays}
        hint={estimatedReadOnly === undefined ? t.estimatedManDaysHint : undefined}
        error={errors['terms.estimatedManDays']}
        testId={`${testIdPrefix}-estimated`}
      >
        {(control) =>
          estimatedReadOnly === undefined ? (
            <input
              {...control}
              inputMode="decimal"
              value={terms.estimatedManDays}
              onChange={(event) => onChange({ estimatedManDays: event.target.value })}
            />
          ) : (
            <input {...control} value={estimatedReadOnly} readOnly />
          )
        }
      </Field>
      <Field
        label={t.maxEffortManDays}
        hint={t.maxEffortManDaysHint}
        required
        error={errors['terms.maxEffortManDays']}
        testId={`${testIdPrefix}-max-effort`}
      >
        {(control) => (
          <input
            {...control}
            inputMode="decimal"
            value={terms.maxEffortManDays}
            onChange={(event) => onChange({ maxEffortManDays: event.target.value })}
          />
        )}
      </Field>
    </>
  )
}

function SlaAndHoursFields({ terms, errors, onChange, testIdPrefix }: Props) {
  const t = strings.terms.form
  const pkg = terms.hourPackage
  const patchPackage = (patch: Partial<TermsForm['hourPackage']>) => onChange({ hourPackage: { ...pkg, ...patch } })
  return (
    <>
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={terms.withSla}
          onChange={(event) => onChange({ withSla: event.target.checked })}
        />
        {t.withSla}
      </label>
      {terms.withSla && (
        <fieldset className="flex flex-col gap-3" data-testid={`${testIdPrefix}-sla`}>
          <legend className="field-label mb-1">{t.slaLegend}</legend>
          <Field label={t.slaHigh} required error={errors['terms.sla.highDays']}>
            {(control) => (
              <input
                {...control}
                inputMode="numeric"
                value={terms.sla.high}
                onChange={(event) => onChange({ sla: { ...terms.sla, high: event.target.value } })}
              />
            )}
          </Field>
          <Field label={t.slaNormal} required error={errors['terms.sla.normalDays']}>
            {(control) => (
              <input
                {...control}
                inputMode="numeric"
                value={terms.sla.normal}
                onChange={(event) => onChange({ sla: { ...terms.sla, normal: event.target.value } })}
              />
            )}
          </Field>
        </fieldset>
      )}
      <label className="flex items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={terms.withHours}
          onChange={(event) => onChange({ withHours: event.target.checked })}
        />
        {t.withHours}
      </label>
      {terms.withHours && (
        <fieldset className="flex flex-col gap-3" data-testid={`${testIdPrefix}-hours`}>
          <legend className="field-label mb-1">{t.hoursLegend}</legend>
          <Field label={t.hours} hint={t.hoursHint} required error={errors['terms.hourPackage.hours']}>
            {(control) => (
              <input
                {...control}
                inputMode="numeric"
                value={pkg.hours}
                onChange={(event) => patchPackage({ hours: event.target.value })}
              />
            )}
          </Field>
          <Field label={t.kind} required error={errors['terms.hourPackage.kind']}>
            {(control) => (
              <select
                {...control}
                value={pkg.kind}
                onChange={(event) => patchPackage({ kind: event.target.value as HourPackageKind })}
              >
                {HOUR_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t.kinds[kind]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t.packageStart} required error={errors['terms.hourPackage.startDate']}>
            {(control) => (
              <DateInput
                {...control}
                value={pkg.startDate}
                onChange={(event) => patchPackage({ startDate: event.target.value })}
              />
            )}
          </Field>
          {pkg.kind === 'capacity' && (
            <Field label={t.packageExpiry} hint={t.packageExpiryHint} error={errors['terms.hourPackage.expiryDate']}>
              {(control) => (
                <DateInput
                  {...control}
                  value={pkg.expiryDate}
                  onChange={(event) => patchPackage({ expiryDate: event.target.value })}
                />
              )}
            </Field>
          )}
        </fieldset>
      )}
      {errors['terms'] && (
        <p role="alert" className="field-error" data-testid={`${testIdPrefix}-terms-error`}>
          {errors['terms']}
        </p>
      )}
    </>
  )
}

function PositionFields({ terms, errors, onChange, testIdPrefix }: Props) {
  const t = strings.terms.form
  const positions = terms.positions
  const set = (index: number, patch: Partial<PositionForm>) =>
    onChange({ positions: positions.map((position, i) => (i === index ? { ...position, ...patch } : position)) })
  return (
    <fieldset className="flex flex-col gap-3" data-testid={`${testIdPrefix}-positions`}>
      <legend className="field-label mb-1">{t.positionsLegend}</legend>
      <p className="field-hint">{t.positionsHint}</p>
      {positions.map((position, index) => (
        <div
          key={index}
          role="group"
          aria-label={t.positionN(index + 1)}
          className="flex flex-col gap-2 border-t border-rule pt-3"
        >
          <p aria-hidden="true" className="text-xs text-soft">
            {t.positionN(index + 1)}
          </p>
          <Field label={t.profile} required error={errors[`terms.positions.${index}.profile`]}>
            {(control) => (
              <input
                {...control}
                value={position.profile}
                onChange={(event) => set(index, { profile: event.target.value })}
              />
            )}
          </Field>
          <Field label={t.plannedManDays} required error={errors[`terms.positions.${index}.plannedManDays`]}>
            {(control) => (
              <input
                {...control}
                inputMode="decimal"
                value={position.plannedManDays}
                onChange={(event) => set(index, { plannedManDays: event.target.value })}
              />
            )}
          </Field>
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={positions.length <= 1}
              aria-label={t.removePosition(index + 1)}
              onClick={() => onChange({ positions: positions.filter((_, i) => i !== index) })}
            >
              {t.removeButton}
            </Button>
          </div>
        </div>
      ))}
      {errors['terms.positions'] && (
        <p role="alert" className="field-error">
          {errors['terms.positions']}
        </p>
      )}
      <div>
        <Button
          size="sm"
          disabled={positions.length >= MAX_POSITIONS}
          onClick={() => onChange({ positions: [...positions, { profile: '', plannedManDays: '' }] })}
        >
          {t.addPosition}
        </Button>
      </div>
    </fieldset>
  )
}
