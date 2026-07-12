import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Auth Service",
      version: "0.1.0",
      description:
        "Authentication and authorisation service for the Operai platform. " +
        "Handles social OAuth (Google, GitHub), session management, and RS256 JWT issuance.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [
      { url: "http://localhost:3001", description: "Local development" },
      { url: "https://auth.operai.io", description: "Production" },
    ],
    tags: [
      {
        name: "Authentication",
        description:
          "Social OAuth flows, session management (powered by Better Auth)",
      },
      {
        name: "System",
        description: "Health checks, JWKS, and service metadata",
      },
      {
        name: "Admin",
        description:
          "Authorization administration (roles, departments, users, audit trail). " +
          "Requires an authenticated session; admin-only gating lands with requireAdmin (spec 004, T4).",
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
