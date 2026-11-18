/**
 * The notice dispatcher (specs/20261117-legal-entities, T59; US-9 AC-9.7, AC-9.9 to AC-9.15; plan amendment 2026-11-17
 * G1, G5, G6). It sends what `duty.ts` (T58) wrote down: one `legal_entity_notice` row per recipient and channel,
 * stored in the version's transaction. Nothing is sent from a request.
 *
 *   - `kick()` runs right after a save or restore commits (`write.routes.ts`: `void`, never awaited, so the answer is
 *     the same whatever notify-api does: AC-9.14);
 *   - `start()` also sweeps on start and then every 15 s, on every replica: a lost kick, a restart and a crash all
 *     end in the next sweep (AC-9.7's 60 s, AC-9.14's durability);
 *   - a sweep CLAIMS due rows with `FOR UPDATE SKIP LOCKED` in the one statement that sets their lease (60 s) and
 *     counts the attempt, so two replicas (or a kick and a sweep) never send the same row;
 *   - each claimed row is sent on its own (4 at a time, 5 s per call): one recipient's or one channel's failure never
 *     stops or delays another's call. The content is rebuilt from versions n and n - 1 (`content.ts`) and the row's own
 *     `authorEmail` (claimed with it, D9; written once at capture, cleared once at the terminal status, never otherwise
 *     updated, never logged), so a retry sends the same words;
 *   - a failure is retried at +1, +3, +5, +10 and +20 minutes, then every 30, never later than 24 h after the version
 *     was stored (`createdAt`), when the row is given up;
 *   - the outcome and its audit entry are one transaction: `notice_failed` (the FIRST failure of a row only),
 *     `notice_delivered` (success of a row that had failed), `notice_given_up`. Audit entries and log lines carry ids,
 *     the entity, the version, the channel and a closed reason: never a name, an address or a value.
 *
 * The outside mailbox's address is read from the environment HERE, when the row is sent, and never stored; unset by
 * then, the row is given up as `outside_address_unset`. A person deleted after the version was stored is never sent
 * to (`recipient_deleted`: the spirit of AC-9.8).
 *
 * Idempotency: every call carries `legal-entity-notice:<row id>` (no value in it); notify-api scopes it to this
 * service and answers a repeat with the first result, so a timeout after notify-api stored is safe to retry.
 *
 * `createNoticeDispatcher` takes its clock, database, notify client and outside address as options, so a test drives
 * it with an injected clock and a fake notify-api. `startNoticeDispatcher` (the server's `src/index.ts`, never under
 * `bun test`) makes the process-wide one that `kickNotices` reaches; until it is started `kickNotices` does nothing.
 */

import { type AuditEntryInput, withAudit } from "../../authz/audit";
import { env } from "../../lib/env";
import { db } from "../../lib/db";
import type { Prisma } from "../../lib/generated/prisma/client";
import {
  type LegalEntityEmailInput,
  type LegalEntityNotificationInput,
  type NoticeFailureReason,
  type NoticeSendOptions,
  type NoticeSendResult,
  sendLegalEntityEmail,
  sendLegalEntityNotification,
} from "../../lib/notify";
import type { LegalEntity } from "../entities";
import { versionOf } from "../repo";
import { emailData, inAppNotice, isUnusableAuthorEmail, noticeFacts } from "./content";

/** The retries: +1, +3, +5, +10, +20 minutes after the 1st to 5th failure, then every 30 (plan G6). */
export const RETRY_DELAYS_MINUTES: readonly number[] = [1, 3, 5, 10, 20];
export const RETRY_REPEAT_MINUTES = 30;
/** A row is given up this long after its version was stored (AC-9.14). */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 15_000;
export const LEASE_MS = 60_000;
export const CLAIM_BATCH = 25;
export const SEND_CONCURRENCY = 4;
export const SEND_TIMEOUT_MS = 5_000;
/** A row still pending this long after it was stored is reported by the sweep (`legal_entity_notice_overdue`). */
export const OVERDUE_AFTER_MS = 5 * 60_000;

/** The closed set of `lastReason` (plan G4): what notify can say plus the dispatcher's own. */
export type NoticeReason = NoticeFailureReason | "outside_address_unset" | "recipient_deleted" | "expired";

/** The notify-api calls the dispatcher makes; the real ones are `lib/notify.ts`'s, a test injects its own. */
export interface NoticeNotifier {
  notification(input: LegalEntityNotificationInput, options: NoticeSendOptions): Promise<NoticeSendResult>;
  email(input: LegalEntityEmailInput, options: NoticeSendOptions): Promise<NoticeSendResult>;
}

