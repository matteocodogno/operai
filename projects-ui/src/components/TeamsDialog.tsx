import { useEffect, useId, useRef, useState } from 'react'
import { Button, FormDialog, SearchPicker, VisuallyHidden } from '@operai/ui'
import type { SearchResult } from '@operai/ui'
import { ApiError, isStaleWrite } from '../lib/api'
import { codeOf, errorMessage, statusOf } from '../lib/errors'
import { searchActiveTeams, replaceTeams } from '../lib/projectsApi'
import { retryAfterSecondsOf, waitSentence } from '../lib/teamsStatus'
import type { AttachableTeam, Project } from '../lib/types'
import { strings } from '../strings'
import { TeamArchivedBadge } from './Badges'

/** At most 10 teams on a project (AC-4.1, O9). */
const MAX_TEAMS = 10
/** The longest team name: text beyond it cannot match any team (plan D13). */
const MAX_QUERY = 80

/** One team of the dialog's list: what the project attached, or what the person staged. `name` is null when it could not be read. */
type Row = { id: string; name: string | null; archived: boolean }

const sameSet = (a: readonly Row[], b: readonly Row[]) =>
  a.length === b.length && a.every((row) => b.some((other) => other.id === row.id))

/**
 * TeamsDialog — edit the whole set of teams of a project in one go (specs/20261126-teams AC-4.1, AC-4.2, AC-5.6;
 * design S7). Attaching is a SERVER search (`GET /attachable-teams?q=`, active teams only): picking stages a team in
 * the list and writes nothing; Remove stages a removal; one `PUT …/teams` with the project's version saves the set.
 * Nothing is fetched on open, so removing and saving work whatever the teams service does. The server judges the
 * ADDED teams only (422 `team_archived` / `team_not_found`, 503 `teams_unavailable`, 429 `rate_limited` for a person
 * over their own limit): each is said inline and the dialog stays open with the set kept. A stale version (409/428) is the
 * page's (`onStale`). Mount it beside the page's forms, never inside one (ADR 20261118).
 */
export default function TeamsDialog({
  project,
  onSaved,
  onCancel,
  onStale,
}: {
  project: Project
  onSaved: (next: Project) => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.project.team.teams.dialog
  const attachedLabelId = useId()
  const initial: Row[] = (project.teams ?? []).map((team) => ({
    id: team.id,
    name: team.name,
    archived: team.archived === true,
  }))
  const [rows, setRows] = useState<Row[]>(initial)
  const [truncated, setTruncated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const labelRef = useRef<HTMLParagraphElement>(null)
  // After a removal the button that had focus is gone: the focus goes to the next Remove, else to the list's label.
  const focusAfterRemoval = useRef<number | null>(null)
  useEffect(() => {
    const index = focusAfterRemoval.current
    if (index === null) return
    focusAfterRemoval.current = null
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
    const target = buttons[Math.min(index, buttons.length - 1)] ?? labelRef.current
    target?.focus()
  })

  const full = rows.length >= MAX_TEAMS
  const unchanged = sameSet(rows, initial)
  const staged = new Set(rows.map((row) => row.id))

  const search = async (q: string, signal: AbortSignal): Promise<SearchResult<AttachableTeam>> => {
    // A name has at most 80 characters: longer text matches nothing, and is never sent (a 400 must not read as an outage).
    if (q.length > MAX_QUERY) return { ok: true, items: [] }
    try {
      const answer = await searchActiveTeams(q, { signal })
      if (!signal.aborted) setTruncated(answer.truncated)
      return { ok: true, items: answer.items.filter((team) => !staged.has(team.id)) }
    } catch (failure) {
      if (signal.aborted) throw failure
      // A 403 is the person's grant; 503, the search's own 429 and a network failure are an outage, never "no match".
      return { ok: false, reason: statusOf(failure) === 403 ? 'forbidden' : 'unavailable' }
    }
  }

  const submit = () => {
    setBusy(true)
    setError(null)
    replaceTeams(
      project.id,
      project.version,
      rows.map((row) => row.id),
    ).then(onSaved, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      const errors = t.errors
      switch (codeOf(failure)) {
        case 'team_archived': {
          const ids =
            failure instanceof ApiError && Array.isArray(failure.extras['teamIds']) ? failure.extras['teamIds'] : []
          const names = ids.map((id) => rows.find((row) => row.id === id)?.name ?? strings.project.team.teams.unnamed)
          return setError(errors.team_archived(names.join(', ')))
        }
        case 'team_not_found':
          return setError(errors.team_not_found)
        case 'teams_unavailable':
          return setError(errors.teams_unavailable)
        case 'rate_limited':
          return setError(`${errors.rate_limited} ${waitSentence(retryAfterSecondsOf(failure))}`)
        default:
          if (statusOf(failure) === 503) {
            return setError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
          }
          return setError(errorMessage(failure))
      }
    })
  }

  return (
    <FormDialog
      title={t.title}
      description={t.description}
      submitLabel={t.submit}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={!unchanged}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      testIdPrefix="project-attached-teams-dialog"
    >
      <SearchPicker<AttachableTeam>
        label={t.add}
        hint={
          full ? t.limitHint(MAX_TEAMS) : `${t.addHint(rows.length, MAX_TEAMS)}${truncated ? ` ${t.narrowHint}` : ''}`
        }
        disabled={full}
        value={null}
        onChange={(team) => {
          if (team) setRows((current) => [...current, { id: team.id, name: team.name, archived: false }])
        }}
        search={search}
        toOption={(team) => ({ id: team.id, label: team.name })}
        messages={t.search}
        testId="project-attached-teams-add"
      />
      <VisuallyHidden live data-testid="project-attached-teams-count">
        {full ? t.limitReached(rows.length, MAX_TEAMS) : ''}
      </VisuallyHidden>
      <div>
        <p id={attachedLabelId} ref={labelRef} tabIndex={-1} className="mb-1 text-xs text-soft">
          {t.attached}
        </p>
        {rows.length === 0 ? (
          <p className="text-sm text-soft">{t.none}</p>
        ) : (
          <ul
            ref={listRef}
            aria-labelledby={attachedLabelId}
            data-testid="project-attached-teams-list"
            className="flex flex-col gap-1"
          >
            {rows.map((row, index) => (
              <li
                key={row.id}
                data-testid={`project-attached-teams-row-${row.id}`}
                className="flex items-center justify-between gap-2 text-sm text-text"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {row.name ?? t.unnamed}
                  {row.archived && <TeamArchivedBadge />}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={row.name === null ? t.removeUnnamed(index + 1) : t.remove(row.name)}
                  onClick={() => {
                    setRows((current) => current.filter((other) => other.id !== row.id))
                    focusAfterRemoval.current = index
                  }}
                  data-testid={`project-attached-teams-remove-${row.id}`}
                >
                  {t.removeButton}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-soft">{t.removeHint}</p>
      </div>
    </FormDialog>
  )
}
