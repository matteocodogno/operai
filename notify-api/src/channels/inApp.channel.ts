/**
 * inApp channel (T2, specs/20260713-user-invitations, ADR 20260714-notify-api-email-channel-service-trust).
 *
 * TODAY'S notification behaviour (specs/20260713-notification-center) refactored behind the Channel
 * interface — UNCHANGED. Addresses a `sub` (recipientId): persists a
 * Notification row via notifications.repo.ts, then publishes it to every
 * open SSE stream for that sub via the EventBus (specs/20260713-notification-center T3).
 *
 * raise.routes.ts (POST /notifications, user-JWT) is the only caller. This
 * refactor moves the persist-then-publish sequence out of the route handler
 * and behind this channel, but the sequence itself, the Effect.runPromiseExit
 * failure handling, and the thrown-Error-on-failure shape (app.onError turns
 * it into a 500) are byte-for-behaviour identical to before — see
 * raise.routes.test.ts, which is unchanged and still exercises this exact
 * path end-to-end.
 *
 * T6 (specs/20261111-push-notifications) adds one step at the end of `send`: the push
 * dispatch, fire-and-forget (see the comment there).
 */

import { Effect } from "effect";
import { pushChannel } from "@/channels/push.channel";
import { eventBus } from "@/notifications/eventBus";
import {
  createNotification,
  createNotificationOnce,
  type CreateNotificationInput,
  type IdempotencyScope,
} from "@/notifications/notifications.repo";
import type { NotificationDto } from "@/notifications/notifications.schemas";
import type { Channel } from "./channel";

export type InAppSendInput = CreateNotificationInput;

/** What `sendOnce` answers: the notification, and whether it was already there (a repeat — nothing was sent). */
export type InAppSendOnceResult = { notification: NotificationDto; replayed: boolean };

/**
 * The tail of every first delivery, shared by `send` and `sendOnce`: publish to the recipient's open streams, then
 * the best-effort web push.
 */
const deliver = (recipientId: string, created: NotificationDto): void => {
  // Publish AFTER persistence succeeds — the DB is the source of truth
  // (specs/20260713-notification-center plan.md Risk R3/R5); a dropped publish never loses the
  // notification, only the live push.
  eventBus.publish(recipientId, {
    type: "notification",
    data: created,
  });

  // Web push (specs/20261111-push-notifications, ADR 20261111-web-push-encrypted-payloads-not-fcm): a best-effort third delivery AFTER the row is stored
  // and published. Deliberately not awaited, so a slow push service never delays the
  // response, and shielded so that nothing it does can fail the request (AC-2.6).
  // `pushChannel.dispatch` is looked up per call, so tests can replace it.
  try {
    void pushChannel.dispatch(recipientId, created).catch(() => {});
  } catch {
    // a synchronous failure of the push channel is as irrelevant as an async one
  }
};

export const inAppChannel: Channel<InAppSendInput, NotificationDto> & {
  /**
   * `send` with receiver-side repeat protection (specs/20261117-legal-entities T56, AC-9.14): the first call for a
   * (callerSub, idempotencyKey) pair stores, publishes and pushes; every later one — including the loser of a
   * concurrent race — answers with the stored row and does none of those.
   */
  sendOnce(input: InAppSendInput, scope: IdempotencyScope): Promise<InAppSendOnceResult>;
} = {
  send: async (input) => {
    const exit = await Effect.runPromiseExit(createNotification(input));

    if (exit._tag === "Failure") {
      throw new Error("Unexpected database failure creating notification");
    }

    const created = exit.value;
    deliver(input.recipientId, created);
    return created;
  },

  sendOnce: async (input, scope) => {
    const exit = await Effect.runPromiseExit(createNotificationOnce(input, scope));

    if (exit._tag === "Failure") {
      throw new Error("Unexpected database failure creating notification");
    }

    const { notification, created } = exit.value;
    if (created) deliver(input.recipientId, notification);
    return { notification, replayed: !created };
  },
};
