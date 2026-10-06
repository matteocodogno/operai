import { OpenAPIHono } from "@hono/zod-openapi";

// Stub router (T1, specs/015-hardware-inventory). Mounted in src/index.ts so
// the owning task adds routes here without touching index.ts.
export const assetRegisterRouter = new OpenAPIHono();
