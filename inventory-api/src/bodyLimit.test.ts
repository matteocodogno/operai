/**
 * The global request-body cap (specs/015 security review L7), over the
 * ASSEMBLED app: 64 KiB everywhere, the stricter 8 KiB kept on
 * `POST /invoice-files`, and the refusal is a 413 Problem JSON, never a parse.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestAuth } from "./test-support/testAuth";
import { truncateInventoryTables } from "./test-support/dbCleanup";

const harness = setupTestAuth();
await harness.init();

const { app } = await import("./index");
const { db } = await import("./lib/db");
const { __resetAuthzCacheForTests } = await import("./auth/authz.middleware");

const KIB = 1024;
let token: string;

beforeAll(async () => {
  await truncateInventoryTables();
  token = await harness.signToken({ sub: "u-1", email: "u1@welld.ch", permEpoch: 1 });
  __resetAuthzCacheForTests();
  harness.setResolve(async () => ({
    sub: "u-1",
    epoch: 1,
    permissions: [
      { resource: "inventory", action: "access", conditions: null },
      { resource: "asset", action: "manage", conditions: null },
      { resource: "ledger", action: "manage", conditions: null },
    ],
    entity: "welld_ch",
    jobTitle: null,
  }));
});
afterAll(async () => {
  await truncateInventoryTables();
});

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body,
  });
const padded = (bytes: number) => JSON.stringify({ description: "x".repeat(bytes) });

describe("global body limit (64 KiB)", () => {
  it("a body over 64 KiB is a 413 Problem JSON on any route, before anything is parsed or written", async () => {
    const res = await post("/assets", padded(65 * KIB));
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("json");
    expect(await res.json()).toMatchObject({ status: 413, title: "Payload Too Large", instance: "/assets" });
    expect(await db.asset.count()).toBe(0);
  });

  it("applies to the unauthenticated caller too (it is checked before auth)", async () => {
    const res = await app.request("/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: padded(65 * KIB),
    });
    expect(res.status).toBe(413);
  });

  it("is enforced on a streamed body that declares no length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * KIB));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 6) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const res = await app.request("/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: stream,
      // a streaming request body needs duplex
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });

  it("a body under the limit is not refused by it (validation answers instead)", async () => {
    const res = await post("/assets", padded(60 * KIB));
    expect(res.status).not.toBe(413);
  });

  it("POST /invoice-files keeps its stricter 8 KiB cap", async () => {
    expect((await post("/invoice-files", padded(9 * KIB))).status).toBe(413);
    expect((await post("/invoice-files", padded(2 * KIB))).status).not.toBe(413);
  });

  it("does not touch bodiless requests", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
