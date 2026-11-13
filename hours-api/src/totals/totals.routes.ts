/**
 * `GET /time-entries/totals` — the hours of a period grouped by person, project, deal, category, month or day
 * (specs/029 T18; plan § Totals; AC-1.4, AC-2.6, AC-4.1, AC-4.4, AC-4.5, AC-4.7, AC-4.8, AC-4.10, AC-4.11).
 *
 * The same question as the list's, answered as a sum: the same `whose`, filters and period (src/entries/filters.ts,
 * T17's, so a view's list and its totals can never disagree about which entries match), but never paged — the answer
 * is complete, every matching entry counted in exactly one group — and with no `cursor` or `limit`. What the request
 * SAYS is validated first, from the request alone; then the entries are tallied by `totalsOf` (./totals.ts).
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { JwtVariables } from "../auth/jwt.middleware";
import { UnavailableSchema } from "../entries/list.routes";
import { entryWhere, filterShape, readFilters } from "../entries/filters";
import { invalidRequestHook } from "../lib/errors";
import { ProblemSchema } from "../lists/errorDocs";
import { readScope } from "../oversight/scope";
import { GROUPINGS } from "./groups";
import { totalsOf } from "./totals";

const TotalsQuerySchema = z
  .object({
    ...filterShape,
    groupBy: z.enum(GROUPINGS).openapi({ description: "What the hours are added up by: one group per person, project, deal, category, calendar month or day" }),
  })
  .strict();

const minutes = z.number().int().openapi({ description: "Minutes: a whole number, never zero in a group" });

const TotalsGroupSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("keyed"),
        key: z.string().openapi({ description: "A user id, a project, deal or category id, `YYYY-MM` or `YYYY-MM-DD`, by `groupBy`" }),
        label: z.string().nullable().openapi({ description: "The name as the viewer may read it; `null` for a month or a day (the client formats the key) and for a person not named" }),
        minutes,
        status: z.enum(["active", "deleted", "unknown"]).optional().openapi({ description: "`groupBy=person` only" }),
        retired: z.boolean().optional().openapi({ description: "`groupBy=category` only" }),
      })
      .strict(),
    z.object({ kind: z.literal("none"), minutes }).strict().openapi({ description: "Entries outside the grouping" }),
    z.object({ kind: z.literal("hidden"), minutes }).strict().openapi({ description: "`project` or `deal`: everything the viewer may not read, merged" }),
    z.object({ kind: z.literal("unavailable"), minutes }).strict().openapi({ description: "`project` or `deal`: everything whose owner did not answer, merged" }),
    z.object({ kind: z.literal("deal-unknown"), minutes }).strict().openapi({ description: "`deal`: meeting entries whose current deal could not be read" }),
  ])
  .openapi("TotalsGroup");

const problemDoc = (description: string) => ({ description, content: { "application/json": { schema: ProblemSchema } } });

const totalsRoute = createRoute({
  method: "get",
  path: "/time-entries/totals",
  tags: ["Entries"],
  summary: "The hours of a period, grouped (any session; whose=all needs time-entry:read-all)",
  description:
    "The entries `GET /time-entries` lists for the same filters, added up by `groupBy`. Complete: every matching entry is in exactly one group " +
    "and the groups' minutes add up to `totalMinutes`; never paged. `whose=mine` (the default) is the caller's own and never asks `auth`. " +
    "`whose=all`, and `userId`, need `time-entry:read-all`, asked live of `auth` as the caller: 403 without it, 503 when `auth` cannot say. " +
    "`groupBy=person` without `userId` lists every person with hours in the period (the person filter's options).",
  request: { query: TotalsQuerySchema },
  responses: {
    200: {
      description: "The groups, in the order the plan lists for the grouping",
      content: { "application/json": { schema: z.object({ totalMinutes: z.number().int(), groups: z.array(TotalsGroupSchema), unavailable: UnavailableSchema }) } },
    },
    400: problemDoc("`invalid_request`: a bad or missing period or `groupBy`, a filter outside its rule, a member the route does not know (`field` names it)"),
    401: problemDoc("No valid session"),
    403: problemDoc("`read_all_required`: `whose=all` or a `userId` without `time-entry:read-all`"),
    503: problemDoc(
      "`authz_unavailable`: `whose=all` or a `userId`, and `auth` could not say whether the caller holds `time-entry:read-all` (never allowed, AC-5.4). " +
        "`host_unavailable`: with a `dealId` filter, meetings-api could not say which meetings are linked to the deal. " +
        "Nothing partial is returned: a deal's hours are never shown low",
    ),
  },
});

export const totalsRouter = new OpenAPIHono<{ Variables: JwtVariables }>({ defaultHook: invalidRequestHook });

totalsRouter.openapi(totalsRoute, async (c) => {
  const query = c.req.valid("query");
  const filters = readFilters(query);
  const authorization = c.req.header("Authorization") ?? "";
  // The same order as the list's: what the request alone decides first, then whose entries (the oversight check for
  // `whose=all`), then the `dealId` filter's question to meetings-api, then the sums.
  const scope = await readScope(filters, { sub: c.get("userId"), permEpoch: c.get("permEpoch"), authorization });
  const where = await entryWhere(filters, scope);
  return c.json(await totalsOf(query.groupBy, where, authorization), 200);
});
