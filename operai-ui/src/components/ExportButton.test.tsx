/**
 * @vitest-environment jsdom
 *
 * ExportButton (specs/029, T5; AC-4.6): the download button of inventory-ui's ExportYearButton, as a
 * library component. The browser seams — `URL.createObjectURL` / `revokeObjectURL` and the anchor
 * click that starts a download — are faked and recorded; `build` is a hand-resolved promise, so a
 * test decides when the file is ready. Timers are fake: the URL is revoked after a delay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ExportButton } from './ExportButton'
import type { ExportButtonProps } from './ExportButton'

type Built = Awaited<ReturnType<ExportButtonProps['build']>>

const messages: ExportButtonProps['messages'] = {
  busy: 'Preparing file…',
  ready: 'File ready',
  failed: 'The export could not be prepared. Try again.',
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type Download = { name: string; href: string; connected: boolean }
let downloads: Download[]
let blobs: Blob[]
let revoked: string[]
let createObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  downloads = []
  blobs = []
  revoked = []
  createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob)
    return `blob:fake-${blobs.length}`
  })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => revoked.push(url),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href, connected: this.isConnected })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

type Pending = { resolve: (built: Built) => void; reject: (reason: unknown) => void }

/** A `build` that stays pending until the test settles it. */
function pendingBuild() {
  const pending: Pending[] = []
  const build = vi.fn(
    () =>
      new Promise<Built>((resolve, reject) => {
        pending.push({ resolve, reject })
      }),
  )
  return { pending, build }
}

const FILE: Built = { data: new Uint8Array([1, 2, 3]), fileName: 'hours-2026-11.xlsx' }

const button = () => screen.getByRole('button', { name: 'Export' })
const click = () => fireEvent.click(button())
const status = () => screen.getByRole('status')
const flush = () => act(async () => {})
const settle = async (p: Pending, built: Built = FILE) => {
  await act(async () => {
    p.resolve(built)
  })
}
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

function renderButton(props: Partial<ExportButtonProps> = {}) {
  const { build } = pendingBuild()
  return render(<ExportButton label="Export" build={build} messages={messages} testId="export" {...props} />)
}

describe('ExportButton', () => {
  it('is an enabled button with an empty polite status, and builds nothing until it is clicked', () => {
    const { build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    expect(button()).toBeEnabled()
    expect(button()).not.toHaveAttribute('aria-busy')
    expect(button()).toHaveAttribute('data-testid', 'export')
    expect(status()).toBeEmptyDOMElement()
    expect(status()).toHaveAttribute('data-testid', 'export-status')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(build).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('is aria-busy, never disabled, while the file is built, and ignores a second click', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    click()
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
    expect(button()).toHaveAttribute('aria-busy', 'true')
    expect(button()).not.toBeDisabled()
    expect(status()).toHaveTextContent('Preparing file…')
    await settle(pending[0])
    expect(build).toHaveBeenCalledTimes(1)
    expect(downloads).toHaveLength(1)
  })

  it('ignores clicks that arrive in the same tick, before React has shown the busy state', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    act(() => {
      button().click()
      button().click()
      button().click()
    })
    await flush()
    expect(build).toHaveBeenCalledTimes(1)
    await settle(pending[0])
    expect(downloads).toHaveLength(1)
  })

  it('downloads the file under its name with the XLSX type by default, then says it is ready', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    await flush()
    await settle(pending[0])
    expect(downloads).toEqual([{ name: 'hours-2026-11.xlsx', href: 'blob:fake-1', connected: true }])
    expect(blobs[0].type).toBe(XLSX)
    expect(blobs[0].size).toBe(3)
    expect(status()).toHaveTextContent('File ready')
    expect(status()).not.toHaveTextContent('Preparing')
    expect(button()).not.toHaveAttribute('aria-busy')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('uses the `mimeType` it is given', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} mimeType="text/csv" testId="export" />)
    click()
    await flush()
    await settle(pending[0], { data: 'a,b', fileName: 'hours.csv' })
    expect(blobs[0].type).toBe('text/csv')
    expect(downloads[0].name).toBe('hours.csv')
  })

  it('does not leave the anchor in the page, and revokes the object URL once the browser has had time', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    await flush()
    await settle(pending[0])
    expect(document.querySelector('a[download]')).toBeNull()
    // Not at once: a browser reads the URL asynchronously and revoking it now can cancel the download.
    await wait(1_000)
    expect(revoked).toEqual([])
    await wait(60_000)
    expect(revoked).toEqual(['blob:fake-1'])
  })

  it('says what `build` says instead of "ready" when it returns a `readyMessage`', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    await flush()
    await settle(pending[0], { ...FILE, readyMessage: 'File ready. Some names are missing.' })
    expect(status()).toHaveTextContent('File ready. Some names are missing.')
    expect(status()).not.toHaveTextContent(/^File ready$/)
    expect(downloads).toHaveLength(1)
  })

  it('falls back to "ready" for an empty `readyMessage`', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    await flush()
    await settle(pending[0], { ...FILE, readyMessage: '' })
    expect(status()).toHaveTextContent(/^File ready$/)
  })

  it('shows an alert when `build` rejects, downloads nothing and can be used again', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    await flush()
    await act(async () => pending[0].reject(new Error('503')))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The export could not be prepared. Try again.')
    expect(alert).toHaveAttribute('data-testid', 'export-error')
    expect(downloads).toEqual([])
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(status()).toBeEmptyDOMElement()
    expect(button()).not.toHaveAttribute('aria-busy')
    expect(button()).toBeEnabled()

    click()
    await flush()
    expect(build).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(status()).toHaveTextContent('Preparing file…')
    await settle(pending[1])
    expect(downloads).toHaveLength(1)
    expect(status()).toHaveTextContent('File ready')
  })

  it('shows the alert when the browser refuses the object URL', async () => {
    createObjectURL.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    await flush()
    await settle(pending[0])
    expect(screen.getByRole('alert')).toHaveTextContent(messages.failed)
    expect(downloads).toEqual([])
    expect(button()).not.toHaveAttribute('aria-busy')
  })

  it('shows the alert for a `build` that throws before it returns a promise', async () => {
    const build = vi.fn((): Promise<Built> => {
      throw new Error('boom')
    })
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent(messages.failed)
    expect(button()).not.toHaveAttribute('aria-busy')
  })

  it('can export again after a successful export', async () => {
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Export" build={build} messages={messages} testId="export" />)
    click()
    await flush()
    await settle(pending[0])
    click()
    await flush()
    expect(status()).toHaveTextContent('Preparing file…')
    await settle(pending[1], { ...FILE, fileName: 'second.xlsx' })
    expect(downloads.map((d) => d.name)).toEqual(['hours-2026-11.xlsx', 'second.xlsx'])
  })
})

