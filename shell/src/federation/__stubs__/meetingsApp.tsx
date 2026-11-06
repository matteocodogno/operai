// Test-only resolution stub for the `meetings/App` federated module
// (specs/021-meetings, T49). See inventoryApp.tsx for why a resolvable stub
// exists; router tests override it with vi.mock. Never rendered.
export default function MeetingsAppResolutionStub() {
  return null
}
