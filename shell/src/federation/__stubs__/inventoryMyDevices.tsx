// Test-only resolution stub for the `inventory/MyDevices` federated module
// (T41, specs/015-hardware-inventory, ADR-0045) — the ungated second entry of
// the inventory remote, mounted at the shell's `/devices` route. See
// inventoryApp.tsx for why a resolvable stub exists; router tests override it
// with vi.mock. Never rendered.
export default function InventoryMyDevicesResolutionStub() {
  return null
}
