/**
 * @vitest-environment jsdom
 *
 * Tests for resolveRuntimeRemotes (specs/20261006-hardware-inventory, T41, AC-9.6):
 * the `inventory` remote follows the exact shape of the other four — resolved
 * from the runtime config when present, omitted when absent (ADR 20260709-suite-frontend-module-federation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveRuntimeRemotes } from './runtimeRemotes'

beforeEach(() => {
  delete window.__OPERAI_RUNTIME_CONFIG__
})

afterEach(() => {
  delete window.__OPERAI_RUNTIME_CONFIG__
  vi.unstubAllGlobals()
})

describe('resolveRuntimeRemotes', () => {
  it('resolves the inventory remote from window.__OPERAI_RUNTIME_CONFIG__', async () => {
    window.__OPERAI_RUNTIME_CONFIG__ = { inventory: 'https://inventory.example.test/remoteEntry.js' }

    await expect(resolveRuntimeRemotes()).resolves.toEqual([
      {
        name: 'inventory',
        entry: 'https://inventory.example.test/remoteEntry.js',
        type: 'module',
        entryGlobalName: 'inventory',
        shareScope: 'default',
      },
    ])
  })

  it('resolves the projects remote from window.__OPERAI_RUNTIME_CONFIG__ (specs/20261103-projects)', async () => {
    window.__OPERAI_RUNTIME_CONFIG__ = { projects: 'https://projects.example.test/remoteEntry.js' }

    await expect(resolveRuntimeRemotes()).resolves.toEqual([
      {
        name: 'projects',
        entry: 'https://projects.example.test/remoteEntry.js',
        type: 'module',
        entryGlobalName: 'projects',
        shareScope: 'default',
      },
    ])
  })

  it('resolves the letterheads remote from window.__OPERAI_RUNTIME_CONFIG__ (specs/20261116-letterhead-service)', async () => {
    window.__OPERAI_RUNTIME_CONFIG__ = { letterheads: 'https://letterheads.example.test/remoteEntry.js' }

    await expect(resolveRuntimeRemotes()).resolves.toEqual([
      {
        name: 'letterheads',
        entry: 'https://letterheads.example.test/remoteEntry.js',
        type: 'module',
        entryGlobalName: 'letterheads',
        shareScope: 'default',
      },
    ])
  })

  it('resolves the inventory remote from a fetched /runtime-config.json', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ inventory: 'https://inventory.example.test/remoteEntry.js' }), {
          status: 200,
        }),
      ),
    )

    const remotes = await resolveRuntimeRemotes()

    expect(remotes.map((r) => r.name)).toEqual(['inventory'])
  })

  it('resolves the meetings remote from window.__OPERAI_RUNTIME_CONFIG__ (specs/20261104-meetings)', async () => {
    window.__OPERAI_RUNTIME_CONFIG__ = { meetings: 'https://meetings.example.test/remoteEntry.js' }

    await expect(resolveRuntimeRemotes()).resolves.toEqual([
      {
        name: 'meetings',
        entry: 'https://meetings.example.test/remoteEntry.js',
        type: 'module',
        entryGlobalName: 'meetings',
        shareScope: 'default',
      },
    ])
  })

  it('resolves the hours remote from window.__OPERAI_RUNTIME_CONFIG__ (specs/20261112-time-tracking)', async () => {
    window.__OPERAI_RUNTIME_CONFIG__ = { hours: 'https://hours.example.test/remoteEntry.js' }

    await expect(resolveRuntimeRemotes()).resolves.toEqual([
      {
        name: 'hours',
        entry: 'https://hours.example.test/remoteEntry.js',
        type: 'module',
        entryGlobalName: 'hours',
        shareScope: 'default',
      },
    ])
  })

  it('omits the hours remote when the config does not name it, so the build-time default governs', async () => {
    window.__OPERAI_RUNTIME_CONFIG__ = { projects: 'https://projects.example.test/remoteEntry.js' }

    const remotes = await resolveRuntimeRemotes()

    expect(remotes.map((r) => r.name)).toEqual(['projects'])
  })

  it('omits the inventory remote when the config does not name it, keeping the others', async () => {
    window.__OPERAI_RUNTIME_CONFIG__ = { estimai: 'https://estimai.example.test/remoteEntry.js' }

    const remotes = await resolveRuntimeRemotes()

    expect(remotes.map((r) => r.name)).toEqual(['estimai'])
  })

  it('resolves to an empty list when there is no runtime config at all (404)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))

    await expect(resolveRuntimeRemotes()).resolves.toEqual([])
  })

  it('resolves to an empty list when the config cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    await expect(resolveRuntimeRemotes()).resolves.toEqual([])
  })
})
