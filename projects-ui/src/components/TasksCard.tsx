import { useCallback, useState } from 'react'
import { Banner, Button, Card, ListRows, Pagination, StatePanel, Tabs, tabPanelProps } from '@operai/ui'
import { listProjectTasks } from '../lib/activitiesApi'
import type { ProjectTask, TaskStatus } from '../lib/activitiesApi'
import { codeOf, errorMessage, statusOf } from '../lib/errors'
import type { Project } from '../lib/types'
import { useResource } from '../hooks/useResource'
import { strings } from '../strings'
import { Loading, Saved } from './LoadState'
import ProjectTaskItem from './ProjectTaskItem'
import TaskFormDialog from './TaskFormDialog'

const PAGE_SIZE = 25
const TABS_ID = 'project-tasks'

/** The card-local failure (F1): the rest of the page renders regardless. */
function TasksLoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = strings.tasks.loadFailure
  if (statusOf(error) === 403) {
    return (
      <StatePanel role="alert" title={strings.common.permissionDenied.heading} testId="project-tasks-denied">
        {strings.common.permissionDenied.body}
      </StatePanel>
    )
  }
  const code = codeOf(error)
  const [title, body] =
    code === 'host_unavailable'
      ? [t.hostUnavailableTitle, t.hostUnavailable]
      : code === 'maintenance'
        ? [t.maintenanceTitle, t.maintenance]
        : statusOf(error) === 503
          ? [strings.common.authUnavailable.heading, strings.common.authUnavailable.body]
          : [strings.common.loadErrorTitle, errorMessage(error)]
  return (
    <Banner
      tone="warning"
      title={title}
      onRetry={onRetry}
      retryLabel={strings.common.retry}
      data-testid="project-tasks-error"
    >
      {body}
    </Banner>
  )
}

/**
 * TasksCard — the project's tasks on the project page (US-3, F1, F4, F5): Open
 * (earliest due first, no due date last) and Done, switched with `Tabs`. It
 * loads on its own, so the rest of the page never waits for it. "Add task" is
 * the only inferred permission (no task view exists to carry `may` when the list
 * is empty): a manager of the project's entity, on a project that is not closed
 * or cancelled (AC-3.8). Every row button follows the row's own `may` flags.
 */
export default function TasksCard({
  project,
  canManage,
  currentUserId,
}: {
  project: Pick<Project, 'id' | 'state' | 'projectManager' | 'team'>
  canManage: boolean
  currentUserId: string | null
}) {
  const t = strings.tasks
  const [view, setView] = useState<TaskStatus>('open')
  const [page, setPage] = useState(1)
  const [saved, setSaved] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<ProjectTask | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const writable = project.state !== 'closed' && project.state !== 'cancelled'

  const load = useCallback(
    (signal: AbortSignal) => listProjectTasks(project.id, { status: view, page, pageSize: PAGE_SIZE }, { signal }),
    [project.id, view, page],
  )
  // Remembered under everything the read depends on, so a re-read after a write keeps the rows on screen (status
  // `ready`, `refreshing`) instead of going through `loading`: a row the list still holds stays mounted, and with it
  // the Record hours widget's message, which has no timer and goes only by × or by leaving the page (specs/20261116-
  // record-hours-in-place design S3, plan G1). A row the re-read no longer holds goes; the first read, a failed one
  // and the empty list are as before. The key is the whole of the fetcher's inputs, as `MyTasksPage`'s is.
  const tasks = useResource(load, { cacheKey: `project-tasks:${JSON.stringify([project.id, view, page])}` })

  /** Where focus rests when a row leaves the view: the selected tab is stable and visible. */
  const focusTab = () => document.getElementById(`${TABS_ID}-tab-${view}`)?.focus()

  const changed = (message: string) => {
    setSaved(message)
    setRowErrors({})
    // The last row of a later page left: step back so the page is not empty.
    if ((tasks.data?.items.length ?? 0) === 1 && page > 1) setPage(page - 1)
    else tasks.retry()
    focusTab()
  }

  const rowFailed = (id: string, message: string | null, reload: boolean) => {
    setRowErrors((current) => {
      const rest = Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))
      return message === null ? rest : { ...rest, [id]: message }
    })
    if (reload) tasks.retry()
  }

  const canAdd = canManage && writable

  let content
  if (tasks.status === 'loading') content = <Loading label={t.loading} />
  else if (tasks.status === 'error') content = <TasksLoadFailure error={tasks.error} onRetry={tasks.retry} />
  else if (tasks.data!.total === 0)
    content =
      view === 'open' ? (
        <StatePanel title={t.emptyOpenTitle}>{canAdd ? t.emptyOpenBodyManager : t.emptyOpenBody}</StatePanel>
      ) : (
        <StatePanel title={t.emptyDoneTitle}>{t.emptyDoneBody}</StatePanel>
      )
  else
    content = (
      <div className="flex flex-col gap-3">
        <ListRows label={t.listLabel} testId="project-tasks-list">
          {tasks.data!.items.map((task) => (
            <ProjectTaskItem
              key={task.id}
              task={task}
              currentUserId={currentUserId}
              error={rowErrors[task.id]}
              onChanged={changed}
              onFailed={rowFailed}
              onEdit={setEditing}
            />
          ))}
        </ListRows>
        {tasks.data!.total > PAGE_SIZE && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={tasks.data!.total}
            onPageChange={setPage}
            label={strings.common.pagination.label}
            previousLabel={strings.common.pagination.previous}
            nextLabel={strings.common.pagination.next}
            status={strings.common.pagination.status}
            testId="project-tasks-pagination"
          />
        )}
      </div>
    )

  return (
    <Card
      title={t.title}
      data-testid="project-tasks"
      action={
        canAdd && (
          <Button size="sm" aria-haspopup="dialog" onClick={() => setAdding(true)} data-testid="project-tasks-add">
            {t.add}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <Tabs
          label={t.viewsLabel}
          idPrefix={TABS_ID}
          value={view}
          onChange={(next) => {
            setView(next)
            setPage(1)
            setRowErrors({})
          }}
          tabs={[
            { id: 'open', label: t.open },
            { id: 'done', label: t.done },
          ]}
          testId="project-tasks-tabs"
        />
        {!writable && <p className="text-sm text-soft">{t.closedNote}</p>}
        <div {...tabPanelProps(TABS_ID, view)} className="flex flex-col gap-3">
          {saved && <Saved message={saved} onDismiss={() => setSaved(null)} />}
          {content}
        </div>
      </div>
      {adding && (
        <TaskFormDialog
          project={project}
          currentUserId={currentUserId}
          onCancel={() => setAdding(false)}
          onSaved={(message) => {
            setAdding(false)
            setSaved(message)
            tasks.retry()
          }}
          onHostReadOnly={tasks.retry}
        />
      )}
      {editing && (
        <TaskFormDialog
          project={project}
          task={editing}
          currentUserId={currentUserId}
          onCancel={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null)
            setSaved(message)
            tasks.retry()
            // The dialog hands focus back to Edit: rest on the selected tab instead, as after every other write.
            window.setTimeout(focusTab, 0)
          }}
          onHostReadOnly={tasks.retry}
        />
      )}
    </Card>
  )
}
