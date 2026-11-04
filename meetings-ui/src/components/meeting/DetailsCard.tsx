import { Card, FactList, formatDate, formatDateTime, formatDuration } from '@operai/ui'
import type { Fact } from '@operai/ui'
import { describeHost, suiteLinkProps } from '../../lib/hostLinks'
import type { HostInfo, Meeting, PersonRef } from '../../lib/types'
import { strings } from '../../strings'

export type DetailsCardProps = {
  meeting: Meeting
  /** The host's registration, for its labels ("Deal", "CRM"); null for a standalone meeting or when `GET /hosts` failed. */
  hostInfo: HostInfo | null
}

const personName = (person: PersonRef): string =>
  person.name ??
  (person.status === 'deleted' ? strings.meeting.details.deletedUser : strings.meeting.details.unknownUser)

type HostDescription = { text: string; href: string | null }

/**
 * How a linked entity reads (S3 Details): "Deal · <title>" while it is open and visible to the
 * caller, "No longer available" once it is gone, else the plain "CRM · deal" (closed, or the host
 * did not answer). The words come from the host's registration, in the UI language (plan G6/G7);
 * without it the registry ids stand in, so nothing is hidden.
 */
function hostDescription(meeting: Meeting, hostInfo: HostInfo | null): HostDescription | null {
  if (meeting.host === null) return null
  const described = describeHost(meeting.host, hostInfo === null ? null : [hostInfo])
  if (described.kind === 'missing') return { text: strings.meeting.details.host.noLongerAvailable, href: null }
  return { text: described.text, href: described.kind === 'open' ? described.href : null }
}

/** The linked entity as text, or as a link opened through the suite while it is open. Renders nothing when standalone. */
export function HostText({ meeting, hostInfo }: DetailsCardProps) {
  const host = hostDescription(meeting, hostInfo)
  if (host === null) return null
  if (host.href === null) return <>{host.text}</>
  return (
    <a className="link" {...suiteLinkProps(host.href)}>
      {host.text}
    </a>
  )
}

/**
 * DetailsCard — the facts of a meeting as a `FactList` (S3 › Details): date, format, language,
 * source, creator (live name, "Deleted user" once deleted: AC-5.10), host, duration, audio
 * (AC-4.4), the consent attestation (who, when, which notice version: AC-4.3) and why the caller
 * can open it. A row with nothing to say is left out, not shown empty.
 */
export default function DetailsCard({ meeting, hostInfo }: DetailsCardProps) {
  const t = strings.meeting.details
  const host = hostDescription(meeting, hostInfo)
  const facts: Fact[] = [
    { id: 'date', term: t.facts.date, value: formatDateTime(meeting.startsAt) },
    { id: 'format', term: t.facts.format, value: strings.meeting.format[meeting.format] },
    { id: 'language', term: t.facts.language, value: strings.meeting.language[meeting.language] },
    { id: 'source', term: t.facts.source, value: strings.meeting.source[meeting.source] },
    { id: 'creator', term: t.facts.creator, value: personName(meeting.creator) },
    {
      id: 'host',
      term: t.facts.host,
      value: host === null ? t.host.standalone : <HostText meeting={meeting} hostInfo={hostInfo} />,
    },
  ]
  if (meeting.durationMs !== null) {
    facts.push({
      id: 'duration',
      term: t.facts.duration,
      value: <span className="font-mono">{formatDuration(meeting.durationMs, { style: 'clock' })}</span>,
    })
  }
  if (meeting.audio.state === 'kept') {
    facts.push({ id: 'audio', term: t.facts.audio, value: t.audio.keptUntil(formatDate(meeting.audio.until)) })
  } else if (meeting.audio.state === 'deleted') {
    facts.push({ id: 'audio', term: t.facts.audio, value: t.audio.deleted })
  }
  // A text meeting has no attestation to show (AC-3.4); a recorded or uploaded one shows it, or that it is still missing.
  if (meeting.source !== 'text') {
    facts.push({
      id: 'consent',
      term: t.facts.consent,
      value:
        meeting.consent === null
          ? t.consent.none
          : t.consent.line(
              personName(meeting.consent.by),
              formatDate(meeting.consent.at),
              meeting.consent.noticeVersion,
            ),
    })
  }
  facts.push({
    id: 'access',
    term: t.facts.access,
    value:
      meeting.role === 'creator'
        ? t.access.creator
        : meeting.role === 'participant'
          ? t.access.participant
          : t.access.viaHost(host?.text ?? t.host.noLongerAvailable),
  })

  return (
    <Card title={t.title} headingLevel={3} data-testid="meetings-details-card">
      <FactList items={facts} />
    </Card>
  )
}
