/**
 * Prisma data-access layer for the Notifications API
 * (T4/T5/T6, specs/005-notification-center).
 *
 * SECURITY: every function is scoped by `recipientId` derived from the verified
 * JWT `sub`. recipientId is NEVER taken from the request body — only from the
 * context variable set by jwtMiddleware after RS256 signature + audience
 * verification (ADR-0005, ADR-0010).
 *
 * Ownership is enforced at the query level, mirroring estimai-api's
 * estimates.repo.ts pattern:
 *  - create:        recipientId is always the caller's sub
 *  - list:           where: { recipientId }, cursor-paginated, createdAt DESC (AC-2.3)
 *  - unreadCount:    where: { recipientId, readAt: null }
 *  - markAllRead:    updateMany({ where: { recipientId, readAt: null } }) — atomic,
 *                     idempotent (0 rows updated when nothing unread, AC-3.4)
 */

import { Effect } from "effect";
import { db } from "@/lib/db";
import { DatabaseError } from "@/lib/errors";
import type { Link, NotificationDto } from "./notifications.schemas";

// ─── Row → DTO mapping ────────────────────────────────────────────────────────

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  severity: string;
  originApp: string;
  linkHref: string | null;
  linkLabel: string | null;
  toastWorthy: boolean;
  readAt: Date | null;
  createdAt: Date;
};

/** Map a Prisma Notification row to the API NotificationDto shape. */
export const toDto = (row: NotificationRow): NotificationDto => {
  const link: Link | undefined =
    row.linkHref !== null
      ? { href: row.linkHref, ...(row.linkLabel !== null ? { label: row.linkLabel } : {}) }
      : undefined;

  return {
    id: row.id,
    title: row.title,
    body: row.body,
    // severity/originApp are validated against their zod enums at the API
    // boundary on the way IN (raise); casting here is safe because nothing
    // outside this codebase can write these columns.
    severity: row.severity as NotificationDto["severity"],
    originApp: row.originApp as NotificationDto["originApp"],
    ...(link !== undefined ? { link } : {}),
    toastWorthy: row.toastWorthy,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
};

// ─── create ───────────────────────────────────────────────────────────────────

export type CreateNotificationInput = {
  recipientId: string;
  title: string;
  body: string;
  severity: string;
  originApp: string;
  link?: Link | undefined;
  toastWorthy: boolean;
};

export const createNotification = (
  input: CreateNotificationInput,
): Effect.Effect<NotificationDto, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.notification.create({
        data: {
          recipientId: input.recipientId,
          title: input.title,
          body: input.body,
          severity: input.severity,
          originApp: input.originApp,
          linkHref: input.link?.href ?? null,
          linkLabel: input.link?.label ?? null,
          toastWorthy: input.toastWorthy,
        },
      });
      return toDto(row);
    },
    catch: (cause) => new DatabaseError({ message: "Failed to create notification", cause }),
  });

// ─── list (cursor pagination, newest-first) ──────────────────────────────────

export type ListResult = {
  items: NotificationDto[];
  nextCursor: string | null;
};

/**
 * List notifications for `recipientId`, newest-first (AC-2.3), cursor-paginated.
 * Returns `[]` (not an error) when the recipient has none (AC-2.4).
 *
 * Cursor scheme: opaque = the `id` of the last item on the previous page.
 * orderBy ties createdAt DESC with id DESC as a deterministic tie-breaker (two
 * notifications created in the same millisecond must still paginate stably).
 * We fetch `limit + 1` rows to detect whether a next page exists without a
 * separate COUNT query.
 */
export const listNotifications = (
  recipientId: string,
  limit: number,
  cursor?: string,
): Effect.Effect<ListResult, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await db.notification.findMany({
        where: { recipientId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

      return {
        items: page.map(toDto),
        nextCursor,
      };
    },
    catch: (cause) => new DatabaseError({ message: "Failed to list notifications", cause }),
  });

// ─── unread count ─────────────────────────────────────────────────────────────

export const countUnread = (recipientId: string): Effect.Effect<number, DatabaseError> =>
  Effect.tryPromise({
    try: () => db.notification.count({ where: { recipientId, readAt: null } }),
    catch: (cause) => new DatabaseError({ message: "Failed to count unread notifications", cause }),
  });

// ─── mark all read ────────────────────────────────────────────────────────────

/**
 * Marks every currently-unread notification for `recipientId` as read.
 * Idempotent: updateMany against `readAt: null` naturally returns `count: 0`
 * when nothing is unread — no separate "already all read" branch needed (AC-3.4).
 */
export const markAllRead = (recipientId: string): Effect.Effect<number, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const { count } = await db.notification.updateMany({
        where: { recipientId, readAt: null },
        data: { readAt: new Date() },
      });
      return count;
    },
    catch: (cause) => new DatabaseError({ message: "Failed to mark notifications as read", cause }),
  });
