/**
 * @vitest-environment jsdom
 *
 * Component tests for MotivoSuggestField (T13, specs/014-motivo-autocomplete/
 * tasks.md; plan.md "## Test strategy", ui-comp rows). Covers AC-1.1, AC-1.2,
 * AC-1.3, AC-1.5, AC-1.6, AC-1.7, AC-1.8, AC-5.2, AC-5.3, AC-5.5 and AC-5.6,
 * plus design.md's scroll-into-view accessibility requirement, which lives
 * outside the ACs entirely and is unobservable without stubbing the prototype.
 * AC-3.x and the AC-5.3/AC-5.4 Enter PAIR are exercised against the real form
 * in `ExpenseLineComposer.test.tsx`, where a `<form>` actually exists to be
 * submitted.
 *
 * `lib/suggestionsApi` is mocked at module level (the endpoint is
 * `refund-api`'s and needs no live service here) and every test drives the
 * 150 ms corpus debounce with fake timers — the convention
 * `MileageAmountField.test.tsx` already established in this app.
 *
 * The three cases worth naming, because they are the ones a reviewer would
 * otherwise read as gaps:
 *   - "no match", "corpus failed" and "corpus still loading" are asserted to
 *     render IDENTICALLY (design.md S3/S6/S7). That identity is the design,
 *     not an omission.
 *   - Every AC-1.6/AC-5.2 assertion checks for the ABSENCE of a
 *     `role="alert"`/`role="status"` node. A "no suggestions" caption would be
 *     a spec violation.
 *   - The polite live region is asserted EMPTY on no-match, because a spoken
 *     "no suggestions" is AC-1.6's forbidden empty state in the audio channel.
 */

import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import MotivoSuggestField from './MotivoSuggestField'
import ExpenseLineRow from './ExpenseLineRow'
import type { RefundLine } from '../lib/requestsApi'
import type { TripSuggestion } from '../lib/suggestionsApi'
import { getTripSuggestions } from '../lib/suggestionsApi'
import { ApiError } from '../lib/refundApi'
import { formatDate } from '../lib/dates'
import { strings } from '../strings'

vi.mock('../lib/suggestionsApi')

const FIELD_ID = 'composer-motivo'

const trip = (overrides: Partial<TripSuggestion> = {}): TripSuggestion => ({
  motivo: 'Milano → Lugano cliente ACME',
  normalisedMotivo: 'milano → lugano cliente acme',
  km: 62,
  entity: 'welld_ch',
  count: 14,
  lastUsedOn: '2026-07-28',
  ...overrides,
})

const LUGANO = trip()
const MALPENSA = trip({
  motivo: 'Aeroporto Malpensa',
  normalisedMotivo: 'aeroporto malpensa',
  km: 45,
  entity: 'welld_it',
  count: 9,
  lastUsedOn: '2026-06-02',
})
const LUGANO_LONG = trip({
  motivo: 'Lugano fiera',
  normalisedMotivo: 'lugano fiera',
  km: 70,
  count: 2,
  lastUsedOn: '2026-05-01',
})
const LUGANO_STAZIONE = trip({
  motivo: 'Lugano stazione cliente',
  normalisedMotivo: 'lugano stazione cliente',
  km: 58,
  count: 9,
  lastUsedOn: '2026-06-11',
})

/**
 * Three trips sharing `lugano`, so one query can match 3, another 2, another 1
 * and another 0 — the shape the count-ladder and live-region tests need.
 * Ordered as the SERVER would rank them (count desc), since the component must
 * never re-sort.
 */
const LUGANO_CORPUS = [LUGANO, LUGANO_STAZIONE, LUGANO_LONG]

type HarnessProps = {
  enabled?: boolean
  disabled?: boolean
  corpusEpoch?: number
  initialValue?: string
  onPick?: (suggestion: TripSuggestion) => void
}

/**
 * A minimal controlled parent. `onPick` writes the picked motivo back into
 * `value` exactly as `ExpenseLineComposer` does — which is what makes the
 * re-open-after-pick trap reproducible here at all (design.md's "re-open
 * trap": the pick's own value change must NOT clear `suppressed`).
 */
