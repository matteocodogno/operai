/**
 * @vitest-environment jsdom
 *
 * The two inner routers (specs/021-meetings, design.md § Conventions › Routes): `./App`
 * under `/meetings` and `./MyMeetings` under `/my-meetings`. Both render the placeholder
 * pages that later tasks fill in place; this pins the route table and the not-found fallback.
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAppRouter, createMyMeetingsRouter } from './router'

beforeEach(() => {
  // jsdom does not implement scrolling; the router's scroll restoration calls it on navigation.
  window.scrollTo = () => undefined
})

afterEach(() => {
  cleanup()
})

const renderAt = async (make: typeof createAppRouter | typeof createMyMeetingsRouter, base: string, url: string) => {
  const router = make(base, undefined, createMemoryHistory({ initialEntries: [url] }))
  render(<RouterProvider router={router} />)
  await router.load()
}

describe('createAppRouter (basepath /meetings)', () => {
  it.each([
    ['/meetings', 'meetings-list-page'],
    ['/meetings/new', 'meetings-new-page'],
    ['/meetings/m/abc', 'meetings-meeting-page'],
    ['/meetings/templates', 'meetings-templates-page'],
    ['/meetings/templates/new', 'meetings-template-editor-page'],
    ['/meetings/templates/t1', 'meetings-template-view-page'],
    ['/meetings/templates/t1/edit', 'meetings-template-editor-page'],
    ['/meetings/erase', 'meetings-erase-page'],
  ])('%s mounts %s', async (url, testId) => {
    await renderAt(createAppRouter, '/meetings', url)
    expect(await screen.findByTestId(testId)).not.toBeNull()
  })

  it('an unknown path shows the not-found state, not a blank page', async () => {
    await renderAt(createAppRouter, '/meetings', '/meetings/nope/nothing')
    expect(await screen.findByTestId('meetings-not-found')).not.toBeNull()
  })
})

describe('createMyMeetingsRouter (basepath /my-meetings)', () => {
  it.each([
    ['/my-meetings', 'meetings-list-page'],
    ['/my-meetings/m/abc', 'meetings-meeting-page'],
  ])('%s mounts %s', async (url, testId) => {
    await renderAt(createMyMeetingsRouter, '/my-meetings', url)
    expect(await screen.findByTestId(testId)).not.toBeNull()
  })

  it('has no tool-only routes: /my-meetings/erase is not found', async () => {
    await renderAt(createMyMeetingsRouter, '/my-meetings', '/my-meetings/erase')
    expect(await screen.findByTestId('meetings-not-found')).not.toBeNull()
  })

  it('has no templates routes either', async () => {
    await renderAt(createMyMeetingsRouter, '/my-meetings', '/my-meetings/templates')
    expect(await screen.findByTestId('meetings-not-found')).not.toBeNull()
  })
})
