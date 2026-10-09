/**
 * @vitest-environment jsdom
 *
 * Component tests for InvoiceFilePanel (T35, specs/015-hardware-inventory; design.md
 * F8, § T2 invoice region, § Error and conflict catalogue, § Accessibility "Invoice
 * panel"; refs AC-10.4, AC-10.5, AC-10.6 and the Resolutions G6/Q2). The HTTP seam
 * is `lib/api` (`sendJson`, `getJson`) plus the global `fetch` for the bucket POST,
 * so the real mint -> upload -> confirm sequence is what is asserted;
 * `assetsApi.listAssets` is the sibling lookup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ApiError } from '../lib/api'
import type { AssetListItem, AssetView } from '../lib/types'

const { sendJson, getJson, listAssets } = vi.hoisted(() => ({
  sendJson: vi.fn(),
  getJson: vi.fn(),
  listAssets: vi.fn(),
}))
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  sendJson,
  getJson,
}))
vi.mock('../lib/assetsApi', () => ({ listAssets }))

import InvoiceFilePanel from './InvoiceFilePanel'

const asset = (over: Partial<AssetView> = {}): AssetView => ({
  id: 'a1',
  entity: 'welld_ch',
  currency: 'CHF',
  category: 'laptop',
  description: 'MacBook Pro 14',
  serialNumber: 'SN123',
  purchaseDate: '2026-09-25',
  purchasePriceCents: 99815,
  status: 'in_stock',
  holder: null,
  pendingAssignment: null,
  locationNote: null,
  supplier: null,
  invoiceRef: 'INV-77',
  invoiceFile: null,
  toVerify: false,
  disposal: null,
  ...over,
})

const sibling = (id: string, description: string, over: Partial<AssetListItem> = {}): AssetListItem => ({
  ...asset({ id, description, serialNumber: `SN-${id}` }),
  ...over,
})

const MANAGER = { canManageAssets: true, canManageLedger: false }
const ACCOUNTANT = { canManageAssets: false, canManageLedger: true }
const onChanged = vi.fn()
const announce = vi.fn()
const focusHeading = vi.fn()
const fetchMock = vi.fn()

const renderPanel = (a: AssetView = asset(), capabilities = MANAGER) =>
  render(
    <InvoiceFilePanel
      asset={a}
      capabilities={capabilities}
      onChanged={onChanged}
      announce={announce}
      focusHeading={focusHeading}
    />,
  )

const fileOf = (name: string, type: string, size = 1024) => {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}
const choose = (file: File) => {
  const input = screen.getByTestId('invoice-file-input') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}
const apiError = (status: number, code?: string, extras: Record<string, unknown> = {}) =>
  new ApiError({ status, title: 'x', code, extras })

/** The happy path of the three upload calls; the link call resolves too. */
const happyUpload = () => {
  sendJson.mockImplementation((path: string) => {
    if (path === '/invoice-files') {
      return Promise.resolve({
        id: 'f1',
        upload: { url: 'https://bucket.example/post', fields: { key: 'k1', policy: 'p' } },
      })
    }
    if (path === '/invoice-files/f1/confirm') return Promise.resolve({ id: 'f1', fileName: 'inv.pdf' })
    if (path === '/invoice-files/f1/assets') return Promise.resolve({ linked: ['a1'] })
    return Promise.reject(new Error(`unexpected ${path}`))
  })
  fetchMock.mockResolvedValue({ ok: true, status: 204 })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  listAssets.mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('InvoiceFilePanel — upload (AC-10.4)', () => {
  it('mints, uploads to the bucket, confirms, then links the file to this asset and reloads the page', async () => {
    happyUpload()
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf', 2048))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null))

    expect(sendJson.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['/invoice-files', 'POST'],
      ['/invoice-files/f1/confirm', 'POST'],
      ['/invoice-files/f1/assets', 'PUT'],
    ])
    expect(sendJson.mock.calls[0][2]).toEqual({
      entity: 'welld_ch',
      invoiceRef: 'INV-77',
      fileName: 'inv.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    })
    expect(sendJson.mock.calls[2][2]).toEqual({ assetIds: ['a1'] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://bucket.example/post')
    const form = fetchMock.mock.calls[0][1].body as FormData
    expect(Array.from(form.keys())).toEqual(['key', 'policy', 'file'])
    expect(announce).toHaveBeenCalledWith('Invoice file inv.pdf saved.')
  })

  it('shows the uploading phase politely while the request is in flight', async () => {
    let release: (value: unknown) => void = () => undefined
    sendJson.mockImplementation(() => new Promise((resolve) => (release = resolve)))
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))

    expect(await screen.findByText('Uploading inv.pdf…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Upload invoice' }).getAttribute('aria-disabled')).toBe('true')
    release({ id: 'f1', upload: { url: 'u', fields: {} } })
  })

  it('rejects a file of the wrong type before any request, and keeps the reason until dismissed (AC-10.6)', () => {
    renderPanel()
    choose(fileOf('notes.txt', 'text/plain'))

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('notes.txt')
    expect(alert.textContent).toContain('Only PDF, JPEG or PNG files can be uploaded.')
    expect(sendJson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('rejects an oversize file before any request (AC-10.6)', () => {
    renderPanel()
    choose(fileOf('big.pdf', 'application/pdf', 10 * 1024 * 1024 + 1))

    expect(screen.getByRole('alert').textContent).toContain('This file is larger than 10 MiB.')
    expect(sendJson).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [413, 'This file is larger than 10 MiB.'],
    [415, 'Only PDF, JPEG or PNG files can be uploaded.'],
  ])('shows the server %i again, and nothing is uploaded', async (status, message) => {
    sendJson.mockRejectedValue(apiError(status))
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))

    expect((await screen.findByRole('alert')).textContent).toContain(message)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('says the upload did not complete on upload_not_found, with no link made', async () => {
    happyUpload()
    sendJson.mockImplementation((path: string) =>
      path === '/invoice-files'
        ? Promise.resolve({ id: 'f1', upload: { url: 'https://bucket.example/post', fields: {} } })
        : Promise.reject(apiError(409, 'upload_not_found')),
    )
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))

    expect((await screen.findByRole('alert')).textContent).toContain('The upload did not complete. Try again.')
    expect(sendJson.mock.calls.some((call) => String(call[0]).endsWith('/assets'))).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('says too many uploads are pending on a 429 too_many_pending_uploads, with no bucket request', async () => {
    sendJson.mockRejectedValue(apiError(429, 'too_many_pending_uploads'))
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Too many uploads are waiting to be completed. Try again in an hour.')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('shows the authorization-unavailable message on a 503', async () => {
    sendJson.mockRejectedValue(apiError(503))
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))

    expect((await screen.findByRole('alert')).textContent).toContain('We cannot verify your access right now.')
  })

  it('keeps the file and offers to retry the link when only the link to this asset failed', async () => {
    happyUpload()
    let linkAttempts = 0
    sendJson.mockImplementation((path: string) => {
      if (path === '/invoice-files') {
        return Promise.resolve({ id: 'f1', upload: { url: 'https://bucket.example/post', fields: {} } })
      }
      if (path === '/invoice-files/f1/confirm') return Promise.resolve({ id: 'f1', fileName: 'inv.pdf' })
      linkAttempts += 1
      return linkAttempts === 1 ? Promise.reject(apiError(503)) : Promise.resolve({ linked: ['a1'] })
    })
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('could not be linked to this asset')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try linking again' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(null))
    // the file is not uploaded a second time
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sendJson.mock.calls.filter((call) => call[0] === '/invoice-files')).toHaveLength(1)
  })

  it('blocks the upload with a described reason while the asset has no invoice reference', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    renderPanel(asset({ invoiceRef: null }))

    const button = screen.getByRole('button', { name: 'Upload invoice' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '')
    expect(reason?.textContent).toContain('Set an invoice reference first')
    fireEvent.click(button)
    expect(click).not.toHaveBeenCalled()
    click.mockRestore()
  })

  it('opens the file picker from the button when an invoice reference is set', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Upload invoice' }))
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })
})

