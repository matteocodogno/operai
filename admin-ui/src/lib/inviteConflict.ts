/**
 * inviteConflictMessageFor — shared 409 message mapping for `POST
 * /admin/invitations` (AC-1.3 "active user exists" / AC-1.4 "live pending
 * invitation exists").
 *
 * Extracted out of InvitationsPage.tsx so every "+ Invite user" entry point
 * — the Invitations tab's own button (T12) and Screen U1's parallel entry
 * point on the Users list (design.md Screen U1 "New key elements", closed as
 * a design-fidelity gap after T12) — share one copy instead of each
 * re-deriving the same fixed-template pattern-match, per "do NOT re-implement
 * invite logic."
 *
 * Distinguishes AC-1.3 (active user) vs AC-1.4 (live pending invite) 409s —
 * the backend contract carries only a `detail` string, no structured
 * discriminant field (design.md Gaps #1), so this pattern-matches the fixed
 * template text `invitations.routes.ts` actually emits.
 */
export const inviteConflictMessageFor = (detail: string | undefined): string => {
  const lower = (detail ?? '').toLowerCase()
  if (lower.includes('active user')) {
    return 'This email already belongs to an existing user — use their user page to change roles or departments instead.'
  }
  if (lower.includes('pending invitation')) {
    return 'An invitation is already pending for this email — resend it from the Invitations tab instead of creating a new one.'
  }
  return detail ?? 'This email cannot be invited right now.'
}
