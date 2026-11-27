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
        "the categories and work types an admin manages, and the totals, specs/20261112-time-tracking. " +
        "Requires a valid RS256 Bearer JWT issued by the Operai auth service. Every user records and " +
        "reads their own hours; everyone's hours need `time-entry:read-all` and the lists need " +
        "`time-list:manage`, both asked live of auth (ADR 20261112-hours-api-time-entries-own-service-hours-catalog). Whether a person may book on a " +
        "project, a deal or a meeting is asked of its owner as the caller (ADR 20261112-time-bookability-asked-of-owners-meeting-hosts-system-route). " +
        "The hours on one project or deal, as everyone recorded them, are `GET /time-entries/summary` for whoever its owner says may read the record; " +
        "its per-person part is for the project's manager, the deal's owner and holders of `time-entry:read-all` " +
        "(specs/20261112-project-hours, ADR 20261126-a-record-hours-summary-is-authorised-by-the-records-owner-as-the-reader-and-its-per-person-part-by-a-role-the-owner-states). " +
        "One route is not a person's: meetings-api tells hours-api what a meeting's hours facts are, with a scoped service JWT " +
        "(`POST /system/meeting-hours/v1/notices`, specs/20261112-meeting-hours).",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [{ url: "http://localhost:8090", description: "Local development" }],
    tags: [{ name: "System", description: "Health checks, and the one route another service calls" }],
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
