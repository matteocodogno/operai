import { Badge, StatusBadge } from '@operai/ui'
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
