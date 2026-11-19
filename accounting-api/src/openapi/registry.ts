import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Accounting API",
      version: "0.1.0",
      description:
        "Ledger accounts, VAT codes and monthly exchange rates of each legal entity, for the Accounting tool " +
        "(specs/20261119-accounting). User routes need a valid RS256 Bearer JWT issued by the Operai auth service and an " +
        "`accounting:read` or `accounting:manage` grant covering the entity; `/system/v1/*` accepts only a scoped service " +
        "JWT (scope `accounting.reference.read`) and never writes.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [{ url: "http://localhost:8089", description: "Local development" }],
    tags: [
      { name: "System", description: "Health checks and service-to-service routes (scoped service credential)" },
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
