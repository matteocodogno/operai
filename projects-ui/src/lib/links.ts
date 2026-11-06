/**
 * Links to the sibling tools the shell mounts next to `/projects` (specs/022). They sit outside this
 * remote's router basepath, so they are plain `<a href>`, never router links; the target tool decides
 * access and shows its own unavailable state (AC-3.2).
 */

/** An estimate in EstimAI (crm-ui `links.ts` precedent). */
export const estimaiEstimateHref = (estimateId: string): string =>
  `/estimai/estimates/${encodeURIComponent(estimateId)}`

/** A deal in the CRM. */
export const crmDealHref = (dealId: string): string => `/crm/deals/${encodeURIComponent(dealId)}`

/**
 * `mailto:` for a contact's email (T18 M5, L9). The scheme is fixed here and the value is only ever the
 * rest of the URL, encoded so that nothing in it can add a recipient (`,`), a header (`?`, `&`) or a
 * fragment; the `@` stays readable. `null` for a blank value: no link, the page shows the text only.
 */
export const mailtoHref = (email: string): string | null => {
  const address = email.trim()
  return address === '' ? null : `mailto:${encodeURIComponent(address).replace(/%40/g, '@')}`
}

/**
 * `tel:` for a contact's phone (T18 M5, L9): the digits and a leading plus only; whatever else the value
 * carries (spaces, dashes, a `;phone-context=` parameter) is left out. `null` when no digit is left.
 */
export const telHref = (phone: string): string | null => {
  const number = phone
    .trim()
    .replace(/[^\d+]/g, '')
    .replace(/(?!^)\+/g, '')
  return /\d/.test(number) ? `tel:${number}` : null
}
