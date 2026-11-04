import { SectionsEditor as LibrarySectionsEditor } from '@operai/ui'
import type { SectionRowErrors } from '@operai/ui'
import { LIMITS, blankSection } from '../lib/offerRules'
import type { SectionsCheck } from '../lib/offerRules'
import type { OfferSection } from '../lib/types'
import { strings } from '../strings'

/**
 * SectionsEditor — the ordered list of headed sections of an offer template or
 * of an offer being prepared (specs/020 AC-3.3): heading, text, the ONE section
 * that carries the cost table, move up/down, remove, add. One component for the
 * template page and the generate dialog; it is controlled and shows the errors
 * it is given (`check`, from `checkSections`) once the page has validated.
 *
 * The list itself is the library's `SectionsEditor` (specs/021, extracted from
 * here); this adapter binds the CRM's copy and limits, reads `check` into
 * messages, and supplies the offer-specific part through the row slot: the
 * "costs section" radio, which marks exactly one row.
 */
export default function SectionsEditor({
  sections,
  onChange,
  check,
  disabled = false,
  testIdPrefix,
}: {
  sections: OfferSection[]
  onChange: (sections: OfferSection[]) => void
  /** Shown after a validation; `undefined` before. */
  check?: SectionsCheck
  disabled?: boolean
  testIdPrefix: string
}) {
  const t = strings.templates.sections

  const listError =
    check?.list === 'count'
      ? t.errors.count(LIMITS.sections.min, LIMITS.sections.max)
      : check?.list === 'costsSection'
        ? t.errors.costsSection
        : null
  const rowErrors: SectionRowErrors[] = (check?.items ?? []).map((issue) =>
    issue === 'headingRequired'
      ? { heading: t.errors.headingRequired }
      : issue === 'headingTooLong'
        ? { heading: t.errors.headingTooLong(LIMITS.heading) }
        : issue === 'bodyTooLong'
          ? { body: t.errors.bodyTooLong(LIMITS.body) }
          : {},
  )

  return (
    <LibrarySectionsEditor<OfferSection>
      sections={sections}
      onChange={onChange}
      createSection={blankSection}
      min={LIMITS.sections.min}
      max={LIMITS.sections.max}
      rowErrors={rowErrors}
      listError={listError}
      disabled={disabled}
      testIdPrefix={testIdPrefix}
      copy={{
        legend: t.legend,
        hint: t.hint(LIMITS.sections.min, LIMITS.sections.max),
        item: t.item,
        headingLabel: (n) => `${t.heading} (${n})`,
        bodyLabel: (n) => `${t.body} (${n})`,
        moveUp: t.moveUp,
        moveDown: t.moveDown,
        remove: t.remove,
        add: t.add,
      }}
      renderRowExtra={(section, index) => (
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="radio"
            name={`${testIdPrefix}-costs-section`}
            checked={section.costs}
            onChange={() => onChange(sections.map((item, at) => ({ ...item, costs: at === index })))}
            data-testid={`${testIdPrefix}-section-${index}-costs`}
          />
          {t.costs}
        </label>
      )}
    />
  )
}
