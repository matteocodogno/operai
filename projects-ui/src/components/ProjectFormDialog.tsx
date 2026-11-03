import { useRef, useState } from 'react'
import { Field, FormDialog, focusFirstInvalid } from '@operai/ui'
import { useScope } from '../hooks/useScope'
import { useSession } from 'shell/session'
import { ApiError, isStaleWrite } from '../lib/api'
import { ENTITIES, PROJECT_TYPES, isClientType } from '../lib/domain'
import { errorMessage, fieldErrorOf } from '../lib/errors'
import { createProject } from '../lib/projectsApi'
import type { CreateProjectInput } from '../lib/projectsApi'
import type { CompanyChoice, Entity, Project, ProjectType } from '../lib/types'
import { first, hasErrors, maxLength, required } from '../lib/validate'
import type { Errors } from '../lib/validate'
import { strings } from '../strings'
import CompanyPicker from './CompanyPicker'
import PersonPicker from './PersonPicker'
import type { PersonChoice } from './PersonPicker'

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
 * ProjectFormDialog — create a project (AC-1.1): name, type, wellD entity, the
 * company of a client type, and the project manager (the caller by default).
 *
 * The entity choices are the ones the caller manages (`GET /scope`): an
 * entity-scoped project manager sees only theirs, preselected (AC-4.4); the
 * server's 403 `out_of_scope` stays the gate. The company field exists only for
 * the client types (T&M, fixed price, maintenance) and is dropped from the
 * request when the type changes to one without. Entity, company and type are
 * fixed once the project exists, which the hints say.
 *
 * Errors: a refusal that names an input lands on it (own copy per code, so it
 * reads in the person's language); a 400/422 naming a member lands on that
 * input; anything else is the dialog's inline alert with every value kept. A
 * create has no precondition, so it cannot be stale.
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

  const [name, setName] = useState('')
  const [type, setType] = useState<ProjectType | ''>('')
  const [entity, setEntity] = useState<Entity | ''>(manage.length === 1 ? (manage[0] ?? '') : '')
  const [company, setCompany] = useState<CompanyChoice | null>(null)
  // `undefined` = untouched: the project manager is the caller (AC-1.1).
  const [pickedManager, setPickedManager] = useState<PersonChoice | null | undefined>(undefined)
  const [errors, setErrors] = useState<Errors<FieldName>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)

  const callerChoice: PersonChoice | null = currentUser?.id
    ? { id: currentUser.id, label: currentUser.name ?? currentUser.email ?? strings.people.you }
    : null
  const manager = pickedManager === undefined ? callerChoice : pickedManager
  const needsCompany = type !== '' && isClientType(type)

  const validate = (): Errors<FieldName> => ({
    name: first(required(name), maxLength(name, 200)) ?? undefined,
    type: type === '' ? strings.common.validation.required : undefined,
    entity: entity === '' ? strings.common.validation.required : undefined,
    company: needsCompany && company === null ? t.companyRequired : undefined,
    projectManager: manager === null ? strings.people.picker.pickRequired : undefined,
  })

  const submit = () => {
    const found = validate()
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
    }
    setBusy(true)
    setError(null)
    createProject(input).then(onSaved, (failure: unknown) => {
      setBusy(false)
      const code = failure instanceof ApiError ? failure.code : undefined
      if (isRefusal(code)) return setErrors({ [REFUSAL_FIELD[code]]: t.errors[code] })
      if (code === 'crm_unavailable') return setError(t.errors.crm_unavailable)
      if (failure instanceof ApiError && failure.status === 503) {
        return setError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
      }
      const named = fieldErrorOf(failure)
      const field = named ? FIELD_OF[named.field] : undefined
      if (named && field) return setErrors({ [field]: named.message })
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
      testIdPrefix="projects-form"
    >
      <div ref={fieldsRef} className="contents">
        <Field label={t.name} required error={errors.name} testId="projects-form-name">
          {(control) => <input {...control} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label={t.type} hint={t.typeHint} required error={errors.type} testId="projects-form-type">
          {(control) => (
            <select
              {...control}
              value={type}
              onChange={(event) => {
                const next = event.target.value as ProjectType | ''
                setType(next)
                if (next === '' || !isClientType(next)) setCompany(null)
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
        <Field label={t.entity} hint={t.entityHint} required error={errors.entity} testId="projects-form-entity">
          {(control) => (
            <select {...control} value={entity} onChange={(event) => setEntity(event.target.value as Entity | '')}>
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
            onChange={setCompany}
            error={errors.company}
            required
            testId="projects-form-company"
          />
        )}
        <PersonPicker
          label={t.projectManager}
          hint={t.projectManagerHint}
          value={manager}
          onChange={setPickedManager}
          error={errors.projectManager}
          required
          forbiddenHint={t.projectManagerReadOnlyHint}
          testId="projects-form-manager"
        />
      </div>
    </FormDialog>
  )
}
