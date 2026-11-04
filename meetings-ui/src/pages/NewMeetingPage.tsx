import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  Banner,
  Button,
  Card,
  DateTimeInput,
  FactList,
  Field,
  Icon,
  PageHeader,
  RadioGroupField,
  Skeleton,
  StatePanel,
  VisuallyHidden,
  focusFirstInvalid,
  resolveLocale,
} from '@operai/ui'
import PermissionDenied from '../components/PermissionDenied'
import { useResource } from '../hooks/useResource'
import { codeOf, errorMessage, fieldErrorsOf, isAuthUnavailable, statusOf } from '../lib/errors'
import { describeHost, hostNames, useHosts } from '../lib/hostLinks'
import { createMeeting, getHost } from '../lib/meetingsApi'
import type { CreateMeetingInput } from '../lib/meetingsApi'
import type { HostRef, MeetingFormat, MeetingLanguage, MeetingSource } from '../lib/types'
import { strings } from '../strings'

const TITLE_MAX = 200

// The one thing this page hands to the meeting page it navigates to: a flag in the history state
// (no query parameter to bookmark, gone on reload), so the new meeting can say "Meeting created".
declare module '@tanstack/react-router' {
  interface HistoryState {
    meetingCreated?: boolean
  }
}

type FieldName = 'title' | 'startsAt' | 'format' | 'language' | 'source'
type FieldErrors = Partial<Record<FieldName, string>>

const FIELD_ORDER: readonly FieldName[] = ['title', 'format', 'startsAt', 'language', 'source']
const isFieldName = (name: string): name is FieldName => (FIELD_ORDER as readonly string[]).includes(name)

const two = (n: number) => String(n).padStart(2, '0')

/** A `datetime-local` value (the person's local time, minutes) for an instant. */
const toLocalInput = (date: Date) =>
  `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`

/**
 * The host reference of the link that opened this page (`?hostApp=crm&hostType=deal&hostId=…`).
 * An incomplete reference is no reference. The router's search parser reads a numeric-looking
 * value as a number, so values are put back through `String`; that is exact for any id the
 * suite issues (UUIDs, small integers), not for digits beyond 2^53.
 */
const parseHostRef = (search: Record<string, unknown>): HostRef | null => {
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
  const app = text(search['hostApp'])
  const entityType = text(search['hostType'])
  const entityId = text(search['hostId'])
  return app && entityType && entityId ? { app, entityType, entityId } : null
}

type HostProblem = 'forbidden' | 'notFound' | 'unavailable'

const HOST_NOT_FOUND_CODES = new Set(['host_entity_not_found', 'host_not_registered'])

/** Sorts a failed host lookup (or create) into what the page shows; AC-1.5 and AC-1.6 read the same. */
const hostProblemOf = (error: unknown): HostProblem => {
  if (statusOf(error) === 403) return 'forbidden'
  const code = codeOf(error)
  if (statusOf(error) === 404 || (code !== null && HOST_NOT_FOUND_CODES.has(code))) return 'notFound'
  return 'unavailable'
}

function RadioOption<T extends string>({
  name,
  value,
  current,
  label,
  hint,
  onSelect,
}: {
  name: string
  value: T
  current: T
  label: string
  hint?: string
  onSelect: (value: T) => void
}) {
  const hintId = useId()
  return (
    <div className="flex flex-col gap-1">
      <label>
        <input
          type="radio"
          name={name}
          value={value}
          checked={current === value}
          aria-describedby={hint ? hintId : undefined}
          onChange={() => onSelect(value)}
        />
        {label}
      </label>
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  )
}

/**
 * The new meeting page (specs/021-meetings S2, F1, F2; T56): a form (a page, not a dialog), opened
 * from the list or from a host record (`?hostApp&hostType&hostId`). A host record is looked up as the
 * caller, its title prefills the title, and it is shown read-only as "<Entity> · <title>".
 * A meeting is never created against a record that could not be checked (AC-11.6), but a standalone
 * one can always be started.
 */
