import { Badge, Banner, Button, Card, Icon, Spinner, StatusBadge, VisuallyHidden, formatDateTime } from '@operai/ui'
import { useEffect, useRef, useState } from 'react'
import { SUMMARY_STATUS_MEANING } from '../../lib/statusMeanings'
import { regenerateSummary, retrySummary } from '../../lib/meetingsApi'
import type { Meeting, Summary } from '../../lib/types'
import { strings } from '../../strings'
import { aiErrorMessage } from '../aiError'

export type SummaryCardProps = {
  meeting: Meeting
  summary: Summary
  /** The meeting already holds 20 summaries: Regenerate waits (AC-7.3). */
  atLimit: boolean
  /** Takes focus once (the card just created, F10). */
  focus: boolean
  /** A write returned this summary (a regeneration, a retry, an edit): show it. */
  onResult: (summary: Summary) => void
  /** An action failed: the panel shows the message. */
  onError: (message: string) => void
  /** Slot for the card's "More actions" menu and the editor (T72). */
  menu?: React.ReactNode
  editor?: React.ReactNode
}

/** The summary as plain text: the template name, then each section's heading and body (AC-7.11). */
const summaryText = (summary: Summary): string =>
  [summary.template.name, ...(summary.sections ?? []).map((section) => `${section.heading}\n${section.body}`)].join(
    '\n\n',
  )

/**
 * One summary. Everything the AI wrote is rendered as plain text — React text nodes in a
 * `whitespace-pre-line` paragraph, never HTML or Markdown (ADR-0067).
 */
export function SummaryCard({ meeting, summary, atLimit, focus, onResult, onError, menu, editor }: SummaryCardProps) {
  const t = strings.summaries
  const [busy, setBusy] = useState<'regenerate' | 'retry' | null>(null)
  const [copied, setCopied] = useState<'copied' | 'copyFailed' | null>(null)
  const root = useRef<HTMLDivElement>(null)
  // Politely announce a summary that was generating when it becomes ready (F10).
  const [wasGenerating, setWasGenerating] = useState(summary.status === 'generating')
  if (summary.status === 'generating' && !wasGenerating) setWasGenerating(true)

  useEffect(() => {
    if (focus) root.current?.focus()
  }, [focus])

  const act = async (kind: 'regenerate' | 'retry') => {
    setBusy(kind)
    try {
      onResult(await (kind === 'regenerate' ? regenerateSummary : retrySummary)(meeting.id, summary.id))
    } catch (error) {
      onError(aiErrorMessage(error, t.rateLimited))
    } finally {
      setBusy(null)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summaryText(summary))
      setCopied('copied')
    } catch {
      setCopied('copyFailed')
    }
  }

  const author = summary.author.name ?? t.formerAuthor
  const generating = summary.status === 'generating'
  const failed = summary.status === 'failed'
  return (
    <div ref={root} tabIndex={-1} data-testid={`meetings-summary-${summary.id}`}>
      <Card title={summary.template.name} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(generating || failed) && (
            <StatusBadge status={SUMMARY_STATUS_MEANING[summary.status]}>
              {strings.common.status.summary[summary.status]}
            </StatusBadge>
          )}
          <Badge tone="accent" glyph={<Icon name="sparkle" />}>
            {t.aiGenerated}
          </Badge>
          <Badge>{t.languages[summary.language]}</Badge>
          {summary.edited && <Badge>{t.edited}</Badge>}
          {summary.stale && <Badge tone="warning">{t.stale}</Badge>}
        </div>
        <p className="text-xs text-soft">{t.byline(author, formatDateTime(summary.createdAt))}</p>

        {generating && (
          <p className="flex items-center gap-2 text-sm text-soft">
            <Spinner /> {t.generating}
          </p>
        )}
        {failed && (
          <Banner
            tone="danger"
            compact
            onRetry={summary.can.retry ? () => void act('retry') : undefined}
            retryLabel={t.tryAgain}
          >
            {t.failed}
          </Banner>
        )}
        {summary.status === 'ready' &&
          (editor ?? (
            <div className="flex flex-col gap-3">
              {(summary.sections ?? []).map((section, index) => (
                <section key={index}>
                  <h4 className="text-sm font-medium text-text">{section.heading}</h4>
                  <p
                    className={
                      section.notDiscussed
                        ? 'whitespace-pre-line text-sm text-soft'
                        : 'whitespace-pre-line text-sm text-text'
                    }
                  >
                    {section.body}
                  </p>
                </section>
              ))}
            </div>
          ))}

        <div className="flex flex-wrap items-center gap-2">
          {summary.status === 'ready' && (
            <Button variant="secondary" size="sm" onClick={() => void copy()}>
              <Icon name="copy" /> {t.copyAsText}
            </Button>
          )}
          {summary.status === 'ready' && meeting.can.summarise && (
            <Button
              variant="secondary"
              size="sm"
              busy={busy === 'regenerate'}
              aria-disabled={atLimit || undefined}
              onClick={() => (atLimit ? undefined : void act('regenerate'))}
            >
              <Icon name="refresh" /> {t.regenerate}
            </Button>
          )}
          {menu}
        </div>
        <VisuallyHidden live>
          {copied === 'copied'
            ? t.copied
            : copied === 'copyFailed'
              ? t.copyFailed
              : generating
                ? t.announceGenerating
                : wasGenerating && summary.status === 'ready'
                  ? t.announceReady
                  : ''}
        </VisuallyHidden>
      </Card>
    </div>
  )
}
