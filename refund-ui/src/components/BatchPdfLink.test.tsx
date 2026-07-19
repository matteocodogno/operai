/**
 * @vitest-environment jsdom
 *
 * Component tests for BatchPdfLink (T10, specs/008-refund-monthly-
 * processing/tasks.md). Mirrors AttachmentDownloadLink.test.tsx's structure:
 * mints on click, opens the returned URL, surfaces an inline error on
 * failure. `batchesApi.getPdfUrl` is mocked at the module level (this
 * component calls it directly, per this task's own brief).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import BatchPdfLink from './BatchPdfLink'
import * as batchesApi from '../lib/batchesApi'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BatchPdfLink', () => {
  it('mints a URL on click and opens it', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const getPdfUrlSpy = vi.spyOn(batchesApi, 'getPdfUrl').mockResolvedValue({
      url: 'https://signed.example/batch-1.pdf',
      expiresAt: '2026-07-19T00:01:00Z',
    })

    render(<BatchPdfLink batchId="batch-1" />)

    fireEvent.click(screen.getByTestId('batch-pdf-link-batch-1'))

    await waitFor(() => expect(getPdfUrlSpy).toHaveBeenCalledWith('batch-1'))
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith('https://signed.example/batch-1.pdf', '_blank', 'noopener,noreferrer'),
    )
    expect(screen.queryByTestId('batch-pdf-link-batch-1-error')).toBeNull()
  })

  it('shows an inline error when minting fails', async () => {
    vi.spyOn(batchesApi, 'getPdfUrl').mockRejectedValue(new Error('boom'))

    render(<BatchPdfLink batchId="batch-1" />)

    fireEvent.click(screen.getByTestId('batch-pdf-link-batch-1'))

    const err = await screen.findByTestId('batch-pdf-link-batch-1-error')
    expect(err.getAttribute('role')).toBe('alert')
  })

  it('disables the button while minting is in flight', async () => {
    let resolveFn: (value: { url: string; expiresAt: string }) => void = () => {}
    vi.spyOn(batchesApi, 'getPdfUrl').mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve
      }),
    )

    render(<BatchPdfLink batchId="batch-1" />)
    const button = screen.getByTestId('batch-pdf-link-batch-1')

    fireEvent.click(button)
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true))

    resolveFn({ url: 'https://signed.example/batch-1.pdf', expiresAt: '2026-07-19T00:01:00Z' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  })

  it('has an accessible name including the batch reference', () => {
    render(<BatchPdfLink batchId="batch-1" />)
    expect(screen.getByRole('button', { name: 'Download compiled PDF for batch batch-1' })).not.toBeNull()
  })
})
