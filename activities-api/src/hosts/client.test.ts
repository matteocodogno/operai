/**
 * The resolve client (specs/20261110-activities T3; AC-8.1, AC-8.2, AC-8.3; plan.md § Host contract): the one
 * HTTP adapter to a host. These tests run it against the scriptable test hosts, over real HTTP.
 *
 * Rules pinned here: the caller's Authorization is forwarded verbatim; 25 ids per call; a 2 s
 * timeout and `redirect:"error"`; only a 200 is an answer; `reader:false` alone decides; an
 * answer is complete (one item per asked id) only when `reader` is true; every defect is
 * `unavailable`, never a throw and never a guess.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { startTestHosts, bearerFor, type TestHosts } from "../test-support/hosts";
import { resolve, RESOLVE_BATCH_SIZE, RESOLVE_TIMEOUT_MS } from "./client";
import { buildRegistry, type ActivityHost, type ResolveResult } from "./registry";

let hosts: TestHosts;
beforeAll(() => {
  hosts = startTestHosts();
});
afterAll(() => hosts.stop());
afterEach(() => hosts.reset());

const crm = (): ActivityHost => hosts.registry.get("crm", "company")!;
const projects = (): ActivityHost => hosts.registry.get("projects", "project")!;
const ALICE = bearerFor("user-alice");

const open = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  state: "open",
  writable: true,
  label: `Label ${id}`,
  href: `/crm/companies/${id}`,
  may: { write: true, manage: true },
  ...extra,
});

function ok(result: ResolveResult) {
  if (result.state !== "ok") throw new Error(`expected ok, got ${result.state}`);
  return result;
}

describe("the request", () => {
  it("POSTs to the host's resolve endpoint with the caller's Authorization, verbatim", async () => {
    hosts.crm.setEntity("c1", { label: "Acme SA", href: "/crm/companies/c1" });
    const result = await resolve(crm(), ALICE, { ids: ["c1"] });
    expect(result.state).toBe("ok");
    expect(hosts.crm.resolves).toHaveLength(1);
    expect(hosts.crm.resolves[0]!.authorization).toBe(ALICE);
    expect(hosts.crm.resolves[0]!.body).toEqual({ entityType: "company", ids: ["c1"] });
  });

  it("asks projects with entityType `project` and never sends it `related`", async () => {
    hosts.projects.setEntity("p1", { label: "Website", href: "/projects/p1" });
    await resolve(projects(), ALICE, { ids: ["p1"], related: { contact: ["k1"], deal: ["d1"] } });
    expect(hosts.projects.resolves[0]!.body).toEqual({ entityType: "project", ids: ["p1"] });
  });

  it("sends crm only the related types it asked for, and not an empty list", async () => {
    await resolve(crm(), ALICE, { ids: ["c1"], related: { contact: ["k1"], deal: [] } });
    expect(hosts.crm.resolves[0]!.body).toEqual({ entityType: "company", ids: ["c1"], related: { contact: ["k1"] } });
    await resolve(crm(), ALICE, { ids: ["c1"], related: { contact: [], deal: [] } });
    expect(hosts.crm.resolves[1]!.body).toEqual({ entityType: "company", ids: ["c1"] });
  });

  it("asks each distinct id once", async () => {
    await resolve(crm(), ALICE, { ids: ["c1", "c2", "c1"] });
    expect(hosts.crm.resolves[0]!.body.ids).toEqual(["c1", "c2"]);
  });

  it("asks `ids: []` as one call, the question 'may I read at all?'", async () => {
    expect(await resolve(crm(), ALICE, { ids: [] })).toEqual({ state: "ok", entities: new Map(), related: [], salesTeam: false });
    expect(hosts.crm.resolves).toHaveLength(1);
    expect(hosts.crm.resolves[0]!.body.ids).toEqual([]);

    hosts.crm.setReader("*", false);
    expect(await resolve(crm(), ALICE, { ids: [] })).toEqual({ state: "not_reader" });
  });

  it("uses a 2 s timeout and refuses redirects (the token must not travel elsewhere)", async () => {
    expect(RESOLVE_TIMEOUT_MS).toBe(2_000);
    const calls: Array<RequestInit | undefined> = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      calls.push(init);
      return Response.json({ reader: true, items: [] });
    }) as unknown as typeof fetch);
    try {
      await resolve(crm(), ALICE, { ids: [] });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe("error");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.method).toBe("POST");
  });

  it("does not follow a redirect: unavailable, and the target never sees the token", async () => {
    hosts.crm.mode = { redirect: true };
    expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "unavailable" });
    expect(hosts.elsewhere).toEqual([]);
  });
});

describe("batching", () => {
  it("splits more than 25 ids into calls of at most 25, in order, and merges the answers", async () => {
    expect(RESOLVE_BATCH_SIZE).toBe(25);
    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);
    for (const id of ids) hosts.crm.setEntity(id, { label: id, href: `/crm/companies/${id}` });
    const result = ok(await resolve(crm(), ALICE, { ids }));
    expect(hosts.crm.resolves.map((r) => r.body.ids.length)).toEqual([25, 25, 10]);
    expect(hosts.crm.resolves.flatMap((r) => r.body.ids)).toEqual(ids);
    expect(result.entities.size).toBe(60);
    expect([...result.entities.keys()]).toEqual(ids);
  });

  it("sends exactly 25 ids in one call", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `c${i}`);
    ok(await resolve(crm(), ALICE, { ids }));
    expect(hosts.crm.resolves).toHaveLength(1);
  });

  it("splits related ids into lists of at most 100 and merges what comes back", async () => {
    hosts.crm.setEntity("c1", { label: "Acme", href: "/crm/companies/c1" });
    const contacts = Array.from({ length: 250 }, (_, i) => `k${i}`);
    for (const id of contacts) hosts.crm.setRelated({ type: "contact", id, parentId: "c1", label: id, href: `/crm/contacts/${id}` });
    const result = ok(await resolve(crm(), ALICE, { ids: ["c1"], related: { contact: contacts } }));
    expect(hosts.crm.resolves.map((r) => r.body.related?.["contact"]?.length)).toEqual([100, 100, 50]);
    expect(result.related).toHaveLength(250);
    expect(new Set(result.related.map((r) => r.id)).size).toBe(250);
  });

  it("is unavailable when any batch is, and a not-reader in any batch decides", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
    // The scripted answer covers the first batch only: the second is incomplete.
    hosts.crm.mode = { body: { reader: true, items: ids.slice(0, 25).map((id) => open(id)) } };
    expect(await resolve(crm(), ALICE, { ids })).toEqual({ state: "unavailable" });

    hosts.crm.mode = { body: { reader: false } };
    expect(await resolve(crm(), ALICE, { ids })).toEqual({ state: "not_reader" });
  });
});

describe("an answer", () => {
  it("maps an open entity, with its label, href, may and writable", async () => {
    hosts.crm.setEntity("c1", { label: "Acme SA", href: "/crm/companies/c1", may: { write: true, manage: false } });
    const result = ok(await resolve(crm(), ALICE, { ids: ["c1"] }));
    expect(result.entities.get("c1")).toEqual({
      state: "open",
      writable: true,
      label: "Acme SA",
      href: "/crm/companies/c1",
      may: { write: true, manage: false },
      assignees: null,
    });
  });

  it("maps an unknown id to `missing`", async () => {
    const result = ok(await resolve(crm(), ALICE, { ids: ["nope"] }));
    expect(result.entities.get("nope")).toEqual({ state: "missing" });
  });

  it("answers per caller: the host sees the forwarded token", async () => {
    hosts.projects.setEntity("p1", {
      label: "Website",
      href: "/projects/p1",
      may: { write: false, manage: false },
      mayFor: { "user-bob": { write: true, manage: true } },
    });
    const asAlice = ok(await resolve(projects(), ALICE, { ids: ["p1"] }));
    const asBob = ok(await resolve(projects(), bearerFor("user-bob"), { ids: ["p1"] }));
    expect(asAlice.entities.get("p1")).toMatchObject({ may: { write: false, manage: false } });
    expect(asBob.entities.get("p1")).toMatchObject({ may: { write: true, manage: true } });
  });

  it("reads `writable:false` and the assignees of a projects entity", async () => {
    hosts.projects.setEntity("p1", { label: "Old", href: "/projects/p1", writable: false, assignees: ["u1", "u2"] });
    const result = ok(await resolve(projects(), ALICE, { ids: ["p1"] }));
    expect(result.entities.get("p1")).toMatchObject({ state: "open", writable: false, assignees: ["u1", "u2"] });
  });

  it("reads assignees only from a host that lists them: crm's are null even if sent", async () => {
    hosts.crm.mode = { body: { reader: true, items: [open("c1", { assignees: ["u1"] })] } };
    const result = ok(await resolve(crm(), ALICE, { ids: ["c1"] }));
    expect(result.entities.get("c1")).toMatchObject({ assignees: null });
  });

  it("ignores an item for an id it did not ask about, and the second item for one it did", async () => {
    hosts.crm.mode = {
      body: { reader: true, items: [open("intruder"), open("c1", { label: "first" }), open("c1", { label: "second" })] },
    };
    const result = ok(await resolve(crm(), ALICE, { ids: ["c1"] }));
    expect([...result.entities.keys()]).toEqual(["c1"]);
    expect(result.entities.get("c1")).toMatchObject({ label: "first" });
  });

  it("shortens a label longer than 200 characters", async () => {
    hosts.crm.setEntity("c1", { label: "x".repeat(500), href: "/crm/companies/c1" });
    const result = ok(await resolve(crm(), ALICE, { ids: ["c1"] }));
    const entity = result.entities.get("c1");
    expect(entity?.state === "open" && entity.label.length).toBe(200);
  });
});

describe("related contacts and deals", () => {
  it("returns the ones the host found under the asked companies", async () => {
    hosts.crm.setEntity("c1", { label: "Acme", href: "/crm/companies/c1" });
    hosts.crm.setRelated({ type: "contact", id: "k1", parentId: "c1", label: "Ada Rossi", href: "/crm/contacts/k1" });
    hosts.crm.setRelated({ type: "deal", id: "d1", parentId: "c1", label: "Website", href: "/crm/deals/d1" });
    const result = ok(await resolve(crm(), ALICE, { ids: ["c1"], related: { contact: ["k1"], deal: ["d1"] } }));
    expect(result.related).toEqual([
      { type: "contact", id: "k1", parentId: "c1", label: "Ada Rossi", href: "/crm/contacts/k1" },
      { type: "deal", id: "d1", parentId: "c1", label: "Website", href: "/crm/deals/d1" },
    ]);
  });

  it("omits a related id the host does not find (the caller turns that into contact_not_in_company)", async () => {
    hosts.crm.setEntity("c1", { label: "Acme", href: "/crm/companies/c1" });
    const result = ok(await resolve(crm(), ALICE, { ids: ["c1"], related: { contact: ["k-gone"] } }));
    expect(result.related).toEqual([]);
  });

  it("treats an absent `related` as empty", async () => {
    hosts.crm.setEntity("c1", { label: "Acme", href: "/crm/companies/c1" });
    hosts.crm.mode = { body: { reader: true, items: [open("c1")] } };
    expect(ok(await resolve(crm(), ALICE, { ids: ["c1"] })).related).toEqual([]);
  });

  it("drops related items it did not ask for, of another type, or under a company it did not ask about", async () => {
    const mk = (over: Record<string, unknown>) => ({ type: "contact", id: "k1", parentId: "c1", label: "Ada", href: "/crm/contacts/k1", ...over });
    hosts.crm.mode = {
      body: {
        reader: true,
        items: [open("c1")],
        related: [mk({}), mk({ id: "k-unasked" }), mk({ type: "deal" }), mk({ parentId: "c-other" })],
      },
    };
    const result = ok(await resolve(crm(), ALICE, { ids: ["c1"], related: { contact: ["k1"] } }));
    expect(result.related.map((r) => `${r.type}/${r.id}/${r.parentId}`)).toEqual(["contact/k1/c1"]);
  });

  it("ignores whatever `related` a projects host sends", async () => {
    hosts.projects.mode = {
      body: {
        reader: true,
        items: [{ id: "p1", state: "open", writable: true, label: "W", href: "/projects/p1", may: { write: true, manage: true }, assignees: [] }],
        related: [{ type: "contact", id: "k1", parentId: "p1", label: "x", href: "/crm/contacts/k1" }],
      },
    };
    expect(ok(await resolve(projects(), ALICE, { ids: ["p1"], related: { contact: ["k1"] } })).related).toEqual([]);
  });
});

describe("a caller who may not read (reader:false alone decides, AC-8.3)", () => {
  it("crm's shape: `items: []`", async () => {
    hosts.crm.setEntity("c1", { label: "Acme", href: "/crm/companies/c1" });
    hosts.crm.setReader("user-alice", false);
    expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "not_reader" });
  });

  it("projects' shape: every id `missing`", async () => {
    hosts.projects.setEntity("p1", { label: "Website", href: "/projects/p1" });
    hosts.projects.setReader("user-alice", false);
    expect(await resolve(projects(), ALICE, { ids: ["p1", "p2"] })).toEqual({ state: "not_reader" });
  });

  it("is the same answer in both shapes, and for a bare `{reader:false}`", async () => {
    hosts.crm.setReader("*", false);
    hosts.projects.setReader("*", false);
    const a = await resolve(crm(), ALICE, { ids: ["x"] });
    const b = await resolve(projects(), ALICE, { ids: ["x"] });
    hosts.crm.mode = { body: { reader: false } };
    const c = await resolve(crm(), ALICE, { ids: ["x"] });
    expect([a, b, c]).toEqual([{ state: "not_reader" }, { state: "not_reader" }, { state: "not_reader" }]);
  });

  it("does not check the items or related of a non-reader, however odd (never host_unavailable)", async () => {
    hosts.crm.mode = { body: { reader: false, items: [{ id: 7 }], related: "garbage" } };
    expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "not_reader" });
    hosts.crm.mode = { body: { reader: false, items: [open("c1")] } };
    expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "not_reader" });
  });

  it("lets a reader and a non-reader share one host", async () => {
    hosts.crm.setEntity("c1", { label: "Acme", href: "/crm/companies/c1" });
    hosts.crm.setReader("user-bob", false);
    expect((await resolve(crm(), ALICE, { ids: ["c1"] })).state).toBe("ok");
    expect(await resolve(crm(), bearerFor("user-bob"), { ids: ["c1"] })).toEqual({ state: "not_reader" });
  });
});

describe("unavailable (AC-8.2): only a 200 is an answer, every defect fails closed", () => {
  it.each([400, 401, 403, 404, 422, 429, 500, 502, 503, 504])("a host status of %i", async (status) => {
    hosts.crm.setEntity("c1", { label: "Acme", href: "/crm/companies/c1" });
    hosts.crm.mode = { status };
    expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "unavailable" });
    hosts.projects.mode = { status };
    expect(await resolve(projects(), ALICE, { ids: ["p1"] })).toEqual({ state: "unavailable" });
  });

  it("other 2xx statuses are not an answer either", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ reader: true, items: [] }), { status: 203 })) as unknown as typeof fetch);
    try {
      expect(await resolve(crm(), ALICE, { ids: [] })).toEqual({ state: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("a timeout", async () => {
    hosts.crm.mode = { delayMs: 400 };
    const started = Date.now();
    expect(await resolve(crm(), ALICE, { ids: ["c1"] }, { timeoutMs: 100 })).toEqual({ state: "unavailable" });
    expect(Date.now() - started).toBeLessThan(380);
  });

  it("a transport error (nobody listening)", async () => {
    const dead = buildRegistry({ crmApiUrl: "http://127.0.0.1:1", projectsApiUrl: "http://127.0.0.1:2" });
    expect(await resolve(dead.get("crm", "company")!, ALICE, { ids: ["c1"] })).toEqual({ state: "unavailable" });
  });

  it("a body that is not JSON", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch);
    try {
      expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("a body that breaks the contract", async () => {
    hosts.crm.mode = { malformed: true };
    expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "unavailable" });
  });

  it.each([
    ["no `reader`", { items: [] }],
    ["a non-boolean `reader`", { reader: "true", items: [] }],
    ["a reader with no `items`", { reader: true }],
    ["`items` that is not a list", { reader: true, items: {} }],
    ["an item with no id", { reader: true, items: [{ state: "missing" }] }],
    ["an item with an unknown state", { reader: true, items: [{ id: "c1", state: "closed" }] }],
    ["an open item with no label", { reader: true, items: [open("c1", { label: undefined })] }],
    ["an open item with an empty label", { reader: true, items: [open("c1", { label: "" })] }],
    ["an open item with no href", { reader: true, items: [open("c1", { href: undefined })] }],
    ["an open item with no `may`", { reader: true, items: [open("c1", { may: undefined })] }],
    ["an open item with a non-boolean `may` flag", { reader: true, items: [open("c1", { may: { write: "yes", manage: true } })] }],
    ["an open item with no `writable`", { reader: true, items: [open("c1", { writable: undefined })] }],
    ["an absolute href", { reader: true, items: [open("c1", { href: "https://evil.example/x" })] }],
    ["a protocol-relative href", { reader: true, items: [open("c1", { href: "//evil.example/x" })] }],
    ["a backslash href", { reader: true, items: [open("c1", { href: "/\\evil.example" })] }],
    ["a related item of an unknown type", { reader: true, items: [open("c1")], related: [{ type: "company", id: "k1", parentId: "c1", label: "x", href: "/x" }] }],
    ["a related item with an off-site href", { reader: true, items: [open("c1")], related: [{ type: "contact", id: "k1", parentId: "c1", label: "x", href: "http://x" }] }],
    ["related that is not a list", { reader: true, items: [open("c1")], related: {} }],
  ])("%s", async (_name, body) => {
    hosts.crm.mode = { body };
    expect(await resolve(crm(), ALICE, { ids: ["c1"], related: { contact: ["k1"] } })).toEqual({ state: "unavailable" });
  });

  it("a projects item with no `assignees` (the host that lists them must state them)", async () => {
    hosts.projects.mode = {
      body: { reader: true, items: [{ id: "p1", state: "open", writable: true, label: "W", href: "/projects/p1", may: { write: true, manage: true } }] },
    };
    expect(await resolve(projects(), ALICE, { ids: ["p1"] })).toEqual({ state: "unavailable" });
  });

  it("a team-only person in a projects item's `assignees` is an assignee like any other (specs/20261126-teams AC-5.2)", async () => {
    hosts.projects.setEntity("p1", { label: "W", href: "/projects/p1", assignees: ["user-pm", "user-team-only", "user-pm"] });
    const result = ok(await resolve(projects(), ALICE, { ids: ["p1"] }));
    expect(result.entities.get("p1")).toMatchObject({ state: "open", assignees: ["user-pm", "user-team-only"] });
  });

  it("`assignees: null` from a projects item is `unavailable`, kept apart from a list and from absent (AC-5.4)", async () => {
    hosts.projects.mode = {
      body: {
        reader: true,
        items: [{ id: "p1", state: "open", writable: true, label: "W", href: "/projects/p1", may: { write: true, manage: true }, assignees: null }],
      },
    };
    const result = ok(await resolve(projects(), ALICE, { ids: ["p1"] }));
    expect(result.entities.get("p1")).toMatchObject({ state: "open", label: "W", assignees: "unavailable" });
  });

  it("one project's `null` does not spoil the others in the same batch", async () => {
    const item = (id: string, assignees: unknown) => ({
      id, state: "open", writable: true, label: id, href: `/projects/${id}`, may: { write: true, manage: true }, assignees,
    });
    hosts.projects.mode = { body: { reader: true, items: [item("p1", null), item("p2", ["u1"])] } };
    const result = ok(await resolve(projects(), ALICE, { ids: ["p1", "p2"] }));
    expect(result.entities.get("p1")).toMatchObject({ assignees: "unavailable" });
    expect(result.entities.get("p2")).toMatchObject({ assignees: ["u1"] });
  });

  it("`assignees: null` from a host that does not list them stays null (not unavailable)", async () => {
    hosts.crm.mode = { body: { reader: true, items: [open("c1", { assignees: null })] } };
    expect(ok(await resolve(crm(), ALICE, { ids: ["c1"] })).entities.get("c1")).toMatchObject({ assignees: null });
  });

  it("an incomplete answer from a reader: an asked id left unanswered", async () => {
    hosts.crm.mode = { body: { reader: true, items: [open("c1")] } };
    expect(await resolve(crm(), ALICE, { ids: ["c1", "c2"] })).toEqual({ state: "unavailable" });
    hosts.crm.mode = { body: { reader: true, items: [] } };
    expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "unavailable" });
  });

  it("never throws", async () => {
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new TypeError("boom");
    }) as unknown as typeof fetch);
    try {
      expect(await resolve(crm(), ALICE, { ids: ["c1"] })).toEqual({ state: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("logs the host and a reason, never an id, a label or the token", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      hosts.crm.mode = { status: 500 };
      await resolve(crm(), ALICE, { ids: ["company-id-secret"] });
      hosts.crm.mode = { body: { reader: true, items: [] } };
      await resolve(crm(), ALICE, { ids: ["company-id-secret"] });
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("crm/company");
      expect(logged).toContain("http_500");
      expect(logged).toContain("incomplete");
      expect(logged).not.toContain("company-id-secret");
      expect(logged).not.toContain(ALICE.slice(7));
    } finally {
      warn.mockRestore();
    }
  });
});
