/**
 * @vitest-environment jsdom
 *
 * The axe helper itself (T44): it must fail on markup that is really inaccessible, say why, and honour a narrow
 * `allow`; otherwise a green "no violations" across the suite would prove nothing.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { axeViolations, expectNoAxeViolations, formatAxeViolations } from './axe'

afterEach(cleanup)

/** The deliberately broken fixture: an input with no accessible name, and an image with no alt text. */
const Broken = () => (
  <form>
    <input type="text" data-testid="unlabelled" />
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-testid="no-alt" />
  </form>
)

const Labelled = () => (
  <form>
    <label htmlFor="name">Legal name</label>
    <input id="name" type="text" />
  </form>
)

describe('axe test helper', () => {
  it('fails on an unlabelled input and an image without alt, naming the rules and the elements', async () => {
    const { container } = render(<Broken />)
    const violations = await axeViolations(container)
    expect(violations.map((v) => v.id).sort()).toEqual(['image-alt', 'label'])
    await expect(expectNoAxeViolations(container)).rejects.toThrow(
      /axe found 2 violation\(s\)[\s\S]*label[\s\S]*<input/,
    )
    const report = formatAxeViolations(violations)
    expect(report).toContain('label (critical)')
    expect(report).toContain('https://dequeuniversity.com/rules/axe/')
    expect(report).toContain('data-testid="unlabelled"')
  })

  it('passes on a labelled input', async () => {
    const { container } = render(<Labelled />)
    await expectNoAxeViolations(container)
  })

  it('checks the whole document by default, so a portalled dialog is not skipped', async () => {
    render(<Labelled />)
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    await expect(expectNoAxeViolations()).rejects.toThrow(/label/)
    outside.remove()
  })

  it('ignores only the allowed element: another violation of the same rule still fails', async () => {
    const { container } = render(
      <form>
        <input type="text" data-testid="known" />
        <input type="text" data-testid="new" />
      </form>,
    )
    const allow = [{ rule: 'label', selector: '[data-testid="known"]', reason: 'test' }]
    const violations = await axeViolations(container, { allow })
    expect(violations).toHaveLength(1)
    expect(violations[0].nodes).toHaveLength(1)
    expect(violations[0].nodes[0].html).toContain('data-testid="new"')
    await expectNoAxeViolations(container, {
      allow: [...allow, { rule: 'label', selector: '[data-testid="new"]', reason: 'test' }],
    })
  })

  it('does not run the page-level landmark rules: a fragment in the body is not a page', async () => {
    render(<p>Just a paragraph</p>)
    await expectNoAxeViolations()
  })

  it('does not run colour contrast (jsdom has no layout), so a contrast verdict never depends on it', async () => {
    const { container } = render(<p style={{ color: '#fff', background: '#fff' }}>Invisible text</p>)
    await expectNoAxeViolations(container)
  })
})
