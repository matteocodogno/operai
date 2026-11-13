/**
 * The OpenAPI document of the ASSEMBLED app is the contract clients read (specs/029-time-tracking T20; AC-1.8,
 * AC-1.6, AC-3.2, AC-5.3; plan § API contracts, § Entries "The id rule", "Counting a note and a name", "The
 * cursor", § Errors "501 is a build-order seam, not part of the contract"). hours-ui, the e2e and the next
 * service to call hours-api are written against what `GET /openapi.json` says, so it is asserted here, not
 * trusted:
 *
 *   - every mounted route is documented and every documented operation is mounted, and every JWT route
 *     documents its 401;
 *   - an entry is a day and a duration, never a time of day (AC-1.8): `TimeEntryView` carries no such member
 *     and the `POST` body is strict, so a `start`, an `end` or a `userId` is refused, never ignored;
 *   - no `DELETE` exists on the lists (AC-3.2);
 *   - every bound a client relies on is in the document, as the plan states it: the id rule on body ids, path
 *     `{id}`s and the six filter ids (1..64), the note (1000), the name of a list item (80), the cursor (200),
 *     and the page size (1..500);
 *   - no 501 and no build-order seam is documented.
 *
 * It reads the document the app serves, over the assembled app and the real database, through the public
 * `GET /openapi.json`. A few probes drive the app to show that what the document says is what it enforces.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { PERSONAS, SEED, app, call, db, makeDealEntry, makeNoEntityEntry, resetWorld } from "./test-support/world";
import { startHosts } from "./test-support/hosts";
import { __setClockForTests } from "./entries/today";
import { __resetOversightCacheForTests } from "./oversight/oversight";

const hosts = startHosts();
afterAll(() => {
  __setClockForTests(null);
  return hosts.stop();
});

beforeEach(async () => {
  __setClockForTests(() => new Date("2026-11-13T10:00:00Z"));
  await resetWorld();
});

// ─── The document, as a client reads it ──────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- an OpenAPI document is untyped JSON, and this file is about its shape */
type Schema = any;

const fetched = await call("GET", "/openapi.json", { as: null });
const doc: Schema = fetched.json;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

interface Operation {
  /** `GET /time-entries/:id` — the spelling of `app.routes`. */
  readonly key: string;
  readonly method: string;
  /** The documented path, `{id}` style. */
  readonly path: string;
  readonly op: Schema;
}

const operations: Operation[] = Object.entries<Schema>(doc.paths).flatMap(([path, item]) =>
  METHODS.filter((method) => item[method] !== undefined).map((method) => ({
    key: `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`,
    method: method.toUpperCase(),
    path,
    op: item[method],
  })),
);

const operation = (key: string): Operation => {
  const found = operations.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`${key} is not documented`);
  return found;
};

const deref = (node: Schema): Schema => {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    const name = (node.$ref as string).replace(/^#\/components\/schemas\//, "");
    const target = doc.components?.schemas?.[name];
    if (!target) throw new Error(`${node.$ref} is not in components`);
    return target;
  }
  return node;
};

/** Every schema node under `root`, with the dotted path of its property names (a variant of `oneOf` keeps its parent's path). */
function* walk(root: Schema, path: readonly string[] = []): Generator<{ path: readonly string[]; schema: Schema }> {
  const schema = deref(root);
  if (!schema || typeof schema !== "object") return;
  yield { path, schema };
  for (const [name, child] of Object.entries<Schema>(schema.properties ?? {})) yield* walk(child, [...path, name]);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) for (const child of schema[key] ?? []) yield* walk(child, path);
  if (schema.items) yield* walk(schema.items, [...path, "[]"]);
}

