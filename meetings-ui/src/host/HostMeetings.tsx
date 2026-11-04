import 'shell/tokens.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Banner,
  Button,
  Card,
  ListRows,
  Pagination,
  StatePanel,
  StatusBadge,
  buttonClassName,
  formatDate,
  listRowClassName,
  listRowMetaClassName,
  resolveLocale,
} from '@operai/ui'
import { Loading, Saved } from '../components/LoadState'
import { useCapabilityHints } from '../hooks/useCapabilityHints'
import { useResource } from '../hooks/useResource'
import { errorMessage } from '../lib/errors'
import { hostNames, hostNoticeFailed, suiteLinkProps, useHosts } from '../lib/hostLinks'
import { listHostMeetings, retryHostNotice } from '../lib/meetingsApi'
import { MEETING_STATUS_MEANING } from '../lib/statusMeanings'
import type { Meeting, MeetingRow } from '../lib/types'
import { strings } from '../strings'
import LinkMeetingDialog from './LinkMeetingDialog'

/** The three strings a host passes (plan § Host integration contract › The UI half); nothing else. */
export type HostMeetingsProps = {
  hostApp: string
  entityType: string
  entityId: string
}

const PAGE_SIZE = 25

type NoticeFailed = { meetingId: string; error: string | null }

function Panel({ hostApp, entityType, entityId }: HostMeetingsProps) {
  const t = strings.host.panel
  const { canUseMeetings } = useCapabilityHints()
  const hosts = useHosts()
  const listRef = useRef<HTMLDivElement>(null)
  /** The meeting to put focus on once the refreshed list is on screen (after Link meeting). */
  const focusAfterLoad = useRef<string | null>(null)

  const [page, setPage] = useState(1)
  const [knownTotal, setKnownTotal] = useState(0)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linked, setLinked] = useState(false)
  const [noticeFailed, setNoticeFailed] = useState<NoticeFailed | null>(null)
  const [retrying, setRetrying] = useState(false)

  const fetcher = useCallback(
    (signal: AbortSignal) => listHostMeetings(hostApp, entityType, entityId, { page }, { signal }),
    [hostApp, entityType, entityId, page],
  )
  const resource = useResource(fetcher)

  // The pager outlives a page change (focus stays on the button just pressed), so the last total is kept.
  if (resource.status === 'ready' && resource.data !== null && resource.data.total !== knownTotal) {
    setKnownTotal(resource.data.total)
  }

  // After Link meeting, focus goes to the row that was just added, once the list has been reloaded.
  useEffect(() => {
    const wanted = focusAfterLoad.current
    if (resource.status !== 'ready' || wanted === null) return
    focusAfterLoad.current = null
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-meeting-id]') ?? []
    Array.from(rows)
      .find((row) => row.dataset['meetingId'] === wanted)
      ?.focus()
  }, [resource.status, resource.data])

  const entity = hostNames(hosts, hostApp, entityType).entity.toLocaleLowerCase(resolveLocale())
  const startUrl = `/meetings/new?hostApp=${encodeURIComponent(hostApp)}&hostType=${encodeURIComponent(entityType)}&hostId=${encodeURIComponent(entityId)}`
  const startLink = (variant: 'primary' | 'secondary', size?: 'sm') => (
    <a className={buttonClassName({ variant, size })} {...suiteLinkProps(startUrl)} data-testid="meetings-host-start">
      {t.start}
    </a>
  )

  const items = resource.data?.items ?? []
  const emptyAndLoaded = resource.status === 'ready' && items.length === 0

  const onLinked = (meeting: Meeting) => {
    setLinkOpen(false)
    setLinked(true)
    focusAfterLoad.current = meeting.id
    setNoticeFailed(meeting.hostNotice?.state === 'failed' ? { meetingId: meeting.id, error: null } : null)
    resource.retry()
  }

  const tryNoticeAgain = async () => {
    if (noticeFailed === null || retrying) return
    setRetrying(true)
    try {
      const meeting = await retryHostNotice(noticeFailed.meetingId)
      setNoticeFailed(meeting.hostNotice?.state === 'failed' ? { ...noticeFailed, error: null } : null)
    } catch (error) {
      setNoticeFailed({ ...noticeFailed, error: errorMessage(error) })
    } finally {
      setRetrying(false)
    }
  }

  const content = () => {
    if (resource.status === 'loading') return <Loading label={t.loading} rows={2} />
    if (resource.status === 'error') {
      // The card keeps its title and the host page keeps working, whatever went wrong (AC-11.6).
      return (
        <Banner
          tone="warning"
          title={t.unavailable.title}
          data-testid="meetings-host-unavailable"
          onRetry={resource.retry}
          retryLabel={strings.common.retry}
        >
          {t.unavailable.body}
        </Banner>
      )
    }
    if (items.length === 0) {
      return (
        <StatePanel
          title={t.empty.title}
          headingLevel={4}
          testId="meetings-host-empty"
          action={canUseMeetings ? startLink('primary') : undefined}
        >
          {t.empty.body(entity)}
        </StatePanel>
      )
    }
    return (
      <ListRows label={t.listLabel} testId="meetings-host-list">
        {items.map((row: MeetingRow) => (
          <a
            key={row.id}
            className={listRowClassName}
            data-meeting-id={row.id}
            {...suiteLinkProps(`/my-meetings/m/${encodeURIComponent(row.id)}`)}
          >
            <span className="flex flex-col gap-1">
              <span>{row.title}</span>
              <span className={listRowMetaClassName}>
                {t.row.meta(formatDate(row.startsAt), row.creator.name ?? t.row.unknownCreator)}
              </span>
            </span>
            <span className="flex items-center gap-3">
              <StatusBadge status={MEETING_STATUS_MEANING[row.status]}>
                {strings.common.status.meeting[row.status]}
              </StatusBadge>
              <span className="font-mono text-xs">{t.row.summaries(row.summaryCount)}</span>
            </span>
          </a>
        ))}
      </ListRows>
    )
  }

  const sentence =
    noticeFailed === null ? null : (hostNoticeFailed(hosts, hostApp, entityType) ?? t.noticeFailedFallback)

  return (
    <Card
      title={t.title}
      data-testid="meetings-host-panel"
      action={
        canUseMeetings ? (
          <div className="flex flex-wrap gap-2">
            {/* On an empty list the panel below carries Start meeting, so it is never offered twice. */}
            {!emptyAndLoaded && startLink('secondary', 'sm')}
            <Button size="sm" variant="secondary" aria-haspopup="dialog" onClick={() => setLinkOpen(true)}>
              {t.link}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {linked && <Saved message={t.linked} onDismiss={() => setLinked(false)} />}
        {noticeFailed !== null && sentence !== null && (
          <Banner
            tone="warning"
            compact
            data-testid="meetings-host-notice-failed"
            onRetry={() => void tryNoticeAgain()}
            retryLabel={t.noticeTryAgain}
          >
            <p>{sentence}</p>
            {noticeFailed.error !== null && <p>{noticeFailed.error}</p>}
          </Banner>
        )}
        {resource.data?.hostReadersUnavailable === true && (
          <Banner tone="info" compact data-testid="meetings-host-some-hidden">
            {t.someHidden}
          </Banner>
        )}
        <div ref={listRef}>{content()}</div>
        {knownTotal > PAGE_SIZE && resource.status !== 'error' && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={knownTotal}
            onPageChange={setPage}
            label={t.pagination.label}
            previousLabel={t.pagination.previous}
            nextLabel={t.pagination.next}
            status={(s) => t.pagination.status(s.page, s.totalPages, s.rangeStart, s.rangeEnd, s.total)}
            testId="meetings-host-pagination"
          />
        )}
      </div>

      {linkOpen && (
        <LinkMeetingDialog
          hostApp={hostApp}
          entityType={entityType}
          entityId={entityId}
          entityLabel={entity}
          hosts={hosts}
          onClose={() => setLinkOpen(false)}
          onLinked={onLinked}
        />
      )}
    </Card>
  )
}

/**
 * HostMeetings — the remote's third exposed entry, `./HostMeetings` (vite.config.ts `exposes`),
 * loaded by the shell's `HostExtension` inside a host's page, e.g. the CRM deal (ADR-0060). It draws
 * a `Card` and no frame of its own, and no router: its links leave through the shell
 * (`navigateSuite`). The list is what the caller may open on this record (AC-11.2); "Start meeting"
 * and "Link an existing meeting" are offered only to a `meetings:access` holder (AC-1.4). A failure
 * of this panel stays in this card (AC-11.6). As with `App`, it must not import this package's own
 * `index.css`.
 */
export default function HostMeetings(props: HostMeetingsProps) {
  // A different record is a different panel: its page, its dialog and its notices start over.
  return <Panel key={`${props.hostApp}/${props.entityType}/${props.entityId}`} {...props} />
}
