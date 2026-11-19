import { useEffect, useRef, useState } from 'react'
import { Button, FactList, Field, VisuallyHidden } from '@operai/ui'
import { readActivities, type ActivitiesPage, type ActivityOption } from '../lib/activitiesRead'
import type { Visibility } from '../lib/hoursApi.types'
import { strings } from '../strings'

export type ActivityFieldProps = {
  targetType: 'project' | 'deal'
  targetId: string | null
  value: string | null
  onChange: (id: string | null) => void
  /**
   * The edited entry's own activity, from its view: it stays an option even when the loaded page does not hold it.
   * Pass it only while the entry is still on the target it was saved on (a pointer belongs to a target). With
   * `lock="fixed"` it is the task the page chose, which the field then shows as a fact.
   */
  current?: { id: string; subject: string | null; visibility: Visibility } | null
  /**
   * What a refused save said about this field (422 `activity_not_allowed`), worded by the dialog: shown under the
   * field as an alert and marking it invalid. The load error is never this: it is a polite hint, the field is optional.
   */
  error?: string | null
  /** The dialog is saving: nothing can be picked and Try again is off. */
  disabled?: boolean
  /**
   * `hidden` — the "not visible" variant (design S2, AC-4.10): the author can no longer read the entry's project or
   * deal, so the field is not editable while the target is unchanged. It reads nothing (the person could not read
   * that target's activities anyway), shows only `current` — the entry's pointer — and says why. Drop it when
   * another target is picked: the field then reads that target's activities as any other.
   *
   * `fixed` — the dialog was opened from a task (specs/20261116-record-hours-in-place, design S4): the activity is
   * a fact the page chose, shown as text (`current`'s subject) with its own hint. It is not a control, reads
   * nothing and cannot be changed.
   */
  lock?: 'hidden' | 'fixed'
  /** @deprecated `lock="hidden"`: kept so a caller written before `lock` existed (and its tests) keeps working. */
  locked?: boolean
  testId?: string
}

/** The option value of a pointer the viewer may not read: a token, never its id. */
const HIDDEN_POINTER = 'hidden-pointer'

/** What a read came to, for the read it was made for (`key`): the page, or `null` when it failed. */
type Answer = { key: string; page: ActivitiesPage | null }

const optionLabel = (option: ActivityOption) =>
  option.type === null ? option.subject : strings.activity.option(strings.activity.type[option.type], option.subject)

/** The entry's own activity, worded as its view allows: the view carries a subject only when it was readable. */
const currentLabel = (current: NonNullable<ActivityFieldProps['current']>) =>
  current.subject !== null && current.visibility === 'visible'
    ? current.subject
    : current.visibility === 'hidden'
      ? strings.activity.currentHidden
      : strings.activity.currentUnavailable

export default function ActivityField({
  targetType,
  targetId,
  value,
  onChange,
  current = null,
  error = null,
  disabled = false,
  lock,
  locked = false,
  testId = 'hours-activity',
}: ActivityFieldProps) {
  const mode = lock ?? (locked ? 'hidden' : undefined)
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const selectRef = useRef<HTMLSelectElement>(null)

  // One key per read: a new target, or Try again. An answer is shown only for the read it belongs to. A locked
  // field (either variant) makes no read at all.
  const key = targetId === null || mode !== undefined ? null : `${targetType}:${targetId}:${attempt}`
  useEffect(() => {
    if (targetId === null || key === null) return
    const controller = new AbortController()
    readActivities({ type: targetType, id: targetId }, { signal: controller.signal }).then(
      (page) => {
        if (!controller.signal.aborted) setAnswer({ key, page })
      },
      () => {
        if (!controller.signal.aborted) setAnswer({ key, page: null })
      },
    )
    return () => controller.abort()
  }, [key, targetType, targetId])

  // The fixed variant: the task the page chose, as a fact. No control and no read (the hooks above stay unconditional).
  if (mode === 'fixed') {
    const subject = current?.subject?.trim() ? current.subject : strings.activity.fixed.unnamed
    return (
      <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
        <FactList
          className="grid-cols-1"
          items={[{ id: 'activity', term: strings.activity.label, value: subject }]}
          testId={`${testId}-fixed`}
        />
        <p className="field-hint">{strings.activity.fixed.hint}</p>
      </div>
    )
  }

  const settled = answer !== null && answer.key === key ? answer : null
  const phase =
    mode === 'hidden'
      ? 'locked'
      : key === null
        ? 'idle'
        : settled === null
          ? 'loading'
          : settled.page === null
            ? 'failed'
            : 'loaded'
  const items = settled?.page?.items ?? []

  // The entry's own activity comes first when the page does not hold it, so it is easy to find and keep. A
  // locked field has no page: the pointer is all it shows.
  // An option's `value` is its id — except for a pointer the viewer may not read, whose id is never drawn into
  // the page (the UI shows no id for a record withheld from the viewer, AC-4.10): it gets an opaque token.
  const options = [
    ...(current !== null && phase !== 'idle' && !items.some((item) => item.id === current.id)
      ? [
          {
            id: current.id,
            value: current.visibility === 'hidden' ? HIDDEN_POINTER : current.id,
            label: currentLabel(current),
          },
        ]
      : []),
    ...items.map((item) => ({ id: item.id, value: item.id, label: optionLabel(item) })),
  ]
  // What the select shows can only be an option it has; a value it cannot show reads as "No activity".
  const shownValue = options.find((option) => option.id === value)?.value ?? ''

  const hint =
    phase === 'locked'
      ? strings.activity.locked[targetType]
      : phase === 'idle'
        ? strings.activity.chooseFirst[targetType]
        : phase === 'loading'
          ? strings.activity.loading
          : phase === 'failed'
            ? strings.activity.loadFailed
            : settled !== null && settled.page !== null && settled.page.total > items.length
              ? strings.activity.latest(items.length)
              : undefined
  const usable = phase === 'loaded'

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <Field
        label={strings.activity.label}
        hint={hint}
        error={error ?? undefined}
        errorRole="alert"
        testId={`${testId}-field`}
        errorTestId={`${testId}-error`}
      >
        {(control) => (
          <select
            {...control}
            ref={selectRef}
            disabled={disabled}
            aria-disabled={usable ? undefined : true}
            // The library draws no state for an aria-disabled select; it looks as inert as a Combobox does.
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            value={shownValue}
            onChange={(event) => {
              if (usable) onChange(options.find((option) => option.value === event.target.value)?.id ?? null)
            }}
            data-testid={`${testId}-select`}
          >
            <option value="">{phase === 'loading' ? strings.activity.loading : strings.activity.none}</option>
            {options.map((option) => (
              <option key={option.id} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {phase === 'failed' && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={disabled}
          onClick={() => {
            // The button goes away as the read starts: keep the keyboard where the person is.
            selectRef.current?.focus()
            setAttempt((count) => count + 1)
          }}
          data-testid={`${testId}-retry`}
        >
          {strings.common.tryAgain}
        </Button>
      )}
      <VisuallyHidden role="status">
        {phase === 'loading' ? strings.activity.loading : phase === 'failed' ? strings.activity.loadFailed : ''}
      </VisuallyHidden>
    </div>
  )
}
