import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  Banner,
  Button,
  Dialog,
  Icon,
  PageHeader,
  StatePanel,
  StatusBadge,
  buttonClassName,
  formatDateTime,
} from '@operai/ui'
import { LoadFailure, Loading } from '../components/LoadState'
import LegalEntityNotice from '../components/offerWizard/LegalEntityNotice'
import LetterheadNotice from '../components/offerWizard/LetterheadNotice'
import OfferWizard from '../components/offerWizard/OfferWizard'
import SaveStatus from '../components/offerWizard/SaveStatus'
import TemplateStep, { type TemplateStepProps, type TemplateTarget } from '../components/offerWizard/TemplateStep'
import type { WizardStep } from '../components/offerWizard/steps'
import { useLetterhead } from '../components/offerWizard/useLetterhead'
import { noticeOf, type ServicePreviewNotice } from '../components/offerWizard/useServicePreview'
import PermissionDenied from '../components/PermissionDenied'
import { useCrmCapabilities } from '../hooks/scopeContext'
import { useCurrentUserId } from '../hooks/useCurrentUserId'
import { useOfferDraft, type TemplateChangedNotice, type UseOfferDraft } from '../hooks/useOfferDraft'
import { useResource } from '../hooks/useResource'
import { ApiError } from '../lib/api'
import { getDeal, getWizardContext, previewOfferDraft } from '../lib/crmApi'
import { codeOf, errorMessage, pdfCheckUnavailableOf, statusOf } from '../lib/errors'
import type { WizardAnswers, WizardContext } from '../lib/offerEngine/answers'
import type { Issue } from '../lib/offerEngine/resolve'
import {
  draftExistsOf,
  invalidAnswersLine,
  legalEntitiesUnavailableOf,
  legalEntityIncompleteOf,
  letterheadUnusableOf,
  offerFailure,
} from '../lib/offerErrors'
import { personName } from '../lib/people'
import type {
  Deal,
  DraftTargetInput,
  Entity,
  Offer,
  OfferLanguage,
  WizardContextResponse,
  WizardTemplate,
} from '../lib/types'
import type { OfferWizardSearch } from '../router'
import { strings } from '../strings'

const t = strings.offerWizard

/** The next revision's reference: `0001/2026` → `0001/2026r1`, `0001/2026r2` → `0001/2026r3` (crm-api `generation.ts`). */
function nextRevisionReference(reference: string): string {
  const match = /^(.*?)(?:r(\d+))?$/.exec(reference)
  return `${match?.[1] ?? reference}r${Number(match?.[2] ?? 0) + 1}`
}

/**
 * The issuer's address in the template's language (specs/20261117-legal-entities AC-6.2): the registry's, as the context
 * answers it for both languages. An older crm-api sends the Italian lines alone, so those stand in for the language it
 * does not send (and for a body whose `issuerAddress` is not the contract).
 */
function issuerAddressOf(response: WizardContextResponse, language: OfferLanguage): string[] {
  const lines: unknown = response.issuerAddress?.[language]
  return Array.isArray(lines) ? (lines as string[]) : response.issuerAddressLines
}

/**
 * The engine's context: the server's answer plus the language of the TEMPLATE and the server's day (DD-41). Neither
 * the UI language nor the browser's clock is read, so a draft prints the same in every browser.
 */
function wizardContextOf(response: WizardContextResponse, language: OfferLanguage): WizardContext {
  return {
    language,
    today: response.today,
    dealTitle: response.dealTitle,
    currency: response.currency,
    dealAmountCents: response.dealAmountCents,
    issuerLegalName: response.issuerLegalName,
    issuerAddressLines: issuerAddressOf(response, language),
    placeOfIssue: response.placeOfIssue,
    clientLines: response.clientLines,
    contacts: response.contacts,
    attachments: response.attachments,
    estimate: response.estimate,
  }
}