const bodyOf = (key: string): Schema => operation(key).op.requestBody.content["application/json"].schema;
const parametersOf = (key: string): Schema[] => operation(key).op.parameters ?? [];
const parameter = (key: string, name: string): Schema => {
  const found = parametersOf(key).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${key} documents no parameter ${name}`);
  return found;
};

/** The dotted property paths of `root` whose last name satisfies `matches`. */
const propertyPaths = (root: Schema, matches: (name: string) => boolean): string[] =>
  [...new Set([...walk(root)].filter(({ path }) => path.length > 0 && matches(path[path.length - 1]!)).map(({ path }) => path.join(".")))].sort();

const isIdName = (name: string) => name === "id" || name.endsWith("Id");

const SIXTY_FOUR = "x".repeat(64);

// ─── The document and the app say the same ───────────────────────────────────

describe("the document and the route table say the same (AC-5.3)", () => {
  const mounted = [...new Set(app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`))];
  /** The documents describe the API, they are not part of it. */
  const UNDOCUMENTED = ["GET /openapi.json", "GET /docs"];

  it("documents every mounted route, and mounts every documented one", () => {
    expect(operations.map((candidate) => candidate.key).sort()).toEqual(mounted.filter((key) => !UNDOCUMENTED.includes(key)).sort());
  });

  it("documents the 401 of every route that needs a session, and of no public one", () => {
    for (const { key, op } of operations) {
      const status = Object.keys(op.responses);
      if (key === "GET /health") expect({ key, status: status.includes("401") }).toEqual({ key, status: false });
      else expect({ key, status: status.includes("401") }).toEqual({ key, status: true });
    }
  });

  it("documents a success answer for every operation, and a 400 for every one that reads a request", () => {
    for (const { key, op, method } of operations) {
      expect({ key, success: Object.keys(op.responses).some((status) => status.startsWith("2")) }).toEqual({ key, success: true });
      if (key === "GET /health") continue;
      const readsARequest = op.requestBody !== undefined || parametersOf(key).length > 0;
      if (readsARequest) expect({ key, method, status: Object.keys(op.responses).includes("400") }).toEqual({ key, method, status: true });
    }
  });

  it("documents no 501 and no build-order seam: the contract has none (plan § Errors, R11)", () => {
    for (const { key, op } of operations) expect({ key, status: Object.keys(op.responses).includes("501") }).toEqual({ key, status: false });
    // The text is tested, not just the status keys: no description may promise a route that is not there yet.
    expect(JSON.stringify(doc)).not.toMatch(/not[_ ]implemented|transitional|coming soon|not yet implemented/i);
  });

  it("is served without a credential, as OpenAPI 3.1", () => {
    expect(fetched.status).toBe(200);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Operai Hours API");
  });
});

// ─── AC-1.8: a day and a duration, never a time of day ───────────────────────

describe("TimeEntryView records a day and a duration only (AC-1.8)", () => {
  const view = deref({ $ref: "#/components/schemas/TimeEntryView" });

  /** Names that would make an entry a stretch of the clock; `createdAt` / `updatedAt` are when the ROW was written. */
  const TIME_OF_DAY = ["start", "end", "startTime", "endTime", "startsAt", "endsAt", "startedAt", "endedAt", "from", "to", "time", "timeOfDay", "hour", "hours", "begin", "finish"];

  it("has exactly the members the plan lists, none of them a time of day", () => {
    expect(Object.keys(view.properties).sort()).toEqual(["activity", "createdAt", "day", "id", "minutes", "note", "on", "person", "updatedAt", "workType"]);
    const names = new Set([...walk(view)].flatMap(({ path }) => (path.length > 0 ? [path[path.length - 1]!] : [])));
    expect([...names].filter((name) => TIME_OF_DAY.includes(name))).toEqual([]);
    // Any other new member is a decision to look at, not a free addition: it must not be a time of day either.
    expect([...names].sort()).toEqual(
      ["activity", "category", "createdAt", "day", "deal", "href", "id", "label", "minutes", "name", "note", "on", "person", "retired", "state", "status", "subject", "type", "updatedAt", "visibility", "workType"].sort(),
    );
  });

  it("types the day as a calendar day string and the duration as an integer number of minutes", () => {
    expect(view.properties.day.type).toBe("string");
    expect(view.properties.day.format).not.toBe("date-time");
    expect(view.properties.minutes.type).toBe("integer");
  });

  it("is closed at every level: a view carries what it lists and nothing more", () => {
    for (const { path, schema } of walk(view)) {
      if (schema.type === "object") expect({ path: path.join("."), closed: schema.additionalProperties }).toEqual({ path: path.join("."), closed: false });
    }
  });

  it("is what POST answers: the answer of a recorded entry has those members and no time of day", async () => {
    const res = await call("POST", "/time-entries", { as: "alice", body: { day: "2026-11-05", minutes: 90, on: { type: "none", categoryId: SEED.categories.training } } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.json).sort()).toEqual(Object.keys(view.properties).sort());
    expect(res.json.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.json.minutes).toBe(90);
  });

  it("is the item of every answer that lists or changes an entry", () => {
    const refersToView = (schema: Schema) => JSON.stringify(schema).includes("#/components/schemas/TimeEntryView");
    const answer = (key: string, status: string) => operation(key).op.responses[status].content["application/json"].schema;
    expect(refersToView(answer("POST /time-entries", "201"))).toBe(true);
    expect(refersToView(answer("PATCH /time-entries/:id", "200"))).toBe(true);
    expect(refersToView(answer("GET /time-entries", "200").properties.items)).toBe(true);
  });
});

