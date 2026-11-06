/**
 * The service-to-service routes of projects-api (specs/022-projects-handoff, ADR-0060), mounted
 * once by `src/index.ts`. Every route here is behind `systemAuthMiddleware` (a scoped service
 * credential, never a user JWT); a new one is added to this router, not to the index.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { systemPurchaseOrdersRouter } from "./purchaseOrders.routes";
import type { SystemAuthVariables } from "./systemAuth.middleware";

export const systemRouter = new OpenAPIHono<{ Variables: SystemAuthVariables }>();

systemRouter.route("/", systemPurchaseOrdersRouter);
