import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import {
  Badge,
  Banner,
  Button,
  Card,
  FactList,
  Field,
  Icon,
  PageHeader,
  RadioGroupField,
  SectionsEditor,
  StatePanel,
  focusFirstInvalid,
} from '@operai/ui'
import type { SectionRowErrors } from '@operai/ui'
import { LoadFailure, Loading, Saved } from '../components/LoadState'
import PermissionDenied from '../components/PermissionDenied'
import { useCapabilityHints } from '../hooks/useCapabilityHints'
import { useResource } from '../hooks/useResource'
import { isStaleWrite } from '../lib/api'
import { codeOf, describeFailure, errorMessage, fieldErrorsOf, statusOf } from '../lib/errors'
import { createTemplate, listTemplates, updateTemplate } from '../lib/meetingsApi'
import type { Template, TemplateInput } from '../lib/types'
import { strings } from '../strings'

const NAME_MAX = 80
const GENERAL_MAX = 2000
const HEADING_MAX = 80
const INSTRUCTION_MAX = 500
const SECTIONS_MIN = 1
const SECTIONS_MAX = 15

/** The editor's row: the library's `Section` (heading, body) where the body is the template's instruction. */
type Row = { heading: string; body: string }

type Values = { name: string; scope: TemplateInput['scope']; general: string; sections: Row[] }

type Errors = {
  name?: string
  general?: string
  list?: string
  rows: Array<SectionRowErrors | null>
}

const EMPTY_ERRORS: Errors = { rows: [] }

const blankRow = (): Row => ({ heading: '', body: '' })

const valuesOf = (template: Template | null): Values =>
  template === null
    ? { name: '', scope: 'personal', general: '', sections: [blankRow()] }
    : {
        name: template.name,
        scope: template.source === 'shared' ? 'shared' : 'personal',
        general: template.generalInstructions ?? '',
        sections: template.sections.map((section) => ({ heading: section.heading, body: section.instruction })),
      }

/** Inline validation of every limit of AC-8.2 (the server checks again). */
function validate(values: Values): Errors | null {
  const t = strings.templates.editor.errors
  const errors: Errors = { rows: [] }
  let found = false

  const name = values.name.trim()
  if (name === '') errors.name = t.nameRequired
  else if (name.length > NAME_MAX) errors.name = t.nameTooLong
  if (values.general.trim().length > GENERAL_MAX) errors.general = t.generalTooLong
  if (errors.name || errors.general) found = true

  if (values.sections.length < SECTIONS_MIN || values.sections.length > SECTIONS_MAX) {
    errors.list = t.sectionsCount
    found = true
  }
  errors.rows = values.sections.map((row) => {
    const rowErrors: SectionRowErrors = {}
    const heading = row.heading.trim()
    if (heading === '') rowErrors.heading = t.headingRequired
    else if (heading.length > HEADING_MAX) rowErrors.heading = t.headingTooLong
    if (row.body.trim().length > INSTRUCTION_MAX) rowErrors.body = t.instructionTooLong
    if (rowErrors.heading || rowErrors.body) found = true
    return rowErrors.heading || rowErrors.body ? rowErrors : null
  })
  return found ? errors : null
}

/** `sections[2].heading` / `sections.2.instruction`: which row and field of the list a server error names. */
const SECTION_FIELD = /^sections(?:\[(\d+)\]|\.(\d+))\.(heading|instruction)$/

/** Server-side field errors (422), placed on the field they name; what names no field is returned apart. */
function placeServerErrors(fields: { field: string; message: string }[]): { errors: Errors; unplaced: string[] } {
  const errors: Errors = { rows: [] }
  const unplaced: string[] = []
  for (const { field, message } of fields) {
    const row = SECTION_FIELD.exec(field)
    if (field === 'name') errors.name ??= message
    else if (field === 'generalInstructions') errors.general ??= message
    else if (field === 'sections') errors.list ??= message
    else if (row) {
      const index = Number(row[1] ?? row[2])
      const key = row[3] === 'heading' ? 'heading' : 'body'
      errors.rows[index] = { ...errors.rows[index], [key]: message }
    } else unplaced.push(message)
  }
  return { errors, unplaced }
}

type Outcome = 'denied' | 'missing'

type TemplateFormProps = {
  /** The template being edited, or null for a new one. */
  template: Template | null
  onStale: () => void
  onOutcome: (outcome: Outcome) => void
}