function Harness({ enabled = true, disabled = false, corpusEpoch = 0, initialValue = '', onPick }: HarnessProps) {
  const [value, setValue] = useState(initialValue)
  return (
    <MotivoSuggestField
      id={FIELD_ID}
      value={value}
      onChange={setValue}
      onPick={(suggestion) => {
        setValue(suggestion.motivo)
        onPick?.(suggestion)
      }}
      enabled={enabled}
      disabled={disabled}
      required
      corpusEpoch={corpusEpoch}
    />
  )
}

const input = () => screen.getByTestId(FIELD_ID) as HTMLInputElement
const listbox = () => screen.queryByTestId(`${FIELD_ID}-listbox`)
const options = () => screen.queryAllByRole('option')
const liveRegion = () => screen.getByTestId(`${FIELD_ID}-live`)

/** Runs both the 150 ms fetch debounce and the promise microtasks behind it. */
const settleCorpus = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
}

const type = async (text: string) => {
  fireEvent.change(input(), { target: { value: text } })
  await settleCorpus()
}

const focusAndType = async (text: string) => {
  fireEvent.focus(input())
  await type(text)
}

/** `fireEvent` returns `false` when the handler called `preventDefault()`. */
const pressKey = (key: string): { defaultPrevented: boolean } => ({
  defaultPrevented: !fireEvent.keyDown(input(), { key }),
})

beforeEach(() => {
  vi.useFakeTimers()
  // The automock returns `undefined`, which the component would then `.then()`
  // on — every test states its own corpus explicitly.
  vi.mocked(getTripSuggestions).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

// ── AC-1.1: entirely invisible outside travel_km ──────────────────────────

describe('MotivoSuggestField — disabled for every non-travel_km type (AC-1.1)', () => {
  it('renders an ordinary text input: no combobox roles, no ARIA, no autoComplete override', () => {
    render(<Harness enabled={false} />)

    const field = input()
    expect(field.tagName).toBe('INPUT')
    expect(field.getAttribute('type')).toBe('text')
    expect(field.hasAttribute('role')).toBe(false)
    expect(field.hasAttribute('aria-expanded')).toBe(false)
    expect(field.hasAttribute('aria-controls')).toBe(false)
    expect(field.hasAttribute('aria-autocomplete')).toBe(false)
    expect(field.hasAttribute('aria-activedescendant')).toBe(false)
    // Deliberate: the other eleven expense types keep today's native
    // browser-history dropdown behaviour byte for byte.
    expect(field.hasAttribute('autocomplete')).toBe(false)
    expect(field.required).toBe(true)
  })

  it('never fetches a corpus, however much is typed', async () => {
    render(<Harness enabled={false} />)
    await focusAndType('lugano')

    expect(getTripSuggestions).not.toHaveBeenCalled()
    expect(listbox()).toBeNull()
    expect(options()).toHaveLength(0)
  })

  it('renders the full combobox wiring once enabled (AC-5.6)', () => {
    render(<Harness enabled />)

    const field = input()
    expect(field.getAttribute('role')).toBe('combobox')
    expect(field.getAttribute('aria-expanded')).toBe('false')
    expect(field.getAttribute('aria-controls')).toBe(`${FIELD_ID}-listbox`)
    expect(field.getAttribute('aria-autocomplete')).toBe('list')
    expect(field.getAttribute('autocomplete')).toBe('off')
    expect(field.hasAttribute('aria-activedescendant')).toBe(false)
  })
})

// ── AC-1.2 / plan D6: the lazy, debounced, once-per-epoch corpus fetch ────

describe('MotivoSuggestField — the lazy corpus fetch (AC-1.2, plan D2/D6)', () => {
  it('does NOT fetch merely because the type became travel_km', async () => {
    render(<Harness enabled />)
    fireEvent.focus(input())
    await settleCorpus()

    expect(getTripSuggestions).not.toHaveBeenCalled()
  })

  it('does NOT fetch on the 1st non-whitespace character', async () => {
    render(<Harness enabled />)
    await focusAndType('l')

    expect(getTripSuggestions).not.toHaveBeenCalled()
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('fetches once on the 2nd non-whitespace character and opens the list beneath the field', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO, LUGANO_LONG])
    render(<Harness enabled />)

    await focusAndType('lu')

    expect(getTripSuggestions).toHaveBeenCalledTimes(1)
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(options()).toHaveLength(2)
  })

  it('debounces: three fast keystrokes still produce exactly one request', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    render(<Harness enabled />)
    fireEvent.focus(input())

    fireEvent.change(input(), { target: { value: 'lu' } })
    fireEvent.change(input(), { target: { value: 'lug' } })
    fireEvent.change(input(), { target: { value: 'luga' } })
    await settleCorpus()

    expect(getTripSuggestions).toHaveBeenCalledTimes(1)
  })

  it('narrows further keystrokes in memory — zero additional network calls (plan D2)', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue(LUGANO_CORPUS)
    render(<Harness enabled />)
    await focusAndType('lugano')
    expect(options()).toHaveLength(3)

    await type('lugano f')
    expect(options()).toHaveLength(1)

    await type('lugano')
    expect(options()).toHaveLength(3)
    expect(getTripSuggestions).toHaveBeenCalledTimes(1)
  })

  it('re-fetches on the next threshold crossing after corpusEpoch is bumped (plan D6)', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    const { rerender } = render(<Harness enabled corpusEpoch={0} />)
    await focusAndType('lu')
    expect(getTripSuggestions).toHaveBeenCalledTimes(1)

    // Same epoch, query re-crosses the threshold: still one request.
    await type('')
    await type('lu')
    expect(getTripSuggestions).toHaveBeenCalledTimes(1)

    rerender(<Harness enabled corpusEpoch={1} />)
    await focusAndType('lu')
    expect(getTripSuggestions).toHaveBeenCalledTimes(2)
  })
})

