/**
 * @vitest-environment jsdom
 *
 * ActivityField: the optional Activity select of the entry dialog (design S2 § Activity field; AC-2.7). Once a
 * project or a deal is picked the BROWSER reads its activities from activities-api as the person (plan §
 * Components `hours-ui`), one page of up to 100, and never through hours-api. The field is optional, so what it
 * shows never decides a save: it has no required state and nothing in it is an alert (the one exception is the
 * `error` a save refused it with, which the dialog passes in).
 */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))
vi.mock('shell/session', async () => (await import('../test-support/fakeSession')).shellSessionMock(apiFetch))

import {
  deferred,
  fakeApi,
  problem,
  requests,
  sequence,
  type FakeAnswer,
  type FakeHandler,
} from '../test-support/fakeApi'
import { ORIGINS } from '../test-support/fakeSession'
import { activitiesAnswer, dealActivities, manyTasks, projectTasks } from '../test-support/fixtures/activity'
import ActivityField, { type ActivityFieldProps } from './ActivityField'

type HarnessProps = Partial<Omit<ActivityFieldProps, 'value' | 'onChange'>> & {
  initialValue?: string | null
  onChange?: (id: string | null) => void
}

/** The dialog's side of the contract: it owns the chosen activity, the field only reads and reports. */
function Harness({ initialValue = null, onChange, ...props }: HarnessProps) {
  const [value, setValue] = useState<string | null>(initialValue)
  return (
    <ActivityField
      targetType="project"
      targetId={null}
      {...props}
      value={value}
      onChange={(id) => {
        setValue(id)
        onChange?.(id)
      }}
    />
  )
}

const field = () => screen.getByRole('combobox', { name: 'Activity' })
const optionTexts = () =>
  within(field())
    .getAllByRole('option')
    .map((option) => option.textContent)

/** What the select is described by: the text of every element its `aria-describedby` names. */
const description = () =>
  (field().getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent)
    .join(' ')

/** The one polite status region of the field. */
const status = () => within(screen.getByTestId('hours-activity')).getByRole('status')

const activityRequests = () => requests(apiFetch, 'GET /activities')

/** The English line of a failed read (design S2); the app pins English under jsdom. */
const LOAD_FAILED = 'Activities could not be loaded. You can save without one.'

/** Answers `GET /activities` with `items` (`total` when the page holds fewer). */
const answersWith = (items: unknown[], total?: number) =>
  apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => activitiesAnswer(items, total) }))

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(fakeApi())
})
afterEach(() => cleanup())

describe('before a project or a deal is chosen', () => {
  it('is aria-disabled, offers only "No activity" and says what to do first', () => {
    render(<Harness targetType="project" targetId={null} />)

    expect(field().getAttribute('aria-disabled')).toBe('true')
    expect(optionTexts()).toEqual(['No activity'])
    expect(description()).toBe('Choose a project first.')
  })

  it('asks for a deal first when the entry is on a deal', () => {
    render(<Harness targetType="deal" targetId={null} />)

    expect(description()).toBe('Choose a deal first.')
  })

  it('reads nothing from anyone', () => {
    render(<Harness targetType="project" targetId={null} />)

    expect(requests(apiFetch)).toEqual([])
  })
})

