/**
 * Product/application metadata shown in the shell's About dialog.
 *
 * Relocated from estimai-ui/src/lib/appInfo.ts (T6, specs/003-suite-shell, AC-1.4) with
 * suite-level content: the shell's About dialog describes **Operai** — the suite itself,
 * not a single tool — so name/description/version below are the suite's, not EstimAI's.
 * Centralised here so no UI copy is hardcoded in components (see project CLAUDE.md).
 */

export const APP_NAME = 'Operai'
export const APP_DESCRIPTION =
  'AI-assisted software consulting toolsuite — estimation, review, retrospectives, and proposals, all in one place.'
export const APP_TAGLINE = 'AI tools built by craftspeople, for craftspeople.'
export const APP_AUTHOR = 'wellD'
export const APP_AUTHOR_URL = 'https://welld.ch'

/**
 * Legal-information link shown in the shell footer (T8, specs/003-suite-shell,
 * AC-1.5). No dedicated Operai legal/privacy page exists yet, so this points at
 * wellD's own site as the placeholder source of truth — update once the suite has
 * its own legal/privacy page.
 */
export const LEGAL_URL = 'https://welld.ch/legal'

/**
 * Injected by Vite `define` at build time (see vite.config.ts, mirroring
 * estimai-ui/vite.config.ts). Under vitest there is no define, so `__APP_VERSION__` is an
 * undeclared global at runtime — `typeof` guards against a ReferenceError and we fall back
 * to a placeholder.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
