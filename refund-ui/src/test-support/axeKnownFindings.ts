/**
 * Findings axe reports in code that this feature did not write or change (T44, specs/20261118-refund-accounting-export).
 * They are not fixed here: each is excluded for the exact elements it concerns, with its owner, so everything else
 * those rules check still applies and the exclusion disappears with the fix. Pass the entry to
 * `expectNoAxeViolations(root, { allow: [...] })` only in a test whose state renders that component.
 */

import type { AxeAllowance } from './axe'

/**
 * `SubtotalsPanel` (a request's "Totals" card, specs/20260716-refund-service, last changed by 3aecb6f1 "show one figure
 * unless accounting adjusted the amount"; untouched by this feature). In the approved state its `<dl>` holds a
 * `<div>` that holds a `<dt>` and a `<div>` that holds the `<dd>` (and the delta `<dd>`), so axe reports
 * `definition-list` on the `<dl>` and `dlitem` on each `<dd>`: a `<dd>` must be a direct child of its `<dl>` or of
 * a `<div>` that is. Owner: whoever next touches SubtotalsPanel; the fix is to put the `<dt>` and the `<dd>`s in
 * one `<div>` and drop the wrapper around the `<dd>`s (the right alignment moves to the `<dd>`). Seen on the
 * review page and the request page of an approved or paid request.
 */
export const SUBTOTALS_PANEL_DEFINITION_LIST: readonly AxeAllowance[] = [
  {
    rule: 'definition-list',
    selector: '[data-testid^="subtotals-panel-card-"] dl',
    reason:
      'SubtotalsPanel (pre-existing, specs/20260716-refund-service): the approved figure wraps its <dd> in an extra <div>',
  },
  {
    rule: 'dlitem',
    selector: '[data-testid^="subtotals-approved-"]',
    reason:
      'SubtotalsPanel (pre-existing, specs/20260716-refund-service): the approved <dd> sits in a <div> inside the <div> inside the <dl>',
  },
]
