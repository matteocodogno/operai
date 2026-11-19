/**
 * GET /system/v1/entities/{entity}/reference-data (T13, specs/20261119-accounting, plan § API contracts "system routes"; AC-3.8,
 * AC-1.4, AC-1.8, AC-1.9, AC-1.10, AC-4.1): an entity's ledger accounts and VAT codes, active and deactivated, for a suite
 * service (Refund) that reads them live and keeps no copy across requests (D2, ADR 20261119-accounting-reference-data-...).
 *
 * The reader's projection (D18): the same entries as `GET /v1/entities/{e}/ledger-accounts` and `…/vat-codes`, with no id, no
 * who-added, no history, and the VAT rate in basis points only (`ratePercent` is a display form the consumer does not need).
 * The two lists are read in ONE repeatable-read transaction, so a deactivation cannot show up in one list and not in the
 * other, and the answer is validated with `accountingWire` (strict, both ways) BEFORE it is sent: a route that drifts from
 * the contract fails its own test, and a body that does not parse is a 500 here, never a malformed answer on the wire.
 *
 * GET only, behind `systemReader` and nothing else (no user JWT, no entity coverage: the caller is a service). An entity that
 * does not exist is 404 `not_found`. Every answer carries `Cache-Control: no-store`.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { SystemAuthVariables } from "../auth/systemAuth.middleware";
import { listLedgerAccounts, listVatCodes } from "../catalog/catalog.repo";
import { entityNotFound } from "../authz/coverage";
import { isEntity, OWN_CURRENCY } from "../entities";
import { db } from "../lib/db";
import { referenceDataWire } from "./accountingWire";
import { noStore, systemReader } from "./readers";

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  instance: z.string(),
  code: z.string().optional(),
});

const route = createRoute({
  method: "get",
  path: "/system/v1/entities/{entity}/reference-data",
  tags: ["System"],
  summary: "An entity's ledger accounts and VAT codes, as the reader sees them",
  description:
    "Service credential only: scope `accounting.reference.read`, `sub` `system:refund-api`. Every failure of the credential " +
    "is one identical 401. Active and deactivated entries, each with `active`; the VAT rate in basis points. Never cached.",
  security: [{ ServiceBearer: [] }],
  middleware: [noStore, systemReader] as const,
  request: { params: z.object({ entity: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: referenceDataWire } }, description: "The reference data of the entity" },
    401: { content: { "application/json": { schema: ProblemSchema } }, description: "No valid service credential (one body for every cause)" },
    404: { content: { "application/json": { schema: ProblemSchema } }, description: "`not_found`: the entity does not exist" },
  },
});

export const referenceDataRouter = new OpenAPIHono<{ Variables: SystemAuthVariables }>();

referenceDataRouter.openapi(route, async (c) => {
  const { entity } = c.req.valid("param");
  if (!isEntity(entity)) throw entityNotFound();

  const [accounts, vatCodes] = await db.$transaction(
    async (tx) => [await listLedgerAccounts(entity, tx), await listVatCodes(entity, tx)] as const,
    { isolationLevel: "RepeatableRead" },
  );
  const body = referenceDataWire.parse({
    entity,
    ownCurrency: OWN_CURRENCY[entity],
    ledgerAccounts: accounts.map(({ number, name, active }) => ({ number, name, active })),
    vatCodes: vatCodes.map(({ code, label, rateBasisPoints, active }) => ({ code, label, rateBasisPoints, active })),
  });
  return c.json(body, 200);
});
