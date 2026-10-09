import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { strings } from './strings'

const STRINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'strings')

/**
 * T24's promise to later tasks: strings.ts aggregates one file per namespace,
 * so nobody edits it again. These namespaces are the ones design.md § Strings
 * and numbers and the later tasks' `touch:` lists name.
 */
const NAMED_BY_LATER_TASKS = [
  'common',
  'errors',
  'badges',
  'nav',
  'assets',
  'register',
  'assetDetail',
  'actions',
  'ledger',
  'invoice',
  'history',
  'rules',
  'years',
  'myDevices',
  'dialogs',
  'empty',
  'categories',
  'disposalReasons',
  'yearDetail',
]

describe('strings aggregate', () => {
  it.each(NAMED_BY_LATER_TASKS)('exposes the %s namespace', (namespace) => {
    expect(strings).toHaveProperty(namespace)
  })

  it('aggregates every file under src/strings/ (a namespace file nobody wired in would be invisible)', () => {
    const namespaces = readdirSync(STRINGS_DIR).map((file) => path.basename(file, '.ts'))
    expect(namespaces.length).toBeGreaterThan(0)
    expect(Object.keys(strings).sort()).toEqual([...namespaces].sort())
  })
})
