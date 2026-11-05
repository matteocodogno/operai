/**
 * Ask the meeting (specs/021-meetings US-9; plan.md § API contracts → Conversation; ADR-0067).
 *
 *   GET    /meetings/:id/conversation                         selfScoped + visibility: the CALLER'S own turns
 *   POST   /meetings/:id/conversation/questions               capability + visibility: synchronous, 201
 *   POST   /meetings/:id/conversation/questions/:tid/retry    the same turn answered again
 *   DELETE /meetings/:id/conversation                         selfScoped: clears the caller's own turns
 *
 * PRIVATE (AC-9.5). Every query is scoped by `userId = sub`; the creator and every other reader get
 * nothing of someone else's conversation, and another user's turn id is a 404. Visibility of the
 * MEETING is still required first (the identical 404), and clearing needs no capability.
 *
 * SYNCHRONOUS. An ask holds the caller's token, so Operai participants' names are resolved LIVE
 * (soft, ADR-0039) instead of from a snapshot. It takes its AI slot and writes the `pending` turn in
 * one transaction (a refusal writes nothing), then calls the model OUTSIDE any transaction with a
 * time limit of its own, and writes `answered` or `failed` under a compare-and-set on `pending`. A
 * `pending` turn older than 2 minutes READS `failed` (a crash mid-call), never swept (ADR-0013/0062).
 *
 * CONTEXT (AC-9.2, AC-9.4). The model sees the WHOLE current transcript of THIS meeting and the
 * caller's last 10 answered turns: no summary, no title, no host data, no other meeting, no one
 * else's turns. Output is forced structure, validated (`validateAnswerOutput`): citations that do not
 * exist are dropped and an answer with no valid citation becomes the fixed "not in the meeting"
 * answer. An invalid reply is sampled once more, then the turn is `failed` with no answer text.
 *
 * RETRY keeps the turn's place in the conversation: it does not become `pending` again (the call is
 * synchronous, so a crash simply leaves it `failed`), and its history is the turns BEFORE it.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AuthzVariables } from "../auth/authz.middleware";
import { MEETINGS_ACCESS, capability, selfScoped } from "../auth/guards";
import { LanguageModelError, languageModel } from "../ai/languageModel";
import { buildAnswerRequest, questionLanguage, validateAnswerOutput, type HistoryTurn, type ValidAnswer } from "../ai/prompts/answer";
import { db } from "../lib/db";
import type { Prisma } from "../lib/generated/prisma/client";
import { commonErrors } from "../lib/http";
import { conflict, notFound, validationHook } from "../lib/problem";
import { AI_TX, readyForAi, takeAiRequest, type AiMeeting } from "../meetings/aiGate";
import { callerOf, type CallerSource } from "../meetings/caller";
import { promptSegmentsOf, speakerNamesFor } from "../meetings/promptSegments";
import { openMeeting } from "../meetings/visibility";

/** The route's own limit on one ask (both samples together); tests shorten it. Kept well under the 2 minutes after which a pending turn reads failed. */
export const askConfig = { timeoutMs: 90_000 };
/** AC-9.6: a `pending` turn older than this reads `failed`. */
export const PENDING_TIMEOUT_MS = 2 * 60_000;
export const MAX_QUESTION = 1_000;
/** Invalid output gets this many samples (the original and one retry), as in the summary job. */
const OUTPUT_TRIES = 2;

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

// ─── Shapes ──────────────────────────────────────────────────────────────────

const TurnSchema = z.object({
  id: z.string(),
  question: z.string(),
  status: z.enum(["pending", "answered", "failed"]),
  answer: z
    .object({
      text: z.string(),
      notInMeeting: z.boolean(),
      citations: z.array(z.object({ segmentId: z.string(), ordinal: z.number().int(), startMs: z.number().int().nullable(), speaker: z.string().nullable() })),
    })
    .nullable(),
  createdAt: z.string(),
});
type Turn = z.infer<typeof TurnSchema>;

const Params = z.object({ id: z.string().min(1).max(64) });
const TurnParams = Params.extend({ tid: z.string().min(1).max(64) });
const AskBody = z.object({
  question: z
    .string()
    .min(1)
    .max(MAX_QUESTION)
    .refine((text) => text.trim() !== "", "must not be blank"),
});

type Row = Awaited<ReturnType<typeof db.conversationTurn.findMany>>[number];

interface StoredAnswer {
  text: string;
  citations: string[];
  notInMeeting: boolean;
}

const storedAnswerOf = (row: Row): StoredAnswer | null => {
  const raw = row.answer;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { text, citations, notInMeeting } = raw as Record<string, unknown>;
  if (typeof text !== "string" || typeof notInMeeting !== "boolean" || !Array.isArray(citations)) return null;
  return { text, citations: citations.filter((c): c is string => typeof c === "string"), notInMeeting };
};

