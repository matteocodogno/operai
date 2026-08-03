/**
 * version — this remote's own version, exposed via Module Federation as
 * `./version` (see vite.config.ts's `exposes`).
 *
 * Consumed by the shell's About dialog (shell/src/hooks/useRemoteVersions.ts)
 * to show each mounted remote's own build, alongside the umbrella suite
 * version shell/src/lib/appInfo.ts already shows (version-bump plan §C).
 * `__REMOTE_VERSION__` is injected at build time from this package's own
 * `package.json` (see vite.config.ts) — mirrors shell/src/lib/appInfo.ts's
 * `__APP_VERSION__` pattern exactly, just scoped to this remote's own version
 * instead of the suite's.
 *
 * Under vitest there is no `define`, so `__REMOTE_VERSION__` is an undeclared
 * global at runtime — `typeof` guards against a ReferenceError. The fallback
 * is deliberately `'unknown'`, not a real-looking SemVer string, so it can
 * never be mistaken for a shipped release (mirrors shell/src/lib/appInfo.ts's
 * `APP_VERSION` fallback and its rationale).
 */
export const REMOTE_VERSION: string =
  typeof __REMOTE_VERSION__ !== 'undefined' ? __REMOTE_VERSION__ : 'unknown'
