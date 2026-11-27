/**
 * @vitest-environment jsdom
 *
 * ConsumptionBar (specs/20261112-project-hours US-5: AC-5.10, AC-5.11, AC-5.14–5.18; design S1.1 "The bar", plan D-P8): the
 * drawing of a share — a track on a 0–125 % scale, a fill, the beyond-100 % part, two ticks, a today mark and an estimate mark.
 * It computes nothing: every position is `share.bar`. It is `aria-hidden` (the lines say what it shows), carries no figure
 * the lines do not state, and has no tab stop. jsdom has no layout and no stylesheet, so what is asserted here is the
 * structure, the positions given to `style`, and the complete token class strings; how it looks is the browser's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { Share } from '../lib/consumption'
import ConsumptionBar from './ConsumptionBar'

afterEach(cleanup)

type Bar = Share['bar']

/** A share as `consumptionOf` hands it; only what the bar reads matters (`state` for the tone, `bar` for the positions). */
const share = (bar: Partial<Bar> = {}, state: Share['state'] = 'on_track', consumedPercent = 50): Share => ({
  consumedPercent,
  state,
  excess: null,
  elapsedPercent: null,
  bar: { within: 40, beyond: 0, estimate: null, today: null, ...bar },
})

const mount = (value: Share) => render(<ConsumptionBar share={value} />)

const root = () => screen.getByTestId('project-hours-consumption-bar')
const track = () => screen.getByTestId('project-hours-consumption-bar-track')
const fill = () => screen.queryByTestId('project-hours-consumption-bar-fill')
const beyond = () => screen.queryByTestId('project-hours-consumption-bar-beyond')
const estimate = () => screen.queryByTestId('project-hours-consumption-bar-estimate')
const today = () => screen.queryByTestId('project-hours-consumption-bar-today')
const ticks = () => screen.queryAllByTestId('project-hours-consumption-bar-tick')

const classes = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/)

describe('the root: a drawing the lines repeat (AC-5.11, D-P8)', () => {
  it('is hidden from assistive technology, takes no focus and has no role, title or tooltip', () => {
    mount(share({ today: 30, estimate: 66.67 }))

    expect(root().getAttribute('aria-hidden')).toBe('true')
    expect(root().hasAttribute('tabindex')).toBe(false)
    expect(root().hasAttribute('role')).toBe(false)
    expect(root().querySelector('[tabindex], [title], [role], a, button, input')).toBeNull()
  })

  it('says only the labels of the scale when there is no mark to name: "80%", "100%" and "125%", from the formatter', () => {
    mount(share())

    expect(root().textContent).toBe('80%100%125%')
  })

  it('adds "Today" only with a today mark, and "Estimate" only with an estimate mark', () => {
    const view = mount(share({ today: 30 }))
    expect(root().textContent).toBe('Today80%100%125%')
    view.unmount()

    const second = mount(share({ estimate: 66.67 }))
    expect(root().textContent).toBe('80%100%125%Estimate')
    second.unmount()

    mount(share({ today: 30, estimate: 66.67 }))
    expect(root().textContent).toBe('Today80%100%125%Estimate')
  })

  it('never says the consumed percentage, an excess, a day count or a date, whatever the share holds', () => {
    mount(share({ within: 80, beyond: 20, today: 80, estimate: 40 }, 'over', 117))

    const text = root().textContent ?? ''
    expect(text).not.toContain('117')
    expect(text).not.toMatch(/\d{4}|\bdays?\b|\bover\b|\bby\b/i)
    expect(text).toBe('Today80%100%125%Estimate')
  })

  it('holds no colour and no figure in `style`: only widths and positions in percent', () => {
    mount(share({ within: 63.5, beyond: 12, today: 30, estimate: 66.67 }, 'over', 117))

    const styles = Array.from(root().querySelectorAll('[style]')).map((element) => element.getAttribute('style') ?? '')
    expect(styles.length).toBeGreaterThan(0)
    for (const style of styles) {
      expect(style).toMatch(/^(?:(?:width|left): [\d.]+%;? ?)+$/)
    }
  })
})

