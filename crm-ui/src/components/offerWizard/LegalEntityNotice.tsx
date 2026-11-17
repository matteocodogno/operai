import { Banner, buttonClassName } from '@operai/ui'
import { useCanManageLegalEntity } from '../../hooks/useCanManageLegalEntity'
import { legalDetailsInWords } from '../../lib/offerErrors'
import type { Entity } from '../../lib/types'
import { strings } from '../../strings'

const t = strings.offerWizard.legalEntity

/** The Legal entities page of admin-ui, opened on the entity's tab (plan E7). A plain link: Admin is another tool. */
const legalEntitiesHref = (entity: Entity): string => `/admin/legal-entities?entity=${encodeURIComponent(entity)}`

export type LegalEntityNoticeProps = { entity: Entity; className?: string } & (
  | {
      /** 409 `legal_entity_incomplete`: the registry says the issuer's details are not all filled in (AC-6.3). */
      problem: 'incomplete'
      /** `missing[]` of the refusal, as received. */
      missing: readonly string[]
      /** The pane's polite warning (no offer is in question), or the refusal of Generate (`danger`, announced at once). */
      where: 'preview' | 'generate'
      /** A host that keeps the notice on screen after the refusal (the offers card) lets it be closed. */
      onDismiss?: () => void
    }
  | {
      /** 503 `legal_entities_unavailable`: the registry cannot be read, so no offer is made (AC-5.5). */
      problem: 'unavailable'
      /** Asks again (the notice's **Retry**): nothing was created, so trying again is safe. */
      onRetry: () => void
    }
)

/**
 * The legal entity notice (specs/20261117-legal-entities design S10; AC-5.5, AC-6.3), the sibling of `LetterheadNotice`.
 * An incomplete entity names the missing details in words and where to fill them in: **Open Legal entities** (a link that
 * carries the entity) only for a person who may manage that entity, an administrator to ask for everyone else, and for
 * everyone while the question is pending or has failed (the hook fails closed). Danger and assertive when it answers
 * Generate, a compact polite warning in the preview. An unreadable registry is a danger notice with Retry. Never a dialog.
 */
export default function LegalEntityNotice(props: LegalEntityNoticeProps) {
  const { entity, className } = props
  const canManage = useCanManageLegalEntity(entity)
  const label = strings.badges.entity[entity]

  if (props.problem === 'unavailable') {
    return (
      <Banner
        tone="danger"
        title={t.unavailable.title}
        onRetry={props.onRetry}
        retryLabel={strings.offerWizard.generate.fail.retryAction}
        {...(className ? { className } : {})}
        data-testid="crm-wizard-legal-entity-unavailable"
      >
        {t.unavailable.body}
      </Banner>
    )
  }

  const generating = props.where === 'generate'
  const list = legalDetailsInWords(props.missing)
  const sentence = [
    generating ? t.incomplete.noOffer : null,
    list === '' ? null : t.incomplete.missing(list),
    canManage ? t.incomplete.fillIn : t.incomplete.askAdmin,
  ]
    .filter((part): part is string => part !== null)
    .join(' ')
  const open = canManage ? (
    <a
      href={legalEntitiesHref(entity)}
      aria-label={t.openNamed(label)}
      className={buttonClassName({ variant: 'secondary', size: 'sm' })}
      data-testid="crm-wizard-legal-entity-link"
    >
      {t.open}
    </a>
  ) : undefined
  return (
    <Banner
      tone={generating ? 'danger' : 'warning'}
      {...(generating ? {} : { live: 'polite' as const, compact: true })}
      title={t.incomplete.title(label)}
      actions={open}
      {...(props.onDismiss ? { onDismiss: props.onDismiss, dismissLabel: strings.common.dismiss } : {})}
      {...(className ? { className } : {})}
      data-testid="crm-wizard-legal-entity-incomplete"
    >
      {sentence}
    </Banner>
  )
}
