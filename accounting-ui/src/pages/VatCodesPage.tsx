import { PageHeader } from '@operai/ui'
import EntitySwitch from '../components/EntitySwitch'
import { useEntity } from '../hooks/useEntity'
import { strings } from '../strings'

/**
 * The vatCodes view (T28 placeholder: the page's heading, the entity switch and the displayed entity). The card, its dialogs and
 * their tests are the task that fills this file in (design AS3 to AS6); the heading outline stays: h1 the tool, h2 this view.
 */
export default function VatCodesPage() {
  const { entity } = useEntity()
  return (
    <section aria-labelledby="accounting-vat-heading" data-testid="accounting-vat-page">
      <PageHeader title={strings.nav.vatCodes} titleId="accounting-vat-heading" actions={<EntitySwitch />} />
      <p className="text-soft" data-testid="accounting-vat-entity">
        {strings.entity[entity.entity]}
      </p>
    </section>
  )
}
