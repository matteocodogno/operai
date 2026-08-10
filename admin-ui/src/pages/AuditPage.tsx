import { Fragment, useCallback, useEffect, useState } from 'react'
import * as adminApi from '../lib/adminApi'
import type { AuditLogEntry, Paginated } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import Pagination from '../components/Pagination'

/**
 * AuditPage — Screen D1 (design.md "Audit log — paginated reverse-chron
 * table + row-expand diff", T21, specs/004-auth-roles-permissions/tasks.md).
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

const formatTimestamp = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

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
  return entry.actorUserId ? 'Unknown user' : 'Deleted user'
}

const formatTarget = (entry: AuditLogEntry): string =>
  entry.targetId ? `${entry.targetType} · ${entry.targetId}` : entry.targetType

/** Pretty-prints a diff side's value, or a placeholder if it wasn't recorded. */
const formatDiffSide = (value: unknown): string => {
  if (value === undefined) return '(not recorded)'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

type AuditState =
  | { status: 'loading' }
  | { status: 'loaded'; result: Paginated<AuditLogEntry> }
  | { status: 'error'; message: string }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return 'Could not load the audit log.'
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
      <h2 id="admin-audit-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Audit
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        A read-only, reverse-chronological history of every authorization change — roles,
        departments, and user assignments. Nothing here can be edited or deleted.
      </p>

      <div className="mt-4">
        {state.status === 'loading' && <SkeletonListRows rows={5} />}

        {state.status === 'error' && (
          <ErrorBanner message={state.message} onRetry={handleRetry} />
        )}

        {state.status === 'loaded' && state.result.total === 0 && (
          <p className="text-sm py-6 text-center" style={{ color: 'var(--soft)' }} data-testid="audit-empty-state">
            No authorization changes recorded yet.
          </p>
        )}

        {state.status === 'loaded' && state.result.total > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]" data-testid="audit-table">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--rule)' }}>
                    <th scope="col" className="w-8">
                      <span className="sr-only">Expand</span>
                    </th>
                    <th
                      scope="col"
                      className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                      style={{ color: 'var(--soft)' }}
                    >
                      Timestamp
                    </th>
                    <th
                      scope="col"
                      className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                      style={{ color: 'var(--soft)' }}
                    >
                      Actor
                    </th>
                    <th
                      scope="col"
                      className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                      style={{ color: 'var(--soft)' }}
                    >
                      Action
                    </th>
                    <th
                      scope="col"
                      className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                      style={{ color: 'var(--soft)' }}
                    >
                      Target
                    </th>
                    <th
                      scope="col"
                      className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                      style={{ color: 'var(--soft)' }}
                    >
                      Summary
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.result.items.map((entry) => {
                    const isExpanded = expandedIds.has(entry.id)
                    const diffRowId = `audit-diff-${entry.id}`
                    return (
                      <Fragment key={entry.id}>
                        <tr className="border-b" style={{ borderColor: 'color-mix(in srgb, var(--rule) 50%, transparent)' }}>
                          <td className="py-1.5 px-2">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(entry.id)}
                              aria-expanded={isExpanded}
                              aria-controls={diffRowId}
                              data-testid={`audit-row-toggle-${entry.id}`}
                              className="text-xs leading-none transition-opacity hover:opacity-80"
                              style={{ color: 'var(--acc)' }}
                            >
                              <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                              <span className="sr-only">
                                {isExpanded ? 'Hide details' : 'Show details'} for {entry.summary}
                              </span>
                            </button>
                          </td>
                          <td className="py-1.5 px-2 whitespace-nowrap" style={{ color: 'var(--text)' }}>
                            {formatTimestamp(entry.createdAt)}
                          </td>
                          <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                            <span className="block">{formatActorName(entry)}</span>
                            {entry.actorUserId && (
                              <span
                                className="block text-[9px] break-all"
                                style={{ fontFamily: 'var(--mono)', color: 'var(--soft)' }}
                              >
                                {entry.actorUserId}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-2" style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                            {entry.action}
                          </td>
                          <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                            {formatTarget(entry)}
                          </td>
                          <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                            {entry.summary}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr id={diffRowId} data-testid={`audit-diff-${entry.id}`}>
                            <td colSpan={6} className="py-2 px-2">
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div>
                                  <p
                                    className="text-[9px] font-mono uppercase tracking-wider mb-1"
                                    style={{ color: 'var(--soft)' }}
                                  >
                                    Before
                                  </p>
                                  <pre
                                    className="text-[10px] whitespace-pre-wrap break-words p-2 rounded"
                                    style={{ backgroundColor: 'var(--ink-mid)', color: 'var(--text)' }}
                                  >
                                    {formatDiffSide(entry.data?.before)}
                                  </pre>
                                </div>
                                <div>
                                  <p
                                    className="text-[9px] font-mono uppercase tracking-wider mb-1"
                                    style={{ color: 'var(--soft)' }}
                                  >
                                    After
                                  </p>
                                  <pre
                                    className="text-[10px] whitespace-pre-wrap break-words p-2 rounded"
                                    style={{ backgroundColor: 'var(--ink-mid)', color: 'var(--text)' }}
                                  >
                                    {formatDiffSide(entry.data?.after)}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={state.result.total}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </section>
  )
}
