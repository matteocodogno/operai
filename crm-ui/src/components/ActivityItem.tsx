import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Badge,
  Button,
  ConfirmDialog,
  formatDate,
  formatDateTime,
  listRowClassName,
  listRowMetaClassName,
  TaskRow,
} from '@operai/ui'
import { RichTextFilesView } from '@operai/ui/rich-text'
import { deleteActivity, setTaskCompleted } from '../lib/activitiesApi'
import { openTaskFile, taskFileUrlResolver } from '../lib/taskFiles'
import { isOverdue } from '../lib/dates'
import { errorMessage } from '../lib/errors'
import { personName } from '../lib/people'
import { mayRecordOnTask, recordHoursPropsOf } from '../lib/recordHours'
import { TASK_STATE_MEANING } from '../lib/statusMeanings'
import type { TaskState } from '../lib/statusMeanings'
import type { Activity } from '../lib/types'
import { useCurrentUserId } from '../hooks/useCurrentUserId'
import { strings } from '../strings'
import RecordHoursAction from './RecordHoursAction'

/**
 * ActivityItem — one row of a timeline or of "Tasks": the type, subject,
 * who and when, what it is about, and for a task its due date, assignee and
 * state. Actions: Mark done / Reopen on a task (anyone, AC-4.3); Edit and
 * Delete for the author only (AC-4.2 — the server's 403 `author_only` is the
 * gate). `showCompany` links the company (Tasks, where rows span companies). The deal an
 * activity is about links to the deal's page.
 *
 * A task renders through the library's `TaskRow` (specs/20261110-activities US-1: a move, not a
 * redesign — the copy and the content of every line are unchanged). The one
 * visible difference: a blocked Mark done is `aria-disabled` instead of
 * `disabled`, so it stays reachable and its "Waiting on" line is read.
 *
 * A task's actions end with hours-ui's Record hours (specs/20261116-record-hours-in-place US-3, design S2) for its
 * assignee and its participants, a done task as an open one; it is the last item so the message it shows after a save
 * displaces nothing the person is using. Every list of CRM tasks — the Tasks page and the deal, company and contact
 * timelines — renders its rows here, so this is the one place the rule is applied.
 */
