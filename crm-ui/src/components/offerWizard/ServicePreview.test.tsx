/**
 * @vitest-environment jsdom
 *
 * The wizard's pane on the service path (specs/20261116-letterhead-service T32; design F12, F13, S9, § Accessibility;
 * AC-10.3, AC-10.4, AC-10.5, AC-10.7, AC-10.8, AC-10.13): the pages with their text as the alternative, the previous pages
 * kept, the polite notices, the title row and the address notice, and the words in both languages.
 */
import { catalogGaps } from '@operai/ui'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetManageableLegalEntities } from '../../hooks/useCanManageLegalEntity'
import { en, it as italian, strings } from '../../strings'
import ServicePreview, { type ServicePreviewProps } from './ServicePreview'
import type { ServicePreviewNotice, ServicePreviewResult } from './useServicePreview'

const { apiFetch, session } = vi.hoisted(() => ({ apiFetch: vi.fn(), session: { apps: [] as string[] } }))
vi.mock('shell/session', () => ({
  apiFetch,
  getAuthBaseUrl: () => 'http://auth.test',
  useSession: () => ({ data: { user: { id: 'u-ada' } } }),
  usePermissions: () => ({ epoch: 0, apps: session.apps, roles: [], departments: [], permissions: [] }),
}))

const t = strings.offerWizard

const pages = [
  { image: 'AAAA', text: 'Offer 0001/2026\nDear Acme' },
  { image: 'BBBB', text: 'Terms and conditions' },
]

function view(overrides: Partial<ServicePreviewResult> = {}, props: Partial<ServicePreviewProps> = {}) {
  const preview: ServicePreviewResult = { state: 'ready', pages, notice: null, retry: () => undefined, ...overrides }
  return (
    <ServicePreview
      preview={preview}
      entity="welld_it"
      language="it"
      missing={0}
      addressUnset={false}
      issuer="wellD IT S.r.l."
      {...props}
    />
  )
}

beforeEach(() => {
  // `manageable` is never answered here: the legal entity notice stays on its sentence, which is what these tests read
  apiFetch.mockImplementation(() => new Promise(() => undefined))
  resetManageableLegalEntities()
})
afterEach(() => {
  cleanup()
  apiFetch.mockReset()
  session.apps = []
})

describe('ServicePreview — the pages (AC-10.3, AC-10.5)', () => {
  it('shows each page as a figure: "Page N of M" as its picture, its own text as its caption, in the template language', () => {
    render(view())
    const region = screen.getByRole('region', { name: t.preview.title })
    expect(region.getAttribute('aria-busy')).toBe('false')
    const figures = within(region).getAllByRole('figure')
    expect(figures).toHaveLength(2)
    expect(within(figures[0]!).getByRole('img', { name: 'Page 1 of 2' })).toBeTruthy()
    expect(within(figures[1]!).getByRole('img', { name: 'Page 2 of 2' })).toBeTruthy()
    const caption = figures[0]!.querySelector('figcaption')!
    expect(caption.textContent).toBe('Offer 0001/2026\nDear Acme')
    expect(caption.getAttribute('lang')).toBe('it')
    expect(caption.style.whiteSpace).toBe('pre-line')
    expect(screen.getByText('2 pages')).toBeTruthy()
  })

  it('does not offer selecting or copying the pictures', () => {
    render(view())
    for (const image of screen.getAllByRole('img')) {
      expect(image.className).toContain('select-none')
      expect(image.getAttribute('draggable')).toBe('false')
    }
  })

  it('draws no letterhead band and no note about approximate page breaks: the pages are the PDF\'s own', () => {
    render(view())
    expect(screen.queryByTestId('crm-wizard-letterhead-band')).toBeNull()
    expect(document.body.textContent).not.toContain(t.preview.note)
  })

  it('says "1 page" for one page', () => {
    render(view({ pages: [pages[0]!] }))
    expect(screen.getByText('1 page')).toBeTruthy()
  })
})

