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
} from '@operai/ui'
import { deleteActivity, setTaskCompleted } from '../lib/crmApi'
import { isOverdue } from '../lib/dates'
import { errorMessage } from '../lib/errors'
import { personName } from '../lib/people'
import type { Activity } from '../lib/types'
import { useCurrentUserId } from '../hooks/useCurrentUserId'
import { strings } from '../strings'
import { TaskStateBadge } from './Badges'

/**
 * ActivityItem — one row of a timeline or of "Tasks": the type, subject,
 * who and when, what it is about, and for a task its due date, assignee and
 * state. Actions: Mark done / Reopen on a task (anyone, AC-4.3); Edit and
 * Delete for the author only (AC-4.2 — the server's 403 `author_only` is the
 * gate). `showCompany` links the company (Tasks, where rows span companies).
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
  // specs/017 US-6: an open task waiting on an open task cannot be marked done.
  const blocked = task !== null && task.completedAt === null && task.blocked === true
  const openBlockers = task?.blockedBy?.filter((blocker) => !blocker.completed) ?? []
  const hintId = `crm-activity-${activity.id}-blocked-hint`

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

  const about = [activity.contact?.name, activity.deal?.title].filter((value): value is string => Boolean(value))

  return (
    <div className={`${listRowClassName} flex-col items-stretch gap-2`} data-testid={`crm-activity-${activity.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{strings.badges.activityType[activity.type]}</Badge>
        {task && (
          <TaskStateBadge
            state={task.completedAt !== null ? 'done' : blocked ? 'blocked' : isOverdue(task) ? 'overdue' : 'open'}
          />
        )}
        <span className="font-medium text-text">{activity.subject}</span>
      </div>
      {/* A meeting activity's body is the link and nothing else (AC-14.2): never show one. */}
      {activity.body && !activity.meeting && <p className="whitespace-pre-line text-sm text-soft">{activity.body}</p>}
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
      <p className={listRowMetaClassName}>
        {t.by(personName(activity.author, currentUserId), formatDateTime(activity.occurredAt))}
        {showCompany && (
          <>
            {' · '}
            <Link to="/companies/$id" params={{ id: activity.company.id }} className="link">
              {strings.tasks.company(activity.company.name)}
            </Link>
          </>
        )}
        {about.length > 0 && ` · ${t.about(about.join(', '))}`}
        {(activity.participants?.length ?? 0) > 0 &&
          ` · ${t.with(activity.participants!.map((person) => personName(person, currentUserId)).join(', '))}`}
      </p>
      {task && (
        <p className={listRowMetaClassName}>
          {task.dueDate ? t.due(formatDate(task.dueDate)) : t.noDue}
          {task.assignee && ` · ${t.assignedTo(personName(task.assignee, currentUserId))}`}
          {task.completedAt &&
            task.completedBy &&
            ` · ${t.completedBy(personName(task.completedBy, currentUserId), formatDate(task.completedAt))}`}
        </p>
      )}
      {blocked && openBlockers.length > 0 && (
        <p className={listRowMetaClassName} id={hintId} data-testid={`crm-activity-${activity.id}-waiting`}>
          {t.waitingOn(openBlockers.map((blocker) => blocker.subject).join(', '))}. {t.blockedHint}
        </p>
      )}
      {(task || isAuthor) && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t.actionsFor(activity.subject)}>
          {task && (
            <Button
              size="sm"
              busy={busy}
              disabled={blocked}
              aria-describedby={blocked ? hintId : undefined}
              onClick={toggle}
              data-testid={`crm-activity-${activity.id}-toggle`}
            >
              {busy ? t.completing : task.completedAt === null ? t.complete : t.reopen}
            </Button>
          )}
          {isAuthor && (
            <Button size="sm" variant="ghost" onClick={() => onEdit(activity)} aria-haspopup="dialog">
              {t.edit}
            </Button>
          )}
          {isAuthor && (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-haspopup="dialog">
              {t.delete}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {confirming && (
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
      )}
    </div>
  )
}