// ── AC-1.3: below the 2-non-whitespace-character threshold ────────────────

describe('MotivoSuggestField — closes below the threshold (AC-1.3)', () => {
  beforeEach(() => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO, LUGANO_LONG])
  })

  it.each([
    ['a single character', 'l'],
    ['an empty field', ''],
    ['whitespace only', '   '],
  ])('closes when the text is reduced to %s', async (_label, next) => {
    render(<Harness enabled />)
    await focusAndType('luga')
    expect(options().length).toBeGreaterThan(0)

    await type(next)

    expect(listbox()).toBeNull()
    expect(options()).toHaveLength(0)
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().value).toBe(next)
  })
})

// ── AC-1.5 / AC-1.7: what a rendered option shows ─────────────────────────

describe('MotivoSuggestField — the rendered list (AC-1.5, AC-1.7)', () => {
  it('shows at most 8 options from a 30-match corpus', async () => {
    const thirty = Array.from({ length: 30 }, (_, i) =>
      trip({ motivo: `Lugano trip ${i}`, normalisedMotivo: `lugano trip ${i}`, count: 30 - i }),
    )
    vi.mocked(getTripSuggestions).mockResolvedValue(thirty)
    render(<Harness enabled />)

    await focusAndType('lugano')

    expect(options()).toHaveLength(8)
  })

  it('exposes all five AC-1.7 facts on the option’s accessible name', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    render(<Harness enabled />)
    await focusAndType('lugano')

    expect(options()[0].getAttribute('aria-label')).toBe(
      strings.components.motivoSuggest.optionLabel(
        LUGANO.motivo,
        LUGANO.km,
        strings.badges.entity[LUGANO.entity],
        LUGANO.count,
        formatDate(LUGANO.lastUsedOn),
      ),
    )
  })

  it('shows the motivo VERBATIM plus km, entity, count and last-used date (AC-1.7, AC-2.5)', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    render(<Harness enabled />)
    await focusAndType('lugano')

    const text = options()[0].textContent ?? ''
    // Never the folded/lower-cased form.
    expect(text).toContain('Milano → Lugano cliente ACME')
    expect(text).not.toContain(LUGANO.normalisedMotivo)
    expect(text).toContain('62 km')
    expect(text).toContain('WellD CH')
    expect(text).toContain(`Used 14× · last ${formatDate(LUGANO.lastUsedOn)}`)
  })

  it('renders the server’s order untouched, so the count ladder is never increasing (AC-1.7)', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue(LUGANO_CORPUS)
    render(<Harness enabled />)
    await focusAndType('lugano')

    expect(options()).toHaveLength(3)
    const counts = options().map((option) => Number(/used (\d+)/.exec(option.getAttribute('aria-label') ?? '')?.[1]))
    expect(counts.length).toBeGreaterThan(1)
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1])
    }
  })

  it('renders options as <li>, never <button> — a <button> in a <form> submits it', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue(LUGANO_CORPUS)
    render(<Harness enabled />)
    await focusAndType('lugano')

    expect(options()).toHaveLength(3)
    for (const option of options()) {
      expect(option.tagName).toBe('LI')
    }
    expect(listbox()!.querySelector('button')).toBeNull()
  })

  it('renders a motivo containing markup as inert text, never as HTML (plan Security §5)', async () => {
    const hostile = trip({
      motivo: '<img src=x onerror="alert(1)"> Lugano',
      normalisedMotivo: '<img src=x onerror="alert(1)"> lugano',
    })
    vi.mocked(getTripSuggestions).mockResolvedValue([hostile])
    render(<Harness enabled />)
    await focusAndType('lugano')

    expect(options()[0].querySelector('img')).toBeNull()
    expect(options()[0].textContent).toContain('<img src=x onerror="alert(1)">')
  })
})

