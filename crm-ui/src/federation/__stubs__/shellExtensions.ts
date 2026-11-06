import { createElement } from 'react'
import type { ReactNode } from 'react'

// Test-only resolution stub for the `shell/extensions` federated module
// (specs/021-meetings, ADR-0060). vitest.config.ts aliases the specifier here so
// Vite's import analysis can resolve it; a test that depends on the extension
// overrides it with vi.mock. The stub behaves like a shell with no remote behind
// it: it renders the host's fallback.
export const HostExtension = ({
  fallback,
}: {
  name: string
  props: unknown
  fallback: ReactNode
  loading?: ReactNode
}) => createElement('div', { 'data-testid': 'stub-host-extension' }, fallback)