// ─── D44: the id of a record the viewer may not read ─────────────────────────

describe("TimeEntryView withholds the id of a record its viewer may not read: those ids are `string | null` (D44, owasp-report.md F1)", () => {
  const view = deref({ $ref: "#/components/schemas/TimeEntryView" });
  const variants: Schema[] = view.properties.on.oneOf.map(deref);
  const variant = (type: string): Schema => {
    const found = variants.find((candidate) => candidate.properties.type.enum?.[0] === type);
    if (!found) throw new Error(`the view's \`on\` has no ${type} variant`);
    return found;
  };

  it("makes `on.id` nullable on a project, a deal and a meeting, and the member stays required", () => {
    for (const type of ["project", "deal", "meeting"]) {
      const on = variant(type);
      expect({ type, id: on.properties.id.type, nullable: on.properties.id.nullable, required: on.required.includes("id") }).toEqual({
        type,
        id: "string",
        nullable: true,
        required: true,
      });
    }
  });

  it("makes `activity.id` nullable, the member required", () => {
    const activity = deref(view.properties.activity);
    expect({ type: activity.properties.id.type, nullable: activity.properties.id.nullable, required: activity.required.includes("id") }).toEqual({
      type: "string",
      nullable: true,
      required: true,
    });
  });

  it("leaves every other id as it was: the entry, the person, an entry's category and work type, and the deal a visible meeting counts for are never withheld", () => {
    const notNullable = (schema: Schema) => expect(schema.nullable ?? false).toBe(false);
    notNullable(view.properties.id);
    notNullable(deref(view.properties.person).properties.id);
    notNullable(variant("none").properties.category.properties.id);
    // The work type is itself nullable (an entry may have none); the id inside it is not.
    notNullable(deref(view.properties.workType).properties.id);
    // The deal a meeting counts for already withholds its id by being another shape (`hidden` has none): the variant with an id keeps it required.
    const linkedVisible = deref(variant("meeting").properties.deal).anyOf.map(deref).find((candidate: Schema) => candidate.properties.id !== undefined);
    expect(linkedVisible).toBeDefined();
    expect(linkedVisible.required).toContain("id");
    notNullable(linkedVisible.properties.id);
  });

  it("is what a hidden deal's list answer carries on the wire: `on.id` is JSON null, not a missing member", async () => {
    // A refusal an earlier file cached for this persona (30 s, per process) must not stand in for the grant below.
    __resetOversightCacheForTests();
    hosts.auth.grant(PERSONAS.holder.sub, "time-entry", "read-all");
    hosts.crm.setDeal("deal-secret", { label: "Acquisition of ACME", involved: [PERSONAS.bob.sub] });
    hosts.crm.setReader(PERSONAS.holder.sub, false);
    await makeDealEntry("deal-secret", { userId: PERSONAS.bob.sub, day: "2026-11-05" });

    const res = await call("GET", "/time-entries?from=2026-11-01&to=2026-11-30&whose=all", { as: "holder" });

    expect(res.status).toBe(200);
    expect(res.json.items[0].on).toEqual({ type: "deal", id: null, label: null, href: null, visibility: "hidden" });
    expect("id" in res.json.items[0].on).toBe(true);
  });
});

