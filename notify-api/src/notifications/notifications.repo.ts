/**
 * Prisma data-access layer for the Notifications API
 * (T4/T5/T6, specs/20260713-notification-center).
 *
 * SECURITY: every function is scoped by `recipientId` derived from the verified
 * JWT `sub`. recipientId is NEVER taken from the request body — only from the
 * context variable set by jwtMiddleware after RS256 signature + audience
 * verification (ADR 20260703-jwt-resource-server-remote-jwks, ADR 20260713-jwt-audience-claim-enforcement).
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
import type { ItVariant, Link, NotificationDto } from "./notifications.schemas";

// ─── Row → DTO mapping ────────────────────────────────────────────────────────

type NotificationRow = {
  id: string;
  title: string;
  body: string;
  titleIt: string | null;
  bodyIt: string | null;
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
    // Both columns or neither: a half-stored pair degrades to English (null)
    // rather than rendering blank (ADR 20261104-bilingual-system-notifications).
    it: row.titleIt !== null && row.bodyIt !== null ? { title: row.titleIt, body: row.bodyIt } : null,
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
  /** Optional Italian variant (specs/20261104-meetings, ADR 20261104-bilingual-system-notifications); stored as titleIt/bodyIt. */
  it?: ItVariant | undefined;
  toastWorthy: boolean;
};

/** The column values a new Notification row is written with. */
export const toCreateData = (input: CreateNotificationInput) => ({
  recipientId: input.recipientId,
  title: input.title,
  body: input.body,
  titleIt: input.it?.title ?? null,
  bodyIt: input.it?.body ?? null,
  severity: input.severity,
  originApp: input.originApp,
  linkHref: input.link?.href ?? null,
  linkLabel: input.link?.label ?? null,
  toastWorthy: input.toastWorthy,
});

export const createNotification = (
  input: CreateNotificationInput,
): Effect.Effect<NotificationDto, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const row = await db.notification.create({
        data: toCreateData(input),
      });
      return toDto(row);
    },
    catch: (cause) => new DatabaseError({ message: "Failed to create notification", cause }),
  });

// ─── create once (POST /system/notifications with an idempotency key) ─────────

/** The repeat-protection pair of one system call: the calling service's JWT `sub` and the key it sent. */
export type IdempotencyScope = { callerSub: string; idempotencyKey: string };

/** True for Prisma's unique-constraint violation (P2002), however the driver wraps it. */
export const isUniqueViolation = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { code?: unknown }).code === "P2002";

export type CreateOnceResult = {
  notification: NotificationDto;
  /** True when this call wrote the row; false when the key had been used (the stored row is returned). */
  created: boolean;
};

/**
 * Creates the notification unless one already exists for (callerSub, idempotencyKey) — AC-9.14's receiver-side
 * repeat protection. The partial unique index is the arbiter: a lookup first (the common repeat), then the insert;
 * when two calls race, the loser's insert violates the index and it reads the winner instead of failing. Rows of
 * other callers never match (the pair is the scope), so a key cannot be used to read another service's row.
 */
export const createNotificationOnce = (
  input: CreateNotificationInput,
  scope: IdempotencyScope,
): Effect.Effect<CreateOnceResult, DatabaseError> =>
  Effect.tryPromise({
    try: async () => {
      const where = { callerSub: scope.callerSub, idempotencyKey: scope.idempotencyKey };
      const existing = await db.notification.findFirst({ where });
      if (existing) return { notification: toDto(existing), created: false };
      try {
        const row = await db.notification.create({ data: { ...toCreateData(input), ...where } });
        return { notification: toDto(row), created: true };
      } catch (cause) {
        if (!isUniqueViolation(cause)) throw cause;
        const winner = await db.notification.findFirst({ where });
        if (!winner) throw cause;
        return { notification: toDto(winner), created: false };
      }
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
