import { useId, useRef, useState } from 'react'
import { Button, Field, FormDialog, Icon, focusFirstInvalid } from '@operai/ui'
import { useScope } from '../hooks/useScope'
import { useSession } from 'shell/session'
import { ApiError, isStaleWrite } from '../lib/api'
import { ENTITIES, PROJECT_TYPES, isClientType } from '../lib/domain'
import { errorMessage, fieldErrorOf } from '../lib/errors'
import { termsErrorKeysChanged, withoutErrors } from '../lib/fieldErrors'
import { createProject } from '../lib/projectsApi'
import type { CreateProjectInput } from '../lib/projectsApi'
import { emptyTermsForm } from '../lib/terms'
import type { TermsErrors, TermsForm } from '../lib/terms'
import { termsFieldKey, termsRequestOf } from '../lib/termsRequest'
import type { CompanyChoice, Entity, Project, ProjectType } from '../lib/types'
import { first, hasErrors, maxLength, required } from '../lib/validate'
import { strings } from '../strings'
import CompanyPicker from './CompanyPicker'
import PersonPicker from './PersonPicker'
import type { PersonChoice } from './PersonPicker'
import TermsFields, { TermsDateFields } from './TermsFields'

type FieldName = 'name' | 'type' | 'entity' | 'company' | 'projectManager'

/** The input a server refusal names, by the member name projects-api puts in `field`. */
const FIELD_OF: Record<string, FieldName> = {
  name: 'name',
  type: 'type',
  entity: 'entity',
  companyId: 'company',
  projectManagerId: 'projectManager',
}

const REFUSAL_FIELD = {
  not_project_user: 'projectManager',
  out_of_scope: 'entity',
  company_required: 'company',
  company_not_allowed: 'company',
  company_not_found: 'company',
} as const satisfies Record<string, FieldName>

type Refusal = keyof typeof REFUSAL_FIELD
const isRefusal = (code: string | undefined): code is Refusal => code !== undefined && code in REFUSAL_FIELD

/**
 * ProjectFormDialog — create a project by hand (AC-1.1; specs/022 AC-5.1, AC-5.3): name, any of the five
 * types, wellD entity, the company of a client type, and the project manager (the caller by default). A
 * project made this way never has a purchase order (AC-5.2): nothing of one is in this form.
 *
 * The entity choices are the ones the caller manages (`GET /scope`): an
 * entity-scoped project manager sees only theirs, preselected (AC-4.4); the
 * server's 403 `out_of_scope` stays the gate. The company field exists for every
 * type but `internal` — `saas` included (D40) — and is dropped from the
 * request when the type changes to `internal`. Entity, company and type are
 * fixed once the project exists, which the hints say.
 *
 * The terms are an optional section, collapsed by default (AC-5.3, A38): "Terms (optional)" opens the
 * dates and the fields of the chosen type (`TermsFields`), and from then on the type's rules apply in full
 * before any request (`lib/terms.ts`) — a project is created with no terms or with a valid set, never a
 * half one. Closing the section again drops the terms from the request, whatever was typed in it.
 * `internal` has no terms, so no section. The request carries them as
 * `terms: { startDate, endDate?, terms: <the type's members> }`.
 *
 * Errors: a refusal that names an input lands on it (own copy per code, so it reads in the person's
 * language); a 400/422 naming a member — or a field of the terms, by its `terms.…` path — lands on that
 * input; anything else is the dialog's inline alert with every value kept. A create has no precondition,
 * so it cannot be stale.
 */
