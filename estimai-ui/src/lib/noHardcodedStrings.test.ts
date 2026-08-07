/**
 * T14 done-when (specs/013-estimate-sharing/tasks.md): "no new hardcoded
 * user-facing string exists outside strings.ts (assert by lint/grep over the
 * new files)". This is a source-level grep test over this task's two new
 * non-`strings.ts` files (`identity.ts`, `AccessLevelBadge.tsx`) — it is
 * intentionally NOT a component-rendering test (those already live in
 * `identity.test.ts` / `AccessLevelBadge.test.tsx`); this one inspects raw
 * source text so it also catches copy that never gets exercised by a test.
 *
 * Method: strip import/comment lines, extract every remaining quoted/
 * template string literal, and assert each one is on an explicit, justified
 * allowlist of TECHNICAL tokens (CSS values, Tailwind classes, wire-contract
 * enum values, `data-testid`s, `aria-*` attribute values, a11y glyphs). Any
 * literal not on the allowlist fails the test — the fix is either to move
 * real copy into `strings.ts` and reference it via `strings.foo.bar`, or, for
 * a genuinely new technical token, to add it to the allowlist with a reason.
 *
 * A glyph (`✎`, `👁`) is allowlisted, not moved to `strings.ts`: it renders
 * `aria-hidden`, carries no accessible name, and is not natural-language
 * copy that a second locale would translate — design.md's Accessibility
 * section is explicit that the *label text*, not the glyph, is what must be
 * data-driven for i18n/a11y.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function extractStringLiterals(rawSource: string): string[] {
  const withoutImports = rawSource
    .split('\n')
    .filter((line) => !/^\s*import\b/.test(line))
    .join('\n')
  const withoutBlockComments = withoutImports.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '')

  const literalPattern = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g
  const matches = withoutLineComments.match(literalPattern) ?? []
  return matches.map((raw) => raw.slice(1, -1))
}

function assertOnlyAllowlisted(filePath: string, allowlist: Set<string>) {
  const source = readFileSync(fileURLToPath(new URL(filePath, import.meta.url)), 'utf-8')
  const literals = extractStringLiterals(source)
  const offenders = literals.filter((literal) => !allowlist.has(literal))
  expect(offenders, `unexpected literal(s) in ${filePath} — move real copy into strings.ts`).toEqual([])
}

describe('no hardcoded user-facing strings outside strings.ts (T14 new files)', () => {
  it('src/lib/identity.ts contains only wire-contract status literals', () => {
    assertOnlyAllowlisted(
      './identity.ts',
      new Set([
        // IdentityStatus union members + the equality checks against them —
        // a wire-contract vocabulary from `auth POST /authz/users/identities`
        // (plan.md), not translatable UI copy.
        'active',
        'deleted',
        'unknown',
      ]),
    )
  })

  it('src/components/AccessLevelBadge.tsx contains only technical/CSS/glyph literals', () => {
    assertOnlyAllowlisted(
      '../components/AccessLevelBadge.tsx',
      new Set([
        // AccessLevel union members — wire-contract vocabulary (plan.md's
        // `EstimateAccessLevel` enum: viewer | editor), not UI copy.
        'viewer',
        'editor',
        // a11y glyphs — aria-hidden, no accessible name, not translatable copy.
        '✎',
        '👁',
        // CSS custom-property references (index.css tokens).
        'var(--acc)',
        'var(--soft)',
        // `data-testid` value — a test hook, not user-facing.
        'access-level-badge',
        // Tailwind utility classes.
        'inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded',
        // `style` template literal — a CSS function, not copy.
        'color-mix(in srgb, ${color} 10%, transparent)',
        // `aria-hidden="true"` attribute value.
        'true',
      ]),
    )
  })
})
