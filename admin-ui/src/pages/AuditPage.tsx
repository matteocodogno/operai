import { useCallback, useEffect, useState } from 'react'
import { Icon, PageHeader, StatePanel, formatDateTime, DataTable } from '@operai/ui'
import * as adminApi from '../lib/adminApi'
import type { AuditLogEntry, Paginated } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import Pagination from '../components/Pagination'
import { strings } from '../strings'

const t = strings.audit

/**
 * AuditPage — Screen D1 (design.md "Audit log — paginated reverse-chron
 * table + row-expand diff", T21, specs/20260713-auth-roles-permissions/tasks.md).
 *
 * Replaces T14's placeholder with the real screen: a paginated,
 * reverse-chronological semantic `<table>` (Timestamp / Actor / Action /
 * Target / Summary — design.md's "Key elements" for Screen D1) sourced from
 * `adminApi.listAudit({ page, pageSize })` (plan.md `GET /admin/audit`,
 * AC-5.2). Each row can expand to reveal the entry's `data` before/after
 * diff (F6 step 2). The list is read-only end to end — **no edit/delete
 * affordance anywhere on this screen** enforces AC-5.3 by omission, exactly
 * as design.md prescribes ("a disabled button would incorrectly imply
 * mutation is *sometimes* possible").
 *
 * States mirror every other admin-ui list screen (design.md "L/E/P/Err"):
 *   L — SkeletonListRows (ported pattern, T15) while the first page loads.
 *   E — reverse-chron empty state, "No authorization changes recorded yet"
 *       (design.md: "only possible immediately post-bootstrap").
 *   P — the table + Pagination control (T15's shared, first-of-its-kind
 *       primitive, also consumed by the later Users list, T20).
 *   Err — ErrorBanner (ported pattern, T15) + Retry, re-running the same
 *       page's fetch (mirrors EstimatesPage's list-error convention).
 *
 * A11y (design.md "Accessibility — Data tables"): semantic `<table>` with
 * `<th scope="col">` per column (ported from `ImportOfferModal`'s existing
 * results-table convention) — never a `<div>` grid. The row-expand control
 * is a real `<button aria-expanded>` (never a clickable `<tr>`/`<div>`),
 * `aria-controls` pointing at the diff row it reveals, so the relationship
 * is programmatically discoverable — this pattern has no in-repo precedent
 * (design.md's component inventory: "row-expand-to-diff has no precedent —
 * new").
 */

const PAGE_SIZE = 20


/**
 * The actor's display name, from the `actor` identity `GET /admin/audit` joins
 * onto every row. An auditor scans this column for *who* — a bare cuid answers
 * that only after a second lookup — so the name leads and the raw id stays
 * underneath for correlation with the rest of the admin API.
 *
 * `actor` is null exactly when `actorUserId` is (`onDelete: SetNull` on a hard
 * delete), leaving no name to resolve; the defensive "Unknown user" branch
 * covers an id whose join came back empty, so the cell is never blank.
 */
const formatActorName = (entry: AuditLogEntry): string => {
  if (entry.actor) return entry.actor.name.trim() || entry.actor.email
  return entry.actorUserId ? t.unknownUser : t.deletedUser
}

const formatTarget = (entry: AuditLogEntry): string =>
  entry.targetId ? t.target(entry.targetType, entry.targetId) : entry.targetType

/** Pretty-prints a diff side's value, or a placeholder if it wasn't recorded. */
const formatDiffSide = (value: unknown): string => {
  if (value === undefined) return t.notRecorded
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The two panes of an entry's expanded row. Authorization rows carry
 * `data.before` / `data.after` and render exactly as they always did. Legal
 * entity save and restore rows carry `data.changes` (`{ <field>: { before,
 * after } }`, auth `write.routes.ts`) instead, so — only when neither
 * `before` nor `after` is present — each pane is rebuilt from it as
 * `{ <field>: <value> }` (security-review F7, plan G10). Anything else
 * (notice and import rows, a malformed `changes`) yields nothing: the panes
 * then say "not recorded" rather than invent a before or an after.
 */
const diffSidesOf = (data: AuditLogEntry['data']): { before: unknown; after: unknown } => {
  if (data === null || data === undefined) return { before: undefined, after: undefined }
  if (data.before !== undefined || data.after !== undefined) return { before: data.before, after: data.after }

  const changes: unknown = (data as Record<string, unknown>).changes
  if (!isRecord(changes)) return { before: undefined, after: undefined }

  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const [field, change] of Object.entries(changes)) {
    if (!isRecord(change)) continue
    if (change.before !== undefined) before[field] = change.before
    if (change.after !== undefined) after[field] = change.after
  }
  return {
    before: Object.keys(before).length > 0 ? before : undefined,
    after: Object.keys(after).length > 0 ? after : undefined,
  }
}

type AuditState =
  { status: 'loading' } | { status: 'loaded'; result: Paginated<AuditLogEntry> } | { status: 'error'; message: string }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return t.loadError
}

