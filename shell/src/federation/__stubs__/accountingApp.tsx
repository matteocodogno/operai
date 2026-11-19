// Test-only resolution stub for the `accounting/App` federated module (specs/20261119-accounting).
// Same rationale as letterheadsApp.tsx: vitest runs without the @module-federation/vite
// plugin, so the bare specifier is aliased here (vitest.config.ts) purely so Vite's
// import analysis can resolve it before a test's `vi.mock('accounting/App', factory)`
// takes over. Never rendered.
export default function AccountingAppResolutionStub() {
  return null
}