// ── AC-1.6 / AC-5.2: silence, in three indistinguishable flavours ─────────

/** Asserts design.md's S6/S7 rendering: no list, and no message of any kind. */
const expectSilentDegradation = () => {
  expect(listbox()).toBeNull()
  expect(options()).toHaveLength(0)
  expect(input().getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryAllByRole('alert')).toHaveLength(0)
  expect(screen.queryAllByRole('status')).toHaveLength(0)
  // The live region exists (it must be permanently mounted) but says nothing.
  expect(liveRegion().textContent).toBe('')
}

describe('MotivoSuggestField — no match is no list and NO message (AC-1.6)', () => {
  it('renders nothing at all when the corpus loaded but nothing matches', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO, MALPENSA])
    render(<Harness enabled />)

    await focusAndType('xyz')

    expect(getTripSuggestions).toHaveBeenCalledTimes(1)
    expectSilentDegradation()
  })

  it('leaves the field fully editable and never alters or completes the typed text (AC-5.1)', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    render(<Harness enabled />)

    await focusAndType('Trasferta mai fatta prima')

    expect(input().value).toBe('Trasferta mai fatta prima')
    expect(input().readOnly).toBe(false)
    expect(input().disabled).toBe(false)
    expectSilentDegradation()
  })
})

describe('MotivoSuggestField — every corpus failure degrades silently (AC-5.2)', () => {
  it.each([
    ['an ApiError 403 (capability absent)', new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 })],
    [
      'an ApiError 503 (auth outage, fail-closed)',
      new ApiError({ type: 'about:blank', title: 'Service Unavailable', status: 503 }),
    ],
    ['an ApiError 400', new ApiError({ type: 'about:blank', title: 'Bad Request', status: 400 })],
    ['an ApiError 500', new ApiError({ type: 'about:blank', title: 'Internal Server Error', status: 500 })],
    ['a network failure', new TypeError('Failed to fetch')],
    ['an abort', new DOMException('The operation was aborted.', 'AbortError')],
  ])('swallows %s — no banner, no toast, no alert, no list', async (_label, failure) => {
    vi.mocked(getTripSuggestions).mockRejectedValue(failure)
    render(<Harness enabled />)

    await focusAndType('lugano')

    expect(getTripSuggestions).toHaveBeenCalledTimes(1)
    expectSilentDegradation()
    // The field still composes: typing continues to work normally.
    await type('lugano cliente')
    expect(input().value).toBe('lugano cliente')
  })

  it('aborts a request that does not answer within 5 s, and stays silent (AC-5.2)', async () => {
    let captured: AbortSignal | undefined
    vi.mocked(getTripSuggestions).mockImplementation(
      (signal: AbortSignal) =>
        new Promise<TripSuggestion[]>((_resolve, reject) => {
          captured = signal
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    render(<Harness enabled />)

    await focusAndType('lugano')
    expect(captured?.aborted).toBe(false)
    expectSilentDegradation()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(captured?.aborted).toBe(true)
    expectSilentDegradation()
  })

  it('renders identically while the corpus is still in flight (design.md S3 === S6 === S7)', async () => {
    vi.mocked(getTripSuggestions).mockImplementation(() => new Promise<TripSuggestion[]>(() => {}))
    render(<Harness enabled />)

    await focusAndType('lugano')

    expect(getTripSuggestions).toHaveBeenCalledTimes(1)
    expectSilentDegradation()
  })
})

// ── AC-5.3 / AC-5.5: keyboard and dismissal ───────────────────────────────

describe('MotivoSuggestField — keyboard navigation (AC-5.3)', () => {
  beforeEach(() => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO, LUGANO_LONG])
  })

  it('opens with NOTHING highlighted, so Enter is never armed by merely opening (AC-5.4)', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')

    expect(options()).toHaveLength(2)
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false'])
  })

  it('ArrowDown moves the highlight down and clamps at the last option (no wrap)', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')

    expect(pressKey('ArrowDown').defaultPrevented).toBe(true)
    expect(input().getAttribute('aria-activedescendant')).toBe(`${FIELD_ID}-option-0`)
    expect(options()[0].getAttribute('aria-selected')).toBe('true')

    pressKey('ArrowDown')
    expect(input().getAttribute('aria-activedescendant')).toBe(`${FIELD_ID}-option-1`)

    pressKey('ArrowDown')
    expect(input().getAttribute('aria-activedescendant')).toBe(`${FIELD_ID}-option-1`)
  })

  it('ArrowUp walks back to "nothing highlighted" and then no-ops', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')
    pressKey('ArrowDown')

    expect(pressKey('ArrowUp').defaultPrevented).toBe(true)
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)

    pressKey('ArrowUp')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('Home/End jump to the first and last option', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')

    pressKey('End')
    expect(input().getAttribute('aria-activedescendant')).toBe(`${FIELD_ID}-option-1`)
    pressKey('Home')
    expect(input().getAttribute('aria-activedescendant')).toBe(`${FIELD_ID}-option-0`)
  })

  it('resets the highlight to nothing on every query change — a narrowed list is different trips', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')
    pressKey('ArrowDown')
    expect(input().getAttribute('aria-activedescendant')).toBe(`${FIELD_ID}-option-0`)

    await type('lugano ')

    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('Enter on a highlighted option picks it, and PREVENTS the event’s default (the Enter trap)', async () => {
    const onPick = vi.fn()
    render(<Harness enabled onPick={onPick} />)
    await focusAndType('lugano')
    pressKey('ArrowDown')

    const { defaultPrevented } = pressKey('Enter')

    expect(defaultPrevented).toBe(true)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(LUGANO)
  })

  it('Enter with NOTHING highlighted picks nothing and does NOT touch the event (AC-5.4)', async () => {
    const onPick = vi.fn()
    render(<Harness enabled onPick={onPick} />)
    await focusAndType('lugano')

    const { defaultPrevented } = pressKey('Enter')

    expect(defaultPrevented).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('clicking an option picks it', async () => {
    const onPick = vi.fn()
    render(<Harness enabled onPick={onPick} />)
    await focusAndType('lugano')

    fireEvent.click(options()[1])

    expect(onPick).toHaveBeenCalledWith(LUGANO_LONG)
  })

  it('hovering an option does NOT arm Enter (deliberate divergence from admin-ui/Combobox)', async () => {
    const onPick = vi.fn()
    render(<Harness enabled onPick={onPick} />)
    await focusAndType('lugano')

    fireEvent.mouseEnter(options()[1])

    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
    expect(pressKey('Enter').defaultPrevented).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('Escape closes the list, leaves the typed text byte-identical, and is not swallowed when closed', async () => {
    render(<Harness enabled />)
    await focusAndType('  Lugàno  ')
    expect(options().length).toBeGreaterThan(0)

    expect(pressKey('Escape').defaultPrevented).toBe(true)

    expect(listbox()).toBeNull()
    expect(input().value).toBe('  Lugàno  ')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)

    // Nothing to dismiss any more — Escape must fall through to the page.
    expect(pressKey('Escape').defaultPrevented).toBe(false)
  })

  it('re-opens after Escape on the next keystroke, and on an explicit ArrowDown', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')
    pressKey('Escape')
    expect(listbox()).toBeNull()

    await type('lugano ')
    expect(listbox()).not.toBeNull()

    pressKey('Escape')
    expect(listbox()).toBeNull()
    expect(pressKey('ArrowDown').defaultPrevented).toBe(true)
    expect(listbox()).not.toBeNull()
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
  })
})

// ── design.md "Focus management": scroll the active option into view ──────

/**
 * `Element.prototype.scrollIntoView`'s property descriptor as it stands BEFORE
 * this file stubs anything — captured at module scope, so it is by construction
 * the pristine one. `undefined` under today's jsdom, which implements no layout
 * and therefore no `scrollIntoView` at all.
 *
 * Restoring to exactly this (rather than to whatever was there at
 * `beforeEach` time) is what makes the stub un-leakable: a prototype patch that
 * outlived this file would silently change every suite that ran after it, and
 * this repo already carries cross-file mock-pollution failures elsewhere.
 */
const PRISTINE_SCROLL_INTO_VIEW = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

/**
 * `aria-activedescendant` moves the highlight WITHOUT moving DOM focus — and a
 * browser does not scroll a popup for it. design.md's Accessibility §
 * ("Scroll-into-view") therefore requires an explicit
 * `scrollIntoView({ block: 'nearest' })` on every change of the active option:
 * the popup is `max-height: min(18rem, 50vh)`, ~5 of its maximum 8 rows, so
 * without this ArrowDown past the 5th row moves an INVISIBLE highlight — and
 * Enter then picks a trip the employee never saw, which sets km, and km is
 * money.
 *
 * jsdom no-ops the whole behaviour (the method does not exist), and the e2e
 * only ever renders 2 options, so the popup never scrolls there either. Stubbing
 * the prototype is the only level at which this is observable at all.
 */
describe('MotivoSuggestField — the active option is scrolled into view (design.md a11y)', () => {
  /** One entry per call, in order: which element scrolled, and with what. */
  let scrolls: { id: string; options: unknown }[]

  beforeEach(() => {
    // Eight matches — AC-1.5's maximum, i.e. exactly the case that overflows
    // the popup's max-height and so actually needs scrolling.
    vi.mocked(getTripSuggestions).mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        trip({ motivo: `Lugano trip ${i}`, normalisedMotivo: `lugano trip ${i}`, count: 8 - i }),
      ),
    )

    scrolls = []
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      // A `function`, not an arrow: `this` is the element the component called
      // it on, which is the half of the contract that proves the RIGHT row
      // scrolled rather than merely that some row did.
      value: vi.fn(function (this: Element, options: unknown) {
        scrolls.push({ id: this.id, options })
      }),
    })
  })

  afterEach(() => {
    if (PRISTINE_SCROLL_INTO_VIEW) {
      Object.defineProperty(Element.prototype, 'scrollIntoView', PRISTINE_SCROLL_INTO_VIEW)
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  it('scrolls each newly highlighted option into view with block: "nearest"', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')
    expect(options()).toHaveLength(8)

    // Opening highlights nothing (AC-5.4), so it scrolls nothing either.
    expect(scrolls).toEqual([])

    pressKey('ArrowDown')
    pressKey('ArrowDown')
    pressKey('ArrowDown')

    expect(scrolls).toEqual([
      { id: `${FIELD_ID}-option-0`, options: { block: 'nearest' } },
      { id: `${FIELD_ID}-option-1`, options: { block: 'nearest' } },
      { id: `${FIELD_ID}-option-2`, options: { block: 'nearest' } },
    ])
    // The scrolled element is the one the input points a11y at — the same
    // assertion the keyboard tests make, tied here to the scroll target.
    expect(input().getAttribute('aria-activedescendant')).toBe(`${FIELD_ID}-option-2`)
  })

  it('scrolls the last option into view on End, and the first on Home', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')

    pressKey('End')
    pressKey('Home')

    expect(scrolls).toEqual([
      { id: `${FIELD_ID}-option-7`, options: { block: 'nearest' } },
      { id: `${FIELD_ID}-option-0`, options: { block: 'nearest' } },
    ])
  })

  it('does NOT scroll when the active option does not change (ArrowDown clamped at the end)', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')

    pressKey('End')
    expect(scrolls).toEqual([{ id: `${FIELD_ID}-option-7`, options: { block: 'nearest' } }])

    // All three are no-ops on the active index: ArrowDown clamps at the last
    // option (no wrap), End is already there, and hovering deliberately never
    // sets `active`.
    pressKey('ArrowDown')
    pressKey('End')
    fireEvent.mouseEnter(options()[3])

    expect(scrolls).toHaveLength(1)
  })

  it('does NOT scroll when the highlight returns to nothing, or when the list is dismissed', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')

    pressKey('ArrowDown')
    expect(scrolls).toHaveLength(1)

    // Back to "nothing highlighted" — there is no option to scroll to.
    pressKey('ArrowUp')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
    expect(scrolls).toHaveLength(1)

    pressKey('ArrowDown')
    expect(scrolls).toHaveLength(2)

    // Escape closes the list; a closed popup is never scrolled.
    pressKey('Escape')
    expect(listbox()).toBeNull()
    expect(scrolls).toHaveLength(2)
  })
})

