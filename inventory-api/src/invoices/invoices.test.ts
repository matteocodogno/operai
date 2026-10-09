/**
 * Invoice files (T21, specs/015-hardware-inventory; AC-10.4 to AC-10.7).
 * Real router + middleware over the harness, real Postgres. Most tests replace
 * the storage layer's network calls (HEAD/DELETE) with an in-memory bucket and
 * keep real request signing; the last block runs mint -> upload -> confirm ->
 * download against the configured bucket (local MinIO) and is skipped, visibly,
 * when it is unreachable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { setupTestAuth } from "../test-support/testAuth";
import type { ResolvedPermission } from "../authz/resolveClient";
import { truncateInventoryTables } from "../test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { db } = await import("../lib/db");
const { handleProblemError } = await import("../lib/problem");
const { invoicesRouter } = await import("./invoices.routes");
const { storage, MAX_INVOICE_BYTES } = await import("../lib/storage");
const { MAX_PENDING_FILES_PER_USER } = await import("./invoices.repo");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { probeBucket, postToPresigned } = await import("./testMinio");
const { eventChanges } = await import("../history/record");

const app = new OpenAPIHono();
app.route("/", invoicesRouter);
app.onError((err, c) => handleProblemError(err, c.req.path) ?? c.json({ error: String(err) }, 500));

const ENTITY: ResolvedPermission["conditions"] = { attributes: [{ key: "entity", match: "user" }] };
const grant = (resource: string, action: string, conditions: ResolvedPermission["conditions"] = ENTITY): ResolvedPermission => ({
  resource,
  action,
  conditions,
});
const MANAGER = [grant("asset", "manage")];
const ACCOUNTANT = [grant("ledger", "manage")];
const UNCONDITIONED_BOTH = [grant("asset", "manage", null), grant("ledger", "manage", null)];

let token: string;
function as(permissions: ResolvedPermission[], entity: string | null) {
  __resetAuthzCacheForTests();
  harness.setResolve(async () => ({ sub: "u", epoch: 1, permissions, entity, jobTitle: null }));
}

// ─── An in-memory bucket (HEAD / DELETE only; signing stays real) ────────────

const bucket = new Map<string, { sizeBytes: number; contentType: string | undefined; etag?: string }>();
let headSpy: ReturnType<typeof spyOn<typeof storage, "headObject">>;
let deleteSpy: ReturnType<typeof spyOn<typeof storage, "deleteObject">>;
const upload = (key: string, sizeBytes: number, contentType: string | undefined = "application/pdf", etag = '"etag-1"') =>
  bucket.set(key, { sizeBytes, contentType, etag });

beforeAll(async () => {
  token = await harness.signToken({ sub: "u-1", email: "u1@welld.ch", permEpoch: 1 });
});
beforeEach(async () => {
  await truncateInventoryTables();
  bucket.clear();
  as(MANAGER, "welld_ch");
  headSpy = spyOn(storage, "headObject").mockImplementation(async (key) => bucket.get(key) ?? null);
  deleteSpy = spyOn(storage, "deleteObject").mockImplementation(async (key) => void bucket.delete(key));
});
afterEach(() => {
  headSpy.mockRestore();
  deleteSpy.mockRestore();
});
afterAll(async () => {
  await truncateInventoryTables();
});

const call = (method: string, path: string, body?: unknown, bearer: string | null = token) =>
  app.request(path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const json = async (res: Response) => (await res.json()) as Record<string, any>;

const mint = (over: Record<string, unknown> = {}) =>
  call("POST", "/invoice-files", {
    entity: "welld_ch",
    invoiceRef: "INV-77",
    fileName: "fattura.pdf",
    contentType: "application/pdf",
    sizeBytes: 1000,
    ...over,
  });
const confirm = (id: string) => call("POST", `/invoice-files/${id}/confirm`);
const link = (id: string, assetIds: string[]) => call("PUT", `/invoice-files/${id}/assets`, { assetIds });
const urlOf = (id: string) => call("GET", `/invoice-files/${id}/url`);

/** Mint + (fake) upload + confirm: a stored file. */
async function storedFile(over: Record<string, unknown> = {}, size = 1000): Promise<{ id: string; key: string }> {
  const res = await mint({ sizeBytes: size, ...over });
  expect(res.status).toBe(201);
  const { id } = await json(res);
  const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
  upload(row.objectKey, size, row.contentType);
  expect((await confirm(id)).status).toBe(200);
  return { id, key: row.objectKey };
}

