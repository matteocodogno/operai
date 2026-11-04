/**
 * The AI request limiter (specs/021-meetings plan.md § Rate limit; AC-13.4, AC-9.8):
 * at most 30 AI requests per user per ROLLING hour, summaries and questions together.
 *
 * `ai_request(userId, kind, at)` is an append-only, content-free row per summary
 * generation, regeneration, retry, question and answer retry. Before inserting, the
 * caller's rows with `at > now - 1 h` are counted under a per-user
 * `pg_advisory_xact_lock`, so two racing requests cannot both take the 30th slot. The
 * 31st is refused with the seconds until the oldest request in the window leaves it.
 * The same transaction deletes THAT user's rows older than the window, so there is no
 * sweep (ADR-0013: nothing is written by a clock, only on the way through).
 *
 * The rows reference no meeting, summary or turn: deleting content, or clearing a
 * conversation, never refunds a request (the point of a cost limit).
 *
 * Two entry points: `consumeAiRequestIn` joins the caller's transaction (a route that
 * also creates the summary row takes the slot and the row together, and a rollback gives
 * the slot back); `consumeAiRequest` is its own transaction.
 */

import type { Prisma, PrismaClient } from "../lib/generated/prisma/client";
import { ProblemError } from "../lib/problem";

export const AI_REQUESTS_PER_HOUR = 30;
const WINDOW_MS = 3_600_000;

export interface RateLimitOptions {
  /** An injectable clock; tests move it. */
  readonly now?: () => Date;
  /** Default 30. */
  readonly limit?: number;
}

export type RateLimitResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Takes one slot for `userId`, inside `tx`. Allowed: the row is inserted. Refused: nothing
 * is inserted (old rows are still pruned).
 *
 * @param kind a short closed label for the cost report (`summary`, `regenerate`, `summary_retry`,
 *             `question`, `question_retry`); never content
 */
export async function consumeAiRequestIn(
  tx: Prisma.TransactionClient,
  userId: string,
  kind: string,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const now = (options.now ?? (() => new Date()))();
  const limit = options.limit ?? AI_REQUESTS_PER_HOUR;
  const windowStart = new Date(now.getTime() - WINDOW_MS);

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai_request:${userId}`}, 0))`;

  // A row exactly an hour old is outside the window (`at > now - 1 h`), so it is pruned too.
  await tx.aiRequest.deleteMany({ where: { userId, at: { lte: windowStart } } });

  const inWindow = await tx.aiRequest.findMany({
    where: { userId, at: { gt: windowStart } },
    orderBy: { at: "asc" },
    select: { at: true },
  });

  if (inWindow.length >= limit) {
    // The request becomes possible when the count drops to limit - 1: the (count - limit)th
    // oldest row must leave. Rounded UP, so following the advice never arrives a moment early.
    const leaving = inWindow[inWindow.length - limit]!.at;
    const retryAfterSeconds = Math.max(1, Math.ceil((leaving.getTime() + WINDOW_MS - now.getTime()) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  await tx.aiRequest.create({ data: { userId, kind, at: now } });
  return { allowed: true };
}

/** `consumeAiRequestIn` in a transaction of its own. */
export function consumeAiRequest(
  db: PrismaClient,
  userId: string,
  kind: string,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  // Callers queued behind one user's lock wait for a connection; the default 2 s / 5 s is tight under a burst.
  return db.$transaction((tx) => consumeAiRequestIn(tx, userId, kind, options), { maxWait: 10_000, timeout: 10_000 });
}

/**
 * The refusal as a response: 429 `ai_rate_limited` with `Retry-After` (a CORS-exposed
 * header) and the same figure in the body as `retryAfterSeconds`, which the UI turns into
 * "try again in n minutes" (AC-9.8). Thrown from a handler; `app.onError` renders it.
 */
export class AiRateLimitedError extends ProblemError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    super({
      status: 429,
      code: "ai_rate_limited",
      detail: `You have reached the limit of ${AI_REQUESTS_PER_HOUR} AI requests per hour. Try again in ${seconds} seconds.`,
      extras: { retryAfterSeconds: seconds },
    });
    this.retryAfterSeconds = seconds;
  }

  override toResponse(instance: string): Response {
    const response = super.toResponse(instance);
    response.headers.set("Retry-After", String(this.retryAfterSeconds));
    return response;
  }
}

/** Takes a slot or throws the 429. For a route that needs no transaction of its own. */
export async function requireAiRequest(db: PrismaClient, userId: string, kind: string, options: RateLimitOptions = {}): Promise<void> {
  const result = await consumeAiRequest(db, userId, kind, options);
  if (!result.allowed) throw new AiRateLimitedError(result.retryAfterSeconds);
}
