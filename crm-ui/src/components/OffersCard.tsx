import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Badge,
  DataTable,
  Dialog,
  Icon,
  StatusBadge,
  VisuallyHidden,
  buttonClassName,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
} from '@operai/ui'
import type { DataTableColumn } from '@operai/ui'
import {
  createWizardDraft,
  deleteOffer,
  discardWizardDraft,
  getDeal,
  getOfferDownload,
  getWizardDraftSummary,
  listOfferTemplatesOf,
  listOffers,
  markOfferSent,
  moveDealStage,
} from '../lib/crmApi'
import { isStaleWrite } from '../lib/api'
import { codeOf, errorMessage, statusOf } from '../lib/errors'
import { legalEntityIncompleteOf, offerFailure } from '../lib/offerErrors'
import { personName } from '../lib/people'
import type { Deal, DealStage, DraftTarget, Entity, Offer, OfferDraftSummary } from '../lib/types'
import { useCrmCapabilities } from '../hooks/scopeContext'
import { useCurrentUserId } from '../hooks/useCurrentUserId'
import { useResource } from '../hooks/useResource'
import { strings } from '../strings'
import GenerateOfferDialog from './GenerateOfferDialog'
import type { OfferSource } from './GenerateOfferDialog'
import { LoadFailure, Loading, Saved } from './LoadState'
import LegalEntityNotice from './offerWizard/LegalEntityNotice'

/** An Edit or a New revision of an offer: what the wizard is asked to start (design F11). */
type Start = { offer: Offer; kind: 'edit' | 'revision' }

type Dialog =
  | 'generate'
  | 'proposal'
  | 'discard'
  | { delete: Offer }
  | { sent: Offer }
  | { source: OfferSource }
  | { exists: Start }
  | null

/** What a draft row says about the offer the draft is for (design S11). */
const targetText = (target: DraftTarget): string =>
  target.kind === 'new'
    ? strings.offers.draft.target.new
    : target.kind === 'edit'
      ? strings.offers.draft.target.edit(target.reference)
      : strings.offers.draft.target.revision(target.reference)

/** The polite "checking" line, only if the check is slow (design S11: nothing at all for a quick answer). */
function CheckingHint({ label }: { label: string }) {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), 800)
    return () => clearTimeout(timer)
  }, [])
  return late ? (
    <VisuallyHidden live role="status">
      {label}
    </VisuallyHidden>
  ) : null
}

/**
 * OffersCard — the deal's offer versions, newest first (specs/20261101-crm-sales-flow US-4). Only
 * rendered for a caller with `deal:financials`: an offer prints the price.
 * Generating needs `deal:manage` over the deal and a ready estimate, or an
 * admin's override of the estimate gate; on a `qualified` deal the person is then asked whether to move it to proposal
 * (AC-4.5). Download opens the short-lived link in a new tab.
 *
 * specs/20261102-crm-offer-document US-7: the newest offer is edited in place until it is marked sent;
 * marking it sent freezes it and moves an open deal before `negotiation` there.
 * After that the header offers "New revision", which starts from the sent one.
 */
