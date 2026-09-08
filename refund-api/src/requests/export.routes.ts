/**
 * GET /requests/:id/export — the per-request archive PDF (ADR-0043).
 *
 * Its own router module, not an addition to `requests.routes.ts`, for the
 * reason `test-support/testAuth.ts` documents: no two test FILES may import
 * the same router specifier, and this endpoint's tests need their own.
 *
 * ACCESS reuses `canReadRequest` verbatim — the owner, or an accounting
 * reviewer whose entity scope the request falls in. No new catalog
 * permission, by ADR-0042's reconstructibility test: a holder of the
 * existing grant can already see every line and open every receipt through
 * the presigned GETs, so this endpoint withholds nothing they lack and a new
 * permission would advertise a control that does not exist. Denials are 404,
 * never 403, matching `GET /requests/:id` (ADR-0005 "not yours = not found")
 * — an export route must not become the one place existence leaks.
 *
 * APPROVED-ONLY (409 otherwise). The feature exists to archive a finished
 * financial record; a draft's mileage is still recomputed on every read
 * (specs/009 Decision 1) and a submitted request has no approved figures at
 * all, so a PDF of either would be a snapshot of something still moving —
 * exactly the thing an archive must not be. `paid` is deliberately allowed
 * too: it is `approved` that has since been paid out, and refusing to
 * archive a request BECAUSE it completed would be absurd.
 *
 * MEMORY. This is the one route in the service that pulls receipt bytes into
 * the process (ADR-0043's departure from ADR-0016). `MAX_EXPORT_RECEIPT_BYTES`
 * is enforced from the DB's `sizeBytes` column BEFORE a single object is
 * fetched, so an oversized request costs one query and a 413 rather than a
 * partially-downloaded heap.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { db } from "../lib/db";
import { getObject, MAX_EXPORT_RECEIPT_BYTES } from "../lib/storage";
import { findRequestWithLines } from "./requests.repo";
import { ProblemSchema, RequestIdParamSchema } from "./requests.schemas";
import { canReadRequest, mapRequestDetail } from "./requests.service";
import { formatBatchPeriod, formatFilePeriod, formatPeriod, formatTimestamp } from "./documentFormat";
import { hydrateDraftMileageLines } from "./mileageHydration";
import {
  renderRequestExportPdf,
  ReceiptEmbedError,
  type ExportReceipt,
} from "./exportPdf";

const problem = (status: 404 | 409 | 413 | 502, title: string, path: string, detail: string) => ({
  type: `https://httpstatuses.com/${status}`,
  title,
  status,
  detail,
  instance: path,
});

/**
 * Where a request stands in the monthly payout cycle, as a sentence.
 *
 * The three states a reader cares about are "nobody has picked this up yet",
 * "it is in a batch that has not paid out" and "it is settled" — the middle
 * one being the easiest to mistake for the last if the document only said
 * "Approved". A discarded batch releases its requests back to the pool
 * (ADR-0020), so `batchId` is null again and the first case covers it
 * correctly with no special-casing.
 */
function describeSettlement(
  batch: { status: string; cutoff: Date; paidAt: Date | null } | null,
): string {
  if (!batch) return "Approved — not yet included in a monthly batch";

  const period = formatBatchPeriod(batch.cutoff);
  if (batch.status === "paid" && batch.paidAt) {
    return `Paid on ${formatTimestamp(batch.paidAt)} — batch ${period}`;
  }
  return `Included in batch ${period} — compiled, not yet paid`;
}

/**
 * `refund_2026-08_camerini_CHF-206.50.pdf` — a filename someone can file,
 * sort and find, replacing `refund-request-<cuid>.pdf`.
 *
 * A cuid is unsortable in a folder and unquotable over the phone. Everything
 * here is derived from data already on the record, so it needs no new column;
 * a stable human REFERENCE (REF-2026-0087) does need one, and is deliberately
 * left to its own change rather than faked from a hash.
 *
 * The amount uses a DOT decimal, alone in this document — `206,50` in a
 * filename invites a comma-separated-list misread and some tools quote or
 * mangle it. Filenames are addresses, not prose.
 */
