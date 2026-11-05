/**
 * Request and response schemas shared by the meeting route groups (specs/021-meetings
 * plan.md § API contracts). The response shapes are built by `view.ts` / `rows.ts`
 * (typed there), so here they are documented for OpenAPI without being re-declared.
 */

import { z } from "@hono/zod-openapi";
import type { MeetingView } from "./view";
import type { MeetingRow } from "./rows";

export const MeetingSchema = z
  .custom<MeetingView>((value) => typeof value === "object" && value !== null)
  .openapi({ type: "object", description: "The Meeting of specs/021 plan.md § API contracts" });

export const MeetingRowSchema = z
  .custom<MeetingRow>((value) => typeof value === "object" && value !== null)
  .openapi({ type: "object", description: "A MeetingRow of specs/021 plan.md § API contracts" });

/** `{ app, entityType, entityId }`: a reference to an entity in a host tool. */
export const HostRefSchema = z
  .object({
    app: z.string().trim().min(1).max(64),
    entityType: z.string().trim().min(1).max(64),
    entityId: z.string().trim().min(1).max(64),
  })
  .openapi("HostRef");

export const MEETING_FORMATS = ["in_person", "online"] as const;
export const MEETING_LANGUAGES = ["en", "it"] as const;
export const MEETING_SOURCES = ["recorded", "uploaded", "text"] as const;
export const DERIVED_STATUSES = ["draft", "recording", "interrupted", "processing", "ready", "failed"] as const;

/** AC-1.3: title 1 to 200 characters (after trimming). */
export const TitleSchema = z.string().trim().min(1).max(200);

/** An ISO 8601 instant with an offset; may be in the past (AC-1.3). */
export const InstantSchema = z.string().datetime({ offset: true });
