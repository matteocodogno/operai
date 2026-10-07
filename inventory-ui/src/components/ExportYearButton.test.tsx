/**
 * @vitest-environment jsdom
 *
 * Component tests for ExportYearButton (T39, specs/015-hardware-inventory; design.md
 * F12 step 5, § Accessibility "T6 year detail"; refs AC-8.8, AC-8.9). The real
 * builder runs (it has its own tests); the browser seams — `URL.createObjectURL`
 * and the anchor click that starts a download — are faked and recorded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ExportYearButton from './ExportYearButton'
import type { FiscalYearView } from '../lib/types'

const view = (over: Partial<FiscalYearView> = {}): FiscalYearView => ({
  entity: 'welld_ch',
  year: 2026,
  currency: 'CHF',
  status: 'open',
  closedAt: null,
  rollForward: {
    openingCents: 100,
    disposalsCents: 0,
    purchasesCents: 50,
    depreciationCents: 25,
    closingCents: 125,
  },
  assets: [],
  ...over,
})

type Download = { name: string; href: string }
let downloads: Download[]
let blobs: Blob[]
let revoked: string[]
let createObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  downloads = []
  blobs = []
  revoked = []
  createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob)
    return 'blob:fake-url'
  })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => revoked.push(url),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const click = () => fireEvent.click(screen.getByRole('button', { name: 'Export XLSX' }))

describe('ExportYearButton', () => {
  it('is an enabled button named "Export XLSX" that has built nothing yet', () => {
    render(<ExportYearButton view={view()} />)
    const button = screen.getByRole('button', { name: 'Export XLSX' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-busy')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('downloads an XLSX of the year: spreadsheet MIME type, non-empty, named by entity and year', async () => {
    render(<ExportYearButton view={view({ status: 'closed', closedAt: '2026-12-31T10:00:00Z' })} />)
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0]).toEqual({ name: 'welld_ch_fiscal-year-2026.xlsx', href: 'blob:fake-url' })
    expect(blobs[0].type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(blobs[0].size).toBeGreaterThan(0)
  })

  it('marks the file name provisional for an open year (AC-8.9)', async () => {
    render(<ExportYearButton view={view({ status: 'open' })} />)
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(downloads[0].name).toBe('welld_ch_fiscal-year-2026_provisional.xlsx')
  })

  it('shows a busy state with a polite "Preparing file" line, then "File ready"', async () => {
    render(<ExportYearButton view={view()} />)
    click()
    const button = screen.getByRole('button', { name: 'Export XLSX' })
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Preparing file…')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('File ready'))
    expect(screen.getByRole('button', { name: 'Export XLSX' }).getAttribute('aria-busy')).toBeNull()
  })

  it('ignores a second click while the file is being built', async () => {
    render(<ExportYearButton view={view()} />)
    click()
    click()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('File ready'))
    expect(downloads).toHaveLength(1)
  })

  it('releases the object URL after handing the file over', async () => {
    render(<ExportYearButton view={view()} />)
    click()
    await waitFor(() => expect(revoked).toEqual(['blob:fake-url']))
  })

  it('can export again after a successful export', async () => {
    render(<ExportYearButton view={view()} />)
    click()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('File ready'))
    click()
    await waitFor(() => expect(downloads).toHaveLength(2))
  })

  it('shows an alert when the file cannot be prepared, and allows another try', async () => {
    createObjectURL.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    render(<ExportYearButton view={view()} />)
    click()
    expect((await screen.findByRole('alert')).textContent).toBe('The export could not be prepared. Try again.')
    expect(downloads).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Export XLSX' }).getAttribute('aria-busy')).toBeNull()
    click()
    await waitFor(() => expect(downloads).toHaveLength(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops a "File ready" line that belongs to the open (provisional) year once the year is closed', async () => {
    const { rerender } = render(<ExportYearButton view={view({ status: 'open' })} />)
    click()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('File ready'))
    rerender(<ExportYearButton view={view({ status: 'closed', closedAt: '2026-12-31T10:00:00Z' })} />)
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