/** Why an edit did not reach the server, as the failure the dialog already knows how to word. */
const notSaved = (why: 'conflict' | 'gone' | 'retrying'): ApiError =>
  why === 'conflict'
    ? new ApiError({ status: 409, title: t.save.conflict.title, code: 'version_conflict' })
    : why === 'gone'
      ? new ApiError({ status: 404, title: t.save.gone.title, code: 'draft_not_found' })
      : new ApiError({ status: 503, title: t.save.retrying, detail: t.save.retrying })

const BackLink = ({ dealId }: { dealId: string }) => (
  <Link to="/deals/$id" params={{ id: dealId }} className="link" data-testid="crm-offer-wizard-back">
    <Icon name="arrow-left" /> {t.page.back}
  </Link>
)

/** The offer the page was opened to continue in the wizard, from `?kind=&offer=` and the deal's newest offer. */
type SearchTarget = TemplateTarget & { input: DraftTargetInput & { kind: 'edit' | 'revision' } }

/** Why the last Generate did not produce an offer (design S10): each one has its banner and its way on. */
type Failure =
  | { kind: 'incomplete' }
  | { kind: 'contact' }
  | { kind: 'attachment'; message: string }
  | { kind: 'templateChanged' }
  | { kind: 'archived' }
  | { kind: 'estimate' }
  | { kind: 'offerChanged' }
  | { kind: 'letterheadUnusable' }
  /** 503 `layout_service_unavailable` (AC-10.6): the layout service could not draw the PDF; nothing was created. */
  | { kind: 'layoutUnavailable' }
  /** 409 `letterhead_not_configured` (AC-10.8) or `letterhead_overflow`: the service path's refusals of the entity's letterhead. */
  | { kind: 'letterhead'; notice: Extract<ServicePreviewNotice, { kind: 'notConfigured' | 'overflow' }> }
  | { kind: 'pdfCheck'; message: string }
  /** 409 `legal_entity_incomplete` (AC-6.3): the registry's details of the issuer are not all filled in; nothing was created. */
  | { kind: 'legalEntityIncomplete'; entity: Entity | null; missing: readonly string[] }
  /** 503 `legal_entities_unavailable` (AC-5.5): the registry could not be read; no offer number was used. */
  | { kind: 'legalEntitiesUnavailable' }
  | { kind: 'retry' }

const ATTACHMENT_CODES = ['attachment_invalid', 'attachment_not_pdf', 'attachment_unreadable', 'attachments_too_large']

function failureOf(error: unknown): Failure | 'handled' {
  const code = codeOf(error)
  if (code === 'version_conflict' || code === 'draft_not_found' || (error instanceof ApiError && error.status === 428))
    return 'handled' // the draft's own state shows the banner
  if (code === 'contact_not_in_company') return { kind: 'contact' }
  if (code !== null && ATTACHMENT_CODES.includes(code)) return { kind: 'attachment', message: offerFailure(error) }
  if (code === 'template_changed') return { kind: 'templateChanged' }
  if (code === 'template_archived') return { kind: 'archived' }
  if (code === 'estimate_not_ready') return { kind: 'estimate' }
  if (letterheadUnusableOf(error)) return { kind: 'letterheadUnusable' }
  // the letterhead service's answers (AC-10.6, AC-10.8): the status must agree with the code, as for every refusal here
  if (error instanceof ApiError && error.status === 503 && code === 'layout_service_unavailable')
    return { kind: 'layoutUnavailable' }
  // the registry's answers (AC-5.5, AC-6.3): the status must agree with the code here too
  const incomplete = legalEntityIncompleteOf(error)
  if (incomplete) return { kind: 'legalEntityIncomplete', ...incomplete }
  if (legalEntitiesUnavailableOf(error)) return { kind: 'legalEntitiesUnavailable' }
  if (error instanceof ApiError && error.status === 409) {
    const notice = noticeOf(error)
    if (notice.kind === 'notConfigured' || notice.kind === 'overflow') return { kind: 'letterhead', notice }
  }
  // the check of a chosen PDF or of the letterhead could not run (503): nothing was created, and it says why
  if (pdfCheckUnavailableOf(error)) return { kind: 'pdfCheck', message: errorMessage(error) }
  if (['offer_not_sent', 'offer_sent', 'offer_not_latest', 'offer_changed'].includes(code ?? ''))
    return { kind: 'offerChanged' }
  return { kind: 'retry' }
}