const realNotifier: NoticeNotifier = { notification: sendLegalEntityNotification, email: sendLegalEntityEmail };

export type NoticeLog = (event: string, fields: Readonly<Record<string, string | number>>) => void;

const consoleLog: NoticeLog = (event, fields) => {
  const text = `[legal-entities] ${event} ${Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}`.trimEnd();
  if (event === "legal_entity_notice_delivered" || event === "legal_entity_notice_dispatcher_started") console.log(text);
  else console.warn(text);
};

export interface NoticeDispatcherOptions {
  /** The clock: claims, leases, the 24 h and the retry times all read it. Default: the system clock. */
  now?: () => Date;
  notifier?: NoticeNotifier;
  /** The outside mailbox, read when a row is SENT. Default: `LEGAL_ENTITY_NOTICE_EMAIL`. */
  outsideAddress?: () => string | undefined;
  /** A `fetch` for the notify calls (a test's fake notify-api). */
  fetch?: typeof fetch;
  log?: NoticeLog;
  sweepIntervalMs?: number;
  sendTimeoutMs?: number;
  /** Rows claimed per statement; a sweep claims again while a batch comes back full. */
  batchSize?: number;
}

export interface NoticeDispatcher {
  /** Sends what is due now; never rejects. Resolves when this process has no more due work. */
  kick(): Promise<void>;
  /** A kick that also reports the rows overdue (the timer's). */
  sweep(): Promise<void>;
  /** Sweeps now and every `sweepIntervalMs` (the timer is `unref`ed). Idempotent. */
  start(): void;
  stop(): void;
  readonly running: boolean;
}

/** One claimed row: the columns the sending needs, `attempts` already counting this one. */
interface ClaimedRow {
  id: string;
  entity: LegalEntity;
  version: number;
  recipient: string;
  recipientKind: "person" | "outside";
  channel: "in_app" | "email";
  attempts: number;
  lastReason: NoticeReason | null;
  firstFailedAt: Date | null;
  createdAt: Date;
  /** The author's account email captured with the version (D9, J2): content of the notice only, never logged or audited. */
  authorEmail: string | null;
}

/** The delay after the `attempts`-th failed attempt (1-based). */
export function retryDelayMs(attempts: number): number {
  const minutes = RETRY_DELAYS_MINUTES[attempts - 1] ?? RETRY_REPEAT_MINUTES;
  return minutes * 60_000;
}

