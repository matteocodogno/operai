import { useCallback, useState } from 'react'
import { Button, Card } from '@operai/ui'
import { listProjectTasks } from '../lib/activitiesApi'
import type { Project } from '../lib/types'
import { useTaskLists } from '../hooks/useTaskLists'
import type { TaskLister } from '../hooks/useTaskLists'
import { strings } from '../strings'
import TaskBoard from './TaskBoard'
import TaskFormDialog from './TaskFormDialog'

/**
 * TasksCard — the project's tasks on the project page (US-3, F1, F4, F5) as a board: Open, In progress and Done (the
 * last 30 days, older on demand), each task a card that opens its drawer (`TaskBoard`). It loads on its own, so the
 * rest of the page never waits for it. "Add task" is the only inferred permission (no task view exists to carry `may`
 * when the list is empty): a manager of the project's entity, on a project that is not closed or cancelled (AC-3.8).
 * Every action in a task's drawer, and every drag, follows the task's own `may` flags.
 */
export default function TasksCard({
  project,
  canManage,
  currentUserId,
}: {
  project: Pick<Project, 'id' | 'state' | 'projectManager' | 'team' | 'onProject' | 'onProjectComplete'>
  canManage: boolean
  currentUserId: string | null
}) {
  const t = strings.tasks
  const [saved, setSaved] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const writable = project.state !== 'closed' && project.state !== 'cancelled'
  const canAdd = canManage && writable

  // Nothing is cached across visits: a new visit, or another project, reads afresh; a re-read after a write keeps the
  // cards on screen (specs/20261116-record-hours-in-place design S3, plan G1).
  const list = useCallback<TaskLister>((query, init) => listProjectTasks(project.id, query, init), [project.id])
  const lists = useTaskLists(list)

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
        {!writable && <p className="text-sm text-soft">{t.closedNote}</p>}
        <TaskBoard
          mode="project"
          lists={lists}
          currentUserId={currentUserId}
          testIdBase="project-tasks"
          cardTestIdPrefix="project-task"
          emptyOpen={canAdd ? t.emptyOpenManager : t.emptyOpen}
          saved={saved}
          onSaved={setSaved}
          renderEdit={({ task, onCancel, onSaved, onHostReadOnly }) => (
            <TaskFormDialog
              project={project}
              task={task}
              currentUserId={currentUserId}
              onCancel={onCancel}
              onSaved={onSaved}
              onHostReadOnly={onHostReadOnly}
            />
          )}
        />
      </div>
      {adding && (
        <TaskFormDialog
          project={project}
          currentUserId={currentUserId}
          onCancel={() => setAdding(false)}
          onSaved={(message) => {
            setAdding(false)
            setSaved(message)
            lists.reload()
          }}
          onHostReadOnly={lists.reload}
        />
      )}
    </Card>
  )
}
