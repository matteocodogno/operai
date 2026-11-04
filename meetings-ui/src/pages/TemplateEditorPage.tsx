import { PageHeader } from '@operai/ui'
import { strings } from '../strings'

/** Placeholder (specs/021-meetings T53): the owning task fills this page in place. */
export default function TemplateEditorPage() {
  return (
    <section aria-labelledby="meetings-template-editor-page-heading" data-testid="meetings-template-editor-page">
      <PageHeader title={strings.templates.heading} titleId="meetings-template-editor-page-heading" />
    </section>
  )
}