export default function OffersCard({
  deal,
  canManage,
  onDealChanged,
  onStale,
  proposePrompt = false,
}: {
  deal: Deal
  canManage: boolean
  onDealChanged: (deal: Deal, message: string) => void
  onStale: () => void
  /** The wizard just generated an offer on a `qualified` deal: open with the question whether to move it to proposal. */
  proposePrompt?: boolean
}) {
  const t = strings.offers
  const currentUserId = useCurrentUserId()
  const { managesAll, financials } = useCrmCapabilities()
  const navigate = useNavigate()
  const dealId = deal.id
  const load = useCallback((signal: AbortSignal) => listOffers(dealId, { signal }), [dealId])
  const offers = useResource(load)
  const [dialog, setDialog] = useState<Dialog>(proposePrompt && deal.stage === 'qualified' ? 'proposal' : null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // a line, or (FU-2) the registry's notice for a 409 `legal_entity_incomplete`, which carries the link for a manager
  const [notice, setNotice] = useState<string | { entity: Entity; missing: string[] } | null>(null)
  const [starting, setStarting] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [changedMeanwhile, setChangedMeanwhile] = useState(false)

  // The deal's one wizard draft (AC-6.4): asked only of someone who may continue it — never answers, never a hint.
  const canAskDraft = canManage && financials
  const loadDraft = useCallback(
    (signal: AbortSignal) =>
      canAskDraft ? getWizardDraftSummary(dealId, { signal }) : Promise.resolve({ draft: null, etag: null }),
    [dealId, canAskDraft],
  )
  const draftState = useResource(loadDraft)
  const draft: OfferDraftSummary | null = draftState.status === 'ready' ? draftState.data!.draft : null
  // a refused (403) or missing (404) summary shows nothing: the answer must be the same with or without a draft
  const draftFailed =
    draftState.status === 'error' && statusOf(draftState.error) !== 403 && statusOf(draftState.error) !== 404

  // A ready estimate, or an admin's go-ahead without one (specs/20261101-crm-sales-flow AC-3.7).
  const ready = deal.estimate?.state === 'ready' || deal.estimateOverridden
  const close = () => {
    setDialog(null)
    setError(null)
  }

  const download = (offer: Offer) => {
    setNotice(null)
    getOfferDownload(dealId, offer.id).then(
      ({ url }) => window.open(url, '_blank', 'noopener'),
      (failure: unknown) => setNotice(noticeOf(failure, deal.entity)),
    )
  }

  const remove = (offer: Offer) => {
    setBusy(true)
    setError(null)
    deleteOffer(dealId, offer.id).then(
      () => {
        setBusy(false)
        close()
        offers.retry()
      },
      (failure: unknown) => {
        setBusy(false)
        setError(errorMessage(failure))
      },
    )
  }

  const markSent = (offer: Offer) => {
    setBusy(true)
    setError(null)
    markOfferSent(dealId, offer.id)
      .then(() => getDeal(dealId))
      .then(
        (next) => {
          setBusy(false)
          close()
          offers.retry()
          onDealChanged(
            next,
            next.stage !== deal.stage
              ? strings.deals.detail.moved(strings.badges.dealStage[next.stage])
              : t.markedSent(offer.reference),
          )
        },
        (failure: unknown) => {
          setBusy(false)
          setError(offerFailure(failure))
        },
      )
  }

  const moveTo = (stage: 'proposal') => {
    setBusy(true)
    setError(null)
    moveDealStage(dealId, deal.version, stage).then(
      (next) => {
        setBusy(false)
        close()
        onDealChanged(next, strings.deals.detail.moved(strings.badges.dealStage[next.stage]))
      },
      (failure: unknown) => {
        setBusy(false)
        if (isStaleWrite(failure)) {
          close()
          return onStale()
        }
        setError(errorMessage(failure))
      },
    )
  }

  const items = offers.status === 'ready' ? offers.data!.items : []
  // The newest offer still listed: the only one edited or marked sent.
  const latest = items.find((offer) => !offer.deleted)
  // An offer from a template (specs/20261102-crm-offer-document); older ones are neither edited nor revised from.
  const latestIsDocument = latest !== undefined && (latest.templateName ?? null) !== null
  const latestSent = latest?.sent != null
  const editable = (offer: Offer) => canManage && offer.id === latest?.id && latestIsDocument && !latestSent
  // Decided once the list is in: until then nobody knows whether there is an offer to edit.
  const header: 'generate' | 'revise' | null =
    offers.status !== 'ready' || draft !== null ? null : !latestIsDocument ? 'generate' : latestSent ? 'revise' : null

  const wizardAddress = (start: Start | null = null) =>
    navigate({
      to: '/deals/$id/offer',
      params: { id: dealId },
      ...(start ? { search: { kind: start.kind, offer: start.offer.id } } : {}),
    })

  /** Starts the wizard on `offer` by the way it was made (design F11): its own template, a template to pick, or the legacy form. */
  const begin = async ({ offer, kind }: Start) => {
    setNotice(null)
    setStarting(true)
    try {
      if (offer.origin === 'wizard') {
        // its snapshot knows the template: no templateId; an archived one is picked again on the Template step
        try {
          await createWizardDraft(dealId, { target: { kind, offerId: offer.id } })
        } catch (failure) {
          if (codeOf(failure) === 'template_archived') return void (await wizardAddress({ offer, kind }))
          if (codeOf(failure) !== 'draft_exists') throw failure
        }
        return void (await wizardAddress())
      }
      // a classic offer: the wizard only if the offer's language has an active wizard template; otherwise the 018 form
      const listed = await listOfferTemplatesOf(deal.entity, false, 'wizard').catch(() => null)
      const wizard = listed?.items.some((row) => row.format === 'wizard' && !row.archived && row.language === offer.language)
      if (wizard) return void (await wizardAddress({ offer, kind }))
      setDialog({ source: { offer, mode: kind === 'edit' ? 'edit' : 'revise' } })
    } catch (failure) {
      setNotice(noticeOf(failure, deal.entity))
    } finally {
      setStarting(false)
    }
  }

  /** A draft may already be there: continue it if it is for this very offer, else ask which one wins (F11). */
  const start = (request: Start) => {
    if (draft === null) return void begin(request)
    if (draft.target.kind === request.kind && 'offerId' in draft.target && draft.target.offerId === request.offer.id)
      return void wizardAddress()
    setDialog({ exists: request })
  }

  /** Deletes the draft the card shows, at the version it showed; false when it did not go (the card says why). */
  const discardDraft = async (): Promise<boolean> => {
    if (draft === null) return true
    try {
      await discardWizardDraft(dealId, draft.version)
      draftState.replace({ draft: null, etag: null })
      return true
    } catch (failure) {
      if (statusOf(failure) === 404) {
        draftState.replace({ draft: null, etag: null }) // already gone
        return true
      }
      if (isStaleWrite(failure)) {
        // the latest summary replaces the row in place, so it does not flicker through a loading state
        const latest = await getWizardDraftSummary(dealId).catch(() => null)
        if (latest) draftState.replace(latest)
        else draftState.retry()
        setChangedMeanwhile(true)
        return false
      }
      throw failure
    }
  }

  const confirmDiscard = () => {
    setBusy(true)
    setError(null)
    discardDraft().then(
      (done) => {
        setBusy(false)
        close()
        if (done) {
          setChangedMeanwhile(false)
          setConfirmation(t.draft.discardDialog.done)
        }
      },
      (failure: unknown) => {
        setBusy(false)
        setError(offerFailure(failure))
      },
    )
  }

  const discardAndContinue = (request: Start) => {
    setBusy(true)
    setError(null)
    discardDraft().then(
      (done) => {
        setBusy(false)
        close()
        if (done) void begin(request)
      },
      (failure: unknown) => {
        setBusy(false)
        setError(offerFailure(failure))
      },
    )
  }

  const columns: DataTableColumn<Offer>[] = [
    {
      id: 'reference',
      header: t.columns.reference,
      rowHeader: true,
      render: (offer) => (
        <span className={offer.deleted ? 'text-soft line-through' : 'font-mono'}>
          {offer.reference}
          {offer.templateName && (
            <span className="block text-xs text-soft font-body" data-testid={`crm-offer-template-${offer.id}`}>
              {t.templateOf(offer.templateName)}
            </span>
          )}
          {offer.origin === 'sections' && (
            <span className="block text-xs text-soft font-body" data-testid={`crm-offer-origin-${offer.id}`}>
              {t.origin.sections}
            </span>
          )}
          {offer.sent && !offer.deleted && (
            <span className="block font-body" title={t.sentBy(personName(offer.sent.by, currentUserId), formatDate(offer.sent.at))}>
              <StatusBadge status="settled" data-testid={`crm-offer-sent-badge-${offer.id}`}>
                {t.sentOn(formatDate(offer.sent.at))}
              </StatusBadge>
            </span>
          )}
          {offer.deleted && (
            <>
              {' '}
              <StatusBadge status="voided">{t.deleted}</StatusBadge>
            </>
          )}
        </span>
      ),
    },
    { id: 'version', header: t.columns.version, render: (offer) => dim(offer, t.versionLabel(offer.number)) },
    { id: 'date', header: t.columns.date, render: (offer) => dim(offer, formatDate(offer.createdAt)) },
    {
      id: 'price',
      header: t.columns.price,
      numeric: true,
      render: (offer) => (
        <span className={offer.deleted ? 'text-soft' : undefined}>
          {formatMoney(offer.priceCents, offer.currency)}
          {(offer.yearlyCents ?? 0) > 0 && (
            <span className="block text-xs text-soft" data-testid={`crm-offer-yearly-${offer.id}`}>
              {t.perYear(formatMoney(offer.yearlyCents ?? 0, offer.currency))}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'manDays',
      header: t.columns.manDays,
      numeric: true,
      render: (offer) =>
        dim(offer, formatNumber(offer.manDaysTenths / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 })),
    },
    {
      id: 'language',
      header: t.columns.language,
      render: (offer) => (
        <span className={offer.deleted ? 'text-soft' : undefined}>
          {t.languageName[offer.language]}
          {offer.aiAssisted && (
            <>
              {' · '}
              {t.aiAssisted}
            </>
          )}
        </span>
      ),
    },
    { id: 'author', header: t.columns.author, render: (offer) => dim(offer, personName(offer.createdBy, currentUserId)) },
    {
      id: 'actions',
      header: t.columns.actions,
      render: (offer) =>
        offer.deleted ? null : (
          <span className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label={t.downloadOf(offer.reference)}
              onClick={() => download(offer)}
              data-testid={`crm-offer-download-${offer.id}`}
            >
              {t.download}
            </Button>
            {editable(offer) && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t.editOf(offer.reference)}
                aria-haspopup="dialog"
                onClick={() => start({ offer, kind: 'edit' })}
                data-testid={`crm-offer-edit-${offer.id}`}
              >
                {t.edit}
              </Button>
            )}
            {canManage && offer.id === latest?.id && !latestSent && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t.markSentOf(offer.reference)}
                aria-haspopup="dialog"
                onClick={() => setDialog({ sent: offer })}
                data-testid={`crm-offer-sent-${offer.id}`}
              >
                {t.markSent}
              </Button>
            )}
            {(offer.createdBy.id === currentUserId || managesAll) && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t.deleteOf(offer.reference)}
                aria-haspopup="dialog"
                onClick={() => setDialog({ delete: offer })}
                data-testid={`crm-offer-delete-${offer.id}`}
              >
                {strings.common.delete}
              </Button>
            )}
          </span>
        ),
    },
  ]

  return (
    <Card
      title={t.title}
      data-testid="crm-offers-card"
      action={
        canManage &&
        header !== null && (
          <span className="flex flex-wrap items-center gap-2">
            {header === 'generate' && (
              <Link
                to="/deals/$id/offer"
                params={{ id: dealId }}
                className={buttonClassName({ variant: 'primary', size: 'sm' })}
                data-testid="crm-offer-new"
              >
                {t.new}
              </Link>
            )}
            <Button
              size="sm"
              variant={header === 'generate' ? 'secondary' : 'primary'}
              disabled={!ready}
              busy={starting}
              title={ready ? undefined : t.needsReady}
              onClick={() => (header === 'revise' && latest ? start({ offer: latest, kind: 'revision' }) : setDialog('generate'))}
              aria-haspopup="dialog"
              data-testid="crm-offer-generate"
            >
              {starting ? t.starting : header === 'revise' ? t.revise : t.generate}
            </Button>
          </span>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {typeof notice === 'string' && (
          <Banner tone="danger" onDismiss={() => setNotice(null)} dismissLabel={strings.common.dismiss} data-testid="crm-offers-notice">
            {notice}
          </Banner>
        )}
        {notice !== null && typeof notice === 'object' && (
          <LegalEntityNotice
            problem="incomplete"
            where="generate"
            entity={notice.entity}
            missing={notice.missing}
            onDismiss={() => setNotice(null)}
          />
        )}
        {confirmation && <Saved message={confirmation} onDismiss={() => setConfirmation(null)} />}
        {changedMeanwhile && (
          <Banner tone="info" onDismiss={() => setChangedMeanwhile(false)} dismissLabel={strings.common.dismiss} data-testid="crm-offer-draft-changed">
            {t.draft.changedMeanwhile}
          </Banner>
        )}
        {canAskDraft && draftState.status === 'loading' && <CheckingHint label={t.draft.checking} />}
        {draftFailed && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-soft" data-testid="crm-offer-draft-check-failed">
            {t.draft.checkFailed}
            <Button size="sm" variant="ghost" onClick={draftState.retry}>
              {t.draft.checkRetry}
            </Button>
          </p>
        )}
        {draft && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-md border border-rule p-3"
            data-testid="crm-offer-draft-row"
          >
            <StatusBadge status="draft">{strings.offerWizard.page.draft}</StatusBadge>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2 text-sm text-text">
                {t.draft.row(draft.template.name, targetText(draft.target))}
                {draft.templateChanged && <Badge tone="neutral">{t.draft.templateChanged}</Badge>}
                {draft.template.archived && (
                  <Badge tone="warning" glyph={<Icon name="alert" />}>
                    {t.draft.templateArchived}
                  </Badge>
                )}
              </span>
              <span className="text-xs text-soft">
                {t.draft.changed(personName(draft.updatedBy, currentUserId), formatDateTime(draft.updatedAt))}
              </span>
            </div>
            <span className="flex gap-1">
              <Link
                to="/deals/$id/offer"
                params={{ id: dealId }}
                className={buttonClassName({ variant: 'primary', size: 'sm' })}
                data-testid="crm-offer-draft-continue"
              >
                {t.draft.continue}
              </Link>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t.draft.discardOf(draft.template.name)}
                aria-haspopup="dialog"
                onClick={() => setDialog('discard')}
                data-testid="crm-offer-draft-discard"
              >
                {t.draft.discard}
              </Button>
            </span>
          </div>
        )}
        {canManage && !ready && <p className="text-xs text-soft">{t.needsReady}</p>}
        {offers.status === 'loading' && <Loading label={t.loading} rows={2} />}
        {offers.status === 'error' && <LoadFailure error={offers.error} onRetry={offers.retry} />}
        {offers.status === 'ready' &&
          (offers.data!.items.length === 0 ? (
            <p className="text-sm text-soft" data-testid="crm-offers-empty">
              {t.empty}
            </p>
          ) : (
            <DataTable
              caption={t.caption}
              columns={columns}
              rows={offers.data!.items}
              getRowKey={(offer) => offer.id}
              testId="crm-offers-table"
            />
          ))}
      </div>
      {(dialog === 'generate' || (typeof dialog === 'object' && dialog !== null && 'source' in dialog)) && (
        <GenerateOfferDialog
          deal={deal}
          {...(typeof dialog === 'object' && dialog !== null && 'source' in dialog ? { source: dialog.source } : {})}
          onCancel={close}
          onGenerated={(offer) => {
            offers.retry()
            setNotice(null)
            onDealChanged(deal, t.generated(offer.reference))
            if (deal.stage === 'qualified') setDialog('proposal')
            else close()
          }}
        />
      )}
      {dialog === 'proposal' && (
        <ConfirmDialog
          title={t.proposalDialog.title}
          tone="primary"
          confirmLabel={t.proposalDialog.confirm}
          busyLabel={t.proposalDialog.busy}
          cancelLabel={t.proposalDialog.later}
          closeLabel={strings.common.close}
          busy={busy}
          error={error}
          onConfirm={() => moveTo('proposal')}
          onCancel={close}
          testIdPrefix="crm-offer-proposal"
        >
          {t.proposalDialog.body}
        </ConfirmDialog>
      )}
      {typeof dialog === 'object' && dialog !== null && 'sent' in dialog && (
        <ConfirmDialog
          title={t.sentDialog.title}
          tone="primary"
          confirmLabel={t.sentDialog.confirm}
          busyLabel={t.sentDialog.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={busy}
          error={error}
          onConfirm={() => markSent(dialog.sent)}
          onCancel={close}
          testIdPrefix="crm-offer-sent-dialog"
        >
          {SENDABLE_FROM.includes(deal.stage)
            ? t.sentDialog.body(dialog.sent.reference)
            : t.sentDialog.bodyNoMove(dialog.sent.reference)}
        </ConfirmDialog>
      )}
      {dialog === 'discard' && draft && (
        <ConfirmDialog
          title={t.draft.discardDialog.title}
          confirmLabel={t.draft.discardDialog.confirm}
          busyLabel={t.draft.discardDialog.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={busy}
          error={error}
          onConfirm={confirmDiscard}
          onCancel={close}
          testIdPrefix="crm-offer-draft-discard-dialog"
        >
          {t.draft.discardDialog.body(draft.template.name)}
          {draft.target.kind !== 'new' ? ` ${t.draft.discardDialog.bodyOffer(draft.target.reference)}` : ''}
        </ConfirmDialog>
      )}
      {typeof dialog === 'object' && dialog !== null && 'exists' in dialog && draft && (
        <Dialog
          title={t.draft.exists.title}
          closeLabel={strings.common.close}
          onClose={close}
          busy={busy}
          testIdPrefix="crm-offer-draft-exists"
        >
          <div className="dialog-body flex flex-col gap-3">
            <p className="text-sm text-text">
              {t.draft.exists.body(personName(draft.updatedBy, currentUserId), formatDateTime(draft.updatedAt))}
            </p>
            {error && (
              <Banner tone="danger" data-testid="crm-offer-draft-exists-error">
                {error}
              </Banner>
            )}
          </div>
          <div className="dialog-footer">
            <Button variant="ghost" onClick={close} disabled={busy}>
              {strings.common.cancel}
            </Button>
            <Button variant="danger" busy={busy} onClick={() => discardAndContinue(dialog.exists)}>
              {t.draft.exists.discard}
            </Button>
            <Link
              to="/deals/$id/offer"
              params={{ id: dealId }}
              className={buttonClassName({ variant: 'primary' })}
            >
              {t.draft.exists.continue}
            </Link>
          </div>
        </Dialog>
      )}
      {typeof dialog === 'object' && dialog !== null && 'delete' in dialog && (
        <ConfirmDialog
          title={t.deleteDialog.title}
          confirmLabel={t.deleteDialog.confirm}
          busyLabel={t.deleteDialog.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={busy}
          error={error}
          onConfirm={() => remove(dialog.delete)}
          onCancel={close}
          testIdPrefix="crm-offer-delete-dialog"
        >
          {t.deleteDialog.body(dialog.delete.reference)}
        </ConfirmDialog>
      )}
    </Card>
  )
}

/** The card's notice for a failure: the registry's notice for an incomplete legal entity, else the readable line. */
function noticeOf(failure: unknown, dealEntity: Entity): string | { entity: Entity; missing: string[] } {
  const found = legalEntityIncompleteOf(failure)
  // a body that names no entity we know is about the deal's own
  return found ? { entity: found.entity ?? dealEntity, missing: found.missing } : offerFailure(failure)
}

/** The stages "Mark as sent" moves on from: open, and not yet past an offer. */
const SENDABLE_FROM: readonly DealStage[] = ['lead', 'qualified', 'proposal']

/** A deleted version stays visible but greyed. */
const dim = (offer: Offer, text: string) => <span className={offer.deleted ? 'text-soft' : undefined}>{text}</span>
