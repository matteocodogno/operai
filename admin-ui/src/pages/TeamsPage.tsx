import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Button, Card, DataTable, Field, formatNumber, PageHeader, StatePanel, VisuallyHidden } from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import * as adminApi from '../lib/adminApi'
import type { TeamSummary } from '../lib/adminApi'
import { ApiError, teamNameClash } from '../lib/adminApi'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import SkeletonListRows from '../components/SkeletonListRows'
import SuccessBanner from '../components/SuccessBanner'
import TeamFormDialog from '../components/TeamFormDialog'
import TeamStatusBadge from '../components/TeamStatusBadge'
import { setFlash, useFlash } from '../lib/flash'
import { strings } from '../strings'

const t = strings.teams

/**
 * TeamsPage — S1, the Teams list (specs/20261126-teams T4; AC-1.1, AC-1.2, AC-1.4, AC-1.7, AC-3.3).
 *
 * `GET /admin/teams` returns every team, archived included, in name order, like the departments list (plan D12): the
 * state filter (Active by default, Archived, All) and the case-insensitive substring search both apply here, in the
 * browser, over that one list. The text is compared literally (`includes`), so `%`, `.` and `*` mean nothing special.
 * There is no pagination (bounded; the trigger to move the filter to the server is about 500 teams) and no delete
 * control of any kind: a team is archived on its own page (AC-1.7).
 *
 * States, one at a time: denied (a 403, admin access revoked mid-session) → loading → failed (a warning with Retry)
 * → empty (no team exists) → loaded. A loaded list whose filter shows nothing says why: nothing typed and every
 * team archived is "No active teams"; anything else is "No teams match".
 *
 * Create is a `TeamFormDialog` over the page, mounted beside its content and never inside a `<form>` (ADR
 * 20261118). On success the page opens the new team and leaves a flash for it; a 409 `team_name_taken` WITH the
 * clashing name goes to the dialog's Name field; every other failure, a 409 without the name included, is the
 * generic `createFailed` in the dialog and never the server's English `detail`.
 */

type ListState =
  | { status: 'loading' }
  | { status: 'loaded'; items: TeamSummary[] }
  | { status: 'denied' }
  | { status: 'error'; message: string }

type ShowFilter = 'active' | 'archived' | 'all'

type CreateState = { open: false } | { open: true; busy: boolean; error: string | null; existingName: string | null }

const loadMessage = (error: unknown): string =>
  error instanceof ApiError ? (error.detail ?? error.title) : t.loadError

const matches = (team: TeamSummary, show: ShowFilter, text: string): boolean =>
  (show === 'all' || (show === 'archived') === team.archived) && team.name.toLowerCase().includes(text)

