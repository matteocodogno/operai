import { useState } from 'react'
import { Button, ConfirmDialog, TaskRow, formatDate } from '@operai/ui'
import { deleteTask, setTaskCompleted } from '../lib/activitiesApi'
import type { ProjectTask } from '../lib/activitiesApi'
import { codeOf, statusOf, taskErrorMessage } from '../lib/errors'
import { mayRecordOnTask, recordHoursPropsOf } from '../lib/recordHours'
import { RichTextFilesView } from '@operai/ui/rich-text'
import { openTaskFile, taskFileUrlResolver } from '../lib/taskFiles'
import { strings } from '../strings'
import RecordHoursAction from './RecordHoursAction'
import { TASK_STATE_MEANING, refName, taskState } from './TaskModel'

/** A refusal that means the row's buttons were stale: the list is read again to get fresh `may` flags. */
const staleFlags = (failure: unknown): boolean =>
  codeOf(failure) === 'forbidden' || codeOf(failure) === 'task_blocked' || statusOf(failure) === 404

/**
 * ProjectTaskItem — binds `TaskRow` to activities-api and to the project rules
 * (design § Component inventory). Every button is gated on the row's own `may`
 * flags (AC-3.2, AC-3.3, AC-3.8): the server decided them for this caller, the
 * row never infers them from scope or assignee. Mark done / Reopen run here;
 * Edit is the card's dialog; Delete asks first.
 *
 * Record hours (specs/20261116-record-hours-in-place AC-3.1, AC-3.6, design S2) is the one button that is NOT a `may`
 * flag of the task: it is hours-ui's widget, offered to the task's assignee and its participants, done tasks
 * included, as the last of the row's actions. The rule is `mayRecordOnTask`, from what the row already holds
 * and the person's id; hours-api decides every save.
 *
 * The row's error is owned by the card (`error`), because a failed action
 * reloads the list and the row would otherwise lose its own alert.
 */
export default function ProjectTaskItem({
  task,
  currentUserId,
  error,
  onChanged,
  onFailed,
  onEdit,
}: {
  task: ProjectTask
  currentUserId: string | null
  error: string | undefined
  /** The task left the current view or changed: reload, confirm, move focus (the card's job). */
  onChanged: (message: string) => void
  /** A row action was refused: show `message` on this row; `reload` when the row's flags are stale. */
  onFailed: (id: string, message: string | null, reload: boolean) => void
  onEdit: (task: ProjectTask) => void
}) {
  const t = strings.tasks.row
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const state = taskState(task)
  const done = task.task.completedAt !== null
  const openBlockers = task.task.blockedBy?.filter((blocker) => !blocker.completed) ?? []
  const participants = task.participants ?? []
  // Only a row the person may record on mounts a widget, so a long list loads the seam once for the rows that use it (R1).
  const recordHours = mayRecordOnTask(task, currentUserId) ? recordHoursPropsOf(task) : null

  const toggle = () => {
    setBusy(true)
    onFailed(task.id, null, false)
    setTaskCompleted(task.id, !done).then(
      () => {
        setBusy(false)
        onChanged(done ? strings.tasks.saved.reopened : strings.tasks.saved.completed)
      },
      (failure: unknown) => {
        setBusy(false)
        onFailed(task.id, taskErrorMessage(failure, 'row'), staleFlags(failure))
      },
    )
  }

  const remove = () => {
    setDeleting(true)
    setDeleteError(null)
    deleteTask(task.id).then(
      () => onChanged(strings.tasks.saved.deleted),
      (failure: unknown) => {
        setDeleting(false)
        setDeleteError(taskErrorMessage(failure, 'dialog'))
      },
    )
  }

  const dueText = task.task.dueDate ? t.due(formatDate(task.task.dueDate)) : t.noDue
  const facts = [
    dueText,
    task.task.assignee ? t.assignedTo(refName(task.task.assignee, currentUserId)) : null,
    done && task.task.completedBy && task.task.completedAt
      ? t.completedBy(refName(task.task.completedBy, currentUserId), formatDate(task.task.completedAt))
      : null,
  ].filter((fact): fact is string => fact !== null)

  return (
    <TaskRow
      state={state}
      stateLabel={strings.tasks.state[state]}
      stateMeanings={TASK_STATE_MEANING}
      title={task.subject}
      body={
        <RichTextFilesView
          doc={task.task.description ?? null}
          attachments={(task.task.files ?? [])
            .filter((file) => file.kind === 'attachment')
            .map((file) => ({ id: file.id, name: file.fileName, sizeBytes: file.sizeBytes }))}
          resolveImageUrl={taskFileUrlResolver(task.id)}
          onDownload={(item) => {
            void openTaskFile(task.id, item.id).then((opened) => {
              if (!opened) onFailed(task.id, strings.tasks.files.errors.openFailed, false)
            })
          }}
          copy={{
            images: strings.tasks.files.images,
            check: strings.tasks.files.check,
            attachments: strings.tasks.files.attachments,
          }}
          testIdPrefix={`project-task-${task.id}-description`}
        />
      }
      meta={[
        facts.join(' · '),
        ...(participants.length > 0
          ? [t.with(participants.map((person) => refName(person, currentUserId)).join(', '))]
          : []),
      ]}
      waiting={
        openBlockers.length > 0
          ? `${t.waitingOn(openBlockers.map((b) => b.subject).join(', '))}. ${t.blockedHint}`
          : undefined
      }
      onComplete={task.may.complete ? toggle : undefined}
      completeLabel={done ? t.reopen : t.complete}
      completing={busy}
      completingLabel={t.completing}
      actionsLabel={t.actionsFor(task.subject)}
      actions={
        <>
          {task.may.edit && (
            <Button
              size="sm"
              variant="ghost"
              aria-haspopup="dialog"
              onClick={() => onEdit(task)}
              data-testid={`project-task-${task.id}-edit`}
            >
              {t.edit}
            </Button>
          )}
          {task.may.delete && (
            <Button
              size="sm"
              variant="ghost"
              aria-haspopup="dialog"
              onClick={() => setConfirming(true)}
              data-testid={`project-task-${task.id}-delete`}
            >
              {t.delete}
            </Button>
          )}
          {recordHours && <RecordHoursAction {...recordHours} />}
        </>
      }
      error={error}
      testId={`project-task-${task.id}`}
      completeTestId={`project-task-${task.id}-toggle`}
      waitingTestId={`project-task-${task.id}-waiting`}
    >
      {confirming && (
        <ConfirmDialog
          title={strings.tasks.deleteDialog.title(task.subject)}
          confirmLabel={strings.tasks.deleteDialog.confirm}
          busyLabel={strings.tasks.deleteDialog.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={deleting}
          error={deleteError}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
          testIdPrefix="project-task-delete"
        >
          {strings.tasks.deleteDialog.body}
        </ConfirmDialog>
      )}
    </TaskRow>
  )
}
