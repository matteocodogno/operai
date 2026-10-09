/**
 * No hardcoded user-facing strings anywhere in `src/` (T24, specs/015-hardware-
 * inventory; design.md § Strings and numbers: "Every string through
 * `inventory-ui/src/strings.ts` with a `noHardcodedStrings` test").
 *
 * Unlike refund-ui's per-file allowlists, this scans EVERY component and page
 * under `src/` with the TypeScript parser, so a file added by a later task is
 * covered the moment it exists, with no list to remember to extend. It flags
 * the only places JSX can carry copy:
 *   - JSX text (`<p>Save</p>`),
 *   - a string literal child (`<p>{'Save'}</p>`),
 *   - a string value for a user-facing attribute (`aria-label`, `title`,
 *     `placeholder`, `alt`, `label`, ...).
 * Class names, `data-testid`s, `type`, `role`, ids and CSS values are other
 * attributes, so they are never flagged; text with no letters (separators such
 * as "/" or a middle dot) is not copy.
 *
 * Out of scope: `src/strings/` and `src/strings.ts` (the destination),
 * `src/federation/` (type declarations and test stubs) and test files.
 *
 * When this fails: move the text into `src/strings/<namespace>.ts` and render
 * `strings.<namespace>.<key>`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** JSX attributes whose string value a user (or a screen reader) reads. */
const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
])

const HAS_LETTER = /\p{L}/u

/** Returns every piece of hardcoded user-facing text found in a TSX source, as `where: text`. */
export function findHardcodedStrings(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const at = (node: ts.Node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return `${fileName}:${line + 1}`
  }
  const stringValue = (node: ts.Expression | undefined): string | undefined =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim()
      if (HAS_LETTER.test(text)) found.push(`${at(node)}: JSX text "${text}"`)
    } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const text = stringValue(node.expression)
      if (text !== undefined && HAS_LETTER.test(text)) found.push(`${at(node)}: JSX string child "${text}"`)
    } else if (ts.isJsxAttribute(node) && USER_FACING_ATTRIBUTES.has(node.name.getText(sourceFile))) {
      const init = node.initializer
      const text =
        init && ts.isStringLiteral(init)
          ? init.text
          : init && ts.isJsxExpression(init)
            ? stringValue(init.expression)
            : undefined
      if (text !== undefined && HAS_LETTER.test(text)) {
        found.push(`${at(node)}: ${node.name.getText(sourceFile)}="${text}"`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** Every non-test `.tsx` under src/, except the strings destination and the federation shims. */
function listScannedFiles(dir = SRC_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'strings' || entry.name === 'federation' ? [] : listScannedFiles(full)
    }
    return entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name) ? [full] : []
  })
}

describe('findHardcodedStrings (the scanner itself can fail)', () => {
  it('flags JSX text', () => {
    expect(findHardcodedStrings('a.tsx', 'export const A = () => <p>Save changes</p>')).toHaveLength(1)
  })

  it('flags a string literal child and a template-literal child', () => {
    const found = findHardcodedStrings('a.tsx', "export const A = () => <p>{'Save'}{`Cancel`}</p>")
    expect(found).toHaveLength(2)
  })

  it.each(['aria-label', 'title', 'placeholder', 'alt', 'label'])('flags a hardcoded %s', (attr) => {
    expect(findHardcodedStrings('a.tsx', `export const A = () => <input ${attr}="Search assets" />`)).toHaveLength(1)
    expect(findHardcodedStrings('a.tsx', `export const A = () => <input ${attr}={'Search assets'} />`)).toHaveLength(1)
  })

  it('reports the file and line', () => {
    const [hit] = findHardcodedStrings('pages/X.tsx', 'export const A = () => (\n  <p>\n    Hello\n  </p>\n)')
    expect(hit).toContain('pages/X.tsx:')
    expect(hit).toContain('Hello')
  })

  it('does not flag copy that comes from strings, technical attributes, or separators', () => {
    const source = `
      import { strings } from '../strings'
      export const A = ({ n }: { n: number }) => (
        <section className="flex gap-2" data-testid="inventory-x" role="status" aria-label={strings.common.save} id={\`row-\${n}\`}>
          <span>{strings.common.save}</span>
          <span>/</span>
          <span>{'·'}</span>
          <span>{n > 1 && n < 3 ? 'x' : 'y'}</span>
        </section>
      )`
    expect(findHardcodedStrings('a.tsx', source)).toEqual([])
  })
})

describe('no hardcoded user-facing strings in src/', () => {
  const files = listScannedFiles()

  it('scans the components and pages it is supposed to (the walk is not silently empty)', () => {
    const relative = files.map((file) => path.relative(SRC_DIR, file))
    expect(relative).toEqual(
      expect.arrayContaining(['App.tsx', 'MyDevices.tsx', path.join('pages', 'NotFoundPage.tsx')]),
    )
    expect(relative.some((file) => file.startsWith('strings') || file.startsWith('federation'))).toBe(false)
  })

  it.each(files.map((file) => [path.relative(SRC_DIR, file), file]))('%s has no inline copy', (_name, file) => {
    expect(findHardcodedStrings(path.relative(SRC_DIR, file), readFileSync(file, 'utf-8'))).toEqual([])
  })
})