/** The turns as a reader sees them: derived `failed`, citations resolved against the CURRENT transcript. */
async function viewTurns(rows: readonly Row[], meetingId: string, isText: boolean, c: CallerSource): Promise<Turn[]> {
  const now = Date.now();
  const answers = new Map(rows.filter((r) => r.status === "answered").map((r) => [r.id, storedAnswerOf(r)] as const));
  const wanted = [...new Set([...answers.values()].flatMap((a) => a?.citations ?? []))];

  const segments = new Map(
    wanted.length === 0 ? [] : (await db.transcriptSegment.findMany({ where: { meetingId, id: { in: wanted } } })).map((s) => [s.id, s] as const),
  );
  const names = isText || segments.size === 0 ? {} : await speakerNamesFor(db, meetingId, callerOf(c).authorization);

  return rows.map((row): Turn => {
    const status = row.status === "pending" && now - row.createdAt.getTime() >= PENDING_TIMEOUT_MS ? "failed" : row.status;
    const stored = status === "answered" ? answers.get(row.id) : null;
    return {
      id: row.id,
      question: row.question,
      status,
      answer: stored
        ? {
            text: stored.text,
            notInMeeting: stored.notInMeeting,
            citations: stored.citations.flatMap((segmentId) => {
              const segment = segments.get(segmentId);
              if (!segment) return []; // the passage is gone: nothing to point at
              const speaker = isText || segment.speakerKey === null ? null : (names[segment.speakerKey] ?? `Speaker ${segment.speakerKey.replace(/^s/, "")}`);
              return [{ segmentId, ordinal: segment.ordinal, startMs: isText ? null : segment.startMs, speaker }];
            }),
          }
        : null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

// ─── Asking the model ────────────────────────────────────────────────────────

type Outcome = { readonly ok: true; readonly answer: ValidAnswer } | { readonly ok: false; readonly code: string };

class AskTimeout extends Error {}

/** `promise`, or a rejection after `ms`: the route does not depend on the model honouring its abort signal. */
function within<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AskTimeout());
    }, ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

interface AskInput {
  readonly meeting: AiMeeting;
  readonly userId: string;
  readonly authorization: string;
  readonly question: string;
  /** History is the caller's answered turns created before this instant (none = all). */
  readonly before: Date | null;
}

async function askModel(input: AskInput): Promise<Outcome> {
  const isText = input.meeting.source === "text";
  const [rows, names, turns] = await Promise.all([
    db.transcriptSegment.findMany({ where: { meetingId: input.meeting.id }, orderBy: { ordinal: "asc" } }),
    isText ? Promise.resolve({}) : speakerNamesFor(db, input.meeting.id, input.authorization),
    db.conversationTurn.findMany({
      where: { meetingId: input.meeting.id, userId: input.userId, status: "answered", ...(input.before ? { createdAt: { lt: input.before } } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
    }),
  ]);
  if (rows.length === 0) return { ok: false, code: "no_transcript" };

  const segments = promptSegmentsOf(rows, isText, names);
  const history: HistoryTurn[] = turns
    .reverse()
    .flatMap((turn) => {
      const stored = storedAnswerOf(turn);
      return stored ? [{ question: turn.question, answer: stored.text }] : [];
    });
  const language = questionLanguage(input.question, input.meeting.language);
  const { request, schema } = buildAnswerRequest({ question: input.question, history, segments });

  const controller = new AbortController();
  try {
    return await within(
      (async (): Promise<Outcome> => {
        const model = await languageModel();
        for (let sample = 1; sample <= OUTPUT_TRIES; sample++) {
          try {
            const checked = validateAnswerOutput(await model.complete(request, schema, controller.signal), { segments, language });
            if (checked.ok) return { ok: true, answer: checked.value };
          } catch (error) {
            if (error instanceof LanguageModelError && error.code === "invalid_output") continue;
            throw error;
          }
        }
        return { ok: false, code: "invalid_output" };
      })(),
      askConfig.timeoutMs,
      controller,
    );
  } catch (error) {
    if (error instanceof AskTimeout) return { ok: false, code: "timed_out" };
    if (error instanceof LanguageModelError) return { ok: false, code: error.code };
    // Name only: an error message can carry content.
    console.error("[conversation] ask failed:", error instanceof Error ? error.name : "unknown");
    return { ok: false, code: "internal_error" };
  }
}

/** Writes the outcome under a compare-and-set on the status the turn was in, and returns the row as stored. */
async function settle(turnId: string, from: Row["status"], transcriptVersion: number, outcome: Outcome): Promise<Row | null> {
  await db.conversationTurn.updateMany({
    where: { id: turnId, status: from },
    data: outcome.ok
      ? {
          status: "answered",
          answer: { text: outcome.answer.text, citations: [...outcome.answer.citations], notInMeeting: outcome.answer.notInMeeting } satisfies StoredAnswer as unknown as Prisma.InputJsonValue,
          failureCode: null,
          transcriptVersion,
          answeredAt: new Date(),
        }
      : { status: "failed", failureCode: outcome.code, transcriptVersion },
  });
  return db.conversationTurn.findUnique({ where: { id: turnId } });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export const conversationRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

const listRoute = createRoute({
  method: "get",
  path: "/meetings/{id}/conversation",
  tags: ["Conversation"],
  summary: "The caller's own conversation with this meeting, oldest first",
  middleware: selfScoped,
  request: { params: Params },
  responses: { 200: { description: "The caller's turns", ...json(z.object({ turns: z.array(TurnSchema) })) }, 401: commonErrors[401], 404: { description: "Not found" } },
});

const askRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/conversation/questions",
  tags: ["Conversation"],
  summary: "Ask the meeting a question (meetings:access); answered synchronously",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: Params, body: { content: { "application/json": { schema: AskBody } }, required: true } },
  responses: {
    ...commonErrors,
    201: { description: "The turn: answered, or failed with a retry offered", ...json(TurnSchema) },
    404: { description: "Not found" },
    409: { description: "not_ready or no_speech" },
    429: { description: "ai_rate_limited" },
  },
});

const retryRoute = createRoute({
  method: "post",
  path: "/meetings/{id}/conversation/questions/{tid}/retry",
  tags: ["Conversation"],
  summary: "Answer a failed question again",
  middleware: capability(MEETINGS_ACCESS),
  request: { params: TurnParams },
  responses: {
    ...commonErrors,
    200: { description: "The turn", ...json(TurnSchema) },
    404: { description: "Not found" },
    409: { description: "not_ready, no_speech or not_failed" },
    429: { description: "ai_rate_limited" },
  },
});

const clearRoute = createRoute({
  method: "delete",
  path: "/meetings/{id}/conversation",
  tags: ["Conversation"],
  summary: "Clear the caller's own conversation with this meeting",
  middleware: selfScoped,
  request: { params: Params },
  responses: { 204: { description: "Cleared" }, 401: commonErrors[401], 404: { description: "Not found" } },
});

conversationRouter.openapi(listRoute, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);
  await openMeeting(id, caller);
  const [rows, meeting] = await Promise.all([
    db.conversationTurn.findMany({ where: { meetingId: id, userId: caller.userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.meeting.findUnique({ where: { id }, select: { source: true } }),
  ]);
  return c.json({ turns: await viewTurns(rows, id, meeting?.source === "text", c) }, 200);
});

conversationRouter.openapi(askRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { question } = c.req.valid("json");
  const caller = callerOf(c);
  await openMeeting(id, caller);
  await readyForAi(id);

  // The slot and the pending turn are taken together: a refusal (429) or a failure leaves neither.
  const { turn, meeting } = await db.$transaction(async (tx) => {
    const ready = await readyForAi(id, tx);
    await takeAiRequest(tx, caller.userId, "question");
    const created = await tx.conversationTurn.create({
      data: { meetingId: id, userId: caller.userId, question, status: "pending", transcriptVersion: ready.transcriptVersion },
    });
    return { turn: created, meeting: ready };
  }, AI_TX);

  const outcome = await askModel({ meeting, userId: caller.userId, authorization: caller.authorization, question, before: null });
  const settled = await settle(turn.id, "pending", meeting.transcriptVersion, outcome);
  // The caller cleared the conversation while the model was thinking: there is no turn to answer.
  if (!settled) throw notFound("Question not found");
  const [view] = await viewTurns([settled], id, meeting.source === "text", c);
  return c.json(view!, 201);
});

conversationRouter.openapi(retryRoute, async (c) => {
  const { id, tid } = c.req.valid("param");
  const caller = callerOf(c);
  await openMeeting(id, caller);
  // Another user's turn, or another meeting's, does not exist for this caller.
  const row = await db.conversationTurn.findFirst({ where: { id: tid, meetingId: id, userId: caller.userId } });
  if (!row) throw notFound("Question not found");
  const meeting = await readyForAi(id);

  const failed = row.status === "failed" || (row.status === "pending" && Date.now() - row.createdAt.getTime() >= PENDING_TIMEOUT_MS);
  if (!failed) throw conflict("not_failed", "Only a failed question can be retried");

  await db.$transaction(async (tx) => {
    await readyForAi(id, tx);
    await takeAiRequest(tx, caller.userId, "question_retry");
  }, AI_TX);

  const outcome = await askModel({ meeting, userId: caller.userId, authorization: caller.authorization, question: row.question, before: row.createdAt });
  // A concurrent retry may have settled it first: whatever is stored now is the answer.
  const settled = await settle(row.id, row.status, meeting.transcriptVersion, outcome);
  if (!settled) throw notFound("Question not found");
  const [view] = await viewTurns([settled], id, meeting.source === "text", c);
  return c.json(view!, 200);
});

conversationRouter.openapi(clearRoute, async (c) => {
  const { id } = c.req.valid("param");
  const caller = callerOf(c);
  await openMeeting(id, caller);
  // Only the caller's own turns, and never a refund of the AI allowance (the ledger holds no reference).
  await db.conversationTurn.deleteMany({ where: { meetingId: id, userId: caller.userId } });
  return c.body(null, 204);
});
