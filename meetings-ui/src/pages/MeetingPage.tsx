import {
  Banner,
  Button,
  Card,
  Icon,
  PageHeader,
  StatusBadge,
  Tabs,
  formatDateTime,
  tabPanelProps,
  useFocusOnMount,
} from '@operai/ui'
import { Link, useNavigate, useParams, useRouterState, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import AskPanel from '../components/ask/AskPanel'
import { LoadFailure, Loading, Saved } from '../components/LoadState'
import DeleteMeetingDialog from '../components/meeting/DeleteMeetingDialog'
import DeleteRecordingDialog from '../components/meeting/DeleteRecordingDialog'
import DetailsCard, { HostText } from '../components/meeting/DetailsCard'
import EditDetailsDialog from '../components/meeting/EditDetailsDialog'
import HostNoticeBanner from '../components/meeting/HostNoticeBanner'
import ParticipantsCard from '../components/meeting/ParticipantsCard'
import StatusPanels from '../components/meeting/StatusPanels'
import SummariesPanel from '../components/summaries/SummariesPanel'
import TranscriptView from '../components/transcript/TranscriptView'
import { usePolling } from '../hooks/usePolling'
import { useResource } from '../hooks/useResource'
import PermissionDenied from '../components/PermissionDenied'
import { statusOf } from '../lib/errors'
import { getConversation, getMeeting, listHosts } from '../lib/meetingsApi'
import type { HostInfo, Meeting } from '../lib/types'
import { MEETING_STATUS_MEANING } from '../lib/statusMeanings'
import { strings } from '../strings'

export type MeetingPageProps = {
  /** The list this page's back link returns to: `/meetings` in `./App`, `/my-meetings` in `./MyMeetings` (design.md Conventions). */
  listPath: '/meetings' | '/my-meetings'
}

const HEADING_ID = 'meetings-meeting-page-heading'

/** A meeting still changing on the server, watched until it settles (F9). */
const POLL = { baseMs: 5000, factor: 1.5, maxMs: 30_000 }

/**
 * The statuses worth watching: `processing` for everyone, and a recording or an interrupted
 * capture for someone who is not the one holding its controls (their panel owns its own state).
 */
const isWatched = (meeting: Meeting): boolean => {
  if (meeting.status === 'processing') return true
  const controls = meeting.can.capture || meeting.can.edit
  return !controls && (meeting.status === 'recording' || meeting.status === 'interrupted')
}

/** Whether a fresh view differs in what Edit details edits, so a save is confirmed and a plain reload is not. */
const detailsChanged = (before: Meeting, after: Meeting): boolean =>
  before.title !== after.title ||
  before.startsAt !== after.startsAt ||
  before.format !== after.format ||
  before.language !== after.language ||
  before.source !== after.source ||
  before.hostVisible !== after.hostVisible ||
  before.host?.entityId !== after.host?.entityId

type TabId = 'summaries' | 'transcript' | 'ask'

/** Reads the host's registration for the visibility hint and the labels; any failure is "unknown host", never an error (plan G6). */
function useHostInfo(meeting: Meeting): HostInfo | null {
  const app = meeting.host?.app ?? null
  const entityType = meeting.host?.entityType ?? null
  const fetcher = useCallback(
    async (signal: AbortSignal): Promise<HostInfo | null> => {
      if (app === null || entityType === null) return null
      const { items } = await listHosts({ signal })
      return items.find((item) => item.app === app && item.entityType === entityType) ?? null
    },
    [app, entityType],
  )
  return useResource(fetcher).data
}

/** Whether the caller already has questions here: keeps the Ask tab readable after the grant is gone (AC-9.5). */
function useHasTurns(meeting: Meeting): boolean {
  const { id } = meeting
  const asks = meeting.can.ask
  const fetcher = useCallback(
    async (signal: AbortSignal) => (asks ? false : (await getConversation(id, { signal })).turns.length > 0),
    [id, asks],
  )
  return useResource(fetcher).data === true
}

type ContentTabsProps = {
  meeting: Meeting
  hostInfo: HostInfo | null
  onChanged: (meeting: Meeting) => void
  /** Reads the meeting again, quietly. */
  onRefresh: () => void
}

/**
 * ContentTabs — Summaries · Transcript · Ask the meeting (S3b), one page, the tab in `?tab=` so
 * back, forward and shared links work. Only the active panel is mounted: the Ask panel unmounts
 * while the cited passage is shown and focus returns to its source on the way back (F12).
 */
function ContentTabs({ meeting, hostInfo, onChanged, onRefresh }: ContentTabsProps) {
  const t = strings.meeting.tabs
  const hasTurns = useHasTurns(meeting)
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { tab?: unknown }

  const available: TabId[] =
    meeting.can.ask || hasTurns ? ['summaries', 'transcript', 'ask'] : ['summaries', 'transcript']
  const fallback: TabId = meeting.summaryCount > 0 ? 'summaries' : 'transcript'
  const requested = available.find((id) => id === search.tab)
  const active: TabId = requested ?? fallback

  const [cited, setCited] = useState<string | null>(null)
  // An answer's "may be incomplete" label was followed: the Transcript tab shows its notice (AC-9.9).
  const [noticeRequested, setNoticeRequested] = useState(false)

  /**
   * Moves to a tab and reads the meeting again: the summaries and the transcript panels do not
   * push their writes up, and `summaryCount` and the stale flags live on the meeting.
   */
  const select = useCallback(
    (tab: TabId) => {
      void navigate({ to: '.', search: (previous: Record<string, unknown>) => ({ ...previous, tab }) })
      onRefresh()
    },
    [navigate, onRefresh],
  )

  // The Ask panel remembers which source was pressed (ask/returnFocus) and takes focus back when it mounts again.
  const openSource = (segmentId: string) => {
    setCited(segmentId)
    setNoticeRequested(false)
    select('transcript')
  }
  const openNotice = () => {
    setCited(null)
    setNoticeRequested(true)
    select('transcript')
  }
  const backToAnswer = () => {
    setCited(null)
    setNoticeRequested(false)
    select('ask')
  }

  const tabs = available.map((id) => ({
    id,
    label: id === 'transcript' && meeting.source === 'text' ? t.passages : t[id],
  }))

  return (
    <div data-testid="meetings-content-tabs">
      <Tabs
        label={t.label}
        tabs={tabs}
        value={active}
        idPrefix="meetings-tab"
        onChange={(id) => {
          setCited(null)
          setNoticeRequested(false)
          if (id !== active) select(id)
        }}
      />
      {/* Every tab keeps its panel element (so `aria-controls` resolves); only the active one holds content. */}
      <div {...tabPanelProps('meetings-tab', 'summaries')} hidden={active !== 'summaries'}>
        {active === 'summaries' && <SummariesPanel meeting={meeting} hostInfo={hostInfo} onChanged={onChanged} />}
      </div>
      <div {...tabPanelProps('meetings-tab', 'transcript')} hidden={active !== 'transcript'}>
        {active === 'transcript' && (
          <TranscriptView
            meeting={meeting}
            focusSegmentId={cited}
            onBackToAnswer={cited !== null ? backToAnswer : null}
            focusNotice={noticeRequested}
          />
        )}
      </div>
      {available.includes('ask') && (
        <div {...tabPanelProps('meetings-tab', 'ask')} hidden={active !== 'ask'}>
          {active === 'ask' && <AskPanel meeting={meeting} onOpenSource={openSource} onOpenNotice={openNotice} />}
        </div>
      )}
    </div>
  )
}

type MeetingViewProps = {
  meeting: Meeting
  replace: (meeting: Meeting) => void
  listPath: MeetingPageProps['listPath']
  back: ReactNode
  /** The page was reached by creating the meeting: confirm it where the person landed (F1). */
  created: boolean
}

type Dialog = 'edit' | 'delete' | 'deleteRecording' | null

/** The loaded page (S3): header, banners, the status panel, the cards and the tabs. */
function MeetingView({ meeting, replace, listPath, back, created }: MeetingViewProps) {
  const t = strings.meeting
  const navigate = useNavigate()
  const hostInfo = useHostInfo(meeting)
  const headingRef = useFocusOnMount<HTMLHeadingElement>()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [saved, setSaved] = useState<string | null>(created ? t.saved.created : null)
  const [refreshFailed, setRefreshFailed] = useState(false)

  const replaceRef = useRef(replace)
  useEffect(() => {
    replaceRef.current = replace
  })

  const changed = useCallback(
    (next: Meeting, message?: string) => {
      replace(next)
      if (message !== undefined) setSaved(message)
    },
    [replace],
  )

  /** Reads the meeting again without leaving the page (Retry on a banner, a refusal that says the state moved on). */
  const { id } = meeting
  const refresh = useCallback(
    async (quiet = false) => {
      try {
        replace(await getMeeting(id))
        setRefreshFailed(false)
      } catch {
        if (!quiet) setRefreshFailed(true)
      }
    },
    [id, replace],
  )

  const watch = useCallback(
    async (signal: AbortSignal) => {
      const next = await getMeeting(id, { signal })
      if (!signal.aborted) replaceRef.current(next)
      return next
    },
    [id],
  )
  usePolling(watch, { ...POLL, enabled: isWatched(meeting), until: (next) => !isWatched(next) })

  const { can } = meeting
  const host = meeting.host !== null ? <HostText meeting={meeting} hostInfo={hostInfo} /> : null
  const description = (
    <>
      {t.format[meeting.format]} · {formatDateTime(meeting.startsAt)}
      {host !== null && <> · {host}</>}
    </>
  )
  const actions =
    can.edit || can.deleteMeeting ? (
      <>
        {can.edit && (
          <Button variant="secondary" aria-haspopup="dialog" onClick={() => setDialog('edit')}>
            {t.actions.editDetails}
          </Button>
        )}
        {can.deleteMeeting && (
          <Button variant="danger" aria-haspopup="dialog" onClick={() => setDialog('delete')}>
            {t.actions.deleteMeeting}
          </Button>
        )}
      </>
    ) : undefined

  return (
    <section aria-labelledby={HEADING_ID} data-testid="meetings-meeting-page" data-list-path={listPath}>
      <PageHeader
        title={meeting.title}
        titleId={HEADING_ID}
        headingRef={headingRef}
        focusableHeading
        status={
          <StatusBadge status={MEETING_STATUS_MEANING[meeting.status]}>
            {strings.common.status.meeting[meeting.status]}
          </StatusBadge>
        }
        description={description}
        back={back}
        actions={actions}
      />

      <div className="flex flex-col gap-4">
        {meeting.capabilities === 'unavailable' && (
          <Banner
            tone="warning"
            title={strings.common.authUnavailable.heading}
            onRetry={() => void refresh()}
            retryLabel={strings.common.retry}
            data-testid="meetings-capabilities-unavailable"
          >
            {strings.common.authUnavailable.body}
          </Banner>
        )}
        {meeting.frozen === true && (
          <Banner tone="info" data-testid="meetings-frozen-banner">
            <span className="inline-flex items-center gap-2">
              <Icon name="lock" />
              {t.banners.frozen}
            </span>
          </Banner>
        )}
        {meeting.frozen === null && (
          <Banner
            tone="warning"
            onRetry={() => void refresh()}
            retryLabel={strings.common.retry}
            data-testid="meetings-creator-unknown"
          >
            {t.banners.creatorUnknown}
          </Banner>
        )}
        {meeting.hostNotice?.state === 'failed' && (
          <HostNoticeBanner
            meeting={meeting}
            hostInfo={hostInfo}
            onChanged={(next) => changed(next, next.hostNotice === null ? t.hostNotice.saved : undefined)}
          />
        )}
        {refreshFailed && (
          <Banner tone="warning" onRetry={() => void refresh()} retryLabel={strings.common.retry}>
            {t.banners.refreshFailed}
          </Banner>
        )}
        {saved !== null && <Saved message={saved} onDismiss={() => setSaved(null)} />}

        <StatusPanels meeting={meeting} onChanged={changed} onRefresh={() => void refresh()} />

        <DetailsCard meeting={meeting} hostInfo={hostInfo} />
        <ParticipantsCard meeting={meeting} hostInfo={hostInfo} onChanged={changed} />

        {meeting.status === 'ready' && (
          <ContentTabs meeting={meeting} hostInfo={hostInfo} onChanged={changed} onRefresh={() => void refresh(true)} />
        )}

        {can.deleteAudio && meeting.audio.state === 'kept' && (
          <Card title={t.recordingCard.title} data-testid="meetings-recording-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-soft">{t.details.audio.keptUntil(formatDateTime(meeting.audio.until))}</p>
              <Button variant="danger" size="sm" aria-haspopup="dialog" onClick={() => setDialog('deleteRecording')}>
                {t.recordingCard.deleteRecording}
              </Button>
            </div>
          </Card>
        )}
      </div>

      {dialog === 'edit' && (
        <EditDetailsDialog
          meeting={meeting}
          onClose={() => setDialog(null)}
          // The dialog closes itself after a save; a reload it asks for (a lock that moved on) keeps it open.
          onChanged={(next) => changed(next, detailsChanged(meeting, next) ? t.saved.details : undefined)}
        />
      )}
      {dialog === 'delete' && (
        <DeleteMeetingDialog
          meeting={meeting}
          onClose={() => setDialog(null)}
          // `meetingDeleted` lets the list confirm "Meeting deleted" where the person lands (design.md F14).
          onDeleted={() => void navigate({ to: '/', state: { meetingDeleted: true } })}
        />
      )}
      {dialog === 'deleteRecording' && (
        <DeleteRecordingDialog
          meeting={meeting}
          onClose={() => setDialog(null)}
          onChanged={(next) => {
            changed(next)
            setDialog(null)
          }}
        />
      )}
    </section>
  )
}

/**
 * MeetingPage — the meeting detail (S3), shared by both entries: `./App` at `/meetings/m/$id`
 * and the ungated `./MyMeetings` at `/my-meetings/m/$id`. States in the order of building-pages
 * § 2 (403, loading, failed/404, loaded), with the back link in every one of them. Every control
 * follows the meeting's server-computed `can` flags, never a client-side role check (AC-10.4).
 */
export default function MeetingPage({ listPath }: MeetingPageProps) {
  const { id = '' } = useParams({ strict: false })
  const fetcher = useCallback((signal: AbortSignal) => getMeeting(id, { signal }), [id])
  const resource = useResource(fetcher)
  // NewMeetingPage navigates here with `meetingCreated` in the history state.
  const created = useRouterState({
    select: (state) => (state.location.state as { meetingCreated?: boolean } | undefined)?.meetingCreated === true,
  })

  const back = (
    <Link to="/" className="link" data-testid="meetings-meeting-back">
      <Icon name="arrow-left" /> {listPath === '/my-meetings' ? strings.meeting.backMine : strings.meeting.back}
    </Link>
  )

  if (resource.status === 'ready' && resource.data !== null) {
    return (
      <MeetingView
        meeting={resource.data}
        replace={resource.replace}
        listPath={listPath}
        back={back}
        created={created}
      />
    )
  }

  return (
    <section aria-labelledby={HEADING_ID} data-testid="meetings-meeting-page" data-list-path={listPath}>
      <PageHeader title={strings.meeting.fallbackTitle} titleId={HEADING_ID} back={back} />
      {resource.status === 'error' ? (
        // Any 403 on the load replaces the page: a refusal code (frozen, meetings_access_required) is not a retryable warning here.
        statusOf(resource.error) === 403 ? (
          <PermissionDenied />
        ) : (
          <LoadFailure error={resource.error} onRetry={resource.retry} notFound={strings.meeting.notFound} />
        )
      ) : (
        <Loading label={strings.meeting.loading} />
      )}
    </section>
  )
}
