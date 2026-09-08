/**
 * @vitest-environment jsdom
 *
 * Component tests for RequestExportLink (ADR-0043).
 *
 * The interesting behaviour is not "does it call the API" but the two things
 * that would quietly hurt users: collapsing distinct, non-retryable failures
 * into "try again", and leaking a Blob object URL per export.
 */

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import RequestExportLink from './RequestExportLink'
import * as requestsApi from '../lib/requestsApi'
import { ApiError } from '../lib/refundApi'

const problem = (status: number) =>
  new ApiError({
    type: `https://httpstatuses.com/${status}`,
    title: 'Export failed',
    status,
  })

let createdUrls: string[] = []
let revokedUrls: string[] = []

beforeEach(() => {
  createdUrls = []
  revokedUrls = []
  globalThis.URL.createObjectURL = vi.fn(() => {
    const url = `blob:mock/${createdUrls.length}`
    createdUrls.push(url)
    return url
  }) as unknown as typeof URL.createObjectURL
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url)
  }) as unknown as typeof URL.revokeObjectURL
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RequestExportLink', () => {
  it('downloads the archive PDF with a request-scoped filename', async () => {
    const blob = new Blob(['%PDF-'], { type: 'application/pdf' })
    vi.spyOn(requestsApi, 'exportPdf').mockResolvedValue(blob)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<RequestExportLink requestId="req_123" />)
    await userEvent.click(screen.getByTestId('request-export-link-req_123'))

    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
    expect(requestsApi.exportPdf).toHaveBeenCalledWith('req_123')
  })

  // A Blob object URL pins the whole (multi-megabyte) blob in memory until
  // revoked. One leaked handle per export would accumulate for the tab's life.
  it('revokes the object URL it created, so repeated exports do not leak blobs', async () => {
    vi.spyOn(requestsApi, 'exportPdf').mockResolvedValue(new Blob(['%PDF-']))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<RequestExportLink requestId="req_123" />)
    await userEvent.click(screen.getByTestId('request-export-link-req_123'))

    await waitFor(() => expect(revokedUrls).toEqual(createdUrls))
    expect(createdUrls).toHaveLength(1)
  })

  // Each of these needs a DIFFERENT action from the reader. "Try again" is
  // actively wrong advice for 413 and 502 — neither will ever succeed on a
  // retry — so they must not share the generic message.
  it.each([
    [413, /too large/i],
    [502, /receipt could not be read/i],
    [409, /only an approved request/i],
  ])('surfaces a distinct, non-generic message for a %s', async (status, expected) => {
    vi.spyOn(requestsApi, 'exportPdf').mockRejectedValue(problem(status))

    render(<RequestExportLink requestId="req_123" />)
    await userEvent.click(screen.getByTestId('request-export-link-req_123'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(expected)
    expect(alert.textContent).not.toMatch(/try again/i)
  })

  it('falls back to a retryable message for an unexpected failure', async () => {
    vi.spyOn(requestsApi, 'exportPdf').mockRejectedValue(problem(500))

    render(<RequestExportLink requestId="req_123" />)
    await userEvent.click(screen.getByTestId('request-export-link-req_123'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/try again/i)
  })

  it('re-enables the button after a failure so the user is not stuck', async () => {
    vi.spyOn(requestsApi, 'exportPdf').mockRejectedValue(problem(500))

    render(<RequestExportLink requestId="req_123" />)
    const button = screen.getByTestId('request-export-link-req_123')
    await userEvent.click(button)

    await screen.findByRole('alert')
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('names the request in its accessible label, not just "Export PDF"', () => {
    render(<RequestExportLink requestId="req_123" />)
    expect(
      screen.getByLabelText(/Export request req_123 as an archive PDF/i),
    ).toBeDefined()
  })
})
