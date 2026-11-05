import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolveResponse } from "../authz/resolveClient";

// AC-8.2 (personal), AC-8.3 (shared, template:manage), AC-8.4 (duplicate), AC-8.7 (existing summaries
// unchanged), G8 (PATCH with If-Match). Real app, real Postgres (`meetings_test`).

const harness = setupTestAuth();
await harness.init();
const { app } = await import("../index");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const grants = (...pairs: [string, string][]): ResolveResponse => ({
  sub: "x",
  epoch: 0,
  permissions: pairs.map(([resource, action]) => ({ resource, action, conditions: null })),
  entity: null,
  jobTitle: null,
});
const PERMISSIONS: Record<string, ResolveResponse> = {
  alice: grants(["meetings", "access"]),
  bob: grants(["meetings", "access"]),
  admin: grants(["meetings", "access"], ["template", "manage"]),
  outsider: grants(),
};

const tokens = new Map<string, string>();
async function call(method: string, path: string, opts: { as?: string | null; body?: unknown; ifMatch?: string | number; headers?: Record<string, string> } = {}) {
  const as = opts.as === undefined ? "alice" : opts.as;
  if (as && !tokens.has(as)) tokens.set(as, await harness.signToken({ sub: as, email: `${as}@x.test` }));
  const headers: Record<string, string> = { ...(as ? { Authorization: `Bearer ${tokens.get(as)}` } : {}), ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.ifMatch !== undefined) headers["If-Match"] = typeof opts.ifMatch === "number" ? `"${opts.ifMatch}"` : opts.ifMatch;
  const res = await app.request(path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get("ETag"), text, json: text ? (JSON.parse(text) as any) : null };
}

const SECTIONS = [{ heading: "Decisions", instruction: "List each decision." }];
const content = (over: Record<string, unknown> = {}) => ({ scope: "personal", name: "My template", sections: SECTIONS, ...over });
const create = (over: Record<string, unknown> = {}, as = "alice") => call("POST", "/templates", { as, body: content(over) });
const rowOf = (id: string) => db.summaryTemplate.findUnique({ where: { id } });

beforeAll(() => {
  spyOn(console, "error").mockImplementation(() => {});
});
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "summary_template", "meeting" CASCADE');
  __resetAuthzCacheForTests();
  harness.setResolve(async (header) => {
    const token = header.slice("Bearer ".length);
    const who = [...tokens].find(([, t]) => t === token)?.[0] ?? "outsider";
    return PERMISSIONS[who] ?? PERMISSIONS["outsider"]!;
  });
});
afterAll(async () => {
  await db.$disconnect();
});

describe("create (AC-8.2, AC-8.3)", () => {
  it("makes a personal template, owned by the caller, answering 201 with its ETag", async () => {
    const res = await create({ name: "  Weekly sync  ", generalInstructions: "Be brief." });
    expect(res.status).toBe(201);
    expect(res.etag).toBe('"1"');
    expect(res.json).toMatchObject({ source: "personal", name: "Weekly sync", sections: SECTIONS, generalInstructions: "Be brief.", recommended: false, version: 1 });
    const row = await rowOf(res.json.id);
    expect(row).toMatchObject({ scope: "personal", ownerUserId: "alice", createdBy: "alice", updatedBy: "alice", version: 1 });
  });

  it("makes a shared template for a template:manage holder, with no owner", async () => {
    const res = await create({ scope: "shared", name: "Team standard" }, "admin");
    expect(res.status).toBe(201);
    expect(res.json.source).toBe("shared");
    expect(await rowOf(res.json.id)).toMatchObject({ scope: "shared", ownerUserId: null, createdBy: "admin" });
  });

  it("refuses a shared template without template:manage (403) and creates nothing", async () => {
    const res = await create({ scope: "shared" }, "alice");
    expect(res.status).toBe(403);
    expect(await db.summaryTemplate.count()).toBe(0);
  });

  it("401 without a token, 403 without meetings:access", async () => {
    expect((await call("POST", "/templates", { as: null, body: content() })).status).toBe(401);
    expect((await create({}, "outsider")).status).toBe(403);
    expect(await db.summaryTemplate.count()).toBe(0);
  });

  it("answers an omitted generalInstructions as null", async () => {
    expect((await create()).json.generalInstructions).toBeNull();
    expect((await create({ name: "Other", generalInstructions: null })).json.generalInstructions).toBeNull();
  });
});

