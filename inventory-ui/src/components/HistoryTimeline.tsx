import { useEffect, useId, useState } from 'react'
import ErrorBanner from './ErrorBanner'
import SkeletonListRows from './SkeletonListRows'
import type { InventoryCapabilities } from '../hooks/useInventoryCapabilities'
import { ApiError } from '../lib/api'
import { formatDate, formatDateTime } from '../lib/dates'
import { getAssetHistory } from '../lib/historyApi'
import { formatMoney } from '../lib/money'
import type { AssetView, HistoryChangeValue, HistoryEvent, Identity } from '../lib/types'
import { strings } from '../strings'

/**
 * HistoryTimeline — the History region of the asset detail page (T36, specs/015-
 * hardware-inventory; design.md F13, § T2 History, § Accessibility "T2 detail";
 * AC-11.1, AC-11.3, AC-11.4). Props fixed by T32.
 *
 * Fetches `GET /assets/{id}/history` itself and keeps its own loading / empty /
 * error states, so a failure stays local to the section (design § T2 States) and
 * the rest of the page stays usable. Reloads whenever the page bumps `revision`
 * (every change to the asset), keeping the entries on screen until the new ones
 * arrive — never another asset's.
 *
 * Read-only by construction (AC-11.2): events are an `<ol>`, oldest first (sorted
 * here too, stably, so the order never depends on the server's), each with a
 * `<time datetime>`, the action, the actor and its changes as "field: from → to".
 * Holder identities appear by name; `deleted`, `unknown` and `system` actors are
 * labelled ("System" for the launch seed and the legacy import, design G9). The
 * history of a disposed asset is shown like any other. Values are only formatted,
 * never computed: money from integer cents, dates from ISO.
 */

export type HistoryTimelineProps = {
  asset: AssetView
  capabilities: InventoryCapabilities
  revision: number
}

type Outcome =
  | { key: string; assetId: string; ok: true; events: HistoryEvent[] }
  | { key: string; assetId: string; ok: false; error: unknown }

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const has = <T extends object>(table: T, key: string): key is Extract<keyof T, string> => key in table

const identityLabel = (identity: Identity): string => {
  if (identity.status === 'system') return strings.assets.holderSystem
  if (identity.status === 'deleted') {
    return identity.name === null ? strings.assets.holderDeleted : strings.history.deletedNamed(identity.name)
  }
  return identity.name ?? strings.assets.holderUnknown
}

const isIdentity = (value: HistoryChangeValue): value is Identity =>
  typeof value === 'object' && value !== null && 'status' in value

const fieldLabel = (field: string): string => (has(strings.history.field, field) ? strings.history.field[field] : field)

const actionLabel = (action: string): string =>
  has(strings.history.action, action) ? strings.history.action[action] : action

const valueLabel = (field: string, value: HistoryChangeValue, asset: AssetView): string => {
  if (value === null) return strings.history.none
  if (isIdentity(value)) return identityLabel(value)
  if (typeof value === 'boolean') return value ? strings.history.yes : strings.history.no
  if (typeof value === 'number') {
    return field.endsWith('Cents') && Number.isInteger(value) ? formatMoney(value, asset.currency) : String(value)
  }
  if (DATE_ONLY.test(value)) return formatDate(value)
  if (field === 'status' && has(strings.badges.assetStatus, value)) return strings.badges.assetStatus[value]
  if (field === 'category' && has(strings.categories, value)) return strings.categories[value]
  if (field === 'reason' && has(strings.disposalReasons, value)) return strings.disposalReasons[value]
  return value
}

const failureMessage = (error: unknown): string => {
  if (error instanceof ApiError) return error.detail ?? strings.errors.unknown
  return strings.errors.network
}

export default function HistoryTimeline({ asset, revision }: HistoryTimelineProps) {
  const t = strings.history
  const headingId = useId()
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const assetId = asset.id
  const key = `${assetId}:${revision}:${attempt}`

  useEffect(() => {
    const controller = new AbortController()
    getAssetHistory(assetId, { signal: controller.signal }).then(
      ({ events }) => {
        if (!controller.signal.aborted) setOutcome({ key, assetId, ok: true, events })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOutcome({ key, assetId, ok: false, error })
      },
    )
    return () => controller.abort()
  }, [assetId, key])

  // The answer to THIS request, else the last good one for the same asset (stale while reloading).
  const current = outcome?.key === key ? outcome : null
  const shown = current ?? (outcome?.assetId === assetId && outcome.ok ? outcome : null)

  let content
  if (current !== null && !current.ok) {
    const unavailable = current.error instanceof ApiError && current.error.status === 503
    const retry = () => setAttempt((previous) => previous + 1)
    content = unavailable ? (
      <ErrorBanner variant="authUnavailable" onRetry={retry} retryLabel={t.retry} />
    ) : (
      <ErrorBanner message={failureMessage(current.error)} onRetry={retry} retryLabel={t.retry} />
    )
  } else if (shown === null || !shown.ok) {
    content = (
      <div className="flex flex-col gap-2">
        <p role="status" className="sr-only">
          {t.loading}
        </p>
        <SkeletonListRows />
      </div>
    )
  } else if (shown.events.length === 0) {
    content = (
      <p className="text-sm" style={{ color: 'var(--soft)' }}>
        {t.empty}
      </p>
    )
  } else {
    const ordered = [...shown.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    content = (
      <ol className="flex flex-col gap-3">
        {ordered.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-1 border-l-2 pl-3" style={{ borderColor: 'var(--rule)' }}>
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm" style={{ color: 'var(--text)' }}>
              <time dateTime={entry.at} className="text-xs" style={{ fontFamily: 'var(--mono)', color: 'var(--soft)' }}>
                {formatDateTime(entry.at)}
              </time>
              <span className="font-medium">{actionLabel(entry.action)}</span>
              <span style={{ color: 'var(--soft)' }}>{t.by(identityLabel(entry.actor))}</span>
            </p>
            {entry.changes.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-sm" style={{ color: 'var(--text)' }}>
                {entry.changes.map((change, index) => (
                  <li key={`${change.field}-${index}`}>
                    {t.change(
                      fieldLabel(change.field),
                      valueLabel(change.field, change.from, asset),
                      valueLabel(change.field, change.to, asset),
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    )
  }

  return (
    <section aria-labelledby={headingId} data-testid="history-timeline" className="card">
      <h3
        id={headingId}
        className="card-title"
      >
        {t.heading}
      </h3>
      {content}
    </section>
  )
}
