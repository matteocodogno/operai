/** Response schema for `GET /assets/{id}/history` (T22, specs/015; plan.md § Assets). */

import { z } from "@hono/zod-openapi";

const IdentitySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["active", "deleted", "unknown", "system"]),
});

const ChangeValueSchema = z.union([z.string(), z.number(), z.boolean(), IdentitySchema, z.null()]);

export const HistoryResponseSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      actor: IdentitySchema,
      at: z.string(),
      changes: z.array(z.object({ field: z.string(), from: ChangeValueSchema, to: ChangeValueSchema })),
    }),
  ),
});
