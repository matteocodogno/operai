/**
 * AuditPage — placeholder for Screen D1 (design.md "Audit log — paginated
 * reverse-chron table + row-expand diff"). T14
 * (specs/004-auth-roles-permissions/tasks.md) ships only the router +
 * section-nav shell these real screens mount into; the paginated table and
 * row-expand diff (no mutate affordance anywhere, AC-5.3) are T21. This
 * placeholder's only job is to prove `/audit` resolves under admin-ui's own
 * inner router — this task's done-when.
 */
export default function AuditPage() {
  return (
    <section aria-labelledby="admin-audit-heading" data-testid="admin-audit-page">
      <h2 id="admin-audit-heading" className="text-lg font-semibold" style={{ fontFamily: 'var(--disp)' }}>
        Audit
      </h2>
      <p className="mt-2 text-sm" style={{ color: 'var(--soft)' }}>
        The audit log ships in a later task of this feature.
      </p>
    </section>
  )
}
