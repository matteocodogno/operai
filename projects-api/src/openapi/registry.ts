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
        "Projects, their teams, terms and purchase orders, and the Bexio order id, for the Projects " +
        "tool (specs/021-projects, specs/022-projects-handoff). Requires a valid RS256 Bearer JWT issued by the " +
        "Operai auth service and the projects:access permission.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [{ url: "http://localhost:8085", description: "Local development" }],
    tags: [
      { name: "System", description: "Health checks and service-to-service routes (scoped service credential)" },
      { name: "Scope", description: "What the caller may do" },
      { name: "Projects", description: "The delivery work wellD runs" },
      { name: "Terms", description: "The type-specific delivery terms of a project" },
      {
        name: "Purchase orders",
        description:
          "The delivery-side record of a won deal (Bexio order id, and the referent: a CRM contact of the project's company " +
          "whose data is read live at every opening, never stored or cached; its answers are no-store)",
      },
      { name: "Companies", description: "CRM companies, read through a service credential" },
      {
        name: "Queue",
        description:
          "Won deals waiting for a project, and taking one (specs/022): handoff:take holders only; the take's form reads " +
          "its ops-manager candidates (from auth) and the deal company's contacts (from the CRM) live",
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