function exportFileName(input: {
  period: string | null;
  ownerEmail: string;
  subtotals: readonly { currency: string; requestedCents: number; approvedCents: number | null }[];
  requestId: string;
}): string {
  const safe = (value: string): string =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // "luca.camerini@welld.ch" → "camerini". A surname is what a human looks
  // for; the full local part just repeats the folder they are already in.
  const local = input.ownerEmail.split("@")[0] ?? "";
  const surname = safe(local.split(".").pop() || local).toLowerCase();

  const amounts = input.subtotals
    .map((s) => {
      const cents = s.approvedCents ?? s.requestedCents;
      return `${s.currency}-${Math.trunc(cents / 100)}.${(Math.abs(cents) % 100).toString().padStart(2, "0")}`;
    })
    .join("_");

  const parts = ["refund", input.period ?? "", surname, amounts].filter(Boolean);
  // The cuid still ends the name: two requests by the same person in the same
  // month for the same total would otherwise collide in a download folder.
  return `${parts.map(safe).join("_")}_${input.requestId}.pdf`;
}

export const requestExportRouter = new OpenAPIHono<{ Variables: AuthzVariables }>();

requestExportRouter.use("/requests/:id/export", jwtMiddleware);
requestExportRouter.use("/requests/:id/export", authzMiddleware);

/** Statuses whose figures are final enough to archive. See the module doc. */
const ARCHIVABLE_STATUSES = new Set(["approved", "paid"]);

const exportRoute = createRoute({
  method: "get",
  path: "/requests/{id}/export",
  tags: ["Requests"],
  summary: "Export an approved refund request as an archive PDF",
  description:
    "Returns a self-contained PDF: every expense line (with its mileage rate " +
    "provenance) plus every stored receipt embedded in full — a PDF receipt " +
    "is copied page-for-page, a JPEG/PNG is embedded as an image. Approved " +
    "and paid requests only (409 otherwise). 404 — never 403 — if the caller " +
    "is neither the owner nor an in-scope accounting reviewer. 413 if the " +
    "request's receipts exceed the export byte budget; 502 if a stored " +
    "receipt cannot be embedded (the archive is never silently incomplete).",
  security: [{ Bearer: [] }],
  request: { params: RequestIdParamSchema },
  responses: {
    200: {
      content: { "application/pdf": { schema: z.string() } },
      description: "The archive PDF",
    },
    401: { description: "Missing or invalid Bearer JWT" },
    404: {
      content: { "application/json": { schema: ProblemSchema } },
      description:
        "Not found, not owned, not in the caller's review scope, or the " +
        "caller holds no relevant capability — every denial is 404 so " +
        "existence is never leaked (ADR-0005, matching GET /requests/:id)",
    },
    409: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "The request is not in an archivable status",
    },
    413: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "The request's receipts exceed the export byte budget",
    },
    502: {
      content: { "application/json": { schema: ProblemSchema } },
      description: "A stored receipt could not be embedded",
    },
  },
});

