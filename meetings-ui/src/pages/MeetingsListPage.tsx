import { useCallback, useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Badge,
  Button,
  Card,
  DataTable,
  PageHeader,
  Pagination,
  StatePanel,
  StatusBadge,
  buttonClassName,
  formatDateTime,
} from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import { LoadFailure, Loading } from '../components/LoadState'
import { useCapabilityHints } from '../hooks/useCapabilityHints'
import { useResource } from '../hooks/useResource'
import { describeHost, hostNames, suiteLinkProps, useHosts } from '../lib/hostLinks'
import { listMeetings } from '../lib/meetingsApi'
import { MEETING_STATUS_MEANING } from '../lib/statusMeanings'
import type { DerivedStatus, HostInfo, MeetingRow } from '../lib/types'
import { strings } from '../strings'

export type MeetingsListPageProps = {
  /** `true` in `./MyMeetings` (identity-scoped entry, no tool frame), `false` in `./App` (design.md S1). */
  mine: boolean
}

const PAGE_SIZE = 25
/** A pause in typing this long searches (design.md S1); Enter searches at once. */
const SEARCH_DEBOUNCE_MS = 300

const STATUSES: readonly DerivedStatus[] = ['draft', 'recording', 'interrupted', 'processing', 'ready', 'failed']

type Filters = {
  q: string
  role: '' | 'creator' | 'participant'
  status: '' | DerivedStatus
  hostApp: string
  page: number
}

const NO_FILTERS: Filters = { q: '', role: '', status: '', hostApp: '', page: 1 }

/** One option per registered app (an app may register several entity kinds), labelled in the page language. */
const hostAppOptions = (hosts: HostInfo[] | null) => {
  const seen = new Map<string, string>()
  for (const host of hosts ?? []) {
    if (!seen.has(host.app)) seen.set(host.app, hostNames(hosts, host.app, host.entityType).app)
  }
  return Array.from(seen, ([value, label]) => ({ value, label }))
}

function HostCell({ row, hosts }: { row: MeetingRow; hosts: HostInfo[] | null }) {
  if (row.host === null) return <>{strings.list.host.standalone}</>
  const host = describeHost(row.host, hosts)
  if (host.kind === 'missing') return <span className="text-soft">{strings.list.host.missing}</span>
  if (host.kind === 'plain') return <>{host.text}</>
  return (
    <a className="link" {...suiteLinkProps(host.href)}>
      {host.text}
    </a>
  )
}

/**
 * The meetings list, for both entries (specs/021-meetings S1, T55): what the caller created or
 * takes part in, newest first, 25 per page, filtered on the server. `./MyMeetings` shows it with no
 * tool frame, so its links to the tool (New meeting, Templates) go through the shell's router.
 *
 * A self-scoped read: it survives an `auth` outage, so there is no 503 state here; the host labels
 * are decoration and degrade silently.
 */
