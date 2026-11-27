import { StatusBadge } from '@operai/ui'
import type { StatusMeaning } from '@operai/ui'
import { strings } from '../strings'

/**
 * TeamStatusBadge — a team is Active or Archived (specs/20261126-teams, design component inventory). The library
 * `StatusBadge` with the suite's meaning for each (`active`, and `voided` for archived, as the CRM's
 * `ARCHIVED_MEANING`), the label from `strings.teams.state`. The one map for teams in this app.
 */
const TEAM_STATE_MEANING: Record<'active' | 'archived', StatusMeaning> = {
  active: 'active',
  archived: 'voided',
}

export type TeamStatusBadgeProps = {
  archived: boolean
  testId?: string
}

export default function TeamStatusBadge({ archived, testId }: TeamStatusBadgeProps) {
  const state = archived ? 'archived' : 'active'
  return (
    <StatusBadge status={TEAM_STATE_MEANING[state]} data-testid={testId}>
      {strings.teams.state[state]}
    </StatusBadge>
  )
}