describe('MotivoSuggestField — the re-open trap after a pick (AC-3.5)', () => {
  beforeEach(() => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO, LUGANO_LONG])
  })

  it('stays closed on the motivo the pick just wrote, even though it qualifies and matches itself', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')

    fireEvent.click(options()[0])
    await settleCorpus()

    expect(input().value).toBe(LUGANO.motivo)
    expect(listbox()).toBeNull()
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(liveRegion().textContent).toBe('')
  })

  it('re-opens on the employee’s NEXT keystroke — suppression is cleared only by typing', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')
    fireEvent.click(options()[0])
    await settleCorpus()
    expect(listbox()).toBeNull()

    await type(`${LUGANO.motivo} `)

    expect(listbox()).not.toBeNull()
  })
})

describe('MotivoSuggestField — focus leaving closes the list (AC-5.5)', () => {
  beforeEach(() => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO, LUGANO_LONG])
  })

  it('blurring to another control closes it and leaves the text unchanged', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')
    expect(listbox()).not.toBeNull()

    fireEvent.blur(input())

    expect(listbox()).toBeNull()
    expect(input().value).toBe('lugano')
  })

  it('re-focusing re-opens it — a blur does not suppress, so an accidental click-away is recoverable', async () => {
    render(<Harness enabled />)
    await focusAndType('lugano')
    fireEvent.blur(input())
    expect(listbox()).toBeNull()

    fireEvent.focus(input())

    expect(listbox()).not.toBeNull()
  })

  it('a pointerdown outside the wrapper closes it, and one inside does not', async () => {
    render(
      <div>
        <Harness enabled />
        <button type="button" data-testid="outside">
          elsewhere
        </button>
      </div>,
    )
    await focusAndType('lugano')

    fireEvent.pointerDown(screen.getByTestId(`${FIELD_ID}-option-0`))
    expect(listbox()).not.toBeNull()

    fireEvent.pointerDown(screen.getByTestId('outside'))

    expect(listbox()).toBeNull()
    expect(input().value).toBe('lugano')
  })

  it('never selects on Tab — it closes and lets focus move on', async () => {
    const onPick = vi.fn()
    render(<Harness enabled onPick={onPick} />)
    await focusAndType('lugano')
    pressKey('ArrowDown')

    expect(pressKey('Tab').defaultPrevented).toBe(false)
    fireEvent.blur(input())

    expect(onPick).not.toHaveBeenCalled()
    expect(listbox()).toBeNull()
    expect(input().value).toBe('lugano')
  })
})

