import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Icon, ICON_NAMES } from '../components/Icon'
import { STATUS, StatusBadge } from '../components/StatusBadge'
import { Tabs, tabPanelProps } from '../components/Tabs'
import {
  formatAmount,
  formatDate,
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatNumber,
  formatRelative,
} from './format'
import { catalogGaps, resolveLocale, selectStrings } from './i18n'

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
  vi.unstubAllGlobals()
})

describe('formatters', () => {
  it('shows numeric dates as day.month.year in both languages, never shifting a date-only value', () => {
    expect(formatDate('2026-10-31')).toBe('31.10.2026')
    expect(formatDate('2026-01-01')).toBe('01.01.2026')
    expect(formatDateTime(new Date(2026, 9, 31, 9, 5))).toBe('31.10.2026 09:05')
  })

  it('writes long dates and relative times in the language', () => {
    expect(formatDateLong('2026-10-31', 'en')).toBe('31 October 2026')
    expect(formatDateLong('2026-10-31', 'it')).toBe('31 ottobre 2026')
    const now = new Date(2026, 9, 31, 12, 0)
    expect(formatRelative(new Date(2026, 9, 31, 9, 0), now, 'en')).toBe('3 hours ago')
    expect(formatRelative(new Date(2026, 9, 31, 9, 0), now, 'it')).toBe('3 ore fa')
    expect(formatRelative(new Date(2026, 9, 20), now, 'en')).toBe('20.10.2026')
  })

  it('formats integer cents with the currency code, grouping and the language decimal mark', () => {
    expect(formatMoney(123450, 'EUR', 'en')).toBe('EUR 1,234.50')
    // Italian (CLDR) groups thousands from five digits up: 1234,50 but 12.345,50.
    expect(formatMoney(123450, 'EUR', 'it')).toBe('1234,50 EUR')
    expect(formatMoney(1234550, 'EUR', 'it')).toBe('12.345,50 EUR')
    expect(formatMoney(5, 'CHF', 'en')).toBe('CHF 0.05')
    expect(formatAmount(123456789, 'it')).toBe('1.234.567,89')
  })

  it('uses a real minus sign, and refuses a non-integer amount', () => {
    expect(formatMoney(-2550, 'EUR', 'en')).toBe('−EUR 25.50')
    expect(formatAmount(-2550, 'it')).toBe('−25,50')
    expect(() => formatMoney(12.5, 'EUR')).toThrow(TypeError)
  })

  it('formats other numbers in the language', () => {
    expect(formatNumber(0.3, { style: 'percent' }, 'en')).toBe('30%')
    expect(formatNumber(1234.5, {}, 'it')).toBe('1234,5')
    expect(formatNumber(12345.5, {}, 'it')).toBe('12.345,5')
  })

  it('writes a duration as a clock: hh:mm:ss, zero-padded, hours past 99 kept whole', () => {
    expect(formatDuration(0, { style: 'clock' })).toBe('00:00:00')
    expect(formatDuration(3_723_000, { style: 'clock' })).toBe('01:02:03')
    expect(formatDuration(59_999, { style: 'clock' })).toBe('00:00:59')
    expect(formatDuration(360_000_000, { style: 'clock' })).toBe('100:00:00')
  })

  it('clamps a negative duration to zero and refuses a non-finite one', () => {
    expect(formatDuration(-5_000, { style: 'clock' })).toBe('00:00:00')
    expect(() => formatDuration(Number.NaN, { style: 'clock' })).toThrow(TypeError)
    expect(() => formatDuration(Number.POSITIVE_INFINITY, { style: 'spoken' })).toThrow(TypeError)
  })

  it('speaks a duration in the language, omitting zero units but never saying nothing', () => {
    expect(formatDuration(3_723_000, { style: 'spoken' }, 'en')).toBe('1 hour, 2 minutes, 3 seconds')
    expect(formatDuration(3_723_000, { style: 'spoken' }, 'it')).toBe('1 ora, 2 minuti e 3 secondi')
    expect(formatDuration(60_000, { style: 'spoken' }, 'en')).toBe('1 minute')
    expect(formatDuration(0, { style: 'spoken' }, 'en')).toBe('0 seconds')
    expect(formatDuration(400, { style: 'spoken' }, 'it')).toBe('0 secondi')
  })

  it('speaks the same words without Intl.DurationFormat (older browsers)', () => {
    // Intl's constructors are not enumerable, so a spread would lose them: hide just this one.
    vi.stubGlobal(
      'Intl',
      new Proxy(Intl, { get: (target, key) => (key === 'DurationFormat' ? undefined : Reflect.get(target, key)) }),
    )
    expect((Intl as { DurationFormat?: unknown }).DurationFormat).toBeUndefined()
    expect(formatDuration(3_723_000, { style: 'spoken' }, 'en')).toBe('1 hour, 2 minutes, 3 seconds')
    expect(formatDuration(3_723_000, { style: 'spoken' }, 'it')).toBe('1 ora, 2 minuti e 3 secondi')
    expect(formatDuration(0, { style: 'spoken' }, 'en')).toBe('0 seconds')
    expect(formatDuration(7_200_000, { style: 'spoken' }, 'it')).toBe('2 ore')
  })
})

