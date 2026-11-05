import { OpenAPIHono } from "@hono/zod-openapi";
import { noticeRetryRouter } from "../hosts/noticeRetry.routes";

// The meeting route groups, mounted at "/" by src/index.ts. Each group lives in its own
// file (specs/021-meetings tasks.md); this file only assembles the ones that belong to
// `/meetings` itself. Capture, transcript, summaries, conversation and audio are mounted by
// their own routers in index.ts.
export const meetingsRouter = new OpenAPIHono();

meetingsRouter.route("/", noticeRetryRouter);
