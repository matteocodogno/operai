/**
 * Authorization matrix over the ASSEMBLED app (specs/021-meetings T42; AC-5.8, AC-5.3, AC-4.8,
 * AC-10.4): role × action, read from the app's own route table, so a route added without a row in
 * `test-support/matrixKit.ts` fails here. Each cell is a fresh world (a real meeting, its
 * transcript, summaries, conversation, templates) and the real route; the expectation is the 2xx the
 * action returns, or the plan's refusal: status AND code.
 *
 * Visibility comes before everything on a record route (a stranger gets the same 404 as for an id
 * that never existed), then `creator_only`, `frozen`, `meetings_access_required`. A capability
 * route refuses a caller without the grant with a 403 BEFORE it looks at any record.
 */

import { describe, expect, it } from "bun:test";
import { createKit } from "./test-support/routeKit";
import { PERSONAS, PUBLIC_ROUTES, ROWS, SPECS, kindsOf, rowName, seedWorld, type Cell, type Persona, type RouteRow, type World } from "./test-support/matrixKit";

const kit = await createKit();

const registered = new Set(kit.app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`));
const split = (route: string) => route.split(" ") as [string, string];

/** The row's request as `persona`; `missingMeeting` swaps the meeting's id for one that never existed. */
async function send(world: World, row: RouteRow, persona: Persona, missingMeeting = false) {
  const [method] = split(row.route);
  const path = missingMeeting ? row.path(world).replaceAll(world.m[kindsOf(row)[0]!]!, "no-such-meeting") : row.path(world);
  return kit.call(SPECS[persona].caller, method, path, row.body?.(world), row.headers);
}
const fire = async (row: RouteRow, persona: Persona) => {
  const world = await seedWorld(kit, persona, kindsOf(row));
  return { world, res: await send(world, row, persona) };
};

const is404 = (cell: Cell) => cell !== "ok" && cell[0] === 404;
const describeCell =(cell: Cell, row: RouteRow) => (cell === "ok" ? `${row.ok}` : `${cell[0]}${cell[1] ? ` ${cell[1]}` : ""}`);

describe("the matrix covers the real route table", () => {
  it("has a row for every route the app serves, and no row for one it does not", () => {
    const rowRoutes = new Set(ROWS.map((row) => row.route));
    expect([...registered].filter((key) => !PUBLIC_ROUTES.has(key) && !rowRoutes.has(key))).toEqual([]);
    expect([...rowRoutes].filter((key) => !registered.has(key))).toEqual([]);
  });

  it("the routes served without a token are exactly the pinned public ones, and each is mounted", () => {
    for (const key of PUBLIC_ROUTES) expect(registered.has(key)).toBe(true);
  });

  it.each([...PUBLIC_ROUTES])("%s answers without a token", async (key) => {
    const [method, path] = split(key);
    await kit.reset();
    expect((await kit.call(null, method, path)).status).toBe(200);
  });

  it("every row gives every persona a cell, and anonymous is always 401", () => {
    for (const row of ROWS) {
      for (const persona of PERSONAS) expect(row.cells[persona], `${rowName(row)} / ${persona}`).toBeDefined();
      expect(row.cells.anonymous, rowName(row)).toEqual([401]);
    }
  });
});

describe("role × action", () => {
  it.each(ROWS.map((row) => [rowName(row), row] as const))("%s", async (_name, row) => {
    const wrong: string[] = [];
    for (const persona of PERSONAS) {
      const cell = row.cells[persona];
      const { res } = await fire(row, persona);
      const body = res.status === 204 ? null : ((await res.json().catch(() => null)) as { code?: string } | null);
      const status = cell === "ok" ? row.ok : cell[0];
      const code = cell === "ok" ? undefined : cell[1];
      if (res.status !== status || (code !== undefined && body?.code !== code)) {
        wrong.push(`${persona}: expected ${describeCell(cell, row)}, got ${res.status}${body?.code ? ` ${body.code}` : ""}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("not visible = nonexistent (AC-5.3, AC-4.8)", () => {
  const scoped = ROWS.filter((row) => row.meetingScoped);

  it.each(scoped.map((row) => [rowName(row), row] as const))("%s: the answer to a stranger is byte-identical to the answer for a missing id", async (_name, row) => {
    const wrong: string[] = [];
    for (const persona of ["outsider", "eraser"] as const) {
      if (!is404(row.cells[persona])) continue;
      // One world, two requests: the meeting that exists but may not be opened, and the id that never existed.
      const world = await seedWorld(kit, persona, kindsOf(row));
      const stranger = await send(world, row, persona);
      const missing = await send(world, row, persona, true);
      const strangerText = (await stranger.text()).replaceAll(world.m[kindsOf(row)[0]!]!, "MID");
      const missingText = (await missing.text()).replaceAll("no-such-meeting", "MID");
      if (stranger.status !== 404) wrong.push(`${persona}: got ${stranger.status}, expected 404`);
      if (stranger.status !== missing.status) wrong.push(`${persona}: status ${stranger.status} vs ${missing.status}`);
      if (strangerText !== missingText) wrong.push(`${persona}: body differs\n  stranger: ${strangerText}\n  missing:  ${missingText}`);
      if (stranger.headers.get("content-type") !== missing.headers.get("content-type")) wrong.push(`${persona}: content-type differs`);
    }
    expect(wrong).toEqual([]);
  });

  it("the matrix has strangers' cells to compare for the record routes", () => {
    expect(scoped.filter((row) => is404(row.cells.outsider)).length).toBeGreaterThan(20);
  });
});