export function createNoticeDispatcher(options: NoticeDispatcherOptions = {}): NoticeDispatcher {
  const now = options.now ?? (() => new Date());
  const database = db;
  const notifier = options.notifier ?? realNotifier;
  const outsideAddress = options.outsideAddress ?? (() => env.LEGAL_ENTITY_NOTICE_EMAIL);
  const log = options.log ?? consoleLog;
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const batchSize = options.batchSize ?? CLAIM_BATCH;
  const sendOptions: NoticeSendOptions = {
    timeoutMs: options.sendTimeoutMs ?? SEND_TIMEOUT_MS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  /**
   * Takes the due rows: pending, due, and not leased by anyone else (a lease that ran out is free again: its owner
   * crashed or was too slow). ONE statement, so the lock and the lease are never apart; `SKIP LOCKED` makes
   * concurrent claimers (replicas, a kick and a sweep) take disjoint rows. The times are the injected clock's.
   */
  async function claim(): Promise<ClaimedRow[]> {
    const at = now();
    const leaseUntil = new Date(at.getTime() + LEASE_MS);
    return database.$queryRaw<ClaimedRow[]>`
      UPDATE "legal_entity_notice" AS n
      SET "leaseUntil" = ${leaseUntil}::timestamp(3), "attempts" = n."attempts" + 1
      WHERE n."id" IN (
        SELECT c."id" FROM "legal_entity_notice" AS c
        WHERE c."status" = 'pending'
          AND c."nextAttemptAt" <= ${at}::timestamp(3)
          AND (c."leaseUntil" IS NULL OR c."leaseUntil" < ${at}::timestamp(3))
        ORDER BY c."nextAttemptAt", c."createdAt", c."id"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING n."id", n."entity", n."version", n."recipient", n."recipientKind", n."channel", n."attempts",
        n."lastReason", n."firstFailedAt", n."createdAt", n."authorEmail"`;
  }

  /** What an outcome records about a row, never a value (plan G4). */
  const auditData = (row: ClaimedRow, at: Date, reason?: NoticeReason): Prisma.InputJsonObject => ({
    version: row.version,
    recipient: row.recipientKind,
    ...(row.recipientKind === "person" ? { userId: row.recipient } : {}),
    channel: row.channel,
    ...(reason !== undefined ? { reason } : {}),
    at: at.toISOString(),
  });

  const auditEntry = (
    row: ClaimedRow,
    action: "notice_failed" | "notice_delivered" | "notice_given_up",
    at: Date,
    reason?: NoticeReason,
  ): AuditEntryInput => ({
    actorUserId: null,
    action: `legal_entity.${action}`,
    targetType: "legal_entity",
    targetId: row.entity,
    summary:
      `Notice of version ${row.version} of ${row.entity} (${row.channel}, ${row.recipientKind}) ` +
      (action === "notice_failed" ? "failed" : action === "notice_delivered" ? "delivered after an earlier failure" : "given up") +
      (reason !== undefined ? `: ${reason}` : ""),
    data: auditData(row, at, reason),
  });

  /** The row is guarded by its status and attempt count: a slower process whose lease ran out cannot overwrite a newer outcome. */
  const sameClaim = (row: ClaimedRow): Prisma.LegalEntityNoticeWhereInput => ({
    id: row.id,
    status: "pending",
    attempts: row.attempts,
  });

  async function deliver(row: ClaimedRow): Promise<void> {
    const at = now();
    const wasFailing = row.firstFailedAt !== null;
    const updated = await withAudit<boolean>({
      affectedUserIds: [],
      mutate: async (tx) => {
        const result = await tx.legalEntityNotice.updateMany({
          where: sameClaim(row),
          // authorEmail: cleared in the same update as the terminal status (D9-1); every send before it read the captured value.
          data: { status: "delivered", deliveredAt: at, leaseUntil: null, authorEmail: null },
        });
        return result.count === 1;
      },
      entry: (applied) => (applied && wasFailing ? auditEntry(row, "notice_delivered", at) : []),
    });
    if (updated) {
      log("legal_entity_notice_delivered", { id: row.id, entity: row.entity, version: row.version, channel: row.channel, attempts: row.attempts });
    }
  }

  /** A failed attempt (or a row that cannot be sent at all): retried, or given up at once or at 24 h. */
  async function fail(row: ClaimedRow, reason: NoticeReason, { giveUpNow }: { giveUpNow: boolean }): Promise<void> {
    const at = now();
    const deadline = new Date(row.createdAt.getTime() + GIVE_UP_AFTER_MS);
    const givingUp = giveUpNow || at.getTime() >= deadline.getTime();
    const first = row.firstFailedAt === null;
    const nextAttemptAt = new Date(Math.min(at.getTime() + retryDelayMs(row.attempts), deadline.getTime()));
    const applied = await withAudit<boolean>({
      affectedUserIds: [],
      mutate: async (tx) => {
        const result = await tx.legalEntityNotice.updateMany({
          where: sameClaim(row),
          data: {
            lastReason: reason,
            leaseUntil: null,
            ...(first ? { firstFailedAt: at } : {}),
            ...(givingUp ? { status: "given_up", givenUpAt: at, authorEmail: null } : { nextAttemptAt }),
          },
        });
        return result.count === 1;
      },
      entry: (done) =>
        !done
          ? []
          : [
              ...(first ? [auditEntry(row, "notice_failed", at, reason)] : []),
              ...(givingUp ? [auditEntry(row, "notice_given_up", at, reason)] : []),
            ],
    });
    if (!applied) return;
    const fields = { id: row.id, entity: row.entity, version: row.version, channel: row.channel, reason, attempts: row.attempts };
    if (first) log("legal_entity_notice_failed", fields);
    if (givingUp) log("legal_entity_notice_given_up", fields);
  }

  /**
   * Builds and sends one row; returns the reason it could not be delivered, or null when it was. `address` is the
   * outside mailbox as read for this send (the outside row only).
   */
  async function send(row: ClaimedRow, address: string | undefined): Promise<NoticeReason | null> {
    const current = await versionOf(row.entity, row.version, database);
    const previous = row.version > 1 ? await versionOf(row.entity, row.version - 1, database) : null;
    if (current === null) return "notify_error"; // unreachable: the notice names its version by a foreign key
    // An address that is present but unusable is "no email address on record" (R-D9a, J11): the row is sent, never
    // looped on a 400. The line names the row only, never the value.
    if (isUnusableAuthorEmail(row.authorEmail)) {
      log("legal_entity_notice_author_email_unusable", { id: row.id, entity: row.entity, version: row.version, channel: row.channel });
    }
    const facts = noticeFacts(current, previous, row.authorEmail);
    const key = `legal-entity-notice:${row.id}`;
    let result: NoticeSendResult;
    if (row.channel === "in_app") {
      const notice = inAppNotice(facts);
      result = await notifier.notification(
        {
          recipientId: row.recipient,
          originApp: "admin",
          severity: "warning",
          title: notice.title,
          body: notice.body,
          it: notice.it,
          link: notice.link,
          idempotencyKey: key,
        },
        sendOptions,
      );
    } else {
      result = await notifier.email(
        {
          template: "legal_entity_change",
          ...(row.recipientKind === "outside" ? { to: address as string } : { recipientId: row.recipient }),
          data: emailData(facts),
          idempotencyKey: key,
        },
        sendOptions,
      );
    }
    return result.status === "sent" ? null : result.reason;
  }

  async function handle(row: ClaimedRow): Promise<void> {
    try {
      const at = now();
      // 24 h after the version was stored the notice is no longer sent: whatever the row last said, or `expired`
      // when no attempt ever ran (the dispatcher was down).
      if (at.getTime() >= row.createdAt.getTime() + GIVE_UP_AFTER_MS) {
        return await fail(row, row.lastReason ?? "expired", { giveUpNow: true });
      }
      let address: string | undefined;
      if (row.recipientKind === "person") {
        const person = await database.user.findFirst({ where: { id: row.recipient }, select: { deletedAt: true } });
        if (person === null || person.deletedAt !== null) return await fail(row, "recipient_deleted", { giveUpNow: true });
      } else {
        // The address is not stored: if the variable was unset since the version was stored there is nowhere to send.
        address = outsideAddress();
        if (address === undefined) return await fail(row, "outside_address_unset", { giveUpNow: true });
      }
      const reason = await send(row, address);
      if (reason === null) await deliver(row);
      else await fail(row, reason, { giveUpNow: false });
    } catch (error) {
      // Our own fault (a database error, a stored version that cannot be noticed): the lease runs out and the next
      // sweep tries again, and the 24 h still ends it. Only the class is logged: a message can carry a row.
      log("legal_entity_notice_error", {
        id: row.id,
        entity: row.entity,
        version: row.version,
        channel: row.channel,
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  /** Sends `rows` at most `SEND_CONCURRENCY` at a time; one row's outcome never waits for another's. */
  async function processAll(rows: readonly ClaimedRow[]): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++] as ClaimedRow;
        await handle(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, rows.length) }, worker));
  }

  async function overdue(): Promise<void> {
    const count = await database.legalEntityNotice.count({
      where: { status: "pending", createdAt: { lt: new Date(now().getTime() - OVERDUE_AFTER_MS) } },
    });
    if (count > 0) log("legal_entity_notice_overdue", { count });
  }

  let inFlight: Promise<void> | null = null;
  let again = false;
  let wantsOverdue = false;

  /** One run at a time per process: a kick during a run asks it to look again before it ends. */
  function run(reportOverdue: boolean): Promise<void> {
    wantsOverdue ||= reportOverdue;
    if (inFlight !== null) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        do {
          again = false;
          let claimed: ClaimedRow[];
          do {
            claimed = await claim();
            await processAll(claimed);
          } while (claimed.length >= batchSize);
        } while (again);
        if (wantsOverdue) await overdue();
      } catch (error) {
        log("legal_entity_notice_sweep_error", { error: error instanceof Error ? error.name : "UnknownError" });
      } finally {
        wantsOverdue = false;
        inFlight = null;
      }
    })();
    return inFlight;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    kick: () => run(false),
    sweep: () => run(true),
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void run(true), sweepIntervalMs);
      timer.unref();
      void run(true);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    get running() {
      return timer !== undefined;
    },
  };
}

// ─── The process-wide dispatcher ────────────────────────────────────────────────────────────────────────────────────────

let processWide: NoticeDispatcher | undefined;

/** Called once by `src/index.ts` when the server starts (never under `bun test`). */
export function startNoticeDispatcher(): NoticeDispatcher {
  if (processWide === undefined) {
    processWide = createNoticeDispatcher();
    processWide.start();
    console.log(`[legal-entities] notice dispatcher started (sweep every ${SWEEP_INTERVAL_MS / 1000} s)`);
  }
  return processWide;
}

/** Whether `startNoticeDispatcher` ran in this process. */
export const noticeDispatcherStarted = (): boolean => processWide?.running === true;

/**
 * What the save and restore routes call after their transaction commits. Does nothing until the dispatcher was started
 * (so a test of the routes sends nothing); never throws and never rejects.
 */
export function kickNotices(): Promise<void> {
  try {
    return processWide?.kick() ?? Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}