let seq = 0;
async function seedAsset(over: Record<string, unknown> = {}) {
  seq++;
  return db.asset.create({
    data: {
      entity: "welld_ch",
      currency: "CHF",
      category: "laptop",
      description: `Device ${seq}`,
      purchaseDate: new Date("2026-03-01"),
      purchasePriceCents: 99815,
      status: "in_stock",
      invoiceRef: "INV-77",
      createdByUserId: "seed",
      ...over,
    } as never,
  });
}
const reload = (id: string) => db.asset.findUniqueOrThrow({ where: { id } });
const linkEvents = (assetId: string) =>
  db.assetEvent.findMany({ where: { assetId, action: "invoice_file_linked" }, orderBy: { createdAt: "asc" } });

// ─── Mint ────────────────────────────────────────────────────────────────────

describe("POST /invoice-files (mint)", () => {
  it("creates a pending row and returns a presigned POST pinned to a server-generated key", async () => {
    const res = await mint();
    expect(res.status).toBe(201);
    const body = await json(res);
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id: body["id"] } });
    expect(row).toMatchObject({
      entity: "welld_ch",
      invoiceRef: "INV-77",
      fileName: "fattura.pdf",
      contentType: "application/pdf",
      sizeBytes: 1000,
      uploadStatus: "pending",
      createdByUserId: "u-1",
    });
    expect(row.objectKey).toBe(`inventory/welld_ch/${row.id}/fattura.pdf`);
    expect(body["upload"].fields["key"]).toBe(row.objectKey);
    expect(body["upload"].fields["Content-Type"]).toBe("application/pdf");
    expect(body["upload"].url).toBeString();
    const policy = JSON.parse(Buffer.from(body["upload"].fields["Policy"], "base64").toString());
    expect(JSON.stringify(policy.conditions)).toContain(JSON.stringify(["content-length-range", 1, MAX_INVOICE_BYTES]));
  });

  it("never lets the client's file name pick the key; the stored name is sanitised for display", async () => {
    const res = await mint({ fileName: "../../etc/pass\u0000wd‮.pdf" });
    expect(res.status).toBe(201);
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id: (await json(res))["id"] } });
    expect(row.objectKey).toBe(`inventory/welld_ch/${row.id}/pass_wd_.pdf`);
    expect(row.objectKey).not.toContain("..");
    expect(row.fileName).toBe("passwd.pdf");
  });

  it("a file of another type is 415 and nothing is stored (AC-10.6)", async () => {
    for (const contentType of ["text/plain", "image/gif", "application/pdf; charset=x", "image/svg+xml"]) {
      const res = await mint({ contentType });
      expect(res.status).toBe(415);
    }
    expect(await db.invoiceFile.count()).toBe(0);
  });

  it("a file over 10 MiB is 413 and nothing is stored; exactly 10 MiB is accepted (AC-10.6)", async () => {
    expect((await mint({ sizeBytes: MAX_INVOICE_BYTES + 1 })).status).toBe(413);
    expect(await db.invoiceFile.count()).toBe(0);
    expect((await mint({ sizeBytes: MAX_INVOICE_BYTES })).status).toBe(201);
  });

  it("type is judged before size", async () => {
    expect((await mint({ contentType: "text/plain", sizeBytes: MAX_INVOICE_BYTES * 2 })).status).toBe(415);
  });

  it("a malformed body is 422 naming the field, and creates nothing", async () => {
    for (const [over, field] of [
      [{ sizeBytes: 0 }, "sizeBytes"],
      [{ sizeBytes: -5 }, "sizeBytes"],
      [{ sizeBytes: 1.5 }, "sizeBytes"],
      [{ sizeBytes: "10" }, "sizeBytes"],
      [{ invoiceRef: "   " }, "invoiceRef"],
      [{ invoiceRef: undefined }, "invoiceRef"],
      [{ fileName: "" }, "fileName"],
      [{ entity: "acme" }, "entity"],
    ] as const) {
      const res = await mint(over);
      expect(res.status).toBe(422);
      expect((await json(res))["field"]).toBe(field);
    }
    expect(await db.invoiceFile.count()).toBe(0);
  });

  it("a very large request body is 413 before it is parsed", async () => {
    expect((await mint({ fileName: "x".repeat(20_000) })).status).toBe(413);
  });

  it("needs a capability (403) and an entity inside the caller's scope (403)", async () => {
    as([], "welld_ch");
    expect((await mint()).status).toBe(403);
    as(MANAGER, "welld_ch");
    expect((await mint({ entity: "welld_it" })).status).toBe(403);
    expect(await db.invoiceFile.count()).toBe(0);
  });

  it("either capability may mint", async () => {
    as(ACCOUNTANT, "welld_ch");
    expect((await mint()).status).toBe(201);
    as(UNCONDITIONED_BOTH, null);
    expect((await mint({ entity: "welld_it" })).status).toBe(201);
  });

  it("without a token it is 401", async () => {
    expect((await call("POST", "/invoice-files", {}, null)).status).toBe(401);
  });
});

