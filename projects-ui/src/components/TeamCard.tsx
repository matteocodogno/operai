import { useId, useState } from 'react'
import { Button, Card, FormDialog } from '@operai/ui'
import { ApiError, isStaleWrite } from '../lib/api'
import { codeOf, errorMessage, userIdsOf } from '../lib/errors'
import { personName } from '../lib/people'
import { replaceTeam } from '../lib/projectsApi'
import type { Person, Project } from '../lib/types'
import { strings } from '../strings'
import PersonPicker from './PersonPicker'

const MAX_MEMBERS = 100

/**
 * TeamDialog — edit the whole team in one go: remove people, add people picked
 * among those who hold access to the module (the directory, ADR-0055), then one
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
 * TeamCard — the people on the project (AC-1.5, AC-1.6). Names are live: the API
 * resolves them on every read, so a renamed or deleted user shows as they are
 * now. A holder of manage projects for the project's entity edits the team.
 */
export default function TeamCard({
  project,
  currentUserId,
  canManage,
  onSaved,
  onStale,
}: {
  project: Project
  currentUserId: string | null
  canManage: boolean
  onSaved: (next: Project) => void
  onStale: () => void
}) {
  const t = strings.project.team
  const [editing, setEditing] = useState(false)
  return (
    <>
      <Card
        title={t.title}
        data-testid="project-team"
        action={
          canManage && (
            <Button size="sm" aria-haspopup="dialog" onClick={() => setEditing(true)} data-testid="project-team-edit">
              {t.edit}
            </Button>
          )
        }
      >
        {project.team.length === 0 ? (
          <p className="text-sm text-soft">{t.empty}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-text">
            {project.team.map((person) => (
              <li key={person.id}>{personName(person, currentUserId)}</li>
            ))}
          </ul>
        )}
      </Card>
      {editing && (
        <TeamDialog
          project={project}
          currentUserId={currentUserId}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false)
            onSaved(next)
          }}
          onStale={() => {
            setEditing(false)
            onStale()
          }}
        />
      )}
    </>
  )
}
