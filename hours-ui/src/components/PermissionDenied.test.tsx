/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { strings } from '../strings'
import PermissionDenied from './PermissionDenied'

afterEach(() => cleanup())

describe('PermissionDenied', () => {
  it('is an alert that says access is missing, and takes focus on its heading', () => {
    render(<PermissionDenied />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(strings.common.permissionDenied.heading)
    expect(alert.textContent).toContain(strings.common.permissionDenied.body)
    const heading = screen.getByRole('heading', { name: strings.common.permissionDenied.heading })
    expect(heading.tagName).toBe('H2')
    expect(document.activeElement).toBe(heading)
  })

  it('offers no retry: a refusal is not transient', () => {
    render(<PermissionDenied />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('takes the words of the screen that raised it, and one way forward', () => {
    render(
      <PermissionDenied
        title="You can’t see everyone’s hours"
        message="Only people with this permission can."
        action={<a href="/hours">Back to my hours</a>}
      />,
    )
    expect(screen.getByRole('heading', { name: 'You can’t see everyone’s hours' })).not.toBeNull()
    expect(screen.getByText('Only people with this permission can.')).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Back to my hours' })).not.toBeNull()
    expect(screen.queryByText(strings.common.permissionDenied.heading)).toBeNull()
  })

  it('can sit under a page’s own header as an h3', () => {
    render(<PermissionDenied headingLevel={3} />)
    expect(screen.getByRole('heading', { name: strings.common.permissionDenied.heading }).tagName).toBe('H3')
  })
})
