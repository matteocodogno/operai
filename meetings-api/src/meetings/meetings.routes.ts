import { OpenAPIHono } from "@hono/zod-openapi";
import { noticeRetryRouter } from "../hosts/noticeRetry.routes";
import { coreRouter } from "./core.routes";
import { consentRouter } from "./consent.routes";
import { deleteRouter } from "./delete.routes";
import { listRouter } from "./list.routes";
import { participantsRouter } from "./participants.routes";

// The meeting route groups, mounted at "/" by src/index.ts. Each group lives in its own
// file (specs/021-meetings tasks.md); this file only assembles the ones that belong to
// `/meetings` itself. Capture, transcript, summaries, conversation and audio are mounted by
// their own routers in index.ts.
export const meetingsRouter = new OpenAPIHono();

meetingsRouter.route("/", listRouter);
meetingsRouter.route("/", coreRouter);
meetingsRouter.route("/", deleteRouter);
meetingsRouter.route("/", participantsRouter);
meetingsRouter.route("/", consentRouter);
meetingsRouter.route("/", noticeRetryRouter);