describe("the POST body is strict (AC-1.6, AC-1.8): what is not a member is refused, never ignored", () => {
  const post = () => bodyOf("POST /time-entries");

  it("is a closed object with exactly the three required members, and so is every target variant", () => {
    expect(post().additionalProperties).toBe(false);
    expect([...post().required].sort()).toEqual(["day", "minutes", "on"]);
    expect(Object.keys(post().properties).sort()).toEqual(["activityId", "day", "minutes", "note", "on", "workTypeId"]);
    for (const variant of post().properties.on.oneOf) expect(variant.additionalProperties).toBe(false);
    expect(post().properties.on.oneOf).toHaveLength(4);
  });

  it("carries no author, no start and no end, in the body or in any target", () => {
    const names = new Set([...walk(post())].flatMap(({ path }) => (path.length > 0 ? [path[path.length - 1]!] : [])));
    for (const forbidden of ["userId", "person", "author", "start", "end", "startTime", "endTime", "startsAt", "endsAt", "createdAt", "updatedAt"]) expect(names.has(forbidden)).toBe(false);
  });

  it("is as strict for PATCH, where every member is optional", () => {
    const patch = bodyOf("PATCH /time-entries/:id");
    expect(patch.additionalProperties).toBe(false);
    expect(patch.required).toBeUndefined();
    expect(Object.keys(patch.properties).sort()).toEqual(Object.keys(post().properties).sort());
    for (const variant of patch.properties.on.oneOf) expect(variant.additionalProperties).toBe(false);
  });

  const EXTRAS: Array<[string, unknown]> = [
    ["userId", "user-bob"],
    ["start", "09:00"],
    ["end", "10:30"],
    ["startTime", "2026-11-05T09:00:00Z"],
    ["endTime", "2026-11-05T10:30:00Z"],
    ["id", "cmhx0p3v10000nobody0000000"],
    ["createdAt", "2026-01-01T00:00:00Z"],
    ["person", { id: "user-bob" }],
  ];

  for (const [key, value] of EXTRAS) {
    it(`refuses a "${key}" member on POST and on PATCH, and nothing is written`, async () => {
      const own = await makeNoEntityEntry(SEED.categories.training, { userId: PERSONAS.alice.sub, day: "2026-11-05" });
      const before = JSON.stringify(await db.timeEntry.findMany({ orderBy: { id: "asc" } }));

      const created = await call("POST", "/time-entries", { as: "alice", body: { day: "2026-11-05", minutes: 60, on: { type: "none", categoryId: SEED.categories.training }, [key]: value } });
      expect({ key, status: created.status, code: created.json?.code }).toEqual({ key, status: 400, code: "invalid_request" });

      const changed = await call("PATCH", `/time-entries/${own.id}`, { as: "alice", body: { minutes: 90, [key]: value } });
      expect({ key, status: changed.status, code: changed.json?.code }).toEqual({ key, status: 400, code: "invalid_request" });

      expect(JSON.stringify(await db.timeEntry.findMany({ orderBy: { id: "asc" } }))).toBe(before);
    });
  }

  it("refuses an unknown member inside `on` too", async () => {
    const res = await call("POST", "/time-entries", { as: "alice", body: { day: "2026-11-05", minutes: 60, on: { type: "none", categoryId: SEED.categories.training, start: "09:00" } } });
    expect(res.status).toBe(400);
    expect(await db.timeEntry.count()).toBe(0);
  });
});

// ─── AC-3.2: nobody deletes a category or a work type ────────────────────────

