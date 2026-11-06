import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Banner } from './Banner'
import { Button } from './Button'

/**
 * jsdom has no layout, so these tests cannot measure a banner at 360px. What they can do is load the REAL
 * `.banner*` rules from tokens.css into the document and read the computed style off the rendered markup:
 * the declarations that make a banner with actions stack instead of squeezing its text (QE D1, specs/022).
 */
const tokens = readFileSync(join(import.meta.dirname, '../styles/tokens.css'), 'utf-8')
const bannerRules = [...tokens.matchAll(/^\s*(\.banner[\w-]*)\s*\{([^}]*)\}/gm)]
  .map(([, selector, body]) => `${selector} {${body}}`)
  .join('\n')

let style: HTMLStyleElement
beforeAll(() => {
  style = document.createElement('style')
  style.textContent = bannerRules
  document.head.appendChild(style)
})
afterAll(() => style.remove())
afterEach(cleanup)

function renderWithAction() {
  render(<Banner actions={<Button>Pick project manager</Button>}>QE022 ops-ch is the ops manager.</Banner>)
  const banner = screen.getByRole('status')
  return {
    banner,
    content: banner.querySelector('.banner-content') as HTMLElement,
    actions: banner.querySelector('.banner-actions') as HTMLElement,
  }
}

describe('Banner layout (D1: the text of a banner with actions stays readable when narrow)', () => {
  it('loads the real banner rules', () => {
    expect(bannerRules).toContain('.banner-actions')
  })

  it('lets the actions wrap below the message instead of squeezing it', () => {
    const { banner } = renderWithAction()
    expect(getComputedStyle(banner).flexWrap).toBe('wrap')
  })

  it('gives the message a readable measure to claim before the actions share its line', () => {
    const { content } = renderWithAction()
    const { flexBasis, flexGrow } = getComputedStyle(content)
    expect(flexBasis).toMatch(/^\d+(\.\d+)?rem$/)
    expect(Number.parseFloat(flexBasis)).toBeGreaterThanOrEqual(12)
    expect(flexGrow).toBe('1')
  })

  it('lets several actions wrap among themselves, never wider than the banner', () => {
    const { actions } = renderWithAction()
    const { flexWrap, maxWidth } = getComputedStyle(actions)
    expect(flexWrap).toBe('wrap')
    // Without a cap an unshrinkable row of buttons on its own line would overflow a narrow banner.
    expect(maxWidth).toBe('100%')
  })
})
