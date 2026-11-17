import { useCallback, useMemo, useState } from 'react'
import { Banner, Button } from '@operai/ui'
import { useCrmCapabilities } from '../../hooks/scopeContext'
import { useResource } from '../../hooks/useResource'
import { listEntityProfiles, tryPreviewOfferTemplate, tryPreviewUnsavedOfferTemplate } from '../../lib/crmApi'
import {
  sampleAnswers,
  sampleContext,
  type OfferLanguage,
  type WizardAnswers,
  type WizardContext,
} from '../../lib/offerEngine/answers'
import { parseTemplate, type TemplateAst } from '../../lib/offerEngine/syntax'
import type { Entity, WizardTemplate } from '../../lib/types'
import { strings } from '../../strings'
import OfferWizard from '../offerWizard/OfferWizard'
import { useLetterhead, type Letterhead } from '../offerWizard/useLetterhead'
import type { ServicePreviewSource } from '../offerWizard/useServicePreview'

const w = strings.templates.wizardEditor

/** The name a never-saved template's try-preview carries: it changes no page, and the half-typed one could be refused as a create's. Never shown. */
const UNSAVED_NAME = 'Try the wizard'

export interface TryWizardViewProps {
  /** The template's entity: its profile gives the classic letterhead (AC-11.9); crm-api reads the issuer's details for the service path. */
  entity: Entity
  /**
   * The template being edited, as saved; null for a new one. With the letterhead service on, the pages of a saved template are
   * asked of `POST /offer-templates/{id}/try-preview` (with the details the body repeats), those of a new one of
   * `POST /offer-templates/try-preview`, which has no id.
   */
  template: WizardTemplate | null
  /** The template text as typed — saved or not. */
  source: string
  /** The editor's language now, which is the document's. */
  language: OfferLanguage
  /** A text with errors cannot be tried: this takes the author back to the problem list. */
  onGoToProblems: () => void
}

/** The wizard itself, on one reading of the text with sample answers; `key`ed by its caller so a new text starts afresh. */
function TrySession({
  ast,
  language,
  issuerLabel,
  letterhead,
  servicePreview,
}: {
  ast: TemplateAst
  language: OfferLanguage
  /** The entity's badge label: the sample supplier is never spoken as the entity's own name. */
  issuerLabel: string
  /** The browser-drawn preview's letterhead (the old path); absent on the service path. */
  letterhead: Letterhead | undefined
  /** What the service path asks the layout service with (design F15); absent on the old path and when it cannot ask. */
  servicePreview: ServicePreviewSource | undefined
}) {
  // The supplier is always the sample: the legal name and address live in the legal entities registry now (specs/20261117-legal-entities
  // AC-6.1), which the browser does not read; the service path asks crm-api, which reads it. The registry's own values are in the pages.
  const context = useMemo<WizardContext>(() => sampleContext(language), [language])
  const [answers, setAnswers] = useState<WizardAnswers>(() => sampleAnswers(ast, language))
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Banner tone="info" live="off" compact data-testid="crm-template-try-banner">
          {w.try.banner}
        </Banner>
        <Button size="sm" variant="secondary" onClick={() => setAnswers(sampleAnswers(ast, language))}>
          {w.try.reset}
        </Button>
      </div>
      {!servicePreview ? (
        <Banner tone="info" live="off" compact data-testid="crm-template-try-issuer-sample">
          {w.try.issuerSample(issuerLabel)}
        </Banner>
      ) : null}
      <OfferWizard
        mode="sample"
        ast={ast}
        answers={answers}
        onAnswersChange={setAnswers}
        context={context}
        {...(letterhead ? { letterhead } : {})}
        {...(servicePreview ? { servicePreview } : {})}
        // a sample name is never spoken as the supplier's: the band and notice name the entity by its badge
        issuerLabel={issuerLabel}
      />
      <p className="text-xs text-soft">{w.try.noGenerate}</p>
    </div>
  )
}

/**
 * The editor's "Try the wizard" view (design S13; AC-8.5): the real wizard in `sample` mode on the text being
 * edited, with the sample context of the editor's language and sample answers. There is no deal and no draft: the
 * answers live in this component, nothing is saved, and Generate does not exist. The only reads are the entity
 * profiles list, once per mount (whether the entity has a classic letterhead), and the letterhead through the one attempt of
 * `useLetterhead` (AC-11.9). They are made here, above the keyed session, so a changed text never repeats them.
 * The supplier's name and address are always the samples on the browser-drawn path, and the note says so at once: the
 * entity profile no longer holds them (specs/20261117-legal-entities AC-6.1) and the browser does not read the registry.
 *
 * With the letterhead service on (specs/20261116-letterhead-service F15, AC-10.14, T53) the preview pane is the service's pages
 * (`ServicePreview`, through the wizard's `servicePreview`) in every case: asked of try-preview with the text as typed, the
 * sample answers and the entity's legal details (which crm-api reads from the registry; the sample issuer is only the wizard's own
 * resolution). A saved template asks `/offer-templates/{id}/try-preview`, a new one the id-less route; a person who can only
 * read the template asks too, because the route needs only the read guard. The body repeats the SAVED name, description and uses
 * (a new template sends fixed ones): they do not change a page, and a half-typed name must not make the request invalid.
 * There is no approximate preview and no note about one on this path; the letterhead is then not read at all.
 */
export default function TryWizardView({ entity, template, source, language, onGoToProblems }: TryWizardViewProps) {
  const { letterheadService } = useCrmCapabilities()
  const loadProfiles = useCallback((signal: AbortSignal) => listEntityProfiles({ signal }), [])
  const profiles = useResource(loadProfiles)
  const reading = profiles.status === 'loading'
  const row = profiles.status === 'ready' ? (profiles.data?.items.find((item) => item.entity === entity) ?? null) : null
  // `null` keeps the attempt pending until the read answers (G11); a profile that cannot be read gives the failure band
  // (AC-11.9: never an error), not a wait that never ends
  const attempt = useLetterhead({ entity, present: row ? row.letterhead !== null : null })
  const letterhead: Letterhead = !reading && row === null ? { state: 'failed', request: attempt.request } : attempt
  const servicePreview: ServicePreviewSource | undefined = letterheadService
    ? {
        entity,
        // the template and the language decide what is drawn (the text is the session's key); a change of either asks again
        identity: `${template?.id ?? `unsaved:${entity}`}:${language}`,
        ask: (answers, signal) => {
          const input = {
            content: {
              name: template?.name ?? UNSAVED_NAME,
              language,
              description: template ? (template.description ?? '') : '',
              uses: template?.uses ?? [],
              source,
            },
            answers,
            entity,
            language,
          }
          return template
            ? tryPreviewOfferTemplate(template.id, input, { signal })
            : tryPreviewUnsavedOfferTemplate(input, { signal })
        },
      }
    : undefined
  const parsed = useMemo(() => parseTemplate(source), [source])
  const errors = parsed.problems.filter((problem) => problem.severity === 'error').length
  if (errors > 0)
    return (
      <Banner
        tone="warning"
        actions={
          <Button size="sm" variant="secondary" onClick={onGoToProblems}>
            {w.try.goProblems}
          </Button>
        }
        data-testid="crm-template-try-blocked"
      >
        {w.try.blocked(errors)}
      </Banner>
    )
  return (
    <TrySession
      key={`${language}:${source}`}
      ast={parsed.ast}
      language={language}
      issuerLabel={strings.badges.entity[entity]}
      letterhead={letterheadService ? undefined : letterhead}
      servicePreview={servicePreview}
    />
  )
}
