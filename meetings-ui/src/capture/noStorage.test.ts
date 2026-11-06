/**
 * AC-4.11: nothing about a recording is ever kept on the device. Audio that cannot be uploaded waits in
 * a JavaScript array and survives only as long as the tab does (spec amendment A2).
 *
 * This is a static scan of every non-test file in `src/capture/`, with the TypeScript parser, so it
 * looks at code (identifiers, string keys) and not at comments that merely describe the rule. It flags
 * the browser storage APIs by name: IndexedDB, CacheStorage, localStorage, sessionStorage, the old
 * WebSQL, `navigator.storage` and cookies.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const CAPTURE_DIR = path.dirname(fileURLToPath(import.meta.url))

const FORBIDDEN = new Set([
  'indexedDB',
  'IDBFactory',
  'IDBDatabase',
  'caches',
  'CacheStorage',
  'localStorage',
  'sessionStorage',
  'openDatabase',
  'StorageManager',
  'cookie',
  'cookieStore',
])

/** Every use of a storage API in a TypeScript source, as `file:line: name`. */
export function findStorageUse(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const at = (node: ts.Node) =>
    `${fileName}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) found.push(`${at(node)}: ${node.text}`)
    // `globalThis['localStorage']`, `window["indexedDB"]`
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && FORBIDDEN.has(node.text)) {
      found.push(`${at(node)}: '${node.text}'`)
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(sourceFile) === 'navigator' &&
      node.name.text === 'storage'
    ) {
      found.push(`${at(node)}: navigator.storage`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

const productionFiles = readdirSync(CAPTURE_DIR)
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file))
  .map((file) => path.join(CAPTURE_DIR, file))

describe('findStorageUse (the scanner itself can fail)', () => {
  it.each([
    'indexedDB.open("x")',
    'window.localStorage.setItem("a", "b")',
    'sessionStorage.clear()',
    'await caches.open("v1")',
    'globalThis["localStorage"]',
    'navigator.storage.persist()',
    'document.cookie = "a=b"',
    'openDatabase("x", "1", "x", 1)',
  ])('flags %s', (code) => {
    expect(findStorageUse('x.ts', `export const f = async () => { ${code} }`)).not.toEqual([])
  })

  it('does not flag a comment that explains the rule, or an unrelated name', () => {
    const source =
      '// never touch indexedDB, localStorage or sessionStorage\nexport const cachesCount = 1\nexport const queue: Blob[] = []'
    expect(findStorageUse('x.ts', source)).toEqual([])
  })
})

describe('src/capture uses no browser storage (AC-4.11)', () => {
  it('scans the capture files (the walk is not silently empty)', () => {
    const names = productionFiles.map((file) => path.basename(file))
    expect(names).toEqual(expect.arrayContaining(['capabilities.ts', 'mixer.ts', 'session.ts', 'uploader.ts']))
  })

  it.each(productionFiles.map((file) => [path.basename(file), file]))('%s', (_name, file) => {
    expect(findStorageUse(path.basename(file!), readFileSync(file!, 'utf-8'))).toEqual([])
  })
})
