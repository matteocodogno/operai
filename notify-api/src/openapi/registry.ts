import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  // OpenAPI 3.1 JSON spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Notify API",
      version: "0.1.0",
      description:
        "Notification center API for the Operai suite. " +
        "Persists and pushes per-user notifications raised by other Operai tools. " +
        "Requires a valid RS256 Bearer JWT issued by the Operai auth service.",
      contact: {
        name: "wellD",
        url: "https://welld.ch",
      },
    },
    servers: [
      { url: "http://localhost:8081", description: "Local development" },
      { url: "https://notify-api.operai.welld.io", description: "Production" },
    ],
    tags: [
      {
        name: "Notifications",
        description:
          "Notification raise/list/read/stream — persistence and real-time push for the notification center. " +
          "All endpoints except GET /notifications/stream are behind jwtMiddleware (RS256 Bearer JWT).",
      },
      {
        name: "Push",
        description:
          "Web push device registration (specs/20261111-push-notifications, ADR 20261111-web-push-encrypted-payloads-not-fcm): GET /push/config, PUT|GET /push/devices and " +
          "DELETE /push/devices/{id}. User JWT only, scoped to the caller; a device's endpoint and keys are never returned.",
      },
      {
        name: "System",
        description:
          "Health checks and service metadata, plus the internal-only " +
          "POST /system/emails and POST /system/notifications endpoints " +
          "(a scoped service JWT in Authorization: Bearer, scope " +
          "emails.send / notifications.push, aud=SERVICE_AUDIENCE — " +
          "NOT a user JWT; ADR 20261006-scoped-service-jwt-fourth-notify-caller, ADR 20261013-all-notify-callers-scoped-credentials-shared-token-retired). The retired X-Internal-Token " +
          "header is refused. A user JWT is refused here and the " +
          "Notifications routes never accept a service JWT. Both routes take an optional `idempotencyKey` " +
          "(1-200 of [A-Za-z0-9._:-], scoped to the calling service's `sub`): a repeat of a stored notification " +
          "answers 200 with it, a repeat of a sent email answers 200 with the same deliveryId, and nothing new " +
          "is sent (the email key also reaches Resend as `<sub>:<key>`, which keeps keys 24 hours). An email " +
          "template may be bound to specific callers (403 `template_not_allowed`) and may be addressed by " +
          "`recipientId` instead of `to` (exactly one of the two; only for a template that allows it).",
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
