import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Refund API",
      version: "0.1.0",
      description:
        "Reimbursement request API for the Refund (Rimborsi) tool. " +
        "Employee expense requests, entity-scoped accounting review and " +
        "decisions, and an immutable financial audit trail (specs/007). " +
        "Requires a valid RS256 Bearer JWT issued by the Operai auth service.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [
      { url: "http://localhost:8082", description: "Local development" },
      { url: "https://api.refund.operai.io", description: "Production" },
    ],
    tags: [
      {
        name: "System",
        description: "Health checks and identity-verification probes",
      },
      {
        name: "Review",
        description:
          "Entity-scoped accounting review queue and decisions (T11-T12, specs/007-refund-service).",
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
