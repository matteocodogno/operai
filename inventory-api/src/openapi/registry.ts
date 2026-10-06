import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Inventory API",
      version: "0.1.0",
      description:
        "Hardware inventory and depreciation register for the Inventory tool " +
        "(specs/015-hardware-inventory): assets, assignments, the " +
        "depreciation ledger and fiscal-year roll-forward, invoice files and " +
        "an immutable history. Requires a valid RS256 Bearer JWT issued by " +
        "the Operai auth service.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [
      { url: "http://localhost:8083", description: "Local development" },
    ],
    tags: [
      {
        name: "System",
        description: "Health checks",
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
