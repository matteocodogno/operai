import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai EstimAI API",
      version: "0.1.0",
      description:
        "Estimate persistence API for the EstimAI tool. " +
        "Stores and retrieves effort estimation documents for signed-in users. " +
        "Requires a valid RS256 Bearer JWT issued by the Operai auth service.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [
      { url: "http://localhost:8080", description: "Local development" },
      { url: "https://api.estimai.operai.io", description: "Production" },
    ],
    tags: [
      {
        name: "Estimates",
        description:
          "Estimate CRUD — create, list, get, update, delete, and bulk-import estimates",
      },
      {
        name: "Collaborators",
        description:
          "Record-level estimate sharing (specs/013-estimate-sharing, ADR-0036) — " +
          "list/add/change-level/remove collaborators and self-leave",
      },
      {
        name: "System",
        description: "Health checks and service metadata",
      },
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
