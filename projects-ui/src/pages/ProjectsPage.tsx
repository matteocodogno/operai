import { useCallback, useId, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Button, Card, DataTable, Field, PageHeader, Pagination, StatePanel } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { EntityBadge, ProjectStateBadge, ProjectTypeBadge } from '../components/Badges'
import { LoadFailure, Loading } from '../components/LoadState'
import ProjectFormDialog from '../components/ProjectFormDialog'
import { useCurrentUserId } from '../hooks/useCurrentUserId'
import { useResource } from '../hooks/useResource'
import { useScope } from '../hooks/useScope'
import { PROJECT_STATES, PROJECT_TYPES } from '../lib/domain'
import { personName } from '../lib/people'
import { getProjectManagers, listProjects } from '../lib/projectsApi'
import type { ProjectState, ProjectSummary, ProjectType } from '../lib/types'
import { strings } from '../strings'

const PAGE_SIZE = 25

/** The project-manager filter value that asks for the projects awaiting one (AC-4.5): `projectManagerId=none`. */
const NO_PROJECT_MANAGER = 'none'

/** What the company column says: the client — a `saas` row carries its own company too (D40) — or "Internal" (AC-1.4). */
function companyText(project: ProjectSummary): string {
  const t = strings.projects.list
  if (project.type === 'internal') return t.internal
  return project.company?.name ?? t.companyUnavailable
}

/** The project-manager cell: the person, or "Awaiting project manager" while there is none (AC-4.5), never blank. */
function projectManagerText(project: ProjectSummary, currentUserId: string | null): string {
  return project.awaitingProjectManager
    ? strings.projects.list.awaitingProjectManager
    : personName(project.projectManager, currentUserId)
}

/**
 * ProjectsPage — the projects list (US-1, AC-1.1, AC-1.4): filters in a Card
 * (name search, type, state, project manager), a DataTable sorted by the server
 * by name, 25 to a page. "New project" opens ProjectFormDialog for a holder of
 * manage projects only (AC-4.4); a created project opens on its own page.
 *
 * The project-manager filter lists the people who manage a project today
 * (`GET /project-managers`, open to every reader) and, always, "None yet" for the projects
 * awaiting one (AC-4.5). It is not the user directory, which only `project:manage` holders
 * may read, so every reader gets the same filter (AC-1.4).
 */
export default function ProjectsPage() {
  const t = strings.projects.list
  const titleId = useId()
  const navigate = useNavigate()
  const currentUserId = useCurrentUserId()
  const { canManage } = useScope()
  const [q, setQ] = useState('')
  const [type, setType] = useState<ProjectType | ''>('')
  const [state, setState] = useState<ProjectState | ''>('')
  const [projectManagerId, setProjectManagerId] = useState('')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)

  const filtered = q.trim() !== '' || type !== '' || state !== '' || projectManagerId !== ''
  const load = useCallback(
    (signal: AbortSignal) => listProjects({ page, q: q.trim(), type, state, projectManagerId }, { signal }),
    [page, q, type, state, projectManagerId],
  )
  const projects = useResource(load)
  const loadManagers = useCallback((signal: AbortSignal) => getProjectManagers({ signal }), [])
  const managers = useResource(loadManagers)

  const columns: DataTableColumn<ProjectSummary>[] = [
    {
      id: 'name',
      header: t.columns.name,
      rowHeader: true,
      render: (project) => (
        <Link to="/$id" params={{ id: project.id }} className="link">
          {project.name}
        </Link>
      ),
    },
    { id: 'type', header: t.columns.type, render: (project) => <ProjectTypeBadge type={project.type} /> },
    { id: 'state', header: t.columns.state, render: (project) => <ProjectStateBadge state={project.state} /> },
    {
      id: 'company',
      header: t.columns.company,
      render: (project) => <span data-testid="projects-company">{companyText(project)}</span>,
    },
    {
      id: 'projectManager',
      header: t.columns.projectManager,
      render: (project) => projectManagerText(project, currentUserId),
    },
    { id: 'entity', header: t.columns.entity, render: (project) => <EntityBadge entity={project.entity} /> },
  ]

  let content
  if (projects.status === 'loading') content = <Loading label={t.loading} />
  else if (projects.status === 'error') content = <LoadFailure error={projects.error} onRetry={projects.retry} />
  else if (projects.data!.total === 0)
    content = filtered ? (
      <StatePanel title={t.noMatchTitle}>{t.noMatchBody}</StatePanel>
    ) : (
      <StatePanel title={t.emptyTitle}>{canManage ? t.emptyBodyManage : t.emptyBodyRead}</StatePanel>
    )
  else
    content = (
      <div className="flex flex-col gap-3">
        <DataTable
          caption={t.caption}
          columns={columns}
          rows={projects.data!.items}
          getRowKey={(project) => project.id}
          interactiveRows
          testId="projects-table"
        />
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={projects.data!.total}
          onPageChange={setPage}
          label={strings.common.pagination.label}
          previousLabel={strings.common.pagination.previous}
          nextLabel={strings.common.pagination.next}
          status={strings.common.pagination.status}
          testId="projects-pagination"
        />
      </div>
    )

  return (
    <section aria-labelledby={titleId} data-testid="projects-page">
      <PageHeader
        title={t.heading}
        titleId={titleId}
        description={t.description}
        actions={
          canManage && (
            <Button
              variant="primary"
              onClick={() => setCreating(true)}
              aria-haspopup="dialog"
              data-testid="projects-new"
            >
              {t.newProject}
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-4">
        <Card title={t.filters}>
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
            <Field label={strings.common.search} hint={t.searchHint} testId="projects-search">
              {(control) => (
                <input
                  {...control}
                  type="search"
                  value={q}
                  onChange={(event) => {
                    setQ(event.target.value)
                    setPage(1)
                  }}
                />
              )}
            </Field>
            <Field label={t.type} testId="projects-type">
              {(control) => (
                <select
                  {...control}
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value as ProjectType | '')
                    setPage(1)
                  }}
                >
                  <option value="">{strings.common.any}</option>
                  {PROJECT_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {strings.badges.projectType[option]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t.state} testId="projects-state">
              {(control) => (
                <select
                  {...control}
                  value={state}
                  onChange={(event) => {
                    setState(event.target.value as ProjectState | '')
                    setPage(1)
                  }}
                >
                  <option value="">{strings.common.any}</option>
                  {PROJECT_STATES.map((option) => (
                    <option key={option} value={option}>
                      {strings.badges.projectState[option]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label={t.projectManager}
              hint={managers.status === 'error' ? t.managersFailed : undefined}
              testId="projects-manager"
            >
              {(control) => (
                <select
                  {...control}
                  value={projectManagerId}
                  onChange={(event) => {
                    setProjectManagerId(event.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">{strings.common.any}</option>
                  <option value={NO_PROJECT_MANAGER}>{t.noProjectManagerYet}</option>
                  {(managers.data?.items ?? []).map((manager) => (
                    <option key={manager.id} value={manager.id}>
                      {personName(manager, currentUserId)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </Card>
        {content}
      </div>
      {creating && (
        <ProjectFormDialog
          onCancel={() => setCreating(false)}
          onSaved={(project) => {
            setCreating(false)
            void navigate({ to: '/$id', params: { id: project.id } })
          }}
        />
      )}
    </section>
  )
}
