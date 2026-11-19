/**
 * Record hours on the pages and rows of this tool (specs/20261116-record-hours-in-place): hours-ui's widget owns
 * every word of the button, the dialog and the message; this host owns only the link it shows in the widget's
 * place when the hours screens cannot be loaded (AC-4.5, design S5). The Italian follows hours-ui's words
 * ("Registra ore", "Le mie ore") and wants a native reader before release (design § Copy).
 */
const en = {
  /** The host's fallback link to My hours, in the slot Record hours would occupy. */
  fallback: 'Record hours in My hours',
}

const it: typeof en = {
  fallback: 'Registra ore in Le mie ore',
}

export const recordHours = { en, it }
