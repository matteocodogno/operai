import UsersSubNav from '../components/UsersSubNav'

/**
 * InvitationsPage — Screen U2 (design.md "Invitations list", route
 * `/users/invitations`, ../router.tsx). Registered here (T10,
 * specs/006-user-invitations) as a thin placeholder so the sibling route
 * exists and is reachable via UsersSubNav's "Invitations" tab; the real
 * list/resend/revoke/invite screen is built out fully in T12 (this same
 * file — InvitationsPage.tsx, InviteUserModal, InvitationStatusBadge).
 */
export default function InvitationsPage() {
  return (
    <section aria-labelledby="admin-invitations-heading" data-testid="admin-invitations-page">
      <UsersSubNav />
      <h2 id="admin-invitations-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Invitations
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        Coming soon.
      </p>
    </section>
  )
}
