// Test-only resolution stub for the `meetings/MyMeetings` federated module
// (specs/021-meetings, T49, ADR-0045 shape) — the ungated second entry of the
// meetings remote, mounted at the shell's `/my-meetings/$` route. Router tests
// override it with vi.mock. Never rendered.
export default function MeetingsMyMeetingsResolutionStub() {
  return null
}