export default function ActivityItem({
  activity,
  showCompany = false,
  onChanged,
  onEdit,
  onDeleted,
}: {
  activity: Activity
  showCompany?: boolean
  onChanged: (activity: Activity) => void
  onEdit: (activity: Activity) => void
  onDeleted: (activity: Activity) => void
}) {
  const t = strings.activities
  const currentUserId = useCurrentUserId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const task = activity.task
  const isAuthor = currentUserId !== null && activity.author.id === currentUserId
  // specs/20261101-crm US-6: an open task waiting on an open task cannot be marked done.
  const blocked = task !== null && task.completedAt === null && task.blocked === true
  const openBlockers = task?.blockedBy?.filter((blocker) => !blocker.completed) ?? []

  const toggle = () => {
    setBusy(true)
    setError(null)
    setTaskCompleted(activity.id, task?.completedAt === null).then(
      (updated) => {
        setBusy(false)
        onChanged(updated)
      },
      (failure) => {
        setBusy(false)
        setError(errorMessage(failure))
      },
    )
  }

  const remove = () => {
    setDeleting(true)
    setDeleteError(null)
    deleteActivity(activity.id).then(
      () => onDeleted(activity),
      (failure) => {
        setDeleting(false)
        setDeleteError(errorMessage(failure))
      },
    )
  }

  const contactName = activity.contact?.name ?? null
  const deal = activity.deal?.title ? activity.deal : null

  const body = (
    <>
      {/* A meeting activity's body is the link and nothing else (AC-14.2): never show one. */}
      {activity.body && !activity.meeting && <p className="whitespace-pre-line text-sm text-soft">{activity.body}</p>}
      {/* A task's text is its rich description, with its pictures and attachments (ADR 20261113-task-description-files-in-activities-api-bucket). */}
      {task && (
        <RichTextFilesView
          doc={task.description ?? null}
          attachments={(task.files ?? [])
            .filter((file) => file.kind === 'attachment')
            .map((file) => ({ id: file.id, name: file.fileName, sizeBytes: file.sizeBytes }))}
          resolveImageUrl={taskFileUrlResolver(activity.id)}
          onDownload={(item) => {
            setError(null)
            void openTaskFile(activity.id, item.id).then((opened) => {
              if (!opened) setError(strings.activities.taskFiles.errors.openFailed)
            })
          }}
          copy={{
            images: strings.activities.taskFiles.images,
            check: strings.activities.taskFiles.check,
            attachments: strings.activities.taskFiles.attachments,
          }}
          testIdPrefix={`crm-activity-${activity.id}-description`}
        />
      )}
      {activity.meeting && (
        <p className="text-sm">
          {/* The Meetings tool is a sibling route of the shell, outside this tool's router basepath, so a plain
              anchor (not the router's Link). The href is built from the id: the server's own href is not trusted
              into an attribute. A reader without access lands on the meeting's not-found state (AC-14.4). */}
          <a
            className="link"
            href={`/my-meetings/m/${encodeURIComponent(activity.meeting.id)}`}
            data-testid={`crm-activity-${activity.id}-open-meeting`}
          >
            {t.openMeeting}
          </a>
        </p>
      )}
    </>
  )

  const byline = (
    <>
      {t.by(personName(activity.author, currentUserId), formatDateTime(activity.occurredAt))}
      {showCompany && (
        <>
          {' · '}
          <Link to="/companies/$id" params={{ id: activity.company.id }} className="link">
            {strings.tasks.company(activity.company.name)}
          </Link>
        </>
      )}
      {(contactName !== null || deal !== null) && (
        <>
          {` · ${t.aboutLabel} `}
          {contactName}
          {contactName !== null && deal !== null && ', '}
          {deal !== null && (
            <Link
              to="/deals/$id"
              params={{ id: deal.id }}
              className="link"
              data-testid={`crm-activity-${activity.id}-deal`}
            >
              {deal.title}
            </Link>
          )}
        </>
      )}
      {(activity.participants?.length ?? 0) > 0 &&
        ` · ${t.with(activity.participants!.map((person) => personName(person, currentUserId)).join(', '))}`}
    </>
  )

  const authorActions = isAuthor && (
    <>
      <Button size="sm" variant="ghost" onClick={() => onEdit(activity)} aria-haspopup="dialog">
        {t.edit}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-haspopup="dialog">
        {t.delete}
      </Button>
    </>
  )

  // Whether the button shows, from what the row already holds; hours-api decides every save (AC-3.1).
  const recordHoursProps = mayRecordOnTask(activity, currentUserId) ? recordHoursPropsOf(activity) : null

  const confirmDialog = confirming && (
    <ConfirmDialog
      title={t.deleteDialog.title(activity.subject)}
      confirmLabel={t.deleteDialog.confirm}
      busyLabel={t.deleteDialog.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={deleting}
      error={deleteError}
      onConfirm={remove}
      onCancel={() => setConfirming(false)}
      testIdPrefix="crm-activity-delete"
    >
      {t.deleteDialog.body}
    </ConfirmDialog>
  )

  const typeBadge = <Badge tone="neutral">{strings.badges.activityType[activity.type]}</Badge>
  const actionsLabel = t.actionsFor(activity.subject)

  if (task) {
    const state: TaskState =
      task.completedAt !== null ? 'done' : blocked ? 'blocked' : isOverdue(task) ? 'overdue' : 'open'
    return (
      <TaskRow
        state={state}
        stateLabel={strings.badges.taskState[state]}
        // The CRM has always shown "blocked" as pending (someone else has to act first), not as attention.
        stateMeanings={TASK_STATE_MEANING}
        leading={typeBadge}
        title={activity.subject}
        body={body}
        meta={[
          byline,
          <>
            {task.dueDate ? t.due(formatDate(task.dueDate)) : t.noDue}
            {task.assignee && ` · ${t.assignedTo(personName(task.assignee, currentUserId))}`}
            {task.completedAt &&
              task.completedBy &&
              ` · ${t.completedBy(personName(task.completedBy, currentUserId), formatDate(task.completedAt))}`}
          </>,
        ]}
        waiting={
          openBlockers.length > 0
            ? `${t.waitingOn(openBlockers.map((blocker) => blocker.subject).join(', '))}. ${t.blockedHint}`
            : undefined
        }
        onComplete={toggle}
        completeLabel={task.completedAt === null ? t.complete : t.reopen}
        completing={busy}
        completingLabel={t.completing}
        actions={
          (authorActions || recordHoursProps) && (
            <>
              {authorActions}
              {recordHoursProps && <RecordHoursAction {...recordHoursProps} />}
            </>
          )
        }
        actionsLabel={actionsLabel}
        error={error}
        testId={`crm-activity-${activity.id}`}
        completeTestId={`crm-activity-${activity.id}-toggle`}
        waitingTestId={`crm-activity-${activity.id}-waiting`}
      >
        {confirmDialog}
      </TaskRow>
    )
  }

  // Notes, calls, meetings and emails have no state, and TaskRow always shows one: the same row without it.
  return (
    <div className={`${listRowClassName} flex-col items-stretch gap-2`} data-testid={`crm-activity-${activity.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        {typeBadge}
        <span className="font-medium text-text">{activity.subject}</span>
      </div>
      {body}
      <p className={listRowMetaClassName}>{byline}</p>
      {isAuthor && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={actionsLabel}>
          {authorActions}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {confirmDialog}
    </div>
  )
}
