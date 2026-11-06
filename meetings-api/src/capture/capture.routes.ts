import { OpenAPIHono } from "@hono/zod-openapi";
import { recordingRouter } from "./recording.routes";
import { textRouter } from "./text.routes";
import { uploadRouter } from "./upload.routes";

// The capture group: browser recording (T26/T27), upload (T28), text (T29).
// Each sub-router carries its own guard stack per route (never `use("*")`).
export const captureRouter = new OpenAPIHono();
captureRouter.route("/", recordingRouter);
captureRouter.route("/", textRouter);
captureRouter.route("/", uploadRouter);