describe("limits: 80 / 15 / 80 / 500 / 2000 -> 422 just past each", () => {
  const at = (field: string, over: Record<string, unknown>) => async () => {
    const res = await create(over);
    expect(res.status, field).toBe(422);
    expect(res.json.field, field).toBe(field);
    expect(await db.summaryTemplate.count()).toBe(0);
  };
  const sectionsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ heading: `H${i}`, instruction: "" }));

  it("name: 81 characters", at("name", { name: "n".repeat(81) }));
  it("sections: 16", at("sections", { sections: sectionsOf(16) }));
  it("a heading: 81 characters", at("sections.0.heading", { sections: [{ heading: "h".repeat(81), instruction: "" }] }));
  it("an instruction: 501 characters", at("sections.0.instruction", { sections: [{ heading: "H", instruction: "i".repeat(501) }] }));
  it("general instructions: 2001 characters", at("generalInstructions", { generalInstructions: "g".repeat(2001) }));

  it("accepts a section that has only a heading", async () => {
    const res = await create({ sections: [{ heading: "Just a heading" }] });
    expect(res.status).toBe(201);
    expect(res.json.sections).toEqual([{ heading: "Just a heading", instruction: "" }]);
  });

  it("accepts exactly the limits", async () => {
    const res = await create({
      name: "n".repeat(80),
      sections: Array.from({ length: 15 }, (_, i) => ({ heading: String(i).padEnd(80, "h"), instruction: "i".repeat(500) })),
      generalInstructions: "g".repeat(2000),
    });
    expect(res.status).toBe(201);
  });

  it("refuses an empty name, a blank name, no sections and an empty heading", async () => {
    for (const over of [{ name: "" }, { name: "    " }, { sections: [] }, { sections: [{ heading: "", instruction: "x" }] }, { sections: [{ heading: "   ", instruction: "x" }] }]) {
      expect((await create(over)).status, JSON.stringify(over)).toBe(422);
    }
  });

  it("refuses an unknown scope, a missing scope and wrong types", async () => {
    for (const over of [{ scope: "global" }, { scope: undefined }, { name: 5 }, { sections: "x" }, { sections: [{ instruction: "no heading" }] }, { generalInstructions: 5 }]) {
      expect((await create(over)).status, JSON.stringify(over)).toBe(422);
    }
  });
});

describe("names are unique (AC-8.2, AC-8.3)", () => {
  it("409 template_name_taken for a second personal template with the same name, ignoring case", async () => {
    expect((await create({ name: "Weekly" })).status).toBe(201);
    const again = await create({ name: "weekly" });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: "template_name_taken", field: "name" });
    expect(await db.summaryTemplate.count()).toBe(1);
  });

  it("lets two people have a personal template of the same name", async () => {
    expect((await create({ name: "Weekly" }, "alice")).status).toBe(201);
    expect((await create({ name: "Weekly" }, "bob")).status).toBe(201);
  });

  it("409 for a second shared template with the same name, ignoring case, whoever makes it", async () => {
    expect((await create({ scope: "shared", name: "Standard" }, "admin")).status).toBe(201);
    expect((await create({ scope: "shared", name: "STANDARD" }, "admin")).status).toBe(409);
  });

  it("lets a personal and a shared template share a name", async () => {
    expect((await create({ scope: "shared", name: "Standard" }, "admin")).status).toBe(201);
    expect((await create({ name: "Standard" }, "alice")).status).toBe(201);
  });
});

describe("a personal template is private (AC-8.2)", () => {
  it("another user can neither see, change, delete nor copy it: 404 each", async () => {
    const mine = (await create({ name: "Private" })).json;
    expect((await call("GET", "/templates", { as: "bob" })).json.items.map((i: { id: string }) => i.id)).not.toContain(mine.id);
    expect((await call("PATCH", `/templates/${mine.id}`, { as: "bob", ifMatch: 1, body: { name: "Hijacked" } })).status).toBe(404);
    expect((await call("DELETE", `/templates/${mine.id}`, { as: "bob" })).status).toBe(404);
    expect((await call("POST", `/templates/${mine.id}/duplicate`, { as: "bob", body: {} })).status).toBe(404);
    // not even a template manager reaches it
    expect((await call("PATCH", `/templates/${mine.id}`, { as: "admin", ifMatch: 1, body: { name: "Hijacked" } })).status).toBe(404);
    expect((await call("DELETE", `/templates/${mine.id}`, { as: "admin" })).status).toBe(404);
    expect(await rowOf(mine.id)).toMatchObject({ name: "Private", version: 1 });
  });

  it("answers byte-identically for a template that does not exist", async () => {
    const mine = (await create({ name: "Private" })).json;
    const a = await call("PATCH", `/templates/${mine.id}`, { as: "bob", ifMatch: 1, body: { name: "x" } });
    const b = await call("PATCH", "/templates/no-such-id", { as: "bob", ifMatch: 1, body: { name: "x" } });
    expect(a.text.replace(mine.id, "ID")).toBe(b.text.replace("no-such-id", "ID"));
  });
});

