import { Banner, Button, Icon, StatePanel } from '@operai/ui'
import { useCallback, useMemo, useState } from 'react'
import { usePolling } from '../../hooks/usePolling'
import { listSummaries } from '../../lib/meetingsApi'
import type { HostInfo, Meeting, Summary } from '../../lib/types'
import { strings } from '../../strings'
import { LoadFailure, Loading } from '../LoadState'
import { GenerateSummaryDialog } from './GenerateSummaryDialog'
import { SummaryCard } from './SummaryCard'

export type SummariesPanelProps = {
  meeting: Meeting
  /** The host's registration, for the "Recommended for <entity>" template group (AC-8.5); null for a standalone meeting. */
  hostInfo: HostInfo | null
  onChanged: (meeting: Meeting) => void
}

/** A summary can hold at most this many per meeting (AC-7.3). */
export const SUMMARY_LIMIT = 20

type List = { items: Summary[] }

/** What a write returned, valid only against the poll it was made after; the next poll supersedes it. */
type Override = { id: string; summary: Summary | null }

/** The Summaries tab (S3b): the list, newest first, polled while any summary is generating. */
export default function SummariesPanel({ meeting, hostInfo }: SummariesPanelProps) {
  const fetcher = useCallback((signal: AbortSignal) => listSummaries(meeting.id, { signal }), [meeting.id])
  const polling = usePolling<List>(fetcher, {
    until: (data) => !data.items.some((summary) => summary.status === 'generating'),
  })
  const polled = polling.data
  const [overrides, setOverrides] = useState<{ against: List | null; entries: Override[] }>({
    against: null,
    entries: [],
  })
  const [dialog, setDialog] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)

  const items = useMemo(() => {
    const base = polled?.items ?? []
    const active = overrides.against === polled ? overrides.entries : []
    const kept = base.flatMap((item) => {
      const override = active.find((entry) => entry.id === item.id)
      return override === undefined ? [item] : override.summary === null ? [] : [override.summary]
    })
    const added = active.flatMap((entry) =>
      entry.summary !== null && !base.some((item) => item.id === entry.id) ? [entry.summary] : [],
    )
    return [...added, ...kept]
  }, [polled, overrides])

  const put = useCallback(
    (summary: Summary | null, id: string) => {
      setOverrides((previous) => ({
        against: polled,
        entries: [
          ...(previous.against === polled ? previous.entries.filter((entry) => entry.id !== id) : []),
          { id, summary },
        ],
      }))
      // Fetch now, and keep polling while something is generating.
      polling.retry()
    },
    [polled, polling],
  )

  const onResult = (summary: Summary) => {
    setActionError(null)
    put(summary, summary.id)
    if (summary.status === 'generating') setFocusId(summary.id)
  }

  if (polled === null) {
    if (polling.status === 'error') return <LoadFailure error={polling.error} onRetry={polling.retry} />
    return <Loading label={strings.summaries.loading} />
  }

  const atLimit = items.length >= SUMMARY_LIMIT
  const noSpeech = meeting.noSpeech
  const generateBlocked = atLimit || noSpeech
  const reasonId = 'meetings-summaries-reason'
  return (
    <div className="flex flex-col gap-4" data-testid="meetings-summaries">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-soft">{strings.summaries.count(items.length)}</p>
        {meeting.can.summarise && (
          <Button
            variant="primary"
            aria-haspopup="dialog"
            aria-disabled={generateBlocked || undefined}
            aria-describedby={generateBlocked ? reasonId : undefined}
            onClick={() => (generateBlocked ? undefined : setDialog(true))}
          >
            <Icon name="sparkle" /> {strings.summaries.generate}
          </Button>
        )}
      </div>
      {generateBlocked && meeting.can.summarise && (
        <p id={reasonId} className="text-xs text-soft">
          {noSpeech ? strings.summaries.noSpeechReason : strings.summaries.limitReached}
        </p>
      )}
      {polling.status === 'error' && (
        <Banner tone="warning" onRetry={polling.retry} retryLabel={strings.common.retry}>
          {strings.common.loadErrorTitle}
        </Banner>
      )}
      {actionError !== null && (
        <Banner
          tone="danger"
          onDismiss={() => setActionError(null)}
          dismissLabel={strings.common.dismiss}
          data-testid="meetings-summaries-error"
        >
          {actionError}
        </Banner>
      )}
      {items.length === 0 ? (
        <StatePanel title={strings.summaries.empty.heading}>
          {meeting.can.summarise ? strings.summaries.empty.body : null}
        </StatePanel>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((summary) => (
            <SummaryCard
              key={summary.id}
              meeting={meeting}
              summary={summary}
              atLimit={atLimit}
              focus={focusId === summary.id}
              onResult={onResult}
              onError={setActionError}
              onDeleted={(id) => put(null, id)}
              onReload={() => {
                setOverrides({ against: null, entries: [] })
                polling.retry()
              }}
            />
          ))}
        </div>
      )}
      {dialog && (
        <GenerateSummaryDialog
          meeting={meeting}
          hostInfo={hostInfo}
          onClose={() => setDialog(false)}
          onGenerated={(summary) => {
            setDialog(false)
            onResult(summary)
          }}
        />
      )}
    </div>
  )
}
