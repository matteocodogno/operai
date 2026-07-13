/**
 * inApp channel (T2, specs/006-user-invitations, ADR-0011).
 *
 * TODAY'S notification behaviour (specs/005) refactored behind the Channel
 * interface — UNCHANGED. Addresses a `sub` (recipientId): persists a
 * Notification row via notifications.repo.ts, then publishes it to every
 * open SSE stream for that sub via the EventBus (specs/005 T3).
 *
 * raise.routes.ts (POST /notifications, user-JWT) is the only caller. This
 * refactor moves the persist-then-publish sequence out of the route handler
 * and behind this channel, but the sequence itself, the Effect.runPromiseExit
 * failure handling, and the thrown-Error-on-failure shape (app.onError turns
 * it into a 500) are byte-for-behaviour identical to before — see
 * raise.routes.test.ts, which is unchanged and still exercises this exact
 * path end-to-end.
 */

import { Effect } from "effect";
import { eventBus } from "@/notifications/eventBus";
import {
  createNotification,
  type CreateNotificationInput,
} from "@/notifications/notifications.repo";
import type { NotificationDto } from "@/notifications/notifications.schemas";
import type { Channel } from "./channel";

export type InAppSendInput = CreateNotificationInput;

export const inAppChannel: Channel<InAppSendInput, NotificationDto> = {
  send: async (input) => {
    const exit = await Effect.runPromiseExit(createNotification(input));

    if (exit._tag === "Failure") {
      throw new Error("Unexpected database failure creating notification");
    }

    const created = exit.value;

    // Publish AFTER persistence succeeds — the DB is the source of truth
    // (specs/005 plan.md Risk R3/R5); a dropped publish never loses the
    // notification, only the live push.
    eventBus.publish(input.recipientId, {
      type: "notification",
      data: created,
    });

    return created;
  },
};