describe("update with If-Match (G8, ADR-0038)", () => {
  it("428 precondition_required without If-Match, or with one that is not a plain version", async () => {
    const t = (await create()).json;
    for (const ifMatch of [undefined, "", "1", "W/\"1\"", '"1", "2"', '"abc"', '"-1"', '"1.5"']) {
      const res = await call("PATCH", `/templates/${t.id}`, { body: { name: "New" }, ...(ifMatch !== undefined ? { ifMatch } : {}) });
      expect(res.status, String(ifMatch)).toBe(428);
      expect(res.json.code).toBe("precondition_required");
    }
    expect((await rowOf(t.id))!.name).toBe("My template");
  });

  it("409 version_conflict with the current version when the precondition is stale", async () => {
    const t = (await create()).json;
    expect((await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: "Second" } })).status).toBe(200);
    const stale = await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: "Third" } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "version_conflict", currentVersion: 2 });
    expect((await rowOf(t.id))!.name).toBe("Second");
    // a precondition from the future is stale too
    expect((await call("PATCH", `/templates/${t.id}`, { ifMatch: 9, body: { name: "x" } })).status).toBe(409);
  });

  it("saves, bumps the version and returns the new ETag", async () => {
    const t = (await create()).json;
    const res = await call("PATCH", `/templates/${t.id}`, {
      ifMatch: t.version,
      body: { name: "Renamed", sections: [{ heading: "New", instruction: "Do." }], generalInstructions: "Short." },
    });
    expect(res.status).toBe(200);
    expect(res.etag).toBe('"2"');
    expect(res.json).toMatchObject({ id: t.id, name: "Renamed", sections: [{ heading: "New", instruction: "Do." }], generalInstructions: "Short.", version: 2, source: "personal" });
    expect(await rowOf(t.id)).toMatchObject({ version: 2, updatedBy: "alice", createdBy: "alice", scope: "personal", ownerUserId: "alice" });
  });

  it("changes only what the body names", async () => {
    const t = (await create({ generalInstructions: "Keep." })).json;
    const res = await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: "Only the name" } });
    expect(res.json).toMatchObject({ name: "Only the name", sections: SECTIONS, generalInstructions: "Keep." });
    const cleared = await call("PATCH", `/templates/${t.id}`, { ifMatch: 2, body: { generalInstructions: null } });
    expect(cleared.json.generalInstructions).toBeNull();
  });

  it("cannot change the scope or the owner, whatever the body says", async () => {
    const t = (await create()).json;
    const res = await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: "Same", scope: "shared", ownerUserId: "bob", version: 99, id: "other" } });
    expect(res.status).toBe(200);
    expect(await rowOf(t.id)).toMatchObject({ scope: "personal", ownerUserId: "alice", version: 2, id: t.id });
  });

  it("an empty body changes nothing, not even the version", async () => {
    const t = (await create()).json;
    const res = await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: {} });
    expect(res.status).toBe(200);
    expect(res.json.version).toBe(1);
    expect((await rowOf(t.id))!.version).toBe(1);
  });

  it("holds the same limits as create", async () => {
    const t = (await create()).json;
    expect((await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: "n".repeat(81) } })).status).toBe(422);
    expect((await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { sections: [] } })).status).toBe(422);
    expect((await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { generalInstructions: "g".repeat(2001) } })).status).toBe(422);
    expect((await rowOf(t.id))!.version).toBe(1);
  });

  it("409 template_name_taken when the new name is one of the owner's other templates", async () => {
    await create({ name: "Taken" });
    const t = (await create({ name: "Mine" })).json;
    const res = await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: "TAKEN" } });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("template_name_taken");
    expect((await rowOf(t.id))!.version).toBe(1);
  });

  it("keeping its own name (even in another case) is not a clash", async () => {
    const t = (await create({ name: "Mine" })).json;
    expect((await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: "MINE" } })).status).toBe(200);
  });

  it("lets exactly one of many concurrent edits from the same version win", async () => {
    const t = (await create()).json;
    // Hold the row's lock so every edit reads version 1 and then waits to write: a real overlap, not a lucky one.
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "summary_template" WHERE "id" = ${t.id} FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const racers = Array.from({ length: 10 }, (_, i) => call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: `From ${i}` } }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await holder;
    const results = await Promise.all(racers);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await rowOf(t.id))!.version).toBe(2);
  });
});

