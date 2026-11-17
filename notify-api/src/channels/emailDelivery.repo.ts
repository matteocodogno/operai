/**
 * Prisma data-access layer for EmailDelivery (T2, specs/20260713-user-invitations).
 *
 * Mirrors notifications.repo.ts's Effect-wrapped-Prisma-call convention. One
 * row is written per send ATTEMPT (never updated in place) — see
 * schema.prisma's EmailDelivery doc comment for the audit-trail rationale.
 */

import { Effect } from "effect";
import { db } from "@/lib/db";
import { DatabaseError } from "@/lib/errors";
import { isUniqueViolation, type IdempotencyScope } from "@/notifications/notifications.repo";

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
  /** The repeat-protection pair of the call that caused this attempt (specs/20261117-legal-entities T56). */
  scope?: IdempotencyScope;
};

const toDto = (row: {
  id: string;
  to: string;
  template: string;
  status: string;
  providerId: string | null;
  error: string | null;
  createdAt: Date;
}): EmailDeliveryDto => ({
  id: row.id,
  to: row.to,
  template: row.template,
  status: row.status,
  providerId: row.providerId,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The `sent` delivery of a (callerSub, idempotencyKey) pair, if there is one — what a repeat answers with
 * (specs/20261117-legal-entities T56, AC-9.14). Only `sent` counts: after `failed` attempts alone the repeat
 * sends again. Scoped to the caller, so another service's key never matches.
 */
export const findSentDelivery = (
  scope: IdempotencyScope,
): Effect.Effect<EmailDeliveryDto | null, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.emailDelivery.findFirst({
        where: { callerSub: scope.callerSub, idempotencyKey: scope.idempotencyKey, status: "sent" },
      });
      return row ? toDto(row) : null;
    },
    catch: (cause) => new DatabaseError({ message: "Failed to look up email delivery", cause }),
  });

/** Thrown inside `recordEmailDelivery` when a keyed `sent` row lost the race: carries the winner. */
export class DeliveryAlreadySent {
  readonly _tag = "DeliveryAlreadySent";
  constructor(readonly delivery: EmailDeliveryDto) {}
}

export const recordEmailDelivery = (
  input: RecordEmailDeliveryInput,
): Effect.Effect<EmailDeliveryDto, DatabaseError | DeliveryAlreadySent> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const row = await db.emailDelivery.create({
          data: {
            to: input.to,
            template: input.template,
            status: input.status,
            providerId: input.providerId ?? null,
            error: input.error ?? null,
            ...(input.scope
              ? { callerSub: input.scope.callerSub, idempotencyKey: input.scope.idempotencyKey }
              : {}),
          },
        });
        return toDto(row);
      } catch (cause) {
        // Two calls with one key both got past the lookup and both sent: the partial unique index on `sent` rows
        // lets one record, the other reads it (Resend, given the same key, answered both with one message).
        if (input.scope && input.status === "sent" && isUniqueViolation(cause)) {
          const winner = await db.emailDelivery.findFirst({
            where: {
              callerSub: input.scope.callerSub,
              idempotencyKey: input.scope.idempotencyKey,
              status: "sent",
            },
          });
          if (winner) throw new DeliveryAlreadySent(toDto(winner));
        }
        throw cause;
      }
    },
    catch: (cause) =>
      cause instanceof DeliveryAlreadySent
        ? cause
        : new DatabaseError({ message: "Failed to record email delivery", cause }),
  });