describe('the track and the fill (AC-5.14, AC-5.16)', () => {
  it('draws the track row 10 px high (h-2.5) with a surface, so the fill, the beyond part and the marks have a height', () => {
    mount(share())

    expect(classes(track())).toContain('h-2.5')
    expect(classes(track())).toContain('relative')
    expect(track().querySelector('.bg-ink.ring-dim')).not.toBeNull()
  })

  it.each([
    [0, null],
    [40, '40%'],
    [63.5, '63.5%'],
    [80, '80%'],
  ])('a share whose within is %s fills %s of the track', (within, width) => {
    mount(share({ within }))

    if (width === null) {
      expect(fill()).toBeNull()
    } else {
      expect(fill()?.style.width).toBe(width)
      expect(fill()?.style.left).toBe('')
      expect(track().contains(fill())).toBe(true)
    }
  })

  it('draws no beyond part at exactly the reference (beyond 0), whatever the fill', () => {
    mount(share({ within: 80, beyond: 0 }, 'over', 100))

    expect(beyond()).toBeNull()
    expect(fill()?.style.width).toBe('80%')
  })

  it.each([
    [0.4, '0.4%'],
    [12, '12%'],
    [20, '20%'],
  ])(
    'draws the part beyond the 100 %% mark as an element of its own, from 80 %% of the track, %s wide',
    (value, width) => {
      mount(share({ within: 80, beyond: value }, 'over', 117))

      expect(beyond()).not.toBeNull()
      expect(beyond()?.style.left).toBe('80%')
      expect(beyond()?.style.width).toBe(width)
      expect(beyond()).not.toBe(fill())
      expect(track().contains(beyond())).toBe(true)
    },
  )

  it('fills to the end of the track at 125 % and beyond, nothing cut: the fill is 80 and the beyond part 20', () => {
    mount(share({ within: 80, beyond: 20 }, 'over', 180))

    expect(fill()?.style.width).toBe('80%')
    expect(beyond()?.style.width).toBe('20%')
    expect(Number.parseFloat(beyond()!.style.left) + Number.parseFloat(beyond()!.style.width)).toBe(100)
  })
})

describe('the tone is the state said, and no state is neutral (AC-5.10, AC-5.25, AC-5.26; design G10, D96)', () => {
  it.each([
    ['on_track', 'bg-acc-solid'],
    ['close_to_limit', 'bg-org'],
    ['over', 'bg-red'],
    [null, 'bg-soft'],
  ] as const)('a share whose state is %s fills with %s', (state, fillClass) => {
    mount(share({ within: 50 }, state))

    expect(classes(fill())).toContain(fillClass)
    // One tone and no other: a status is never a class built from a name.
    const tones = ['bg-acc-solid', 'bg-org', 'bg-red', 'bg-soft'].filter((name) => classes(fill()).includes(name))
    expect(tones).toEqual([fillClass])
  })

  it('stripes the beyond part in the red of the over state: complete classes, vertical hard stops of 6 px', () => {
    mount(share({ within: 80, beyond: 10 }, 'over', 112))

    expect(classes(beyond())).toEqual(
      expect.arrayContaining([
        'bg-linear-90',
        'from-red',
        'from-50%',
        'to-transparent',
        'to-50%',
        'bg-size-[6px_100%]',
      ]),
    )
    expect(classes(beyond())).not.toContain('bg-red')
  })

  it('stripes the beyond part in the neutral when no state is said (an expired package, a closed project), never in red', () => {
    mount(share({ within: 80, beyond: 10 }, null, 117))

    expect(classes(fill())).toContain('bg-soft')
    expect(classes(beyond())).toEqual(
      expect.arrayContaining([
        'bg-linear-90',
        'from-soft',
        'from-50%',
        'to-transparent',
        'to-50%',
        'bg-size-[6px_100%]',
      ]),
    )
    expect(classes(beyond())).not.toContain('from-red')
    expect(classes(fill())).not.toContain('bg-red')
  })

  it('draws the beyond part as stripes against a solid fill: told apart by shape, not by colour alone (AC-5.15)', () => {
    mount(share({ within: 80, beyond: 10 }, 'over', 112))

    expect(classes(fill())).not.toContain('bg-linear-90')
    expect(classes(beyond())).toContain('bg-linear-90')
    expect(classes(beyond())).not.toContain('bg-red')
  })
})

