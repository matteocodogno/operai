import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Projects API",
      version: "0.1.0",
      description:
        "Projects, their teams and contracts, and the Bexio order id, for the Projects " +
        "tool (specs/024-projects). Requires a valid RS256 Bearer JWT issued by the " +
        "Operai auth service and the projects:access permission.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [{ url: "http://localhost:8085", description: "Local development" }],
    tags: [
      { name: "System", description: "Health checks" },
      { name: "Scope", description: "What the caller may do" },
      { name: "Projects", description: "The delivery work wellD runs" },
      { name: "Contracts", description: "What each client bought on a project" },
      { name: "Companies", description: "CRM companies, read through a service credential" },
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
