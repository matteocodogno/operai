// Test-only resolution stub for the `hours/RecordHours` federated module (specs/20261116-record-hours-in-place, T3,
// ADR 20261116-record-hours-widget-through-the-host-extension-seam) — the Record hours button `HostExtension` loads on
// a host's behalf. extensions.test.tsx overrides it with vi.doMock. Never rendered.
export default function HoursRecordHoursResolutionStub() {
  return null
}