describe('InvoiceFilePanel — siblings (AC-10.5, Q2)', () => {
  const uploadThenSiblings = async () => {
    happyUpload()
    listAssets.mockResolvedValue({
      items: [
        sibling('a1', 'MacBook Pro 14'),
        sibling('a2', 'Dell U2723QE'),
        sibling('a3', 'Dell U2723QE second'),
        sibling('a4', 'Scrapped monitor', { status: 'disposed' }),
        sibling('a5', 'Already linked', { invoiceFile: { id: 'f1', fileName: 'inv.pdf' } }),
      ],
      nextCursor: null,
    })
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))
    return await screen.findByRole('group', { name: 'Link to assets with invoice reference INV-77' })
  }

  it('offers the other assets with the same reference that are open and not yet linked', async () => {
    const group = await uploadThenSiblings()

    expect(listAssets).toHaveBeenCalledWith({ entity: 'welld_ch', invoiceRef: 'INV-77' })
    const labels = within(group)
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('aria-label') ?? box.closest('label')?.textContent)
    expect(labels).toEqual(['Dell U2723QE (SN-a2)', 'Dell U2723QE second (SN-a3)'])
  })

  it('links the selected assets to the uploaded file and announces the count', async () => {
    const group = await uploadThenSiblings()
    expect(screen.getByText('0 selected')).toBeTruthy()
    fireEvent.click(within(group).getByRole('checkbox', { name: /Dell U2723QE \(SN-a2\)/ }))
    expect(screen.getByText('1 selected')).toBeTruthy()

    sendJson.mockClear()
    sendJson.mockResolvedValue({ linked: ['a2'] })
    fireEvent.click(screen.getByRole('button', { name: 'Link selected' }))

    await waitFor(() => expect(announce).toHaveBeenCalledWith('Invoice linked to 1 more asset.'))
    expect(sendJson).toHaveBeenCalledWith('/invoice-files/f1/assets', 'PUT', { assetIds: ['a2'] })
    expect(screen.queryByRole('group', { name: /Link to assets/ })).toBeNull()
  })

  it('does not call the API when nothing is selected', async () => {
    await uploadThenSiblings()
    sendJson.mockClear()
    const button = screen.getByRole('button', { name: 'Link selected' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(sendJson).not.toHaveBeenCalled()
  })

  it('names the asset on invoice_ref_mismatch and keeps the list for another try', async () => {
    const group = await uploadThenSiblings()
    fireEvent.click(within(group).getByRole('checkbox', { name: /Dell U2723QE \(SN-a2\)/ }))
    sendJson.mockClear()
    sendJson.mockRejectedValue(apiError(409, 'invoice_ref_mismatch', { assetId: 'a2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Link selected' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Dell U2723QE has a different invoice reference and was not linked.')
    expect(screen.getByRole('group', { name: /Link to assets/ })).toBeTruthy()
  })

  it('offers nothing when no other asset shares the reference', async () => {
    happyUpload()
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))
    await waitFor(() => expect(listAssets).toHaveBeenCalled())
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.queryByRole('group', { name: /Link to assets/ })).toBeNull()
  })

  it('says so, with a retry, when the sibling lookup fails; the upload itself stays done', async () => {
    happyUpload()
    listAssets.mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce({
      items: [sibling('a2', 'Dell U2723QE')],
      nextCursor: null,
    })
    renderPanel()
    choose(fileOf('inv.pdf', 'application/pdf'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not look up other assets')
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('group', { name: /Link to assets/ })).toBeTruthy()
  })

  it('can be dismissed with Not now', async () => {
    await uploadThenSiblings()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('group', { name: /Link to assets/ })).toBeNull()
  })
})