export default function MeetingsListPage({ mine }: MeetingsListPageProps) {
  const t = strings.list
  const { canUseMeetings } = useCapabilityHints()
  const hosts = useHosts()
  const searchId = useId()
  const roleId = useId()
  const statusId = useId()
  const hostAppId = useId()

  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [searchText, setSearchText] = useState('')
  const [knownTotal, setKnownTotal] = useState(0)

  // Typing searches after a pause; the applied value is what the request carries.
  const typed = searchText.trim()
  useEffect(() => {
    if (typed === filters.q) return
    const timer = setTimeout(() => setFilters((current) => ({ ...current, q: typed, page: 1 })), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed, filters.q])

  const { q, role, status, hostApp, page } = filters
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      listMeetings(
        {
          q,
          page,
          ...(role ? { role } : {}),
          ...(status ? { status } : {}),
          ...(hostApp ? { hostApp } : {}),
        },
        { signal },
      ),
    [q, role, status, hostApp, page],
  )
  const resource = useResource(fetcher)

  // The pager outlives a page change (focus stays on the button just pressed), so the last total is kept.
  if (resource.status === 'ready' && resource.data !== null && resource.data.total !== knownTotal) {
    setKnownTotal(resource.data.total)
  }

  const change = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch, page: 1 }))
  const search = (event: FormEvent) => {
    event.preventDefault()
    change({ q: typed })
  }
  const clear = () => {
    setSearchText('')
    setFilters(NO_FILTERS)
  }
  const filtered = q !== '' || role !== '' || status !== '' || hostApp !== ''

  const columns: DataTableColumn<MeetingRow>[] = [
    {
      id: 'title',
      header: t.table.title,
      rowHeader: true,
      render: (row) => (
        <Link to="/m/$id" params={{ id: row.id }} className="link">
          {row.title}
        </Link>
      ),
    },
    { id: 'date', header: t.table.date, render: (row) => formatDateTime(row.startsAt) },
    { id: 'format', header: t.table.format, render: (row) => t.format[row.format] },
    { id: 'host', header: t.table.host, render: (row) => <HostCell row={row} hosts={hosts} /> },
    {
      id: 'status',
      header: t.table.status,
      render: (row) => (
        <StatusBadge status={MEETING_STATUS_MEANING[row.status]}>
          {strings.common.status.meeting[row.status]}
        </StatusBadge>
      ),
    },
    { id: 'role', header: t.table.role, render: (row) => <Badge>{t.role[row.role]}</Badge> },
  ]

  const actions = canUseMeetings ? (
    mine ? (
      <>
        <a className={buttonClassName({ variant: 'secondary' })} {...suiteLinkProps('/meetings/templates')}>
          {strings.nav.tabs.templates}
        </a>
        <a className={buttonClassName({ variant: 'primary' })} {...suiteLinkProps('/meetings/new')}>
          {t.newMeeting}
        </a>
      </>
    ) : (
      <Link to="/new" className={buttonClassName({ variant: 'primary' })}>
        {t.newMeeting}
      </Link>
    )
  ) : undefined

  const results = () => {
    if (resource.status === 'loading') return <Loading label={t.loading} />
    if (resource.status === 'error') return <LoadFailure error={resource.error} onRetry={resource.retry} />
    const items = resource.data?.items ?? []
    if (items.length === 0) {
      return filtered ? (
        <StatePanel title={t.empty.filtered.title} testId="meetings-list-empty-filtered">
          {t.empty.filtered.body}
        </StatePanel>
      ) : (
        <StatePanel title={t.empty.none.title} testId="meetings-list-empty">
          {t.empty.none.body}
        </StatePanel>
      )
    }
    return (
      <DataTable
        caption={t.table.caption}
        columns={columns}
        rows={items}
        getRowKey={(row) => row.id}
        interactiveRows
        testId="meetings-list-table"
        rowTestIdPrefix="meetings-list-row"
      />
    )
  }

  return (
    <section aria-labelledby="meetings-list-page-heading" data-testid="meetings-list-page">
      <PageHeader title={mine ? t.myHeading : t.heading} titleId="meetings-list-page-heading" actions={actions} />
      <div className="flex flex-col gap-4">
        <Card>
          <form role="search" aria-label={t.filters.title} onSubmit={search} className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <label htmlFor={searchId} className="field-label">
                {t.filters.search}
              </label>
              <input
                id={searchId}
                type="search"
                value={searchText}
                placeholder={t.filters.searchPlaceholder}
                onChange={(event) => setSearchText(event.target.value)}
                data-testid="meetings-list-search"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={roleId} className="field-label">
                {t.filters.role}
              </label>
              <select
                id={roleId}
                value={role}
                onChange={(event) => change({ role: event.target.value as Filters['role'] })}
              >
                <option value="">{t.filters.all}</option>
                <option value="creator">{t.role.creator}</option>
                <option value="participant">{t.role.participant}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={statusId} className="field-label">
                {t.filters.status}
              </label>
              <select
                id={statusId}
                value={status}
                onChange={(event) => change({ status: event.target.value as Filters['status'] })}
              >
                <option value="">{t.filters.all}</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {strings.common.status.meeting[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={hostAppId} className="field-label">
                {t.filters.hostApp}
              </label>
              <select id={hostAppId} value={hostApp} onChange={(event) => change({ hostApp: event.target.value })}>
                <option value="">{t.filters.all}</option>
                {hostAppOptions(hosts).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {(filtered || searchText !== '') && (
              <Button variant="ghost" onClick={clear} data-testid="meetings-list-clear">
                {t.filters.clear}
              </Button>
            )}
          </form>
        </Card>

        {results()}

        {knownTotal > PAGE_SIZE && resource.status !== 'error' && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={knownTotal}
            onPageChange={(next) => setFilters((current) => ({ ...current, page: next }))}
            label={t.pagination.label}
            previousLabel={t.pagination.previous}
            nextLabel={t.pagination.next}
            status={(s) => t.pagination.status(s.page, s.totalPages, s.rangeStart, s.rangeEnd, s.total)}
            testId="meetings-list-pagination"
          />
        )}
      </div>
    </section>
  )
}