// ─── Confirm ─────────────────────────────────────────────────────────────────

describe("POST /invoice-files/{id}/confirm", () => {
  it("HEADs the object and flips the row to stored", async () => {
    const { id } = await json(await mint());
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, 1000);
    const res = await confirm(id);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id, fileName: "fattura.pdf" });
    expect((await db.invoiceFile.findUniqueOrThrow({ where: { id } })).uploadStatus).toBe("stored");
  });

  it("is idempotent: a second confirm is 200 and does not go back to the bucket", async () => {
    const { id } = await storedFile();
    headSpy.mockClear();
    expect((await confirm(id)).status).toBe(200);
    expect(headSpy).not.toHaveBeenCalled();
  });

  it("with no object it is 409 upload_not_found, stays pending, and can be confirmed after the upload", async () => {
    const { id } = await json(await mint());
    const res = await confirm(id);
    expect(res.status).toBe(409);
    expect((await json(res))["code"]).toBe("upload_not_found");
    expect((await db.invoiceFile.findUniqueOrThrow({ where: { id } })).uploadStatus).toBe("pending");
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, 1000);
    expect((await confirm(id)).status).toBe(200);
  });

  it("a size that differs from the declared one is 409, the object and the row are removed", async () => {
    const { id } = await json(await mint());
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, 999);
    const res = await confirm(id);
    expect(res.status).toBe(409);
    expect((await json(res))["code"]).toBe("upload_not_found");
    expect(bucket.has(row.objectKey)).toBe(false);
    expect(await db.invoiceFile.count({ where: { id } })).toBe(0);
  });

  it("a type that differs from the declared one is 409 and cleaned up", async () => {
    const { id } = await json(await mint());
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, 1000, "image/png");
    expect((await confirm(id)).status).toBe(409);
    expect(bucket.has(row.objectKey)).toBe(false);
    expect(await db.invoiceFile.count()).toBe(0);
  });

  it("an object over 10 MiB is 413 and cleaned up, whatever was declared", async () => {
    const { id } = await json(await mint());
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, MAX_INVOICE_BYTES + 1);
    expect((await confirm(id)).status).toBe(413);
    expect(bucket.has(row.objectKey)).toBe(false);
    expect(await db.invoiceFile.count({ where: { uploadStatus: "stored" } })).toBe(0);
    expect(await db.invoiceFile.count()).toBe(0);
  });

  it("an object of a type outside the allowlist is 415 and cleaned up", async () => {
    const { id } = await json(await mint());
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, 1000, "text/html");
    expect((await confirm(id)).status).toBe(415);
    expect(bucket.has(row.objectKey)).toBe(false);
    expect(await db.invoiceFile.count()).toBe(0);
  });

  it("a failing cleanup does not change the answer", async () => {
    const { id } = await json(await mint());
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, 1);
    deleteSpy.mockImplementation(async () => {
      throw new Error("storage down");
    });
    const logs = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await confirm(id)).status).toBe(409);
    } finally {
      logs.mockRestore();
    }
  });

  it("a storage outage on HEAD is a 500, never a confirmed file", async () => {
    const { id } = await json(await mint());
    headSpy.mockImplementation(async () => {
      throw Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
    });
    const logs = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await confirm(id)).status).toBe(500);
    } finally {
      logs.mockRestore();
    }
    expect((await db.invoiceFile.findUniqueOrThrow({ where: { id } })).uploadStatus).toBe("pending");
  });

  it("another entity's file, no capability, and an unknown id are all 404", async () => {
    const { id } = await json(await mint());
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, 1000);
    as(ACCOUNTANT, "welld_it");
    expect((await confirm(id)).status).toBe(404);
    as([], null);
    expect((await confirm(id)).status).toBe(404);
    as(MANAGER, "welld_ch");
    expect((await confirm("nope")).status).toBe(404);
    expect((await db.invoiceFile.findUniqueOrThrow({ where: { id } })).uploadStatus).toBe("pending");
  });
});