// ── AC-5.6: the polite live region ────────────────────────────────────────

describe('MotivoSuggestField — the polite live region (AC-5.6)', () => {
  it('is always mounted, so its content is reliably announced when it arrives', () => {
    render(<Harness enabled={false} />)
    expect(liveRegion()).not.toBeNull()
    expect(liveRegion().getAttribute('aria-live')).toBe('polite')
    expect(liveRegion().textContent).toBe('')
  })

  it('announces the available count, and tracks it as the count changes', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue(LUGANO_CORPUS)
    render(<Harness enabled />)

    await focusAndType('lugano')
    expect(liveRegion().textContent).toBe('3 suggestions available')

    await type('cliente')
    expect(liveRegion().textContent).toBe('2 suggestions available')

    await type('lugano f')
    expect(liveRegion().textContent).toBe('1 suggestion available')
  })

  it('says NOTHING on no-match — a spoken "no suggestions" is AC-1.6’s forbidden empty state in audio', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    render(<Harness enabled />)

    await focusAndType('lugano')
    expect(liveRegion().textContent).toBe('1 suggestion available')

    await type('lugano zzz')

    expect(liveRegion().textContent).toBe('')
  })

  it('says nothing below the threshold, or after a corpus failure', async () => {
    vi.mocked(getTripSuggestions).mockRejectedValue(new TypeError('Failed to fetch'))
    render(<Harness enabled />)

    await focusAndType('l')
    expect(liveRegion().textContent).toBe('')

    await type('lugano')
    expect(liveRegion().textContent).toBe('')
  })

  it('never announces the option text itself — aria-activedescendant already does', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    render(<Harness enabled />)
    await focusAndType('lugano')
    pressKey('ArrowDown')

    expect(liveRegion().textContent).not.toContain(LUGANO.motivo)
    expect(liveRegion().textContent).toBe('1 suggestion available')
  })
})

