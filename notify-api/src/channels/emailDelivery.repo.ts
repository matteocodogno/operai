/**
 * Prisma data-access layer for EmailDelivery (T2, specs/006-user-invitations).
 *
 * Mirrors notifications.repo.ts's Effect-wrapped-Prisma-call convention. One
 * row is written per send ATTEMPT (never updated in place) — see
 * schema.prisma's EmailDelivery doc comment for the audit-trail rationale.
 */

import { Effect } from "effect";
import { db } from "@/lib/db";
import { DatabaseError } from "@/lib/errors";

export type EmailDeliveryDto = {
  id: string;
  to: string;
  template: string;
  status: string;
  providerId: string | null;
  error: string | null;
  createdAt: string;
};

export type RecordEmailDeliveryInput = {
  to: string;
  template: string;
  status: "sent" | "failed";
  providerId?: string;
  error?: string;
};

export const recordEmailDelivery = (
  input: RecordEmailDeliveryInput,
): Effect.Effect<EmailDeliveryDto, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.emailDelivery.create({
        data: {
          to: input.to,
          template: input.template,
          status: input.status,
          providerId: input.providerId ?? null,
          error: input.error ?? null,
        },
      });

      return {
        id: row.id,
        to: row.to,
        template: row.template,
        status: row.status,
        providerId: row.providerId,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
      };
    },
    catch: (cause) =>
      new DatabaseError({ message: "Failed to record email delivery", cause }),
  });
