import { PageHeader } from '@operai/ui'
import EntitySwitch from '../components/EntitySwitch'
import VatCodesCard from '../components/VatCodesCard'
import { useEntity } from '../hooks/useEntity'
import { strings } from '../strings'

/**
 * The VAT codes view (design AS4): the page header (h2) with the entity switch in its `actions`, and the card. The card is keyed
 * by entity, so switching entity remounts it and restarts its load (AS2).
 */
export default function VatCodesPage() {
  const { entity, entityGone, writeRefused } = useEntity()
  return (
    <section aria-labelledby="accounting-vat-heading" data-testid="accounting-vat-page" className="flex flex-col gap-4">
      <PageHeader title={strings.nav.vatCodes} titleId="accounting-vat-heading" actions={<EntitySwitch />} />
      <VatCodesCard
        key={entity.entity}
        entity={entity.entity}
        canManage={entity.canManage}
        onEntityGone={entityGone}
        onWriteRefused={writeRefused}
      />
    </section>
  )
}
