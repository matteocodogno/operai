/**
 * `/me/*` — the employee's own devices (T16, specs/015-hardware-inventory;
 * AC-2.3, AC-2.4, AC-2.6, AC-2.7, AC-4.1, AC-4.2, AC-4.4; ADR-0045).
 *
 * JWT ONLY. These routes use `identityOnly` (no `authzMiddleware`, no catalog
 * permission): a user with no inventory grant must reach their own devices,
 * and an `auth` outage must not take them away. The substitute for
 * authorization is scoping: every query takes the verified `sub`, and an
 * assignment that is not addressed to it is a 404 indistinguishable from an
 * unknown one. No price, currency, entity or ledger key exists in any shape
 * here (own serializer, me.schemas.ts).
 *
 * Confirm and decline call the same T17 seam as assignment creation
 * (`runAfterCommit`), after the transaction has committed.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { identityOnly } from "../auth/guards";
import type { JwtVariables } from "../auth/jwt.middleware";
import { validationHook } from "../lib/problem";
import { runAfterCommit } from "../assignments/assignments.routes";
import { answerAssignment, myDevices } from "./me.repo";
import { AssignmentIdParamSchema, MyDeviceSchema, MyDevicesResponseSchema } from "./me.schemas";
import { z } from "@hono/zod-openapi";

const devicesRoute = createRoute({
  method: "get",
  path: "/me/devices",
  tags: ["Me"],
  summary: "My devices and the assignments waiting for my answer",
  middleware: identityOnly,
  responses: {
    200: { description: "Held devices and pending offers", content: { "application/json": { schema: MyDevicesResponseSchema } } },
  },
});

const answerRoute = (action: "confirm" | "decline") =>
  createRoute({
    method: "post",
    path: `/me/assignments/{id}/${action}`,
    tags: ["Me"],
    summary: action === "confirm" ? "Confirm that I received the device" : "Decline a device I did not receive",
    middleware: identityOnly,
    request: { params: AssignmentIdParamSchema },
    responses:
      action === "confirm"
        ? {
            200: {
              description: "The device, now mine",
              content: { "application/json": { schema: z.object({ device: MyDeviceSchema }) } },
            },
            404: { description: "Not addressed to the caller, or unknown" },
            409: { description: "assignment_not_pending" },
          }
        : {
            204: { description: "Declined" },
            404: { description: "Not addressed to the caller, or unknown" },
            409: { description: "assignment_not_pending" },
          },
  });

export const meRouter = new OpenAPIHono<{ Variables: JwtVariables }>({ defaultHook: validationHook });

meRouter.openapi(devicesRoute, async (c) => c.json(await myDevices(c.get("userId")), 200));

const callerOf = (c: { get(k: "userId" | "email"): string; get(k: "userName"): string | undefined }) => ({
  userId: c.get("userId"),
  email: c.get("email"),
  userName: c.get("userName"),
});

const answer = async (
  caller: { userId: string; email: string; userName: string | undefined },
  assignmentId: string,
  outcome: "confirmed" | "declined",
) => {
  const sub = caller.userId;
  const done = await answerAssignment({
    assignmentId,
    sub,
    outcome,
    actor: { userId: sub, email: caller.email },
  });
  runAfterCommit({
    kind: outcome === "confirmed" ? "confirmed" : "declined",
    assignmentId,
    assetId: done.assetId,
    assetDescription: done.assetDescription,
    assigneeUserId: sub,
    createdByUserId: done.createdByUserId,
    ...(caller.userName ? { assigneeName: caller.userName } : {}),
  });
  return done;
};

meRouter.openapi(answerRoute("confirm"), async (c) => {
  const { id } = c.req.valid("param");
  const done = await answer(callerOf(c), id, "confirmed");
  return c.json({ device: done.device }, 200);
});

meRouter.openapi(answerRoute("decline"), async (c) => {
  const { id } = c.req.valid("param");
  await answer(callerOf(c), id, "declined");
  return c.body(null, 204);
});
