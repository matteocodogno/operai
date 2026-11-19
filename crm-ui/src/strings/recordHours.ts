/**
 * Record hours in place (specs/20261116-record-hours-in-place AC-4.5, AC-4.6, design S5). The button, its dialog and its
 * message are hours-ui's own widget and its own copy; these are the host's words for when that widget cannot be loaded:
 * a link to My hours where the button would have been.
 */
const en = {
  /** Where Record hours would be, after hours-ui failed to load, threw or did not answer in time. */
  fallbackLink: 'Record hours in My hours',
}

const it: typeof en = {
  fallbackLink: 'Registra ore in Le mie ore',
}

export const recordHours = { en, it }