describe("confirm belongs to the uploader; minting is bounded", () => {
  let other: string;
  beforeAll(async () => {
    other = await harness.signToken({ sub: "u-2", email: "u2@welld.ch", permEpoch: 1 });
  });

  it("another in-scope user cannot confirm (or discard) someone else's upload: 404, object and row untouched", async () => {
    const { id } = await json(await mint());
    const row = await db.invoiceFile.findUniqueOrThrow({ where: { id } });
    upload(row.objectKey, 4242); // a size that would make the uploader's own confirm discard it
    const res = await call("POST", `/invoice-files/${id}/confirm`, undefined, other);
    expect(res.status).toBe(404);
    expect(bucket.has(row.objectKey)).toBe(true);
    expect((await db.invoiceFile.findUniqueOrThrow({ where: { id } })).uploadStatus).toBe("pending");
  });

  it("the 404 is the one an unknown file gets, and applies to an already-stored file too", async () => {
    const { id } = await storedFile();
    const stranger = await call("POST", `/invoice-files/${id}/confirm`, undefined, other);
    const unknown = await call("POST", `/invoice-files/nope/confirm`, undefined, other);
    expect(stranger.status).toBe(404);
    const a = await json(stranger);
    const b = await json(unknown);
    expect({ ...a, instance: undefined }).toEqual({ ...b, instance: undefined });
  });

  it("the uploader still confirms their own file", async () => {
    const { id } = await storedFile();
    expect((await confirm(id)).status).toBe(200);
  });

  it("a user with MAX_PENDING_FILES_PER_USER pending files is refused with 429 too_many_pending_uploads; others and confirmed files do not count", async () => {
    for (let i = 0; i < MAX_PENDING_FILES_PER_USER; i++) expect((await mint()).status).toBe(201);
    const res = await mint();
    expect(res.status).toBe(429);
    expect((await json(res))["code"]).toBe("too_many_pending_uploads");
    expect(await db.invoiceFile.count()).toBe(MAX_PENDING_FILES_PER_USER);
    // another user is unaffected
    expect((await call("POST", "/invoice-files", { entity: "welld_ch", invoiceRef: "X", fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 10 }, other)).status).toBe(201);
    // confirming one frees a slot
    const first = await db.invoiceFile.findFirstOrThrow({ where: { createdByUserId: "u-1" } });
    upload(first.objectKey, first.sizeBytes);
    expect((await confirm(first.id)).status).toBe(200);
    expect((await mint()).status).toBe(201);
  });

  it("pending files older than the window (abandoned mints) do not lock the user out", async () => {
    for (let i = 0; i < MAX_PENDING_FILES_PER_USER; i++) expect((await mint()).status).toBe(201);
    await db.invoiceFile.updateMany({ data: { createdAt: new Date(Date.now() - 2 * 3600_000) } });
    expect((await mint()).status).toBe(201);
  });
});

// ─── Link ────────────────────────────────────────────────────────────────────

