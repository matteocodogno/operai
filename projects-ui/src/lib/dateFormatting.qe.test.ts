/**
 * QE addition for specs/021-projects (T19): AC-4.7 says dates use the library formatters
 * (`formatDate` from `@operai/ui`, which follows the suite's language). `strings.test.ts` and
 * `noHardcodedStrings.test.ts` guard the copy half of that AC; nothing guarded the date half, so
 * a hand-rolled `toLocaleDateString('en-GB')` or `Intl.DateTimeFormat` would have passed every
 * test and shown a Swiss-Italian user an English date.
 *
 * This scans every non-test source file under `src/` for the browser's own date formatting.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const isSource = (name: string) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return isSource(entry.name) ? [full] : []
  })
}

/** Date formatting the library formatters replace. `toLocaleString`/`toLocaleDateString` on a Date, and `Intl.DateTimeFormat`. */
export const HAND_ROLLED_DATE_FORMATTING =
  /toLocale(Date|Time)?String\s*\(|Intl\s*\.\s*(DateTimeFormat|RelativeTimeFormat)/

describe('dates go through the library formatters (AC-4.7)', () => {
  const files = walk(SRC_DIR)

  it('scans the files that render dates (the walk is not silently empty)', () => {
    const relative = files.map((file) => path.relative(SRC_DIR, file))
    expect(relative).toEqual(
      expect.arrayContaining([
        path.join('components', 'TermsDetails.tsx'),
        path.join('pages', 'ProjectDetailPage.tsx'),
      ]),
    )
  })

  it('the pages that show dates use formatDate from @operai/ui', () => {
    for (const file of ['components/TermsDetails.tsx', 'pages/ProjectDetailPage.tsx']) {
      expect(readFileSync(path.join(SRC_DIR, file), 'utf-8'), file).toMatch(
        /\bformatDate\b[^]*from '@operai\/ui'|from '@operai\/ui'[^]*\bformatDate\b/,
      )
    }
  })

  it('the scanner can fail: it flags a hand-rolled date format', () => {
    expect("new Date(value).toLocaleDateString('en-GB')").toMatch(HAND_ROLLED_DATE_FORMATTING)
    expect("new Intl.DateTimeFormat('it').format(d)").toMatch(HAND_ROLLED_DATE_FORMATTING)
    expect('formatDate(project.startDate)').not.toMatch(HAND_ROLLED_DATE_FORMATTING)
  })

  it.each(files.map((file) => [path.relative(SRC_DIR, file), file]))('%s formats no date by hand', (_name, file) => {
    expect(readFileSync(file as string, 'utf-8')).not.toMatch(HAND_ROLLED_DATE_FORMATTING)
  })
})