describe("no DELETE exists on the lists (AC-3.2)", () => {
  const LISTS = (path: string) => /^\/(time-lists|time-categories|work-types)(\/|$)/.test(path);

  it("documents no delete operation on a list path", () => {
    expect(operations.filter(({ path, method }) => LISTS(path) && method === "DELETE").map(({ key }) => key)).toEqual([]);
    expect(operations.filter(({ path }) => LISTS(path)).map(({ key }) => key).sort()).toEqual(
      ["GET /time-lists", "PATCH /time-categories/:id", "PATCH /work-types/:id", "POST /time-categories", "POST /work-types"].sort(),
    );
  });

  it("mounts no delete route on a list path either: the document is not hiding one", () => {
    expect(app.routes.filter(({ path, method }) => LISTS(path) && (method === "DELETE" || method === "ALL")).map(({ method, path }) => `${method} ${path}`)).toEqual([]);
  });

  it("documents DELETE only on an entry, which the person who recorded it may delete", () => {
    expect(operations.filter(({ method }) => method === "DELETE").map(({ key }) => key)).toEqual(["DELETE /time-entries/:id"]);
  });
});

// ─── The bounds clients rely on, as the plan states them ─────────────────────

describe("every id the API receives carries the id rule's bounds: minLength 1, maxLength 64 (plan § Entries)", () => {
  const bounded = (schema: Schema) => ({ minLength: schema.minLength, maxLength: schema.maxLength });
  const ID_BOUNDS = { minLength: 1, maxLength: 64 };

  it("body ids of POST and PATCH /time-entries: on.id (project, deal, meeting), on.categoryId, workTypeId, activityId", () => {
    for (const key of ["POST /time-entries", "PATCH /time-entries/:id"]) {
      expect(propertyPaths(bodyOf(key), isIdName)).toEqual(["activityId", "on.categoryId", "on.id", "workTypeId"]);
      for (const { path, schema } of walk(bodyOf(key))) {
        if (path.length > 0 && isIdName(path[path.length - 1]!)) expect({ key, path: path.join("."), ...bounded(schema) }).toEqual({ key, path: path.join("."), ...ID_BOUNDS });
      }
      // Three of the four targets carry an `on.id`: the bound is on each, not on the first.
      const ons = bodyOf(key).properties.on.oneOf.flatMap((variant: Schema) => (variant.properties.id ? [variant.properties.id] : []));
      expect(ons).toHaveLength(3);
    }
  });

  it("the path {id} of every entry and list route: PATCH /time-entries, DELETE /time-entries, PATCH /time-categories, PATCH /work-types", () => {
    const pathIds = operations.flatMap(({ key, op }) =>
      (op.parameters ?? []).filter((candidate: Schema) => candidate.in === "path").map((candidate: Schema) => ({ key, name: candidate.name, ...bounded(candidate.schema) })),
    );
    expect(pathIds.map(({ key }) => key).sort()).toEqual(["DELETE /time-entries/:id", "PATCH /time-categories/:id", "PATCH /time-entries/:id", "PATCH /work-types/:id"]);
    for (const found of pathIds) expect(found).toEqual({ key: found.key, name: "id", ...ID_BOUNDS });
  });

  it("the six filter ids of the list and of the totals: userId, projectId, dealId, meetingId, categoryId, workTypeId", () => {
    for (const key of ["GET /time-entries", "GET /time-entries/totals"]) {
      for (const name of ["userId", "projectId", "dealId", "meetingId", "categoryId", "workTypeId"]) {
        expect({ key, name, ...bounded(parameter(key, name).schema) }).toEqual({ key, name, ...ID_BOUNDS });
      }
      // No other id-shaped query member escapes the rule.
      const idNames = parametersOf(key).filter((candidate) => candidate.in === "query" && isIdName(candidate.name)).map((candidate) => candidate.name);
      expect(idNames.sort()).toEqual(["categoryId", "dealId", "meetingId", "projectId", "userId", "workTypeId"]);
    }
  });

  it("is what the app enforces: 65 characters is a 400 naming the member, 64 is past the shape check", async () => {
    const TOO_LONG = "x".repeat(65);
    const patch = await call("PATCH", `/time-entries/${TOO_LONG}`, { as: "alice", body: { minutes: 90 } });
    expect(patch.json).toMatchObject({ status: 400, code: "invalid_request", field: "id" });
    expect((await call("PATCH", `/time-entries/${SIXTY_FOUR}`, { as: "alice", body: { minutes: 90 } })).status).toBe(404);
    expect((await call("DELETE", `/time-entries/${TOO_LONG}`, { as: "alice" })).status).toBe(400);

    const body = (categoryId: string) => ({ day: "2026-11-05", minutes: 60, on: { type: "none", categoryId } });
    expect((await call("POST", "/time-entries", { as: "alice", body: body(TOO_LONG) })).json).toMatchObject({ status: 400, field: "on.categoryId" });
    // 64 passes the shape and meets a RULE (no such category), which is a 422, not a 400.
    expect((await call("POST", "/time-entries", { as: "alice", body: body(SIXTY_FOUR) })).json).toMatchObject({ status: 422, code: "category_not_found" });

    for (const name of ["userId", "projectId", "dealId", "meetingId", "categoryId", "workTypeId"]) {
      const res = await call("GET", `/time-entries?from=2026-11-01&to=2026-11-30&${name}=${TOO_LONG}${name === "userId" ? "&whose=all" : ""}`, { as: "alice" });
      expect({ name, status: res.status, field: res.json?.field }).toEqual({ name, status: 400, field: name });
    }
  });
});

