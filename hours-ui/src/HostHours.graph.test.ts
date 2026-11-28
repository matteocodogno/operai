/**
 * What the `./HostHours` entry loads (specs/20261112-project-hours T13; plan § Components `hours-ui` (a), D-P4; the `RecordHours.graph.test.ts`
 * rule): a host page (the project page, the deal page) loads this one module for its Hours card, so it must stay the total, the disclosure
 * and the two tables, and never drag in My hours' pages, the router or `exceljs` (which belong to the export, behind its own lazy import).
 * `rg -l exceljs dist/` after a build is the end-to-end check; this is the one that runs in `pnpm test`: it follows every STATIC import from
 * `src/HostHours.tsx` (a dynamic `import()` is its own chunk and is not followed; a type-only import is erased) and fails the moment a heavy
 * module becomes reachable.
 *
 * It also keeps the router out: the panel renders in the host's tree, where hours-ui's router does not exist, so a `useNavigate` or a `Link`
 * inside it would throw there.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(SRC, 'HostHours.tsx')

/** The module specifiers a file imports (or re-exports) for real: type-only declarations and dynamic imports are left out. */
function staticImportsOf(fileName: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!statement.importClause?.isTypeOnly) found.push(statement.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      if (!statement.isTypeOnly) found.push(statement.moduleSpecifier.text)
    }
  }
  return found
}

const resolveRelative = (from: string, specifier: string): string => {
  const base = path.resolve(path.dirname(from), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  const found = candidates.find((candidate) => path.extname(candidate) !== '' && existsSync(candidate))
  if (found === undefined) throw new Error(`cannot resolve ${specifier} from ${path.relative(SRC, from)}`)
  return found
}

/** Every file of `src/` and every package reachable from `entry` through static imports. */
function reachableFrom(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const visit = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    for (const specifier of staticImportsOf(file, readFileSync(file, 'utf-8'))) {
      if (specifier.startsWith('.')) visit(resolveRelative(file, specifier))
      else packages.add(specifier)
    }
  }
  visit(entry)
  return { files: [...files].map((file) => path.relative(SRC, file)).sort(), packages: [...packages].sort() }
}

describe('staticImportsOf (the scanner itself can fail)', () => {
  it('reads imports and re-exports, and leaves type-only ones and dynamic imports out', () => {
    const source = `
      import a from './a'
      import { b } from 'bee'
      import type { C } from './c'
      export { d } from './d'
      export type { E } from './e'
      const lazy = () => import('exceljs')
    `
    expect(staticImportsOf('x.ts', source)).toEqual(['./a', 'bee', './d'])
  })
})

describe('what ./HostHours loads (plan § Components hours-ui (a))', () => {
  const { files, packages } = reachableFrom(ENTRY)

  it('reaches the model, the API client, the entry list’s duration, the event and the strings it is made of (the walk is not silently empty)', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'HostHours.tsx',
        'HostHoursModel.ts',
        path.join('components', 'EntryRow.tsx'),
        path.join('lib', 'hoursApi.ts'),
        path.join('lib', 'timeEntryRecordedEvent.ts'),
        'strings.ts',
      ]),
    )
  })

  it('never reaches `exceljs`, the workbook or the export: those stay behind the export’s lazy import', () => {
    expect(packages).not.toContain('exceljs')
    expect(files).not.toContain(path.join('lib', 'hoursWorkbook.ts'))
    expect(files).not.toContain(path.join('components', 'HoursExport.tsx'))
  })

  it('never reaches the entry dialog or the Record hours button: reading hours is not recording them', () => {
    expect(files).not.toContain(path.join('components', 'EntryDialog.tsx'))
    expect(files).not.toContain('RecordHours.tsx')
  })

  it('never reaches a page, the app or the router of My hours', () => {
    expect(
      files.filter((file) => file.startsWith('pages') || ['App.tsx', 'router.tsx', 'main.tsx'].includes(file)),
    ).toEqual([])
  })

  it('never imports the router: it renders in the host’s tree, where hours-ui’s router does not exist', () => {
    expect(packages).not.toContain('@tanstack/react-router')
  })
})
