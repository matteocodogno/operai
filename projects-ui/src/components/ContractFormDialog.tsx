import { useRef, useState } from 'react'
import { Button, DateInput, Field, FormDialog, focusFirstInvalid } from '@operai/ui'
import { ApiError, isStaleWrite } from '../lib/api'
import { emptyTermsForm, termsFormOf, termsInputOf } from '../lib/contractTerms'
import type { PositionForm, TermsErrors, TermsForm } from '../lib/contractTerms'
import { MAX_POSITIONS } from '../lib/contractTerms'
import { codeOf, errorMessage, fieldErrorOf } from '../lib/errors'
import { createContract, updateContract } from '../lib/projectsApi'
import type { CompanyChoice, CompanyRef, Contract, HourPackageKind, Project } from '../lib/types'
import { strings } from '../strings'
import CompanyPicker from './CompanyPicker'

type ProjectRef = Pick<Project, 'id' | 'type' | 'company'>

const HOUR_KINDS: readonly HourPackageKind[] = ['capacity', 'yearly']

/** Server `code`s that belong to one input, by the input's error key. */
const REFUSAL_FIELD: Record<string, string> = {
  company_mismatch: 'companyId',
  company_required: 'companyId',
  company_not_found: 'companyId',
  maintenance_needs_sla_or_hours: 'terms',
}
/** Server `code`s that are about the dialog as a whole. */
const DIALOG_REFUSALS = ['contracts_not_allowed', 'project_not_open', 'crm_unavailable', 'out_of_scope'] as const

const isFieldKey = (field: string): boolean =>
  field === 'startDate' ||
  field === 'endDate' ||
  field === 'companyId' ||
  field === 'terms' ||
  field.startsWith('terms.')

/**
 * ContractFormDialog — add a contract to a project, or edit one (AC-2.1 – AC-2.8).
 * The contract's type is the project's (never chosen), and the fields are that
 * type's: fixed price (deadline, estimated man-days, max effort), maintenance and
 * SaaS (an optional SLA, prefilled 1 / 3, and an optional hour package; a
 * maintenance contract needs one of the two), time and material (1 to 50
 * positions). A client project's company is its own; a SaaS takes any CRM company
 * when the contract is created. No amount, price or rate exists in the form
 * (AC-2.9).
 *
 * Errors are keyed by the server's dotted field names (lib/contractTerms.ts), so
 * a check made here and a 400/422 from the server land on the same input.
 * Editing sends the dates and the whole `terms` with the contract's `version` as
 * If-Match; a stale save closes the dialog and is the page's (`onStale`).
 */