describe('languages and catalogs', () => {
  it('resolves the language from <html lang>, then the browser, else English', () => {
    document.documentElement.setAttribute('lang', 'it-CH')
    expect(resolveLocale()).toBe('it')
    document.documentElement.removeAttribute('lang')
    vi.stubGlobal('navigator', { language: 'de-CH', languages: ['de-CH', 'it-IT', 'en'] })
    expect(resolveLocale()).toBe('it')
    vi.stubGlobal('navigator', { language: 'fr-FR', languages: ['fr-FR'] })
    expect(resolveLocale()).toBe('en')
  })

  it('selects the catalog, falling back to English', () => {
    expect(selectStrings({ en: { hi: 'Hello' }, it: { hi: 'Ciao' } }, 'it').hi).toBe('Ciao')
    expect(selectStrings({ en: { hi: 'Hello' } }, 'it').hi).toBe('Hello')
  })

  it('lists every gap between a catalog and its translation', () => {
    const en = { a: 'A', nested: { b: 'B', count: (n: number) => `${n} items` }, c: 'C' }
    expect(catalogGaps(en, { a: 'A', nested: { b: 'B', count: (n: number) => `${n} voci` }, c: 'C' })).toEqual([])
    expect(catalogGaps(en, { a: '', nested: { b: 'B', count: '3 voci' }, d: 'D' })).toEqual([
      'a: empty',
      'nested.count: expected a function',
      'c: missing',
      'd: not in the reference',
    ])
  })
})

describe('Icon and StatusBadge', () => {
  it('is decorative unless labelled', () => {
    const { container } = render(<Icon name="close" />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    render(<Icon name="alert" label="Warning" />)
    expect(screen.getByRole('img', { name: 'Warning' })).toBeInTheDocument()
  })

  it('draws the recording controls', () => {
    for (const name of ['mic', 'pause', 'play', 'stop'] as const) {
      expect(ICON_NAMES).toContain(name)
      const { container, unmount } = render(<Icon name={name} />)
      expect(container.querySelector('svg path, svg rect, svg circle')).not.toBeNull()
      unmount()
    }
  })

  it('gives every status meaning its own icon', () => {
    const icons = Object.values(STATUS).map((meaning) => meaning.icon)
    expect(new Set(icons).size).toBe(icons.length)
    for (const icon of icons) expect(ICON_NAMES).toContain(icon)
  })

  it('renders the tone and icon of the meaning with the domain label', () => {
    render(<StatusBadge status="settled">Paid</StatusBadge>)
    const badge = screen.getByText('Paid').parentElement
    expect(badge).toHaveClass('badge', 'badge-success')
    expect(badge?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('Tabs', () => {
  function Harness() {
    const [value, setValue] = useState<'a' | 'b' | 'c'>('a')
    return (
      <>
        <Tabs
          label="Views"
          idPrefix="views"
          value={value}
          onChange={setValue}
          tabs={[
            { id: 'a', label: 'Activities' },
            { id: 'b', label: 'Summary' },
            { id: 'c', label: 'Parameters' },
          ]}
        />
        <div {...tabPanelProps('views', value)}>Panel {value}</div>
      </>
    )
  }

  it('is a tablist with one tab stop, moved by arrow keys, Home and End', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const tabs = screen.getAllByRole('tab')
    expect(screen.getByRole('tablist', { name: 'Views' })).toBeInTheDocument()
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
    expect(screen.getByRole('tabpanel', { name: 'Activities' })).toHaveTextContent('Panel a')

    await user.tab()
    expect(tabs[0]).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('tabpanel', { name: 'Parameters' })).toBeInTheDocument()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Activities' })).toHaveAttribute('aria-selected', 'true')
  })
})
