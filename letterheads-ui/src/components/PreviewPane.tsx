/**
 * The preview pane of the configurator (task T22; design S1, S7, F3, F4): the sample document drawn by the
 * service on the form as it is now, in `PagePreview`. It shows
 * - a source line saying the company details are the registry's, in the preview language, and the body is sample text
 *   (AC-5.4), with a link to the entity's Legal entities tab for a person who may manage it, and a legend of the
 *   "missing" look;
 * - the preview language, a viewing choice that is not saved (F4, AC-5.8);
 * - the pages, each a figure with its "Page N of M" alt and its text (AC-8.6);
 * - a polite notice when the form holds refused values (info), with one link per value that moves focus to its
 *   control (a refusal of the header can sit far above the control that was just changed), or when the preview
 *   could not be made (warning, with Try again), or when the registry's details could not be read (warning, with Try
 *   again; the pages show every detail as missing). Neither moves focus by itself; the form stays usable and Save
 *   stays available.
 * The same component is the wide `aside` and the body of the narrow Drawer; both read one request.
 */
import { useId } from 'react'
import { Banner, PagePreview, RadioGroupField } from '@operai/ui'
import type { PagePreviewLabels } from '@operai/ui'
import type { PreviewLanguage, PreviewView } from './PreviewPaneRequest'
import { useCanManageLegalEntity } from '../hooks/useCanManageLegalEntity'
import type { Entity } from '../lib/types'
import type { Problem } from '../lib/formStateTypes'
import { strings } from '../strings'

/** The Legal entities page of admin-ui, opened on the entity's tab (plan E7). A plain link: Admin is another tool. */
const legalEntitiesHref = (entity: Entity): string => `/admin/legal-entities?entity=${encodeURIComponent(entity)}`

const labels = (): PagePreviewLabels => ({
  region: strings.preview.region,
  loading: strings.preview.loading,
  updating: strings.preview.updating,
  failed: strings.preview.failedShort,
  pageCount: strings.preview.pages,
  pageAlt: strings.preview.pageAlt,
})

export interface PreviewPaneProps {
  view: PreviewView
  language: PreviewLanguage
  onLanguage: (language: PreviewLanguage) => void
  onRetry: () => void
  /** The values the last refused preview named, in page order, each described in words. */
  problems?: readonly { problem: Problem; text: string }[]
  /** Moves focus to the control of the value at `path`. */
  onGo?: (path: string) => void
  /** The pane's own heading (the wide aside); the Drawer has its title already. */
  heading?: boolean
  className?: string
  testId?: string
}

export function PreviewPane({
  view,
  language,
  onLanguage,
  onRetry,
  problems = [],
  onGo,
  heading = false,
  className,
  testId,
}: PreviewPaneProps) {
  const radioName = useId()
  const canManage = useCanManageLegalEntity(view.entity)
  const options: { value: PreviewLanguage; label: string }[] = [
    { value: 'it', label: strings.preview.it },
    { value: 'en', label: strings.preview.en },
  ]
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {heading && <h3 className="m-0 text-base font-semibold text-text">{strings.preview.title}</h3>}
      <p className="m-0 text-sm text-soft" data-testid="letterheads-preview-source">
        {strings.preview.sourceLine}{' '}
        {canManage ? (
          <a href={legalEntitiesHref(view.entity)} className="link" data-testid="letterheads-preview-source-link">
            {strings.preview.sourceLink}
          </a>
        ) : (
          strings.preview.sourceAdmin
        )}
      </p>
      <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-soft" data-testid="letterheads-preview-legend">
        <span className="rounded-sm bg-paper-mark px-1 text-paper-mark-ink">{strings.preview.legendMark}</span>
        {strings.preview.legend}
      </p>
      <RadioGroupField label={strings.preview.language}>
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={radioName}
              data-testid={`letterheads-preview-language-${option.value}`}
              checked={option.value === language}
              onChange={() => onLanguage(option.value)}
            />
            {option.label}
          </label>
        ))}
      </RadioGroupField>
      <PagePreview
        pages={view.pages}
        state={view.state}
        labels={labels()}
        lang={view.lang}
        className={className}
        testId="letterheads-preview"
      >
        {view.refused !== null && (
          <Banner
            tone="info"
            live="off"
            title={strings.problem.previewTitle}
            data-testid="letterheads-preview-refused"
            className="mb-2"
          >
            {strings.problem.previewBody}
            {problems.length > 0 && (
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                {problems.map(({ problem, text }, index) => (
                  <li key={`${problem.path}|${problem.reason}|${index}`}>
                    <button
                      type="button"
                      className="link cursor-pointer border-0 bg-transparent p-0 text-left text-sm"
                      onClick={() => onGo?.(problem.path)}
                      data-testid="letterheads-preview-refused-item"
                    >
                      {text}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        {view.issuerUnavailable && (
          <Banner
            tone="warning"
            live="polite"
            title={strings.preview.unavailableTitle}
            onRetry={onRetry}
            retryLabel={strings.preview.retry}
            retryTestId="letterheads-preview-unavailable-retry"
            data-testid="letterheads-preview-unavailable"
            className="mb-2"
          >
            {strings.preview.unavailableBody}
          </Banner>
        )}
        {view.failed && (
          <Banner
            tone="warning"
            live="polite"
            title={strings.preview.failedTitle}
            onRetry={onRetry}
            retryLabel={strings.preview.retry}
            retryTestId="letterheads-preview-retry"
            data-testid="letterheads-preview-failed"
            className="mb-2"
          >
            {view.pages.length === 0 ? strings.preview.failedFirstBody : strings.preview.failedBody}
          </Banner>
        )}
      </PagePreview>
    </div>
  )
}