describe("PUT /invoice-files/{id}/assets (AC-10.5)", () => {
  it("one file linked to three assets is one invoice_file row, and each link is a history event", async () => {
    const { id } = await storedFile();
    const assets = [await seedAsset(), await seedAsset(), await seedAsset()];
    const res = await link(id, assets.map((a) => a.id));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ linked: assets.map((a) => a.id) });
    expect(await db.invoiceFile.count()).toBe(1);
    for (const a of assets) {
      expect((await reload(a.id)).invoiceFileId).toBe(id);
      const events = await linkEvents(a.id);
      expect(events).toHaveLength(1);
      expect(eventChanges(events[0]!.oldValue, events[0]!.newValue)).toEqual([
        { field: "invoiceFile", from: null, to: "fattura.pdf" },
      ]);
      expect(events[0]).toMatchObject({ actorUserId: "u-1", entity: "welld_ch" });
    }
  });

  it("linking again is a no-op: no second event; duplicate ids are collapsed", async () => {
    const { id } = await storedFile();
    const a = await seedAsset();
    expect((await link(id, [a.id, a.id])).status).toBe(200);
    const res = await link(id, [a.id]);
    expect(await json(res)).toEqual({ linked: [a.id] });
    expect(await linkEvents(a.id)).toHaveLength(1);
  });

  it("a mismatching invoice reference is 409 naming the asset, and NOTHING is linked", async () => {
    const { id } = await storedFile();
    const ok = await seedAsset();
    const wrong = await seedAsset({ invoiceRef: "INV-78" });
    const none = await seedAsset({ invoiceRef: null });
    for (const bad of [wrong, none]) {
      const res = await link(id, [ok.id, bad.id]);
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ code: "invoice_ref_mismatch", assetId: bad.id });
    }
    expect((await reload(ok.id)).invoiceFileId).toBeNull();
    expect(await linkEvents(ok.id)).toHaveLength(0);
  });

  it("a disposed asset is 409 asset_disposed naming it, and nothing is linked", async () => {
    const { id } = await storedFile();
    const ok = await seedAsset();
    const gone = await seedAsset({ status: "disposed", disposedOn: new Date("2026-06-01"), disposalReason: "scrapped" });
    const res = await link(id, [ok.id, gone.id]);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: "asset_disposed", assetId: gone.id });
    expect((await reload(ok.id)).invoiceFileId).toBeNull();
  });

  it("an asset of another entity is refused even for a caller who may see both", async () => {
    as(UNCONDITIONED_BOTH, null);
    const { id } = await storedFile();
    const other = await seedAsset({ entity: "welld_it", currency: "EUR" });
    const res = await link(id, [other.id]);
    expect(res.status).toBe(409);
    expect((await reload(other.id)).invoiceFileId).toBeNull();
  });

  it("an out-of-scope or unknown asset is 404 for the whole request, ahead of any 409", async () => {
    const { id } = await storedFile();
    const mismatch = await seedAsset({ invoiceRef: "INV-78" });
    const foreign = await seedAsset({ entity: "welld_it", currency: "EUR" });
    for (const bad of [foreign.id, "nope"]) {
      expect((await link(id, [mismatch.id, bad])).status).toBe(404);
    }
    const ok = await seedAsset();
    expect((await link(id, [ok.id, foreign.id])).status).toBe(404);
    expect((await reload(ok.id)).invoiceFileId).toBeNull();
  });

  it("linking a new file replaces the asset's link and keeps the old row (plan: no unlink)", async () => {
    const first = await storedFile({ fileName: "one.pdf" });
    const second = await storedFile({ fileName: "two.pdf" });
    const a = await seedAsset();
    await link(first.id, [a.id]);
    expect((await link(second.id, [a.id])).status).toBe(200);
    expect((await reload(a.id)).invoiceFileId).toBe(second.id);
    expect(await db.invoiceFile.count()).toBe(2);
    const events = await linkEvents(a.id);
    expect(events).toHaveLength(2);
    expect(eventChanges(events[1]!.oldValue, events[1]!.newValue)).toEqual([
      { field: "invoiceFile", from: "one.pdf", to: "two.pdf" },
    ]);
  });

  it("a file that was never confirmed cannot be linked (404)", async () => {
    const { id } = await json(await mint());
    const a = await seedAsset();
    expect((await link(id, [a.id])).status).toBe(404);
    expect((await reload(a.id)).invoiceFileId).toBeNull();
  });

  it("either capability may link; the other entity's accountant and a grant-less caller get 404", async () => {
    const { id } = await storedFile();
    const a = await seedAsset();
    as(ACCOUNTANT, "welld_it");
    expect((await link(id, [a.id])).status).toBe(404);
    as([], null);
    expect((await link(id, [a.id])).status).toBe(404);
    as(ACCOUNTANT, "welld_ch");
    expect((await link(id, [a.id])).status).toBe(200);
  });

  it("an empty list, more than 200 ids, or a non-array is 422", async () => {
    const { id } = await storedFile();
    expect((await link(id, [])).status).toBe(422);
    expect((await link(id, Array.from({ length: 201 }, (_, i) => `a${i}`))).status).toBe(422);
    expect((await call("PUT", `/invoice-files/${id}/assets`, { assetIds: "x" })).status).toBe(422);
  });

  it("two files raced onto one asset end with exactly one link and both calls answered 200", async () => {
    const one = await storedFile({ fileName: "one.pdf" });
    const two = await storedFile({ fileName: "two.pdf" });
    const a = await seedAsset();
    const results = await Promise.all([link(one.id, [a.id]), link(two.id, [a.id])]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect([one.id, two.id]).toContain((await reload(a.id)).invoiceFileId as string);
    expect(await linkEvents(a.id)).toHaveLength(2);
  }, 20_000);

  it("changing the invoice reference afterwards unlinks the file (T13) and the link rule then refuses the old ref", async () => {
    const { id } = await storedFile();
    const a = await seedAsset();
    await link(id, [a.id]);
    await db.asset.update({ where: { id: a.id }, data: { invoiceRef: "INV-99", invoiceFileId: null } });
    expect((await link(id, [a.id])).status).toBe(409);
  });
});

