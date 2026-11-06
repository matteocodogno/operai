import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  FactList,
  FormDialog,
  Icon,
  PageHeader,
  RadioGroupField,
  StatePanel,
  buttonClassName,
  resolveLocale,
} from '@operai/ui'
import { LoadFailure, Loading, Saved } from '../components/LoadState'
import PermissionDenied from '../components/PermissionDenied'
import { useCapabilityHints } from '../hooks/useCapabilityHints'
import { useResource } from '../hooks/useResource'
import { statusOf, errorMessage } from '../lib/errors'
import { deleteTemplate, duplicateTemplate, listTemplates } from '../lib/meetingsApi'
import type { MeetingLanguage, Template } from '../lib/types'
import { strings } from '../strings'

const fetchTemplates = (signal: AbortSignal) => listTemplates({}, { signal })

/**
 * Template read view (specs/021-meetings S8, T74): name and type, the general instructions and the
 * ordered sections, with Duplicate for everyone, Edit and Delete only where the caller may.
 *
 * "May" is a UI hint (plan G5): a personal template is the caller's own (the list returns no one
 * else's), a shared one needs `template:manage`, a built-in one is never editable. The server
 * decides; a refusal surfaces as the error it sends.
 */
export default function TemplateViewPage() {
  const t = strings.templates
  const { id } = useParams({ strict: false })
  const navigate = useNavigate()
  const { canManageTemplates } = useCapabilityHints()
  const resource = useResource(fetchTemplates)
  const notice = useRouterState({ select: (state) => state.location.state.templatesNotice })
  const [noticeDismissed, setNoticeDismissed] = useState(false)

  const [dialog, setDialog] = useState<'duplicate' | 'delete' | null>(null)
  const [language, setLanguage] = useState<MeetingLanguage>(() => resolveLocale())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const radioName = useId()

  const template = resource.data?.items.find((item) => item.id === id) ?? null

  const duplicate = async (target: Template, copyLanguage?: MeetingLanguage) => {
    setBusy(true)
    setError(null)
    try {
      const copy = await duplicateTemplate(target.id, copyLanguage)
      await navigate({ to: '/templates/$id/edit', params: { id: copy.id }, state: { templatesNotice: 'copied' } })
    } catch (failure) {
      setBusy(false)
      setError(errorMessage(failure))
    }
  }

  const remove = async (target: Template) => {
    setBusy(true)
    setError(null)
    try {
      await deleteTemplate(target.id)
    } catch (failure) {
      // Already gone is the outcome the person asked for.
      if (statusOf(failure) !== 404) {
        setBusy(false)
        setError(errorMessage(failure))
        return
      }
    }
    await navigate({ to: '/templates', state: { templatesNotice: 'deleted' } })
  }

  const closeDialog = () => {
    setDialog(null)
    setError(null)
  }

  const back = (
    <Link to="/templates" className="link" data-testid="meetings-template-back">
      <Icon name="arrow-left" /> {t.back}
    </Link>
  )

  const frame = (content: ReactNode, header?: Template) => (
    <section aria-labelledby="meetings-template-view-page-heading" data-testid="meetings-template-view-page">
      {header ? (
        <PageHeader
          title={header.name}
          titleId="meetings-template-view-page-heading"
          status={<Badge>{t.type[header.source]}</Badge>}
          back={back}
          actions={actionsFor(header)}
        />
      ) : (
        <PageHeader title={t.heading} titleId="meetings-template-view-page-heading" back={back} />
      )}
      {content}
    </section>
  )

  const canEdit = (target: Template) =>
    target.source === 'personal' || (target.source === 'shared' && canManageTemplates)

  function actionsFor(target: Template) {
    const primaryDuplicate = target.source === 'builtin' || (target.source === 'shared' && !canManageTemplates)
    return (
      <>
        <Button
          variant={primaryDuplicate ? 'primary' : 'secondary'}
          busy={busy && dialog === null}
          aria-haspopup={target.source === 'builtin' ? 'dialog' : undefined}
          onClick={() => (target.source === 'builtin' ? setDialog('duplicate') : void duplicate(target))}
          data-testid="meetings-template-duplicate"
        >
          {t.view.duplicate}
        </Button>
        {canEdit(target) && (
          <>
            <Link
              to="/templates/$id/edit"
              params={{ id: target.id }}
              className={buttonClassName({ variant: 'secondary' })}
              data-testid="meetings-template-edit"
            >
              {t.view.edit}
            </Link>
            <Button
              variant="danger"
              aria-haspopup="dialog"
              onClick={() => setDialog('delete')}
              data-testid="meetings-template-delete"
            >
              {t.view.delete}
            </Button>
          </>
        )}
      </>
    )
  }

  if (resource.status === 'loading') return frame(<Loading label={t.loading} />)
  if (resource.status === 'error') {
    // A 403 on a page load is the whole page being off limits, whatever code it carries.
    return frame(
      statusOf(resource.error) === 403 ? (
        <PermissionDenied />
      ) : (
        <LoadFailure error={resource.error} onRetry={resource.retry} />
      ),
    )
  }
  if (template === null) {
    return frame(
      <StatePanel
        role="alert"
        focusOnMount
        headingLevel={2}
        title={t.notFound.title}
        testId="meetings-template-not-found"
      >
        {t.notFound.body}
      </StatePanel>,
    )
  }

  const info =
    template.source === 'builtin'
      ? t.view.builtinInfo
      : template.source === 'shared' && !canManageTemplates
        ? t.view.sharedInfo
        : null

  return frame(
    <div className="flex flex-col gap-4">
      {notice === 'saved' && !noticeDismissed && (
        <Saved message={t.notice.saved} onDismiss={() => setNoticeDismissed(true)} />
      )}
      {info && (
        <Banner tone="info" data-testid="meetings-template-info">
          {info}
        </Banner>
      )}
      {error !== null && dialog === null && (
        <Banner tone="danger" data-testid="meetings-template-error">
          {error}
        </Banner>
      )}
      <Card title={t.view.detailsTitle}>
        <FactList
          items={[
            { id: 'type', term: t.view.type, value: t.type[template.source] },
            {
              id: 'general',
              term: t.view.generalInstructions,
              value: template.generalInstructions ? (
                <span className="whitespace-pre-wrap">{template.generalInstructions}</span>
              ) : (
                strings.common.none
              ),
            },
          ]}
        />
      </Card>
      <Card title={t.view.sectionsTitle}>
        <ol aria-label={t.view.sectionsTitle} className="flex flex-col gap-3">
          {template.sections.map((section, index) => (
            <li key={index}>
              <p className="font-medium">{section.heading}</p>
              {section.instruction && <p className="whitespace-pre-wrap text-soft">{section.instruction}</p>}
            </li>
          ))}
        </ol>
      </Card>

      {dialog === 'duplicate' && (
        <FormDialog
          title={t.duplicateDialog.title}
          description={t.duplicateDialog.description}
          submitLabel={t.duplicateDialog.submit}
          busyLabel={t.duplicateDialog.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={busy}
          error={error}
          onSubmit={() => void duplicate(template, language)}
          onCancel={closeDialog}
          testIdPrefix="meetings-template-duplicate-dialog"
        >
          <RadioGroupField label={t.duplicateDialog.language} required>
            {(['en', 'it'] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${radioName}-language`}
                  value={value}
                  checked={language === value}
                  onChange={() => setLanguage(value)}
                />
                {t.duplicateDialog[value]}
              </label>
            ))}
          </RadioGroupField>
        </FormDialog>
      )}

      {dialog === 'delete' && (
        <ConfirmDialog
          title={t.deleteDialog.title}
          confirmLabel={t.deleteDialog.confirm}
          busyLabel={t.deleteDialog.busy}
          cancelLabel={strings.common.cancel}
          closeLabel={strings.common.close}
          busy={busy}
          error={error}
          onConfirm={() => void remove(template)}
          onCancel={closeDialog}
          testIdPrefix="meetings-template-delete-dialog"
        >
          {t.deleteDialog.body}
        </ConfirmDialog>
      )}
    </div>,
    template,
  )
}
