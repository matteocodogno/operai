import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The suite runs ONE React (Module Federation singleton, ADR-0006). A floating range in this
 * remote resolved react 19.3.1 while the shell and every other remote ran 19.2.7, and with both
 * registered the shell crashed ("Cannot read properties of null (reading 'useState')"). The
 * versions are pinned exactly here and checked against crm-ui's lockfile, the suite reference.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), 'utf-8')
const lockedVersion = (lock: string, name: string): string | undefined =>
  new RegExp(`^ {2}${name}@(\\d[^:(\\s]*):`, 'm').exec(lock)?.[1]

const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
const mine = read('pnpm-lock.yaml')
const suite = read('..', 'crm-ui', 'pnpm-lock.yaml')

describe('the suite runs one React', () => {
  it.each(['react', 'react-dom'])('%s is pinned exactly in package.json', (name) => {
    expect(pkg.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.each(['react', 'react-dom'])("%s resolves to the version crm-ui's lockfile resolves", (name) => {
    const reference = lockedVersion(suite, name)
    expect(reference).toBeDefined()
    expect(lockedVersion(mine, name)).toBe(reference)
    expect(pkg.dependencies[name]).toBe(reference)
  })

  it('declares react and react-dom as federation singletons', () => {
    const config = read('vite.config.ts')
    expect(config).toMatch(/react: \{ singleton: true, requiredVersion: caret\(/)
    expect(config).toMatch(/'react-dom': \{ singleton: true, requiredVersion: caret\(/)
  })
})
