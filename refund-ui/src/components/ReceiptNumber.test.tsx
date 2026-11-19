/**
 * @vitest-environment jsdom
 *
 * ReceiptNumber (T22, specs/20261118-refund-accounting-export, design S9): the number in full with a visually hidden
 * label, and nothing at all for a line without one.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { expectNoAxeViolations } from '../test-support/axe'
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

// T44: automated axe checks (test-support/axe.ts): the number inside a table cell and inside a list item, where it is used.
describe('ReceiptNumber: accessibility (axe)', () => {
  it('has no violations in a table row, in a list, and on its own', async () => {
    render(
      <>
        <table>
          <caption>Lines</caption>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col">Receipt</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Train</td>
              <td>
                <ReceiptNumber value="MC26/014" />
              </td>
            </tr>
            <tr>
              <td>Taxi</td>
              <td>
                <ReceiptNumber value={null} />
              </td>
            </tr>
          </tbody>
        </table>
        <ul>
          <li>
            <ReceiptNumber value="MC26/015" />
          </li>
        </ul>
      </>,
    )
    await expectNoAxeViolations()
  })
})