// ── S11: submitting ───────────────────────────────────────────────────────

describe('MotivoSuggestField — while the composer is submitting (design.md S11)', () => {
  it('forces the list closed and issues no fetch', async () => {
    vi.mocked(getTripSuggestions).mockResolvedValue([LUGANO])
    const { rerender } = render(<Harness enabled />)
    await focusAndType('lugano')
    expect(listbox()).not.toBeNull()

    rerender(<Harness enabled disabled initialValue="lugano" />)
    await settleCorpus()

    expect(listbox()).toBeNull()
    expect(input().disabled).toBe(true)
  })
})

// ── AC-1.8: the in-place row editor is untouched, structurally ────────────

describe('AC-1.8 — ExpenseLineRow’s in-place Motivo editor gains nothing', () => {
  const mileageLine: RefundLine = {
    id: 'line-1',
    date: '2026-07-01',
    type: 'travel_km',
    motivo: 'Client visit',
    entity: 'welld_ch',
    currency: 'CHF',
    requestedAmountCents: 16800,
    km: 240,
    approvedTotalCents: null,
    attachments: [],
  }

  it('renders a plain input and requests no suggestions when its Motivo is typed into', async () => {
    render(
      <ExpenseLineRow
        line={mileageLine}
        mode="edit"
        onCommit={vi.fn()}
        onDelete={vi.fn()}
        onDownloadAttachment={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('row-line-1-edit'))

    const rowMotivo = screen.getByTestId('row-line-1-motivo')
    fireEvent.focus(rowMotivo)
    fireEvent.change(rowMotivo, { target: { value: 'Lugano cliente' } })
    await settleCorpus()

    expect(getTripSuggestions).not.toHaveBeenCalled()
    expect(rowMotivo.hasAttribute('role')).toBe(false)
    expect(rowMotivo.hasAttribute('aria-expanded')).toBe(false)
    expect(rowMotivo.hasAttribute('aria-autocomplete')).toBe(false)
    expect(screen.queryByRole('listbox')).toBeNull()
    // Queried by ATTRIBUTE, not by role: the row's own `<select>`s contribute
    // native `<option>` elements, which carry the implicit `option` role.
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0)
  })
})

// ── Teardown contract for the one prototype patch this file installs ──────

/**
 * Declared LAST so it runs after the scroll-into-view suite has torn down (this
 * project runs a file's tests in declaration order — no `sequence.shuffle`).
 * It can never false-fail if that order ever changed: run first, it observes the
 * same pristine descriptor it compares against.
 *
 * Worth its own test rather than an `expect` in `afterEach`: `Element.prototype`
 * is shared by every suite in the run, and a leaked stub is precisely the
 * cross-file pollution class that already produces failures elsewhere in this
 * repo.
 */
describe('MotivoSuggestField — the scrollIntoView stub does not leak (test hygiene)', () => {
  it('leaves Element.prototype.scrollIntoView exactly as it found it', () => {
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')).toEqual(PRISTINE_SCROLL_INTO_VIEW)
  })
})
