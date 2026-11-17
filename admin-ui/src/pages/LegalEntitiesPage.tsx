import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

const t = strings.legalEntities.page

/**
 * LegalEntitiesPage — the `/legal-entities` route's host (T35, specs/20261117-legal-entities, plan E7).
 *
 * Only the minimal host lives here: the route, its guarded reach (AdminShell resolves "may this person see
 * the section" before this ever mounts) and the page heading. The entity tabs, the Details | History views
 * and the drafts are T36's. The validated search params (`entity`, `view`, `version`; see
 * `validateLegalEntitiesSearch` in ../router.tsx) are deliberately not rendered here: a value that is not
 * one of the closed set never reaches the page, so there is nothing of it to echo.
 */
export default function LegalEntitiesPage() {
  return (
    <section aria-labelledby="admin-legal-entities-heading" data-testid="admin-legal-entities-page">
      <PageHeader title={t.heading} titleId="admin-legal-entities-heading" description={t.description} />
    </section>
  )
}
