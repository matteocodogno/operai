/**
 * AC-5.7 (as amended 2026-08-11) — "this feature's components introduce no
 * user-facing string literal inline, and every string this feature adds is
 * reachable through a key path on `strings.ts` and is typed against its
 * exported type" (T14, specs/014-motivo-autocomplete/tasks.md).
 *
 * Ported from `estimai-ui/src/lib/noHardcodedStrings.test.ts`, which specs/013
 * introduced for the same purpose. Deliberately a SOURCE-LEVEL grep rather
 * than a rendering test: the rendering assertions already live in
 * `MotivoSuggestField.test.tsx` / `ExpenseLineComposer.test.tsx`, whereas this
 * one inspects raw source text and so also catches copy that no test ever
 * exercises — a `title`, an `aria-label` on a rarely-reached branch, a
 * placeholder.
 *
 * Method: strip import lines and comments, extract every remaining quoted or
 * templated string literal, and assert each one is on an explicit, justified
 * allowlist of TECHNICAL tokens — CSS values and custom properties, Tailwind
 * class strings, ARIA attribute values, DOM/keyboard event names, wire-contract
 * enum values, `data-testid`s and derived-id templates. Anything not on the
 * list fails.
 *
 * When this test fails, there are exactly two correct fixes:
 *   1. the literal is real user-facing copy → move it into `strings.ts` under a
 *      namespaced key path and reference it as `strings.foo.bar`; or
 *   2. the literal is a genuinely new TECHNICAL token → add it below, in the
 *      right group, with a reason.
 *
 * Scope: this feature's three new source files plus the one existing file it
 * changed. `strings.ts` itself is, obviously, exempt — it is the destination.
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
  expect(
    [...new Set(offenders)],
    `unexpected literal(s) in ${filePath} — move real copy into strings.ts and reference it as strings.<path>`,
  ).toEqual([])
}

/** CSS custom properties and values shared by both components below. */
const CSS_TOKENS = [
  'var(--acc)',
  'var(--acc-lo)',
  'var(--disp)',
  'var(--ink)',
  'var(--ink-mid)',
  'var(--ink-soft)',
  'var(--muted)',
  'var(--red)',
  'var(--rule)',
  'var(--soft)',
  'var(--text)',
]

describe('AC-5.7 — no hardcoded user-facing strings outside strings.ts (specs/014 files)', () => {
  it('src/lib/tripSuggestions.ts contains only Unicode normalisation-form tokens', () => {
    assertOnlyAllowlisted(
      './tripSuggestions.ts',
      new Set([
        // `String.prototype.normalize` form arguments — a Unicode API
        // vocabulary, not copy. See the fold's step-order documentation.
        'NFD',
        'NFC',
        // The whitespace-collapse replacement and the empty accent-strip
        // replacement — punctuation the fold emits, never displayed.
        ' ',
        '',
      ]),
    )
  })

  it('src/lib/suggestionsApi.ts contains only the endpoint path and its wire enum', () => {
    assertOnlyAllowlisted(
      './suggestionsApi.ts',
      new Set([
        // refund-api's route + its single-member query enum (plan.md
        // "## API contracts"). A wire contract, never shown to anyone.
        '/line-suggestions?type=travel_km',
        'travel_km',
      ]),
    )
  })

  it('src/components/MotivoSuggestField.tsx contains only technical/CSS/ARIA literals', () => {
    assertOnlyAllowlisted(
      '../components/MotivoSuggestField.tsx',
      new Set([
        ...CSS_TOKENS,
        // ARIA and HTML attribute VALUES — a fixed a11y vocabulary the ARIA
        // spec defines, never translatable copy. (Every ARIA *label* in this
        // component comes from `strings.components.motivoSuggest`.)
        'combobox',
        'listbox',
        'option',
        'list',
        'polite',
        'off',
        'text',
        // DOM event name + `scrollIntoView` option value.
        'pointerdown',
        'nearest',
        // `KeyboardEvent.key` values — the keyboard contract (design.md
        // "Interaction and keyboard"), a UA vocabulary, not copy.
        'ArrowDown',
        'ArrowUp',
        'Enter',
        'Escape',
        'Home',
        'End',
        'Tab',
        // Derived element ids / `data-testid`s and the option React key —
        // test and a11y wiring hooks, never rendered as text.
        '${id}-listbox',
        '${id}-live',
        '${id}-option-${index}',
        '${id}-option-${activeIndex}',
        '${suggestion.normalisedMotivo}|${suggestion.km}|${suggestion.entity}',
        // Tailwind utility class strings.
        'relative',
        'sr-only',
        'text-sm px-2.5 py-1.5 border rounded',
        'absolute z-10 mt-1 border rounded-md shadow-lg overflow-y-auto',
        'px-3 py-2 cursor-pointer',
        'text-sm overflow-hidden text-ellipsis whitespace-nowrap',
        'flex items-center gap-2',
        'flex items-center justify-between gap-2 text-[11px]',
        // Inline CSS values for the popup's size, anchoring and highlight.
        '100%',
        'max(100%, 20rem)',
        'calc(100vw - 1.5rem)',
        'min(18rem, 50vh)',
        'contain',
        'transparent',
        '3px solid transparent',
        '3px solid var(--acc)',
        'color-mix(in srgb, var(--acc) 6%, transparent)',
        // The empty live-region text — the deliberate silence AC-1.6 requires
        // (a "no suggestions" announcement would be the forbidden empty state
        // in the audio channel), so it is an absence of copy, not copy.
        '',
      ]),
    )
  })

  it('src/components/ExpenseLineComposer.tsx contains only technical/CSS/wire literals', () => {
    assertOnlyAllowlisted(
      '../components/ExpenseLineComposer.tsx',
      new Set([
        ...CSS_TOKENS,
        // Wire-contract enum values (specs/007 `Entity`/`Currency`), matched
        // and emitted, never displayed — their LABELS come from
        // `strings.badges.entity` / `strings.badges.currency`.
        'welld_it',
        'welld_ch',
        'EUR',
        'CHF',
        'USD',
        'GBP',
        // `data-testid`s and the ids their `<label htmlFor>` associations use.
        'expense-line-composer',
        'composer-add-button',
        'composer-amount',
        'composer-currency',
        'composer-date',
        'composer-entity',
        'composer-error',
        'composer-km',
        'composer-km-help',
        'composer-km-status',
        'composer-motivo',
        'composer-type',
        // HTML/ARIA attribute values.
        'text',
        'date',
        'number',
        'submit',
        'alert',
        'polite',
        'true',
        'dark',
        // `<input type="number">` step/min bounds — numeric constraints.
        '0',
        '0.01',
        '1',
        // Tailwind utility class strings + the grid template.
        'sr-only',
        'flex flex-col gap-1',
        'flex flex-col gap-3 rounded-md border p-4',
        'grid gap-3',
        'text-[11px]',
        'text-xs',
        'text-xs font-medium',
        'text-sm font-semibold',
        'text-sm px-2.5 py-1.5 border rounded',
        'py-1.5 px-3 text-sm font-medium border transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed',
        'repeat(auto-fit, minmax(160px, 1fr))',
        // The empty-string draft sentinels (`type === ''`, `entity: ''`).
        '',
      ]),
    )
  })
})
