import { Card, FactList } from '@operai/ui'
import type { Delivery } from '../lib/types'
import { strings } from '../strings'

/**
 * DeliveryCard — the project that carries this deal and its contract's Bexio order id (specs/022
 * AC-3.4). Read-only: the project and the order id are managed in Projects, never here.
 *
 * Three outcomes of `GET /deals/{id}`:
 *  - a project carries the deal → its name and the order id ("—" until Bexio has one);
 *  - `deliveryKnown` and no project → no card (most deals never reach delivery);
 *  - `deliveryKnown: false` (projects-api not configured or down) → the card says so rather than
 *    letting "no card" read as "no project".
 */
export default function DeliveryCard({
  delivery,
  deliveryKnown,
}: {
  delivery: Delivery | null
  deliveryKnown: boolean
}) {
  const t = strings.deals.delivery
  if (delivery === null && deliveryKnown) return null
  return (
    <Card title={t.title} data-testid="crm-delivery-card">
      {delivery === null ? (
        <p className="text-sm text-soft" data-testid="crm-delivery-unavailable">
          {t.unavailable}
        </p>
      ) : (
        <FactList
          testId="crm-delivery-facts"
          items={[
            { id: 'project', term: t.project, value: delivery.project.name },
            {
              id: 'bexio',
              term: t.bexioOrderId,
              value: delivery.bexioOrderId ? (
                <span className="font-mono">{delivery.bexioOrderId}</span>
              ) : (
                strings.common.none
              ),
            },
          ]}
        />
      )}
    </Card>
  )
}