export default function NewMeetingPage() {
  const t = strings.newMeeting
  const navigate = useNavigate()
  const hosts = useHosts()
  const hostRef = parseHostRef(useSearch({ strict: false }))
  const { app: hostApp, entityType: hostType, entityId: hostId } = hostRef ?? { app: '', entityType: '', entityId: '' }

  const formRef = useRef<HTMLFormElement>(null)
  const radioName = useId()

  // `null` until the person types: until then the title is the host record's.
  const [titleInput, setTitleInput] = useState<string | null>(null)
  const [startsAt, setStartsAt] = useState(() => toLocalInput(new Date()))
  const [format, setFormat] = useState<MeetingFormat>('online')
  const [language, setLanguage] = useState<MeetingLanguage>(() => resolveLocale())
  const [source, setSource] = useState<MeetingSource>('recorded')

  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hostGone, setHostGone] = useState(false)
  const [focusTick, setFocusTick] = useState(0)

  const fetchHost = useCallback(
    (signal: AbortSignal) => (hostApp ? getHost(hostApp, hostType, hostId, { signal }) : Promise.resolve(null)),
    [hostApp, hostType, hostId],
  )
  const lookup = useResource(fetchHost)
  const lookedUp = lookup.data?.host ?? null

  // After a failed submit, the first invalid control takes focus once the errors are on screen.
  useEffect(() => {
    if (focusTick > 0) focusFirstInvalid(formRef.current)
  }, [focusTick])

  const names = hostNames(hosts, hostApp, hostType)
  let problem: HostProblem | null = null
  if (hostRef !== null) {
    if (lookup.status === 'error') problem = hostProblemOf(lookup.error)
    else if (hostGone) problem = 'notFound'
    else if (lookedUp !== null && (lookedUp.state === 'closed' || lookedUp.state === 'missing')) problem = 'notFound'
    else if (lookedUp !== null && lookedUp.state === 'unavailable') problem = 'unavailable'
  }

  const title = titleInput ?? lookedUp?.title ?? ''

  const startStandalone = () => {
    setHostGone(false)
    void navigate({ to: '/new', replace: true })
  }

  const validate = (): FieldErrors => {
    const found: FieldErrors = {}
    const trimmed = title.trim()
    if (trimmed === '') found.title = t.errors.titleRequired
    else if (trimmed.length > TITLE_MAX) found.title = t.errors.titleTooLong
    if (startsAt === '' || Number.isNaN(new Date(startsAt).getTime())) found.startsAt = t.errors.startsAtInvalid
    return found
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setFormError(null)
    const found = validate()
    setErrors(found)
    if (Object.keys(found).length > 0) {
      setFocusTick((tick) => tick + 1)
      return
    }

    const input: CreateMeetingInput = {
      title: title.trim(),
      format,
      startsAt: new Date(startsAt).toISOString(),
      language,
      source,
      ...(hostRef !== null ? { host: hostRef } : {}),
    }
    setBusy(true)
    try {
      const created = await createMeeting(input)
      // `meetingCreated` lets the meeting page confirm "Meeting created" where the person lands.
      await navigate({ to: '/m/$id', params: { id: created.id }, state: { meetingCreated: true } })
    } catch (error) {
      setBusy(false)
      const fields = fieldErrorsOf(error)
      if (fields.length > 0) {
        const named: FieldErrors = {}
        const unplaced: string[] = []
        for (const { field, message } of fields) {
          if (isFieldName(field)) named[field] ??= message
          else unplaced.push(message)
        }
        setErrors(named)
        setFormError(unplaced.length > 0 ? unplaced.join(' ') : null)
        setFocusTick((tick) => tick + 1)
      } else if (hostRef !== null && statusOf(error) === 422 && HOST_NOT_FOUND_CODES.has(codeOf(error) ?? '')) {
        setHostGone(true)
      } else {
        setErrors({})
        setFormError(isAuthUnavailable(error) ? strings.common.authUnavailable.body : errorMessage(error))
      }
    }
  }

  const back = (
    <Link to="/" className="link" data-testid="meetings-new-back">
      <Icon name="arrow-left" /> {t.back}
    </Link>
  )

  const header = <PageHeader title={t.heading} titleId="meetings-new-page-heading" back={back} />

  const frame = (content: ReactNode) => (
    <section aria-labelledby="meetings-new-page-heading" data-testid="meetings-new-page">
      {header}
      {content}
    </section>
  )

  if (problem === 'forbidden') return frame(<PermissionDenied />)

  if (problem === 'notFound') {
    return frame(
      <StatePanel
        title={t.host.notFound.title}
        testId="meetings-new-host-not-found"
        action={
          <Button variant="secondary" onClick={startStandalone}>
            {t.host.notFound.standalone}
          </Button>
        }
      >
        {t.host.notFound.body}
      </StatePanel>,
    )
  }

  if (problem === 'unavailable') {
    return frame(
      <Banner
        tone="warning"
        title={t.host.unavailable.title(names.entity.toLocaleLowerCase(resolveLocale()))}
        data-testid="meetings-new-host-unavailable"
        onRetry={lookup.retry}
        retryLabel={strings.common.retry}
        actions={
          <Button size="sm" variant="secondary" onClick={startStandalone}>
            {t.host.unavailable.standalone}
          </Button>
        }
      >
        {t.host.unavailable.body}
      </Banner>,
    )
  }

  const hostText = lookedUp ? describeHost(lookedUp, hosts) : null

  return frame(
    <form ref={formRef} noValidate onSubmit={onSubmit} data-testid="meetings-new-form">
      <Card title={t.detailsTitle}>
        <div className="flex flex-col gap-4">
          {hostRef !== null && (
            <FactList
              items={[
                {
                  id: 'host',
                  term: t.linkedTo,
                  value:
                    hostText !== null && hostText.kind !== 'missing' ? (
                      hostText.text
                    ) : (
                      <>
                        <VisuallyHidden live role="status">
                          {t.loadingHost}
                        </VisuallyHidden>
                        <Skeleton width={160} height={14} />
                      </>
                    ),
                },
              ]}
              testId="meetings-new-linked"
            />
          )}

          {Object.keys(errors).length > 0 && (
            <Banner tone="danger" data-testid="meetings-new-error-summary">
              {t.errors.summary}
            </Banner>
          )}

          <Field label={t.fields.title} hint={t.fields.titleHint} error={errors.title} required>
            {(control) => (
              <input
                {...control}
                value={title}
                onChange={(event) => setTitleInput(event.target.value)}
                data-testid="meetings-new-title"
              />
            )}
          </Field>

          <RadioGroupField label={t.fields.format} error={errors.format} required>
            {(['online', 'in_person'] as const).map((value) => (
              <RadioOption
                key={value}
                name={`${radioName}-format`}
                value={value}
                current={format}
                label={t.format[value]}
                onSelect={setFormat}
              />
            ))}
          </RadioGroupField>

          <Field label={t.fields.startsAt} hint={t.fields.startsAtHint} error={errors.startsAt} required>
            {(control) => (
              <DateTimeInput
                {...control}
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
                data-testid="meetings-new-starts-at"
              />
            )}
          </Field>

          <RadioGroupField label={t.fields.language} hint={t.fields.languageHint} error={errors.language} required>
            {(['en', 'it'] as const).map((value) => (
              <RadioOption
                key={value}
                name={`${radioName}-language`}
                value={value}
                current={language}
                label={t.language[value]}
                onSelect={setLanguage}
              />
            ))}
          </RadioGroupField>

          <RadioGroupField label={t.fields.source} error={errors.source} required>
            <RadioOption
              name={`${radioName}-source`}
              value="recorded"
              current={source}
              label={t.source.recorded}
              hint={t.source.recordedHint}
              onSelect={setSource}
            />
            <RadioOption
              name={`${radioName}-source`}
              value="uploaded"
              current={source}
              label={t.source.uploaded}
              hint={t.source.uploadedHint}
              onSelect={setSource}
            />
            <RadioOption
              name={`${radioName}-source`}
              value="text"
              current={source}
              label={t.source.text}
              hint={t.source.textHint}
              onSelect={setSource}
            />
          </RadioGroupField>

          {formError && (
            <p className="form-error" role="alert" data-testid="meetings-new-form-error">
              {formError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => void navigate({ to: '/' })}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="primary" busy={busy} data-testid="meetings-new-submit">
              {busy ? t.submitting : t.submit}
            </Button>
          </div>
        </div>
      </Card>
    </form>,
  )
}
