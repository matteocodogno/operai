/**
 * UsersPage — Screen C1 (design.md "Users list — search+pagination", T20,
 * specs/004-auth-roles-permissions/tasks.md). Replaces T14's placeholder.
 *
 * A search input (name/email → `?q=`, design.md's plan-drift-fix) drives a
 * paginated table (`adminApi.listUsers({ q, page, pageSize })`, plan.md
 * `GET /admin/users`) rendered with the shared Pagination primitive (T15) —
 * the `{ items, page, pageSize, total }` envelope. Columns: Name (links to
 * Screen C2), Email, Entity, Job title, and role/department chip counts
 * (design.md "Key elements"). Selecting a row navigates to
 * `/users/$id` (Screen C2, ./UserDetail.tsx).
 *
 * States mirror every other admin-ui list screen (design.md "L/E/P/Err"),
 * same pattern as ../pages/AuditPage.tsx (T21):
 *   L — SkeletonListRows while the current page loads.
 *   E — "No users match your search." (design.md: search-scoped empty state,
 *       distinct from a true zero-users case which can't happen post-sign-in
 *       since every signed-in user gets `employee`, AC-6.3).
 *   P — the table + Pagination control.
 *   Err — ErrorBanner + Retry, re-running the same page/query.
 *
 * Changing the search query resets to page 1 (a stale page number against a
 * new, possibly-shorter result set would otherwise strand the user past the
 * last page).
 *
 * Built as an explicit Promise chain in the fetch effect, not async/await —
 * see ../pages/AuditPage.tsx's doc comment for the full rationale
 * (`react-hooks/set-state-in-effect` false positive on an async function
 * that calls a state setter after an `await`).
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import * as adminApi from '../lib/adminApi'
import type { Paginated, UserSummary } from '../lib/adminApi'
import { ApiError } from '../lib/adminApi'
import SkeletonListRows from '../components/SkeletonListRows'
import ErrorBanner from '../components/ErrorBanner'
import Pagination from '../components/Pagination'

const PAGE_SIZE = 20

const formatEntity = (entity: UserSummary['entity']): string => {
  if (entity === 'welld_ch') return 'WellD CH'
  if (entity === 'welld_it') return 'WellD Italia'
  return '—'
}

type UsersState =
  | { status: 'loading' }
  | { status: 'loaded'; result: Paginated<UserSummary> }
  | { status: 'error'; message: string }

const errorMessageFor = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.detail ?? error.title
  }
  return 'Could not load users.'
}

export default function UsersPage() {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState<UsersState>({ status: 'loading' })

  // Fetches the current page/query whenever they (or `reloadToken`, bumped by
  // "Retry") change. See ../pages/AuditPage.tsx's doc comment for why this is
  // a Promise chain rather than an async/await helper.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => adminApi.listUsers({ q: query || undefined, page, pageSize: PAGE_SIZE }))
      .then((result) => {
        if (!cancelled) setState({ status: 'loaded', result })
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessageFor(error) })
      })

    return () => {
      cancelled = true
    }
  }, [query, page, reloadToken])

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value)
    setPage(1)
  }, [])

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  return (
    <section aria-labelledby="admin-users-heading" data-testid="admin-users-page">
      <h2 id="admin-users-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Users
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        Browse every signed-in user, then open one to set attributes and assign roles or
        departments.
      </p>

      <div className="mt-4">
        <label htmlFor="users-search-input" className="sr-only">
          Search users by name or email
        </label>
        <input
          id="users-search-input"
          type="search"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Search by name or email…"
          data-testid="users-search-input"
          className="w-full sm:w-80 border rounded-md px-3 py-2 text-sm"
          style={{ borderColor: 'var(--rule)', backgroundColor: 'var(--ink-mid)', color: 'var(--text)' }}
        />
      </div>

      <div className="mt-4">
        {state.status === 'loading' && <SkeletonListRows rows={5} />}

        {state.status === 'error' && <ErrorBanner message={state.message} onRetry={handleRetry} />}

        {state.status === 'loaded' && state.result.total === 0 && (
          <p
            className="text-sm py-6 text-center"
            style={{ color: 'var(--soft)' }}
            data-testid="users-empty-state"
          >
            No users match your search.
          </p>
        )}

        {state.status === 'loaded' && state.result.total > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]" data-testid="users-table">
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--rule)' }}>
                    {['Name', 'Email', 'Entity', 'Job title', 'Roles', 'Departments'].map((label) => (
                      <th
                        key={label}
                        scope="col"
                        className="text-left py-1.5 px-2 text-[9px] font-mono uppercase tracking-wider"
                        style={{ color: 'var(--soft)' }}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.result.items.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b"
                      style={{ borderColor: 'color-mix(in srgb, var(--rule) 50%, transparent)' }}
                    >
                      <td className="py-1.5 px-2">
                        <Link
                          to="/users/$id"
                          params={{ id: user.id }}
                          data-testid={`user-row-${user.id}`}
                          className="font-medium transition-opacity hover:opacity-80"
                          style={{ color: 'var(--acc)' }}
                        >
                          {user.name ?? user.email}
                        </Link>
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {user.email}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {formatEntity(user.entity)}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {user.jobTitle ?? '—'}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {user.roleCount}
                      </td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--text)' }}>
                        {user.departmentCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination page={page} pageSize={PAGE_SIZE} total={state.result.total} onPageChange={setPage} />
          </>
        )}
      </div>
    </section>
  )
}