// ─── Download URL ────────────────────────────────────────────────────────────

describe("GET /invoice-files/{id}/url (AC-10.4, AC-10.7)", () => {
  it("confirm records the object's ETag; a download of the same object is served", async () => {
    const { id } = await storedFile();
    expect((await db.invoiceFile.findUniqueOrThrow({ where: { id } })).etag).toBe('"etag-1"');
    expect((await urlOf(id)).status).toBe(200);
  });

  it("an object overwritten after confirm (new ETag, same size) is 404, never a URL", async () => {
    const { id, key } = await storedFile();
    upload(key, 1000, "application/pdf", '"etag-2"');
    const res = await urlOf(id);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await json(res))).not.toContain(key);
  });

  it("an object whose size changed after confirm is 404", async () => {
    const { id, key } = await storedFile();
    upload(key, 999, "application/pdf", '"etag-1"');
    expect((await urlOf(id)).status).toBe(404);
  });

  it("a stored object that has vanished is 404", async () => {
    const { id, key } = await storedFile();
    bucket.delete(key);
    expect((await urlOf(id)).status).toBe(404);
  });

  it("a file confirmed before ETags were recorded (null) is served on size alone", async () => {
    const { id } = await storedFile();
    await db.invoiceFile.update({ where: { id }, data: { etag: null } });
    expect((await urlOf(id)).status).toBe(200);
  });

  it("answers a 60 s signed URL for either capability, never cacheable, never the object key", async () => {
    const { id, key } = await storedFile();
    for (const [perms, entity] of [
      [MANAGER, "welld_ch"],
      [ACCOUNTANT, "welld_ch"],
      [UNCONDITIONED_BOTH, null],
    ] as const) {
      as([...perms], entity);
      const res = await urlOf(id);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await json(res);
      expect(body["expiresInSeconds"]).toBe(60);
      const url = new URL(body["url"]);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
      expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
      expect(url.pathname).toContain(key);
      expect(Object.keys(body).sort()).toEqual(["expiresInSeconds", "url"]);
    }
  });

  it("the asset's own holder with no capability gets 404 (AC-10.7)", async () => {
    const { id } = await storedFile();
    const a = await seedAsset({ status: "assigned", holderUserId: "u-1" });
    await link(id, [a.id]);
    as([], null);
    expect((await urlOf(id)).status).toBe(404);
  });

  it("another entity's accountant, an unknown id and a not-yet-confirmed file are 404", async () => {
    const { id } = await storedFile();
    as(ACCOUNTANT, "welld_it");
    expect((await urlOf(id)).status).toBe(404);
    as(MANAGER, "welld_ch");
    expect((await urlOf("nope")).status).toBe(404);
    const pending = await json(await mint());
    expect((await urlOf(pending["id"])).status).toBe(404);
  });

  it("a stale file whose upload was never confirmed is not surfaced anywhere (orphans stay invisible)", async () => {
    await mint();
    await mint();
    expect(await db.invoiceFile.count({ where: { uploadStatus: "stored" } })).toBe(0);
    const a = await seedAsset();
    const view = await db.asset.findUniqueOrThrow({ where: { id: a.id }, include: { invoiceFile: true } });
    expect(view.invoiceFile).toBeNull();
  });
});

