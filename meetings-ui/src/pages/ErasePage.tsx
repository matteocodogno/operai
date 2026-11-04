import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

/** Placeholder (specs/021-meetings T53): the owning task fills this page in place. */
export default function ErasePage() {
  return (
    <section aria-labelledby="meetings-erase-page-heading" data-testid="meetings-erase-page">
      <PageHeader title={strings.erase.heading} titleId="meetings-erase-page-heading" />
    </section>
  )
}
