import { Banner, buttonClassName } from '@operai/ui'
import { useCanManageLegalEntity } from '../hooks/useCanManageLegalEntity'
import type { Entity } from '../lib/types'
import { strings } from '../strings'

/** The Legal entities page of admin-ui, opened on the entity's tab (plan E7). A plain link: Admin is another tool. */
const legalEntitiesHref = (entity: Entity): string => `/admin/legal-entities?entity=${encodeURIComponent(entity)}`

/**
 * LegalEntitySettingsNote — where the entity card's legal fields used to be (specs/20261117-legal-entities AC-6.1, D5, design S9).
 * A static note (read in place, not announced). A person who may manage the entity gets the link; everyone else, and
 * everyone while `manageable` is pending or has failed, gets the sentence naming the page and saying an administrator keeps it.
 */
export default function LegalEntitySettingsNote({ entity }: { entity: Entity }) {
  const t = strings.settings
  const canManage = useCanManageLegalEntity(entity)
  return (
    <Banner
      tone="info"
      live="off"
      compact
      dismissible={false}
      actions={
        canManage ? (
          <a
            href={legalEntitiesHref(entity)}
            className={buttonClassName({ variant: 'secondary', size: 'sm' })}
            data-testid={`crm-settings-${entity}-legal-link`}
          >
            {t.legalNoteLink}
          </a>
        ) : undefined
      }
      data-testid={`crm-settings-${entity}-legal-note`}
    >
      {canManage ? t.legalNote : t.legalNoteAdmin}
    </Banner>
  )
}
