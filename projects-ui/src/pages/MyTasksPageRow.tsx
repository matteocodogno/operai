import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Badge, TaskRow, formatDate, listRowMetaClassName } from '@operai/ui'
import { setTaskCompleted } from '../lib/activitiesApi'
import type { MyTask } from '../lib/activitiesApi'
import { statusOf, codeOf, taskErrorMessage } from '../lib/errors'
import { mayRecordOnTask, recordHoursPropsOf } from '../lib/recordHours'
import { RichTextFilesView } from '@operai/ui/rich-text'
import { openTaskFile, taskFileUrlResolver } from '../lib/taskFiles'
import { strings } from '../strings'
import RecordHoursAction from '../components/RecordHoursAction'
import { TASK_STATE_MEANING, refName, taskState } from '../components/TaskModel'

/** A refusal that means the row's buttons were stale: the list is read again to get fresh `may` flags. */
const staleFlags = (failure: unknown): boolean =>
  codeOf(failure) === 'forbidden' || codeOf(failure) === 'task_blocked' || statusOf(failure) === 404

/**
 * MyTaskItem — one row of My tasks (design S4, F7). Binds `TaskRow` to either kind:
 *
 * - a project task shows its project (a router link, built from the id) and offers
 *   Mark done / Mark not done whenever the server's `may.complete` says so;
 * - a pre-sales task shows a **Pre-sales** badge before its title and its company, offers the
 *   same toggle under the same flag, and an "Open in CRM" link to the company. Nothing else
 *   can be changed from here (AC-7.3), so it never gets Edit or Delete whatever its `may`.
 *
 * Every button follows the row's own `may.complete`; the page never infers it. The CRM link is a
 * plain anchor: `/crm/...` lies outside this router's `/projects` basepath, so the shell routes it.
 *
 * Record hours (specs/20261116-record-hours-in-place AC-3.1 – AC-3.4, AC-3.6, design S2) is hours-ui's widget, not a
 * `may` flag: offered to the task's assignee and its participants (`mayRecordOnTask`), done rows included, as
 * the last of the row's actions, on either kind of row. A project task records on its project, a pre-sales task
 * on its deal, or as other work when it has none (`recordHoursPropsOf`); hours-api decides every save.
 */
export default function MyTaskItem({
  task,
  currentUserId,
  error,
  onChanged,
  onFailed,
}: {
  task: MyTask
  currentUserId: string | null
  error: string | undefined
  /** The task changed: reload, confirm, move focus (the page's job). */
  onChanged: (message: string) => void
  /** The toggle was refused: show `message` on this row; `reload` when its flags are stale. */
  onFailed: (id: string, message: string | null, reload: boolean) => void
}) {
  const t = strings.tasks.row
  const my = strings.tasks.my
  const [busy, setBusy] = useState(false)
  const state = taskState(task)
  const done = task.task.completedAt !== null
  const openBlockers = task.task.blockedBy?.filter((blocker) => !blocker.completed) ?? []

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

  const facts = [
    task.task.dueDate ? t.due(formatDate(task.task.dueDate)) : t.noDue,
    task.task.assignee ? t.assignedTo(refName(task.task.assignee, currentUserId)) : null,
    done && task.task.completedBy && task.task.completedAt
      ? t.completedBy(refName(task.task.completedBy, currentUserId), formatDate(task.task.completedAt))
      : null,
  ].filter((fact): fact is string => fact !== null)

  const participants = task.participants ?? []
  // Only a row the person may record on mounts a widget, so a long list loads the seam once for the rows that use it (R1).
  const recordHours = mayRecordOnTask(task, currentUserId) ? recordHoursPropsOf(task) : null
  const companyLink =
    task.kind === 'pre_sales' && task.company ? (
      <a
        className="link self-center text-sm"
        href={`/crm/companies/${encodeURIComponent(task.company.id)}`}
        aria-label={my.openInCrmFor(task.subject)}
        data-testid={`my-task-${task.id}-crm`}
      >
        {my.openInCrm}
      </a>
    ) : null
  const where =
    task.kind === 'pre_sales' ? (
      <>
        <p className={listRowMetaClassName}>{my.company(task.company?.name ?? my.unknownCompany)}</p>
        {task.deal && (
          <p className={listRowMetaClassName}>
            {my.dealLabel}{' '}
            {/* The CRM is a sibling tool outside this router's basepath: a plain anchor, its href built from the id. */}
            <a className="link" href={`/crm/deals/${encodeURIComponent(task.deal.id)}`} data-testid={`my-task-${task.id}-deal`}>
              {task.deal.title ?? my.unknownDeal}
            </a>
          </p>
        )}
      </>
    ) : task.project ? (
      <p className={listRowMetaClassName}>
        {my.projectLabel}{' '}
        <Link to="/$id" params={{ id: task.project.id }} className="link">
          {task.project.name ?? my.unknownProject}
        </Link>
      </p>
    ) : null

  return (
    <TaskRow
      state={state}
      stateLabel={strings.tasks.state[state]}
      stateMeanings={TASK_STATE_MEANING}
      leading={task.kind === 'pre_sales' ? <Badge tone="neutral">{my.preSales}</Badge> : undefined}
      title={task.subject}
      body={
        <>
          {where}
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
        </>
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
        // `undefined`, not an empty fragment, when there is nothing to show: the row then draws no empty group.
        companyLink || recordHours ? (
          <>
            {companyLink}
            {recordHours && <RecordHoursAction {...recordHours} />}
          </>
        ) : undefined
      }
      error={error}
      testId={`my-task-${task.id}`}
      completeTestId={`my-task-${task.id}-toggle`}
      waitingTestId={`my-task-${task.id}-waiting`}
    />
  )
}
