/**
 * Integration tests for the attachment endpoints (T9,
 * specs/007-refund-service, ADR-0016).
 *
 * Strategy: real Postgres, jwt/authz mocked (see requests.routes.test.ts's
 * header comment). Object storage is ALSO mocked here (`../lib/storage`) —
 * no live bucket is required, per T9's own done-when.
 *
 * AC coverage (T9 done-when)
 * ──────────────────────────
 * - mint→confirm→list flow (only `stored` attachments surface)
 * - oversize/wrong-type rejection at mint (422)
 * - draft-only delete guard
 * - a signed GET is only minted AFTER the ownership/entity-scope authz check
 *   (proven by: mintPresignedGet call-count stays 0 on a denied request)
 */

import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import type { ResolveResponse } from "../authz/resolveClient";
import { setupTestAuth } from "../test-support/testAuth";
import { truncateRefundTables } from "../test-support/dbCleanup";

process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] = "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["REFUND_S3_ENDPOINT"] =
  "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";

const harness = setupTestAuth();
await harness.init();

// ─── Mock the storage layer — no live bucket ───────────────────────────────

let mintPresignedPostCalls = 0;
let mintPresignedGetCalls = 0;
let deleteObjectCalls = 0;
let headResponse: { sizeBytes: number; contentType: string } | null = {
  sizeBytes: 100,
  contentType: "application/pdf",
};

mock.module("../lib/storage", () => ({
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024,
  ALLOWED_CONTENT_TYPES: ["application/pdf", "image/jpeg", "image/png"],
  isAllowedContentType: (ct: string) =>
    ["application/pdf", "image/jpeg", "image/png"].includes(ct),
  sanitizeFileName: (fileName: string) =>
    (fileName.split(/[/\\]/).pop() ?? "file").replace(/[^a-zA-Z0-9._-]/g, "_"),
  mintPresignedPost: async (objectKey: string) => {
    mintPresignedPostCalls++;
    return { url: "https://mock.example.com/upload", fields: { key: objectKey } };
  },
  headObject: async () => headResponse,
  mintPresignedGet: async () => {
    mintPresignedGetCalls++;
    return "https://mock.example.com/signed-get";
  },
  deleteObject: async () => {
    deleteObjectCalls++;
  },
}));

const { attachmentsRouter } = await import("./attachments.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");

const EMPLOYEE_PERMS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "create", conditions: null },
    { resource: "request", action: "read", conditions: { ownership: "own" } },
  ],
  entity: "welld_it",
  jobTitle: null,
};

const accountingPerms = (entity: string | null): ResolveResponse => ({
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    {
      resource: "request",
      action: "review",
      conditions: entity
        ? { attributes: [{ key: "entity", match: "user" }] }
        : null,
    },
  ],
  entity,
  jobTitle: null,
});

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const OWNER_SUB = "emp-att-1";
const OWNER_EMAIL = "emp-att-1@x.com";

async function makeRequestWithLine(status: "draft" | "submitted" = "draft") {
  const request = await db.refundRequest.create({
    data: { ownerUserId: OWNER_SUB, ownerEmail: OWNER_EMAIL, status },
  });
  const line = await db.refundLine.create({
    data: {
      requestId: request.id,
      date: new Date("2026-06-01T00:00:00.000Z"),
      type: "postal",
      motivo: "Receipt line",
      entity: "welld_it",
      requestedAmountCents: 500,
    },
  });
  return { request, line };
}

beforeEach(async () => {
  await truncateRefundTables();
  harness.setResolve(async () => EMPLOYEE_PERMS);
  __resetAuthzCacheForTests();
  mintPresignedPostCalls = 0;
  mintPresignedGetCalls = 0;
  deleteObjectCalls = 0;
  headResponse = { sizeBytes: 100, contentType: "application/pdf" };
});

afterAll(async () => {
  await truncateRefundTables();
});

// ─── POST .../attachments — mint ────────────────────────────────────────────

