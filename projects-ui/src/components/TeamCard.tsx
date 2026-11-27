import { useId, useState } from 'react'
import { Button, Card, FormDialog } from '@operai/ui'
import { ApiError, isStaleWrite } from '../lib/api'
import { codeOf, errorMessage, userIdsOf } from '../lib/errors'
import { personName } from '../lib/people'
import { replaceTeam } from '../lib/projectsApi'
import type { Person, Project } from '../lib/types'
import { strings } from '../strings'
import AttachedTeams from './AttachedTeams'
import PersonPicker from './PersonPicker'
import TeamsDialog from './TeamsDialog'

const MAX_MEMBERS = 100

/**
 * TeamDialog — edit the whole team in one go: remove people, add people picked
 * among those who hold access to the module (the directory, ADR 20261101-app-access-check-by-user-id-and-directory-app-filter), then one
 * `PUT` replaces the team (AC-1.6). The server re-checks every member (422
 * `not_project_user` naming the ids, 503 `identity_unavailable`); a stale save
 * (AC-1.7) closes the dialog and is the page's (`onStale`).
 */
function TeamDialog({
  project,
  currentUserId,
  onSaved,
  onCancel,
  onStale,
}: {
  project: Project
  currentUserId: string | null
  onSaved: (next: Project) => void
  onCancel: () => void
  onStale: () => void
}) {
  const t = strings.project.team.dialog
  const membersId = useId()
  const [members, setMembers] = useState<Person[]>([...project.team])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const unchanged =
    members.length === project.team.length && members.every((member, index) => member.id === project.team[index]?.id)

  const submit = () => {
    if (members.length > MAX_MEMBERS) return setError(t.tooMany)
    setBusy(true)
    setError(null)
    replaceTeam(
      project.id,
      project.version,
      members.map((member) => member.id),
    ).then(onSaved, (failure: unknown) => {
      setBusy(false)
      if (isStaleWrite(failure)) return onStale()
      const errors = strings.project.team.errors
      if (codeOf(failure) === 'not_project_user') {
        const names = userIdsOf(failure).map((id) => {
          const person = members.find((member) => member.id === id)
          return person ? personName(person) : id
        })
        return setError(errors.not_project_user(names.join(', ')))
      }
      if (codeOf(failure) === 'identity_unavailable') return setError(errors.identity_unavailable)
      if (failure instanceof ApiError && failure.status === 503) {
        return setError(`${strings.common.authUnavailable.heading}. ${strings.common.authUnavailable.body}`)
      }
      setError(errorMessage(failure))
    })
  }

  return (
    <FormDialog
      title={t.title}
      submitLabel={t.submit}
      busyLabel={t.busy}
      cancelLabel={strings.common.cancel}
      closeLabel={strings.common.close}
      busy={busy}
      canSubmit={!unchanged}
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      testIdPrefix="project-team"
    >
      <PersonPicker
        label={t.add}
        hint={t.addHint}
        value={null}
        onChange={(choice) => {
          if (choice) {
            setMembers((current) => [...current, { id: choice.id, name: choice.label, deleted: false }])
          }
        }}
        excludeIds={members.map((member) => member.id)}
        clearOnSelect
        testId="project-team-add"
      />
      <div data-testid="project-team-members">
        <p id={membersId} className="mb-1 text-xs text-soft">
          {t.members}
        </p>
        {members.length === 0 ? (
          <p className="text-sm text-soft">{t.none}</p>
        ) : (
          <ul aria-labelledby={membersId} className="flex flex-col gap-1">
            {members.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-2 text-sm text-text">
                <span>{personName(member, currentUserId)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t.remove(personName(member))}
                  onClick={() => setMembers((current) => current.filter((other) => other.id !== member.id))}
                >
                  {t.removeButton}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </FormDialog>
  )
}

/**
 * TeamCard — who is on the project (AC-1.3, AC-1.5, AC-1.6, AC-4.1; specs/20261126-teams design S6). Two sections
 * under one "Team" heading: **People**, the listed team (unchanged), and **Teams**, the attached teams with their
 * members (`AttachedTeams`). Names are live: the API resolves them on every read, so a renamed team or a deleted
 * user shows as they are now. A holder of manage projects for the project's entity edits each list; the two dialogs
 * are siblings of the card, never inside a form (ADR 20261118).
 */
export default function TeamCard({
  project,
  currentUserId,
  canManage,
  onSaved,
  onStale,
  onReloadTeams,
}: {
  project: Project
  currentUserId: string | null
  canManage: boolean
  /** A save made the project `next`; `message` is what the page confirms ("Team saved." or "Teams saved."). */
  onSaved: (next: Project, message: string) => void
  onStale: () => void
  /** Retry of a banner: reloads the project in place and resolves with it, or `null` when the page took the failure over. */
  onReloadTeams: () => Promise<Project | null>
}) {
  const t = strings.project.team
  const [editing, setEditing] = useState<'people' | 'teams' | null>(null)
  const close = () => setEditing(null)
  return (
    <>
      <Card title={t.title} data-testid="project-team">
        <div className="flex flex-col gap-4">
          <div data-testid="project-team-people" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-text">{t.people.title}</h4>
              {canManage && (
                <Button
                  size="sm"
                  aria-haspopup="dialog"
                  onClick={() => setEditing('people')}
                  data-testid="project-team-edit"
                >
                  {t.edit}
                </Button>
              )}
            </div>
            {project.team.length === 0 ? (
              <p className="text-sm text-soft">{t.empty}</p>
            ) : (
              <ul aria-label={t.people.label} className="flex flex-col gap-1 text-sm text-text">
                {project.team.map((person) => (
                  <li key={person.id}>{personName(person, currentUserId)}</li>
                ))}
              </ul>
            )}
          </div>
          <AttachedTeams
            project={project}
            currentUserId={currentUserId}
            canManage={canManage}
            onEdit={() => setEditing('teams')}
            onReload={onReloadTeams}
          />
        </div>
      </Card>
      {editing === 'people' && (
        <TeamDialog
          project={project}
          currentUserId={currentUserId}
          onCancel={close}
          onSaved={(next) => {
            close()
            onSaved(next, strings.project.saved.team)
          }}
          onStale={() => {
            close()
            onStale()
          }}
        />
      )}
      {editing === 'teams' && (
        <TeamsDialog
          project={project}
          onCancel={close}
          onSaved={(next) => {
            close()
            onSaved(next, strings.project.saved.teams)
          }}
          onStale={() => {
            close()
            onStale()
          }}
        />
      )}
    </>
  )
}
