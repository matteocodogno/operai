import { Badge, Banner, Icon, PagePreview, type PagePreviewLabels } from '@operai/ui'
import type { Entity } from '../../lib/types'
import { strings } from '../../strings'
import LegalEntityNotice from './LegalEntityNotice'
import LetterheadNotice from './LetterheadNotice'
import type { ServicePreviewNotice, ServicePreviewResult } from './useServicePreview'

const t = strings.offerWizard
const s = t.servicePreview

/** The library's labels for the pages: the wizard's own words (design § Copy keys). */
const labels: PagePreviewLabels = {
  region: t.preview.title,
  loading: s.loading,
  updating: s.updating,
  failed: s.failedShort,
  pageCount: s.pages,
  pageAlt: s.pageAlt,
}

export interface ServicePreviewProps {
  /** The page's one preview (`useServicePreview`), so both slots of the pane and the Drawer share its last answer. */
  preview: ServicePreviewResult
  /** The entity the pages are drawn on: named by the notices and in the link to its letterhead. */
  entity: Entity
  /** The language of the pages' text (the template's), for the screen reader's voice. */
  language: string
  /** The wizard's own count of what is still missing, as the badge and the Preview step's list count it. */
  missing: number
  /** The profile has no address though the template prints it: the wizard's notice, unchanged. */
  addressUnset: boolean
  /** The issuer's name in the notice. */
  issuer: string
  /** The pane's own title row; off inside a drawer that has its title. */
  heading?: boolean
  /** The inline pane of a wizard that fills its scroller: the pages take what the title and notices leave. */
  fill?: boolean
}

/** The notice slot of the pane (design F13): polite, never a dialog, never `role="alert"` (AC-10.7). */
function Notice({
  notice,
  entity,
  hasPages,
  onRetry,
}: {
  notice: ServicePreviewNotice
  entity: Entity
  hasPages: boolean
  onRetry: () => void
}) {
  switch (notice.kind) {
    case 'failed':
      return (
        <Banner
          tone="warning"
          live="polite"
          compact
          title={s.failedTitle}
          onRetry={onRetry}
          retryLabel={s.retry}
          data-testid="crm-wizard-service-preview-failed"
        >
          {hasPages ? s.failedBody : s.failedFirstBody}
        </Banner>
      )
    case 'notConfigured':
      return <LetterheadNotice entity={entity} problem="notConfigured" where="preview" />
    case 'overflow':
      return <LetterheadNotice entity={entity} problem="overflow" frame={notice.frame} />
    case 'legalEntityIncomplete':
      // the entity the refusal names is the issuer's; the deal's own stands in for a body that names none we know
      return (
        <LegalEntityNotice
          entity={notice.entity ?? entity}
          problem="incomplete"
          missing={notice.missing}
          where="preview"
        />
      )
    case 'invalid':
      return (
        <Banner tone="info" live="polite" compact data-testid="crm-wizard-service-preview-invalid">
          {s.invalidAnswers}
        </Banner>
      )
    case 'sectionTooLong':
      return (
        <Banner tone="warning" live="polite" compact data-testid="crm-wizard-service-preview-too-long">
          {s.sectionTooLong(notice.sections)}
        </Banner>
      )
  }
}

/**
 * ServicePreview — the wizard's preview pane on the service path (design F12, F13, S9; AC-10.3, AC-10.4, AC-10.5, AC-10.7,
 * AC-10.8): the pane's own title row and address notice, then the pages the layout service drew, in the library's
 * `PagePreview`. It replaces `DocumentPreview` in the same two slots, with no letterhead band: the pages are the PDF's own.
 *
 * It asks nothing itself; `useServicePreview` does, once, in the wizard. Missing fields are drawn on the pages by the
 * service and listed by the Preview step; the badge counts what the wizard's own resolution counts.
 */
export default function ServicePreview({
  preview,
  entity,
  language,
  missing,
  addressUnset,
  issuer,
  heading = true,
  fill = false,
}: ServicePreviewProps) {
  return (
    <div className={`flex flex-col gap-3${fill ? ' h-full min-h-0' : ''}`}>
      {heading ? (
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-disp text-base text-text">{t.preview.title}</h3>
          {missing > 0 ? (
            <Badge tone="warning" glyph={<Icon name="alert" />}>
              {t.preview.missingBadge(missing)}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {addressUnset ? (
        <Banner
          tone="warning"
          live="off"
          compact
          aria-label={t.preview.addressNoticeLabel}
          data-testid="crm-wizard-address-notice"
        >
          {t.preview.addressNotice(issuer)}
        </Banner>
      ) : null}
      <PagePreview
        pages={preview.pages}
        state={preview.state}
        labels={labels}
        lang={language}
        className={fill ? 'min-h-0 flex-1' : 'max-h-[80vh]'}
        testId="crm-wizard-service-preview"
      >
        {preview.notice ? (
          <Notice
            notice={preview.notice}
            entity={entity}
            hasPages={preview.pages.length > 0}
            onRetry={preview.retry}
          />
        ) : null}
      </PagePreview>
    </div>
  )
}