function TemplateForm({ template, onStale, onOutcome }: TemplateFormProps) {
  const t = strings.templates.editor
  const navigate = useNavigate()
  const { canManageTemplates } = useCapabilityHints()
  const formRef = useRef<HTMLFormElement>(null)
  const radioName = useId()

  const [values, setValues] = useState<Values>(() => valuesOf(template))
  const [attempted, setAttempted] = useState(false)
  const [server, setServer] = useState<Errors>(EMPTY_ERRORS)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [focusTick, setFocusTick] = useState(0)

  useEffect(() => {
    if (focusTick > 0) focusFirstInvalid(formRef.current)
  }, [focusTick])

  // Client errors follow the edit once the person has tried to save; a server error stays until the next edit.
  const client = attempted ? validate(values) : null
  const shown: Errors = {
    name: server.name ?? client?.name,
    general: server.general ?? client?.general,
    list: server.list ?? client?.list,
    rows: values.sections.map((_, index) => server.rows[index] ?? client?.rows[index] ?? null),
  }
  const anyError = Boolean(shown.name || shown.general || shown.list || shown.rows.some((row) => row !== null))

  const change = (patch: Partial<Values>) => {
    setValues((current) => ({ ...current, ...patch }))
    setServer(EMPTY_ERRORS)
    setFormError(null)
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setAttempted(true)
    setFormError(null)
    if (validate(values) !== null) {
      setServer(EMPTY_ERRORS)
      setFocusTick((tick) => tick + 1)
      return
    }

    const name = values.name.trim()
    const general = values.general.trim()
    const sections = values.sections.map((row) => ({ heading: row.heading.trim(), instruction: row.body.trim() }))
    setBusy(true)
    try {
      const saved =
        template === null
          ? await createTemplate({
              scope: values.scope,
              name,
              sections,
              ...(general !== '' ? { generalInstructions: general } : {}),
            })
          : await updateTemplate(template.id, template.version, { name, sections, generalInstructions: general })
      await navigate({ to: '/templates/$id', params: { id: saved.id }, state: { templatesNotice: 'saved' } })
    } catch (error) {
      setBusy(false)
      const fields = fieldErrorsOf(error)
      const failure = describeFailure(error)
      if (isStaleWrite(error)) {
        onStale()
      } else if (codeOf(error) === 'template_name_taken') {
        setServer({ ...EMPTY_ERRORS, name: errorMessage(error) })
        setFocusTick((tick) => tick + 1)
      } else if (fields.length > 0) {
        const { errors, unplaced } = placeServerErrors(fields)
        setServer(errors)
        setFormError(unplaced.length > 0 ? unplaced.join(' ') : null)
        setFocusTick((tick) => tick + 1)
      } else if (failure.kind === 'forbidden') {
        onOutcome('denied')
      } else if (failure.kind === 'notFound') {
        onOutcome('missing')
      } else {
        setFormError(failure.kind === 'authUnavailable' ? strings.common.authUnavailable.body : failure.message)
      }
    }
  }

  const cancelTo = template === null ? '/templates' : `/templates/${encodeURIComponent(template.id)}`

  return (
    <form ref={formRef} noValidate onSubmit={onSubmit} data-testid="meetings-template-form">
      <div className="flex flex-col gap-4">
        <Card title={t.detailsTitle}>
          <div className="flex flex-col gap-4">
            {anyError && (
              <Banner tone="danger" data-testid="meetings-template-error-summary">
                {t.errors.summary}
              </Banner>
            )}

            <Field label={t.name} hint={t.nameHint} error={shown.name} required>
              {(control) => (
                <input
                  {...control}
                  value={values.name}
                  onChange={(event) => change({ name: event.target.value })}
                  data-testid="meetings-template-name"
                />
              )}
            </Field>

            {template === null ? (
              canManageTemplates && (
                <RadioGroupField label={t.scope} required>
                  {(
                    [
                      ['personal', t.scopePersonal, t.scopePersonalHint],
                      ['shared', t.scopeShared, t.scopeSharedHint],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <div key={value} className="flex flex-col gap-1">
                      <label>
                        <input
                          type="radio"
                          name={`${radioName}-scope`}
                          value={value}
                          checked={values.scope === value}
                          onChange={() => change({ scope: value })}
                        />
                        {label}
                      </label>
                      <span className="field-hint">{hint}</span>
                    </div>
                  ))}
                </RadioGroupField>
              )
            ) : (
              <FactList
                items={[
                  {
                    id: 'scope',
                    term: t.scopeFixed,
                    value: <Badge>{strings.templates.type[template.source]}</Badge>,
                  },
                ]}
              />
            )}

            <Field
              label={t.generalInstructions}
              hint={t.generalInstructionsHint(values.general.length, GENERAL_MAX)}
              error={shown.general}
            >
              {(control) => (
                <textarea
                  {...control}
                  rows={4}
                  value={values.general}
                  onChange={(event) => change({ general: event.target.value })}
                  data-testid="meetings-template-general"
                />
              )}
            </Field>
          </div>
        </Card>

        <Card>
          <SectionsEditor
            sections={values.sections}
            onChange={(sections) => change({ sections })}
            createSection={blankRow}
            min={SECTIONS_MIN}
            max={SECTIONS_MAX}
            rowErrors={shown.rows}
            listError={shown.list}
            disabled={busy}
            testIdPrefix="meetings-template"
            copy={t.sections}
          />
        </Card>

        {formError && (
          <p className="form-error" role="alert" data-testid="meetings-template-form-error">
            {formError}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => void navigate({ to: cancelTo })}
            data-testid="meetings-template-cancel"
          >
            {t.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy} data-testid="meetings-template-save">
            {busy ? t.saving : t.save}
          </Button>
        </div>
      </div>
    </form>
  )
}

/**
 * Template editor, new and edit (specs/021-meetings S8, T74): name, scope (shared only for a
 * `template:manage` holder; fixed once saved), general instructions and 1 to 15 sections on the
 * library `SectionsEditor`. A save of an existing template carries the version it read as `If-Match`
 * (plan G8): a 409/428 shows the stale-write banner, and Reload fetches the template again and
 * REPLACES the form with it (the banner says the unsaved edits are discarded).
 */
export default function TemplateEditorPage() {
  const t = strings.templates
  const { id } = useParams({ strict: false })
  const editing = id !== undefined
  const notice = useRouterState({ select: (state) => state.location.state.templatesNotice })
  const { canManageTemplates } = useCapabilityHints()

  const fetchTemplate = useCallback(
    (signal: AbortSignal) =>
      editing ? listTemplates({}, { signal }).then((result) => result.items) : Promise.resolve(null),
    [editing],
  )
  const resource = useResource(fetchTemplate)

  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const [stale, setStale] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const reload = () => {
    setStale(false)
    resource.retry()
  }

  const frame = (content: ReactNode) => (
    <section aria-labelledby="meetings-template-editor-page-heading" data-testid="meetings-template-editor-page">
      <PageHeader
        title={editing ? t.editor.editHeading : t.editor.newHeading}
        titleId="meetings-template-editor-page-heading"
        back={
          <Link to="/templates" className="link" data-testid="meetings-template-back">
            <Icon name="arrow-left" /> {t.back}
          </Link>
        }
      />
      {content}
    </section>
  )

  const notFound = frame(
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

  if (outcome === 'denied') return frame(<PermissionDenied />)
  if (outcome === 'missing') return notFound
  // A new template needs nothing loaded, so it is on screen at once.
  if (editing && resource.status === 'loading') return frame(<Loading label={t.loading} />)
  if (editing && resource.status === 'error') {
    return frame(
      statusOf(resource.error) === 403 ? (
        <PermissionDenied />
      ) : (
        <LoadFailure error={resource.error} onRetry={resource.retry} />
      ),
    )
  }

  const template = editing ? (resource.data?.find((item) => item.id === id) ?? null) : null
  if (editing && template === null) return notFound

  const cannotEdit =
    template?.source === 'builtin'
      ? t.editor.cannotEdit.builtin
      : template?.source === 'shared' && !canManageTemplates
        ? t.editor.cannotEdit.shared
        : null
  if (cannotEdit !== null) {
    return frame(
      <Banner tone="info" data-testid="meetings-template-cannot-edit">
        {cannotEdit}
      </Banner>,
    )
  }

  return frame(
    <div className="flex flex-col gap-4">
      {notice === 'copied' && !noticeDismissed && (
        <Saved message={t.notice.copied} onDismiss={() => setNoticeDismissed(true)} />
      )}
      {stale && (
        <Banner
          tone="danger"
          title={t.editor.stale.title}
          data-testid="meetings-template-stale"
          onRetry={reload}
          retryLabel={t.editor.stale.reload}
          retryTestId="meetings-template-stale-reload"
        >
          {t.editor.stale.body}
        </Banner>
      )}
      <TemplateForm template={template} onStale={() => setStale(true)} onOutcome={setOutcome} />
    </div>,
  )
}