describe('InvoiceFilePanel — open (AC-10.4)', () => {
  it('requests a fresh URL on every open and navigates the new tab to it', async () => {
    const tabs: { location: { href: string }; opener: unknown; close: () => void }[] = []
    vi.spyOn(window, 'open').mockImplementation(() => {
      const tab = { location: { href: '' }, opener: 'x', close: vi.fn() }
      tabs.push(tab)
      return tab as unknown as Window
    })
    getJson
      .mockResolvedValueOnce({ url: 'https://s3.example/one', expiresInSeconds: 60 })
      .mockResolvedValueOnce({ url: 'https://s3.example/two', expiresInSeconds: 60 })
    renderPanel(asset({ invoiceFile: { id: 'f1', fileName: 'inv.pdf' } }))

    const open = screen.getByRole('button', { name: /Open invoice/ })
    fireEvent.click(open)
    await waitFor(() => expect(tabs[0]?.location.href).toBe('https://s3.example/one'))
    fireEvent.click(open)
    await waitFor(() => expect(tabs[1]?.location.href).toBe('https://s3.example/two'))

    expect(getJson).toHaveBeenCalledTimes(2)
    expect(getJson.mock.calls[0][0]).toBe('/invoice-files/f1/url')
    expect(tabs[0].opener).toBeNull()
  })

  it('closes the blank tab and says so when the URL cannot be minted', async () => {
    const tab = { location: { href: '' }, opener: 'x', close: vi.fn() }
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    getJson.mockRejectedValue(apiError(404))
    renderPanel(asset({ invoiceFile: { id: 'f1', fileName: 'inv.pdf' } }))

    fireEvent.click(screen.getByRole('button', { name: /Open invoice/ }))

    expect((await screen.findByRole('alert')).textContent).toContain('Could not open the invoice.')
    expect(tab.close).toHaveBeenCalled()
  })

  it('shows the reference and file name, and an empty state without a file', () => {
    const { unmount } = renderPanel(asset({ invoiceFile: { id: 'f1', fileName: 'inv.pdf' } }))
    expect(screen.getByText('INV-77')).toBeTruthy()
    expect(screen.getByText('inv.pdf')).toBeTruthy()
    unmount()
    renderPanel()
    expect(screen.getByText('No invoice file yet.')).toBeTruthy()
  })
})

