/**
 * capabilityHints — what the shell's permission snapshot lets the UI HIDE (plan G5). The server
 * enforces every action and the meeting's own `can` flags decide every control on a meeting;
 * these three booleans only decide navigation: whether to offer the entry points at all.
 *
 *   - `canUseMeetings`      `apps` includes `meetings` — "New meeting", Templates, "Start meeting"
 *                           and "Link an existing meeting" (the entries need `meetings:access`);
 *   - `canManageTemplates`  the `{template, manage}` pair — the shared scope in the template form;
 *   - `canErase`            the `{meeting, erase}` pair — the Erase tab.
 *
 * The pairs are not app-qualified in the snapshot, so `template` and `meeting` would collide with
 * a future catalog declaring the same resource key; auth has a catalog test that fails on that.
 */
export type PermissionSnapshot = {
  apps: readonly string[]
  permissions: readonly { resource: string; action: string }[]
}

export type CapabilityHints = {
  canUseMeetings: boolean
  canManageTemplates: boolean
  canErase: boolean
}

const holds = (snapshot: PermissionSnapshot, resource: string, action: string): boolean =>
  snapshot.permissions.some((permission) => permission.resource === resource && permission.action === action)

export function capabilityHints(snapshot: PermissionSnapshot): CapabilityHints {
  return {
    canUseMeetings: snapshot.apps.includes('meetings'),
    canManageTemplates: holds(snapshot, 'template', 'manage'),
    canErase: holds(snapshot, 'meeting', 'erase'),
  }
}
