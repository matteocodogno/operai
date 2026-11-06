/**
 * @vitest-environment jsdom
 *
 * ReferentPicker (AC-3.6, T18 M5): the referent of a purchase order is chosen among the non-archived CRM
 * contacts of the company the server derives — listed as name and job title, optional (it may stay
 * empty), read again every time the picker opens and kept in memory only, with the CRM's absence said
 * in its own words and never blocking the form.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { ContactChoice } from '../lib/types'
import ReferentPicker from './ReferentPicker'

const CONTACTS: ContactChoice[] = [
  { id: 'k1', name: 'Jane Roe', jobTitle: 'CTO' },
  { id: 'k2', name: 'Max Mustermann', jobTitle: null },
]

const failure = (status: number, code: string) =>
  new ApiError({ status, title: 'Problem', detail: 'server detail that must not be shown', code })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type Load = (signal: AbortSignal) => Promise<{ items: ContactChoice[] }>

const renderPicker = (load: Load, value: string | null = null, onChange = vi.fn()) => {
  render(<ReferentPicker load={load} value={value} onChange={onChange} testId="referent" />)
  return onChange
}
const select = () => screen.getByLabelText(/^Referent/) as HTMLSelectElement
const optionTexts = () => Array.from(select().options).map((option) => option.textContent)

describe('the contacts to choose from', () => {
  it('lists the contacts as name and job title, after a "No referent" choice, and nothing is chosen by default', async () => {
    renderPicker(() => Promise.resolve({ items: CONTACTS }))
    await waitFor(() => expect(optionTexts()).toEqual(['No referent', 'Jane Roe — CTO', 'Max Mustermann']))
    expect(select().value).toBe('')
  })

  it('may stay empty: the form does not need a referent, and a company with no contacts says so', async () => {
    const onChange = renderPicker(() => Promise.resolve({ items: [] }))
    expect(
      await screen.findByText('This company has no contacts in the CRM, so there is no referent to choose.'),
    ).not.toBeNull()
    expect(optionTexts()).toEqual(['No referent'])
    expect(onChange).not.toHaveBeenCalled()
    expect(select().getAttribute('aria-required')).toBeNull()
  })

  it('says it is loading until the contacts arrive', async () => {
    let resolve: (value: { items: ContactChoice[] }) => void = () => undefined
    renderPicker(() => new Promise((done) => (resolve = done)))
    expect(optionTexts()).toEqual(['Loading the contacts…'])
    resolve({ items: CONTACTS })
    await waitFor(() => expect(optionTexts()).toHaveLength(3))
  })

  it('hands a chosen contact to the form as its id, and "No referent" as null', async () => {
    const onChange = renderPicker(() => Promise.resolve({ items: CONTACTS }))
    await waitFor(() => expect(optionTexts()).toHaveLength(3))
    fireEvent.change(select(), { target: { value: 'k2' } })
    expect(onChange).toHaveBeenLastCalledWith('k2')
    fireEvent.change(select(), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('shows the contact the form holds as chosen', async () => {
    renderPicker(() => Promise.resolve({ items: CONTACTS }), 'k1')
    await waitFor(() => expect(select().value).toBe('k1'))
  })

  it('renders a contact’s fields as text, never as markup', async () => {
    renderPicker(() =>
      Promise.resolve({ items: [{ id: 'k9', name: '<img src=x onerror=alert(1)>', jobTitle: '<b>CEO</b>' }] }),
    )
    await waitFor(() => expect(optionTexts()).toEqual(['No referent', '<img src=x onerror=alert(1)> — <b>CEO</b>']))
    expect(document.querySelector('img')).toBeNull()
  })
})

describe('the contacts are personal data: read on open, kept in memory only (T18 M5)', () => {
  it('asks the CRM again every time the picker opens', async () => {
    const load = vi.fn<Load>(() => Promise.resolve({ items: CONTACTS }))
    renderPicker(load)
    await waitFor(() => expect(optionTexts()).toHaveLength(3))
    cleanup()
    renderPicker(load)
    await waitFor(() => expect(optionTexts()).toHaveLength(3))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('writes nothing to the browser’s storage', async () => {
    const setItem = vi.fn()
    const storage = { setItem, getItem: () => null, removeItem: vi.fn(), clear: vi.fn() }
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
    renderPicker(() => Promise.resolve({ items: CONTACTS }))
    await waitFor(() => expect(optionTexts()).toHaveLength(3))
    fireEvent.change(select(), { target: { value: 'k1' } })
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('when the contacts cannot be listed', () => {
  it('says why in its own words and not with the server’s detail, and the form stays usable without a referent', async () => {
    const onChange = renderPicker(() => Promise.reject(failure(503, 'crm_unavailable')))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The contacts could not be loaded.')
    expect(alert.textContent).toContain('The CRM cannot be reached right now.')
    expect(alert.textContent).not.toContain('server detail')
    expect(optionTexts()).toEqual(['No referent'])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('offers to try again, which reads the contacts again', async () => {
    const load = vi
      .fn<Load>()
      .mockRejectedValueOnce(failure(503, 'crm_unavailable'))
      .mockResolvedValueOnce({ items: CONTACTS })
    renderPicker(load)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(optionTexts()).toHaveLength(3))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a refusal of the take (the deal is gone, out of scope) is said in the take’s words', async () => {
    renderPicker(() => Promise.reject(failure(403, 'out_of_scope')))
    expect((await screen.findByRole('alert')).textContent).toContain('You may not take deals of this entity.')
  })

  it('a failure with no words of ours shows the server’s detail', async () => {
    renderPicker(() => Promise.reject(new ApiError({ status: 500, title: 'Problem', detail: 'Boom' })))
    expect((await screen.findByRole('alert')).textContent).toContain('Boom')
  })
})

describe('a caller with its own wording (the purchase order’s edit)', () => {
  it('says a failed read in the words it passes, and its own hint, instead of the take form’s', async () => {
    render(
      <ReferentPicker
        load={() => Promise.reject(failure(403, 'out_of_scope'))}
        value={null}
        onChange={() => undefined}
        failureText={() => 'Their own words.'}
        hint="Their own hint."
        testId="referent"
      />,
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Their own words.Retry')
    expect(alert.textContent).not.toContain('take deals')
    expect(screen.getByText('Their own hint.')).not.toBeNull()
    expect(screen.queryByText(/You can set it later/)).toBeNull()
  })
})

describe('a refusal of the chosen referent', () => {
  it('is shown on the field, which is then invalid', async () => {
    render(
      <ReferentPicker
        load={() => Promise.resolve({ items: CONTACTS })}
        value="k1"
        onChange={() => undefined}
        error="This contact cannot be the referent."
        testId="referent"
      />,
    )
    await waitFor(() => expect(optionTexts()).toHaveLength(3))
    expect(select().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('This contact cannot be the referent.')).not.toBeNull()
  })
})
