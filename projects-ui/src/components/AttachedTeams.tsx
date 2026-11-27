import { useEffect, useId, useRef, useState } from 'react'
import { Banner, Button, VisuallyHidden } from '@operai/ui'
import { personName } from '../lib/people'
import { teamsBannerOf, waitSentence } from '../lib/teamsStatus'
import type { AttachedTeamView, Project, TeamMemberView } from '../lib/types'
import { strings } from '../strings'
import { MemberDeactivatedBadge, NoProjectsAccessBadge, TeamArchivedBadge } from './Badges'

/** Up to this many members show at once; a project can show 10 teams of 100 (AC-4.3, O9). */
const MEMBERS_SHOWN = 12

/** A member counts as on the project when active and holding access to Projects (AC-4.4, AC-4.7). */
const counts = (member: TeamMemberView) => !member.deleted && member.projectsAccess
/** A deactivated member is marked Deactivated, not also as lacking access: that is the reason, not a second fact. */
const lacksAccess = (member: TeamMemberView) => !member.deleted && !member.projectsAccess

/**
 * One attached team. It follows ITS OWN `name` and `members` (null = "could not be loaded"), never the project's
 * status: nothing is guessed (AC-5.4). The name is the live one (AC-1.3).
 */
function TeamBlock({ team, currentUserId }: { team: AttachedTeamView; currentUserId: string | null }) {
  const t = strings.project.team.teams
  const listId = useId()
  const [all, setAll] = useState(false)
  const members = team.members
  const shown = members === null ? [] : all ? members : members.slice(0, MEMBERS_SHOWN)
  return (
    <li data-testid={`project-attached-team-${team.id}`} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm text-text">
        <span className="font-medium" data-testid={`project-attached-team-name-${team.id}`}>
          {team.name ?? t.unnamed}
        </span>
        {team.archived === true && <TeamArchivedBadge testId={`project-attached-team-archived-${team.id}`} />}
        {members !== null && (
          <span className="text-xs text-soft" data-testid={`project-attached-team-count-${team.id}`}>
            {t.counted(members.filter(counts).length)}
          </span>
        )}
      </div>
      {team.archived === true && <p className="text-xs text-soft">{t.archivedNote}</p>}
      {members === null ? (
        <p className="text-sm text-soft" data-testid={`project-attached-team-members-unavailable-${team.id}`}>
          {t.membersUnavailable}
        </p>
      ) : members.length === 0 ? (
        <p className="text-sm text-soft">{t.noMembers}</p>
      ) : (
        <>
          <ul
            id={listId}
            aria-label={t.membersLabel(team.name ?? t.unnamed)}
            data-testid={`project-attached-team-members-${team.id}`}
            className="grid gap-x-4 gap-y-1 text-sm text-text sm:grid-cols-2"
          >
            {shown.map((member) => (
              <li
                key={member.id}
                data-testid={`project-attached-team-member-${team.id}-${member.id}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span>{personName({ id: member.id, name: member.name, deleted: member.deleted }, currentUserId)}</span>
                {member.deleted && (
                  <MemberDeactivatedBadge testId={`project-attached-team-member-deactivated-${team.id}-${member.id}`} />
                )}
                {lacksAccess(member) && (
                  <NoProjectsAccessBadge testId={`project-attached-team-member-noaccess-${team.id}-${member.id}`} />
                )}
              </li>
            ))}
          </ul>
          {members.length > MEMBERS_SHOWN && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              aria-expanded={all}
              aria-controls={listId}
              onClick={() => setAll((current) => !current)}
              data-testid={`project-attached-team-more-${team.id}`}
            >
              {all ? t.showFewer : t.showAll(members.length)}
            </Button>
          )}
        </>
      )}
    </li>
  )
}

/**
 * AttachedTeams — the Teams section of the Team card (specs/20261126-teams AC-1.3, AC-4.1 – AC-4.3, AC-4.7, AC-5.4,
 * AC-5.6; design S6). The attached teams by their live names with their members, and — by the project's one status
 * (`teamsBannerOf`) — at most one polite banner: "Some teams could not be loaded" or "Too many requests", each with
 * Retry. Retry reloads the project IN PLACE (`onReload` resolves with the new project, or `null` when the page's own
 * load-failure handling took over): a click while one is in flight does nothing, a still-failing answer keeps the
 * banner (same element, so Retry keeps its focus) and says so in a hidden polite line, and when the focused Retry
 * disappears the focus moves to the Teams heading, never to the body.
 */
export default function AttachedTeams({
  project,
  currentUserId,
  canManage,
  onEdit,
  onReload,
}: {
  project: Project
  currentUserId: string | null
  canManage: boolean
  onEdit: () => void
  onReload: () => Promise<Project | null>
}) {
  const t = strings.project.team.teams
  const teams = project.teams ?? []
  const banner = teamsBannerOf(project)
  const sectionRef = useRef<HTMLDivElement>(null)
  const bannerRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const reloading = useRef(false)
  const focusPending = useRef(false)
  const [statusLine, setStatusLine] = useState('')
  // A render once a reload has settled, so the focus rule below sees the new project.
  const [, setSettled] = useState(0)

  useEffect(() => {
    if (!focusPending.current || reloading.current) return
    focusPending.current = false
    if (!sectionRef.current?.contains(document.activeElement)) headingRef.current?.focus()
  })

  const retry = () => {
    if (reloading.current) return
    reloading.current = true
    focusPending.current = bannerRef.current?.contains(document.activeElement) ?? false
    // Cleared first, so the same words are announced again after a second click with the same answer.
    setStatusLine('')
    onReload()
      .catch(() => null)
      .then((next) => {
        reloading.current = false
        if (next !== null && teamsBannerOf(next) !== 'none') setStatusLine(t.rateLimited.stillLimited)
        setSettled((count) => count + 1)
      })
  }

  const anyLacksAccess = teams.some((team) => team.members?.some(lacksAccess) ?? false)

  return (
    <div ref={sectionRef} data-testid="project-attached-teams" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h4
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium text-text"
          data-testid="project-attached-teams-heading"
        >
          {t.title}
        </h4>
        {canManage && (
          <Button size="sm" aria-haspopup="dialog" onClick={onEdit} data-testid="project-attached-teams-edit">
            {t.edit}
          </Button>
        )}
      </div>
      {banner === 'unavailable' && (
        <Banner
          key="unavailable"
          ref={bannerRef}
          tone="warning"
          live="polite"
          title={t.unavailable.title}
          titleTestId="project-attached-teams-unavailable-title"
          onRetry={retry}
          retryLabel={strings.common.retry}
          retryTestId="project-attached-teams-unavailable-retry"
          data-testid="project-attached-teams-unavailable"
        >
          {t.unavailable.body}
        </Banner>
      )}
      {banner === 'rateLimited' && (
        <Banner
          key="rate-limited"
          ref={bannerRef}
          tone="warning"
          live="polite"
          title={t.rateLimited.title}
          titleTestId="project-attached-teams-rate-limited-title"
          onRetry={retry}
          retryLabel={strings.common.retry}
          retryTestId="project-attached-teams-rate-limited-retry"
          data-testid="project-attached-teams-rate-limited"
        >
          {`${t.rateLimited.lead} ${waitSentence(project.teamsRetryAfterSeconds)} ${t.rateLimited.consequences}`}
        </Banner>
      )}
      <VisuallyHidden live data-testid="project-attached-teams-retry-status">
        {statusLine}
      </VisuallyHidden>
      {teams.length === 0 ? (
        <p className="text-sm text-soft" data-testid="project-attached-teams-empty">
          {t.empty}
        </p>
      ) : (
        <ul aria-label={t.listLabel} className="flex flex-col gap-3">
          {teams.map((team) => (
            <TeamBlock key={team.id} team={team} currentUserId={currentUserId} />
          ))}
        </ul>
      )}
      {anyLacksAccess && (
        <p className="text-xs text-soft" data-testid="project-attached-teams-legend">
          {t.noAccessLegend}
        </p>
      )}
    </div>
  )
}
