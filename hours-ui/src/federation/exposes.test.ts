import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REMOTE_VERSION } from '../version'

/**
 * The federation contract the shell depends on (specs/029-time-tracking tasks.md T22/T23, plan §
 * Components, ADR-0030/0090): the remote is named `hours`, serves on the pinned port 5184, and exposes
 * exactly the two entries the shell imports, `./App` and `./version`. A rename here silently breaks
 * the shell at runtime (a dynamic import of a missing export), so the table is asserted against the
 * config source, and every exposed file must exist. The shell's own `remoteVersionSpecifiers` test
 * (T23) reads the same file.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const config = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf-8')

const EXPOSES: Record<string, string> = {
  './App': './src/App.tsx',
  './version': './src/version.ts',
}

describe('vite.config.ts federation contract', () => {
  it('names the remote `hours`', () => {
    expect(config).toMatch(/name: 'hours'/)
  })

  it.each(Object.entries(EXPOSES))('exposes %s from %s, and that file exists', (key, file) => {
    expect(config).toContain(`'${key}': '${file}'`)
    expect(existsSync(path.join(ROOT, file))).toBe(true)
  })

  it('exposes nothing else (the screens are one entry: the whole hours screen)', () => {
    const block = /exposes: \{([^}]*)\}/.exec(config)?.[1] ?? ''
    expect([...block.matchAll(/'(\.\/[^']+)':/g)].map((match) => match[1]).sort()).toEqual(Object.keys(EXPOSES).sort())
  })

  it('serves remoteEntry.js and pins port 5184 for dev and preview (strictPort)', () => {
    expect(config).toMatch(/filename: 'remoteEntry\.js'/)
    expect([...config.matchAll(/port: 5184/g)]).toHaveLength(2)
    expect([...config.matchAll(/strictPort: true/g)]).toHaveLength(2)
  })

  it('does not take a port another service already owns', () => {
    const taken = [3001, 5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180, 5181, 5182, 5183, 5185]
    for (const port of taken) expect(config).not.toContain(`port: ${port}`)
  })

  it('shares the same singletons as every other remote, with the shell as the one remote it consumes', () => {
    for (const name of ['react', 'react-dom', '@tanstack/react-router', 'better-auth']) {
      expect(config).toMatch(new RegExp(`'?${name}'?: \\{\\s*singleton: true`))
    }
    expect(config).toMatch(/remotes: \{\s*shell:/)
  })
})

describe('src/version.ts (ADR-0030)', () => {
  it('exports the remote’s own version, and "unknown" where the build did not define it', () => {
    expect(REMOTE_VERSION).toBe('unknown')
  })

  it('reads the version the build injects from this package’s own package.json', () => {
    expect(config).toContain('__REMOTE_VERSION__: JSON.stringify(pkg.version)')
  })
})
