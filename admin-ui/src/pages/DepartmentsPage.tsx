/**
 * DepartmentsPage — placeholder for Screen B1 (design.md "Departments list").
 * T14 (specs/004-auth-roles-permissions/tasks.md) ships only the router +
 * section-nav shell these real screens mount into; the create/delete list,
 * "Roles conferred" multi-select, and the Members panel (Screen B2) are T19.
 * This placeholder's only job is to prove `/departments` resolves under
 * admin-ui's own inner router — this task's done-when.
 */
export default function DepartmentsPage() {
  return (
    <section aria-labelledby="admin-departments-heading" data-testid="admin-departments-page">
      <h2 id="admin-departments-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Departments
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        The departments list and detail screen ship in a later task of this feature.
      </p>
    </section>
  )
}
