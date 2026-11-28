/**
 * `GET /time-entries/summary` — the hours of ONE record, a project or a deal, as everyone recorded them (specs/20261112-project-hours T9; plan
 * § API contracts; AC-1.8, AC-2.1–2.5, AC-2.7, AC-3.1, AC-4.1–4.3, AC-4.9; ADR
 * 20261126-a-record-hours-summary-is-authorised-by-the-records-owner-as-the-reader-and-its-per-person-part-by-a-role-the-owner-states).
 *
 * The suite's third read of hours: a person's own (any session), everyone's (`time-entry:read-all`), and this one — a record's, for whoever the
 * record's OWNER says may read the record, asked as that reader on every request and never remembered (./summary.ts). It is a read: no write route
 * comes with it, and it asks `auth` only for a caller who is neither the project's manager nor the deal's owner, to learn whether they hold
 * `time-entry:read-all`.
 *
 * The answer is groups of minutes and nothing else, so it is never cached (`Cache-Control: no-store`, ADR § Risks: a change to that header names the ADR).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { JwtVariables } from "../auth/jwt.middleware";
import { invalidRequestHook } from "../lib/errors";
import { ProblemSchema } from "../lists/errorDocs";
import { SummaryQuerySchema, readSummaryQuery } from "./query";
import { summaryOf } from "./summary";

const minutes = z.number().int().openapi({ description: "Minutes: a whole number, never zero in a group" });

const WorkTypeGroupSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("keyed"),
        key: z.string().openapi({ description: "A work type's id" }),
        label: z.string().openapi({ description: "The work type's name as typed, shown even when it is retired" }),
        minutes,
        retired: z.boolean(),
      })
      .strict(),
    z.object({ kind: z.literal("none"), minutes }).strict().openapi({ description: "The hours without a work type: an entry on a meeting has none, and neither has one the person did not give" }),
  ])
  .openapi("SummaryWorkTypeGroup");

const PersonGroupSchema = z
  .object({
    kind: z.literal("keyed"),
    key: z.string().openapi({ description: "A user id" }),
    label: z.string().nullable().openapi({ description: "The person's name as `auth` names them now; `null` for one it cannot name" }),
    minutes,
    status: z.enum(["active", "deleted", "unknown"]),
  })
  .strict()
  .openapi("SummaryPersonGroup");

const SummaryAnswerSchema = z
  .object({
    on: z.object({ type: z.enum(["project", "deal"]), id: z.string() }).strict(),
    totalMinutes: z.number().int().openapi({ description: "All time: the entries on the record and on the meetings linked to it now, whoever recorded them" }),
    windowMinutes: z.number().int().nullable().openapi({ description: "The same, the days of the window only (both ends included); `null` without a window" }),
    byWorkType: z.array(WorkTypeGroupSchema).openapi({ description: "The most hours first, then by name; the `none` group last. Adds up to `totalMinutes`" }),
    byPerson: z.array(PersonGroupSchema).nullable().openapi({
      description:
        "The hours of each person, by name. Present only for the project's manager, the deal's owner (as the record's owner states it) or a holder of `time-entry:read-all`; " +
        "`null` for everyone else, for a project that awaits its manager, and while `auth` cannot say (`authz` in `unavailable`). Adds up to `totalMinutes` when present",
    }),
    unavailable: z.array(z.enum(["identities", "authz"])).openapi({
      description:
        "`identities`: `auth` could not name some people (their `label` is null). `authz`: `auth` could not say whether the caller holds `time-entry:read-all`, so `byPerson` is withheld",
    }),
  })
  .strict()
  .openapi("SummaryAnswer");

const problemDoc = (description: string) => ({ description, content: { "application/json": { schema: ProblemSchema } } });

const summaryRoute = createRoute({
  method: "get",
  path: "/time-entries/summary",
  tags: ["Entries"],
  summary: "The hours of a project or a deal, as everyone recorded them (any session that may read the record)",
  description:
    "The hours on ONE record: the entries on the project or deal itself plus the entries on the meetings linked to it now, whoever recorded them. " +
    "Whether the caller may read the record is asked of its owner (projects-api, crm-api) as the caller, on every request. " +
    "A reader gets `totalMinutes`, `windowMinutes` and `byWorkType`; `byPerson` only the project's manager, the deal's owner or a holder of `time-entry:read-all`. " +
    "The answer carries no entry, note, meeting id or title, activity subject or amount, and is never cached.",
  request: { query: SummaryQuerySchema },
  responses: {
    200: { description: "The figures of the record", content: { "application/json": { schema: SummaryAnswerSchema } } },
    400: problemDoc("`invalid_request`: not exactly one of `projectId` and `dealId`, an id outside the id rule, a half window, a window with a deal or a window that ends before it begins (`field` names it)"),
    401: problemDoc("No valid session"),
    404: problemDoc("`not_found`: no record with this id that the caller may read. One answer for a record that does not exist and one the caller may not read"),
    503: problemDoc(
      "`host_unavailable`: the record's owner could not say whether the caller may read it, or meetings-api could not say which meetings are linked to it. " +
        "Nothing partial is returned: a record's hours are never shown low",
    ),
  },
});

export const summaryRouter = new OpenAPIHono<{ Variables: JwtVariables }>({ defaultHook: invalidRequestHook });

summaryRouter.openapi(summaryRoute, async (c) => {
  // Before anything can throw: a refusal about a record is no more to be kept than its figures.
  c.header("Cache-Control", "no-store");
  const request = readSummaryQuery(c.req.valid("query"));
  const session = { sub: c.get("userId"), permEpoch: c.get("permEpoch"), authorization: c.req.header("Authorization") ?? "" };
  return c.json(await summaryOf(request, session), 200);
});