describe('once a project or a deal is chosen', () => {
  it('reads the project’s activities from activities-api as the person, saying so politely while it waits', async () => {
    const answer = deferred<FakeAnswer>()
    apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => answer.promise }))

    render(<Harness targetType="project" targetId="p1" />)

    expect(activityRequests()).toEqual([
      expect.objectContaining({
        method: 'GET',
        origin: ORIGINS.activities,
        path: '/activities',
        query: { projectId: 'p1', pageSize: '100' },
      }),
    ])
    expect(status().textContent).toBe('Loading activities…')
    expect(description()).toBe('Loading activities…')
    expect(field().getAttribute('aria-disabled')).toBe('true')
    expect(optionTexts()).toEqual(['Loading activities…'])

    answer.resolve(activitiesAnswer(projectTasks))
    await waitFor(() => expect(field().getAttribute('aria-disabled')).toBeNull())
    expect(status().textContent).toBe('')
  })

  it('offers "No activity" and one "Type · subject" option per activity, in activities-api’s order', async () => {
    answersWith(projectTasks)

    render(<Harness targetType="project" targetId="p1" />)

    await waitFor(() =>
      expect(optionTexts()).toEqual(['No activity', 'Task · Write the offer', 'Task · Review the design']),
    )
    expect(description()).toBe('')
  })

  it('reads a deal’s activities by dealId and words each type', async () => {
    answersWith(dealActivities)

    render(<Harness targetType="deal" targetId="d1" />)

    await waitFor(() =>
      expect(optionTexts()).toEqual([
        'No activity',
        'Call · Call Acme about the renewal',
        'Note · Budget is fixed',
        'Task · Send the offer',
      ]),
    )
    expect(activityRequests()[0]!.query).toEqual({ dealId: 'd1', pageSize: '100' })
  })

  it('shows an activity of a type this build does not know by its subject alone', async () => {
    answersWith([{ id: 'a9', type: 'visit', subject: 'On site' }])

    render(<Harness targetType="project" targetId="p1" />)

    await waitFor(() => expect(optionTexts()).toEqual(['No activity', 'On site']))
  })

  it('reports the activity the person picks, and null for "No activity"', async () => {
    answersWith(projectTasks)
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Harness targetType="project" targetId="p1" onChange={onChange} />)
    await waitFor(() => expect(optionTexts()).toHaveLength(3))

    await user.selectOptions(field(), 'Task · Review the design')
    expect(onChange).toHaveBeenLastCalledWith('a-review')
    expect((field() as HTMLSelectElement).value).toBe('a-review')

    await user.selectOptions(field(), 'No activity')
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect((field() as HTMLSelectElement).value).toBe('')
  })

  it('shows the activity it was given as the chosen one', async () => {
    answersWith(projectTasks)

    render(<Harness targetType="project" targetId="p1" initialValue="a-review" />)

    await waitFor(() => expect(optionTexts()).toHaveLength(3))
    expect((field() as HTMLSelectElement).value).toBe('a-review')
  })
})

describe('when there are more activities than one page holds', () => {
  it('says the latest N are shown and that older ones cannot be chosen here', async () => {
    answersWith(manyTasks(100), 130)

    render(<Harness targetType="project" targetId="p1" />)

    await waitFor(() =>
      expect(description()).toBe("Showing the latest 100 activities. Older ones can't be chosen here."),
    )
    expect(optionTexts()).toHaveLength(101)
    expect(optionTexts()[1]).toBe('Task · Task 1')
    expect(field().getAttribute('aria-disabled')).toBeNull()
  })

  it('counts what was loaded, not what exists', async () => {
    answersWith(manyTasks(40), 41)

    render(<Harness targetType="project" targetId="p1" />)

    await waitFor(() =>
      expect(description()).toBe("Showing the latest 40 activities. Older ones can't be chosen here."),
    )
  })

  it('says "activity", not "1 activities", when one was loaded', async () => {
    answersWith(manyTasks(1), 2)

    render(<Harness targetType="project" targetId="p1" />)

    await waitFor(() => expect(description()).toBe("Showing the latest activity. Older ones can't be chosen here."))
  })

  it('says nothing when the page holds them all', async () => {
    answersWith(manyTasks(100), 100)

    render(<Harness targetType="project" targetId="p1" />)

    await waitFor(() => expect(optionTexts()).toHaveLength(101))
    expect(description()).toBe('')
    expect(field().getAttribute('aria-describedby')).toBeNull()
  })
})