export default function TeamsPage() {
  const navigate = useNavigate()
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [show, setShow] = useState<ShowFilter>('active')
  const [text, setText] = useState('')
  const [create, setCreate] = useState<CreateState>({ open: false })
  const [success, setSuccess] = useFlash('teams')
  const submitting = useRef(false)

  // A Promise chain rather than an async helper: the same lint reasoning as DepartmentsPage's list fetch.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => adminApi.listTeams())
      .then((items) => {
        if (!cancelled) setState({ status: 'loaded', items })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState(
          error instanceof ApiError && error.status === 403
            ? { status: 'denied' }
            : { status: 'error', message: loadMessage(error) },
        )
      })

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const handleRetry = useCallback(() => setReloadToken((n) => n + 1), [])

  const needle = text.trim().toLowerCase()
  const items = state.status === 'loaded' ? state.items : null
  const shown = useMemo(() => items?.filter((team) => matches(team, show, needle)) ?? [], [items, show, needle])

  const handleCreate = useCallback(
    async (values: { name: string; description: string }) => {
      if (submitting.current) return
      submitting.current = true
      // `existingName` goes back to null so that the same clash twice is raised (and focused) twice.
      setCreate({ open: true, busy: true, error: null, existingName: null })
      try {
        const created = await adminApi.createTeam(
          values.description === '' ? { name: values.name } : { name: values.name, description: values.description },
        )
        setCreate({ open: false })
        // The page this navigates to says the team was created (INC-19).
        setFlash(`team:${created.id}`, t.created(created.name))
        navigate({ to: '/teams/$id', params: { id: created.id } })
      } catch (error) {
        const existingName = teamNameClash(error)
        setCreate({
          open: true,
          busy: false,
          error: existingName === null ? t.form.createFailed : null,
          existingName,
        })
      } finally {
        submitting.current = false
      }
    },
    [navigate],
  )

  const columns: DataTableColumn<TeamSummary>[] = [
    {
      id: 'name',
      header: t.columns.name,
      rowHeader: true,
      render: (team) => (
        <Link to="/teams/$id" params={{ id: team.id }} className="link" data-testid={`team-open-${team.id}`}>
          {team.name}
        </Link>
      ),
    },
    {
      id: 'members',
      header: t.columns.members,
      numeric: true,
      render: (team) => formatNumber(team.activeMemberCount),
    },
    {
      id: 'state',
      header: t.columns.state,
      render: (team) => <TeamStatusBadge archived={team.archived} testId={`team-state-${team.id}`} />,
    },
  ]

  const emptyPanel = () => {
    if (needle === '' && show === 'active' && items?.every((team) => team.archived)) {
      return (
        <StatePanel title={t.noActive.title} testId="teams-no-active">
          {t.noActive.body}
        </StatePanel>
      )
    }
    return (
      <StatePanel title={t.noMatch.title} testId="teams-no-match">
        {t.noMatch.body}
      </StatePanel>
    )
  }

  return (
    <section aria-labelledby="admin-teams-heading" data-testid="admin-teams-page">
      {create.open && (
        <TeamFormDialog
          mode="create"
          busy={create.busy}
          error={create.error}
          existingName={create.existingName}
          onSubmit={(values) => void handleCreate(values)}
          onCancel={() => setCreate({ open: false })}
        />
      )}

      <PageHeader
        title={t.heading}
        titleId="admin-teams-heading"
        description={t.description}
        actions={
          state.status === 'denied' ? undefined : (
            <Button
              variant="primary"
              onClick={() => setCreate({ open: true, busy: false, error: null, existingName: null })}
              data-testid="new-team-button"
            >
              {t.newTeam}
            </Button>
          )
        }
      />

      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} testId="teams-success" className="mb-4" />

      {state.status === 'denied' && <PermissionDenied headingLevel={3} />}

      {state.status === 'loading' && <SkeletonListRows rows={4} label={t.loading} />}

      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={handleRetry} />}

      {state.status === 'loaded' && state.items.length === 0 && (
        <StatePanel title={t.empty.title} testId="teams-empty-state">
          {t.empty.body}
        </StatePanel>
      )}

      {state.status === 'loaded' && state.items.length > 0 && (
        <>
          <Card title={t.filters.title} className="mb-4">
            <div className="flex flex-wrap gap-4">
              <Field label={t.filters.search} hint={t.filters.searchHint} className="min-w-64 flex-1">
                {(control) => (
                  <input
                    {...control}
                    type="search"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    data-testid="teams-search"
                  />
                )}
              </Field>
              <Field label={t.filters.show}>
                {(control) => (
                  <select
                    {...control}
                    value={show}
                    onChange={(e) => setShow(e.target.value as ShowFilter)}
                    data-testid="teams-show"
                  >
                    <option value="active">{t.filters.active}</option>
                    <option value="archived">{t.filters.archived}</option>
                    <option value="all">{t.filters.all}</option>
                  </select>
                )}
              </Field>
            </div>
          </Card>

          <VisuallyHidden live data-testid="teams-count-live">
            {t.count(shown.length)}
          </VisuallyHidden>

          {shown.length === 0 ? (
            emptyPanel()
          ) : (
            <DataTable
              caption={t.caption}
              columns={columns}
              rows={shown}
              getRowKey={(team) => team.id}
              interactiveRows
              testId="teams-table"
            />
          )}
        </>
      )}
    </section>
  )
}
