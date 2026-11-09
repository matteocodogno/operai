/**
 * A contract's Bexio order id (specs/024 T9; AC-3.1, AC-3.2, AC-3.3, AC-1.7, AC-4.5).
 *
 * `PUT /projects/:id/contracts/:contractId/bexio-order` is the ONLY way to write it: it needs the
 * `contract:bexio` capability (the `accounting` role, D35) — not `project:manage`, and not scoped
 * to an entity, so accounting writes it on a contract of either one. The id is typed in, free text
 * of at most 64 characters, trimmed (empty clears it); it is not checked against Bexio nor for
 * uniqueness (A24). Nothing else in the module reads it to decide anything: a project is created,
 * started and closed with or without it (AC-3.3), so no other route looks at it.
 *
 * It is a write on the contract like any other: `If-Match` required, and it bumps the contract's
 * `version` (ADR-0038).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CONTRACT_BEXIO, authorized, requireCapability } from "../auth/guards";
import type { AuthzVariables } from "../auth/authz.middleware";
import { assertVersion, commonErrors, etag, requireIfMatch } from "../lib/http";
import { notFound, validationHook } from "../lib/problem";
import { findContractRow, toContractView, updateContractIfVersion } from "./contracts.routes";
import { ContractParams, ContractSchema } from "./contracts.schemas";

export const MAX_BEXIO_ORDER_ID = 64;

/** Trimmed, at most 64 characters once trimmed; empty or blank means "none". The member itself is required. */
const BexioOrderSchema = z
  .object({
    bexioOrderId: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(MAX_BEXIO_ORDER_ID))
      .transform((value) => (value === "" ? null : value))
      .nullable(),
  })
  .strict();

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

const setBexioOrderRoute = createRoute({
  method: "put",
  path: "/projects/{id}/contracts/{contractId}/bexio-order",
  tags: ["Contracts"],
  summary: "Set, change or clear a contract's Bexio order id (contract:bexio, If-Match required)",
  middleware: [...authorized, requireCapability(CONTRACT_BEXIO)],
  request: {
    params: ContractParams,
    body: { content: { "application/json": { schema: BexioOrderSchema } }, required: true },
  },
  responses: {
    200: { description: "The contract with its new Bexio order id", ...json(ContractSchema) },
    404: { description: "Not found" },
    409: { description: "version_conflict" },
    428: { description: "precondition_required" },
    ...commonErrors,
  },
});

export const bexioRouter = new OpenAPIHono<{ Variables: AuthzVariables }>({ defaultHook: validationHook });

bexioRouter.openapi(setBexioOrderRoute, async (c) => {
  const { id, contractId } = c.req.valid("param");
  const { bexioOrderId } = c.req.valid("json");
  const expected = requireIfMatch(c);
  const current = await findContractRow(id, contractId);
  if (!current) throw notFound("Contract not found");
  assertVersion(current.version, expected);
  const row = await updateContractIfVersion(contractId, expected, { bexioOrderId });
  c.header("ETag", etag(row.version));
  return c.json(await toContractView(row), 200);
});
