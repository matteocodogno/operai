import type { OpenAPIHono } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export function setupOpenAPI(app: OpenAPIHono): void {
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Operai Meetings API",
      version: "0.1.0",
      description:
        "Record, transcribe, summarise and question meetings (specs/021-meetings). " +
        "Requires a valid RS256 Bearer JWT issued by the Operai auth service; " +
        "visibility is by participation, capabilities are resolved live from auth.",
      contact: { name: "wellD", url: "https://welld.ch" },
    },
    servers: [{ url: "http://localhost:8085", description: "Local development" }],
    tags: [
      { name: "System", description: "Health checks" },
      { name: "Hosts", description: "Entities in other tools a meeting can belong to" },
      { name: "Meetings", description: "Meeting metadata, participants and consent" },
      { name: "Capture", description: "Recording, upload and pasted text" },
      { name: "Transcript", description: "Segments and speakers" },
      { name: "Summaries", description: "Template-based summaries" },
      { name: "Templates", description: "Summary templates" },
      { name: "Conversation", description: "Ask the meeting" },
      { name: "Erase", description: "Deletion on request" },
    ],
  });

  app.get("/docs", apiReference({ spec: { url: "/openapi.json" }, theme: "purple", layout: "modern" }));
}
