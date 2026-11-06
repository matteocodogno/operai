import { useCallback, useId, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Banner, Button, Card, DataTable, Field, formatDate, PageHeader, StatePanel } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { EntityBadge } from '../components/Badges'
import { LoadFailure, Loading } from '../components/LoadState'
import PermissionDenied from '../components/PermissionDenied'
import TakeDealDialog from '../components/TakeDealDialog'
import { useResource } from '../hooks/useResource'
import { useScope } from '../hooks/useScope'
import { codeOf } from '../lib/errors'
import { ENTITIES } from '../lib/domain'
import { crmDealHref, estimaiEstimateHref } from '../lib/links'
import { listQueue } from '../lib/projectsApi'
import type { Entity, QueueItem } from '../lib/types'
import { strings } from '../strings'

/**
 * QueuePage — the to-start queue (US-1, AC-1.1): the won deals no project has
 * taken, newest won first, each with its title (a link to the deal in the CRM),
 * company, entity, won date and — when it has one — the estimate in EstimAI. No
 * amount exists on the page (D14). Search and entity are the server's filters.
 *
 * The queue is for those who may take a deal — `scope.take` non-empty: `sales`
 * and admins (D37, AC-1.9). Anyone else gets the permission-denied state and the
 * API is not asked (the server answers them 403 too).
 *
 * The queue is computed by projects-api on every read ("won in the CRM" minus
 * "has a purchase order"), so this page keeps no list of its own: a deal
 * reopened in the CRM (AC-2.1) or taken meanwhile (AC-1.6) is simply absent from
 * the next load. crm-api down is its own state (503 `crm_unavailable`), never an
 * empty queue. The list is capped at the newest 500 (A26) and says so when it is.
 *
 * A taker with manage projects for a deal's entity takes it (AC-1.2): "New
 * project", a dialog that also asks the PO's dates and terms, its ops-manager and
 * its optional referent (no project manager: the ops-manager picks one afterwards,
 * D42). There is no attaching a deal to an existing project (D39). The action is UX gating on the
 * entities (`GET /scope`); the server's 403 `out_of_scope` is the gate. A take
 * lands the user on the project; a deal that turns out to be taken or no longer
 * won reloads the queue behind the dialog, which keeps saying why.
 */
export default function QueuePage() {
  const { canTake } = useScope()
  return canTake ? <Queue /> : <PermissionDenied />
}

function Queue() {
  const t = strings.queue
  const titleId = useId()
  const navigate = useNavigate()
  const { canManage, canTakeEntity, canManageEntity } = useScope()
  const [q, setQ] = useState('')
  const [entity, setEntity] = useState<Entity | ''>('')
  const [taking, setTaking] = useState<QueueItem | null>(null)

  const filtered = q.trim() !== '' || entity !== ''
  const load = useCallback((signal: AbortSignal) => listQueue({ q: q.trim(), entity }, { signal }), [q, entity])
  const queue = useResource(load)

  const columns: DataTableColumn<QueueItem>[] = [
    {
      id: 'deal',
      header: t.columns.deal,
      rowHeader: true,
      render: (item) => (
        <a href={crmDealHref(item.dealId)} className="link">
          {item.title}
        </a>
      ),
    },
    { id: 'company', header: t.columns.company, render: (item) => item.company.name ?? t.companyUnavailable },
    { id: 'entity', header: t.columns.entity, render: (item) => <EntityBadge entity={item.entity} /> },
    {
      id: 'won',
      header: t.columns.won,
      render: (item) => (item.wonAt === null ? strings.common.none : formatDate(item.wonAt)),
    },
    {
      id: 'estimate',
      header: t.columns.estimate,
      render: (item) =>
        item.estimate === null ? (
          strings.common.none
        ) : (
          <a href={estimaiEstimateHref(item.estimate.id)} className="link">
            {item.estimate.name}
          </a>
        ),
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: t.take.actions.column,
            // The server needs `handoff:take` and `project:manage` for the deal's entity (S3).
            render: (item: QueueItem) =>
              canTakeEntity(item.entity) &&
              canManageEntity(item.entity) && (
                <Button
                  size="sm"
                  aria-haspopup="dialog"
                  aria-label={t.take.actions.newProjectFor(item.title)}
                  onClick={() => setTaking(item)}
                >
                  {t.take.actions.newProject}
                </Button>
              ),
          },
        ]
      : []),
  ]

  let content
  if (queue.status === 'loading') content = <Loading label={t.loading} />
  else if (queue.status === 'error')
    content =
      codeOf(queue.error) === 'crm_unavailable' ? (
        <Banner
          tone="warning"
          data-testid="queue-crm-unavailable"
          title={t.crmUnavailable.title}
          onRetry={queue.retry}
          retryLabel={strings.common.retry}
        >
          {t.crmUnavailable.body}
        </Banner>
      ) : (
        <LoadFailure error={queue.error} onRetry={queue.retry} />
      )
  else if (queue.data!.items.length === 0)
    content = filtered ? (
      <StatePanel title={t.noMatchTitle}>{t.noMatchBody}</StatePanel>
    ) : (
      <StatePanel title={t.emptyTitle}>{t.emptyBody}</StatePanel>
    )
  else
    content = (
      <div className="flex flex-col gap-3">
        <DataTable
          caption={t.caption}
          columns={columns}
          rows={queue.data!.items}
          getRowKey={(item) => item.dealId}
          rowTestIdPrefix="queue-row"
          testId="queue-table"
        />
        {queue.data!.truncated && (
          <p className="text-sm text-soft" data-testid="queue-truncated">
            {t.truncated}
          </p>
        )}
      </div>
    )

  return (
    <section aria-labelledby={titleId} data-testid="queue-page">
      <PageHeader title={t.heading} titleId={titleId} description={t.description} />
      <div className="flex flex-col gap-4">
        <Card title={t.filters}>
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
            <Field label={strings.common.search} hint={t.searchHint} testId="queue-search">
              {(control) => (
                <input {...control} type="search" value={q} onChange={(event) => setQ(event.target.value)} />
              )}
            </Field>
            <Field label={t.entity} testId="queue-entity">
              {(control) => (
                <select {...control} value={entity} onChange={(event) => setEntity(event.target.value as Entity | '')}>
                  <option value="">{strings.common.any}</option>
                  {ENTITIES.map((option) => (
                    <option key={option} value={option}>
                      {strings.badges.entity[option]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </Card>
        {content}
      </div>
      {taking && (
        <TakeDealDialog
          deal={taking}
          onCancel={() => setTaking(null)}
          onGone={queue.retry}
          onTaken={(project) => {
            setTaking(null)
            void navigate({ to: '/$id', params: { id: project.id } })
          }}
        />
      )}
    </section>
  )
}