// ─── The real bucket ─────────────────────────────────────────────────────────

const unreachable = await probeBucket();
if (unreachable) console.warn(`[invoices.test] SKIPPING the object-storage tests: ${unreachable}`);

describe.skipIf(unreachable !== null)("against the configured bucket (MinIO)", () => {
  beforeEach(() => {
    // The real bucket, not the in-memory one.
    headSpy.mockRestore();
    deleteSpy.mockRestore();
    headSpy = spyOn(storage, "headObject");
    deleteSpy = spyOn(storage, "deleteObject");
  });

  const pdf = (n = 0) => new TextEncoder().encode(`%PDF-1.4 invoice ${n}`);

  it("mint -> upload -> confirm -> URL works for either capability in scope (AC-10.4)", async () => {
    const bytes = pdf(1);
    const minted = await json(await mint({ sizeBytes: bytes.length, fileName: "Fattura è 03.pdf" }));
    expect((await postToPresigned(minted["upload"], bytes, "application/pdf")).ok).toBe(true);
    const confirmed = await confirm(minted["id"]);
    expect(confirmed.status).toBe(200);
    expect(await json(confirmed)).toEqual({ id: minted["id"], fileName: "Fattura è 03.pdf" });

    const asset = await seedAsset();
    expect((await link(minted["id"], [asset.id])).status).toBe(200);

    for (const [perms, entity] of [
      [MANAGER, "welld_ch"],
      [ACCOUNTANT, "welld_ch"],
    ] as const) {
      as([...perms], entity);
      const { url } = await json(await urlOf(minted["id"]));
      const file = await fetch(url);
      expect(file.status).toBe(200);
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
      expect(file.headers.get("content-type")).toBe("application/pdf");
      expect(file.headers.get("content-disposition")).toContain("filename*=UTF-8''Fattura%20%C3%A8%2003.pdf");
    }
    await storage.deleteObject((await db.invoiceFile.findUniqueOrThrow({ where: { id: minted["id"] } })).objectKey);
  });

  it("text/plain is 415 and 11 MiB is 413 at mint, and no row is left stored (AC-10.6)", async () => {
    expect((await mint({ contentType: "text/plain" })).status).toBe(415);
    expect((await mint({ sizeBytes: 11 * 1024 * 1024 })).status).toBe(413);
    expect(await db.invoiceFile.count()).toBe(0);
  });

  it("a file the browser never uploaded is 409, and a smaller-than-declared one is rejected and deleted", async () => {
    const never = await json(await mint());
    expect((await confirm(never["id"])).status).toBe(409);

    const short = await json(await mint({ sizeBytes: 5000 }));
    expect((await postToPresigned(short["upload"], pdf(2), "application/pdf")).ok).toBe(true);
    const key = (await db.invoiceFile.findUniqueOrThrow({ where: { id: short["id"] } })).objectKey;
    expect((await confirm(short["id"])).status).toBe(409);
    expect(await storage.headObject(key)).toBeNull();
    expect(await db.invoiceFile.count({ where: { id: short["id"] } })).toBe(0);
  });
});
