import { Banner, buttonClassName } from '@operai/ui'
import { usePermissions } from 'shell/session'
import { useCanManageLegalEntity } from '../../hooks/useCanManageLegalEntity'
import type { Entity } from '../../lib/types'
import { strings } from '../../strings'

const t = strings.offerWizard.letterhead

/** The configurator on the shell's path, opened on the entity (design F13). A plain link: Letterheads is another tool. */
const letterheadsHref = (entity: Entity): string => `/letterheads?entity=${encodeURIComponent(entity)}`

/** The Legal entities page of admin-ui, opened on the entity's tab (plan E7). A plain link: Admin is another tool. */
const legalEntitiesHref = (entity: Entity): string => `/admin/legal-entities?entity=${encodeURIComponent(entity)}`

/** Whether the person may open Letterheads at all: UX only, the service's own 403 is the gate. */
function useCanOpenLetterheads(): boolean {
  return usePermissions().apps.includes('letterheads')
}

export type LetterheadNoticeProps = { entity: Entity; className?: string } & (
  | {
      /** 409 `letterhead_not_configured`: the entity has no active letterhead (AC-10.8). */
      problem: 'notConfigured'
      /** The pane's polite warning, or the Generate refusal (`danger`, announced at once, with its own sentence). */
      where: 'preview' | 'generate'
    }
  | {
      /** 409 `letterhead_overflow`: a legal detail is too long for the header or the footer (T27, AC-5.3; FU-1). */
      problem: 'overflow'
      frame: 'header' | 'footer'
    }
)

/**
 * The letterhead notice (design F13, S9; AC-10.7, AC-10.8): one rule in two places, the preview pane and the Generate error.
 * The action **Open Letterheads** exists only for a holder of access to Letterheads; everyone else is told to ask an
 * administrator and sees no link. Never a dialog; in the pane it is a polite status, announced once.
 * An overflow follows two independent gates (design S10b, DR-18): may the person manage the entity's legal details
 * (**Open Legal entities**, `useCanManageLegalEntity`, fails closed) and may they open Letterheads; four bodies, no
 * link for a gate that is shut.
 */
export default function LetterheadNotice(props: LetterheadNoticeProps) {
  const { entity, className } = props
  const canOpen = useCanOpenLetterheads()
  const canManage = useCanManageLegalEntity(entity)
  const label = strings.badges.entity[entity]
  const open = canOpen ? (
    <a href={letterheadsHref(entity)} className={buttonClassName({ variant: 'secondary', size: 'sm' })}>
      {t.open}
    </a>
  ) : undefined

  if (props.problem === 'overflow') {
    const o = t.overflow
    const body = canManage ? (canOpen ? o.body : o.bodyValueOnly) : canOpen ? o.bodyLetterheadOnly : o.bodyAskAdmin
    const actions =
      canManage || canOpen ? (
        <>
          {canManage && (
            <a
              href={legalEntitiesHref(entity)}
              aria-label={strings.offerWizard.legalEntity.openNamed(label)}
              className={buttonClassName({ variant: 'secondary', size: 'sm' })}
              data-testid="crm-wizard-letterhead-overflow-legal-entity-link"
            >
              {strings.offerWizard.legalEntity.open}
            </a>
          )}
          {open}
        </>
      ) : undefined
    return (
      <Banner
        tone="warning"
        live="polite"
        title={o.title(label, o[props.frame])}
        actions={actions}
        {...(className ? { className } : {})}
        data-testid="crm-wizard-letterhead-overflow"
      >
        {body}
      </Banner>
    )
  }

  const generating = props.where === 'generate'
  return (
    <Banner
      tone={generating ? 'danger' : 'warning'}
      {...(generating ? {} : { live: 'polite' as const })}
      title={t.notConfigured.title(label)}
      actions={open}
      {...(className ? { className } : {})}
      data-testid="crm-wizard-letterhead-not-configured"
    >
      {generating ? t.notConfigured.generate : t.notConfigured.preview}
      {canOpen ? null : ` ${t.askAdmin}`}
    </Banner>
  )
}