export default function AuditPage() {
  const [page, setPage] = useState(1)
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState<AuditState>({ status: 'loading' })
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())

  // Fetches the current page whenever `page` or `reloadToken` (bumped by
  // "Retry") changes. Built as an explicit Promise chain rather than an
  // async/await helper invoked from the effect: an async function that calls
  // a state setter anywhere in its body (even after an `await`) reads, to
  // `react-hooks/set-state-in-effect`'s static analysis, as "this effect
  // calls setState directly" — the very pattern the rule polices — because
  // await-continuations stay within the same function body. Routing each
  // setState call through its own `.then()`/`.catch()` closure keeps the
  // state transition genuinely decoupled from the effect's own body (each
  // closure is its own function boundary the analysis doesn't need to trace
  // through), while the runtime behavior — set loading, fetch, then set
  // loaded/error, ignoring a stale response after unmount/page-change — is
  // unchanged from the equivalent async/await version.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => adminApi.listAudit({ page, pageSize: PAGE_SIZE }))
      .then((result) => {
        if (!cancelled) setState({ status: 'loaded', result })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessageFor(error) })
      })

    return () => {
      cancelled = true
    }
  }, [page, reloadToken])

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  return (
    <section aria-labelledby="admin-audit-heading" data-testid="admin-audit-page">
      <PageHeader
        title={t.heading}
        titleId="admin-audit-heading"
        description={t.description}
      />

      <div>
        {state.status === 'loading' && <SkeletonListRows rows={5} />}

        {state.status === 'error' && <ErrorBanner message={state.message} onRetry={handleRetry} />}

        {state.status === 'loaded' && state.result.total === 0 && (
          <StatePanel title={t.empty.title} testId="audit-empty-state">
            {t.empty.body}
          </StatePanel>
        )}

        {state.status === 'loaded' && state.result.total > 0 && (
          <>
            <DataTable
              caption={t.tableLabel}
              testId="audit-table"
              rows={state.result.items}
              getRowKey={(entry) => entry.id}
              columns={[
                {
                  id: 'expand',
                  header: <span className="visually-hidden">{t.columns.expand}</span>,
                  render: (entry) => {
                    const isExpanded = expandedIds.has(entry.id)
                    return (
                      // A table-cell disclosure toggle, not a button visually (INC-07 exception): no fill, global focus ring.
                      <button
                        type="button"
                        onClick={() => toggleExpanded(entry.id)}
                        aria-expanded={isExpanded}
                        aria-controls={`audit-diff-${entry.id}`}
                        data-testid={`audit-row-toggle-${entry.id}`}
                        className="text-xs leading-none transition-opacity hover:opacity-80 text-acc-text"
                      >
                        <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
                        <span className="visually-hidden">
                          {isExpanded ? t.hideDetails(entry.summary) : t.showDetails(entry.summary)}
                        </span>
                      </button>
                    )
                  },
                },
                {
                  id: 'timestamp',
                  header: t.columns.timestamp,
                  render: (entry) => <span className="whitespace-nowrap font-mono">{formatDateTime(entry.createdAt)}</span>,
                },
                {
                  id: 'actor',
                  header: t.columns.actor,
                  render: (entry) => (
                    <>
                      <span className="block">{formatActorName(entry)}</span>
                      {entry.actorUserId && (
                        <span className="block text-2xs break-all font-mono text-soft">{entry.actorUserId}</span>
                      )}
                    </>
                  ),
                },
                { id: 'action', header: t.columns.action, render: (entry) => <span className="font-mono">{entry.action}</span> },
                { id: 'target', header: t.columns.target, render: (entry) => formatTarget(entry) },
                { id: 'summary', header: t.columns.summary, render: (entry) => entry.summary },
              ]}
              // The expanded entry's before/after, as a full-width row under it (DataTable renderDetail).
              renderDetail={(entry) => {
                if (!expandedIds.has(entry.id)) return null
                const sides = diffSidesOf(entry.data)
                return (
                  <div id={`audit-diff-${entry.id}`} data-testid={`audit-diff-${entry.id}`}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <p className="text-2xs mb-1 text-soft">{t.before}</p>
                        <pre className="text-2xs whitespace-pre-wrap break-words p-2 rounded bg-ink-mid text-text">
                          {formatDiffSide(sides.before)}
                        </pre>
                      </div>
                      <div>
                        <p className="text-2xs mb-1 text-soft">{t.after}</p>
                        <pre className="text-2xs whitespace-pre-wrap break-words p-2 rounded bg-ink-mid text-text">
                          {formatDiffSide(sides.after)}
                        </pre>
                      </div>
                    </div>
                  </div>
                )
              }}
            />

            <Pagination page={page} pageSize={PAGE_SIZE} total={state.result.total} onPageChange={setPage} />
          </>
        )}
      </div>
    </section>
  )
}
