/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('shell/session', () => ({
  apiFetch: vi.fn(),
  getMeetingsApiBaseUrl: vi.fn(() => 'http://meetings-api.test'),
  getAuthBaseUrl: vi.fn(() => 'http://auth.test'),
}))

import { apiFetch } from 'shell/session'
import type { Meeting } from '../../lib/types'
import { en } from '../../strings'
import { CAN_CREATOR_DRAFT, fakeApi, meeting, problem, readyMeeting } from '../../test-support/fakeApi'
import type { FakeHandler } from '../../test-support/fakeApi'
import TextCard from './TextCard'

const t = en.text
const MAX = 200_000

/** A text meeting as its creator sees it: no consent, none needed. */
const textMeeting = (overrides: Partial<Meeting> = {}) => meeting({ source: 'text', consent: null, ...overrides })

let requests: Array<{ line: string; body: unknown }>

const install = (routes: Record<string, FakeHandler> = {}) => {
  requests = []
  const note =
    (handler: FakeHandler): FakeHandler =>
    (url, init, params) => {
      requests.push({
        line: `${init?.method ?? 'GET'} ${url.pathname}`,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return handler(url, init, params)
    }
  vi.mocked(apiFetch).mockImplementation(
    fakeApi({
      'PUT /meetings/m1/text': note(() => ({ status: 200, body: readyMeeting({ source: 'text', consent: null }) })),
      ...Object.fromEntries(Object.entries(routes).map(([key, handler]) => [key, note(handler)])),
    }),
  )
}

const renderCard = (m: Meeting = textMeeting()) => {
  const onChanged = vi.fn()
  return { onChanged, ...render(<TextCard meeting={m} onChanged={onChanged} />) }
}

const field = () => screen.getByRole('textbox', { name: t.label }) as HTMLTextAreaElement
const save = () => screen.getByRole('button', { name: t.save })
const count = () => screen.getByTestId('meetings-text-count').textContent
const setText = (value: string) => fireEvent.change(field(), { target: { value } })

beforeEach(() => install())
afterEach(cleanup)

describe('what is shown (AC-3.4)', () => {
  it('is a labelled text field with a live character count and one Save', () => {
    renderCard()
    expect(screen.getByRole('heading', { name: t.title })).not.toBeNull()
    expect(field()).not.toBeNull()
    expect(screen.getByText(t.hint)).not.toBeNull()
    expect(count()).toBe(t.count('0', '200,000'))
    expect(save()).not.toBeNull()
  })

  it('asks for no consent: no checkbox, no confirmation step, even though the meeting has no attestation', () => {
    renderCard(textMeeting({ consent: null }))
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText(/consent/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /continue|confirm/i })).toBeNull()
    expect(field().disabled).toBe(false)
  })

  it('offers nothing to someone who may not capture', () => {
    const { container } = renderCard(textMeeting({ can: { ...CAN_CREATOR_DRAFT, capture: false } }))
    expect(container.textContent).toBe('')
  })

  it('counts as you type, grouped like every figure in the suite', async () => {
    renderCard()
    await userEvent.setup().type(field(), 'hello')
    expect(count()).toBe(t.count('5', '200,000'))
    setText('x'.repeat(12_345))
    expect(count()).toBe(t.count('12,345', '200,000'))
  })
})

describe('the limit: 200,000 characters', () => {
  it('saves exactly 200,000 characters as typed', async () => {
    const { onChanged } = renderCard()
    const text = 'a'.repeat(MAX)
    setText(text)
    expect(screen.queryByText(t.errors.tooLong('200,000'))).toBeNull()
    await userEvent.setup().click(save())
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' })))
    expect(requests).toEqual([{ line: 'PUT /meetings/m1/text', body: { text } }])
  })

  it('refuses 200,001 at once, naming the limit, and sends nothing', async () => {
    const { onChanged } = renderCard()
    setText('a'.repeat(MAX + 1))
    expect(screen.getByText(t.errors.tooLong('200,000'))).not.toBeNull()
    expect(count()).toBe(t.count('200,001', '200,000'))
    expect(field().getAttribute('aria-invalid')).toBe('true')

    await userEvent.setup().click(save())
    expect(requests).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()

    // Back under the limit: the complaint goes and Save works.
    setText('a'.repeat(MAX))
    expect(screen.queryByText(t.errors.tooLong('200,000'))).toBeNull()
    expect(field().getAttribute('aria-invalid')).toBeNull()
  })

  it('an empty text, or only spaces and line breaks, is refused with its own message', async () => {
    const { onChanged } = renderCard()
    const user = userEvent.setup()
    await user.click(save())
    expect(screen.getByText(t.errors.empty)).not.toBeNull()
    setText('  \n\t ')
    await user.click(save())
    expect(screen.getByText(t.errors.empty)).not.toBeNull()
    expect(requests).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()

    // Typing clears the complaint.
    await user.type(field(), 'x')
    expect(screen.queryByText(t.errors.empty)).toBeNull()
  })
})

describe('saving', () => {
  it('hands the page the ready meeting; double activation sends one request', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    install({
      'PUT /meetings/m1/text': async () => {
        await gate
        return { status: 200, body: readyMeeting({ source: 'text', consent: null }) }
      },
    })
    const { onChanged } = renderCard()
    setText('Notes from the call.')
    const user = userEvent.setup()
    await user.click(save())
    // In flight: busy, the text cannot be edited, a second click does nothing.
    expect(screen.getByRole('button', { name: t.saving }).getAttribute('aria-busy')).toBe('true')
    expect(field().readOnly).toBe(true)
    await user.click(screen.getByRole('button', { name: t.saving }))
    release()

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(requests).toHaveLength(1)
  })

  it('a field error from the server is shown on the text field', async () => {
    install({
      'PUT /meetings/m1/text': () => ({
        status: 422,
        body: problem(422, undefined, {
          field: 'text',
          errors: [{ field: 'text', message: 'Text must be 1 to 200,000 characters' }],
        }),
      }),
    })
    const { onChanged } = renderCard()
    setText('x')
    await userEvent.setup().click(save())
    expect((await screen.findByText('Text must be 1 to 200,000 characters')).className).toContain('field-error')
    expect(onChanged).not.toHaveBeenCalled()
    expect(save().hasAttribute('disabled')).toBe(false)
  })

  it('any other failure is shown, the text is kept, and Save can be tried again', async () => {
    install({ 'PUT /meetings/m1/text': () => ({ status: 409, body: problem(409, 'frozen') }) })
    const { onChanged } = renderCard()
    setText('Do not lose this.')
    await userEvent.setup().click(save())
    expect((await screen.findByRole('alert')).textContent).toContain(en.common.errors.frozen)
    expect(field().value).toBe('Do not lose this.')
    expect(field().readOnly).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('a network failure says so and keeps the text', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'))
    renderCard()
    setText('Still here.')
    await userEvent.setup().click(save())
    expect((await screen.findByRole('alert')).textContent).toContain(en.common.networkError)
    expect(field().value).toBe('Still here.')
  })
})

describe('accessibility', () => {
  it('has no axe violation: empty, over the limit, and with a failure', async () => {
    const { container } = renderCard()
    const check = async () =>
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      )
    expect(await check()).toEqual([])
    setText('a'.repeat(MAX + 1))
    expect(await check()).toEqual([])
    install({ 'PUT /meetings/m1/text': () => ({ status: 503, body: problem(503) }) })
    setText('fine')
    await userEvent.setup().click(save())
    await screen.findByRole('alert')
    expect(await check()).toEqual([])
  })
})