describe('ServicePreview — never blank, previous pages stay (AC-10.4)', () => {
  it('shows the A4 skeleton and "Preparing the preview…" the first time, busy', () => {
    render(view({ state: 'loading', pages: [] }))
    expect(screen.getByTestId('page-preview-placeholder')).toBeTruthy()
    expect(screen.getByTestId('page-preview-status').textContent).toBe(t.servicePreview.loading)
    expect(screen.getByRole('region').getAttribute('aria-busy')).toBe('true')
  })

  it('keeps the pages with "Updating…" and aria-busy while the next ones are made', () => {
    render(view({ state: 'updating' }))
    expect(screen.getAllByRole('figure')).toHaveLength(2)
    expect(screen.getByTestId('page-preview-status').textContent).toBe(t.servicePreview.updating)
    expect(screen.getByRole('region').getAttribute('aria-busy')).toBe('true')
  })

  it('shows the placeholder, not an empty region, before anything was asked', () => {
    render(view({ state: 'ready', pages: [] }))
    expect(screen.getByTestId('page-preview-placeholder')).toBeTruthy()
    expect(screen.queryByRole('figure')).toBeNull()
    expect(screen.getByRole('region').getAttribute('aria-busy')).toBe('false')
  })
})

describe('ServicePreview — the preview could not be updated (AC-10.7)', () => {
  const failed: ServicePreviewNotice = { kind: 'failed' }

  it('keeps the last pages and tells it politely: a status, no alert, no dialog', () => {
    render(view({ state: 'failed', notice: failed }))
    expect(screen.getAllByRole('figure')).toHaveLength(2)
    expect(screen.getByTestId('page-preview-status').textContent).toBe(t.servicePreview.failedShort)
    const notice = screen.getByTestId('crm-wizard-service-preview-failed')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain(t.servicePreview.failedTitle)
    expect(notice.textContent).toContain(t.servicePreview.failedBody)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says there is no preview yet, and that the draft is saved, when it never had one', () => {
    render(view({ state: 'failed', pages: [], notice: failed }))
    expect(screen.getByTestId('page-preview-placeholder')).toBeTruthy()
    const notice = screen.getByTestId('crm-wizard-service-preview-failed')
    expect(notice.textContent).toContain(t.servicePreview.failedFirstBody)
    expect(notice.textContent).not.toContain(t.servicePreview.failedBody)
  })

  it('asks again from Try again', async () => {
    const retry = vi.fn()
    render(view({ state: 'failed', notice: failed, retry }))
    await userEvent.setup().click(screen.getByRole('button', { name: t.servicePreview.retry }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('tells incomplete legal details and an answer that is not valid in the same polite way (AC-6.3)', () => {
    const { unmount } = render(
      view({ state: 'blocked', notice: { kind: 'legalEntityIncomplete', entity: 'welld_ch', missing: ['legalName'] } }),
    )
    const incomplete = screen.getByTestId('crm-wizard-legal-entity-incomplete')
    expect(incomplete.getAttribute('role')).toBe('status')
    expect(incomplete.textContent).toContain(t.legalEntity.incomplete.title('wellD CH'))
    expect(incomplete.textContent).toContain('Legal name')
    expect(within(incomplete).queryByRole('button')).toBeNull()
    unmount()
    render(view({ state: 'blocked', notice: { kind: 'invalid' } }))
    expect(screen.getByTestId('crm-wizard-service-preview-invalid').textContent).toBe(t.servicePreview.invalidAnswers)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByRole('figure')).toHaveLength(2)
  })
})

describe('ServicePreview — a section over the length limit (T50)', () => {
  it('names the section politely, keeps the pages, and offers no retry', () => {
    render(view({ state: 'blocked', notice: { kind: 'sectionTooLong', sections: ['OGGETTO'] } }))
    const notice = screen.getByTestId('crm-wizard-service-preview-too-long')
    expect(notice.textContent).toBe(t.servicePreview.sectionTooLong(['OGGETTO']))
    expect(notice.textContent).toContain('OGGETTO')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getAllByRole('figure')).toHaveLength(2)
  })

  it('says it without a name when the engine names none, and names several', () => {
    const { unmount } = render(view({ state: 'blocked', notice: { kind: 'sectionTooLong', sections: [] } }))
    expect(screen.getByTestId('crm-wizard-service-preview-too-long').textContent).toBe(t.servicePreview.sectionTooLong([]))
    unmount()
    render(view({ state: 'blocked', notice: { kind: 'sectionTooLong', sections: ['A', 'B'] } }))
    expect(screen.getByTestId('crm-wizard-service-preview-too-long').textContent).toMatch(/“A”.*“B”/)
  })
})

describe('ServicePreview — no letterhead is set (AC-10.8)', () => {
  it('keeps the pages and shows the notice, with the link only for a holder of access', () => {
    session.apps = ['letterheads']
    const { unmount } = render(view({ state: 'blocked', notice: { kind: 'notConfigured' } }, { entity: 'welld_ch' }))
    expect(screen.getAllByRole('figure')).toHaveLength(2)
    expect(screen.getByTestId('crm-wizard-letterhead-not-configured').textContent).toContain(
      t.letterhead.notConfigured.title('wellD CH'),
    )
    expect(screen.getByRole('link', { name: t.letterhead.open }).getAttribute('href')).toBe('/letterheads?entity=welld_ch')
    unmount()

    session.apps = ['crm']
    render(view({ state: 'blocked', pages: [], notice: { kind: 'notConfigured' } }))
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByTestId('crm-wizard-letterhead-not-configured').textContent).toContain(t.letterhead.askAdmin)
    expect(screen.getByTestId('page-preview-placeholder')).toBeTruthy()
  })

  it('names the frame of an overflow', () => {
    render(view({ state: 'blocked', notice: { kind: 'overflow', frame: 'footer' } }))
    expect(screen.getByTestId('crm-wizard-letterhead-overflow').textContent).toContain(
      t.letterhead.overflow.title('wellD IT', t.letterhead.overflow.footer),
    )
  })
})

describe('ServicePreview — the wizard\'s own title row and notice', () => {
  it('keeps the title, the missing badge from the wizard\'s count and the address notice', () => {
    render(view({}, { missing: 3, addressUnset: true }))
    expect(screen.getByRole('heading', { level: 3, name: t.preview.title })).toBeTruthy()
    expect(screen.getByText(t.preview.missingBadge(3))).toBeTruthy()
    expect(screen.getByTestId('crm-wizard-address-notice').textContent).toBe(t.preview.addressNotice('wellD IT S.r.l.'))
  })

  it('has no badge when nothing is missing, no address notice when the address is set, and no title inside a drawer', () => {
    render(view({}, { heading: false }))
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByText(/missing/)).toBeNull()
    expect(screen.queryByTestId('crm-wizard-address-notice')).toBeNull()
  })
})

