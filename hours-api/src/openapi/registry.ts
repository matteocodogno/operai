import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

/** The two documents are public, like /health: they describe the API and hold no record. */
export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Hours API",
      version: "0.1.0",
      description:
        "Time entries (a person's hours on a day, on a project, a deal, a meeting or no entity), " +
        "the categories and work types an admin manages, and the totals, specs/029-time-tracking. " +
        "Requires a valid RS256 Bearer JWT issued by the Operai auth service. Every user records and " +
        "reads their own hours; everyone's hours need `time-entry:read-all` and the lists need " +
        "`time-list:manage`, both asked live of auth (ADR-0088). Whether a person may book on a " +
        "project, a deal or a meeting is asked of its owner as the caller (ADR-0089).",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [{ url: "http://localhost:8088", description: "Local development" }],
    tags: [{ name: "System", description: "Health checks" }],
  });

  // Scalar UI at /docs
  app.get(
    "/docs",
    apiReference({
      spec: { url: "/openapi.json" },
      theme: "purple",
      layout: "modern",
    }),
  );
}
