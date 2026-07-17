/**
 * @vitest-environment jsdom
 *
 * Component tests for AttachmentList (T17, specs/007-refund-service/
 * tasks.md; post-close UX amendment, specs/007, 2026-07-17 — see
 * `specs/007-refund-service/design.md`'s dated amendment note). Covers:
 * per-file client-side rejection (oversize/wrong type), the
 * queued→uploading→stored/failed phase state machine, the attachment-remove
 * confirm modal (open → confirm → onRemove called; cancel → not removed),
 * and that `readOnly` mode exposes no upload/remove affordances.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AttachmentList from './AttachmentList'
import type { Attachment } from '../lib/requestsApi'

afterEach(() => {
  cleanup()
})

const stored: Attachment = { id: 'a1', fileName: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 2048 }

const pdfFile = (name = 'new-receipt.pdf', sizeBytes = 1024): File => new File([new Uint8Array(sizeBytes)], name, { type: 'application/pdf' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AttachmentList — edit mode', () => {
  it('renders persisted attachments with a download link and a Remove button', () => {
    render(<AttachmentList lineId="l1" attachments={[stored]} mode="edit" onUpload={vi.fn()} onRemove={vi.fn()} onDownload={vi.fn()} />)

    expect(screen.getByTestId('attachment-download-a1')).not.toBeNull()
    expect(screen.getByTestId('attachment-remove-a1')).not.toBeNull()
  })

  it('the Remove button carries a hover title tooltip', () => {
    render(<AttachmentList lineId="l1" attachments={[stored]} mode="edit" onUpload={vi.fn()} onRemove={vi.fn()} onDownload={vi.fn()} />)

    expect(screen.getByTestId('attachment-remove-a1').getAttribute('title')).toBe('Remove attachment')
  })

  it('renders the "+ Attach files" trigger and a hidden multi-file input', () => {
    render(<AttachmentList lineId="l1" attachments={[]} mode="edit" onUpload={vi.fn()} onRemove={vi.fn()} onDownload={vi.fn()} />)

    expect(screen.getByTestId('attachment-attach-button-l1')).not.toBeNull()
    const input = screen.getByTestId('attachment-input-l1') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.multiple).toBe(true)
    expect(input.className).toContain('hidden')
  })

  it('rejects an oversize file client-side with an inline reason, without calling onUpload', async () => {
    const onUpload = vi.fn()
    render(<AttachmentList lineId="l1" attachments={[]} mode="edit" onUpload={onUpload} onRemove={vi.fn()} onDownload={vi.fn()} />)

    const bigFile = pdfFile('big.pdf', 10 * 1024 * 1024 + 1)
    const input = screen.getByTestId('attachment-input-l1') as HTMLInputElement
    await userEvent.upload(input, bigFile)

    const status = await screen.findByText('File exceeds 10 MB and was not added.')
    expect(status.getAttribute('role')).toBe('alert')
    expect(onUpload).not.toHaveBeenCalled()
  })

  it('rejects an unsupported file type client-side with an inline reason, without calling onUpload', async () => {
    const onUpload = vi.fn()
    render(<AttachmentList lineId="l1" attachments={[]} mode="edit" onUpload={onUpload} onRemove={vi.fn()} onDownload={vi.fn()} />)

    // fireEvent.change (not userEvent.upload) — userEvent.upload filters the
    // FileList against the input's own `accept` attribute before firing the
    // change event, which would silently swallow this exact file rather than
    // letting AttachmentList's own client-side check reject it.
    const textFile = new File(['x'], 'notes.txt', { type: 'text/plain' })
    const input = screen.getByTestId('attachment-input-l1') as HTMLInputElement
    fireEvent.change(input, { target: { files: [textFile] } })

    await screen.findByText('Unsupported file type — use PDF, JPEG, or PNG.')
    expect(onUpload).not.toHaveBeenCalled()
  })

  it('walks a valid file through queued/uploading -> stored via aria-live status text', async () => {
    const { promise, resolve } = deferred<Attachment>()
    const onUpload = vi.fn().mockReturnValue(promise)
    render(<AttachmentList lineId="l1" attachments={[]} mode="edit" onUpload={onUpload} onRemove={vi.fn()} onDownload={vi.fn()} />)

    const input = screen.getByTestId('attachment-input-l1') as HTMLInputElement
    await userEvent.upload(input, pdfFile())

    await waitFor(() => expect(screen.getByText('Uploading…')).not.toBeNull())
    expect(onUpload).toHaveBeenCalledTimes(1)

    resolve({ id: 'a2', fileName: 'new-receipt.pdf', contentType: 'application/pdf', sizeBytes: 1024 })

    await waitFor(() => expect(screen.getByText('Uploaded')).not.toBeNull())
  })

  it('shows a failed state with a dismissible reason when onUpload rejects', async () => {
    const onUpload = vi.fn().mockRejectedValue(new Error('network blip'))
    render(<AttachmentList lineId="l1" attachments={[]} mode="edit" onUpload={onUpload} onRemove={vi.fn()} onDownload={vi.fn()} />)

    const input = screen.getByTestId('attachment-input-l1') as HTMLInputElement
    await userEvent.upload(input, pdfFile())

    const failedStatus = await screen.findByText('Upload failed. Try again.')
    expect(failedStatus.getAttribute('role')).toBe('alert')

    const item = failedStatus.closest('li')!
    const dismiss = item.querySelector('button[aria-label^="Dismiss"]')!
    fireEvent.click(dismiss)
    await waitFor(() => expect(screen.queryByText('Upload failed. Try again.')).toBeNull())
  })

  it('drops the local "stored" item once the same attachment id appears in the `attachments` prop (no duplicate row)', async () => {
    const { promise, resolve } = deferred<Attachment>()
    const onUpload = vi.fn().mockReturnValue(promise)
    const { rerender } = render(
      <AttachmentList lineId="l1" attachments={[]} mode="edit" onUpload={onUpload} onRemove={vi.fn()} onDownload={vi.fn()} />,
    )

    const input = screen.getByTestId('attachment-input-l1') as HTMLInputElement
    await userEvent.upload(input, pdfFile())
    resolve({ id: 'a2', fileName: 'new-receipt.pdf', contentType: 'application/pdf', sizeBytes: 1024 })
    await waitFor(() => expect(screen.getByText('Uploaded')).not.toBeNull())

    rerender(
      <AttachmentList
        lineId="l1"
        attachments={[{ id: 'a2', fileName: 'new-receipt.pdf', contentType: 'application/pdf', sizeBytes: 1024 }]}
        mode="edit"
        onUpload={onUpload}
        onRemove={vi.fn()}
        onDownload={vi.fn()}
      />,
    )

    expect(screen.queryByText('Uploaded')).toBeNull()
    expect(screen.getAllByTestId('attachment-download-a2')).toHaveLength(1)
  })

  it('clicking Remove opens a ConfirmDeleteModal naming the file, without calling onRemove yet', () => {
    const onRemove = vi.fn()
    render(<AttachmentList lineId="l1" attachments={[stored]} mode="edit" onUpload={vi.fn()} onRemove={onRemove} onDownload={vi.fn()} />)

    fireEvent.click(screen.getByTestId('attachment-remove-a1'))

    expect(screen.getByTestId('attachment-remove-confirm-a1-modal')).not.toBeNull()
    expect(screen.getByTestId('attachment-remove-confirm-a1-modal').textContent).toContain('receipt.pdf')
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('confirming removes a persisted attachment via onRemove', async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined)
    render(<AttachmentList lineId="l1" attachments={[stored]} mode="edit" onUpload={vi.fn()} onRemove={onRemove} onDownload={vi.fn()} />)

    fireEvent.click(screen.getByTestId('attachment-remove-a1'))
    fireEvent.click(screen.getByTestId('attachment-remove-confirm-a1-confirm'))

    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('a1'))
    await waitFor(() => expect(screen.queryByTestId('attachment-remove-confirm-a1-modal')).toBeNull())
  })

  it('canceling does not call onRemove and keeps the attachment', () => {
    const onRemove = vi.fn()
    render(<AttachmentList lineId="l1" attachments={[stored]} mode="edit" onUpload={vi.fn()} onRemove={onRemove} onDownload={vi.fn()} />)

    fireEvent.click(screen.getByTestId('attachment-remove-a1'))
    fireEvent.click(screen.getByTestId('attachment-remove-confirm-a1-cancel'))

    expect(screen.queryByTestId('attachment-remove-confirm-a1-modal')).toBeNull()
    expect(onRemove).not.toHaveBeenCalled()
    expect(screen.getByTestId('attachment-download-a1')).not.toBeNull()
  })

  it('shows an inline error in the modal and keeps it open when onRemove rejects', async () => {
    const onRemove = vi.fn().mockRejectedValue(new Error('boom'))
    render(<AttachmentList lineId="l1" attachments={[stored]} mode="edit" onUpload={vi.fn()} onRemove={onRemove} onDownload={vi.fn()} />)

    fireEvent.click(screen.getByTestId('attachment-remove-a1'))
    fireEvent.click(screen.getByTestId('attachment-remove-confirm-a1-confirm'))

    await waitFor(() => expect(screen.getByTestId('attachment-remove-confirm-a1-error')).not.toBeNull())
    expect(screen.getByTestId('attachment-remove-confirm-a1-modal')).not.toBeNull()
  })
})

describe('AttachmentList — readOnly mode', () => {
  it('renders only download links — no Remove button, no attach trigger, no file input', () => {
    render(<AttachmentList lineId="l1" attachments={[stored]} mode="readOnly" onDownload={vi.fn()} />)

    expect(screen.getByTestId('attachment-download-a1')).not.toBeNull()
    expect(screen.queryByTestId('attachment-remove-a1')).toBeNull()
    expect(screen.queryByTestId('attachment-attach-button-l1')).toBeNull()
    expect(screen.queryByTestId('attachment-input-l1')).toBeNull()
  })

  it('renders nothing (no empty-state chrome) when there are no attachments', () => {
    const { container } = render(<AttachmentList lineId="l1" attachments={[]} mode="readOnly" onDownload={vi.fn()} />)
    expect(container.querySelector('ul')).toBeNull()
  })
})
