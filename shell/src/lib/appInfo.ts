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
 * The OPERAI UMBRELLA suite version (not `@operai/shell`'s own package
 * version — those are two different numbers; see vite.config.ts's
 * `readSuiteVersion` for why). Injected by Vite `define` at build time from
 * the committed, generated `src/lib/suiteVersion.generated.json` (kept in
 * sync with the root `package.json` by `scripts/version.mjs` at release
 * time — see CLAUDE.md, "Versioning & releases").
 *
 * Under vitest there is no `define`, so `__APP_VERSION__` is an undeclared
 * global at runtime — `typeof` guards against a ReferenceError. The fallback
 * is deliberately `'unknown'`, not a fake-looking SemVer string like
 * `'0.0.0'`: that literal is the exact value this module used to fall back
 * to, and it is also what `@operai/shell`'s own (irrelevant)
 * `package.json` version happened to be — i.e. a plausible-looking real
 * version that silently masked the original bug (the footer rendering the
 * shell's own `0.0.0` instead of the suite's version). `'unknown'` cannot be
 * mistaken for a shipped release under any circumstance.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown'
