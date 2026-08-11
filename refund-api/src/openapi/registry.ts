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
        "Reimbursement request API for the Refund tool. " +
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
          "Entity-scoped accounting review queue and decisions, plus the " +
          "post-decision employee notification (T11-T13, specs/007-refund-service).",
      },
      {
        name: "Batches",
        description:
          "Monthly compiled-batch processing — candidate preview, the " +
          "atomic compile claim, and (in later tasks) reads, email, " +
          "mark-paid, and discard (specs/008-refund-monthly-processing).",
      },
      {
        name: "Rates",
        description:
          "Per-entity, effective-dated mileage rates — admin-managed " +
          "history/audit (rate:read/rate:manage) and the employee-facing " +
          "effective-rate lookup (refund:access) that drives computed " +
          "travel_km amounts (specs/009-mileage-rate).",
      },
      {
        name: "Suggestions",
        description:
          "Derived, self-scoped reads that help an employee compose a line " +
          "faster — currently the caller's OWN past `travel_km` trip " +
          "signatures behind the motivo autocomplete (specs/014-motivo-" +
          "autocomplete). Never another user's data: gated by the existing " +
          "`request:read` capability, scoped unconditionally to the verified " +
          "JWT `sub`, and exposing no caller-controlled selector at all.",
      },
      {
        name: "Settings",
        description:
          "Admin-managed refund configuration — an append-only key/value " +
          "store (settings:read/settings:manage), currently exposing the " +
          "accounting-distribution-email setting the compiled-batch email " +
          "(specs/008) is sent to (specs/011-refund-settings).",
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