describe('an edited entry’s current activity (design S2: it stays an option from the entry’s view)', () => {
  const current = { id: 'a-old', subject: 'Plan the sprint', visibility: 'visible' as const }

  it('stays an option, right after "No activity", when it is outside the loaded page, and is the chosen one', async () => {
    answersWith(projectTasks, 230)

    render(<Harness targetType="project" targetId="p1" current={current} initialValue="a-old" />)

    await waitFor(() => expect(optionTexts()).toHaveLength(4))
    expect(optionTexts()).toEqual([
      'No activity',
      'Plan the sprint',
      'Task · Write the offer',
      'Task · Review the design',
    ])
    expect((field() as HTMLSelectElement).value).toBe('a-old')
  })

  it('is not offered twice when the page has it, and then reads as the page words it', async () => {
    answersWith(projectTasks)

    render(
      <Harness
        targetType="project"
        targetId="p1"
        current={{ id: 'a-review', subject: 'Review the design', visibility: 'visible' }}
        initialValue="a-review"
      />,
    )

    await waitFor(() =>
      expect(optionTexts()).toEqual(['No activity', 'Task · Write the offer', 'Task · Review the design']),
    )
    expect((field() as HTMLSelectElement).value).toBe('a-review')
  })

  it('stays, and stays chosen, while the activities load and when they cannot be loaded', async () => {
    const answer = deferred<FakeAnswer>()
    apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => answer.promise }))
    render(<Harness targetType="project" targetId="p1" current={current} initialValue="a-old" />)

    expect(optionTexts()).toEqual(['Loading activities…', 'Plan the sprint'])
    expect((field() as HTMLSelectElement).value).toBe('a-old')

    answer.resolve({ status: 503, body: problem(503, 'host_unavailable') })
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))
    expect(optionTexts()).toEqual(['No activity', 'Plan the sprint'])
    expect((field() as HTMLSelectElement).value).toBe('a-old')
    expect(field().getAttribute('aria-disabled')).toBe('true')
  })

  it.each([
    ['unavailable', 'Name unavailable'],
    ['hidden', 'Not visible to you'],
  ] as const)('is worded as "%s" when its subject did not come with the view', async (visibility, words) => {
    answersWith(projectTasks)

    render(
      <Harness
        targetType="project"
        targetId="p1"
        current={{ id: 'a-old', subject: null, visibility }}
        initialValue="a-old"
      />,
    )

    await waitFor(() => expect(optionTexts()).toHaveLength(4))
    expect(optionTexts()[1]).toBe(words)
  })

  it('is not offered before an entity is chosen: a pointer belongs to a target', () => {
    render(<Harness targetType="project" targetId={null} current={current} />)

    expect(optionTexts()).toEqual(['No activity'])
  })
})