describe('InvoiceFilePanel — capabilities and state', () => {
  it.each([
    ['manager', MANAGER],
    ['accountant', ACCOUNTANT],
  ])('lets a %s upload (AC-10.4: either capability)', (_name, capabilities) => {
    renderPanel(asset(), capabilities)
    expect(screen.getByRole('button', { name: 'Upload invoice' })).toBeTruthy()
  })

  it('is read-only on a disposed asset: the file still opens, nothing can be uploaded or linked', () => {
    renderPanel(
      asset({
        status: 'disposed',
        invoiceFile: { id: 'f1', fileName: 'inv.pdf' },
        disposal: { disposedOn: '2026-10-01', reason: 'scrapped', salePriceCents: null },
      }),
    )

    expect(screen.getByRole('button', { name: /Open invoice/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Upload/ })).toBeNull()
    expect(screen.queryByTestId('invoice-file-input')).toBeNull()
    expect(screen.getByText(/can no longer be changed/)).toBeTruthy()
  })

  it('has no remove, delete or unlink control, with or without a file (re-linking replaces)', () => {
    const { unmount } = renderPanel(asset({ invoiceFile: { id: 'f1', fileName: 'inv.pdf' } }))
    expect(screen.queryByRole('button', { name: /remove|delete|unlink|detach/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Upload a new file' })).toBeTruthy()
    unmount()
    renderPanel()
    expect(screen.queryByRole('button', { name: /remove|delete|unlink|detach/i })).toBeNull()
  })
})
