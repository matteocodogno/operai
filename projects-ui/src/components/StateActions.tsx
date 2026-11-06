import { useState } from 'react'
import { Button, ConfirmDialog } from '@operai/ui'
import type { ButtonVariant } from '@operai/ui'
import { ApiError, isStaleWrite } from '../lib/api'
import { codeOf, errorMessage } from '../lib/errors'
import { changeTypeToSaas, transitionProject } from '../lib/projectsApi'
import type { Project, ProjectState } from '../lib/types'
import { strings } from '../strings'

type Move = { to: ProjectState; label: string; variant: ButtonVariant }

/**
 * The moves a project offers from where it is (AC-1.3, the same matrix the
 * server enforces): `planned` → `active`, `planned` / `active` → `on_hold` and
 * back to the state it left, `active` ⇄ `closed`, and everything but `closed`
 * → `cancelled`, which is final.
 */
function movesFor(project: Project): Move[] {
  const t = strings.project.actions
  const hold: Move = { to: 'on_hold', label: t.hold, variant: 'secondary' }
  const cancel: Move = { to: 'cancelled', label: t.cancel, variant: 'danger' }
  switch (project.state) {
    case 'planned':
      return [{ to: 'active', label: t.start, variant: 'primary' }, hold, cancel]
    case 'active':
      return [hold, { to: 'closed', label: t.close, variant: 'secondary' }, cancel]
    case 'on_hold':
      // Back to the state it left only; a hold without one cannot be resumed (cancel is still open).
      return [
        ...(project.stateBeforeHold
          ? [{ to: project.stateBeforeHold, label: t.resume, variant: 'primary' as const }]
          : []),
        cancel,
      ]
    case 'closed':
      return [{ to: 'active', label: t.reopen, variant: 'secondary' }]
    case 'cancelled':
      return []
  }
}

/** The refusal in the person's language when the code is known, else the server's own detail. */
function refusalMessage(failure: unknown): string {
  const code = codeOf(failure)
  const known = strings.project.errors
  if (code === 'invalid_transition' || code === 'type_change_refused' || code === 'out_of_scope') return known[code]
  if (failure instanceof ApiError && failure.status === 503) {
    return `${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`
  }
  return errorMessage(failure)
}

/**
 * StateActions — the page actions that move a project: its state (AC-1.3) and
 * the one allowed type change, internal → SaaS (AC-1.2). Only the moves the
 * matrix allows from the current state are rendered; cancelling and the type
 * change, which cannot be undone, ask first. The project's `version` goes out
 * as If-Match (AC-1.7): a stale write is the page's to handle (`onStale`), any
 * other refusal is `onError`'s text.
 */
export default function StateActions({
  project,
  onChanged,
  onStale,
  onError,
}: {
  project: Project
  onChanged: (next: Project, message: string) => void
  onStale: () => void
  onError: (message: string) => void
}) {
  const t = strings.project
  const [pending, setPending] = useState<ProjectState | 'type' | null>(null)
  const [dialog, setDialog] = useState<'cancel' | 'saas' | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const moves = movesFor(project)
  const canMakeSaas = project.type === 'internal'
  if (moves.length === 0 && !canMakeSaas) return null

  const settle = (request: Promise<Project>, message: string, inDialog: boolean) =>
    request.then(
      (next) => {
        setPending(null)
        setDialog(null)
        onChanged(next, message)
      },
      (failure: unknown) => {
        setPending(null)
        if (isStaleWrite(failure)) {
          setDialog(null)
          return onStale()
        }
        if (inDialog) return setDialogError(refusalMessage(failure))
        onError(refusalMessage(failure))
      },
    )

  const move = (to: ProjectState, inDialog = false) => {
    setPending(to)
    setDialogError(null)
    void settle(
      transitionProject(project.id, project.version, to),
      t.saved.state(strings.badges.projectState[to]),
      inDialog,
    )
  }

  const makeSaas = () => {
    setPending('type')
    setDialogError(null)
    void settle(changeTypeToSaas(project.id, project.version), t.saved.type, true)
  }

  const closeDialog = () => {
    setDialog(null)
    setDialogError(null)
  }

  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t.actions.label} data-testid="project-actions">
        {moves.map((option) => (
          <Button
            key={option.to}
            variant={option.variant}
            busy={pending === option.to}
            disabled={pending !== null && pending !== option.to}
            aria-haspopup={option.to === 'cancelled' ? 'dialog' : undefined}
            onClick={() => (option.to === 'cancelled' ? setDialog('cancel') : move(option.to))}
          >
            {pending === option.to ? t.actions.working : option.label}
          </Button>
        ))}
        {canMakeSaas && (
          <Button aria-haspopup="dialog" disabled={pending !== null} onClick={() => setDialog('saas')}>
            {t.actions.makeSaas}
          </Button>
        )}
      </div>
      {dialog === 'cancel' && (
        <ConfirmDialog
          title={t.cancelDialog.title}
          confirmLabel={t.cancelDialog.confirm}
          busyLabel={t.cancelDialog.busy}
          cancelLabel={t.cancelDialog.keep}
          closeLabel={strings.common.close}
          busy={pending === 'cancelled'}
          error={dialogError}
          onConfirm={() => move('cancelled', true)}
          onCancel={closeDialog}
          testIdPrefix="project-cancel"
        >
          {t.cancelDialog.body}
        </ConfirmDialog>
      )}
      {dialog === 'saas' && (
        <ConfirmDialog
          title={t.saasDialog.title}
          confirmLabel={t.saasDialog.confirm}
          busyLabel={t.saasDialog.busy}
          cancelLabel={t.saasDialog.keep}
          closeLabel={strings.common.close}
          busy={pending === 'type'}
          error={dialogError}
          onConfirm={makeSaas}
          onCancel={closeDialog}
          testIdPrefix="project-saas"
        >
          {t.saasDialog.body}
        </ConfirmDialog>
      )}
    </>
  )
}
