/*
 * Copied unchanged from refund-ui/src/test-support/axe.ts (specs/20261119-accounting, design § Accessibility,
 * "How accounting-ui gets the same automated accessibility check as refund-ui", layer 1; follow-up F-A1 lifts it into
 * a shared package once a third app needs it). Only this note is new. Where the comment below speaks of a "browser
 * pass" or of design.md's findings (the refund feature's), read: layer 2, the suite's real-browser axe in
 * `shell/e2e` (`accounting.spec.ts`, `accounting-access.spec.ts`, light and dark, English and Italian), and
 * layer 3, the QE's manual pass, which is where contrast and reflow are checked. accounting-ui starts with NO
 * `AxeAllowance`; a future one is recorded inline at its call site with its reason (`axeKnownFindings.ts` is not copied).
 */
/**
 * Automated accessibility check for component tests (T44, specs/20261118-refund-accounting-export).
 *
 * Follows operai-ui's use of axe-core (ConfirmDialog.test.tsx, ErrorSummary.test.tsx): `axe-core` is imported
 * directly and run on the rendered DOM under jsdom. The difference is one place for the configuration and a
 * readable failure: the assertion lists every violation, its rule, impact, help URL, the offending markup and
 * axe's fix hint, instead of an array of rule ids.
 *
 * Use it in a `@vitest-environment jsdom` test, after the state has settled:
 *
 *   const { container } = render(<Card />)
 *   await screen.findByRole('table')
 *   await expectNoAxeViolations(container)
 *
 * Rules that are switched off, and why (the same reasoning as operai-ui's tests, which disable `color-contrast`):
 *   - `color-contrast` and `color-contrast-enhanced` (AAA): need computed colours and layout. jsdom does no layout,
 *     and the design tokens come from CSS that is not loaded in a unit test, so the rule reports "incomplete" at
 *     best and a false verdict at worst. Contrast of the Accounting screens is NOT checked here and has not been
 *     checked yet: it belongs to the real-browser pass, owner step T51 (specs/20261119-accounting/design.md,
 *     "Browser accessibility pass (pending, owner step T51)"; no result is recorded there until that pass runs).
 *   - `region`, `landmark-one-main`, `page-has-heading-one`: page-level rules about the document's landmarks and
 *     its `<h1>`. A component test renders a fragment into `document.body`, and the page's `<main>` and `<h1>`
 *     belong to the shell that hosts this remote, so these would fail on every fragment (design.md calls
 *     `landmark-one-main` "a harness artefact, not a finding"). Everything else, including the heading-order,
 *     list, table, form-label, ARIA and name rules, runs.
 *
 * What jsdom cannot see: rules that need layout come back from axe as "incomplete", not as violations, and this
 * helper does not fail on those. `label-content-name-mismatch` is one (design.md A-6, the batch page's request
 * links, is pre-existing and reproduces only in a real browser), as is `scrollable-region-focusable`'s
 * overflow test. A browser pass remains the check for them.
 *
 * A finding that belongs outside this feature (an `@operai/ui` primitive, or older code) is not fixed here: pass
 * it as `allow` with the rule, a selector that matches only the offending element(s) and the reason. The
 * entry is matched node by node, so the rest of the rule still applies to everything else.
 */

import axe from 'axe-core'
import type { AxeResults, ImpactValue, Result, RunOptions } from 'axe-core'

/** One targeted, documented exclusion: `rule` is ignored for the elements matching `selector` only. */
export interface AxeAllowance {
  rule: string
  /** CSS selector; a violating node is ignored only if it is, or sits inside, an element this selector matches. */
  selector: string
  /** Why this is not fixed here, and where it belongs (a finding id from design.md, or the owning package). */
  reason: string
}

export interface AxeCheckOptions {
  /** Extra rules to switch off for this check (prefer `allow`: it is narrower). Needs a reason in the call site. */
  allow?: readonly AxeAllowance[]
}

/** Rules switched off for a component test; each reason is in the file comment. */
const DISABLED_RULES = [
  'color-contrast',
  'color-contrast-enhanced',
  'region',
  'landmark-one-main',
  'page-has-heading-one',
] as const

const RUN_OPTIONS: RunOptions = {
  rules: Object.fromEntries(DISABLED_RULES.map((id) => [id, { enabled: false }])),
  // `node.element` lets `allow` match a node by DOM, not by axe's generated selector path.
  elementRef: true,
}

const IMPACT_ORDER: Record<ImpactValue & string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 }

/** Run axe on `root` (default: the whole `document.body`, so portalled dialogs are included). */
export async function axeViolations(
  root: Element = document.body,
  { allow = [] }: AxeCheckOptions = {},
): Promise<Result[]> {
  const results: AxeResults = await axe.run(root, RUN_OPTIONS)
  const allowedByRule = new Map<string, Element[]>()
  for (const { rule, selector } of allow) {
    const matches = [...document.querySelectorAll(selector)]
    allowedByRule.set(rule, [...(allowedByRule.get(rule) ?? []), ...matches])
  }
  return results.violations
    .map((violation) => {
      const allowed = allowedByRule.get(violation.id) ?? []
      const nodes = violation.nodes.filter(
        (node) => !node.element || !allowed.some((element) => element.contains(node.element!)),
      )
      return { ...violation, nodes }
    })
    .filter((violation) => violation.nodes.length > 0)
    .sort((a, b) => IMPACT_ORDER[a.impact ?? 'minor'] - IMPACT_ORDER[b.impact ?? 'minor'])
}

/** A readable report: one block per violated rule, one entry per offending element. Empty string when clean. */
export function formatAxeViolations(violations: readonly Result[]): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => {
          const hint = node.failureSummary?.replace(/\n/g, '\n      ') ?? ''
          return `    - ${node.html}\n      ${hint}`
        })
        .join('\n')
      return `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n  ${violation.helpUrl}\n${nodes}`
    })
    .join('\n\n')
}

/**
 * Fail unless axe finds no violation. The failure message is the readable report, so a red test says which rule,
 * which element and how to fix it without re-running axe by hand.
 */
export async function expectNoAxeViolations(root: Element = document.body, options: AxeCheckOptions = {}) {
  const violations = await axeViolations(root, options)
  if (violations.length > 0) {
    throw new Error(`axe found ${violations.length} violation(s):\n\n${formatAxeViolations(violations)}\n`)
  }
}