describe('ExportButton: resetKey', () => {
  it('clears the "ready" line when the key changes, and it does not come back with the old key', async () => {
    const { pending, build } = pendingBuild()
    const view = render(<ExportButton label="Export" build={build} messages={messages} resetKey="a" testId="export" />)
    click()
    await flush()
    await settle(pending[0])
    expect(status()).toHaveTextContent('File ready')
    view.rerender(<ExportButton label="Export" build={build} messages={messages} resetKey="b" testId="export" />)
    expect(status()).toBeEmptyDOMElement()
    view.rerender(<ExportButton label="Export" build={build} messages={messages} resetKey="a" testId="export" />)
    expect(status()).toBeEmptyDOMElement()
  })

  it('clears the alert when the key changes', async () => {
    const { pending, build } = pendingBuild()
    const view = render(<ExportButton label="Export" build={build} messages={messages} resetKey="a" testId="export" />)
    click()
    await flush()
    await act(async () => pending[0].reject(new Error('503')))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    view.rerender(<ExportButton label="Export" build={build} messages={messages} resetKey="b" testId="export" />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the line when it re-renders with the same key', async () => {
    const { pending, build } = pendingBuild()
    const view = render(<ExportButton label="Export" build={build} messages={messages} resetKey="a" testId="export" />)
    click()
    await flush()
    await settle(pending[0])
    view.rerender(<ExportButton label="Export" build={build} messages={messages} resetKey="a" testId="export" />)
    expect(status()).toHaveTextContent('File ready')
  })

  it('says nothing about a file that finished after the key changed, still hands it over, and is usable at once', async () => {
    const { pending, build } = pendingBuild()
    const view = render(<ExportButton label="Export" build={build} messages={messages} resetKey="a" testId="export" />)
    click()
    await flush()
    view.rerender(<ExportButton label="Export" build={build} messages={messages} resetKey="b" testId="export" />)
    expect(status()).toHaveTextContent('Preparing file…')
    await settle(pending[0])
    expect(downloads).toHaveLength(1)
    expect(status()).toBeEmptyDOMElement()
    expect(button()).not.toHaveAttribute('aria-busy')

    // The export for the new key is not swallowed by the one that was in flight.
    click()
    await flush()
    expect(build).toHaveBeenCalledTimes(2)
    await settle(pending[1], { ...FILE, fileName: 'b.xlsx' })
    expect(status()).toHaveTextContent('File ready')
  })
})

describe('ExportButton: look and words', () => {
  it('is a secondary button unless it is told otherwise', () => {
    const view = renderButton()
    expect(button()).toHaveClass('btn-secondary')
    view.rerender(
      <ExportButton label="Export" build={pendingBuild().build} messages={messages} variant="ghost" testId="export" />,
    )
    expect(button()).toHaveClass('btn-ghost')
  })

  it('takes every word it shows from its props', async () => {
    const italian: ExportButtonProps['messages'] = {
      busy: 'Preparazione del file…',
      ready: 'File pronto',
      failed: 'Esportazione non riuscita. Riprova.',
    }
    const { pending, build } = pendingBuild()
    render(<ExportButton label="Esporta" build={build} messages={italian} testId="export" />)
    fireEvent.click(screen.getByRole('button', { name: 'Esporta' }))
    await flush()
    expect(status().textContent).toBe('Preparazione del file…')
    await settle(pending[0])
    expect(status().textContent).toBe('File pronto')
    fireEvent.click(screen.getByRole('button', { name: 'Esporta' }))
    await flush()
    await act(async () => pending[1].reject(new Error('x')))
    expect(screen.getByRole('alert').textContent).toBe('Esportazione non riuscita. Riprova.')
  })
})
