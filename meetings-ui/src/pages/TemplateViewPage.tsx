import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

/** Placeholder (specs/021-meetings T53): the owning task fills this page in place. */
export default function TemplateViewPage() {
  return (
    <section aria-labelledby="meetings-template-view-page-heading" data-testid="meetings-template-view-page">
      <PageHeader title={strings.templates.heading} titleId="meetings-template-view-page-heading" />
    </section>
  )
}
