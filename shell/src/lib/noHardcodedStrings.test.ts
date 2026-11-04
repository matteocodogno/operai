/**
 * INC-24 — no user-visible string outside the strings module, in EVERY
 * non-test .tsx under src/ (new files are scanned automatically).
 *
 * Parses each file with the TypeScript compiler and inspects every string
 * literal, template and JSX text node. A literal passes when it is clearly not
 * copy:
 *   - it contains no letters (punctuation, numbers, "—", "9+");
 *   - it sits in an import/export specifier or a type position;
 *   - it is the value of a technical JSX attribute (className, data-testid,
 *     id, to, href, role, variant, the Icon `name`…), or a technical argument
 *     (`console.*`, `new Error`, `import()`);
 *   - it is a list of utility classes (recognised by shape);
 *   - it is on TECHNICAL below, with a reason.
 * Everything else — JSX text above all — fails: move it into src/strings.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const isScanned = (file: string) =>
  file.endsWith('.tsx') && !/\.test\.tsx$/.test(file) && !file.includes(`${path.sep}__stubs__${path.sep}`)

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? listFiles(full) : isScanned(full) ? [full] : []
  })
}

/** JSX attributes whose value is wiring or styling, never shown to anyone. */
const TECHNICAL_ATTRIBUTES = new Set([
  'className',
  'data-testid',
  'id',
  'key',
  'to',
  'href',
  'src',
  'rel',
  'target',
  'role',
  'type',
  'name',
  'variant',
  'size',
  'tone',
  'align',
  'triggerShape',
  'width',
  'viewBox',
  'fill',
  'stroke',
  'strokeLinecap',
  'strokeLinejoin',
  'd',
  'referrerPolicy',
  'testId',
  'testIdPrefix',
  'titleId',
  'headingTestId',
  'retryTestId',
  'aria-live',
  'aria-hidden',
  'aria-haspopup',
  'aria-atomic',
  'aria-labelledby',
  'focusable',
])

/** Technical literals outside attributes: route paths, storage keys, enum values, DOM vocabulary. */
const TECHNICAL = new Set([
  // KeyboardEvent.key / DOM event names.
  'Escape',
  'ArrowDown',
  'ArrowRight',
  'ArrowUp',
  'ArrowLeft',
  'Home',
  'End',
  'mousedown',
  'keydown',
  // ARIA role / live values chosen in a lookup table.
  'status',
  'alert',
  'polite',
  'assertive',
  // Severity and theme enum values, tool ids, icon names.
  'info',
  'success',
  'warning',
  'error',
  'system',
  'light',
  'dark',
  'estimai',
  'refund',
  'admin',
  'inventory',
  'crm',
  'meetings',
  'notify',
  'settings',
  'sun',
  'moon',
  'check-circle',
  'x-circle',
  'chevron-left',
  'chevron-right',
  'banknote',
  'box',
  'mic',
  // Route paths and route ids.
  '/',
  '_shell',
  '_authed',
  '/no-access',
  '/account',
  '/devices',
  '/notify',
  '/notify/$',
  '/estimai',
  '/estimai/$',
  '/refund',
  '/refund/$',
  '/admin',
  '/admin/$',
  '/inventory',
  '/inventory/$',
  '/crm',
  '/crm/$',
  '/meetings',
  '/meetings/$',
  '/my-meetings',
  '/my-meetings/$',
  '/operai.svg',
  // The product name, the same in every language.
  'Operai',
  // CSS class fragments toggled by state.
  'sr-only',
  'font-mono',
  'font-semibold',
  'font-normal',
  'w-full',
  'justify-center px-0',
  'gap-3 px-3',
  'w-16',
  'w-56',
  'translate-y-0 opacity-100',
  '-translate-y-2 opacity-0',
  'bg-acc-lo text-acc hover:bg-acc-lo hover:text-acc',
  // Element ids.
  'root',
  'shell-main-content',
  // Async-state discriminants.
  'loading',
  'loaded',
  // Router wiring: the hosted sign-in redirect URL and the preload strategy.
  '${getAuthUrl()}/sign-in?redirect=${encodeURIComponent(window.location.href)}',
  'preload',
])

