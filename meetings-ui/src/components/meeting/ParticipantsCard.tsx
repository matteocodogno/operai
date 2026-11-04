import { Badge, Button, Card, ConfirmDialog, resolveLocale } from '@operai/ui'
import { useState } from 'react'
import { Saved } from '../LoadState'
import { errorMessage } from '../../lib/errors'
import { updateMeeting } from '../../lib/meetingsApi'
import type { HostInfo, Meeting, PersonRef } from '../../lib/types'
import { strings } from '../../strings'
import EditParticipantsDialog from './EditParticipantsDialog'

export type ParticipantsCardProps = {
  meeting: Meeting
  /** The host's registration, for the host-visible checkbox and its hint (plan G6); null for a standalone meeting. */
  hostInfo: HostInfo | null
  onChanged: (meeting: Meeting) => void
}

const MAX_PARTICIPANTS = 30

const personName = (person: PersonRef): string =>
  person.name ??
  (person.status === 'deleted' ? strings.participants.card.deletedUser : strings.participants.card.unknownUser)

const isMuted = (person: PersonRef): boolean => person.name === null

/**
 * ParticipantsCard — "People and access" (S3 card 4; F13): the creator first, then each
 * participant (a deleted user is shown as deleted, AC-5.10; an external person with their
 * organisation), the count against 30, and for the creator Edit participants plus the "Also
 * visible to people who can open <host>" checkbox. The checkbox exists only for a linked meeting
 * whose host offers it (AC-5.5) and carries the host's OWN continuation phrase from its
 * registration, in the UI language, so no host wording lives here (plan G6). Turning it ON widens
 * the readership and asks first; turning it OFF applies at once.
 */
export default function ParticipantsCard({ meeting, hostInfo, onChanged }: ParticipantsCardProps) {
  const t = strings.participants
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const { can, host } = meeting
  const labels = hostInfo?.labels[resolveLocale()]
  const hostName =
    host === null
      ? null
      : host.title !== null
        ? strings.meeting.details.host.open(labels?.entity ?? host.entityType, host.title)
        : (labels?.entity ?? host.entityType)
  const offersVisibility = host !== null && meeting.hostVisibleOffered && can.setVisibility
  const hostGone = host?.state === 'missing' && meeting.role === 'creator'

  const setVisible = async (visible: boolean) => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await updateMeeting(meeting.id, { hostVisible: visible }))
      setSaved(t.visibility.updated)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <Card
      title={t.card.title}
      data-testid="meetings-participants-card"
      action={
        can.manageParticipants ? (
          <Button variant="secondary" size="sm" aria-haspopup="dialog" onClick={() => setEditing(true)}>
            {t.card.edit}
          </Button>
        ) : undefined
      }
    >
      {saved !== null && <Saved message={saved} onDismiss={() => setSaved(null)} />}

      <ul aria-label={t.card.listLabel} className="flex flex-col divide-y divide-rule">
        <li className="flex flex-wrap items-center gap-2 py-2">
          <span className={isMuted(meeting.creator) ? 'text-sm text-soft' : 'text-sm'}>
            {personName(meeting.creator)}
          </span>
          <Badge tone="accent">{t.card.creatorBadge}</Badge>
        </li>
        {meeting.participants.map((participant) =>
          participant.kind === 'operai' ? (
            <li key={participant.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className={isMuted(participant.person) ? 'text-sm text-soft' : 'text-sm'}>
                {personName(participant.person)}
              </span>
            </li>
          ) : (
            <li key={participant.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="text-sm">{participant.name}</span>
              {participant.organisation !== null && (
                <span className="text-xs text-soft">{participant.organisation}</span>
              )}
              <Badge>{t.card.externalBadge}</Badge>
            </li>
          ),
        )}
      </ul>
      {meeting.participants.length === 0 && <p className="mt-2 text-sm text-soft">{t.card.empty}</p>}
      <p className="mt-2 text-xs text-soft">{t.card.count(meeting.participants.length, MAX_PARTICIPANTS)}</p>

      {offersVisibility && hostName !== null && !hostGone && (
        <div className="mt-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={meeting.hostVisible}
              disabled={busy}
              onChange={(event) => {
                if (event.target.checked) setConfirming(true)
                else void setVisible(false)
              }}
            />
            <span>
              {labels?.visibilityHint
                ? t.visibility.labelWithHint(hostName, labels.visibilityHint)
                : t.visibility.label(hostName)}
            </span>
          </label>
          {error !== null && (
            <p role="alert" className="form-error mt-1">
              {error}
            </p>
          )}
        </div>
      )}
      {hostGone && <p className="mt-4 text-sm text-soft">{t.visibility.hostGone}</p>}

      {confirming && hostName !== null && (
        <ConfirmDialog
          tone="primary"
          title={t.visibility.confirmTitle}
          confirmLabel={t.visibility.confirm}
          busyLabel={t.visibility.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={busy}
          error={error}
          onConfirm={() => void setVisible(true)}
          onCancel={() => setConfirming(false)}
          testIdPrefix="meetings-host-visible-confirm"
        >
          {t.visibility.confirmBody(hostName)}
        </ConfirmDialog>
      )}

      {editing && (
        <EditParticipantsDialog
          meeting={meeting}
          onClose={() => setEditing(false)}
          onChanged={(next) => {
            onChanged(next)
            setSaved(t.card.saved)
          }}
        />
      )}
    </Card>
  )
}
