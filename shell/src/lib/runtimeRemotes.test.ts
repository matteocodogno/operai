/**
 * @vitest-environment jsdom
 *
 * Tests for resolveRuntimeRemotes (specs/015-hardware-inventory, T41, AC-9.6):
 * the `inventory` remote follows the exact shape of the other four — resolved
 * from the runtime config when present, omitted when absent (ADR-0006).
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