// A utility family always takes a suffix (`items-center`, `px-3`); the few
// bare utilities are listed as words, so an English word like "items" or
// "block" alone is not mistaken for styling.
const UTILITY_CLASS =
  /^(?:[a-z-]+:)*-?(?:text|bg|border|font|p[xytblr]?|m[xytblr]?|gap|space|w|h|size|min|max|flex|grid|inline|items|justify|self|place|content|rounded|shadow|overflow|whitespace|leading|tracking|z|top|bottom|left|right|inset|opacity|cursor|transition|duration|ease|animate|ring|outline|fill|stroke|divide|col|row|order|tabular|line|list|object|aspect|basis|grow|shrink|break|decoration|underline|select|pointer|resize|align|sr|motion|translate|focus|not)-[a-z0-9./[\]%()#,_-]+$/
const UTILITY_WORDS = new Set([
  'flex',
  'grid',
  'block',
  'hidden',
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'italic',
  'uppercase',
  'truncate',
  'underline',
  'border',
  'rounded',
  'shadow',
  'outline',
  'transition',
  'grow',
  'shrink',
  'icon',
  'link',
])
const isUtilityClassList = (text: string) => {
  const tokens = text
    .replace(/\$\{[^}]*\}/g, ' ')
    .trim()
    .split(/\s+/)
  return (
    tokens.length > 0 &&
    tokens[0] !== '' &&
    tokens.every((token) => UTILITY_WORDS.has(token.replace(/^(?:[a-z-]+:)+/, '')) || UTILITY_CLASS.test(token))
  )
}

const hasLetters = (text: string) => /\p{L}/u.test(text.replace(/\$\{[^}]*\}/g, '').replace(/&[a-z]+;/g, ''))

function isTechnicalPosition(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current) || ts.isModuleDeclaration(current))
      return true
    if (ts.isLiteralTypeNode(current) || ts.isTypeNode(current)) return true
    if (ts.isJsxAttribute(current)) return TECHNICAL_ATTRIBUTES.has(current.name.getText())
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      const callee = current.expression.getText()
      if (
        /^console\.|^Error$|^import$|^lazy$|^vi\./.test(callee) ||
        current.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        return true
    }
    if (ts.isPropertyAssignment(current) && current.name === node) return true
    if (ts.isBlock(current) || ts.isSourceFile(current)) return false
  }
  return false
}

function offendersIn(file: string, text = readFileSync(file, 'utf-8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.getText().trim()
      if (text && hasLetters(text)) found.push(text)
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node) ? node.getText().slice(1, -1) : node.text
      if (hasLetters(text) && !TECHNICAL.has(text) && !isUtilityClassList(text) && !isTechnicalPosition(node)) {
        found.push(text)
      }
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((span) => visit(span.expression))
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const files = listFiles(SRC)

describe('INC-24 — no hardcoded user-visible strings outside src/strings.ts', () => {
  it('scans every non-test .tsx under src/', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('flags copy and lets wiring through (self-check)', () => {
    const fixture = [
      "import { x } from 'some-module'",
      'export const A = () => (',
      '  <button className="text-sm" data-testid="go" aria-label="Go now" title={t.ok}>',
      '    Sign out',
      '  </button>',
      ')',
      'const b = `${n} items`',
    ].join('\n')
    expect(offendersIn('fixture.tsx', fixture)).toEqual(['Go now', 'Sign out', '${n} items'])
  })

  it.each(files.map((file) => [path.relative(SRC, file), file]))('%s', (_name, file) => {
    expect(offendersIn(file), 'move this copy into src/strings.ts').toEqual([])
  })
})
