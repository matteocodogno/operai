/**
 * @vitest-environment jsdom
 *
 * Component tests for AttachmentDownloadLink (T17, specs/007-refund-service/
 * tasks.md). Covers: idle → minting → open on success, and the inline error
 * state when `onDownload` rejects.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AttachmentDownloadLink from './AttachmentDownloadLink'
import type { Attachment } from '../lib/requestsApi'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const attachment: Attachment = { id: 'a1', fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 2048 }

describe('AttachmentDownloadLink', () => {
  it('mints a URL on click and opens it', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    const onDownload = vi.fn().mockResolvedValue({ url: 'https://signed.example/a1' })

    render(<AttachmentDownloadLink attachment={attachment} onDownload={onDownload} />)

    fireEvent.click(screen.getByTestId('attachment-download-a1'))

    await waitFor(() => expect(onDownload).toHaveBeenCalledWith('a1'))
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://signed.example/a1', '_blank', 'noopener,noreferrer'))
    expect(screen.queryByTestId('attachment-download-a1-error')).toBeNull()
  })

  it('shows an inline error when minting fails', async () => {
    const onDownload = vi.fn().mockRejectedValue(new Error('boom'))

    render(<AttachmentDownloadLink attachment={attachment} onDownload={onDownload} />)

    fireEvent.click(screen.getByTestId('attachment-download-a1'))

    const err = await screen.findByTestId('attachment-download-a1-error')
    expect(err.getAttribute('role')).toBe('alert')
  })

  it('has an accessible name including the file name', () => {
    render(<AttachmentDownloadLink attachment={attachment} onDownload={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Download receipt.pdf' })).not.toBeNull()
  })
})