describe('when the project or deal changes', () => {
  /** One held answer per target, so a test releases them in the order it is about. */
  const held = () => {
    const answers = new Map<string, ReturnType<typeof deferred<FakeAnswer>>>()
    apiFetch.mockImplementation(
      fakeApi({
        'GET /activities': (url) => {
          const target = url.searchParams.get('projectId') ?? url.searchParams.get('dealId') ?? ''
          const answer = deferred<FakeAnswer>()
          answers.set(target, answer)
          return answer.promise
        },
      }),
    )
    return answers
  }

  it('reads the new project, and never shows a late answer of the old one', async () => {
    const answers = held()
    const { rerender } = render(<Harness targetType="project" targetId="p1" />)
    rerender(<Harness targetType="project" targetId="p2" />)

    expect(activityRequests().map((request) => request.query['projectId'])).toEqual(['p1', 'p2'])
    answers.get('p2')!.resolve(activitiesAnswer([{ id: 'a-two', type: 'task', subject: 'Of project two' }]))
    await waitFor(() => expect(optionTexts()).toEqual(['No activity', 'Task · Of project two']))

    answers.get('p1')!.resolve(activitiesAnswer([{ id: 'a-one', type: 'task', subject: 'Of project one' }]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(optionTexts()).toEqual(['No activity', 'Task · Of project two'])
  })

  it('shows the old project’s activities no longer, and says it is loading, while the new ones come', async () => {
    const answers = held()
    const { rerender } = render(<Harness targetType="project" targetId="p1" />)
    answers.get('p1')!.resolve(activitiesAnswer(projectTasks))
    await waitFor(() => expect(optionTexts()).toHaveLength(3))

    rerender(<Harness targetType="project" targetId="p2" />)

    expect(optionTexts()).toEqual(['Loading activities…'])
    expect(status().textContent).toBe('Loading activities…')
    expect(field().getAttribute('aria-disabled')).toBe('true')
  })

  it('does not show a late failure of the old project over the new project’s activities', async () => {
    const answers = held()
    const { rerender } = render(<Harness targetType="project" targetId="p1" />)
    rerender(<Harness targetType="project" targetId="p2" />)
    answers.get('p2')!.resolve(activitiesAnswer(projectTasks))
    await waitFor(() => expect(optionTexts()).toHaveLength(3))

    answers.get('p1')!.resolve({ status: 503, body: problem(503, 'host_unavailable') })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(optionTexts()).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('takes no answer of an aborted read, even from a request that ignored the abort, for a project it came back to', async () => {
    // Read 1 (p1) outlives its abort and answers last; reads 2 (p2) and 3 (p1 again) are still out.
    const first = deferred<Response>()
    let reads = 0
    apiFetch.mockImplementation(() => (++reads === 1 ? first.promise : new Promise<Response>(() => {})))
    const { rerender } = render(<Harness targetType="project" targetId="p1" />)
    rerender(<Harness targetType="project" targetId="p2" />)
    rerender(<Harness targetType="project" targetId="p1" />)

    first.resolve(new Response(JSON.stringify(problem(503, 'host_unavailable')), { status: 503 }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(status().textContent).toBe('Loading activities…')
    expect(optionTexts()).toEqual(['Loading activities…'])
  })

  it('reads by dealId when the entry moves from a project to a deal', async () => {
    const answers = held()
    const { rerender } = render(<Harness targetType="project" targetId="p1" />)
    rerender(<Harness targetType="deal" targetId="d1" />)

    expect(activityRequests().map((request) => request.query)).toEqual([
      { projectId: 'p1', pageSize: '100' },
      { dealId: 'd1', pageSize: '100' },
    ])
    answers.get('d1')!.resolve(activitiesAnswer(dealActivities))
    await waitFor(() => expect(optionTexts()).toHaveLength(4))
  })

  it('goes back to asking for an entity when it is cleared, and reads nothing more', async () => {
    const answers = held()
    const { rerender } = render(<Harness targetType="project" targetId="p1" />)
    answers.get('p1')!.resolve(activitiesAnswer(projectTasks))
    await waitFor(() => expect(optionTexts()).toHaveLength(3))

    rerender(<Harness targetType="project" targetId={null} />)

    expect(optionTexts()).toEqual(['No activity'])
    expect(description()).toBe('Choose a project first.')
    expect(field().getAttribute('aria-disabled')).toBe('true')
    expect(activityRequests()).toHaveLength(1)
  })

  it('aborts the read in flight when the target changes, and when the field goes away', async () => {
    held()
    const { rerender, unmount } = render(<Harness targetType="project" targetId="p1" />)
    const signals = () => apiFetch.mock.calls.map(([, init]) => init?.signal)

    rerender(<Harness targetType="project" targetId="p2" />)
    expect(signals().map((signal) => signal?.aborted)).toEqual([true, false])

    unmount()
    expect(signals().map((signal) => signal?.aborted)).toEqual([true, true])
  })
})

describe('an aria-disabled field is inert (it stays focusable only so the person can learn why)', () => {
  const current = { id: 'a-old', subject: 'Plan the sprint', visibility: 'visible' as const }

  it('ignores a pick while the activities cannot be read, and keeps showing what it had', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    apiFetch.mockImplementation(
      fakeApi({ 'GET /activities': () => ({ status: 404, body: problem(404, 'not_found') }) }),
    )
    render(<Harness targetType="project" targetId="p1" current={current} initialValue="a-old" onChange={onChange} />)
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))

    await user.selectOptions(field(), 'No activity')

    expect(onChange).not.toHaveBeenCalled()
    expect((field() as HTMLSelectElement).value).toBe('a-old')
  })

  it('ignores a pick while the activities load', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    apiFetch.mockImplementation(fakeApi({ 'GET /activities': () => deferred<FakeAnswer>().promise }))
    render(<Harness targetType="project" targetId="p1" current={current} initialValue="a-old" onChange={onChange} />)

    await user.selectOptions(field(), 'Loading activities…')

    expect(onChange).not.toHaveBeenCalled()
    expect((field() as HTMLSelectElement).value).toBe('a-old')
  })

  it('can be focused to read why, in the order hint, then Try again', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(
      fakeApi({ 'GET /activities': () => ({ status: 503, body: problem(503, 'host_unavailable') }) }),
    )
    render(<Harness targetType="project" targetId="p1" />)
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))

    await user.tab()
    expect(document.activeElement).toBe(field())

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' }))
  })
})