export default function ContractFormDialog({
  project,
  contract,
  onSaved,
  onCancel,
  onStale,
}: {
  project: ProjectRef
  contract?: Contract
  onSaved: (contract: Contract) => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.contracts.form
  const editing = contract !== undefined
  const type = contract?.type ?? project.type
  const initialTerms = contract ? termsFormOf(contract) : emptyTermsForm(type)

  const [startDate, setStartDate] = useState(contract?.startDate ?? '')
  const [endDate, setEndDate] = useState(contract?.endDate ?? '')
  const [company, setCompany] = useState<CompanyChoice | null>(null)
  const [terms, setTerms] = useState<TermsForm>(initialTerms)
  const [errors, setErrors] = useState<TermsErrors>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)
  const [initial] = useState(() => JSON.stringify([contract?.startDate ?? '', contract?.endDate ?? '', initialTerms]))

  const dirty = JSON.stringify([startDate, endDate, terms]) !== initial
  const pickCompany = !editing && type === 'saas'
  const ownCompany: CompanyRef | null = contract?.company ?? project.company

  const patchTerms = (patch: Partial<TermsForm>) => setTerms((current) => ({ ...current, ...patch }))

  const validate = (): { errors: TermsErrors; input: ReturnType<typeof termsInputOf>['input'] } => {
    const found: TermsErrors = {}
    if (startDate === '') found['startDate'] = strings.common.validation.required
    if (endDate !== '' && startDate !== '' && endDate < startDate)
      found['endDate'] = strings.contracts.errors.endBeforeStart
    if (pickCompany && company === null) found['companyId'] = t.companyRequired
    const checked = termsInputOf(type, terms)
    return { errors: { ...found, ...checked.errors }, input: checked.input }
  }

  const submit = () => {
    const checked = validate()
    setErrors(checked.errors)
    if (Object.keys(checked.errors).length > 0) {
      requestAnimationFrame(() => focusFirstInvalid(fieldsRef.current))
      return
    }
    setBusy(true)
    setError(null)
    const request = contract
      ? updateContract(project.id, contract.id, contract.version, {
          startDate,
          endDate: endDate === '' ? null : endDate,
          terms: checked.input,
        })
      : createContract(project.id, {
          ...(pickCompany && company ? { companyId: company.id } : {}),
          startDate,
          ...(endDate !== '' ? { endDate } : {}),
          terms: checked.input,
        })
    request.then(onSaved, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      const code = codeOf(failure)
      const known = strings.contracts.errors
      const refusalField = code ? REFUSAL_FIELD[code] : undefined
      if (code && refusalField) return setErrors({ [refusalField]: known[code as keyof typeof known] as string })
      if (code && (DIALOG_REFUSALS as readonly string[]).includes(code)) {
        return setError(known[code as (typeof DIALOG_REFUSALS)[number]])
      }
      if (failure instanceof ApiError && failure.status === 503) {
        return setError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
      }
      const named = fieldErrorOf(failure)
      if (named && isFieldKey(named.field)) return setErrors({ [named.field]: named.message })
      setError(errorMessage(failure))
    })
  }

  const dateField = (
    name: 'startDate' | 'endDate',
    label: string,
    value: string,
    onChange: (value: string) => void,
    hint?: string,
    required = false,
  ) => (
    <Field label={label} hint={hint} required={required} error={errors[name]} testId={`contract-form-${name}`}>
      {(control) => <DateInput {...control} value={value} onChange={(event) => onChange(event.target.value)} />}
    </Field>
  )

  return (
    <FormDialog
      title={editing ? t.editTitle : t.createTitle}
      submitLabel={editing ? t.save : t.create}
      busyLabel={editing ? t.saving : t.creating}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={!editing || dirty}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      size="lg"
      testIdPrefix="contract-form"
    >
      <div ref={fieldsRef} className="contents">
        {pickCompany ? (
          <CompanyPicker
            label={t.company}
            hint={t.companyHint}
            value={company}
            onChange={setCompany}
            error={errors['companyId']}
            required
            testId="contract-form-company"
          />
        ) : (
          <Field label={t.company} hint={editing ? undefined : t.companyOwn} error={errors['companyId']}>
            {(control) => (
              <input {...control} value={ownCompany?.name ?? strings.contracts.card.companyUnavailable} readOnly />
            )}
          </Field>
        )}
        {dateField(
          'startDate',
          t.startDate,
          startDate,
          setStartDate,
          type === 'saas' ? t.saasPeriodHint : undefined,
          true,
        )}
        {dateField('endDate', t.endDate, endDate, setEndDate, t.endDateHint)}

        {type === 'fixed_price' && <FixedPriceFields terms={terms} errors={errors} onChange={patchTerms} />}
        {(type === 'maintenance' || type === 'saas') && (
          <SlaAndHoursFields terms={terms} errors={errors} onChange={patchTerms} />
        )}
        {type === 't_and_m' && <PositionFields terms={terms} errors={errors} onChange={patchTerms} />}
      </div>
    </FormDialog>
  )
}

type FieldsProps = { terms: TermsForm; errors: TermsErrors; onChange: (patch: Partial<TermsForm>) => void }

function FixedPriceFields({ terms, errors, onChange }: FieldsProps) {
  const t = strings.contracts.form
  return (
    <>
      <Field label={t.deadline} required error={errors['terms.deadline']} testId="contract-form-deadline">
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
        hint={t.estimatedManDaysHint}
        error={errors['terms.estimatedManDays']}
        testId="contract-form-estimated"
      >
        {(control) => (
          <input
            {...control}
            inputMode="decimal"
            value={terms.estimatedManDays}
            onChange={(event) => onChange({ estimatedManDays: event.target.value })}
          />
        )}
      </Field>
      <Field
        label={t.maxEffortManDays}
        hint={t.maxEffortManDaysHint}
        required
        error={errors['terms.maxEffortManDays']}
        testId="contract-form-max-effort"
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

function SlaAndHoursFields({ terms, errors, onChange }: FieldsProps) {
  const t = strings.contracts.form
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
        <fieldset className="flex flex-col gap-3" data-testid="contract-form-sla">
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
        <fieldset className="flex flex-col gap-3" data-testid="contract-form-hours">
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
        <p role="alert" className="field-error" data-testid="contract-form-terms-error">
          {errors['terms']}
        </p>
      )}
    </>
  )
}

function PositionFields({ terms, errors, onChange }: FieldsProps) {
  const t = strings.contracts.form
  const positions = terms.positions
  const set = (index: number, patch: Partial<PositionForm>) =>
    onChange({ positions: positions.map((position, i) => (i === index ? { ...position, ...patch } : position)) })
  return (
    <fieldset className="flex flex-col gap-3" data-testid="contract-form-positions">
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
