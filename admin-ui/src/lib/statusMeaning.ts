import type { StatusMeaning } from '@operai/ui'
import type { AccessRequestStatus, EffectiveInvitationStatus } from './adminApi'

/**
 * statusMeaning — admin-ui's ONE map from each domain status to the suite's
 * status dictionary (INC-23, operai-ui design-system.md § Statuses). The
 * meaning fixes the badge's tone and icon; the label comes from
 * `strings.badges`. Every status badge in this app reads this module.
 */
export const INVITATION_STATUS_MEANING: Record<EffectiveInvitationStatus, StatusMeaning> = {
  pending: 'pending',
  accepted: 'active',
  expired: 'voided',
  revoked: 'voided',
}

export const ACCESS_REQUEST_STATUS_MEANING: Record<AccessRequestStatus, StatusMeaning> = {
  pending: 'pending',
  approved: 'active',
  rejected: 'failed',
}

/** A seed/system role: a neutral fact worth a badge. */
export const SYSTEM_ROLE_MEANING: StatusMeaning = 'info'