export default function ProjectFormDialog({
  onSaved,
  onCancel,
}: {
  onSaved: (project: Project) => void
  onCancel: () => void
}) {
  const t = strings.projects.form
  const { manage, canManageEntity } = useScope()
  const session = useSession()
  const currentUser = session.data?.user
  const entities = ENTITIES.filter(canManageEntity)
  const termsPanelId = useId()

  const [name, setName] = useState('')
  const [type, setType] = useState<ProjectType | ''>('')
  const [entity, setEntity] = useState<Entity | ''>(manage.length === 1 ? (manage[0] ?? '') : '')
  const [company, setCompany] = useState<CompanyChoice | null>(null)
  // `undefined` = untouched: the project manager is the caller (AC-1.1).
  const [pickedManager, setPickedManager] = useState<PersonChoice | null | undefined>(undefined)
  const [termsOpen, setTermsOpen] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [terms, setTerms] = useState<TermsForm>(() => emptyTermsForm('internal'))
  const [errors, setErrors] = useState<TermsErrors>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)

  const callerChoice: PersonChoice | null = currentUser?.id
    ? { id: currentUser.id, label: currentUser.name ?? currentUser.email ?? strings.people.you }
    : null
  const manager = pickedManager === undefined ? callerChoice : pickedManager
  const needsCompany = type !== '' && isClientType(type)
  // `internal` has no terms, and until a type is chosen there are none to ask.
  const hasTerms = type !== '' && type !== 'internal'

  const validate = (): TermsErrors => ({
    name: first(required(name), maxLength(name, 200)) ?? '',
    type: type === '' ? strings.common.validation.required : '',
    entity: entity === '' ? strings.common.validation.required : '',
    company: needsCompany && company === null ? t.companyRequired : '',
    projectManager: manager === null ? strings.people.picker.pickRequired : '',
  })

  // An error is about the value it was raised on: when that value changes, the message goes (QE D2). The
  // next submit checks everything again.
  const clearErrors = (...fields: string[]) => setErrors((current) => withoutErrors(current, ...fields))
  const patchTerms = (patch: Partial<TermsForm>) => {
    const next = { ...terms, ...patch }
    setTerms(next)
    clearErrors(...termsErrorKeysChanged(terms, next))
  }

  // An error that names an input lands on it, and the first invalid input takes the focus.
  const refuseField = (field: string, message: string) => {
    setErrors({ [field]: message })
    requestAnimationFrame(() => focusFirstInvalid(fieldsRef.current))
  }

  const submit = () => {
    // The terms are checked, and sent, only while their section is open (AC-5.3).
    const request =
      termsOpen && hasTerms ? termsRequestOf(type, { startDate, endDate, terms }, { estimateBacked: false }) : null
    const found = { ...validate(), ...request?.errors }
    setErrors(found)
    if (hasErrors(found)) {
      requestAnimationFrame(() => focusFirstInvalid(fieldsRef.current))
      return
    }
    const input: CreateProjectInput = {
      name: name.trim(),
      type: type as ProjectType,
      entity: entity as Entity,
      ...(needsCompany && company ? { companyId: company.id } : {}),
      ...(manager && manager.id !== currentUser?.id ? { projectManagerId: manager.id } : {}),
      ...(request ? { terms: request.input } : {}),
    }
    setBusy(true)
    setError(null)
    createProject(input).then(onSaved, (failure: unknown) => {
      setBusy(false)
      const code = failure instanceof ApiError ? failure.code : undefined
      if (isRefusal(code)) return refuseField(REFUSAL_FIELD[code], t.errors[code])
      if (code === 'terms_not_allowed') return setError(t.errors.terms_not_allowed)
      if (code === 'maintenance_needs_sla_or_hours' && request) {
        return refuseField('terms', strings.terms.refusals.maintenance_needs_sla_or_hours)
      }
      if (code === 'crm_unavailable') return setError(t.errors.crm_unavailable)
      if (failure instanceof ApiError && failure.status === 503) {
        return setError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
      }
      const named = fieldErrorOf(failure)
      // A create wraps the terms input under `terms`: `terms.startDate`, `terms.terms.deadline`. Only a
      // request that carried the terms can name one of their fields.
      const field = named ? (FIELD_OF[named.field] ?? (request ? termsFieldKey(named.field, 'nested') : null)) : null
      if (named && field) return refuseField(field, named.message)
      // A create takes no If-Match, so a stale write cannot happen here; treat it as any other failure.
      setError(isStaleWrite(failure) ? strings.common.saveError : errorMessage(failure))
    })
  }

  return (
    <FormDialog
      title={t.createTitle}
      submitLabel={t.create}
      busyLabel={t.creating}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      size="lg"
      testIdPrefix="projects-form"
    >
      <div ref={fieldsRef} className="contents">
        <Field label={t.name} required error={errors['name']} testId="projects-form-name">
          {(control) => (
            <input
              {...control}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                clearErrors('name')
              }}
            />
          )}
        </Field>
        <Field label={t.type} hint={t.typeHint} required error={errors['type']} testId="projects-form-type">
          {(control) => (
            <select
              {...control}
              value={type}
              onChange={(event) => {
                const next = event.target.value as ProjectType | ''
                setType(next)
                clearErrors('type')
                if (next === '' || !isClientType(next)) {
                  setCompany(null)
                  clearErrors('company')
                }
                // The members are the type's: a form of another type's terms is not carried over (the dates are).
                setTerms(emptyTermsForm(next === '' ? 'internal' : next))
                clearErrors('terms', 'terms.*')
              }}
            >
              <option value="">{strings.common.choose}</option>
              {PROJECT_TYPES.map((option) => (
                <option key={option} value={option}>
                  {strings.badges.projectType[option]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t.entity} hint={t.entityHint} required error={errors['entity']} testId="projects-form-entity">
          {(control) => (
            <select
              {...control}
              value={entity}
              onChange={(event) => {
                setEntity(event.target.value as Entity | '')
                clearErrors('entity')
              }}
            >
              {entities.length !== 1 && <option value="">{strings.common.choose}</option>}
              {entities.map((option) => (
                <option key={option} value={option}>
                  {strings.badges.entity[option]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {needsCompany && (
          <CompanyPicker
            label={t.company}
            hint={t.companyHint}
            value={company}
            onChange={(choice) => {
              setCompany(choice)
              clearErrors('company')
            }}
            error={errors['company']}
            required
            testId="projects-form-company"
          />
        )}
        <PersonPicker
          label={t.projectManager}
          hint={t.projectManagerHint}
          value={manager}
          onChange={(choice) => {
            setPickedManager(choice)
            clearErrors('projectManager')
          }}
          error={errors['projectManager']}
          required
          forbiddenHint={t.projectManagerReadOnlyHint}
          testId="projects-form-manager"
        />
        {hasTerms && (
          <div className="flex flex-col gap-3 border-t border-rule pt-3" data-testid="projects-form-terms">
            <div>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={termsOpen}
                aria-controls={termsOpen ? termsPanelId : undefined}
                onClick={() => setTermsOpen((open) => !open)}
                data-testid="projects-form-terms-toggle"
              >
                <Icon name={termsOpen ? 'chevron-down' : 'chevron-right'} />
                {t.terms.toggle}
              </Button>
            </div>
            {termsOpen && (
              <div id={termsPanelId} className="flex flex-col gap-3">
                <p className="field-hint">{t.terms.hint}</p>
                {type === 'saas' && <p className="field-hint">{strings.terms.form.saasPeriodHint}</p>}
                <TermsDateFields
                  startDate={startDate}
                  endDate={endDate}
                  errors={errors}
                  onStartDateChange={(value) => {
                    setStartDate(value)
                    // An end before the start is raised on the end date, and a new start may settle it.
                    clearErrors('startDate', 'endDate')
                  }}
                  onEndDateChange={(value) => {
                    setEndDate(value)
                    clearErrors('endDate')
                  }}
                  testIdPrefix="projects-form-terms"
                />
                <TermsFields
                  type={type}
                  terms={terms}
                  errors={errors}
                  onChange={patchTerms}
                  testIdPrefix="projects-form-terms"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </FormDialog>
  )
}
