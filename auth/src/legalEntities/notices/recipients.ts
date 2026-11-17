/**
 * Who is told about a protected change, as of the moment its version is stored (specs/20261117-legal-entities, T58;
 * US-9 AC-9.8 to AC-9.10; plan amendment 2026-11-17 G3). Computed INSIDE the version's transaction, never at send
 * time: a role removed between the store and the send must not silence anyone (the very attack AC-9.10 guards
 * against).
 *
 *   - managers of the entity: active users holding a `legal-entity:manage` rule through a role or a department's
 *     role (a candidate narrowing, as `authz/holders.routes.ts`), CONFIRMED per candidate by the registry's own
 *     coverage (`resolveEffectivePermissions` + `coveredEntities`): an entity-conditioned grant covers the holder's
 *     own entity only, so a welld_it-only manager gets nothing for welld_ch;
 *   - every effective administrator (`getEffectiveAdminUserIds`: the admin role directly or through a department,
 *     active users only; the same set that receives access-request notices), whether or not they hold the permission;
 *   - the person who saved (AC-9.9, a receipt) when still active;
 *   - de-duplicated by user id: one person, one entry, however many ways they qualify;
 *   - a soft-deleted person is never a recipient, in any role.
 *
 * Whether the outside mailbox applies is not decided here (it is configuration, not a person); `duty.ts` adds it.
 */

import { getEffectiveAdminUserIds } from "../../admin/lastAdminGuard";
import { resolveEffectivePermissions } from "../../authz/resolver";
import type { Prisma } from "../../lib/generated/prisma/client";
import { coveredEntities, LEGAL_ENTITY_MANAGE_ACTION, LEGAL_ENTITY_RESOURCE } from "../coverage";
import type { LegalEntity } from "../entities";
import { Effect } from "effect";

/** The people (user ids, sorted: a stable order for the rows and the tests) that get a notice of one protected change. */
export type RecipientResolver = (
  tx: Prisma.TransactionClient,
  request: { entity: LegalEntity; actorUserId: string },
) => Promise<readonly string[]>;

/** The managers of `entity`, active only, confirmed by the registry's own coverage rule. */
async function managersOf(tx: Prisma.TransactionClient, entity: LegalEntity): Promise<string[]> {
  const rulesForManage = { rules: { some: { resource: LEGAL_ENTITY_RESOURCE, action: LEGAL_ENTITY_MANAGE_ACTION } } };
  const candidates = await tx.user.findMany({
    where: {
      deletedAt: null,
      OR: [
        { userRoles: { some: { role: rulesForManage } } },
        { userDepartments: { some: { department: { departmentRoles: { some: { role: rulesForManage } } } } } },
      ],
    },
    select: { id: true, entity: true },
  });
  const managers: string[] = [];
  // One candidate at a time: a transaction client runs one query at a time anyway.
  for (const candidate of candidates) {
    const permissions = await Effect.runPromise(resolveEffectivePermissions(candidate.id, tx));
    if (coveredEntities(permissions, { entity: candidate.entity }).includes(entity)) managers.push(candidate.id);
  }
  return managers;
}

/** Every active effective administrator (none when the `admin` role does not exist). */
async function administrators(tx: Prisma.TransactionClient): Promise<string[]> {
  const role = await tx.role.findUnique({ where: { name: "admin" }, select: { id: true } });
  return role === null ? [] : [...(await getEffectiveAdminUserIds(tx, role.id))];
}

export const resolveRecipients: RecipientResolver = async (tx, { entity, actorUserId }) => {
  // Sequential: one transaction connection runs one query at a time.
  const managers = await managersOf(tx, entity);
  const admins = await administrators(tx);
  const actor = await tx.user.findFirst({ where: { id: actorUserId, deletedAt: null }, select: { id: true } });
  return [...new Set([...managers, ...admins, ...(actor === null ? [] : [actor.id])])].sort();
};
