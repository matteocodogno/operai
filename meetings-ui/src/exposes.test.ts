import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The federation contract the shell depends on (plan § Host integration, ADR-0030/0045/0060):
 * the remote is named `meetings`, serves on the pinned port 5180, and exposes exactly the four
 * entries the shell and the host extension import. A rename here silently breaks the shell at
 * runtime (a dynamic import of a missing export), so the table is asserted against the config
 * source, and every exposed file must exist.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf-8')

const EXPOSES: Record<string, string> = {
  './App': './src/App.tsx',
  './MyMeetings': './src/MyMeetings.tsx',
  './HostMeetings': './src/host/HostMeetings.tsx',
  './version': './src/version.ts',
}

describe('vite.config.ts federation contract', () => {
  it('names the remote `meetings`', () => {
    expect(config).toMatch(/name: 'meetings'/)
  })

  it.each(Object.entries(EXPOSES))('exposes %s from %s, and that file exists', (key, file) => {
    expect(config).toContain(`'${key}': '${file}'`)
    expect(existsSync(path.join(ROOT, file))).toBe(true)
  })

  it('exposes nothing else', () => {
    const block = /exposes: \{([^}]*)\}/.exec(config)?.[1] ?? ''
    expect([...block.matchAll(/'(\.\/[^']+)':/g)].map((match) => match[1]).sort()).toEqual(Object.keys(EXPOSES).sort())
  })

  it('pins port 5180 for dev and preview (strictPort)', () => {
    expect([...config.matchAll(/port: 5180/g)]).toHaveLength(2)
    expect([...config.matchAll(/strictPort: true/g)]).toHaveLength(2)
  })
})
