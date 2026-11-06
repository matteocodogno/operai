// Test-only resolution stub for the `meetings/HostMeetings` federated module
// (specs/021-meetings, T51, ADR-0060) — the panel `HostExtension` loads on a
// host's behalf. extensions.test.tsx overrides it with vi.mock. Never rendered.
export default function MeetingsHostMeetingsResolutionStub() {
  return null
}
