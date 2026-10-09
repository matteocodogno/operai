/**
 * strings.nav — the tool layout's copy (T28, specs/015-hardware-inventory;
 * design.md § T0 InventoryShell and Resolutions G1/G11): the heading, the tab
 * navigation and the states the layout shows before a page does.
 */
export const nav = {
  /** The tool's h1. */
  heading: 'Inventory',
  /** `aria-label` of the tab navigation landmark. */
  landmarkLabel: 'Inventory sections',
  assets: 'Assets',
  rules: 'Depreciation rules',
  years: 'Fiscal years',
  /** sr-only polite line while `GET /scope` loads. */
  loading: 'Loading inventory…',
  /** Tool access, but both capability scopes are empty (not an empty list). */
  scopeEmpty: {
    heading: 'No entity in your scope',
    body: 'You can use Inventory, but no legal entity is assigned to your account yet. Ask an administrator to assign one.',
  },
} as const
