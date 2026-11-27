import { Badge, Icon, StatusBadge } from '@operai/ui'
import type { StatusMeaning } from '@operai/ui'
import type { Entity, ProjectState, ProjectType } from '../lib/types'
import { strings } from '../strings'

/**
 * The ONE place projects-ui maps a project state to the suite's status
 * dictionary (`STATUS` in @operai/ui): the meaning picks the badge's tone and
 * icon, the label is this app's (`strings.badges`).
 */
const STATE_MEANING: Record<ProjectState, StatusMeaning> = {
  planned: 'draft',
  active: 'active',
  on_hold: 'attention',
  closed: 'settled',
  cancelled: 'voided',
}

export function ProjectStateBadge({ state }: { state: ProjectState }) {
  return <StatusBadge status={STATE_MEANING[state]}>{strings.badges.projectState[state]}</StatusBadge>
}

/** Type is metadata, not a status: a neutral badge (design-system § Data). */
export function ProjectTypeBadge({ type }: { type: ProjectType }) {
  return <Badge tone="neutral">{strings.badges.projectType[type]}</Badge>
}

export function EntityBadge({ entity }: { entity: Entity }) {
  return <Badge tone="neutral">{strings.badges.entity[entity]}</Badge>
}

/** A won public tender in the queue (US-10): metadata worth emphasis, not a status — an accent badge, as in crm-ui. */
export function TenderBadge({ testId }: { testId?: string }) {
  return (
    <Badge tone="accent" data-testid={testId}>
      {strings.badges.tender}
    </Badge>
  )
}

/**
 * An attached team the admins archived, and a team member whose account is deactivated: both `voided` in the suite's
 * dictionary (as the CRM's archived), through this one map (specs/20261126-teams design, component inventory).
 */
export function TeamArchivedBadge({ testId }: { testId?: string }) {
  return (
    <StatusBadge status="voided" data-testid={testId}>
      {strings.project.team.teams.archived}
    </StatusBadge>
  )
}

export function MemberDeactivatedBadge({ testId }: { testId?: string }) {
  return (
    <StatusBadge status="voided" data-testid={testId}>
      {strings.project.team.teams.deactivated}
    </StatusBadge>
  )
}

/** A team member who does not hold access to Projects: attached, but not on the project (AC-4.7). An access level, so a warning badge. */
export function NoProjectsAccessBadge({ testId }: { testId?: string }) {
  return (
    <Badge tone="warning" glyph={<Icon name="lock" />} data-testid={testId}>
      {strings.project.team.teams.noAccess}
    </Badge>
  )
}
