import { PageHeader } from '@operai/ui'
import EntitySwitch from '../components/EntitySwitch'
import { useEntity } from '../hooks/useEntity'
import { strings } from '../strings'

/**
 * The exchangeRates view (T28 placeholder: the page's heading, the entity switch and the displayed entity). The card, its dialogs and
 * their tests are the task that fills this file in (design AS3 to AS6); the heading outline stays: h1 the tool, h2 this view.
 */
export default function ExchangeRatesPage() {
  const { entity } = useEntity()
  return (
    <section aria-labelledby="accounting-fx-heading" data-testid="accounting-fx-page">
      <PageHeader title={strings.nav.exchangeRates} titleId="accounting-fx-heading" actions={<EntitySwitch />} />
      <p className="text-soft" data-testid="accounting-fx-entity">
        {strings.entity[entity.entity]}
      </p>
    </section>
  )
}
