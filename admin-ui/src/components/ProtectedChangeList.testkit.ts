/**
 * Test helper (D3, specs/20261117-legal-entities): the accessible DESCRIPTION of an element as the accname algorithm
 * computes it from `aria-describedby`, which is what a screen reader reads when a dialog opens. `textContent` of the
 * referenced element is NOT that: an `aria-label` on a descendant (accname 2C) or an `aria-labelledby` (2B) replaces
 * that descendant's content, which is how a labelled `<ul>` once hid every Old and New value (D-T68-2).
 *
 * `dom-accessibility-api` is not a direct dependency of admin-ui (adding it means a package.json/lockfile edit outside
 * D3's scope), so the traversal that matters here is written out: hidden subtrees skipped, 2B, 2C, then content, with
 * block-level and list elements separated by spaces.
 */
const BLOCK = new Set([
  'DIV',
  'P',
  'UL',
  'OL',
  'LI',
  'DL',
  'DT',
  'DD',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'SECTION',
  'FORM',
  'FIELDSET',
])

function isHidden(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  return style?.display === 'none' || style?.visibility === 'hidden'
}

function textOf(node: Node, referenced: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  if (!referenced && isHidden(el)) return ''
  const labelledby = el.getAttribute('aria-labelledby')
  if (labelledby !== null && !referenced) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter((target): target is HTMLElement => target !== null)
      .map((target) => textOf(target, true))
      .join(' ')
      .trim()
    if (text !== '') return text
  }
  const label = el.getAttribute('aria-label')?.trim()
  if (label !== undefined && label !== '') return label
  const inner = Array.from(el.childNodes)
    .map((child) => textOf(child, false))
    .join('')
  return BLOCK.has(el.tagName) ? ` ${inner} ` : inner
}

/** The accessible description of `el`: the text of the elements `aria-describedby` names, as accname computes it. */
export function accessibleDescription(el: Element): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id !== '')
  return ids
    .map((id) => el.ownerDocument.getElementById(id))
    .filter((target): target is HTMLElement => target !== null)
    .map((target) => textOf(target, true))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
