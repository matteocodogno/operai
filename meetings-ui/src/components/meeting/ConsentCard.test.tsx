/**
 * @vitest-environment jsdom
 *
 * The consent card (specs/021-meetings T61; design.md F3; AC-4.1, AC-4.2, AC-4.3, AC-2.1): the
 * versioned notice with its five statements, one explicit tick, the copyable announcement, and the
 * collapsed attestation once given. Capture controls are the page's to hide until then.
 */
import { catalogGaps } from '@operai/ui'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en, it as italian } from '../../strings'
import { CAN_CREATOR_DRAFT, CAN_NONE, GONE, fakeApi, meeting, problem, readyMeeting } from '../../test-support/fakeApi'
import ConsentCard from './ConsentCard'

const session = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  apiFetch: session.apiFetch,
  getMeetingsApiBaseUrl: () => 'http://meetings-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

beforeEach(() => {
  session.apiFetch.mockReset()
})

afterEach(() => {
  cleanup()
})

const t = en.consent

const unattested = (overrides = {}) => meeting({ status: 'draft', source: 'recorded', consent: null, ...overrides })

describe('consent notice copy (AC-4.1)', () => {
  /** What each of the five statements must say; the same five, in this order, in both languages. */
  const REQUIRED: Record<'en' | 'it', RegExp[]> = {
    en: [
      /told .* agreed/i, // everyone present has been told and agreed
      /AI/, // transcribed and summarised by AI …
      /EU or Switzerland/, // … processed in the EU or Switzerland
      /read/i, // who can read the result
      /30 days/, // how long the audio is kept
      /Zoom, Teams or Meet/, // a platform banner does not cover this tool
    ],
    it: [/informate .* consenso/i, /IA/, /UE o in Svizzera/, /letto|leggerlo/i, /30 giorni/, /Zoom, Teams o Meet/],
  }
  // Statement 2 carries two requirements (AI, and where it is processed); the rest one each.
  const split = (language: 'en' | 'it') => {
    const patterns = REQUIRED[language]
    return [[patterns[0]!], [patterns[1]!, patterns[2]!], [patterns[3]!], [patterns[4]!], [patterns[5]!]]
  }

  it.each([
    ['en', en.consent.statements],
    ['it', italian.consent.statements],
  ] as const)(
    'the %s notice has exactly the five required statements, each saying what AC-4.1 asks',
    (language, statements) => {
      expect(statements).toHaveLength(5)
      split(language).forEach((patterns, index) => {
        for (const pattern of patterns) expect(statements[index]).toMatch(pattern)
      })
    },
  )

  it('the Italian notice is a complete translation of the English one, not a copy', () => {
    expect(catalogGaps(en.consent, italian.consent)).toEqual([])
    en.consent.statements.forEach((statement, index) => expect(italian.consent.statements[index]).not.toBe(statement))
    expect(italian.consent.announcementText).not.toBe(en.consent.announcementText)
  })

  it('carries a version, the same in both languages (it names the legal text, not a translation)', () => {
    expect(en.consent.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(italian.consent.version).toBe(en.consent.version)
  })
})

describe('ConsentCard: the notice and the tick (AC-4.1)', () => {
  it('shows the notice: the five statements, in order, under the card title', () => {
    render(<ConsentCard meeting={unattested()} onChanged={vi.fn()} />)
    const card = screen.getByRole('region', { name: t.title })
    const items = within(card).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(t.statements)
  })

  it('Continue is disabled until the tick, and enabled again by it; unticking disables it again', async () => {
    render(<ConsentCard meeting={unattested()} onChanged={vi.fn()} />)
    const proceed = screen.getByRole('button', { name: t.continue }) as HTMLButtonElement
    expect(proceed.disabled).toBe(true)

    await userEvent.click(screen.getByRole('checkbox', { name: t.confirmLabel }))
    expect(proceed.disabled).toBe(false)

    await userEvent.click(screen.getByRole('checkbox', { name: t.confirmLabel }))
    expect(proceed.disabled).toBe(true)
  })

  it('Continue posts the notice version that was shown, and hands the server meeting up (AC-4.3)', async () => {
    const attested = readyMeeting({ status: 'draft' })
    const bodies: unknown[] = []
    const api = fakeApi({
      'POST /meetings/:id/consent': (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { status: 200, body: attested }
      },
    })
    session.apiFetch.mockImplementation(api)
    const onChanged = vi.fn()
    render(<ConsentCard meeting={unattested()} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('checkbox', { name: t.confirmLabel }))
    await userEvent.click(screen.getByRole('button', { name: t.continue }))

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(attested))
    expect(bodies).toEqual([{ noticeVersion: t.version }])
    expect(new URL(String(api.mock.calls[0]![0])).pathname).toBe('/meetings/m1/consent')
  })

  it('is busy while the request runs and cannot be sent twice', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const api = fakeApi({
      'POST /meetings/:id/consent': async () => {
        await gate
        return { status: 200, body: readyMeeting({ status: 'draft' }) }
      },
    })
    session.apiFetch.mockImplementation(api)
    render(<ConsentCard meeting={unattested()} onChanged={vi.fn()} />)

    await userEvent.click(screen.getByRole('checkbox', { name: t.confirmLabel }))
    await userEvent.click(screen.getByRole('button', { name: t.continue }))
    const busy = screen.getByRole('button', { name: t.busy })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    await userEvent.click(busy)
    expect(api).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: t.busy })).toBeNull())
  })

  it('a changed notice (409 notice_outdated) asks to reload and keeps the page, the tick and the notice', async () => {
    session.apiFetch.mockImplementation(
      fakeApi({ 'POST /meetings/:id/consent': () => ({ status: 409, body: problem(409, 'notice_outdated') }) }),
    )
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } })
    render(<ConsentCard meeting={unattested()} onChanged={vi.fn()} />)

    await userEvent.click(screen.getByRole('checkbox', { name: t.confirmLabel }))
    await userEvent.click(screen.getByRole('button', { name: t.continue }))

    expect(await screen.findByText(t.outdated.message)).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: t.outdated.reload }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('any other refusal shows its message in the card and lets the creator try again', async () => {
    let fail = true
    const attested = readyMeeting({ status: 'draft' })
    session.apiFetch.mockImplementation(
      fakeApi({
        'POST /meetings/:id/consent': () =>
          fail ? { status: 403, body: problem(403, 'frozen') } : { status: 200, body: attested },
      }),
    )
    const onChanged = vi.fn()
    render(<ConsentCard meeting={unattested()} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('checkbox', { name: t.confirmLabel }))
    await userEvent.click(screen.getByRole('button', { name: t.continue }))
    expect(await screen.findByText(en.common.errors.frozen)).not.toBeNull()
    expect((screen.getByRole('checkbox', { name: t.confirmLabel }) as HTMLInputElement).checked).toBe(true)

    fail = false
    await userEvent.click(screen.getByRole('button', { name: t.continue }))
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(attested))
  })

  it('a network failure says so instead of failing silently', async () => {
    session.apiFetch.mockRejectedValue(new TypeError('offline'))
    render(<ConsentCard meeting={unattested()} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('checkbox', { name: t.confirmLabel }))
    await userEvent.click(screen.getByRole('button', { name: t.continue }))
    expect(await screen.findByText(en.common.networkError)).not.toBeNull()
  })
})

