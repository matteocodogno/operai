import { useCallback, useId, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { Banner, Button, Card, FactList, Icon, PageHeader, StatePanel, formatDate } from '@operai/ui'
import { EntityBadge, ProjectStateBadge, ProjectTypeBadge } from '../components/Badges'
import ContractCard from '../components/ContractCard'
import ContractFormDialog from '../components/ContractFormDialog'
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
import type { Project } from '../lib/types'
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

/**
 * The contracts of a project (AC-1.5, AC-2.2): one card each, and "Add contract"
 * for a holder of manage projects. An internal project has none; a closed or
 * cancelled one takes no new contract (its existing ones stay editable, so the
 * cards keep their controls).
 */
function ContractsCard({
  project,
  canManage,
  onAdd,
  onChanged,
  onStale,
}: {
  project: Project
  canManage: boolean
  onAdd: () => void
  onChanged: (message: string) => void
  onStale: () => void
}) {
  const t = strings.contracts
  const open = project.state !== 'closed' && project.state !== 'cancelled'
  const canAdd = canManage && project.type !== 'internal' && open
  return (
    <Card
      title={t.title}
      data-testid="project-contracts"
      action={
        canAdd && (
          <Button size="sm" aria-haspopup="dialog" onClick={onAdd} data-testid="project-contract-add">
            {t.add}
          </Button>
        )
      }
    >
      {project.type === 'internal' ? (
        <p className="text-sm text-soft">{t.internal}</p>
      ) : (
        <>
          {canManage && !open && <p className="text-sm text-soft">{t.notOpen}</p>}
          {project.contracts.length === 0 ? (
            <p className="text-sm text-soft">{t.empty}</p>
          ) : (
            <div className="flex flex-col divide-y divide-rule">
              {project.contracts.map((contract) => (
                <ContractCard
                  key={contract.id}
                  project={project}
                  contract={contract}
                  canManage={canManage}
                  onChanged={onChanged}
                  onStale={onStale}
                />
              ))}
            </div>
          )}
        </>
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
  const [addingContract, setAddingContract] = useState(false)

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
  // A contract write changes what the project derives from its contracts (dates, the list): read it again.
  const contractChanged = (message: string) => {
    setSaved(message)
    setStale(false)
    setActionError(null)
    getProject(id).then(resource.replace, () => resource.retry())
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
        <ContractsCard
          project={project}
          canManage={canManage}
          onAdd={() => setAddingContract(true)}
          onChanged={contractChanged}
          onStale={() => setStale(true)}
        />
      </div>
      {addingContract && (
        <ContractFormDialog
          project={project}
          onCancel={() => setAddingContract(false)}
          onSaved={() => {
            setAddingContract(false)
            contractChanged(strings.contracts.saved.created)
          }}
          onStale={() => {
            setAddingContract(false)
            setStale(true)
          }}
        />
      )}
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