describe("POST /requests/:id/lines/:lineId/attachments (mint)", () => {
  it("mints a presigned upload and records a pending attachment", async () => {
    const { request, line } = await makeRequestWithLine();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          fileName: "receipt.pdf",
          contentType: "application/pdf",
          sizeBytes: 20481,
        }),
      },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      attachmentId: string;
      upload: { url: string; fields: Record<string, string>; objectKey: string };
    };
    expect(body.upload.objectKey).toContain(`refund/${request.id}/${line.id}/`);
    expect(body.upload.objectKey.endsWith("receipt.pdf")).toBe(true);
    expect(mintPresignedPostCalls).toBe(1);

    const row = await db.attachment.findUniqueOrThrow({ where: { id: body.attachmentId } });
    expect(row.uploadStatus).toBe("pending");
  });

  it("oversize sizeBytes → 422, nothing minted or persisted", async () => {
    const { request, line } = await makeRequestWithLine();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          fileName: "big.pdf",
          contentType: "application/pdf",
          sizeBytes: 11 * 1024 * 1024,
        }),
      },
    );

    expect(res.status).toBe(422);
    expect(mintPresignedPostCalls).toBe(0);
    expect(await db.attachment.count()).toBe(0);
  });

  it("disallowed content type → 422, nothing minted or persisted", async () => {
    const { request, line } = await makeRequestWithLine();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          fileName: "archive.zip",
          contentType: "application/zip",
          sizeBytes: 1000,
        }),
      },
    );

    expect(res.status).toBe(422);
    expect(mintPresignedPostCalls).toBe(0);
    expect(await db.attachment.count()).toBe(0);
  });

  it("draft-only guard: 409 on a submitted request", async () => {
    const { request, line } = await makeRequestWithLine("submitted");
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          fileName: "receipt.pdf",
          contentType: "application/pdf",
          sizeBytes: 1000,
        }),
      },
    );

    expect(res.status).toBe(409);
    expect(mintPresignedPostCalls).toBe(0);
  });

  it("ownership guard: a non-owner gets 404", async () => {
    const { request, line } = await makeRequestWithLine();
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          fileName: "receipt.pdf",
          contentType: "application/pdf",
          sizeBytes: 1000,
        }),
      },
    );

    expect(res.status).toBe(404);
    expect(mintPresignedPostCalls).toBe(0);
  });
});

// ─── POST .../attachments/:aid/confirm ──────────────────────────────────────

