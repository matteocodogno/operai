/**
 * Product/application metadata shown in the About dialog.
 *
 * Centralised here so no UI copy is hardcoded in components. EstimAI is the
 * first tool in the Operai suite, built by wellD (see the project CLAUDE.md).
 */

export const APP_NAME = 'EstimAI'
export const APP_SUITE = 'Operai'
export const APP_DESCRIPTION = 'Software effort estimation with PERT + AI productivity modelling.'
export const APP_TAGLINE = 'AI tools built by craftspeople, for craftspeople.'
export const APP_AUTHOR = 'wellD'
export const APP_AUTHOR_URL = 'https://welld.ch'

/**
 * Injected by Vite `define` at build time. Under vitest there is no define, so
 * `__APP_VERSION__` is an undeclared global at runtime — `typeof` guards against
 * a ReferenceError and we fall back to a placeholder.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
