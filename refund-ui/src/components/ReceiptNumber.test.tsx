/**
 * @vitest-environment jsdom
 *
 * ReceiptNumber (T22, specs/20261118-refund-accounting-export, design S9): the number in full with a visually hidden
 * label, and nothing at all for a line without one.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ReceiptNumber from './ReceiptNumber'

afterEach(cleanup)

describe('ReceiptNumber', () => {
  it('shows the number in mono, read with its label', () => {
    render(<ReceiptNumber value="MC26/014" />)
    const node = screen.getByTestId('receipt-number')
    expect(node.textContent).toBe('Receipt number MC26/014')
    expect(node.className).toContain('font-mono')
    expect(screen.getByText('MC26/014')).not.toBeNull()
  })

  it('hides the label visually but not from assistive technology', () => {
    render(<ReceiptNumber value="MC26/014" />)
    const label = screen.getByText('Receipt number', { exact: false, selector: '.visually-hidden' })
    expect(label.getAttribute('aria-hidden')).toBeNull()
  })

  it.each([null, undefined, ''])('renders nothing for %j (no dash, no placeholder)', (value) => {
    const { container } = render(<ReceiptNumber value={value} />)
    expect(container.innerHTML).toBe('')
  })
})
