import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

/** Placeholder (specs/021-meetings T53): the owning task fills this page in place. */
export default function TemplatesPage() {
  return (
    <section aria-labelledby="meetings-templates-page-heading" data-testid="meetings-templates-page">
      <PageHeader title={strings.templates.heading} titleId="meetings-templates-page-heading" />
    </section>
  )
}
