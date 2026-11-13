// Test-only resolution stub for the `hours/App` federated module (specs/029-time-tracking).
// Same rationale as projectsApp.tsx: vitest runs without the @module-federation/vite
// plugin, so the bare specifier is aliased here (vitest.config.ts) purely so Vite's
// import analysis can resolve it before a test's `vi.mock('hours/App', factory)`
// takes over. Never rendered.
export default function HoursAppResolutionStub() {
  return null
}
