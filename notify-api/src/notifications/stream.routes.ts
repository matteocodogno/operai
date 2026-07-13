/**
 * SSE stream endpoints (T7, specs/005-notification-center, ADR-0008, plan.md
 * §API contracts "SSE stream authentication").
 *
 * POST /notifications/stream-ticket — Bearer/JWKS-authed (jwtMiddleware, same as
 *   every other notify-api route). Mints a short-lived, single-use, sub-bound
 *   ticket via the T3 ticketStore and returns it. This is the ONLY authenticated
 *   step; the browser's EventSource cannot carry the resulting ticket in a header,
 *   only in the next request's query string.
 *
 * GET /notifications/stream?ticket=<t> — deliberately NOT behind jwtMiddleware
 *   (EventSource sends no Authorization header — ADR-0008). Instead it consumes
 *   the ticket via ticketStore.consume(): unknown / expired / already-used are
 *   all indistinguishable to the caller and all produce the same 401 Problem
 *   JSON with the stream never opening (ADR-0008 Decision item 3). A valid
 *   ticket resolves the bound sub and the stream subscribes to that sub's
 *   EventBus events for as long as the connection is open (bounded by
 *   MAX_STREAM_DURATION).
 *
 * CORS: the stream response inherits the app-wide `cors({ origin: env.ALLOWED_ORIGINS })`
 * middleware already mounted on "*" in index.ts — no per-route CORS handling is
 * added here. plan.md's "Access-Control-Allow-Origin: <shell origin>" requirement
 * is satisfied by that global middleware reflecting the shell's origin when it
 * matches ALLOWED_ORIGINS (the same mechanism every other notify-api route uses).
 *
 * SSE framing (plan.md §API contracts):
 *   event: notification / event: unread-reset  — application events, forwarded
 *     verbatim from whatever the EventBus delivers for this sub.
 *   `: heartbeat` comment line every ~15s — keeps the connection alive through
 *     intermediate proxies/load balancers and lets the client detect a dead
 *     stream (no `event:`/`data:` lines, so it is invisible to EventSource's
 *     onmessage/addEventListener consumers).
 *   Connection closes after MAX_STREAM_DURATION seconds, forcing the client to
 *     mint a fresh ticket and reconnect (the closest revocation lever available
 *     to a stateless JWKS verifier — ADR-0008).
 *
 * connectionCount() (T3 EventBus) is incremented/decremented by this route's
 * subscribe()/unsubscribe() calls — GET /health's active-SSE-connection-count
 * fold-in reads the exact same counter, so no separate registry is needed.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { jwtMiddleware, type JwtVariables } from "@/auth/jwt.middleware";
import { env } from "@/lib/env";
import { eventBus } from "./eventBus";
import { ProblemSchema, StreamTicketResponseSchema, problem } from "./notifications.schemas";
import { TICKET_TTL_MS, ticketStore } from "./ticketStore";

/** SSE heartbeat comment cadence — plan.md: "~15s". */
const HEARTBEAT_INTERVAL_MS = 15_000;

export const streamRouter = new OpenAPIHono<{ Variables: JwtVariables }>();

// ─── POST /notifications/stream-ticket — mint (Bearer/JWKS-authed) ──────────
//
// jwtMiddleware is scoped to this EXACT path only — NOT `.use("*", jwtMiddleware)`
// on a sub-router merged in via `.route("/", …)`. A wildcard "*" registered on a
// child OpenAPIHono leaks across the WHOLE merged path space once mounted at
// prefix "/" on the parent (Hono merges the child's route table, middleware
// included, under the given prefix) — that would silently gate the ticket-only
// GET /notifications/stream route behind a Bearer-JWT requirement it must never
// have (ADR-0008: EventSource cannot send an Authorization header at all).

const streamTicketRoute = createRoute({
  method: "post",
  path: "/notifications/stream-ticket",
  tags: ["Notifications"],
  summary: "Mint a short-lived, single-use SSE handshake ticket",
  description:
    "Bearer/JWKS-authed (ADR-0005). Returns an opaque ticket bound to the caller's " +
    "sub, valid once, for ~30 seconds — used to open GET /notifications/stream, " +
    "which EventSource cannot authenticate with a Bearer header (ADR-0008).",
  responses: {
    200: {
      content: { "application/json": { schema: StreamTicketResponseSchema } },
      description: "Ticket minted",
    },
    401: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "Missing or invalid Bearer JWT",
    },
  },
});

streamRouter.use("/notifications/stream-ticket", jwtMiddleware);

streamRouter.openapi(streamTicketRoute, (c) => {
  const sub = c.get("userId");
  const ticket = ticketStore.mint(sub);
  return c.json({ ticket, expiresIn: Math.floor(TICKET_TTL_MS / 1000) }, 200);
});

// ─── GET /notifications/stream?ticket=<t> — the SSE push stream ────────────
//
// Deliberately NOT registered through jwtMiddleware / .openapi() with a JSON
// response schema — this is a raw streamed text/event-stream response, which
// doesn't fit the request/response JSON contract createRoute() models. Kept on
// the same OpenAPIHono instance (plain .get()) so it still mounts under the
// shared router registered in index.ts.

streamRouter.get("/notifications/stream", async (c) => {
  const ticket = c.req.query("ticket");

  if (!ticket) {
    return c.json(
      problem(401, "Unauthorized", "A stream ticket is required", c.req.path),
      401,
    );
  }

  // consume() is atomic get-and-delete (ADR-0008) — unknown, expired, and
  // already-used tickets are indistinguishable here, all → 401, stream never opens.
  const sub = ticketStore.consume(ticket);

  if (!sub) {
    return c.json(
      problem(401, "Unauthorized", "The stream ticket is invalid, expired, or already used", c.req.path),
      401,
    );
  }

  return streamSSE(c, async (stream) => {
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        clearInterval(heartbeatTimer);
        clearTimeout(maxDurationTimer);
        unsubscribe();
      };

      const unsubscribe = eventBus.subscribe(sub, (event) => {
        if (event.type === "notification") {
          void stream.writeSSE({ event: "notification", data: JSON.stringify(event.data) });
        } else {
          void stream.writeSSE({ event: "unread-reset", data: JSON.stringify(event.data) });
        }
      });

      // `: heartbeat` is a raw SSE comment line — writeSSE() always emits a
      // `data:`/`event:` line, so we use the lower-level write() for a line
      // that EventSource's message/addEventListener consumers never see.
      const heartbeatTimer = setInterval(() => {
        void stream.write(": heartbeat\n\n");
      }, HEARTBEAT_INTERVAL_MS);

      // Bound the connection lifetime — forces a re-ticket + reconnect, the
      // closest revocation lever available to a stateless JWKS verifier (ADR-0008).
      const maxDurationTimer = setTimeout(
        () => {
          cleanup();
          resolve();
        },
        env.MAX_STREAM_DURATION * 1000,
      );

      // Client disconnect (tab closed, network drop, explicit EventSource.close()).
      stream.onAbort(() => {
        cleanup();
        resolve();
      });
    });
  });
});
