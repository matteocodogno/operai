import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Badge, Card, DataTable, PageHeader, StatePanel, buttonClassName, formatNumber } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { LoadFailure, Loading, Saved } from '../components/LoadState'
import PermissionDenied from '../components/PermissionDenied'
import { useResource } from '../hooks/useResource'
import { statusOf } from '../lib/errors'
import { listTemplates } from '../lib/meetingsApi'
import type { Template, TemplateSource } from '../lib/types'
import { strings } from '../strings'

// What a templates page tells the next one (history state: nothing to bookmark, gone on a fresh visit).
declare module '@tanstack/react-router' {
  interface HistoryState {
    templatesNotice?: 'saved' | 'deleted' | 'copied'
  }
}

const fetchTemplates = (signal: AbortSignal) => listTemplates({}, { signal })

/** AC-8.5 order, minus "recommended", which only exists for a meeting's picker. */
const GROUPS: readonly TemplateSource[] = ['personal', 'shared', 'builtin']

/**
 * Templates list (specs/021-meetings S7, T74): the caller's personal templates, the shared ones and
 * the built-in ones, in three cards, each a table of name, number of sections and type. A built-in
 * group is never empty; the other two say so and point at duplicating.
 */
export default function TemplatesPage() {
  const t = strings.templates
  const resource = useResource(fetchTemplates)
  const notice = useRouterState({ select: (state) => state.location.state.templatesNotice })
  const [noticeDismissed, setNoticeDismissed] = useState(false)

  const columns: DataTableColumn<Template>[] = [
    {
      id: 'name',
      header: t.table.name,
      rowHeader: true,
      render: (row) => (
        <Link to="/templates/$id" params={{ id: row.id }} className="link">
          {row.name}
        </Link>
      ),
    },
    { id: 'sections', header: t.table.sections, numeric: true, render: (row) => formatNumber(row.sections.length) },
    { id: 'type', header: t.table.type, render: (row) => <Badge>{t.type[row.source]}</Badge> },
  ]

  const content = () => {
    if (resource.status === 'loading') return <Loading label={t.loading} />
    if (resource.status === 'error') {
      // A 403 on a page load is the whole page being off limits, whatever code it carries.
      return statusOf(resource.error) === 403 ? (
        <PermissionDenied />
      ) : (
        <LoadFailure error={resource.error} onRetry={resource.retry} />
      )
    }
    const items = resource.data?.items ?? []
    return GROUPS.map((source) => {
      const rows = items.filter((item) => item.source === source)
      return (
        <Card key={source} title={t.groups[source]} data-testid={`meetings-templates-${source}`}>
          {rows.length > 0 ? (
            <DataTable
              caption={t.groups[source]}
              columns={columns}
              rows={rows}
              getRowKey={(row) => row.id}
              interactiveRows
              testId={`meetings-templates-table-${source}`}
            />
          ) : source === 'builtin' ? null : (
            <StatePanel title={t.empty[source].title} headingLevel={4}>
              {t.empty[source].body}
            </StatePanel>
          )}
        </Card>
      )
    })
  }

  return (
    <section aria-labelledby="meetings-templates-page-heading" data-testid="meetings-templates-page">
      <PageHeader
        title={t.heading}
        titleId="meetings-templates-page-heading"
        description={t.description}
        actions={
          <Link to="/templates/new" className={buttonClassName({ variant: 'primary' })}>
            {t.newTemplate}
          </Link>
        }
      />
      <div className="flex flex-col gap-4">
        {notice === 'deleted' && !noticeDismissed && (
          <Saved message={t.notice.deleted} onDismiss={() => setNoticeDismissed(true)} />
        )}
        {content()}
      </div>
    </section>
  )
}
