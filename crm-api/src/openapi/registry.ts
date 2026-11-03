import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai CRM API",
      version: "0.1.0",
      description:
        "Companies, contacts, deals, the sales pipeline and activities for the " +
        "CRM tool (specs/017-crm). Requires a valid RS256 Bearer JWT issued by " +
        "the Operai auth service and the crm:access permission.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [
      { url: "http://localhost:8084", description: "Local development" },
    ],
    tags: [
      { name: "System", description: "Health checks and service-to-service routes (scoped service credential)" },
      { name: "Scope", description: "What the caller may do" },
      { name: "Companies", description: "Organisations wellD works with" },
      { name: "Contacts", description: "People at those organisations" },
      { name: "Deals", description: "Opportunities and the pipeline" },
      { name: "Activities", description: "Notes, calls, meetings, emails and tasks" },
    ],
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
