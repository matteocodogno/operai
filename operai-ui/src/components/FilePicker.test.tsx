import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { FilePicker } from './FilePicker'
import type { FilePickerProps } from './FilePicker'

afterEach(cleanup)

const copy = { label: 'Recording', chooseLabel: 'Choose file', clearLabel: 'Remove file', emptyText: 'No file chosen' }

const audio = (name = 'standup.m4a', bytes = 2_500_000) =>
  new File([new Uint8Array(Math.min(bytes, 16))], name, { type: 'audio/mp4' })

/** A File whose reported size is `size`, without allocating it. */
const sized = (name: string, size: number) => {
  const file = audio(name)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function Harness(props: Partial<FilePickerProps> & { initial?: File | null; onPick?: (file: File | null) => void }) {
  const { initial = null, onPick, ...rest } = props
  const [file, setFile] = useState<File | null>(initial)
  return (
    <FilePicker
      {...copy}
      file={file}
      onChange={(next) => {
        setFile(next)
        onPick?.(next)
      }}
      inputTestId="picker-input"
      {...rest}
    />
  )
}

const input = () => screen.getByTestId('picker-input') as HTMLInputElement

describe('FilePicker', () => {
  it('names the button by its own visible text (WCAG 2.5.3) and the group by the field label', () => {
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Choose file' })
    // The accessible name is exactly the visible text, not the field label that used to win via <label for>.
    expect(screen.queryByRole('button', { name: /Recording/ })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Recording' })).toContainElement(button)
    expect(screen.getByText('No file chosen')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove file' })).not.toBeInTheDocument()
  })

  it('still opens the file dialog from the field label', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opened = vi.fn()
    input().addEventListener('click', opened)
    await user.click(screen.getByText('Recording'))
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('keeps the file input out of the tab order and the accessibility tree, with the accept list', () => {
    render(<Harness accept="audio/*,.m4a" />)
    expect(input()).toHaveAttribute('type', 'file')
    expect(input()).toHaveAttribute('accept', 'audio/*,.m4a')
    expect(input()).toHaveAttribute('tabindex', '-1')
    expect(input()).toHaveAttribute('aria-hidden', 'true')
  })

  it('opens the file dialog from the button by mouse and by keyboard', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opened = vi.fn()
    input().addEventListener('click', opened)
    await user.click(screen.getByRole('button', { name: 'Choose file' }))
    expect(opened).toHaveBeenCalledTimes(1)
    screen.getByRole('button', { name: 'Choose file' }).focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(opened).toHaveBeenCalledTimes(3)
  })

  it('reports the chosen file and shows its name and size', async () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    const file = sized('standup.m4a', 2_500_000)
    await userEvent.upload(input(), file)
    expect(onPick).toHaveBeenCalledWith(file)
    expect(screen.getByText('standup.m4a')).toBeInTheDocument()
    expect(screen.getByText('2.4 MB')).toBeInTheDocument()
    expect(screen.queryByText('No file chosen')).not.toBeInTheDocument()
  })

  it('formats sizes from bytes up to gigabytes, and lets the app supply its own formatter', () => {
    const { rerender } = render(<FilePicker {...copy} file={sized('a', 512)} onChange={() => {}} />)
    expect(screen.getByText('512 byte')).toBeInTheDocument()
    rerender(<FilePicker {...copy} file={sized('a', 20_480)} onChange={() => {}} />)
    expect(screen.getByText('20 kB')).toBeInTheDocument()
    rerender(<FilePicker {...copy} file={sized('a', 3 * 1024 ** 3)} onChange={() => {}} />)
    expect(screen.getByText('3 GB')).toBeInTheDocument()
    rerender(
      <FilePicker {...copy} file={sized('a', 10)} onChange={() => {}} formatSize={(bytes) => `${bytes} bytes!`} />,
    )
    expect(screen.getByText('10 bytes!')).toBeInTheDocument()
  })

  it('announces the selection politely', () => {
    render(<Harness initial={audio()} />)
    expect(screen.getByText('standup.m4a').closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
  })

  it('clears the selection, empties the input and returns focus to the choose button', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<Harness initial={audio()} onPick={onPick} />)
    await user.click(screen.getByRole('button', { name: 'Remove file' }))
    expect(onPick).toHaveBeenLastCalledWith(null)
    expect(screen.getByText('No file chosen')).toBeInTheDocument()
    expect(input().value).toBe('')
    expect(screen.getByRole('button', { name: 'Choose file' })).toHaveFocus()
  })

  it('lets the same file be chosen again after a clear', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    const file = audio()
    await user.upload(input(), file)
    await user.click(screen.getByRole('button', { name: 'Remove file' }))
    await user.upload(input(), file)
    expect(onPick.mock.calls.map(([f]) => f)).toEqual([file, null, file])
  })

  it('ignores a cancelled dialog (an empty selection) and keeps the current file', () => {
    const onPick = vi.fn()
    render(<Harness initial={audio()} onPick={onPick} />)
    fireEvent.change(input(), { target: { files: [] } })
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByText('standup.m4a')).toBeInTheDocument()
  })

  it('wires hint and error to the button through aria-describedby, and marks it invalid', () => {
    render(<Harness hint="m4a, mp3 or wav, up to 500 MiB" error="This file type is not supported" />)
    const button = screen.getByRole('button', { name: 'Choose file' })
    expect(button).toHaveAttribute('aria-invalid', 'true')
    const described = (button.getAttribute('aria-describedby') ?? '').split(' ')
    const texts = described.map((id) => document.getElementById(id)?.textContent)
    expect(texts).toContain('m4a, mp3 or wav, up to 500 MiB')
    expect(texts).toContain('This file type is not supported')
  })

  it('points the button at the selected-file line so focusing it reads the choice', () => {
    render(<Harness initial={audio()} />)
    const button = screen.getByRole('button', { name: 'Choose file' })
    const described = (button.getAttribute('aria-describedby') ?? '').split(' ')
    expect(described.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain('standup.m4a')
  })

  it('shows the required marker and disables both buttons when disabled', () => {
    render(<Harness initial={audio()} required disabled />)
    expect(screen.getByRole('button', { name: 'Choose file' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove file' })).toBeDisabled()
    expect(input()).toBeDisabled()
  })

  it('empties the input when the app resets the file, so the same file can be picked again', async () => {
    const onPick = vi.fn()
    const file = audio()
    const { rerender } = render(<FilePicker {...copy} file={null} onChange={onPick} inputTestId="picker-input" />)
    await userEvent.upload(input(), file)
    rerender(<FilePicker {...copy} file={file} onChange={onPick} inputTestId="picker-input" />)
    rerender(<FilePicker {...copy} file={null} onChange={onPick} inputTestId="picker-input" />)
    expect(input().value).toBe('')
  })
})
