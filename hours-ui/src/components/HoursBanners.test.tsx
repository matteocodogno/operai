/**
 * @vitest-environment jsdom
 *
 * HoursBanners — what the view says about names it could not load or may not show (specs/029-time-tracking
 * T25; AC-4.7, AC-4.10; design S1 states table). Three notes, each only when it applies, none announced
 * more loudly than it deserves: a source that did not answer is a polite status, the deal-grouping warning
 * is polite too (never `alert`), and the "names not visible" note is a standing fact read in place
 * (`role="note"`, named), never announced.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { strings } from '../strings'
import HoursBanners from './HoursBanners'
import type { HoursBannersProps } from './HoursBanners'

afterEach(() => cleanup())

const e = strings.entries
const n = strings.names

const none: HoursBannersProps = { sources: [], dealGroupingUnavailable: false, hiddenNames: false }

describe('HoursBanners', () => {
  it('renders nothing when every name loaded and none is withheld', () => {
    const { container } = render(<HoursBanners {...none} />)
    expect(container.textContent).toBe('')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  describe('a source that did not answer (AC-4.7)', () => {
    it('is ONE polite info banner naming the sources in words, never an alert', () => {
      render(<HoursBanners {...none} sources={['projects', 'activities', 'meeting-deals']} />)

      const banner = screen.getByTestId('hours-banner-unavailable')
      expect(banner.getAttribute('role')).toBe('status')
      expect(banner.getAttribute('aria-live')).toBe('polite')
      expect(banner.textContent).toContain(
        e.banners.unavailable([n.sources.projects, n.sources.activities, n.sources['meeting-deals']].join(', ')),
      )
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getAllByTestId(/^hours-banner-/)).toHaveLength(1)
    })

    it('names a single source in its own words', () => {
      render(<HoursBanners {...none} sources={['crm']} />)
      expect(screen.getByTestId('hours-banner-unavailable').textContent).toContain(n.sources.crm)
      expect(screen.getByTestId('hours-banner-unavailable').textContent).not.toContain(n.sources.projects)
    })
  })

  describe('grouping by deal while the meeting → deal link did not answer', () => {
    it('adds a polite warning that the meeting hours are in one separate row and the total is unchanged', () => {
      render(<HoursBanners {...none} sources={['meeting-deals']} dealGroupingUnavailable />)

      const warning = screen.getByTestId('hours-banner-deal-grouping')
      expect(warning.textContent).toContain(e.banners.dealGrouping)
      expect(warning.textContent).toMatch(/separate row/)
      expect(warning.textContent).toMatch(/total is unchanged/)
      // Warning in tone, but polite: it is not time-critical.
      expect(warning.className).toContain('banner-warning')
      expect(warning.getAttribute('role')).toBe('status')
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('is absent unless the grouping asks for it', () => {
      render(<HoursBanners {...none} sources={['meeting-deals']} />)
      expect(screen.queryByTestId('hours-banner-deal-grouping')).toBeNull()
      expect(screen.getByTestId('hours-banner-unavailable')).not.toBeNull()
    })
  })

  describe('a name the viewer may not read (AC-4.10)', () => {
    it('is a static, named note that is not announced', () => {
      render(<HoursBanners {...none} hiddenNames />)

      const note = screen.getByRole('note', { name: e.banners.hidden.label })
      expect(note.textContent).toContain(e.banners.hidden.body)
      expect(note.getAttribute('aria-live')).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    })
  })

  it('the note can carry the page’s own words (Everyone’s hours reads "not visible to you"), still a named static note', () => {
    const own = strings.everyone.entries.hidden
    render(<HoursBanners {...none} hiddenNames hiddenCopy={own} />)

    const note = screen.getByRole('note', { name: own.label })
    expect(note.textContent).toContain(own.body)
    expect(note.textContent).not.toContain(e.banners.hidden.body)
    expect(note.getAttribute('aria-live')).toBeNull()
    expect(own.body).toBe(
      'Some projects, deals or meetings are not visible to you, so they show without a name. Their hours are still counted.',
    )
  })

  it('shows the three in a fixed order: names missing, deal grouping, names not visible', () => {
    render(<HoursBanners sources={['crm', 'meeting-deals']} dealGroupingUnavailable hiddenNames />)
    expect(screen.getAllByTestId(/^hours-banner-/).map((banner) => banner.getAttribute('data-testid'))).toEqual([
      'hours-banner-unavailable',
      'hours-banner-deal-grouping',
      'hours-banner-hidden',
    ])
  })
})
