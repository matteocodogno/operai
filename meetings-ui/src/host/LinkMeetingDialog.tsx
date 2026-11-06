import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Dialog, Pagination, RadioGroupField, StatePanel, formatDate } from '@operai/ui'
import { LoadFailure, Loading } from '../components/LoadState'
import PermissionDenied from '../components/PermissionDenied'
import { useResource } from '../hooks/useResource'
import { codeOf, errorMessage, isAuthUnavailable, statusOf } from '../lib/errors'
import { describeHost } from '../lib/hostLinks'
import { listLinkableMeetings, updateMeeting } from '../lib/meetingsApi'
import type { HostInfo, Meeting, MeetingRow } from '../lib/types'
import { strings } from '../strings'

const PAGE_SIZE = 25
const SEARCH_DEBOUNCE_MS = 300

export type LinkMeetingDialogProps = {
  hostApp: string
  entityType: string
  entityId: string
  /** The entity word in the page language, lower case ("deal"), for the sentences that name it. */
  entityLabel: string
  hosts: HostInfo[] | null
  onClose: () => void
  /** The meeting was linked: the answer of `PATCH /meetings/:id`. */
  onLinked: (meeting: Meeting) => void
}

/**
 * LinkMeetingDialog — "Link an existing meeting" (specs/021-meetings F1b, S6, T76; plan G2). Lists the
 * caller's own meetings that can be linked to this record (`GET /hosts/:app/:type/:id/linkable-meetings`:
 * created by them, not frozen, not already on it) and links the chosen one with
 * `PATCH /meetings/:id { host }`. The host resolves the record as the caller on that request, so a
 * record that cannot be checked is never linked (AC-11.6). A `Dialog` and not a `FormDialog`: Enter in
 * the search field searches, it must never link.
 */
export default function LinkMeetingDialog({
  hostApp,
  entityType,
  entityId,
  entityLabel,
  hosts,
  onClose,
  onLinked,
}: LinkMeetingDialogProps) {
  const t = strings.host.dialog
  const cancelRef = useRef<HTMLButtonElement>(null)

  const [searchText, setSearchText] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [chosen, setChosen] = useState<MeetingRow | null>(null)
  const [knownTotal, setKnownTotal] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const typed = searchText.trim()
  useEffect(() => {
    if (typed === q) return
    const timer = setTimeout(() => {
      setQ(typed)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed, q])

  const fetcher = useCallback(
    (signal: AbortSignal) => listLinkableMeetings(hostApp, entityType, entityId, { q, page }, { signal }),
    [hostApp, entityType, entityId, q, page],
  )
  const resource = useResource(fetcher)

  // The pager outlives a page change, so the last total is kept (focus stays on the button just pressed).
  if (resource.status === 'ready' && resource.data !== null && resource.data.total !== knownTotal) {
    setKnownTotal(resource.data.total)
  }

  const search = (event: FormEvent) => {
    event.preventDefault()
    setQ(typed)
    setPage(1)
  }

  const where = (row: MeetingRow): string => {
    if (row.host === null) return t.standalone
    const host = describeHost(row.host, hosts)
    return host.kind === 'missing' ? t.missing : host.text
  }

  const movedFrom = chosen?.host != null && describeHost(chosen.host, hosts).kind !== 'missing' ? where(chosen) : null

  const link = async () => {
    if (chosen === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const linked = await updateMeeting(chosen.id, { host: { app: hostApp, entityType, entityId } })
      onLinked(linked)
    } catch (failure) {
      setBusy(false)
      const status = statusOf(failure)
      const code = codeOf(failure)
      if (status === 404) {
        // Deleted since the list was loaded: say so, drop the choice, show what is left.
        setError(t.errors.gone)
        setChosen(null)
        resource.retry()
      } else if (status === 422 && (code === 'host_entity_not_found' || code === 'host_not_registered')) {
        setError(t.errors.cannotLink)
      } else if (code === 'host_unavailable') {
        setError(t.errors.unavailable(entityLabel))
      } else {
        setError(isAuthUnavailable(failure) ? strings.common.authUnavailable.body : errorMessage(failure))
      }
    }
  }

  const list = () => {
    if (resource.status === 'loading') return <Loading label={t.loading} rows={2} />
    if (resource.status === 'error') {
      return statusOf(resource.error) === 403 ? (
        <PermissionDenied />
      ) : (
        <LoadFailure error={resource.error} onRetry={resource.retry} />
      )
    }
    const items = resource.data?.items ?? []
    if (items.length === 0) {
      return (
        <StatePanel title={t.empty.title} testId="meetings-link-empty">
          {t.empty.body(entityLabel)}
        </StatePanel>
      )
    }
    return (
      <RadioGroupField label={t.choose} required>
        <div className="flex w-full flex-col gap-2" data-testid="meetings-link-list">
          {items.map((row) => (
            <label key={row.id} className="flex items-start gap-2">
              <input
                type="radio"
                name="meetings-link-choice"
                value={row.id}
                checked={chosen?.id === row.id}
                onChange={() => {
                  setChosen(row)
                  setError(null)
                }}
              />
              <span className="flex flex-col">
                <span>{row.title}</span>
                <span className="text-xs text-soft">
                  {strings.host.panel.row.meta(formatDate(row.startsAt), where(row))}
                </span>
              </span>
            </label>
          ))}
        </div>
      </RadioGroupField>
    )
  }

  return (
    <Dialog
      title={t.title}
      size="md"
      onClose={onClose}
      dismissOnBackdrop={false}
      closeLabel={strings.common.close}
      busy={busy}
      fallbackFocusRef={cancelRef}
      testIdPrefix="meetings-link-dialog"
    >
      <div className="dialog-body flex flex-col gap-3">
        <form role="search" onSubmit={search}>
          <label htmlFor="meetings-link-search" className="field-label">
            {t.search}
          </label>
          <input
            id="meetings-link-search"
            type="search"
            value={searchText}
            placeholder={t.searchPlaceholder}
            disabled={busy}
            onChange={(event) => setSearchText(event.target.value)}
            data-testid="meetings-link-search"
          />
        </form>

        <fieldset disabled={busy} className="dialog-fields">
          {list()}
        </fieldset>

        {knownTotal > PAGE_SIZE && resource.status !== 'error' && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={knownTotal}
            onPageChange={setPage}
            label={t.pagination.label}
            previousLabel={t.pagination.previous}
            nextLabel={t.pagination.next}
            status={(s) =>
              strings.host.panel.pagination.status(s.page, s.totalPages, s.rangeStart, s.rangeEnd, s.total)
            }
            testId="meetings-link-pagination"
          />
        )}

        {movedFrom !== null && <p className="text-sm text-soft">{t.moved(movedFrom, entityLabel)}</p>}
      </div>

      {error !== null && (
        <p role="alert" className="form-error dialog-body" data-testid="meetings-link-error">
          {error}
        </p>
      )}

      <div className="dialog-footer">
        <Button ref={cancelRef} variant="ghost" onClick={onClose} disabled={busy}>
          {strings.common.cancel}
        </Button>
        <Button
          variant="primary"
          disabled={chosen === null || busy}
          busy={busy}
          onClick={() => void link()}
          data-testid="meetings-link-submit"
        >
          {busy ? t.busy : t.submit}
        </Button>
      </div>
    </Dialog>
  )
}
