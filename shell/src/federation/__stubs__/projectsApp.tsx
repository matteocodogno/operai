// Test-only resolution stub for the `projects/App` federated module (specs/025-projects).
// Same rationale as crmApp.tsx: vitest runs without the @module-federation/vite
// plugin, so the bare specifier is aliased here (vitest.config.ts) purely so Vite's
// import analysis can resolve it before a test's `vi.mock('projects/App', factory)`
// takes over. Never rendered.
export default function ProjectsAppResolutionStub() {
  return null
}