describe('ConsentCard: the announcement (AC-4.2)', () => {
  it('shows the announcement text, and Copy puts exactly it on the clipboard', async () => {
    const user = userEvent.setup()
    render(<ConsentCard meeting={unattested()} onChanged={vi.fn()} />)
    expect(screen.getByText(t.announcementText)).not.toBeNull()

    await user.click(screen.getByRole('button', { name: t.copyAnnouncement }))
    expect(await navigator.clipboard.readText()).toBe(t.announcementText)
    expect(await screen.findByText(t.copied)).not.toBeNull()
  })

  it('a clipboard that refuses says so, and the text stays on screen to copy by hand', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    render(<ConsentCard meeting={unattested()} onChanged={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: t.copyAnnouncement }))
    expect(await screen.findByText(t.copyFailed)).not.toBeNull()
    expect(screen.queryByText(t.copied)).toBeNull()
    expect(screen.getByText(t.announcementText)).not.toBeNull()
  })
})

describe('ConsentCard: once attested, and when it does not apply (AC-4.3, AC-3.4)', () => {
  it('collapses to the one-line fact: who, when, which version; no tick, no Continue', () => {
    render(<ConsentCard meeting={readyMeeting({ status: 'draft' })} onChanged={vi.fn()} />)
    expect(screen.getByText(/^Confirmed by Ada Lovelace on \d{2}\.\d{2}\.\d{4}, notice 2026-11-01$/)).not.toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: t.continue })).toBeNull()
    expect(screen.queryByText(t.announcementText)).toBeNull()
  })

  it('names a deleted attester as "Deleted user"', () => {
    const attested = readyMeeting({ status: 'draft' })
    render(<ConsentCard meeting={{ ...attested, consent: { ...attested.consent!, by: GONE } }} onChanged={vi.fn()} />)
    expect(screen.getByText(new RegExp(`Confirmed by ${en.meeting.details.deletedUser} on`))).not.toBeNull()
  })

  it('a text meeting never shows the card (AC-3.4)', () => {
    const { container } = render(<ConsentCard meeting={unattested({ source: 'text' })} onChanged={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('offers nothing to someone who cannot capture (a participant, a frozen meeting)', () => {
    const { container } = render(
      <ConsentCard meeting={unattested({ role: 'participant', can: CAN_NONE })} onChanged={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
  })

  it('still shows the attestation to someone who cannot capture, when one exists', () => {
    render(<ConsentCard meeting={readyMeeting({ status: 'draft', can: CAN_NONE })} onChanged={vi.fn()} />)
    expect(screen.getByText(/^Confirmed by Ada Lovelace/)).not.toBeNull()
  })

  it('shows the card to the creator of a fresh draft (CAN_CREATOR_DRAFT)', () => {
    render(<ConsentCard meeting={unattested({ can: CAN_CREATOR_DRAFT })} onChanged={vi.fn()} />)
    expect(screen.getByRole('region', { name: t.title })).not.toBeNull()
  })
})
