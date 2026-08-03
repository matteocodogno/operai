// Test-only resolution stub for the `estimai/version` federated module
// (version-bump plan §C). See estimaiApp.tsx in this directory for the full
// rationale — same reasoning applies here: Vite's import-analysis needs a
// real, resolvable module for the `import('estimai/version')` specifier
// AboutModal.test.tsx's `vi.mock('estimai/version', ...)` overrides; this
// stub is what resolution finds before that override takes effect (see
// vitest.config.ts's `resolve.alias`). Its value is never actually asserted
// on — every test that renders AboutModal supplies its own mock.
export const REMOTE_VERSION = '0.0.0-stub'
