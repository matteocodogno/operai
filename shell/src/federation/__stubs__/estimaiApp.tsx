// Test-only resolution stub for the `estimai/App` federated module (T9,
// specs/003-suite-shell).
//
// Vite's import-analysis needs a real, resolvable module for every
// static/dynamic import specifier in a transformed file — even one a test's
// `vi.mock('estimai/App', factory)` fully overrides once resolution has
// found something (vi.mock replaces a module's CONTENT, it can't stand in
// for resolution itself). In production, `estimai/App` resolves via the real
// `@module-federation/vite` runtime (see ../../../vite.config.ts's
// `remotes` + ../remotes.d.ts's ambient type declaration); `vitest.config.ts`
// runs without that plugin (no live remoteEntry.js in a unit-test run), so
// it aliases the bare specifier here instead (see vitest.config.ts's
// `resolve.alias`). Every test file that imports router.tsx (T9) overrides
// this via vi.mock — this default export is never actually rendered.
export default function EstimaiAppResolutionStub() {
  return null
}