describe('the ticks, the today mark and the estimate mark (AC-5.14, AC-5.17, AC-5.18)', () => {
  it('draws a tick at 64 %, 80 % and 100 % of the bar: 80 % and 100 % of the reference, and the end of the scale', () => {
    mount(share())

    expect(ticks().map((tick) => tick.style.left)).toEqual(['64%', '80%', '100%'])
    // 16 px through and below the 10 px track, in two tones so it reads over a fill.
    for (const tick of ticks())
      expect(classes(tick)).toEqual(expect.arrayContaining(['h-4', 'w-0.5', 'bg-soft', 'ring-ink']))
  })

  it('labels the three ticks: "80%" under the first, "100%" under the second, "125%" ending at the third', () => {
    mount(share())

    const label = (text: string) => within(root()).getByText(text)
    expect(label('80%').style.left).toBe('64%')
    expect(label('100%').style.left).toBe('80%')
    expect(label('125%').style.left).toBe('100%')
    expect(classes(label('80%'))).toContain('-translate-x-1/2')
    expect(classes(label('100%'))).toContain('-translate-x-1/2')
    expect(classes(label('125%'))).toContain('-translate-x-full')
    expect(classes(label('80%'))).toEqual(expect.arrayContaining(['font-mono', 'text-2xs', 'text-soft']))
  })

  // Found rendering it (specs/20261112-project-hours T24): the shell keeps its 64 px rail at every width, so the card's inner width
  // is 205 px at 360 and about 165 px at 320, not the 274 and 234 the design counted, and "100%" and "125%" touch below ~215 px.
  it('hides the "125%" label when the bar itself is narrower than 230 px, by a container query on its own width (not the screen\'s)', () => {
    mount(share())

    expect(classes(root())).toContain('@container')
    expect(classes(within(root()).getByText('125%'))).toContain('@max-[230px]:hidden')
    // The two that name the thresholds the state words stand for stay, whatever the width.
    for (const label of ['80%', '100%']) {
      expect(classes(within(root()).getByText(label)).some((name) => name.includes('hidden'))).toBe(false)
    }
  })

  it('draws no today mark and no label without one', () => {
    mount(share({ today: null }))

    expect(today()).toBeNull()
    expect(screen.queryByText('Today')).toBeNull()
  })

  it('puts the today mark at share.bar.today, a line through the track, and names it "Today" at the same position', () => {
    mount(share({ today: 36 }))

    expect(today()?.style.left).toBe('36%')
    expect(classes(today())).toEqual(expect.arrayContaining(['bg-text', 'ring-ink', '-top-1.5', 'h-4', 'w-0.5']))
    expect(track().contains(today())).toBe(true)
    const label = within(root()).getByText('Today')
    expect(label.style.left).toBe('36%')
    expect(classes(label)).toEqual(expect.arrayContaining(['font-mono', 'text-2xs', 'text-text', 'bottom-1']))
  })

  it.each([
    [0, false],
    [7.9, false],
    [8, true],
    [40, true],
    [80, true],
  ])(
    'a today mark at %s: its label is %s-centred (start-aligned below 8, so it stays inside a narrow bar)',
    (position, centred) => {
      mount(share({ today: position }))

      expect(classes(within(root()).getByText('Today')).includes('-translate-x-1/2')).toBe(centred)
    },
  )

  it('draws no estimate mark and no label without one', () => {
    mount(share({ estimate: null }))

    expect(estimate()).toBeNull()
    expect(screen.queryByText('Estimate')).toBeNull()
  })

  it('puts the estimate diamond at share.bar.estimate: 8 px (size-2), turned 45 degrees, ringed, on the track', () => {
    mount(share({ estimate: 66.67 }))

    expect(estimate()?.style.left).toBe('66.67%')
    expect(classes(estimate())).toEqual(
      expect.arrayContaining([
        'size-2',
        'rotate-45',
        'bg-text',
        'ring-1',
        'ring-ink',
        'top-1/2',
        '-translate-x-1/2',
        '-translate-y-1/2',
      ]),
    )
    expect(track().contains(estimate())).toBe(true)
  })

  it('names the estimate one row below the scale, with the same diamond as a key, tied to the mark by shape and by position', () => {
    mount(share({ estimate: 66.67 }))

    const label = within(root()).getByText('Estimate')
    const row = label.closest('[style]') as HTMLElement
    expect(row.style.left).toBe('66.67%')
    expect(classes(row)).toEqual(expect.arrayContaining(['font-mono', 'text-2xs', 'text-text']))
    const key = row.querySelector('.rotate-45')
    expect(key).not.toBeNull()
    expect(classes(key)).toEqual(expect.arrayContaining(['inline-block', 'size-2', 'bg-text', 'ring-1', 'ring-ink']))
    // No leader line: nothing joins the label to the mark.
    expect(root().querySelectorAll('[class*="border-l"], hr, svg')).toHaveLength(0)
  })

  it.each([
    [0, 'start'],
    [13.9, 'start'],
    [14, 'centre'],
    [66.67, 'centre'],
    [86, 'centre'],
    [86.1, 'end'],
    [100, 'end'],
  ])(
    'an estimate at %s: its label is %s-aligned, so a 63 px label stays inside a 234 px bar',
    (position, alignment) => {
      mount(share({ estimate: position }))

      const row = within(root()).getByText('Estimate').closest('[style]') as HTMLElement
      const expected = { start: [], centre: ['-translate-x-1/2'], end: ['-translate-x-full'] }[alignment]
      const alignments = ['-translate-x-1/2', '-translate-x-full'].filter((name) => classes(row).includes(name))
      expect(alignments).toEqual(expected)
    },
  )

  it('keeps every row in the order of the drawing: today label, track, scale labels, estimate label', () => {
    mount(share({ today: 30, estimate: 50 }))

    const order = [
      within(root()).getByText('Today'),
      track(),
      within(root()).getByText('100%'),
      within(root()).getByText('Estimate'),
    ]
    for (let index = 0; index < order.length - 1; index += 1) {
      expect(order[index]!.compareDocumentPosition(order[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })
})

describe('nothing is computed here', () => {
  it('draws exactly what share.bar says and nothing from the percentage: the same bar for any consumedPercent', () => {
    const view = mount(share({ within: 40 }, 'on_track', 50))
    const first = view.container.innerHTML
    view.unmount()

    const second = mount(share({ within: 40 }, 'on_track', 99))
    expect(second.container.innerHTML).toBe(first)
  })
})
