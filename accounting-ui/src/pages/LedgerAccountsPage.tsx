import { PageHeader } from '@operai/ui'
import EntitySwitch from '../components/EntitySwitch'
import LedgerAccountsCard from '../components/LedgerAccountsCard'
import { useEntity } from '../hooks/useEntity'
import { strings } from '../strings'

/**
 * The ledger accounts view (design AS3): the page header (h2) with the entity switch in its `actions`, and the card. The card
 * is keyed by entity, so switching entity remounts it and restarts its load: a row of one entity is never shown under another's
 * title, and a late answer of the entity just left is dropped with the old card (AS2).
 */
export default function LedgerAccountsPage() {
  const { entity, entityGone, writeRefused } = useEntity()
  return (
    <section aria-labelledby="accounting-ledger-heading" data-testid="accounting-ledger-page" className="flex flex-col gap-4">
      <PageHeader title={strings.nav.ledgerAccounts} titleId="accounting-ledger-heading" actions={<EntitySwitch />} />
      <LedgerAccountsCard
        key={entity.entity}
        entity={entity.entity}
        canManage={entity.canManage}
        onEntityGone={entityGone}
        onWriteRefused={writeRefused}
      />
    </section>
  )
}
