// Test-only resolution stub for the `inventory/App` federated module (T41,
// specs/015-hardware-inventory). Same rationale as notifyApp.tsx: vitest runs
// without the @module-federation/vite plugin, so the bare specifier is aliased
// here (vitest.config.ts) purely so Vite's import analysis can resolve it before
// a test's `vi.mock('inventory/App', factory)` takes over. Never rendered.
export default function InventoryAppResolutionStub() {
  return null
}
