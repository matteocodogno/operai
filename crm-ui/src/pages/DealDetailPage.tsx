import { useCallback, useId, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import {
  Banner,
  Button,
  Card,
  FactList,
  Icon,
  PageHeader,
  StatePanel,
  formatDate,
  formatDateTime,
  formatNumber,
} from '@operai/ui'
import ActivityTimeline from '../components/ActivityTimeline'
import AttachmentsCard from '../components/AttachmentsCard'
import { DealStageBadge, EntityBadge } from '../components/Badges'
import DealFormDialog from '../components/DealFormDialog'
import EstimateCard from '../components/EstimateCard'
import { LoadFailure, Loading, Saved, StaleWriteBanner } from '../components/LoadState'
import MeetingsSection from '../components/MeetingsSection'
import MoveStageDialog from '../components/MoveStageDialog'
import OffersCard from '../components/OffersCard'
import { getDeal, getPipeline } from '../lib/crmApi'
import { statusOf } from '../lib/errors'
import { dealAmount, weightedCents } from '../lib/money'
import { personName } from '../lib/people'
import type { Deal, DealStage, Pipeline } from '../lib/types'
import { useCrmCapabilities } from '../hooks/scopeContext'
import { useCurrentUserId } from '../hooks/useCurrentUserId'
import { useResource } from '../hooks/useResource'
import { strings } from '../strings'
import { sourceSummary } from '../lib/source'

const BackLink = () => (
  <Link to="/pipeline" className="link" data-testid="crm-deal-back">
    <Icon name="arrow-left" /> {strings.deals.detail.back}
  </Link>
)

type Loaded = [Deal, Pipeline['probabilities'] | null]

/**
 * DealDetailPage — one deal (AC-3.1–3.3, 3.5): details with the weighted
 * amount, Edit and "Move to stage" for a holder of `deal:manage` over the
 * deal's entity (otherwise a read-only notice; the server's 403 is the gate),
 * and the activities about the deal. The win probabilities come from
 * `GET /pipeline` (D-8: the UI never hardcodes them); if that read fails the
 * weighted line is simply left out.
 */
export default function DealDetailPage() {
  const t = strings.deals.detail
  const { id = '' } = useParams({ strict: false }) as { id?: string }
  const titleId = useId()
  const currentUserId = useCurrentUserId()
  const { canManageDealsOf, financials } = useCrmCapabilities()
  const load = useCallback(
    (signal: AbortSignal): Promise<Loaded> =>
      Promise.all([
        getDeal(id, { signal }),
        getPipeline(undefined, { signal }).then(
          (pipeline) => pipeline.probabilities,
          () => null,
        ),
      ]),
    [id],
  )
  const deal = useResource(load)
  const [dialog, setDialog] = useState<'edit' | 'stage' | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  // An estimate change creates, completes or removes its task: the timeline reloads.
  const [timelineRevision, setTimelineRevision] = useState(0)

  if (deal.status === 'loading') return <Loading label={t.loading} />
  if (deal.status === 'error') {
    if (statusOf(deal.error) === 404)
      return (
        <section aria-labelledby={titleId}>
          <PageHeader title={t.notFoundTitle} titleId={titleId} back={<BackLink />} />
          <StatePanel role="alert" focusOnMount title={t.notFoundTitle} testId="crm-deal-not-found">
            {t.notFoundBody}
          </StatePanel>
        </section>
      )
    return <LoadFailure error={deal.error} onRetry={deal.retry} />
  }

  const [current, probabilities] = deal.data!
  const canManage = canManageDealsOf(current.entity)
  const probability = probabilities?.[current.stage]
  const showsMoney = financials && current.amountCents !== undefined && current.currency !== undefined
  const hasAmount = showsMoney && current.amountCents !== null
  const updated = (next: Deal, message: string) => {
    deal.replace([next, probabilities])
    setSaved(message)
    setStale(false)
  }
  const onStale = () => {
    setDialog(null)
    setStale(true)
  }
  const stageLabel = (stage: DealStage) => strings.badges.dealStage[stage]

  return (
    <section aria-labelledby={titleId} data-testid="crm-deal-page">
      <PageHeader
        title={current.title}
        titleId={titleId}
        status={<DealStageBadge stage={current.stage} />}
        description={
          <Link to="/companies/$id" params={{ id: current.company.id }} className="link">
            {current.company.name}
          </Link>
        }
        back={<BackLink />}
        actions={
          canManage && (
            <>
              <Button onClick={() => setDialog('edit')} aria-haspopup="dialog" data-testid="crm-deal-edit">
                {strings.common.edit}
              </Button>
              <Button
                variant="primary"
                onClick={() => setDialog('stage')}
                aria-haspopup="dialog"
                data-testid="crm-deal-move"
              >
                {t.move}
              </Button>
            </>
          )
        }
      />
      <div className="flex flex-col gap-4">
        {stale && (
          <StaleWriteBanner
            onReload={() => {
              setStale(false)
              deal.retry()
            }}
          />
        )}
        {saved && <Saved message={saved} onDismiss={() => setSaved(null)} />}
        {!canManage && <Banner tone="info">{t.readOnly}</Banner>}
        <Card title={t.details}>
          <FactList
            testId="crm-deal-facts"
            items={[
              ...(showsMoney
                ? [
                    {
                      id: 'amount',
                      term: t.amount,
                      value: hasAmount ? (
                        <span className="font-mono">{dealAmount(current.amountCents!, current.currency!)}</span>
                      ) : (
                        <span className="text-soft">{t.amountUnset}</span>
                      ),
                    },
                  ]
                : []),
              ...(hasAmount && probability !== undefined
                ? [
                    {
                      id: 'weighted',
                      term: t.weighted(formatNumber(probability / 100, { style: 'percent' })),
                      value: (
                        <span className="font-mono">
                          {dealAmount(weightedCents(current.amountCents!, probability), current.currency!)}
                        </span>
                      ),
                    },
                  ]
                : []),
              { id: 'entity', term: t.entity, value: <EntityBadge entity={current.entity} /> },
              {
                id: 'expected',
                term: t.expected,
                value: current.expectedCloseDate ? formatDate(current.expectedCloseDate) : strings.common.none,
              },
              { id: 'owner', term: t.owner, value: personName(current.owner, currentUserId) },
              {
                id: 'source',
                term: strings.source.label,
                value: sourceSummary(current.source, current.sourceDetail) ?? strings.common.none,
              },
              ...(current.closedAt
                ? [{ id: 'closed', term: t.closedAt, value: formatDateTime(current.closedAt) }]
                : []),
              ...(current.stage === 'lost' && current.lostReason
                ? [{ id: 'reason', term: t.lostReason, value: current.lostReason }]
                : []),
            ]}
          />
          {financials && current.notes && (
            <div className="mt-3">
              <h4 className="text-xs text-soft">{t.notes}</h4>
              <p className="whitespace-pre-line text-sm text-text">{current.notes}</p>
            </div>
          )}
        </Card>
        <EstimateCard
          deal={current}
          canManage={canManage}
          onChanged={(next, message) => {
            updated(next, message)
            setTimelineRevision((revision) => revision + 1)
          }}
        />
        {financials && (
          <OffersCard
            deal={current}
            canManage={canManage}
            onDealChanged={(next, message) => updated(next, message)}
            onStale={onStale}
          />
        )}
        <AttachmentsCard dealId={current.id} />
        <MeetingsSection dealId={current.id} />
        <ActivityTimeline
          key={timelineRevision}
          target={{ dealId: current.id }}
          company={current.company}
          preset={{ dealId: current.id }}
        />
      </div>
      {dialog === 'edit' && (
        <DealFormDialog
          deal={current}
          onCancel={() => setDialog(null)}
          onStale={onStale}
          onSaved={(next) => {
            setDialog(null)
            updated(next, t.saved)
          }}
        />
      )}
      {dialog === 'stage' && (
        <MoveStageDialog
          deal={current}
          probabilities={probabilities}
          onCancel={() => setDialog(null)}
          onStale={onStale}
          onMoved={(next) => {
            setDialog(null)
            updated(next, t.moved(stageLabel(next.stage)))
          }}
        />
      )}
    </section>
  )
}
