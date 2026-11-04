import { Banner, Button, Card, Icon, formatDate } from '@operai/ui'
import { useId, useState } from 'react'
import { codeOf, errorMessage } from '../../lib/errors'
import { confirmConsent } from '../../lib/meetingsApi'
import type { Meeting, PersonRef } from '../../lib/types'
import { strings } from '../../strings'

export type ConsentCardProps = {
  meeting: Meeting
  /** The server's fresh view after a write, so the page replaces its copy. */
  onChanged: (meeting: Meeting) => void
}

const attester = (person: PersonRef): string =>
  person.name ??
  (person.status === 'deleted' ? strings.meeting.details.deletedUser : strings.meeting.details.unknownUser)

type Copied = 'idle' | 'copied' | 'failed'

/**
 * ConsentCard — the consent attestation (F3; AC-4.1, AC-4.2, AC-4.3). Until it is given, a
 * `recorded` or `uploaded` draft shows only this: the versioned notice (five statements), the
 * announcement to read aloud or paste in the meeting chat, one explicit tick, and Continue, which
 * posts the notice version that was shown. The page renders no capture control before the meeting
 * carries an attestation (AC-2.1). Afterwards the card is the one-line fact "Confirmed by <name>
 * on <date>, notice <version>". A text meeting has no consent step (AC-3.4), and someone who
 * cannot capture sees the fact if there is one and nothing otherwise.
 */
export default function ConsentCard({ meeting, onChanged }: ConsentCardProps) {
  const t = strings.consent
  const tickId = useId()
  const [ticked, setTicked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outdated, setOutdated] = useState(false)
  const [copied, setCopied] = useState<Copied>('idle')

  if (meeting.source === 'text') return null

  if (meeting.consent !== null) {
    const { by, at, noticeVersion } = meeting.consent
    return (
      <Card title={t.title} data-testid="meetings-consent-card">
        <p className="flex items-center gap-2 text-sm">
          <Icon name="check-circle" />
          {strings.meeting.details.consent.line(attester(by), formatDate(at), noticeVersion)}
        </p>
      </Card>
    )
  }

  if (!meeting.can.capture) return null

  const proceed = async () => {
    setBusy(true)
    setError(null)
    setOutdated(false)
    try {
      onChanged(await confirmConsent(meeting.id, t.version))
    } catch (failure) {
      if (codeOf(failure) === 'notice_outdated') setOutdated(true)
      else setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(t.announcementText)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <Card title={t.title} data-testid="meetings-consent-card">
      <p className="text-sm">{t.intro}</p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm">
        {t.statements.map((statement) => (
          <li key={statement}>{statement}</li>
        ))}
      </ul>

      <div className="mt-4 rounded border border-rule bg-ink p-3">
        <p className="field-label">{t.announcementTitle}</p>
        <p className="field-hint">{t.announcementHint}</p>
        <p className="mt-2 text-sm">{t.announcementText}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            <Icon name="copy" /> {t.copyAnnouncement}
          </Button>
          <span role="status" className="text-xs text-soft">
            {copied === 'copied' ? t.copied : copied === 'failed' ? t.copyFailed : ''}
          </span>
        </div>
      </div>

      <form
        className="mt-4 flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (ticked && !busy) void proceed()
        }}
      >
        <div className="flex items-start gap-2 text-sm">
          <input
            id={tickId}
            type="checkbox"
            checked={ticked}
            disabled={busy}
            onChange={(event) => setTicked(event.target.checked)}
          />
          <label htmlFor={tickId}>{t.confirmLabel}</label>
        </div>

        {outdated && (
          <Banner
            tone="warning"
            onRetry={() => window.location.reload()}
            retryLabel={t.outdated.reload}
            data-testid="meetings-consent-outdated"
          >
            {t.outdated.message}
          </Banner>
        )}
        {error !== null && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}

        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={!ticked}
            busy={busy}
          >
            {busy ? t.busy : t.continue}
          </Button>
        </div>
      </form>
    </Card>
  )
}