describe("the other bounds are in the document, not only in the code", () => {
  it("a note is at most 1000 characters (plan: counted in code points, so the document says maxLength 1000)", () => {
    for (const key of ["POST /time-entries", "PATCH /time-entries/:id"]) {
      expect({ key, maxLength: bodyOf(key).properties.note.maxLength }).toEqual({ key, maxLength: 1000 });
      expect(bodyOf(key).properties.note.nullable).toBe(true);
    }
  });

  it("the name of a category or a work type is 1..80 characters, on every route that writes one", () => {
    for (const key of ["POST /time-categories", "PATCH /time-categories/:id", "POST /work-types", "PATCH /work-types/:id"]) {
      const { minLength, maxLength } = bodyOf(key).properties.name;
      expect({ key, minLength, maxLength }).toEqual({ key, minLength: 1, maxLength: 80 });
    }
  });

  it("the list bodies are closed too: an unknown member, `list` on a PATCH included, is refused", () => {
    for (const key of ["POST /time-categories", "PATCH /time-categories/:id", "POST /work-types", "PATCH /work-types/:id"]) expect(bodyOf(key).additionalProperties).toBe(false);
    expect(Object.keys(bodyOf("PATCH /work-types/:id").properties)).not.toContain("list");
  });

  it("the cursor is at most 200 characters (plan amendment 3, § The cursor)", () => {
    expect(parameter("GET /time-entries", "cursor").schema.maxLength).toBe(200);
  });

  it("the page size is 1..500, and the period's days are YYYY-MM-DD", () => {
    const limit = parameter("GET /time-entries", "limit").schema;
    expect({ minimum: limit.minimum, maximum: limit.maximum }).toEqual({ minimum: 1, maximum: 500 });
    for (const key of ["GET /time-entries", "GET /time-entries/totals"]) {
      for (const name of ["from", "to"]) {
        const found = parameter(key, name);
        expect({ key, name, required: found.required, pattern: found.schema.pattern }).toEqual({ key, name, required: true, pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
      }
    }
  });

  it("the totals take no cursor and no limit: they are complete, never paged", () => {
    const names = parametersOf("GET /time-entries/totals").map((candidate) => candidate.name);
    expect(names).not.toContain("cursor");
    expect(names).not.toContain("limit");
    expect(names).toContain("groupBy");
  });
});
