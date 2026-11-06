import { useState } from 'react'
import { FormDialog } from '@operai/ui'
import { isStaleWrite } from '../lib/api'
import { errorMessage, projectRefusalOf } from '../lib/errors'
import { updateProject } from '../lib/projectsApi'
import type { Project } from '../lib/types'
import { strings } from '../strings'
import PersonPicker from './PersonPicker'
import type { PersonChoice } from './PersonPicker'

/**
 * PickProjectManagerDialog — the first project manager of a project made from a deal (specs/022 AC-4.8, D42,
 * D46): picked among the people who hold access to the module, the same picker as the project's own manager
 * (ADR-0055), and sent as `PATCH /projects/{id}` `{ projectManagerId }` with the project's version as
 * If-Match. Only the purchase order's ops-manager and an admin are offered it (the page gates it; the server
 * refuses anyone else with 403 `not_ops_manager`).
 *
 * A person must be chosen to save: there is no way here to leave the project without a project manager
 * (AC-4.9). Each refusal has its own words — not the ops-manager, no access to the module (on the field),
 * the directory down — and a stale save (409 `version_conflict`) closes the dialog and is the page's reload
 * prompt (`onStale`). Success hands the written project to the page (`onSaved`), which is then no longer
 * awaiting.
 */
export default function PickProjectManagerDialog({
  project,
  onSaved,
  onCancel,
  onStale,
}: {
  project: Project
  onSaved: (next: Project) => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.project.pickDialog
  const [manager, setManager] = useState<PersonChoice | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = () => {
    if (manager === null) return
    setBusy(true)
    setFieldError(null)
    setError(null)
    updateProject(project.id, project.version, { projectManagerId: manager.id }).then(onSaved, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      const refusal = projectRefusalOf(failure)
      if (refusal === 'not_project_user') return setFieldError(t.errors.not_project_user)
      if (refusal === 'not_ops_manager' || refusal === 'identity_unavailable' || refusal === 'out_of_scope') {
        return setError(t.errors[refusal])
      }
      setError(errorMessage(failure))
    })
  }

  return (
    <FormDialog
      title={t.title}
      description={t.description}
      submitLabel={t.submit}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={manager !== null}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      testIdPrefix="project-pick-manager"
    >
      <PersonPicker
        label={t.label}
        hint={t.hint}
        value={manager}
        onChange={(choice) => {
          setManager(choice)
          setFieldError(null)
        }}
        error={fieldError}
        required
        forbiddenHint={strings.projects.form.projectManagerReadOnlyHint}
        testId="project-pick-manager-person"
      />
    </FormDialog>
  )
}