describe('ServicePreview — the words, in English and Italian (AC-10.13)', () => {
  it('has the same keys in both languages for everything this task added', () => {
    expect(catalogGaps(en.offerWizard.servicePreview, italian.offerWizard.servicePreview)).toEqual([])
    expect(catalogGaps(en.offerWizard.letterhead, italian.offerWizard.letterhead)).toEqual([])
  })

  it('is translated, and every function key renders a sentence with its values in both', () => {
    for (const catalog of [en, italian]) {
      const s = catalog.offerWizard.servicePreview
      const l = catalog.offerWizard.letterhead
      expect(s.pages(1)).toContain('1')
      expect(s.pages(4)).toContain('4')
      expect(s.pageAlt(2, 5)).toMatch(/2.*5/)
      const e = catalog.offerWizard.legalEntity
      expect(e.incomplete.title('wellD CH')).toContain('wellD CH')
      expect(e.incomplete.missing('X')).toContain('X')
      expect(e.openNamed('wellD CH')).toContain('wellD CH')
      expect(s.sectionTooLong(['OGGETTO'])).toContain('OGGETTO')
      expect(s.sectionTooLong(['A', 'B'])).toMatch(/A.*B/)
      expect(s.sectionTooLong([])).toContain('20 000')
      expect(l.notConfigured.title('wellD IT')).toContain('wellD IT')
      expect(l.overflow.title('wellD CH', l.overflow.header)).toContain(l.overflow.header)
    }
    expect(italian.offerWizard.servicePreview.retry).not.toBe(en.offerWizard.servicePreview.retry)
    expect(italian.offerWizard.servicePreview.failedBody).not.toBe(en.offerWizard.servicePreview.failedBody)
    expect(italian.offerWizard.letterhead.open).not.toBe(en.offerWizard.letterhead.open)
    expect(italian.offerWizard.servicePreview.pageAlt(1, 2)).toBe('Pagina 1 di 2')
  })

  it('ends each sentence once (no doubled full stop where a notice joins two)', () => {
    for (const catalog of [en, italian]) {
      const l = catalog.offerWizard.letterhead
      for (const text of [l.notConfigured.preview, l.notConfigured.generate, l.askAdmin, l.overflow.body]) {
        expect(text).toMatch(/[.]$/)
        expect(text).not.toMatch(/[.!?]{2}/)
      }
    }
  })
})
