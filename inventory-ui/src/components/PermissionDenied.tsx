import { useEffect, useRef } from 'react'
import { strings } from '../strings'

/**
 * PermissionDenied — the 403 state (T25, specs/015-hardware-inventory;
 * design.md § Screens & states: "PermissionDenied in place of the content, no
 * Retry (not transient)"). Re-authored from refund-ui's component: same
 * `role="alert"`, heading focused on mount, no controls. It also renders for a
 * deep link to a tab the caller's capabilities hide (T28), where the server
 * would 403 the same way.
 */
export default function PermissionDenied() {
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Focus the heading on mount.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div
      role="alert"
      data-testid="permission-denied"
      className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center"
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        data-testid="permission-denied-heading"
        className="text-lg font-bold focus:outline-none"
        style={{ fontFamily: 'var(--disp)', color: 'var(--text)' }}
      >
        {strings.common.permissionDenied.heading}
      </h2>
      <p className="max-w-md text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
        {strings.common.permissionDenied.body}
      </p>
    </div>
  )
}
