import { OpenAPIHono } from "@hono/zod-openapi";
import { retryRouter } from "./retry.routes";

// Processing routes (specs/021-meetings): the retry of failed processing (T32).
export const processingRouter = new OpenAPIHono();
processingRouter.route("/", retryRouter);
