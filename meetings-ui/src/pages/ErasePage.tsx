import {
  Banner,
  Button,
  Card,
  DataTable,
  DateInput,
  Field,
  PageHeader,
  PersonPicker,
  Pagination,
  StatePanel,
  formatDate,
} from '@operai/ui'
import type { DataTableColumn, PersonChoice, PersonLoadFailure } from '@operai/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { LoadFailure, Loading, Saved } from '../components/LoadState'
import DeleteMeetingDialog from '../components/meeting/DeleteMeetingDialog'
import PermissionDenied from '../components/PermissionDenied'
import { useResource } from '../hooks/useResource'
import { ApiError } from '../lib/api'
import { statusOf } from '../lib/errors'
import { listDirectory, listEraseMeetings } from '../lib/meetingsApi'
import type { EraseRow, PersonRef } from '../lib/types'
import { strings } from '../strings'

const HEADING_ID = 'meetings-erase-page-heading'
const PAGE_SIZE = 25
const DEFAULT_RETRY_SECONDS = 60

type Filters = { q: string; creator: PersonChoice | null; from: string; to: string }
const NO_FILTERS: Filters = { q: '', creator: null, from: '', to: '' }

const hasFilters = (filters: Filters) =>
  filters.q.trim() !== '' || filters.creator !== null || filters.from !== '' || filters.to !== ''

const creatorName = (person: PersonRef): string =>
  person.name ?? (person.status === 'deleted' ? strings.erase.deletedUser : strings.erase.unknownUser)

const classifyDirectoryError = (error: unknown): PersonLoadFailure => {
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: 'forbidden' }
    if (error.status === 429) {
      return { kind: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS }
    }
  }
  return { kind: 'failed' }
}

const loadDirectory = async (signal: AbortSignal) => (await listDirectory({ signal })).users

/**
 * Erase (specs/021-meetings S9, T75; AC-4.6, AC-4.7, AC-4.8, AC-5.12) — for holders of
 * `meeting:erase`: find a meeting by title, creator or date and delete it. The list shows title,
 * date and creator ONLY, and nothing in it links to the meeting: holding the role never grants
 * reading content (AC-4.8). Filters apply on Search, not per keystroke. The tab is hidden without
 * the permission hint, but the server decides: a 403 is the page-level denial.
 */
