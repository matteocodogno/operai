/**
 * The name clash of a team (specs/20261126-teams, plan D14 and "The name clash body"; AC-1.2).
 *
 * Names are unique case-insensitively, archived teams included: the unique index `team_name_lower_key` on
 * `lower("name")` DECIDES a clash. The lookups here only supply the 409's `existingName` (the other team's name as
 * stored) and answer the common case without a failed write. They use a parameterised `lower("name") = lower($1)`,
 * never Prisma's `mode: "insensitive"` (which is `ILIKE`: `_` and `%` would be wildcards, so "Back_nd" would clash
 * with "Backend") and never a second case folding beside the index's.
 */

import { Prisma } from "../lib/generated/prisma/client";
import { db } from "../lib/db";

/** What the lookups need: a client that can run one parameterised raw query (`db` or a transaction). */
export type RawClient = Pick<typeof db, "$queryRaw">;

/** The 409 of a clash: `existingName` is the clashing team's name as stored; `detail` is built from it (for logs). */
export function nameTakenBody(existingName: string, path: string) {
  return {
    type: "https://httpstatuses.com/409",
    title: "Conflict",
    status: 409,
    code: "team_name_taken",
    detail: `A team named "${existingName}" already exists`,
    instance: path,
    existingName,
  } as const;
}

/**
 * The stored name of another team whose name equals `name` ignoring case, or `null`. `selfId` is the team being
 * renamed: it never clashes with itself, so "Backend" -> "BACKEND" is a change, not a clash.
 */
export async function findClashingName(client: RawClient, name: string, selfId?: string): Promise<string | null> {
  const rows =
    selfId === undefined
      ? await client.$queryRaw<{ name: string }[]>`SELECT "name" FROM "team" WHERE lower("name") = lower(${name}) LIMIT 1`
      : await client.$queryRaw<{ name: string }[]>`SELECT "name" FROM "team" WHERE lower("name") = lower(${name}) AND "id" <> ${selfId} LIMIT 1`;
  return rows[0]?.name ?? null;
}

/**
 * After a write lost the race (the unique index refused it and the transaction rolled back), the committed winner is
 * read again, outside that transaction, and its stored name is `existingName`. If the winner was renamed in between,
 * the read finds nothing and the submitted trimmed name stands in: it equalled the stored name ignoring case at the
 * moment of the clash. Nothing is retried.
 */
export async function clashAfterConflict(submitted: string, selfId?: string, client: RawClient = db): Promise<string> {
  return (await findClashingName(client, submitted, selfId)) ?? submitted;
}

/** The unique index's name: the one the database raises for a clashing name (a driver may nest it under `cause`). */
const NAME_INDEX = "team_name_lower_key";

/** True when `error` is the database refusing a clashing name (Prisma's P2002, or the index named in a driver message). */
export function isNameUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return true;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current.message.includes(NAME_INDEX)) return true;
    const meta = (current as { meta?: unknown }).meta;
    if (meta !== undefined && meta !== null && JSON.stringify(meta).includes(NAME_INDEX)) return true;
    current = current.cause;
  }
  return false;
}