/**
 * OfferWizardPage — `/deals/$id/offer` (specs/20261115-crm-offer-wizard design S1, S9, S10): the deal's one draft,
 * loaded and autosaved by `useOfferDraft`, and the wizard on top of it. No draft exists until a template is chosen
 * (AC-1.1), so the page opens on the Template step alone. It owns what the draft's states look like (conflict,
 * gone, rejected, retrying, template changed or archived), what a refused Generate says, and where the person
 * goes next; the wizard owns the form.
 */
export default function OfferWizardPage() {
  const { id = '' } = useParams({ strict: false }) as { id?: string }
  const titleId = useId()
  const { canManageDealsOf, financials } = useCrmCapabilities()
  const load = useCallback((signal: AbortSignal) => getDeal(id, { signal }), [id])
  const deal = useResource(load)

  const frame = (body: ReactNode, status?: ReactNode) => (
    <section aria-labelledby={titleId} data-testid="crm-offer-wizard-page">
      <PageHeader title={t.page.titleNew} titleId={titleId} back={<BackLink dealId={id} />} status={status} />
      {body}
    </section>
  )

  if (deal.status === 'loading') return frame(<Loading label={t.page.loading} />)
  if (deal.status === 'error') {
    if (statusOf(deal.error) === 404)
      return frame(
        <StatePanel
          role="alert"
          focusOnMount
          headingLevel={3}
          title={t.page.notFound.title}
          testId="crm-offer-wizard-not-found"
        >
          {t.page.notFound.body}
        </StatePanel>,
      )
    return frame(<LoadFailure error={deal.error} onRetry={deal.retry} />)
  }
  const current = deal.data!
  // An offer prints the price and generating needs `deal:manage` of the deal's entity: nobody else gets even the context.
  if (!financials || !canManageDealsOf(current.entity)) return frame(<PermissionDenied />)
  return <Workspace deal={current} titleId={titleId} />
}

