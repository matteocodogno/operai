import { useCallback, useId, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { Banner, Button, Card, DataTable, FactList, Icon, PageHeader, StatePanel, formatDate } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { EntityBadge, ProjectStateBadge, ProjectTypeBadge } from '../components/Badges'
import ProjectEditDialog from '../components/ProjectEditDialog'
import { LoadFailure, Loading, Saved, StaleWriteBanner } from '../components/LoadState'
import StateActions from '../components/StateActions'
import TeamCard from '../components/TeamCard'
import { useCurrentUserId } from '../hooks/useCurrentUserId'
import { useResource } from '../hooks/useResource'
import { useScope } from '../hooks/useScope'
import { statusOf } from '../lib/errors'
import { personName } from '../lib/people'
import { getProject } from '../lib/projectsApi'
import type { ContractSummary, Project } from '../lib/types'
import { strings } from '../strings'

const BackLink = () => (
  <Link to="/" className="link" data-testid="project-detail-back">
    <Icon name="arrow-left" /> {strings.project.back}
  </Link>
)

/** What the company row says: the client, how many clients a SaaS has, or "Internal" (AC-1.4). */
function companyFact(project: Project): { term: string; value: string } {
  const t = strings.project.details
  if (project.type === 'internal') return { term: t.company, value: t.internal }
  if (project.type === 'saas') {
    const clients = new Set(project.contracts.map((contract) => contract.company.id))
    return { term: t.clients, value: t.clientCount(clients.size) }
  }
  return { term: t.company, value: project.company?.name ?? t.companyUnavailable }
}

/** The contracts of a project, as a table of their headline facts (T14 adds each contract's terms). */
function ContractsList({ project }: { project: Project }) {
  const t = strings.project.contracts
  const columns: DataTableColumn<ContractSummary>[] = [
    {
      id: 'company',
      header: t.columns.company,
      rowHeader: true,
      render: (c) => c.company.name ?? t.companyUnavailable,
    },
    { id: 'origin', header: t.columns.origin, render: (c) => t.origin[c.origin] },
    { id: 'bexio', header: t.columns.bexio, render: (c) => c.bexioOrderId ?? strings.common.none },
    { id: 'start', header: t.columns.start, render: (c) => formatDate(c.startDate) },
    { id: 'end', header: t.columns.end, render: (c) => (c.endDate ? formatDate(c.endDate) : t.ongoing) },
  ]
  return (
    <Card title={t.title} data-testid="project-contracts">
      {project.type === 'internal' ? (
        <p className="text-sm text-soft">{t.internal}</p>
      ) : project.contracts.length === 0 ? (
        <p className="text-sm text-soft">{t.empty}</p>
      ) : (
        <DataTable caption={t.caption} columns={columns} rows={project.contracts} getRowKey={(c) => c.id} />
      )}
    </Card>
  )
}

/**
 * ProjectDetailPage — one project (US-1, AC-1.2 – AC-1.7): its details with the
 * derived dates, the team and the contracts. A holder of manage projects for the
 * project's entity gets the state actions, the type change, and the edit
 * dialogs; anyone else reads (the server's 403 is the gate, ADR-0014).
 */
export default function ProjectDetailPage() {
  const t = strings.project
  const { id } = useParams({ from: '/$id' })
  const titleId = useId()
  const currentUserId = useCurrentUserId()
  const load = useCallback((signal: AbortSignal) => getProject(id, { signal }), [id])
  const resource = useResource(load)
  const { canManageEntity } = useScope()
  const [saved, setSaved] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  if (resource.status === 'loading') return <Loading label={t.loading} />
  if (resource.status === 'error') {
    if (statusOf(resource.error) === 404)
      return (
        <section aria-labelledby={titleId}>
          <PageHeader title={t.notFoundTitle} titleId={titleId} back={<BackLink />} />
          <StatePanel role="alert" focusOnMount title={t.notFoundTitle} testId="project-not-found">
            {t.notFoundBody}
          </StatePanel>
        </section>
      )
    return <LoadFailure error={resource.error} onRetry={resource.retry} />
  }

  const project = resource.data!
  const canManage = canManageEntity(project.entity)
  const changed = (next: Project, message: string) => {
    resource.replace(next)
    setSaved(message)
    setStale(false)
    setActionError(null)
  }
  const company = companyFact(project)
  const dateFacts = [
    {
      id: 'start',
      term: t.details.startDate,
      value: project.startDate ? formatDate(project.startDate) : strings.common.none,
    },
    {
      id: 'end',
      term: t.details.endDate,
      value: project.endDate
        ? formatDate(project.endDate)
        : project.contracts.length > 0
          ? t.details.openEnded
          : strings.common.none,
    },
  ]

  return (
    <section aria-labelledby={titleId} data-testid="project-detail-page" data-project-id={project.id}>
      <PageHeader
        title={project.name}
        titleId={titleId}
        status={<ProjectStateBadge state={project.state} />}
        back={<BackLink />}
        actions={
          canManage && (
            <StateActions
              project={project}
              onChanged={changed}
              onStale={() => setStale(true)}
              onError={setActionError}
            />
          )
        }
      />
      <div className="flex flex-col gap-4">
        {stale && (
          <StaleWriteBanner
            onReload={() => {
              setStale(false)
              resource.retry()
            }}
          />
        )}
        {actionError && (
          <Banner
            tone="danger"
            title={t.errors.title}
            onDismiss={() => setActionError(null)}
            dismissLabel={strings.common.dismiss}
            data-testid="project-action-error"
          >
            {actionError}
          </Banner>
        )}
        {saved && <Saved message={saved} onDismiss={() => setSaved(null)} />}
        {!canManage && <Banner tone="info">{t.readOnly}</Banner>}
        <Card
          title={t.details.title}
          action={
            canManage && (
              <Button size="sm" aria-haspopup="dialog" onClick={() => setEditing(true)} data-testid="project-edit">
                {t.details.edit}
              </Button>
            )
          }
        >
          <FactList
            testId="project-facts"
            items={[
              { id: 'type', term: t.details.type, value: <ProjectTypeBadge type={project.type} /> },
              { id: 'entity', term: t.details.entity, value: <EntityBadge entity={project.entity} /> },
              { id: 'company', term: company.term, value: company.value },
              { id: 'pm', term: t.details.projectManager, value: personName(project.projectManager, currentUserId) },
              ...dateFacts,
            ]}
          />
        </Card>
        <TeamCard
          project={project}
          currentUserId={currentUserId}
          canManage={canManage}
          onSaved={(next) => changed(next, t.saved.team)}
          onStale={() => setStale(true)}
        />
        <ContractsList project={project} />
      </div>
      {editing && (
        <ProjectEditDialog
          project={project}
          currentUserId={currentUserId}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false)
            changed(next, t.saved.details)
          }}
          onStale={() => {
            setEditing(false)
            setStale(true)
          }}
        />
      )}
    </section>
  )
}
