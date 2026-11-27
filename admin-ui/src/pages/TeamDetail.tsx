import { useEffect, useId, useRef, useState } from 'react'
import { getRouteApi, Link } from '@tanstack/react-router'
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  FactList,
  formatDate,
  formatDateTime,
  Icon,
  PageHeader,
  SearchPicker,
  StatePanel,
  StatusBadge,
  VisuallyHidden,
} from '@operai/ui'
import type { DataTableColumn, SearchResult } from '@operai/ui'
import * as adminApi from '../lib/adminApi'
import type { TeamDetail as TeamDetailData, TeamMemberAdmin, TeamPatchInput, UserSummary } from '../lib/adminApi'
import { ApiError, isVersionConflict, teamNameClash } from '../lib/adminApi'
import ErrorBanner from '../components/ErrorBanner'
import PermissionDenied from '../components/PermissionDenied'
import SkeletonListRows from '../components/SkeletonListRows'
import SuccessBanner from '../components/SuccessBanner'
import TeamFormDialog from '../components/TeamFormDialog'
import TeamStatusBadge from '../components/TeamStatusBadge'
import { useFlash } from '../lib/flash'
import { strings } from '../strings'

const t = strings.teams.detail

const route = getRouteApi('/teams/$id')

/** A team has at most 100 members, deactivated ones included (plan D7). Only the wording and the full state use it: auth decides. */
const TEAM_MEMBER_LIMIT = 100

