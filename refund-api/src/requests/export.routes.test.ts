/**
 * Integration tests for GET /requests/:id/export (ADR-0043).
 *
 * SCOPE NOTE — read before adding to this file. These cover the ACCESS gate,
 * the archivable-status gate and the byte budget: every path that resolves
 * WITHOUT reading a single object from storage. The budget check is
 * deliberately placed before any download in the handler, which is what makes
 * it testable here at all.
 *
 * The receipt-embedding path is NOT integration-tested here, on purpose.
 * `mock.module` is process-global for the rest of the `bun test` run (see
 * test-support/testAuth.ts), and `batches/batches.routes.test.ts` already
 * registers a `../lib/storage` mock that has no `getObject`. Two files
 * mocking the same module means last-registration-wins across the whole run,
 * so a storage mock here would be order-dependent in one direction and would
 * silently reshape the batch tests' storage in the other. Embedding is
 * covered instead by `exportPdf.test.ts`, which drives the renderer directly
 * with real PNG/JPEG/PDF bytes and needs no mock at all — the renderer is
 * pure precisely so that split is possible.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
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

const harness = setupTestAuth();
await harness.init();

const { requestExportRouter } = await import("./export.routes");
const { db } = await import("../lib/db");
const { __resetAuthzCacheForTests } = await import("../auth/authz.middleware");
const { MAX_EXPORT_RECEIPT_BYTES } = await import("../lib/storage");
const { extractPdfText } = await import("../test-support/pdfText");

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

const EMPLOYEE_PERMS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [
    { resource: "refund", action: "access", conditions: null },
    { resource: "request", action: "read", conditions: { ownership: "own" } },
  ],
  entity: "welld_ch",
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
      conditions: entity ? { attributes: [{ key: "entity", match: "user" }] } : null,
    },
  ],
  entity,
  jobTitle: null,
});

const NO_GRANTS: ResolveResponse = {
  sub: "",
  epoch: 1,
  permissions: [],
  entity: null,
  jobTitle: null,
};

async function createRequest(
  status: "draft" | "submitted" | "approved" | "rejected" | "paid",
  overrides: Partial<{ ownerUserId: string; entity: "welld_it" | "welld_ch" }> = {},
) {
  const request = await db.refundRequest.create({
    data: {
      ownerUserId: overrides.ownerUserId ?? "emp-1",
      ownerEmail: "emp1@x.com",
      status,
      submittedAt: status === "draft" ? null : new Date(),
      decidedAt: status === "approved" || status === "paid" ? new Date() : null,
    },
  });
  const line = await db.refundLine.create({
    data: {
      requestId: request.id,
      date: new Date("2026-08-11T00:00:00.000Z"),
      type: "office_material",
      motivo: "Test line",
      entity: overrides.entity ?? "welld_ch",
      currency: "CHF",
      requestedAmountCents: 20650,
      approvedTotalCents: 20650,
    },
  });
  return { request, line };
}

beforeEach(async () => {
  await truncateRefundTables();
  __resetAuthzCacheForTests();
});

afterAll(async () => {
  await truncateRefundTables();
});

describe("GET /requests/:id/export", () => {
  const url = (id: string) => `/requests/${id}/export`;

  it("the owner can export their own approved request", async () => {
    const { request } = await createRequest("approved");
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestExportRouter.request(url(request.id), {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    // The filename is human-first now (period, surname, amount) with the cuid
    // kept as a collision guard — see the filename test below.
    expect(res.headers.get("content-disposition")).toContain(`${request.id}.pdf`);
    // Personal financial data must never sit in an intermediary cache.
    expect(res.headers.get("cache-control")).toBe("no-store");

    const bytes = new Uint8Array(await res.arrayBuffer());
    // A real PDF, not an error body that happened to get the header.
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("an in-scope accounting reviewer can export someone else's approved request", async () => {
    const { request } = await createRequest("approved", { entity: "welld_ch" });
    harness.setResolve(async () => accountingPerms("welld_ch"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await requestExportRouter.request(url(request.id), {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
  });

  it("a paid request is still exportable — completing a payout must not block archiving", async () => {
    const { request } = await createRequest("paid");
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestExportRouter.request(url(request.id), {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
  });

  // ADR-0005 / the sibling GET /requests/:id: a denial must never distinguish
  // "exists but not yours" from "does not exist". An export route must not
  // become the one place existence leaks.
  it("a non-owner, non-reviewer gets 404 — never 403", async () => {
    const { request } = await createRequest("approved", { ownerUserId: "someone-else" });
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestExportRouter.request(url(request.id), {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("an out-of-scope accounting reviewer gets 404", async () => {
    const { request } = await createRequest("approved", {
      ownerUserId: "someone-else",
      entity: "welld_ch",
    });
    harness.setResolve(async () => accountingPerms("welld_it"));
    const token = await harness.signToken({ sub: "acct-1", email: "acct1@x.com" });

    const res = await requestExportRouter.request(url(request.id), {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  // 404, NOT 403 — matching the sibling GET /requests/:id, whose route doc is
  // explicit that "EVERY denial (not found, not owned, missing capability,
  // out-of-scope) → 404, never 403". A capability-absent 403 here would tell
  // an ungranted caller that this request id exists.
  it("a caller with no grants at all gets 404, not a capability-revealing 403", async () => {
    const { request } = await createRequest("approved");
    harness.setResolve(async () => NO_GRANTS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestExportRouter.request(url(request.id), {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  it("a nonexistent request is 404", async () => {
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestExportRouter.request(url("does-not-exist"), {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(404);
  });

  // An archive must record something settled. A draft's mileage is recomputed
  // on every read and a submitted request has no approved figures at all, so
  // exporting either would archive a moving target.
  it.each(["draft", "submitted", "rejected"] as const)(
    "a %s request is 409, not an archive of a moving target",
    async (status) => {
      const { request } = await createRequest(status);
      harness.setResolve(async () => EMPLOYEE_PERMS);
      const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

      const res = await requestExportRouter.request(url(request.id), {
        headers: authHeaders(token),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain(status);
    },
  );

  // The budget is checked from the DB's sizeBytes BEFORE any object is
  // fetched — that is what stops one oversized request OOMing the service,
  // and it is why this is testable without touching storage at all.
  it("refuses with 413 when the receipts exceed the export byte budget, before downloading anything", async () => {
    const { request, line } = await createRequest("approved");
    await db.attachment.create({
      data: {
        lineId: line.id,
        objectKey: `refund/${request.id}/${line.id}/a1/huge.pdf`,
        fileName: "huge.pdf",
        contentType: "application/pdf",
        sizeBytes: MAX_EXPORT_RECEIPT_BYTES + 1,
        uploadStatus: "stored",
      },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestExportRouter.request(url(request.id), {
      headers: authHeaders(token),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { detail: string };
    // The message must name the real total, so the limit is actionable
    // rather than a mystery.
    expect(body.detail).toContain(String(MAX_EXPORT_RECEIPT_BYTES + 1));
  });

  // A `pending` attachment is one whose direct-to-bucket upload never
  // completed (ADR-0016). Its object may not exist, so counting it toward the
  // budget — or trying to embed it — would fail an export over a file that is
  // not part of the record.
  it("ignores pending (never-confirmed) attachments entirely", async () => {
    const { request, line } = await createRequest("approved");
    await db.attachment.create({
      data: {
        lineId: line.id,
        objectKey: `refund/${request.id}/${line.id}/a2/ghost.pdf`,
        fileName: "ghost.pdf",
        contentType: "application/pdf",
        sizeBytes: MAX_EXPORT_RECEIPT_BYTES + 1,
        uploadStatus: "pending",
      },
    });

    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });

    const res = await requestExportRouter.request(url(request.id), {
      headers: authHeaders(token),
    });
    // Not 413: the pending row must not count toward the budget.
    expect(res.status).toBe(200);
  });
});

// ─── Document quality (2026-09-08 review) ──────────────────────────────────

describe("GET /requests/:id/export — settlement state and filename", () => {
  const url = (id: string) => `/requests/${id}/export`;

  async function exportAs(requestId: string) {
    harness.setResolve(async () => EMPLOYEE_PERMS);
    const token = await harness.signToken({ sub: "emp-1", email: "emp1@x.com" });
    return await requestExportRouter.request(url(requestId), { headers: authHeaders(token) });
  }

  // A filename someone can file and sort, replacing refund-request-<cuid>.pdf.
  it("names the file by period, surname and amount, not by the cuid alone", async () => {
    const { request } = await createRequest("approved");
    const res = await exportAs(request.id);

    expect(res.status).toBe(200);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("refund_2026-08_emp1_CHF-206.50");
    // The cuid still ends it, so two requests by the same person in the same
    // month for the same total cannot collide in a downloads folder.
    expect(disposition).toContain(request.id);
  });

  it("says a request with no batch is not yet included in one", async () => {
    const { request } = await createRequest("approved");
    const res = await exportAs(request.id);
    const text = await extractPdfText(Buffer.from(await res.arrayBuffer()));

    expect(text).toContain("not yet included in a monthly batch");
  });

  // The distinction that matters to a recipient: compiled is still a
  // liability, paid is settled. Both used to render identically.
  it("distinguishes a compiled-but-unpaid batch from a paid one", async () => {
    const { request } = await createRequest("approved");
    const batch = await db.refundBatch.create({
      data: {
        cutoff: new Date("2026-09-30T12:00:00.000Z"),
        createdByUserId: "acct-1",
        createdByEmail: "acct1@x.com",
        pdfObjectKey: `refund/batches/${crypto.randomUUID()}/compiled.pdf`,
      },
    });
    await db.refundRequest.update({ where: { id: request.id }, data: { batchId: batch.id } });

    const compiledText = await extractPdfText(
      Buffer.from(await (await exportAs(request.id)).arrayBuffer()),
    );
    expect(compiledText).toContain("batch 2026-09");
    expect(compiledText).toContain("not yet paid");

    await db.refundBatch.update({
      where: { id: batch.id },
      data: { status: "paid", paidAt: new Date("2026-09-30T06:00:00.000Z") },
    });

    const paidText = await extractPdfText(
      Buffer.from(await (await exportAs(request.id)).arrayBuffer()),
    );
    expect(paidText).toContain("Paid on 30.09.2026 08:00 (CEST)");
    expect(paidText).toContain("batch 2026-09");
    expect(paidText).not.toContain("not yet paid");
  });
});