describe('when a save refused the activity, or the dialog is saving', () => {
  it('shows the refusal under the field, as an alert that names it, and marks the field invalid', async () => {
    answersWith(projectTasks)

    render(
      <Harness
        targetType="project"
        targetId="p1"
        initialValue="a-offer"
        error="This activity does not belong to the chosen project."
      />,
    )
    await waitFor(() => expect(optionTexts()).toHaveLength(3))

    expect(screen.getByRole('alert').textContent).toBe('This activity does not belong to the chosen project.')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(description()).toBe('This activity does not belong to the chosen project.')
  })

  it('shows no alert without a refusal', async () => {
    answersWith(projectTasks)

    render(<Harness targetType="project" targetId="p1" />)
    await waitFor(() => expect(optionTexts()).toHaveLength(3))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('is disabled while the dialog saves, Try again included', async () => {
    apiFetch.mockImplementation(
      fakeApi({ 'GET /activities': () => ({ status: 503, body: problem(503, 'host_unavailable') }) }),
    )
    const { rerender } = render(<Harness targetType="project" targetId="p1" />)
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))

    rerender(<Harness targetType="project" targetId="p1" disabled />)

    expect(field().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(true)
  })

  it('is usable again, and not disabled, when the dialog stops saving', async () => {
    answersWith(projectTasks)
    const { rerender } = render(<Harness targetType="project" targetId="p1" disabled />)
    await waitFor(() => expect(optionTexts()).toHaveLength(3))
    expect(field().hasAttribute('disabled')).toBe(true)

    rerender(<Harness targetType="project" targetId="p1" disabled={false} />)

    expect(field().hasAttribute('disabled')).toBe(false)
  })
})

describe('when the activities cannot be read (the field is optional, the save is checked by hours-api)', () => {
  const failures: [string, FakeHandler][] = [
    [
      'a 404: the project is not readable through activities-api',
      () => ({ status: 404, body: problem(404, 'not_found') }),
    ],
    ['a 503 host_unavailable', () => ({ status: 503, body: problem(503, 'host_unavailable') })],
    ['an unexpected 500', () => ({ status: 500, body: problem(500) })],
    [
      'a network failure',
      () => {
        throw new TypeError('Failed to fetch')
      },
    ],
  ]

  it.each(failures)(
    'after %s it is aria-disabled with only "No activity" and says so, politely',
    async (_name, handler) => {
      apiFetch.mockImplementation(fakeApi({ 'GET /activities': handler }))

      render(<Harness targetType="project" targetId="p1" />)

      await waitFor(() => expect(description()).toBe(LOAD_FAILED))
      expect(field().getAttribute('aria-disabled')).toBe('true')
      expect(optionTexts()).toEqual(['No activity'])
      expect(status().textContent).toBe(LOAD_FAILED)
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    },
  )

  it('shows nothing of it as an alert and never marks the field invalid or required', async () => {
    apiFetch.mockImplementation(
      fakeApi({ 'GET /activities': () => ({ status: 503, body: problem(503, 'host_unavailable') }) }),
    )

    render(<Harness targetType="project" targetId="p1" />)
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))

    expect(within(screen.getByTestId('hours-activity')).queryByRole('alert')).toBeNull()
    expect(field().getAttribute('aria-invalid')).toBeNull()
    expect(field().getAttribute('aria-required')).toBeNull()
    expect(field().hasAttribute('required')).toBe(false)
    expect(field().hasAttribute('disabled')).toBe(false)
  })

  it('Try again sends the read again, and the activities appear when it works', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(
      fakeApi({
        'GET /activities': sequence(
          () => ({ status: 503, body: problem(503, 'host_unavailable') }),
          () => activitiesAnswer(projectTasks),
        ),
      }),
    )
    render(<Harness targetType="project" targetId="p1" />)
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))
    expect(activityRequests()).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(activityRequests()).toHaveLength(2)
    expect(activityRequests()[1]!.query).toEqual({ projectId: 'p1', pageSize: '100' })
    await waitFor(() =>
      expect(optionTexts()).toEqual(['No activity', 'Task · Write the offer', 'Task · Review the design']),
    )
    expect(field().getAttribute('aria-disabled')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('keeps the person’s place: Try again moves focus to the field, whose button is about to go away', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(
      fakeApi({
        'GET /activities': sequence(
          () => ({ status: 503, body: problem(503, 'host_unavailable') }),
          () => activitiesAnswer(projectTasks),
        ),
      }),
    )
    render(<Harness targetType="project" targetId="p1" />)
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(document.activeElement).toBe(field())
  })

  it('goes back to the failed state, with its button, when the second read fails too', async () => {
    const user = userEvent.setup()
    apiFetch.mockImplementation(
      fakeApi({ 'GET /activities': () => ({ status: 404, body: problem(404, 'not_found') }) }),
    )
    render(<Harness targetType="project" targetId="p1" />)
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))

    await user.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(activityRequests()).toHaveLength(2))
    await waitFor(() => expect(description()).toBe(LOAD_FAILED))
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(optionTexts()).toEqual(['No activity'])
  })
})
