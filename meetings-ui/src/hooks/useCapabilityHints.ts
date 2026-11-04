import { usePermissions } from 'shell/session'
import { capabilityHints } from '../lib/capabilityHints'
import type { CapabilityHints } from '../lib/capabilityHints'

/**
 * useCapabilityHints — the shell's permission snapshot (`usePermissions`, ADR-0007) read as the
 * three navigation hints of plan G5. UI hints only: a control on a meeting follows that meeting's
 * server-computed `can` flags, never this.
 */
export function useCapabilityHints(): CapabilityHints {
  return capabilityHints(usePermissions())
}