describe("shared templates need template:manage (AC-8.3)", () => {
  it("others cannot edit or delete one (403), a manager can", async () => {
    const t = (await create({ scope: "shared", name: "Standard" }, "admin")).json;
    expect((await call("PATCH", `/templates/${t.id}`, { as: "alice", ifMatch: 1, body: { name: "Mine now" } })).status).toBe(403);
    expect((await call("DELETE", `/templates/${t.id}`, { as: "alice" })).status).toBe(403);
    expect(await rowOf(t.id)).toMatchObject({ name: "Standard", version: 1 });

    const edited = await call("PATCH", `/templates/${t.id}`, { as: "admin", ifMatch: 1, body: { name: "Standard v2" } });
    expect(edited.status).toBe(200);
    expect(await rowOf(t.id)).toMatchObject({ name: "Standard v2", updatedBy: "admin" });
    expect((await call("DELETE", `/templates/${t.id}`, { as: "admin" })).status).toBe(204);
  });

  it("a manager who is not the creator can edit a shared template too", async () => {
    const t = (await create({ scope: "shared", name: "Standard" }, "admin")).json;
    harness.setResolve(async () => PERMISSIONS["admin"]!);
    __resetAuthzCacheForTests();
    expect((await call("PATCH", `/templates/${t.id}`, { as: "bob", ifMatch: 1, body: { name: "By bob the manager" } })).status).toBe(200);
  });

  it("usable by every meetings:access holder: they see it in the picker (403 only on writes)", async () => {
    const t = (await create({ scope: "shared", name: "Standard" }, "admin")).json;
    expect((await call("GET", "/templates", { as: "bob" })).json.items.map((i: { id: string }) => i.id)).toContain(t.id);
  });

  it("a shared name clash on edit is 409", async () => {
    await create({ scope: "shared", name: "One" }, "admin");
    const two = (await create({ scope: "shared", name: "Two" }, "admin")).json;
    expect((await call("PATCH", `/templates/${two.id}`, { as: "admin", ifMatch: 1, body: { name: "one" } })).status).toBe(409);
  });
});

describe("built-in templates are read-only (AC-8.1)", () => {
  it("403 builtin_readonly on edit and delete, for everyone, with or without a precondition", async () => {
    for (const as of ["alice", "admin"]) {
      for (const id of ["builtin:minutes", "builtin:sales-discovery"]) {
        const patch = await call("PATCH", `/templates/${id}`, { as, ifMatch: 1, body: { name: "Hacked" } });
        expect(patch.status, `${as} ${id}`).toBe(403);
        expect(patch.json.code).toBe("builtin_readonly");
        const bare = await call("PATCH", `/templates/${id}`, { as, body: { name: "Hacked" } });
        expect(bare.status).toBe(403); // not 428: there is no version to ask for
        const del = await call("DELETE", `/templates/${id}`, { as });
        expect(del.status).toBe(403);
        expect(del.json.code).toBe("builtin_readonly");
      }
    }
    const list = (await call("GET", "/templates")).json.items;
    expect(list.find((i: { id: string }) => i.id === "builtin:minutes").name).toBe("Meeting minutes");
  });

  it("403 for any id in the builtin namespace, even an unknown one", async () => {
    expect((await call("DELETE", "/templates/builtin:nope")).status).toBe(403);
  });
});

describe("delete", () => {
  it("removes the caller's personal template: 204, then it is gone", async () => {
    const t = (await create()).json;
    expect((await call("DELETE", `/templates/${t.id}`)).status).toBe(204);
    expect(await rowOf(t.id)).toBeNull();
    expect((await call("DELETE", `/templates/${t.id}`)).status).toBe(404);
  });

  it("404 for a template that never existed", async () => {
    expect((await call("DELETE", "/templates/nope")).status).toBe(404);
  });

  it("frees the name for a new template", async () => {
    const t = (await create({ name: "Reusable" })).json;
    await call("DELETE", `/templates/${t.id}`);
    expect((await create({ name: "Reusable" })).status).toBe(201);
  });
});