describe("POST .../attachments/:aid/confirm", () => {
  async function mintOne(requestId: string, lineId: string, token: string) {
    const res = await attachmentsRouter.request(
      `/requests/${requestId}/lines/${lineId}/attachments`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          fileName: "receipt.pdf",
          contentType: "application/pdf",
          sizeBytes: 100,
        }),
      },
    );
    const body = (await res.json()) as { attachmentId: string };
    return body.attachmentId;
  }

  it("flips uploadStatus to stored when HEAD confirms matching size/type", async () => {
    const { request, line } = await makeRequestWithLine();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });
    const attachmentId = await mintOne(request.id, line.id, token);

    headResponse = { sizeBytes: 100, contentType: "application/pdf" };

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachmentId}/confirm`,
      { method: "POST", headers: authHeaders(token) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { uploadStatus: string };
    expect(body.uploadStatus).toBe("stored");

    const row = await db.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.uploadStatus).toBe("stored");
  });

  it("object missing in storage (HEAD → null) → 409, stays pending", async () => {
    const { request, line } = await makeRequestWithLine();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });
    const attachmentId = await mintOne(request.id, line.id, token);

    headResponse = null;

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachmentId}/confirm`,
      { method: "POST", headers: authHeaders(token) },
    );

    expect(res.status).toBe(409);
    const row = await db.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.uploadStatus).toBe("pending");
  });

  it("HEAD size mismatch (client lied about metadata at mint) → 409, stays pending", async () => {
    const { request, line } = await makeRequestWithLine();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });
    const attachmentId = await mintOne(request.id, line.id, token);

    headResponse = { sizeBytes: 99999, contentType: "application/pdf" };

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachmentId}/confirm`,
      { method: "POST", headers: authHeaders(token) },
    );

    expect(res.status).toBe(409);
    const row = await db.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    expect(row.uploadStatus).toBe("pending");
  });

  it("a pending (unconfirmed) attachment never surfaces on the request detail", async () => {
    // Exercises requests.repo/requests.service directly (both DB-only, no
    // jwt/authz mocking) rather than dynamically importing requests.routes
    // here — that module is ALSO imported (and mock.module()-wired against
    // its OWN jwt/authz fixtures) by requests.routes.test.ts elsewhere in
    // this same `bun test` process; re-importing it from a second file could
    // return the already-cached instance bound to a different harness.
    const { request, line } = await makeRequestWithLine();
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });
    await mintOne(request.id, line.id, token);

    const { findRequestWithLines } = await import("../requests/requests.repo");
    const { mapRequestDetail } = await import("../requests/requests.service");
    const { Effect } = await import("effect");

    const row = await Effect.runPromise(findRequestWithLines(request.id));
    const detail = mapRequestDetail(row!);
    expect(detail.lines[0]?.attachments).toEqual([]);
  });
});

// ─── DELETE .../attachments/:aid ────────────────────────────────────────────

describe("DELETE .../attachments/:aid", () => {
  it("draft-only: deletes the object (best-effort) and the DB row", async () => {
    const { request, line } = await makeRequestWithLine();
    const attachment = await db.attachment.create({
      data: {
        lineId: line.id,
        objectKey: `refund/${request.id}/${line.id}/att1/receipt.pdf`,
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        uploadStatus: "stored",
      },
    });
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachment.id}`,
      { method: "DELETE", headers: authHeaders(token) },
    );

    expect(res.status).toBe(204);
    expect(deleteObjectCalls).toBe(1);
    expect(await db.attachment.findUnique({ where: { id: attachment.id } })).toBeNull();
  });

  it("draft-only guard: 409 on a submitted request, attachment untouched", async () => {
    const { request, line } = await makeRequestWithLine("submitted");
    const attachment = await db.attachment.create({
      data: {
        lineId: line.id,
        objectKey: `refund/${request.id}/${line.id}/att1/receipt.pdf`,
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        uploadStatus: "stored",
      },
    });
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachment.id}`,
      { method: "DELETE", headers: authHeaders(token) },
    );

    expect(res.status).toBe(409);
    expect(deleteObjectCalls).toBe(0);
    expect(await db.attachment.findUnique({ where: { id: attachment.id } })).not.toBeNull();
  });
});

// ─── GET .../attachments/:aid/url ───────────────────────────────────────────

describe("GET .../attachments/:aid/url", () => {
  async function makeStoredAttachment(requestId: string, lineId: string) {
    return db.attachment.create({
      data: {
        lineId,
        objectKey: `refund/${requestId}/${lineId}/att1/receipt.pdf`,
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        uploadStatus: "stored",
      },
    });
  }

  it("owner: mints a signed GET only after the authz check passes", async () => {
    const { request, line } = await makeRequestWithLine();
    const attachment = await makeStoredAttachment(request.id, line.id);
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachment.id}/url`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(200);
    expect(mintPresignedGetCalls).toBe(1);
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body.url).toBe("https://mock.example.com/signed-get");
  });

  it("a non-owner, non-accounting stranger gets 404 — the signed GET is NEVER minted", async () => {
    const { request, line } = await makeRequestWithLine();
    const attachment = await makeStoredAttachment(request.id, line.id);
    const token = await harness.signToken({ sub: "stranger", email: "stranger@x.com" });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachment.id}/url`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(404);
    expect(mintPresignedGetCalls).toBe(0);
  });

  it("an out-of-scope accounting reviewer gets 404 — signed GET NEVER minted", async () => {
    const { request, line } = await makeRequestWithLine("submitted");
    const attachment = await makeStoredAttachment(request.id, line.id);
    harness.setResolve(async () => accountingPerms("welld_ch")); // line is welld_it
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachment.id}/url`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(404);
    expect(mintPresignedGetCalls).toBe(0);
  });

  it("an in-scope accounting reviewer CAN mint a signed GET", async () => {
    const { request, line } = await makeRequestWithLine("submitted");
    const attachment = await makeStoredAttachment(request.id, line.id);
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${attachment.id}/url`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(200);
    expect(mintPresignedGetCalls).toBe(1);
  });

  it("a pending (unconfirmed) attachment → 404, never a signed GET", async () => {
    const { request, line } = await makeRequestWithLine();
    const pending = await db.attachment.create({
      data: {
        lineId: line.id,
        objectKey: `refund/${request.id}/${line.id}/att-pending/receipt.pdf`,
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        uploadStatus: "pending",
      },
    });
    const token = await harness.signToken({ sub: OWNER_SUB, email: OWNER_EMAIL });

    const res = await attachmentsRouter.request(
      `/requests/${request.id}/lines/${line.id}/attachments/${pending.id}/url`,
      { headers: authHeaders(token) },
    );

    expect(res.status).toBe(404);
    expect(mintPresignedGetCalls).toBe(0);
  });
});
