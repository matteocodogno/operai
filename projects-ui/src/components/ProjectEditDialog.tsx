import { useRef, useState } from 'react'
import { Field, FormDialog, focusFirstInvalid } from '@operai/ui'
import { ApiError, isStaleWrite } from '../lib/api'
import { codeOf, errorMessage, fieldErrorOf } from '../lib/errors'
import { personName } from '../lib/people'
import { updateProject } from '../lib/projectsApi'
import type { UpdateProjectInput } from '../lib/projectsApi'
import type { Project } from '../lib/types'
import { first, hasErrors, maxLength, required } from '../lib/validate'
import type { Errors } from '../lib/validate'
import { strings } from '../strings'
import PersonPicker from './PersonPicker'
import type { PersonChoice } from './PersonPicker'

type FieldName = 'name' | 'projectManager'

/**
 * ProjectEditDialog — rename a project and change its project manager (AC-1.6).
 * The manager is picked among the people who hold access to the module; the
 * server re-checks it (422 `not_project_user`, which lands on that field). Only
 * what changed is sent, with the project's `version` as If-Match (AC-1.7): a
 * stale save closes the dialog and is the page's to handle (`onStale`).
 */
export default function ProjectEditDialog({
  project,
  currentUserId,
  onSaved,
  onCancel,
  onStale,
}: {
  project: Project
  currentUserId: string | null
  onSaved: (next: Project) => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.project.editDialog
  const [name, setName] = useState(project.name)
  const [manager, setManager] = useState<PersonChoice | null>({
    id: project.projectManager.id,
    label: personName(project.projectManager, currentUserId),
  })
  const [errors, setErrors] = useState<Errors<FieldName>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)

  const trimmed = name.trim()
  const changes: UpdateProjectInput = {
    ...(trimmed !== project.name ? { name: trimmed } : {}),
    ...(manager && manager.id !== project.projectManager.id ? { projectManagerId: manager.id } : {}),
  }

  const submit = () => {
    const found: Errors<FieldName> = {
      name: first(required(name), maxLength(name, 200)) ?? undefined,
      projectManager: manager === null ? strings.people.picker.pickRequired : undefined,
    }
    setErrors(found)
    if (hasErrors(found)) {
      requestAnimationFrame(() => focusFirstInvalid(fieldsRef.current))
      return
    }
    setBusy(true)
    setError(null)
    updateProject(project.id, project.version, changes).then(onSaved, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      if (codeOf(failure) === 'not_project_user') {
        return setErrors({ projectManager: strings.projects.form.errors.not_project_user })
      }
      if (failure instanceof ApiError && failure.status === 503) {
        return setError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
      }
      const named = fieldErrorOf(failure)
      const field: FieldName | undefined =
        named?.field === 'name' ? 'name' : named?.field === 'projectManagerId' ? 'projectManager' : undefined
      if (named && field) return setErrors({ [field]: named.message })
      setError(errorMessage(failure))
    })
  }

  return (
    <FormDialog
      title={t.title}
      submitLabel={t.submit}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={Object.keys(changes).length > 0}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      testIdPrefix="project-edit"
    >
      <div ref={fieldsRef} className="contents">
        <Field label={t.name} required error={errors.name} testId="project-edit-name">
          {(control) => <input {...control} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <PersonPicker
          label={t.projectManager}
          hint={t.projectManagerHint}
          value={manager}
          onChange={setManager}
          error={errors.projectManager}
          required
          forbiddenHint={strings.projects.form.projectManagerReadOnlyHint}
          testId="project-edit-manager"
        />
      </div>
    </FormDialog>
  )
}