describe("existing summaries are unchanged by an edit or a delete (AC-7.5, AC-8.7)", () => {
  it("leaves a summary's snapshot byte-identical", async () => {
    const t = (await create({ name: "Snap" })).json;
    const meeting = await db.meeting.create({
      data: { title: "m", format: "online", startsAt: new Date(), language: "en", source: "text", creatorUserId: "alice" },
    });
    const snapshot = { source: "personal", templateId: t.id, name: "Snap", sections: SECTIONS, generalInstructions: null };
    const summary = await db.summary.create({
      data: { meetingId: meeting.id, authorUserId: "alice", template: snapshot, language: "en", status: "ready", attemptId: "a1", transcriptVersion: 1 },
    });
    const before = JSON.stringify((await db.summary.findUniqueOrThrow({ where: { id: summary.id } })).template);

    await call("PATCH", `/templates/${t.id}`, { ifMatch: 1, body: { name: "Edited", sections: [{ heading: "Other", instruction: "" }] } });
    expect(JSON.stringify((await db.summary.findUniqueOrThrow({ where: { id: summary.id } })).template)).toBe(before);
    await call("DELETE", `/templates/${t.id}`);
    expect(JSON.stringify((await db.summary.findUniqueOrThrow({ where: { id: summary.id } })).template)).toBe(before);
  });
});

describe("duplicate (AC-8.4)", () => {
  const dup = (id: string, opts: { as?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    call("POST", `/templates/${id}/duplicate`, { as: opts.as ?? "alice", body: opts.body ?? {}, ...(opts.headers ? { headers: opts.headers } : {}) });

  it("copies a built-in into the caller's personal templates, in the asked language", async () => {
    const res = await dup("builtin:sales-discovery", { body: { language: "it" } });
    expect(res.status).toBe(201);
    expect(res.etag).toBe('"1"');
    expect(res.json).toMatchObject({ source: "personal", name: "Chiamata di discovery commerciale (copia)", version: 1, recommended: false });
    expect(res.json.sections[0].heading).toBe("Cliente e contesto");
    expect(await rowOf(res.json.id)).toMatchObject({ scope: "personal", ownerUserId: "alice", createdBy: "alice" });
  });

  it("takes the language from Accept-Language when the body names none, English by default", async () => {
    expect((await dup("builtin:minutes", { headers: { "Accept-Language": "it" } })).json.name).toBe("Verbale della riunione (copia)");
    expect((await dup("builtin:minutes")).json.name).toBe("Meeting minutes (copy)");
  });

  it("copies a shared template, whoever owns it, and the copy is independent of the source", async () => {
    const shared = (await create({ scope: "shared", name: "Standard", sections: [{ heading: "A", instruction: "a" }], generalInstructions: "G" }, "admin")).json;
    const copy = await dup(shared.id, { as: "bob" });
    expect(copy.status).toBe(201);
    expect(copy.json).toMatchObject({ source: "personal", name: "Standard (copy)", sections: [{ heading: "A", instruction: "a" }], generalInstructions: "G" });
    expect(await rowOf(copy.json.id)).toMatchObject({ ownerUserId: "bob", scope: "personal" });
    await call("PATCH", `/templates/${copy.json.id}`, { as: "bob", ifMatch: 1, body: { sections: [{ heading: "Changed", instruction: "" }] } });
    expect((await rowOf(shared.id))!.sections).toEqual([{ heading: "A", instruction: "a" }]);
  });

  it("copies the caller's own personal template too", async () => {
    const mine = (await create({ name: "Mine" })).json;
    expect((await dup(mine.id)).json.name).toBe("Mine (copy)");
  });

  it("finds a free name: (copy), (copy 2), (copy 3)", async () => {
    const names = [];
    for (let i = 0; i < 3; i++) names.push((await dup("builtin:action-items")).json.name);
    expect(names).toEqual(["Action items (copy)", "Action items (copy 2)", "Action items (copy 3)"]);
  });

  it("keeps the copy's name within 80 characters", async () => {
    const long = (await create({ name: "L".repeat(80) })).json;
    const copy = await dup(long.id);
    expect(copy.status).toBe(201);
    expect(copy.json.name.length).toBeLessThanOrEqual(80);
    expect(copy.json.name.endsWith("(copy)")).toBe(true);
  });

  it("422 for a language that is not en or it; 404 for an unknown template", async () => {
    expect((await dup("builtin:minutes", { body: { language: "fr" } })).status).toBe(422);
    expect((await dup("nope")).status).toBe(404);
    expect((await dup("builtin:nope")).status).toBe(404);
  });

  it("accepts no body at all", async () => {
    await call("GET", "/templates"); // makes alice's token
    const res = await app.request("/templates/builtin:minutes/duplicate", { method: "POST", headers: { Authorization: `Bearer ${tokens.get("alice")}` } });
    expect(res.status).toBe(201);
  });

  it("is a capability route: 403 without meetings:access", async () => {
    expect((await dup("builtin:minutes", { as: "outsider" })).status).toBe(403);
  });
});