requestExportRouter.openapi(exportRoute, async (c) => {
  const sub = c.get("userId");
  const email = c.get("email") as string;
  const authz = c.get("authz");
  const { id } = c.req.valid("param");

  const exit = await Effect.runPromiseExit(findRequestWithLines(id));
  if (exit._tag === "Failure") {
    throw new Error("Unexpected database failure fetching refund request");
  }

  const request = exit.value;
  if (!request || !canReadRequest(request, authz, sub)) {
    return c.json(
      problem(404, "Not Found", c.req.path, `Refund request ${id} not found`),
      404,
    );
  }

  if (!ARCHIVABLE_STATUSES.has(request.status)) {
    return c.json(
      problem(
        409,
        "Conflict",
        c.req.path,
        `Only an approved or paid request can be exported; this one is ${request.status}`,
      ),
      409,
    );
  }

  // Settlement state. Its own query rather than widening the shared
  // `findRequestWithLines` include, which every other request route also uses:
  // only this document needs the batch's status and cutoff.
  const claimed = await db.refundRequest.findUnique({
    where: { id },
    select: { batch: { select: { status: true, cutoff: true, paidAt: true } } },
  });
  const settlement = describeSettlement(claimed?.batch ?? null);

  // An archivable request is never a draft, so this is a pass-through — but
  // routing through the same helper as GET /requests/:id keeps the exported
  // figures identical to the on-screen ones by construction.
  const hydrationExit = await Effect.runPromiseExit(
    hydrateDraftMileageLines(request.lines, request.status),
  );
  if (hydrationExit._tag === "Failure") {
    throw new Error("Unexpected database failure resolving mileage rates");
  }
  const detail = mapRequestDetail({ ...request, lines: hydrationExit.value });

  // ── Budget check BEFORE any download (see module doc) ────────────────────
  //
  // Attachments are re-queried here rather than read off `request.lines`
  // because the shared `LineRow` type deliberately omits `objectKey` — that
  // column must never be reachable from a shape that gets mapped into an API
  // response. This is the only place in the service that needs it.
  const stored = await db.attachment.findMany({
    where: { line: { requestId: id }, uploadStatus: "stored" },
    orderBy: [{ line: { createdAt: "asc" } }, { createdAt: "asc" }],
    select: {
      id: true,
      fileName: true,
      contentType: true,
      sizeBytes: true,
      objectKey: true,
      line: { select: { motivo: true, date: true } },
    },
  });
  const totalBytes = stored.reduce((sum, a) => sum + a.sizeBytes, 0);
  if (totalBytes > MAX_EXPORT_RECEIPT_BYTES) {
    return c.json(
      problem(
        413,
        "Payload Too Large",
        c.req.path,
        `This request's ${stored.length} receipt(s) total ${totalBytes} bytes, ` +
          `over the ${MAX_EXPORT_RECEIPT_BYTES}-byte export limit. ` +
          "Ask an administrator to export it another way rather than treating " +
          "a partial archive as complete.",
      ),
      413,
    );
  }

  let receipts: ExportReceipt[];
  try {
    receipts = await Promise.all(
      stored.map(async (attachment) => ({
        attachmentId: attachment.id,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        bytes: await getObject(attachment.objectKey),
        lineMotivo: attachment.line.motivo,
        lineDate: attachment.line.date.toISOString().slice(0, 10),
      })),
    );
  } catch (error) {
    // The object key is an internal identifier; the request id is what an
    // operator needs. No file names or bytes in the log (data residency).
    console.error(
      `[export] failed to read a stored receipt for refund request ${id}:`,
      error instanceof Error ? error.message : error,
    );
    return c.json(
      problem(
        502,
        "Bad Gateway",
        c.req.path,
        "A stored receipt could not be read from object storage, so a complete " +
          "archive cannot be produced. No partial PDF was returned.",
      ),
      502,
    );
  }

  let pdf: Buffer;
  try {
    pdf = await renderRequestExportPdf({
      requestId: detail.id,
      status: detail.status,
      owner: { email: detail.owner.email, name: detail.owner.name },
      submittedAt: detail.submittedAt,
      decidedAt: detail.decidedAt,
      decidedByEmail: detail.decidedBy?.email ?? null,
      lines: detail.lines,
      subtotals: detail.subtotals,
      receipts,
      generatedAt: new Date(),
      generatedByEmail: email,
      settlement,
    });
  } catch (error) {
    if (error instanceof ReceiptEmbedError) {
      console.error(`[export] ${error.message} (refund request ${id})`);
      return c.json(
        problem(
          502,
          "Bad Gateway",
          c.req.path,
          `The stored receipt "${error.fileName}" could not be embedded, so a ` +
            "complete archive cannot be produced. No partial PDF was returned.",
        ),
        502,
      );
    }
    throw error;
  }

  const fileName = exportFileName({
    period: formatFilePeriod(detail.lines.map((line) => line.date)),
    ownerEmail: detail.owner.email,
    subtotals: detail.subtotals,
    requestId: id,
  });

  c.header("Content-Type", "application/pdf");
  c.header("Content-Disposition", `attachment; filename="${fileName}"`);
  // Personal financial data — never cached by an intermediary (ADR-0041's
  // no-store posture, extended from the JWT to derived personal documents).
  c.header("Cache-Control", "no-store");
  return c.body(pdf as unknown as ArrayBuffer);
});