/**
 * TeamDetail — S3..S5, a team's own page (specs/20261126-teams T5; AC-1.5..1.8, AC-2.1..2.4, AC-3.3).
 *
 * One page, two cards. Details: the name and description (edit through a `TeamFormDialog`), and Archive / Restore
 * (a `ConfirmDialog`). Members: the people in the team, an Add field (a `SearchPicker` over `GET /admin/users?q=`,
 * then an explicit Add button: a pick alone never writes) and a Remove on every row. There is no delete control of
 * any kind (AC-1.7): a team is archived, and it keeps its members.
 *
 * The team's own fields are versioned. Edit, Archive and Restore send the version the page holds as `baseVersion`; a
 * 409 `version_conflict` never overwrites and never throws typed text away: the edit dialog stays open with the typed
 * values and its Save blocked, an Archive / Restore dialog stays open with Confirm unavailable, and once the dialog
 * is closed the page shows the stale banner with Reload (design S4). Members are NOT versioned: add and remove are
 * set operations that answer the whole team, and the page takes only the member list from the answer, so its version
 * stays that of the name and description it shows and a real conflict is still caught by the next edit.
 *
 * Add and remove work on an archived team (AC-2.4), and a deactivated member is listed, badged and removable.
 *
 * States, one at a time: denied (a 403) → loading → not found (404) → failed (a warning with Retry) → loaded. The
 * dialogs are mounted beside the cards, never inside a form (ADR 20261118): the add row is not a `<form>`.
 * Messages come from the catalog and the status code, never from the server's English `detail` (AC-3.3).
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; team: TeamDetailData }
  | { status: 'notFound' }
  | { status: 'denied' }
  | { status: 'error'; message: string }

type EditState =
  { open: false } | { open: true; busy: boolean; error: string | null; existingName: string | null; blocked: boolean }

type ConfirmKind = 'archive' | 'restore'
type ConfirmState = null | { kind: ConfirmKind; busy: boolean; error: string | null; blocked: boolean }
type RemoveState = null | { member: TeamMemberAdmin; busy: boolean; error: string | null }
type AddState = { busy: boolean; error: string | null }

const memberLabel = (user: { name: string | null; email: string }): string => user.name ?? user.email

export default function TeamDetail() {
  const { id } = route.useParams()
  // One instance per team: nothing typed or in flight for another team survives a change of address.
  return <TeamDetailView key={id} id={id} />
}

function TeamDetailView({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [stale, setStale] = useState(false)
  const [edit, setEdit] = useState<EditState>({ open: false })
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [removal, setRemoval] = useState<RemoveState>(null)
  const [picked, setPicked] = useState<UserSummary | null>(null)
  const [add, setAdd] = useState<AddState>({ busy: false, error: null })
  const [created, setCreated] = useFlash(`team:${id}`)
  const [success, setSuccess] = useState<string | null>(null)
  const [membersSuccess, setMembersSuccess] = useState<string | null>(null)
  const [headingFocus, setHeadingFocus] = useState(0)
  const [pickerFocus, setPickerFocus] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  // One write at a time per kind: a double click or Enter must not send two requests.
  const inFlight = useRef({ edit: false, confirm: false, add: false, remove: false })
  const fullId = useId()

  // A Promise chain rather than an async helper: the same lint reasoning as DepartmentDetail's fetch.
  useEffect(() => {
    let cancelled = false

    Promise.resolve()
      .then(() => {
        if (!cancelled) setState({ status: 'loading' })
      })
      .then(() => adminApi.getTeam(id))
      .then((team) => {
        if (!cancelled) setState({ status: 'loaded', team })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 403) setState({ status: 'denied' })
        else if (error instanceof ApiError && error.status === 404) setState({ status: 'notFound' })
        else setState({ status: 'error', message: t.loadError })
      })

    return () => {
      cancelled = true
    }
  }, [id, reloadToken])

  // After an Archive / Restore the button that opened the dialog is gone: focus goes to the page heading.
  useEffect(() => {
    if (headingFocus > 0) headingRef.current?.focus()
  }, [headingFocus])

  // After an add or a remove the next person is added from the same field.
  useEffect(() => {
    if (pickerFocus > 0) pickerRef.current?.querySelector('input')?.focus()
  }, [pickerFocus])

  const reload = () => {
    setStale(false)
    setReloadToken((n) => n + 1)
  }

  const team = state.status === 'loaded' ? state.team : null

  /** A successful write of the team's own fields answers the whole team: it is the freshest picture. */
  const adopt = (next: TeamDetailData) => {
    setState({ status: 'loaded', team: next })
    setStale(false)
  }

  /** Add and remove answer the whole team, of which only the members are taken (see the page note). */
  const adoptMembers = (next: TeamDetailData) =>
    setState((current) =>
      current.status === 'loaded'
        ? {
            status: 'loaded',
            team: { ...current.team, members: next.members, activeMemberCount: next.activeMemberCount },
          }
        : current,
    )

  const handleEdit = async (values: { name: string; description: string }) => {
    if (!team || inFlight.current.edit) return
    const patch: TeamPatchInput = { baseVersion: team.version }
    if (values.name !== team.name) patch.name = values.name
    const description = values.description === '' ? null : values.description
    if (description !== team.description) patch.description = description
    if (patch.name === undefined && patch.description === undefined) {
      setEdit({ open: false })
      return
    }
    inFlight.current.edit = true
    // `existingName` goes back to null so that the same clash twice is raised (and focused) twice.
    setEdit({ open: true, busy: true, error: null, existingName: null, blocked: false })
    try {
      const saved = await adminApi.patchTeam(team.id, patch)
      adopt(saved)
      setEdit({ open: false })
      setSuccess(t.saved)
    } catch (error) {
      if (isVersionConflict(error)) {
        setStale(true)
        setEdit({ open: true, busy: false, error: t.stale.inDialog, existingName: null, blocked: true })
      } else {
        const existingName = teamNameClash(error)
        setEdit({
          open: true,
          busy: false,
          error: existingName === null ? strings.teams.form.saveFailed : null,
          existingName,
          blocked: false,
        })
      }
    } finally {
      inFlight.current.edit = false
    }
  }

  const handleConfirm = async () => {
    if (!team || !confirm || inFlight.current.confirm) return
    const { kind } = confirm
    inFlight.current.confirm = true
    setConfirm({ kind, busy: true, error: null, blocked: false })
    try {
      const saved = await (kind === 'archive' ? adminApi.archiveTeam : adminApi.restoreTeam)(team.id, team.version)
      adopt(saved)
      setConfirm(null)
      setSuccess(t[kind].done(saved.name))
      setHeadingFocus((n) => n + 1)
    } catch (error) {
      setStale((current) => current || isVersionConflict(error))
      setConfirm(
        isVersionConflict(error)
          ? { kind, busy: false, error: t.stale.body, blocked: true }
          : { kind, busy: false, error: t[kind].failed, blocked: false },
      )
    } finally {
      inFlight.current.confirm = false
    }
  }

  const searchUsers = async (q: string): Promise<SearchResult<UserSummary>> => {
    try {
      const found = await adminApi.listUsers({ q, pageSize: 10 })
      // The picker never offers a person who is already a member, a deactivated one included.
      const members = new Set((team?.members ?? []).map((member) => member.id))
      return { ok: true, items: found.items.filter((user) => !members.has(user.id)) }
    } catch (error) {
      return { ok: false, reason: error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unavailable' }
    }
  }

  const handleAdd = async () => {
    if (!team || !picked || inFlight.current.add) return
    if (team.members.length >= TEAM_MEMBER_LIMIT) return
    inFlight.current.add = true
    const person = picked
    setAdd({ busy: true, error: null })
    setMembersSuccess(null)
    try {
      const saved = await adminApi.addTeamMember(team.id, person.id)
      adoptMembers(saved)
      setPicked(null)
      setAdd({ busy: false, error: null })
      setMembersSuccess(t.members.add.added(memberLabel(person)))
      setPickerFocus((n) => n + 1)
    } catch (error) {
      const code = error instanceof ApiError && error.status === 422 ? error.code : undefined
      setAdd({
        busy: false,
        error:
          code === 'user_not_active'
            ? t.members.add.notActive
            : code === 'team_full'
              ? t.members.add.limit(TEAM_MEMBER_LIMIT)
              : t.members.add.failed,
      })
    } finally {
      inFlight.current.add = false
    }
  }

  const handleRemove = async () => {
    if (!team || !removal || inFlight.current.remove) return
    const { member } = removal
    inFlight.current.remove = true
    setRemoval({ member, busy: true, error: null })
    try {
      const saved = await adminApi.removeTeamMember(team.id, member.id)
      adoptMembers(saved)
      setRemoval(null)
      setAdd({ busy: false, error: null })
      setMembersSuccess(t.members.remove.done(member.name))
      setPickerFocus((n) => n + 1)
    } catch {
      setRemoval({ member, busy: false, error: t.members.remove.failed })
    } finally {
      inFlight.current.remove = false
    }
  }

  const columns: DataTableColumn<TeamMemberAdmin>[] = [
    {
      id: 'name',
      header: t.members.columns.name,
      rowHeader: true,
      render: (member) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {member.name}
          {member.deactivated && (
            <StatusBadge status="voided" data-testid={`team-member-deactivated-${member.id}`}>
              {t.members.deactivated}
            </StatusBadge>
          )}
        </span>
      ),
    },
    { id: 'email', header: t.members.columns.email, render: (member) => member.email },
    { id: 'added', header: t.members.columns.added, render: (member) => formatDate(member.addedAt) },
    {
      id: 'actions',
      header: <VisuallyHidden>{strings.common.actionsColumn}</VisuallyHidden>,
      render: (member) => (
        <Button
          variant="danger"
          size="sm"
          aria-label={t.members.remove.label(member.name)}
          aria-haspopup="dialog"
          onClick={() => setRemoval({ member, busy: false, error: null })}
          data-testid={`team-member-remove-${member.id}`}
        >
          {strings.common.actions.remove}
        </Button>
      ),
    },
  ]

  const memberCount = team?.members.length ?? 0
  const deactivatedCount = team?.members.filter((member) => member.deactivated).length ?? 0
  const full = memberCount >= TEAM_MEMBER_LIMIT
  const dialogOpen = edit.open || confirm !== null || removal !== null

  return (
    <section aria-labelledby="team-detail-heading" data-testid="team-detail-page">
      {team && edit.open && (
        <TeamFormDialog
          mode="edit"
          initial={{ name: team.name, description: team.description }}
          busy={edit.busy}
          error={edit.error}
          existingName={edit.existingName}
          submitBlocked={edit.blocked}
          onSubmit={(values) => void handleEdit(values)}
          onCancel={() => setEdit({ open: false })}
        />
      )}

      {team && confirm && (
        <ConfirmDialog
          tone="primary"
          title={t[confirm.kind].title(team.name)}
          confirmLabel={t[confirm.kind].confirm}
          busyLabel={t[confirm.kind].busy}
          cancelLabel={strings.common.actions.cancel}
          closeLabel={strings.common.actions.cancel}
          busy={confirm.busy}
          error={confirm.error}
          confirmDisabledReason={confirm.blocked ? t.stale.confirmReason : undefined}
          onConfirm={() => void handleConfirm()}
          onCancel={() => setConfirm(null)}
          testIdPrefix={`${confirm.kind}-team`}
        >
          {t[confirm.kind].body}
        </ConfirmDialog>
      )}

      {removal && (
        <ConfirmDialog
          tone="danger"
          title={t.members.remove.title(removal.member.name)}
          confirmLabel={strings.common.actions.remove}
          busyLabel={strings.common.actions.removing}
          cancelLabel={strings.common.actions.cancel}
          closeLabel={strings.common.actions.cancel}
          busy={removal.busy}
          error={removal.error}
          onConfirm={() => void handleRemove()}
          onCancel={() => setRemoval(null)}
          testIdPrefix="remove-team-member"
        >
          {t.members.remove.body}
        </ConfirmDialog>
      )}

      <PageHeader
        title={team?.name ?? t.titleFallback}
        titleId="team-detail-heading"
        headingRef={headingRef}
        focusableHeading
        status={team ? <TeamStatusBadge archived={team.archived} testId="team-status" /> : undefined}
        back={
          <Link to="/teams" className="link" data-testid="team-detail-back-link">
            <Icon name="arrow-left" /> {t.back}
          </Link>
        }
        actions={
          team ? (
            <>
              <Button
                variant="secondary"
                aria-haspopup="dialog"
                onClick={() => setEdit({ open: true, busy: false, error: null, existingName: null, blocked: false })}
                data-testid="team-edit-details"
              >
                {t.editDetails}
              </Button>
              {team.archived ? (
                <Button
                  key="restore"
                  variant="secondary"
                  aria-haspopup="dialog"
                  onClick={() => setConfirm({ kind: 'restore', busy: false, error: null, blocked: false })}
                  data-testid="team-restore"
                >
                  {t.restore.action}
                </Button>
              ) : (
                <Button
                  key="archive"
                  variant="secondary"
                  aria-haspopup="dialog"
                  onClick={() => setConfirm({ kind: 'archive', busy: false, error: null, blocked: false })}
                  data-testid="team-archive"
                >
                  {t.archive.action}
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      <SuccessBanner message={created} onDismiss={() => setCreated(null)} testId="team-created" className="mb-4" />
      <SuccessBanner message={success} onDismiss={() => setSuccess(null)} testId="team-success" className="mb-4" />

      {state.status === 'denied' && <PermissionDenied headingLevel={3} />}

      {state.status === 'loading' && <SkeletonListRows rows={4} label={t.loading} />}

      {state.status === 'notFound' && (
        <StatePanel title={t.notFound.title} role="alert" focusOnMount testId="team-not-found">
          {t.notFound.body}
        </StatePanel>
      )}

      {state.status === 'error' && <ErrorBanner message={state.message} onRetry={() => setReloadToken((n) => n + 1)} />}

      {team && (
        <div className="flex flex-col gap-4">
          {stale && !dialogOpen && (
            <Banner
              tone="danger"
              title={t.stale.title}
              onRetry={reload}
              retryLabel={t.stale.reload}
              retryTestId="team-stale-reload"
              data-testid="team-stale-banner"
            >
              {t.stale.body}
            </Banner>
          )}

          {team.archived && (
            <Banner tone="info" live="off" data-testid="team-archived-note">
              {t.archivedNote}
            </Banner>
          )}

          <Card title={t.detailsTitle} data-testid="team-details-section">
            <FactList
              items={[
                {
                  id: 'description',
                  term: strings.common.fields.description,
                  value: team.description ?? t.noDescription,
                },
                { id: 'created', term: t.created, value: formatDateTime(team.createdAt) },
                { id: 'updated', term: t.updated, value: formatDateTime(team.updatedAt) },
              ]}
            />
          </Card>

          <Card title={t.members.title} data-testid="team-members-section">
            <p className="text-sm text-soft mb-3">{t.members.hint}</p>

            <p className="text-sm mb-3" data-testid="team-members-count">
              {t.members.countOf(memberCount, TEAM_MEMBER_LIMIT)}
              {deactivatedCount > 0 && t.members.deactivatedCount(deactivatedCount)}
            </p>

            {/* Top-aligned: the field has a hint under its input, so bottom alignment would put Add level with the hint. */}
            <div className="flex flex-wrap items-start gap-3 mb-3">
              <div ref={pickerRef} className="min-w-64 flex-1">
                <SearchPicker<UserSummary>
                  label={t.members.add.label}
                  hint={t.members.add.hint}
                  disabled={full || add.busy}
                  value={picked}
                  onChange={(user) => {
                    setPicked(user)
                    setAdd({ busy: false, error: null })
                  }}
                  search={searchUsers}
                  toOption={(user) => ({
                    id: user.id,
                    label: memberLabel(user),
                    secondaryLabel: user.name ? user.email : undefined,
                  })}
                  messages={{
                    searching: t.members.add.searching,
                    noMatch: t.members.add.noMatch,
                    forbidden: t.members.add.forbidden,
                    unavailable: t.members.add.unavailable,
                    count: t.members.add.count,
                  }}
                  testId="team-member-picker"
                />
              </div>
              <div className="field">
                {/* The field's own label, invisible, so Add starts where the input starts in either language. */}
                <span aria-hidden="true" className="field-label invisible">
                  {t.members.add.label}
                </span>
                <Button
                  variant="secondary"
                  busy={add.busy}
                  disabled={!full && picked === null}
                  aria-disabled={full ? true : undefined}
                  aria-describedby={full ? fullId : undefined}
                  onClick={() => void handleAdd()}
                  data-testid="team-member-add"
                >
                  {add.busy ? t.members.add.busy : t.members.add.button}
                </Button>
              </div>
            </div>

            {full && (
              <p id={fullId} className="text-sm text-soft mb-3" data-testid="team-members-full">
                {t.members.add.full(TEAM_MEMBER_LIMIT)}
              </p>
            )}

            {add.error && (
              <p role="alert" className="form-error mb-3" data-testid="team-members-error">
                {add.error}
              </p>
            )}

            <SuccessBanner
              message={membersSuccess}
              onDismiss={() => setMembersSuccess(null)}
              testId="team-members-success"
              className="mb-3"
            />

            {team.members.length === 0 ? (
              <StatePanel title={t.members.empty.title} testId="team-members-empty">
                {t.members.empty.body}
              </StatePanel>
            ) : (
              <>
                <DataTable
                  caption={t.members.caption}
                  columns={columns}
                  rows={team.members}
                  getRowKey={(member) => member.id}
                  rowTestIdPrefix="team-member"
                  testId="team-members-table"
                />
                {deactivatedCount > 0 && <p className="text-xs text-soft mt-3">{t.members.deactivatedNote}</p>}
              </>
            )}
          </Card>
        </div>
      )}
    </section>
  )
}