export default function ErasePage() {
  const t = strings.erase
  const [draft, setDraft] = useState<Filters>(NO_FILTERS)
  const [applied, setApplied] = useState<Filters>(NO_FILTERS)
  const [pageNumber, setPageNumber] = useState(1)
  const [reload, setReload] = useState(0)
  const [toError, setToError] = useState<string | null>(null)
  const [pickerKey, setPickerKey] = useState(0)
  const [deleting, setDeleting] = useState<EraseRow | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [focusRegion, setFocusRegion] = useState(0)
  const regionRef = useRef<HTMLDivElement>(null)

  const fetcher = useCallback(
    (signal: AbortSignal) =>
      listEraseMeetings(
        {
          q: applied.q.trim(),
          creatorId: applied.creator?.id,
          from: applied.from,
          to: applied.to,
          page: pageNumber > 1 ? pageNumber : undefined,
        },
        { signal },
      ),
    // `reload` is not read: bumping it is how the list is asked for again after the last row of a page went.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applied, pageNumber, reload],
  )
  const resource = useResource(fetcher)

  // Rows deleted from the list that is on screen; they disappear at once, and a new list starts clean.
  const [removal, setRemoval] = useState<{ fetcher: typeof fetcher; ids: readonly string[] }>({ fetcher, ids: [] })
  const removedIds = removal.fetcher === fetcher ? removal.ids : []

  useEffect(() => {
    if (focusRegion > 0) regionRef.current?.focus()
  }, [focusRegion])

  const search = (event: FormEvent) => {
    event.preventDefault()
    if (draft.from !== '' && draft.to !== '' && draft.to < draft.from) {
      setToError(t.filters.toBeforeFrom)
      return
    }
    setToError(null)
    setApplied(draft)
    setPageNumber(1)
  }

  const clear = () => {
    setDraft(NO_FILTERS)
    setApplied(NO_FILTERS)
    setPageNumber(1)
    setToError(null)
    setPickerKey((key) => key + 1)
  }

  const deleted = (row: EraseRow, remaining: number, total: number) => {
    setRemoval({ fetcher, ids: [...removedIds, row.id] })
    setDeleting(null)
    setSaved(t.deleted)
    setFocusRegion((count) => count + 1)
    // The page emptied but more meetings exist: ask for the list again instead of showing a blank page.
    if (remaining === 0 && total > 0) setReload((count) => count + 1)
  }

  const columns: DataTableColumn<EraseRow>[] = [
    { id: 'title', header: t.table.title, rowHeader: true, render: (row) => row.title },
    { id: 'date', header: t.table.date, render: (row) => formatDate(row.startsAt) },
    { id: 'creator', header: t.table.creator, render: (row) => creatorName(row.creator) },
    {
      id: 'actions',
      header: t.table.actions,
      render: (row) => (
        <Button
          variant="danger"
          size="sm"
          aria-haspopup="dialog"
          aria-label={t.table.deleteAria(row.title)}
          onClick={() => setDeleting(row)}
        >
          {t.table.delete}
        </Button>
      ),
    },
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
    const data = resource.data
    if (data === null) return null
    const rows = data.items.filter((row) => !removedIds.includes(row.id))
    const total = Math.max(0, data.total - removedIds.length)
    if (rows.length === 0) {
      return (
        <StatePanel title={t.empty.title} testId="meetings-erase-empty">
          {t.empty.body}
        </StatePanel>
      )
    }
    return (
      <>
        <div
          ref={regionRef}
          role="region"
          aria-label={t.table.caption}
          tabIndex={-1}
          data-testid="meetings-erase-table-region"
        >
          <DataTable
            caption={t.table.caption}
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            testId="meetings-erase-table"
          />
        </div>
        <Pagination
          page={data.page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPageNumber}
          label={t.pagination.label}
          previousLabel={t.pagination.previous}
          nextLabel={t.pagination.next}
          status={(status) =>
            t.pagination.status(status.page, status.totalPages, status.rangeStart, status.rangeEnd, status.total)
          }
          testId="meetings-erase-pagination"
        />
        {deleting !== null && (
          <DeleteMeetingDialog
            meeting={deleting}
            onClose={() => setDeleting(null)}
            onDeleted={() => deleted(deleting, rows.length - 1, total - 1)}
          />
        )}
      </>
    )
  }

  return (
    <section aria-labelledby={HEADING_ID} data-testid="meetings-erase-page">
      <PageHeader title={t.heading} titleId={HEADING_ID} />
      <div className="flex flex-col gap-4">
        <Banner tone="info">{t.notice}</Banner>

        <Card title={t.filters.title}>
          <form onSubmit={search} noValidate className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.filters.search}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    value={draft.q}
                    onChange={(event) => setDraft({ ...draft, q: event.target.value })}
                  />
                )}
              </Field>
              <PersonPicker
                key={pickerKey}
                label={t.filters.creator}
                load={loadDirectory}
                classifyError={classifyDirectoryError}
                value={draft.creator}
                onChange={(creator) => setDraft((current) => ({ ...current, creator }))}
                testId="meetings-erase-creator"
                copy={t.picker}
              />
              <Field label={t.filters.from}>
                {(control) => (
                  <DateInput
                    {...control}
                    value={draft.from}
                    onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t.filters.to} error={toError}>
                {(control) => (
                  <DateInput
                    {...control}
                    value={draft.to}
                    onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                  />
                )}
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary">
                {t.filters.submit}
              </Button>
              {(hasFilters(draft) || hasFilters(applied)) && (
                <Button variant="ghost" onClick={clear}>
                  {t.filters.clear}
                </Button>
              )}
            </div>
          </form>
        </Card>

        {saved !== null && <Saved message={saved} onDismiss={() => setSaved(null)} />}
        {content()}
      </div>
    </section>
  )
}
