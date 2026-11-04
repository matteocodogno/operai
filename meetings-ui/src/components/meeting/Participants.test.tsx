/**
 * @vitest-environment jsdom
 *
 * The participants card and the Edit participants dialog (specs/021-meetings T60; design.md S3 ›
 * People and access, S4, F13; AC-5.1, AC-5.4, AC-5.5, AC-5.10, plan G6, G9): the library
 * `PersonPicker` over the user directory called WITHOUT `appId`, external people with a name and an
 * organisation, at most 30, deleted users shown as deleted, and focus that survives a removal.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Meeting, Participant } from '../../lib/types'
import { en } from '../../strings'
import {
  ADA,
  CAN_CREATOR_READY,
  CAN_NONE,
  GONE,
  GRACE,
  crmDealHost,
  fakeApi,
  hostView,
  participantMeeting,
  problem,
  readyMeeting,
} from '../../test-support/fakeApi'
import type { FakeHandler } from '../../test-support/fakeApi'
import EditParticipantsDialog from './EditParticipantsDialog'
import ParticipantsCard from './ParticipantsCard'

const session = vi.hoisted(() => ({ apiFetch: vi.fn() }))

vi.mock('shell/session', () => ({
  apiFetch: session.apiFetch,
  getMeetingsApiBaseUrl: () => 'http://meetings-api.test',
  getAuthBaseUrl: () => 'http://auth.test',
}))

beforeEach(() => {
  session.apiFetch.mockReset()
  document.documentElement.removeAttribute('lang')
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('lang')
})

const c = en.participants.card
const d = en.participants.dialog
const v = en.participants.visibility

const DIRECTORY = {
  users: [
    { id: 'u-grace', name: 'Grace Hopper', email: 'grace@welld.ch', entity: 'welld_ch' },
    { id: 'u-alan', name: 'Alan Turing', email: 'alan@welld.ch', entity: 'welld_it' },
    { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@welld.ch', entity: 'welld_it' },
  ],
}

const operai = (id: string, person = GRACE): Participant => ({
  id,
  kind: 'operai',
  person: { ...person, id: person.id },
})
const external = (id: string, name: string, organisation: string | null = null): Participant => ({
  id,
  kind: 'external',
  name,
  organisation,
})

const serve = (extra: Record<string, FakeHandler> = {}) => {
  const api = fakeApi({
    'GET /authz/users/directory': () => ({ status: 200, body: DIRECTORY }),
    ...extra,
  })
  session.apiFetch.mockImplementation(api)
  return api
}

const requests = (api: ReturnType<typeof fakeApi>, method: string, path: string) =>
  api.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === path && (init?.method ?? 'GET') === method)

const manyExternals = (count: number): Participant[] =>
  Array.from({ length: count }, (_, index) => external(`x${index}`, `Guest ${index + 1}`))

describe('ParticipantsCard: who is on the meeting (AC-5.10)', () => {
  it('lists the creator first with a Creator badge, then each participant, with the count', () => {
    serve()
    render(
      <ParticipantsCard
        meeting={readyMeeting({
          participants: [operai('p1', GRACE), external('p2', 'Zed Client', 'Acme')],
        })}
        hostInfo={null}
        onChanged={vi.fn()}
      />,
    )
    const card = screen.getByRole('region', { name: c.title })
    const rows = within(card).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('Ada Lovelace')
    expect(rows[0]!.textContent).toContain(c.creatorBadge)
    expect(rows[1]!.textContent).toContain('Grace Hopper')
    expect(rows[2]!.textContent).toContain('Zed Client')
    expect(rows[2]!.textContent).toContain('Acme')
    expect(rows[2]!.textContent).toContain(c.externalBadge)
    expect(within(card).getByText(c.count(2, 30))).not.toBeNull()
  })

  it('shows a deleted user as "Deleted user", and a creator who was deleted too', () => {
    serve()
    render(
      <ParticipantsCard
        meeting={readyMeeting({ creator: GONE, participants: [operai('p1', GONE)] })}
        hostInfo={null}
        onChanged={vi.fn()}
      />,
    )
    expect(screen.getAllByText(c.deletedUser)).toHaveLength(2)
  })

  it('an unknown identity (the lookup failed) is not called deleted', () => {
    serve()
    render(
      <ParticipantsCard
        meeting={readyMeeting({
          participants: [operai('p1', { id: 'u-x', name: null, status: 'unknown' })],
        })}
        hostInfo={null}
        onChanged={vi.fn()}
      />,
    )
    expect(screen.getByText(c.unknownUser)).not.toBeNull()
    expect(screen.queryByText(c.deletedUser)).toBeNull()
  })

  it('says so when there is nobody besides the creator', () => {
    serve()
    render(<ParticipantsCard meeting={readyMeeting({ participants: [] })} hostInfo={null} onChanged={vi.fn()} />)
    expect(screen.getByText(c.empty)).not.toBeNull()
  })

  it('Edit participants is a card action only while can.manageParticipants', () => {
    serve()
    render(<ParticipantsCard meeting={readyMeeting()} hostInfo={null} onChanged={vi.fn()} />)
    const edit = screen.getByRole('button', { name: c.edit })
    expect(edit.getAttribute('aria-haspopup')).toBe('dialog')
    cleanup()

    render(<ParticipantsCard meeting={participantMeeting()} hostInfo={null} onChanged={vi.fn()} />)
    expect(screen.queryByRole('button', { name: c.edit })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('opens the dialog from the card, and a saved list is reported up with a polite confirmation', async () => {
    const saved = readyMeeting({ participants: [external('p9', 'Zed Client')] })
    serve({ 'PUT /meetings/:id/participants': () => ({ status: 200, body: saved }) })
    const onChanged = vi.fn()
    render(<ParticipantsCard meeting={readyMeeting()} hostInfo={null} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('button', { name: c.edit }))
    const dialog = await screen.findByRole('dialog', { name: d.title })
    await userEvent.type(within(dialog).getByLabelText(new RegExp(`^${d.name}`)), 'Zed Client')
    await userEvent.click(within(dialog).getByRole('button', { name: d.add }))
    await userEvent.click(within(dialog).getByRole('button', { name: d.save }))

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(saved))
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: d.title })).toBeNull())
    expect(screen.getByText(c.saved)).not.toBeNull()
  })
})

describe("ParticipantsCard: also visible to the host's readers (AC-5.5, plan G6)", () => {
  const linked = (overrides: Partial<Meeting> = {}) =>
    readyMeeting({
      host: hostView(),
      hostVisibleOffered: true,
      hostVisible: false,
      can: { ...CAN_CREATOR_READY, setVisibility: true },
      ...overrides,
    })
  const label = /Also visible to people who can open Deal · Acme renewal/

  it("shows the checkbox with the host's own hint from the registry, in the UI language", () => {
    serve()
    render(<ParticipantsCard meeting={linked()} hostInfo={crmDealHost} onChanged={vi.fn()} />)
    const box = screen.getByRole('checkbox', { name: label })
    expect(box.closest('label')?.textContent).toContain('and can see deal financials')
    cleanup()

    document.documentElement.setAttribute('lang', 'it')
    render(<ParticipantsCard meeting={linked()} hostInfo={crmDealHost} onChanged={vi.fn()} />)
    expect(screen.getByText(/e possono vedere i dati economici dell'opportunità/)).not.toBeNull()
  })

  it('is absent for a standalone meeting, when the host does not offer it, and for a read-only viewer', () => {
    serve()
    render(<ParticipantsCard meeting={readyMeeting({ host: null })} hostInfo={null} onChanged={vi.fn()} />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    cleanup()
    render(
      <ParticipantsCard meeting={linked({ hostVisibleOffered: false })} hostInfo={crmDealHost} onChanged={vi.fn()} />,
    )
    expect(screen.queryByRole('checkbox')).toBeNull()
    cleanup()
    render(
      <ParticipantsCard
        meeting={linked({ can: { ...CAN_NONE, edit: false } })}
        hostInfo={crmDealHost}
        onChanged={vi.fn()}
      />,
    )
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('turning it ON asks first (it widens the readership); Cancel changes nothing', async () => {
    const api = serve()
    render(<ParticipantsCard meeting={linked()} hostInfo={crmDealHost} onChanged={vi.fn()} />)

    await userEvent.click(screen.getByRole('checkbox', { name: label }))
    const confirm = screen.getByRole('alertdialog', { name: v.confirmTitle })
    expect(within(confirm).getByText(v.confirmBody('Deal · Acme renewal'))).not.toBeNull()
    await userEvent.click(within(confirm).getByRole('button', { name: en.common.cancel }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(false)
    expect(requests(api, 'PATCH', '/meetings/m1')).toHaveLength(0)
  })

  it('confirming sends hostVisible: true, reports the meeting and confirms', async () => {
    const turnedOn = linked({ hostVisible: true })
    const api = serve({ 'PATCH /meetings/:id': () => ({ status: 200, body: turnedOn }) })
    const onChanged = vi.fn()
    render(<ParticipantsCard meeting={linked()} hostInfo={crmDealHost} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('checkbox', { name: label }))
    await userEvent.click(screen.getByRole('button', { name: v.confirm }))

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(turnedOn))
    expect(JSON.parse(String(requests(api, 'PATCH', '/meetings/m1')[0]![1]?.body))).toEqual({ hostVisible: true })
    expect(await screen.findByText(v.updated)).not.toBeNull()
  })

  it('turning it OFF applies at once, without a question', async () => {
    const turnedOff = linked({ hostVisible: false })
    const api = serve({ 'PATCH /meetings/:id': () => ({ status: 200, body: turnedOff }) })
    const onChanged = vi.fn()
    render(<ParticipantsCard meeting={linked({ hostVisible: true })} hostInfo={crmDealHost} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('checkbox', { name: label }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith(turnedOff))
    expect(JSON.parse(String(requests(api, 'PATCH', '/meetings/m1')[0]![1]?.body))).toEqual({ hostVisible: false })
  })

  it('a refusal (the host no longer offers it) shows inline and the dialog closes', async () => {
    serve({ 'PATCH /meetings/:id': () => ({ status: 422, body: problem(422, 'host_visible_unavailable') }) })
    const onChanged = vi.fn()
    render(<ParticipantsCard meeting={linked()} hostInfo={crmDealHost} onChanged={onChanged} />)

    await userEvent.click(screen.getByRole('checkbox', { name: label }))
    await userEvent.click(screen.getByRole('button', { name: v.confirm }))

    expect(await screen.findByText(en.common.errors.host_visible_unavailable)).not.toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(false)
  })

  it('a host that is gone replaces the checkbox with the sentence that its visibility ended', () => {
    serve()
    render(
      <ParticipantsCard
        meeting={linked({ host: hostView({ state: 'missing', title: null, href: null }), hostVisible: true })}
        hostInfo={crmDealHost}
        onChanged={vi.fn()}
      />,
    )
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByText(v.hostGone)).not.toBeNull()
  })
})

describe('EditParticipantsDialog: Operai people from the directory (G9)', () => {
  const open = (meeting: Meeting = readyMeeting()) => {
    const onClose = vi.fn()
    const onChanged = vi.fn()
    render(<EditParticipantsDialog meeting={meeting} onClose={onClose} onChanged={onChanged} />)
    return { onClose, onChanged }
  }
  const picker = () => screen.getByRole('combobox', { name: new RegExp(d.addOperai) })

  it('asks the directory WITHOUT appId, once: a participant needs no tool grant (AC-10.4)', async () => {
    const api = serve()
    open()
    await vi.waitFor(() => expect(requests(api, 'GET', '/authz/users/directory')).toHaveLength(1))
    const url = new URL(String(requests(api, 'GET', '/authz/users/directory')[0]![0]))
    expect(url.origin).toBe('http://auth.test')
    expect(url.searchParams.has('appId')).toBe(false)
    expect(url.search).toBe('')
  })

  it('picking a person adds them to the list and takes them out of the choices; the field empties', async () => {
    const user = userEvent.setup()
    serve()
    open()

    await user.click(picker())
    await user.type(picker(), 'Gra')
    await user.click(await screen.findByRole('option', { name: /Grace Hopper/ }))

    const list = screen.getByRole('list', { name: d.listLabel })
    expect(within(list).getByText('Grace Hopper')).not.toBeNull()
    expect((picker() as HTMLInputElement).value).toBe('')

    await user.type(picker(), 'Gra')
    expect(screen.queryByRole('option', { name: /Grace Hopper/ })).toBeNull()
  })

  it('shows the people already on the meeting, a deleted user as "Deleted user", and an external with their organisation', () => {
    serve()
    open(
      readyMeeting({ participants: [operai('p1', GRACE), operai('p2', GONE), external('p3', 'Zed Client', 'Acme')] }),
    )
    const list = screen.getByRole('list', { name: d.listLabel })
    expect(within(list).getByText('Grace Hopper')).not.toBeNull()
    expect(within(list).getByText(en.participants.card.deletedUser)).not.toBeNull()
    expect(within(list).getByText('Zed Client')).not.toBeNull()
    expect(within(list).getByText('Acme')).not.toBeNull()
    expect(within(list).getByText(d.external)).not.toBeNull()
    expect(screen.getByText(d.count(3, 30))).not.toBeNull()
  })

  it('a directory that is rate limited says how long to wait', async () => {
    const user = userEvent.setup()
    serve({
      'GET /authz/users/directory': () => ({ status: 429, body: problem(429), headers: { 'Retry-After': '30' } }),
    })
    open()
    await user.click(picker())
    expect(await screen.findByText(d.picker.rateLimited(30))).not.toBeNull()
  })

  it('a directory the caller may not read leaves a read-only field with the reason', async () => {
    serve({ 'GET /authz/users/directory': () => ({ status: 403, body: problem(403) }) })
    open()
    expect(await screen.findByText(d.picker.unavailableHint)).not.toBeNull()
  })

  it('any other directory failure says people cannot be loaded', async () => {
    const user = userEvent.setup()
    serve({ 'GET /authz/users/directory': () => ({ status: 500, body: problem(500) }) })
    open()
    await user.click(picker())
    expect(await screen.findByText(d.picker.failed)).not.toBeNull()
  })
})

describe('EditParticipantsDialog: external people', () => {
  const open = (meeting: Meeting = readyMeeting()) => {
    const onClose = vi.fn()
    const onChanged = vi.fn()
    render(<EditParticipantsDialog meeting={meeting} onClose={onClose} onChanged={onChanged} />)
    return { onClose, onChanged }
  }
  const nameField = () => screen.getByLabelText(new RegExp(`^${d.name}`)) as HTMLInputElement
  const organisationField = () => screen.getByLabelText(new RegExp(`^${d.organisation}`)) as HTMLInputElement
  const add = () => userEvent.click(screen.getByRole('button', { name: d.add }))

  it('adds an external person with a name and an organisation, then clears the fields and refocuses the name', async () => {
    serve()
    open()
    await userEvent.type(nameField(), 'Zed Client')
    await userEvent.type(organisationField(), 'Acme')
    await add()

    const list = screen.getByRole('list', { name: d.listLabel })
    expect(within(list).getByText('Zed Client')).not.toBeNull()
    expect(within(list).getByText('Acme')).not.toBeNull()
    expect(nameField().value).toBe('')
    expect(organisationField().value).toBe('')
    expect(document.activeElement).toBe(nameField())
  })

  it('the organisation is optional', async () => {
    serve()
    open()
    await userEvent.type(nameField(), 'Zed Client')
    await add()
    expect(within(screen.getByRole('list', { name: d.listLabel })).getByText('Zed Client')).not.toBeNull()
  })

  it('a name is 1 to 100 characters: empty and over-long are refused with a message on the field', async () => {
    serve()
    open()
    await add()
    expect(await screen.findByText(d.errors.nameRequired)).not.toBeNull()
    expect(nameField().getAttribute('aria-invalid')).toBe('true')
    expect(screen.queryByRole('list', { name: d.listLabel })).toBeNull()

    await userEvent.type(nameField(), '   ')
    await add()
    expect(screen.getByText(d.errors.nameRequired)).not.toBeNull()

    await userEvent.clear(nameField())
    await userEvent.click(nameField())
    await userEvent.paste('x'.repeat(101))
    await add()
    expect(screen.getByText(d.errors.nameTooLong)).not.toBeNull()
    expect(screen.queryByRole('list', { name: d.listLabel })).toBeNull()

    await userEvent.clear(nameField())
    await userEvent.paste('x'.repeat(100))
    await add()
    expect(within(screen.getByRole('list', { name: d.listLabel })).getByText('x'.repeat(100))).not.toBeNull()
  })

  it('an organisation over 100 characters is refused', async () => {
    serve()
    open()
    await userEvent.type(nameField(), 'Zed')
    await userEvent.click(organisationField())
    await userEvent.paste('o'.repeat(101))
    await add()
    expect(await screen.findByText(d.errors.organisationTooLong)).not.toBeNull()
    expect(screen.queryByRole('list', { name: d.listLabel })).toBeNull()
  })

  it('trims the name and the organisation', async () => {
    const api = serve({ 'PUT /meetings/:id/participants': () => ({ status: 200, body: readyMeeting() }) })
    open()
    await userEvent.type(nameField(), '  Zed Client  ')
    await userEvent.type(organisationField(), '  Acme  ')
    await add()
    await userEvent.click(screen.getByRole('button', { name: d.save }))
    await vi.waitFor(() => expect(requests(api, 'PUT', '/meetings/m1/participants')).toHaveLength(1))
    expect(JSON.parse(String(requests(api, 'PUT', '/meetings/m1/participants')[0]![1]?.body))).toEqual({
      participants: [{ name: 'Zed Client', organisation: 'Acme' }],
    })
  })
})

describe('EditParticipantsDialog: the limit of 30 (AC-5.1)', () => {
  it('at 29 one more external person fits; the 31st is blocked and the limit is stated', async () => {
    serve()
    render(
      <EditParticipantsDialog
        meeting={readyMeeting({ participants: manyExternals(29) })}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    )
    const nameField = () => screen.getByLabelText(new RegExp(`^${d.name}`)) as HTMLInputElement
    const add = () => userEvent.click(screen.getByRole('button', { name: d.add }))

    expect(screen.queryByText(d.limit)).toBeNull()
    await userEvent.type(nameField(), 'The thirtieth')
    await add()
    expect(screen.getByText(d.count(30, 30))).not.toBeNull()
    expect(screen.getByText(d.limit)).not.toBeNull()

    await userEvent.type(nameField(), 'The thirty-first')
    expect(screen.getByRole('button', { name: d.add }).getAttribute('aria-disabled')).toBe('true')
    await add()
    expect(screen.getByText(d.count(30, 30))).not.toBeNull()
    expect(screen.queryByText('The thirty-first', { selector: 'li *' })).toBeNull()
    expect(within(screen.getByRole('list', { name: d.listLabel })).getAllByRole('listitem')).toHaveLength(30)
  })

  it('at 30 the Operai picker is out of reach too, so a person cannot be added through it', async () => {
    serve()
    render(
      <EditParticipantsDialog
        meeting={readyMeeting({ participants: manyExternals(30) })}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    )
    const picker = screen.getByRole('combobox', { name: new RegExp(d.addOperai) }) as HTMLInputElement
    expect(picker.matches(':disabled')).toBe(true)
    expect(screen.getByText(d.limit)).not.toBeNull()
  })

  it('removing one at the limit makes room again', async () => {
    serve()
    render(
      <EditParticipantsDialog
        meeting={readyMeeting({ participants: manyExternals(30) })}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: d.remove('Guest 1') }))
    expect(screen.queryByText(d.limit)).toBeNull()
    expect(screen.getByRole('button', { name: d.add }).getAttribute('aria-disabled')).not.toBe('true')
  })
})

describe('EditParticipantsDialog: removing, and where focus goes (S4)', () => {
  const three = () => readyMeeting({ participants: [external('a', 'Ann'), external('b', 'Bob'), external('c', 'Cy')] })

  it('removing a person takes them off the list', async () => {
    serve()
    render(<EditParticipantsDialog meeting={three()} onClose={vi.fn()} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: d.remove('Bob') }))
    expect(screen.queryByText('Bob')).toBeNull()
    expect(screen.getByText(d.count(2, 30))).not.toBeNull()
  })

  it('focus moves to the next Remove button', async () => {
    serve()
    render(<EditParticipantsDialog meeting={three()} onClose={vi.fn()} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: d.remove('Ann') }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: d.remove('Bob') }))
    await userEvent.click(screen.getByRole('button', { name: d.remove('Bob') }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: d.remove('Cy') }))
  })

  it('removing the last one moves focus to the Operai picker', async () => {
    serve()
    render(<EditParticipantsDialog meeting={three()} onClose={vi.fn()} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: d.remove('Cy') }))
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: new RegExp(d.addOperai) }))
  })
})

describe('EditParticipantsDialog: saving (AC-5.1, AC-5.4)', () => {
  const body = (api: ReturnType<typeof fakeApi>) =>
    JSON.parse(String(requests(api, 'PUT', '/meetings/m1/participants')[0]![1]?.body)) as unknown

  it('sends the full list: Operai people by id, external people by name and organisation', async () => {
    const saved = readyMeeting()
    const api = serve({ 'PUT /meetings/:id/participants': () => ({ status: 200, body: saved }) })
    const onChanged = vi.fn()
    const onClose = vi.fn()
    render(
      <EditParticipantsDialog
        meeting={readyMeeting({
          participants: [operai('p1', GRACE), external('p2', 'Zed Client', 'Acme'), external('p3', 'Solo')],
        })}
        onClose={onClose}
        onChanged={onChanged}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: d.remove('Solo') }))
    await userEvent.click(screen.getByRole('button', { name: d.save }))

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onChanged).toHaveBeenCalledWith(saved)
    expect(body(api)).toEqual({ participants: [{ userId: 'u-grace' }, { name: 'Zed Client', organisation: 'Acme' }] })
  })

  it('an unchanged list closes without a request', async () => {
    const api = serve()
    const onClose = vi.fn()
    render(
      <EditParticipantsDialog
        meeting={readyMeeting({ participants: [external('p2', 'Zed Client')] })}
        onClose={onClose}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: d.save }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requests(api, 'PUT', '/meetings/m1/participants')).toHaveLength(0)
  })

  it('a person without an active account (422 participant_not_active) is named on their own row, by index', async () => {
    serve({
      'PUT /meetings/:id/participants': () => ({
        status: 422,
        body: problem(422, 'participant_not_active', { index: 1 }),
      }),
    })
    render(
      <EditParticipantsDialog
        meeting={readyMeeting({ participants: [external('p1', 'Ann'), operai('p2', GONE), external('p3', 'Cy'), external('p4', 'Di')] })}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: d.remove('Di') }))
    await userEvent.click(screen.getByRole('button', { name: d.save }))
    const rows = () => within(screen.getByRole('list', { name: d.listLabel })).getAllByRole('listitem')
    await vi.waitFor(() => expect(rows()[1]!.textContent).toContain(d.notActive))
    expect(rows()[0]!.textContent).not.toContain(d.notActive)
    expect(rows()[2]!.textContent).not.toContain(d.notActive)
  })

  it.each([
    ['too_many_participants', 422],
    ['identity_unavailable', 503],
  ] as const)('%s shows as a form error and keeps the dialog open with its edits', async (code, status) => {
    serve({ 'PUT /meetings/:id/participants': () => ({ status, body: problem(status, code) }) })
    const onClose = vi.fn()
    render(
      <EditParticipantsDialog
        meeting={readyMeeting({ participants: [external('p1', 'Ann'), external('p2', 'Bob')] })}
        onClose={onClose}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: d.remove('Ann') }))
    await userEvent.click(screen.getByRole('button', { name: d.save }))

    expect(await screen.findByText(en.common.errors[code])).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('Ann')).toBeNull()
  })

  it('Cancel closes without saving', async () => {
    const api = serve()
    const onClose = vi.fn()
    render(<EditParticipantsDialog meeting={readyMeeting()} onClose={onClose} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: en.common.cancel }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(requests(api, 'PUT', '/meetings/m1/participants')).toHaveLength(0)
  })

  it('the creator is not in the list: they are never a participant entry (the card shows them)', () => {
    serve()
    render(<EditParticipantsDialog meeting={readyMeeting({ creator: ADA })} onClose={vi.fn()} onChanged={vi.fn()} />)
    expect(screen.queryByRole('list', { name: d.listLabel })).toBeNull()
    expect(screen.getByText(d.empty)).not.toBeNull()
  })
})
