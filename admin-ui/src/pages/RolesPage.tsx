/**
 * RolesPage — placeholder for Screen A1 (design.md "Roles list — Roles list
 * table (Screen A1)"). T14 (specs/004-auth-roles-permissions/tasks.md) ships
 * only the router + section-nav shell these real screens mount into; the
 * table (Name/Description/System badge/rule count/Edit/Delete), the
 * "+ New role" action, and Screen A2's rule composer are T17/T18. This
 * placeholder's only job is to prove `/roles` resolves under admin-ui's own
 * inner router — this task's done-when.
 */
export default function RolesPage() {
  return (
    <section aria-labelledby="admin-roles-heading" data-testid="admin-roles-page">
      <h2 id="admin-roles-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Roles
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        The roles list and rule composer ship in a later task of this feature.
      </p>
    </section>
  )
}