function Workspace({ deal, titleId }: { deal: Deal; titleId: string }) {
  const search = useSearch({ strict: false }) as OfferWizardSearch
  const navigate = useNavigate()
  const currentUserId = useCurrentUserId()
  const draft = useOfferDraft(deal.id)
  const loadContext = useCallback((signal: AbortSignal) => getWizardContext(deal.id, { signal }), [deal.id])
  const context = useResource(loadContext)

  const [failure, setFailure] = useState<Failure | null>(null)
  const [serverIssues, setServerIssues] = useState<{ missing: Issue[]; invalid: (Issue & { code: string })[] } | null>(
    null,
  )
  const [existing, setExisting] = useState<{ by: string; at: string } | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [dropped, setDropped] = useState(false)
  const [reloaded, setReloaded] = useState(0)
  const issuesHeading = useRef<HTMLHeadingElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const response = context.data
  // ONE letterhead attempt per opening of the wizard, handed to the pane and to the Drawer alike (DD-54, D-32); an
  // unanswered context keeps it pending and starts nothing (G11)
  const letterhead = useLetterhead({ entity: deal.entity, present: response ? response.letterhead : null })
  const meta = draft.draft
  const language = meta?.template.language ?? null
  const wizardContext = useMemo(
    () => (response && language ? wizardContextOf(response, language) : null),
    [response, language],
  )

  const latest = response?.latestOffer ?? null
  const searchTarget: SearchTarget | null =
    search.kind !== undefined && search.offer !== undefined && latest !== null && latest.id === search.offer
      ? {
          reference: latest.reference,
          reason: latest.origin === 'wizard' ? 'archived' : 'legacy',
          input: { kind: search.kind, offerId: latest.id },
        }
      : null

  const step: WizardStep = search.step ?? draft.step

  const goToStep = (next: WizardStep) => {
    draft.setStep(next)
    void navigate({
      to: '/deals/$id/offer',
      params: { id: deal.id },
      search: (previous) => ({ ...previous, step: next }),
      replace: true,
    })
  }

  const goToDeal = (state?: { generated: string; proposePrompt: boolean }) =>
    navigate({ to: '/deals/$id', params: { id: deal.id }, ...(state ? { state } : {}) })
  const generated = (offer: Offer) =>
    goToDeal({ generated: offer.reference, proposePrompt: deal.stage === 'qualified' })

  // after Reload draft the focus goes to the step's heading: the button that was pressed is gone
  useEffect(() => {
    if (reloaded > 0) panel.current?.querySelector<HTMLElement>('h3')?.focus()
  }, [reloaded])

  useEffect(() => {
    if (failure?.kind === 'incomplete') issuesHeading.current?.focus()
  }, [failure])

  // ─── the draft's answers ───────────────────────────────────────────────────

  // the freshest snapshot, for code that waits on a save and then asks what became of it
  const latestDraft = useRef<UseOfferDraft>(draft)
  useEffect(() => {
    latestDraft.current = draft
  })

  const changeAnswers = (next: WizardAnswers) => {
    setServerIssues(null)
    setFailure(null)
    draft.setAnswers(next)
  }

  /** The hand-edit dialog's save: the answers are kept only once the server has them, else it says why. */
  const commitAnswers = async (next: WizardAnswers) => {
    if (latestDraft.current.readOnly) throw notSaved('conflict')
    changeAnswers(next)
    const saved = await latestDraft.current.flush()
    const status = latestDraft.current.status
    if (status === 'conflict' || status === 'gone') throw notSaved(status)
    if (!saved) throw notSaved('retrying')
  }

  // ─── starting and switching ────────────────────────────────────────────────

  /** Another person started the deal's draft first (409 `draft_exists`): that draft is opened and who started it said. */
  const adoptExisting = async (error: unknown): Promise<boolean> => {
    const found = draftExistsOf(error)
    if (!found) return false
    setExisting({ by: personName(found.updatedBy, currentUserId), at: formatDateTime(found.updatedAt) })
    await draft.reload()
    return true
  }

  const choose = async (picked: WizardTemplate) => {
    setPageError(null)
    if (meta) {
      if (!(await draft.switchTemplate(picked.id))) throw notSaved('retrying')
      return
    }
    try {
      await draft.create({ templateId: picked.id, ...(searchTarget ? { target: searchTarget.input } : {}) })
      goToStep('client')
    } catch (error) {
      if (!(await adoptExisting(error))) throw error
    }
  }

  const editLatest = () => {
    if (!latest) return
    setPageError(null)
    const withTarget = () =>
      navigate({
        to: '/deals/$id/offer',
        params: { id: deal.id },
        search: { kind: 'edit', offer: latest.id },
        replace: true,
      })
    if (latest.origin !== 'wizard') return void withTarget()
    // a wizard offer starts from its own template and answers; an archived template goes to the Template step instead
    draft.create({ target: { kind: 'edit', offerId: latest.id } }).then(
      () => goToStep('client'),
      async (error: unknown) => {
        if (codeOf(error) === 'template_archived') return void withTarget()
        if (await adoptExisting(error)) return
        setPageError(offerFailure(error))
      },
    )
  }

  // ─── generating ────────────────────────────────────────────────────────────

  const generate = async () => {
    setFailure(null)
    setServerIssues(null)
    try {
      const outcome = await draft.generate()
      if (outcome.kind === 'generated') return void generated(outcome.offer)
      if (outcome.kind === 'incomplete') {
        setServerIssues({ missing: outcome.missing, invalid: outcome.invalid })
        setFailure({ kind: 'incomplete' })
      } else setFailure({ kind: 'retry' })
    } catch (error) {
      const next = failureOf(error)
      if (next !== 'handled') setFailure(next)
    }
  }

  const reload = async () => {
    setFailure(null)
    setServerIssues(null)
    await draft.reload()
    setReloaded((count) => count + 1)
  }

  // ─── what the page shows ───────────────────────────────────────────────────

  const back = <BackLink dealId={deal.id} />
  const description = `${deal.title} · ${deal.company.name} · ${strings.badges.entity[deal.entity]}`
  const shell = (
    body: ReactNode,
    title: string = t.page.titleNew,
    header?: { status?: ReactNode; actions?: ReactNode },
    fill = false,
  ) => (
    // at xl the wizard fills the content scroller (owner D20): the section is the flex column the frame in CrmShell
    // hands down, its header keeps its height and the body takes the rest. Every other state of the page keeps
    // its natural height and scrolls with the scroller as before.
    <section
      aria-labelledby={titleId}
      data-testid="crm-offer-wizard-page"
      className={fill ? 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col' : undefined}
    >
      <PageHeader title={title} titleId={titleId} back={back} description={description} {...header} />
      {body}
    </section>
  )

  if (draft.load === 'loading' || context.status === 'loading') return shell(<Loading label={t.page.loading} />)
  if (context.status === 'error')
    // the registry that holds the issuer's details cannot be read (AC-5.5): said as that, not as the authorization service
    return shell(
      legalEntitiesUnavailableOf(context.error) ? (
        <LegalEntityNotice entity={deal.entity} problem="unavailable" onRetry={context.retry} />
      ) : (
        <LoadFailure error={context.error} onRetry={context.retry} />
      ),
    )
  if (draft.load === 'error') return shell(<LoadFailure error={draft.loadError} onRetry={() => void draft.reload()} />)
  const loaded = response!

  const target = meta?.target ?? { kind: 'new' as const }
  const shownTarget = meta
    ? target
    : searchTarget
      ? { kind: searchTarget.input.kind, reference: searchTarget.reference }
      : null
  const title =
    shownTarget?.kind === 'edit'
      ? t.page.titleEdit(shownTarget.reference)
      : shownTarget?.kind === 'revision'
        ? t.page.titleRevision(shownTarget.reference)
        : t.page.titleNew

  const archived = meta?.template.archived === true
  const estimateMissing = loaded.estimate?.state === 'missing'
  const estimateState = loaded.estimate?.state ?? 'missing'

  // One reason at a time, the first that applies (D-26): no ready estimate, an archived template, then an issuer with no
  // legal name (AC-12.7 — damaged data; the person cannot fill it in the wizard, so it is never a missing field)
  const issuerNameBlank = loaded.issuerLegalName.trim() === ''
  // The stored letterhead fails the service's bound (security M-4, AC-11.4): said as the reason Generate is blocked and
  // as the answer of a refused generation, with the issuer's legal name (a blank one is blocked before this is shown)
  const unusableLine = strings.offers.errors.letterheadUnusable(loaded.issuerLegalName)
  const blockedReason: string | null = estimateMissing
    ? t.estimate.missing
    : archived
      ? t.archived.title
      : issuerNameBlank
        ? t.bar.blockedLegalName(strings.badges.entity[deal.entity])
        : letterhead.state === 'unusable'
          ? unusableLine
          : null

  const targetBanner = (() => {
    if (shownTarget?.kind === 'edit' && meta) return t.target.edit(shownTarget.reference)
    if (shownTarget?.kind === 'revision' && meta)
      return t.target.revision(shownTarget.reference, nextRevisionReference(shownTarget.reference))
    if (searchTarget)
      return searchTarget.reason === 'legacy'
        ? t.target.legacy(searchTarget.reference)
        : t.target.archived(searchTarget.reference)
    return null
  })()

  const banners: ReactNode[] = []
  const state = draft.status
  if (state === 'conflict')
    banners.push(
      <Banner
        key="conflict"
        tone="danger"
        title={t.save.conflict.title}
        onRetry={() => void reload()}
        retryLabel={t.save.reload}
        data-testid="crm-offer-wizard-conflict"
      >
        {t.save.conflict.body}
      </Banner>,
    )
  if (state === 'gone')
    banners.push(
      <Banner
        key="gone"
        tone="warning"
        title={t.save.gone.title}
        actions={
          <Link
            to="/deals/$id"
            params={{ id: deal.id }}
            className={buttonClassName({ variant: 'secondary', size: 'sm' })}
          >
            {t.page.back}
          </Link>
        }
        data-testid="crm-offer-wizard-gone"
      >
        {t.save.gone.body}
      </Banner>,
    )
  if (state === 'rejected' && draft.rejection)
    banners.push(
      <Banner key="rejected" tone="warning" data-testid="crm-offer-wizard-rejected">
        {draft.rejection.kind === 'tooLarge'
          ? t.save.tooLarge
          : draft.rejection.kind === 'invalid'
            ? t.save.rejected(invalidAnswersLine(draft.rejection, draft.ast))
            : draft.rejection.message}
      </Banner>,
    )
  if (draft.retryingLong && state === 'retrying')
    banners.push(
      <Banner key="retrying" tone="warning" live="polite" data-testid="crm-offer-wizard-retrying">
        {t.save.retrying}
      </Banner>,
    )
  if (targetBanner)
    banners.push(
      <Banner key="target" tone="info" live="off" data-testid="crm-offer-wizard-target">
        {targetBanner}
      </Banner>,
    )
  if (existing)
    banners.push(
      <Banner key="exists" tone="info" onDismiss={() => setExisting(null)} dismissLabel={strings.common.dismiss}>
        {t.draftExists(existing.by, existing.at)}
      </Banner>,
    )
  if (draft.notice)
    banners.push(
      <Banner
        key="changed"
        tone="info"
        title={t.changed.title}
        onDismiss={draft.dismissNotice}
        dismissLabel={strings.common.dismiss}
        actions={
          <Button size="sm" variant="secondary" aria-haspopup="dialog" onClick={() => setDropped(true)}>
            {t.changed.see}
          </Button>
        }
        data-testid="crm-offer-wizard-changed"
      >
        {t.changed.body}
      </Banner>,
    )
  if (archived)
    banners.push(
      <Banner key="archived" tone="warning" title={t.archived.title} data-testid="crm-offer-wizard-archived">
        {t.archived.body}
      </Banner>,
    )
  if (meta && estimateMissing)
    banners.push(
      <Banner
        key="estimate"
        tone="warning"
        actions={
          <Link
            to="/deals/$id"
            params={{ id: deal.id }}
            className={buttonClassName({ variant: 'secondary', size: 'sm' })}
          >
            {t.estimate.go}
          </Link>
        }
        data-testid="crm-offer-wizard-estimate"
      >
        {t.estimate.missing}
      </Banner>,
    )
  if (pageError)
    banners.push(
      <Banner key="error" tone="danger" onDismiss={() => setPageError(null)} dismissLabel={strings.common.dismiss}>
        {pageError}
      </Banner>,
    )

  const failureBanner = (() => {
    if (!failure || step !== 'preview') return null
    const fail = t.generate.fail
    const action = (label: string, onClick: () => void) => (
      <Button size="sm" variant="secondary" onClick={onClick}>
        {label}
      </Button>
    )
    const link = (label: string) => (
      <Link to="/deals/$id" params={{ id: deal.id }} className={buttonClassName({ variant: 'secondary', size: 'sm' })}>
        {label}
      </Link>
    )
    switch (failure.kind) {
      case 'incomplete':
        return { text: fail.incomplete }
      case 'contact':
        return { text: fail.contact, actions: action(fail.go(t.steps.client), () => goToStep('client')) }
      case 'attachment':
        return {
          text: failure.message || fail.attachment,
          actions: action(fail.go(t.steps.annexes), () => goToStep('annexes')),
        }
      case 'templateChanged':
        return { text: fail.templateChanged, actions: action(t.save.reload, () => void reload()) }
      case 'archived':
        return {
          text: strings.offers.errors.templateArchived,
          actions: action(fail.chooseAnother, () => goToStep('template')),
        }
      case 'estimate':
        return { text: strings.offers.errors.estimateNotReady, actions: link(t.estimate.go) }
      case 'offerChanged':
        return { text: fail.offerChanged, actions: link(t.page.back) }
      case 'layoutUnavailable':
        // nothing to fix here: no offer number was used, so trying again is safe (AC-10.6)
        return {
          title: t.generate.layoutUnavailable.title,
          text: t.generate.layoutUnavailable.body,
          actions: action(fail.retryAction, () => void generate()),
        }
      case 'letterhead':
        // one rule in two places (design F13): the link to Letterheads only for a holder of access (AC-10.8)
        return {
          node:
            failure.notice.kind === 'notConfigured' ? (
              <LetterheadNotice entity={deal.entity} problem="notConfigured" where="generate" />
            ) : (
              <LetterheadNotice entity={deal.entity} problem="overflow" frame={failure.notice.frame} />
            ),
        }
      case 'legalEntityIncomplete':
        // one rule in two places (design S10): the link to Legal entities only for a person who may manage that entity
        return {
          node: (
            <LegalEntityNotice
              entity={failure.entity ?? deal.entity}
              problem="incomplete"
              missing={failure.missing}
              where="generate"
            />
          ),
        }
      case 'legalEntitiesUnavailable':
        // nothing to fix here: no offer number was used, so trying again is safe (AC-5.5)
        return {
          node: <LegalEntityNotice entity={deal.entity} problem="unavailable" onRetry={() => void generate()} />,
        }
      case 'letterheadUnusable':
        // the fix is in CRM Settings, outside the wizard: no action (D-41); Generate stays available to try again
        return { text: unusableLine }
      case 'pdfCheck':
        return { text: failure.message, actions: action(fail.retryAction, () => void generate()), tone: 'warning' as const }
      case 'retry':
        return { text: fail.retry, actions: action(fail.retryAction, () => void generate()), tone: 'warning' as const }
    }
  })()

  const templateStep: TemplateStepProps = {
    deal,
    estimateState,
    // with a draft the unsent newest offer is the one being edited (or the draft would not exist): nothing to warn about
    latestOffer: meta ? null : latest,
    target: meta ? null : searchTarget,
    currentTemplateId: meta?.template.id ?? null,
    onChoose: choose,
    onEditLatest: editLatest,
    onClassicGenerated: generated,
  }

  const header = {
    status: meta ? <StatusBadge status="draft">{t.page.draft}</StatusBadge> : undefined,
    actions:
      meta && (state === 'saved' || state === 'saving' || state === 'retrying') ? (
        <SaveStatus state={state} {...(draft.savedAt ? { savedAt: draft.savedAt } : {})} />
      ) : undefined,
  }

  const bannerList =
    banners.length > 0 || failureBanner ? (
      <div className="mb-4 flex flex-col gap-3">
        {banners}
        {failureBanner?.node ? (
          failureBanner.node
        ) : failureBanner ? (
          <Banner
            tone={failureBanner.tone ?? 'danger'}
            {...(failureBanner.title ? { title: failureBanner.title } : {})}
            actions={failureBanner.actions}
            data-testid="crm-offer-wizard-failure"
          >
            {failureBanner.text}
          </Banner>
        ) : null}
      </div>
    ) : null

  if (!meta || !draft.ast || !draft.answers || !wizardContext) {
    // no draft: the Template step alone, no tabs (AC-1.1) — the wizard needs a template to ask anything
    return shell(
      <>
        {bannerList}
        <TemplateOnly props={templateStep} />
      </>,
      title,
      header,
    )
  }

  const annexKey = `${wizardContext.language}${draft.answers.aiAssisted ? 'Ai' : ''}` as 'it' | 'en' | 'itAi' | 'enAi'
  return shell(
    <div ref={panel} className="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
      {bannerList}
      <OfferWizard
        fill
        mode="deal"
        ast={draft.ast}
        answers={draft.answers}
        onAnswersChange={changeAnswers}
        context={wizardContext}
        step={step}
        onStepChange={goToStep}
        readOnly={draft.readOnly || archived}
        onGenerate={() => void generate()}
        generating={draft.generating}
        {...(blockedReason !== null ? { generateBlockedReason: blockedReason } : {})}
        effortAnnex={loaded.estimate?.annex?.[annexKey] ?? null}
        {...(target.kind === 'edit'
          ? { referenceNote: target.reference }
          : target.kind === 'revision'
            ? { referenceNote: t.client.referenceNext(target.reference) }
            : {})}
        serverIssues={serverIssues}
        issuesHeadingRef={issuesHeading}
        commitAnswers={commitAnswers}
        templateStep={templateStep}
        templateName={meta.template.name}
        letterhead={letterhead}
        servicePreview={{
          entity: deal.entity,
          identity: `${deal.id}:${meta.templateVersion}:${meta.target.kind === 'new' ? 'new' : `${meta.target.kind}:${meta.target.offerId}`}`,
          // the unsaved answers, under the draft's own target and template version: what a save would send
          ask: (answers, signal) =>
            previewOfferDraft(
              deal.id,
              {
                templateVersion: meta.templateVersion,
                target:
                  meta.target.kind === 'new'
                    ? { kind: 'new' }
                    : { kind: meta.target.kind, offerId: meta.target.offerId },
                answers,
              },
              { signal },
            ),
        }}
        {...(issuerNameBlank ? { issuerLabel: strings.badges.entity[deal.entity] } : {})}
      />
      {dropped && draft.notice ? <DroppedDialog notice={draft.notice} onClose={() => setDropped(false)} /> : null}
    </div>,
    title,
    header,
    true,
  )
}

/** The Template step without a draft behind it: a heading and the step's own panel. */
function TemplateOnly({ props }: { props: TemplateStepProps }) {
  return (
    <div className="flex flex-col gap-4" data-testid="offer-wizard">
      <h3 className="font-disp text-base text-text">{t.steps.template}</h3>
      <TemplateStep {...props} />
    </div>
  )
}

/** What a template edit cost the draft (F8): the answers that no longer fit and the hand edits to copy from. */
function DroppedDialog({ notice, onClose }: { notice: TemplateChangedNotice; onClose: () => void }) {
  const d = t.changed.dialog
  const [copied, setCopied] = useState('')
  const copy = (text: string, heading: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(`${t.sections.copied}: ${heading}`),
      () => setCopied(''),
    )
  }
  return (
    <Dialog title={d.title} closeLabel={d.close} onClose={onClose} testIdPrefix="crm-offer-wizard-dropped">
      <div className="dialog-body flex flex-col gap-4">
        {notice.dropped.length > 0 ? (
          <div>
            <h4 className="mb-1 text-xs text-soft">{d.answers}</h4>
            <ul className="m-0 list-disc pl-5 text-sm text-text">
              {notice.dropped.map((name) => (
                <li key={name} className="font-mono">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {notice.orphanedEdits.length > 0 ? (
          <div>
            <h4 className="mb-1 text-xs text-soft">{d.edits}</h4>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {notice.orphanedEdits.map((edit, index) => (
                <li key={index} className="flex flex-col gap-1">
                  <strong className="text-sm text-text">{edit.heading}</strong>
                  <pre className="m-0 whitespace-pre-wrap text-sm text-soft">{edit.body}</pre>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t.sections.orphanCopy(edit.heading)}
                    onClick={() => copy(`${edit.heading}\n\n${edit.body}`, edit.heading)}
                  >
                    <Icon name="copy" /> {d.copy}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {notice.dropped.length === 0 && notice.orphanedEdits.length === 0 ? (
          <p className="text-sm text-soft">{t.changed.body}</p>
        ) : null}
        <span className="sr-only" role="status">
          {copied}
        </span>
      </div>
      <div className="dialog-footer">
        <Button variant="primary" onClick={onClose}>
          {d.close}
        </Button>
      </div>
    </Dialog>
  )
}
