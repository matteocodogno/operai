/**
 * UsersPage — placeholder for Screen C1 (design.md "Users list — search+pagination").
 * T14 (specs/004-auth-roles-permissions/tasks.md) ships only the router +
 * section-nav shell these real screens mount into; the search+paginated
 * table and Screen C2 (user detail: entity/jobTitle, roles, departments,
 * the last-admin guardrail) are T20. This placeholder's only job is to
 * prove `/users` resolves under admin-ui's own inner router — this task's
 * done-when.
 */
export default function UsersPage() {
  return (
    <section aria-labelledby="admin-users-heading" data-testid="admin-users-page">
      <h2 id="admin-users-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Users
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        The users list and detail screen ship in a later task of this feature.
      </p>
    </section>
  )
}
