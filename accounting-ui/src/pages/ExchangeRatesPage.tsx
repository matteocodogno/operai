import { useSearch } from '@tanstack/react-router'
import { PageHeader } from '@operai/ui'
import EntitySwitch from '../components/EntitySwitch'
import ExchangeRatesCard from '../components/ExchangeRatesCard'
import { useEntity } from '../hooks/useEntity'
import { strings } from '../strings'

/**
 * The exchange rates view (design AS5): the page header (h2) with the entity switch in its `actions`, and the card. The card is
 * keyed by entity, so switching entity remounts it and restarts its load and its once-per-visit auto-fetch (AS2). `?month=` is
 * the AC-7.3 deep link from Refund: the card focuses that row, or says the month is not listed.
 */
export default function ExchangeRatesPage() {
  const { entity, entityGone, writeRefused } = useEntity()
  const { month } = useSearch({ strict: false }) as { month?: string }
  return (
    <section aria-labelledby="accounting-fx-heading" data-testid="accounting-fx-page" className="flex flex-col gap-4">
      <PageHeader title={strings.nav.exchangeRates} titleId="accounting-fx-heading" actions={<EntitySwitch />} />
      <ExchangeRatesCard
        key={entity.entity}
        entity={entity.entity}
        canManage={entity.canManage}
        month={month}
        onEntityGone={entityGone}
        onWriteRefused={writeRefused}
      />
    </section>
  )
}
