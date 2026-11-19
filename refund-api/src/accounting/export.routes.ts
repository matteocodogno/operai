/**
 * Accounting export endpoints (T18, specs/20261118-refund-accounting-export,
 * plan § API contracts "Export"; AC-4.6, AC-6.1, AC-6.5 to AC-6.12, AC-7.2, G9,
 * G10, G11; reworked by T21, specs/20261119-accounting: AC-5.3 to AC-5.6, AC-6.6,
 * AC-6.7, AC-7.2, AC-7.3, G7, D14, D17; ADR 20261118-the-accounting-export-is-
 * generated-on-request-never-stored-and-logged-append-only-with-its-content-hash-
 * and-format-version, ADR 20261119-accounting-reference-data-belongs-to-
 * accounting-api-...).
 *
 *   GET /batches/{id}/accounting-export        the summary: rows, what is left out, blockers
 *   GET /batches/{id}/accounting-export/file   the XLSX workbook, or 409 `accounting_export_blocked`
 *
 * Since 2026-11-19 (T62, SO-12) the file route replaces `…/csv`, which answers 404: it is named for what it gives, not its format.
 *
 * Who may call: `request:review` AND a review scope that covers `welld_ch`
 * (global, or entity `welld_ch`). Batch reads stay unscoped (D1 of
 * specs/20260719-refund-monthly-processing) but this file is WellD CH's books, so
 * a caller without the capability gets 403, and one scoped to another entity gets
 * 403 `accounting_export_out_of_scope` (D8, AC-6.11). The check comes BEFORE the
 * batch is looked up, so it reveals nothing about which batches exist.
 *
 * Answers
 * - 200 summary / 200 the workbook (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition`
 *   with an `.xlsx` filename, `X-Export-Row-Count`, `X-Export-Excluded-Line-Count`; CORS exposes all three, `src/index.ts`, G9).
 * - 409 `batch_discarded` on both routes (AC-6.9).
 * - 409 `accounting_export_blocked` on the file route only: its body IS the
 *   summary (G10), so the page can show the blockers from the refusal alone. It is
 *   also the answer when Accounting cannot be read while a line waits for its
 *   rate (`blockers.accountingUnavailable`, AC-6.6, D14): not a 503, and never a
 *   missing rate.
 * - 404 for an unknown batch.
 * - 500 Problem, with NO file, when the export transaction fails (the log row, a
 *   rate copy): the log is written BEFORE the body leaves (record, then deliver),
 *   so a delivered file always has a record (AC-6.10), and a failed export copies
 *   no rate to any line (AC-5.6).
 *
 * The summary writes nothing (AC-6.10); a download writes exactly one
 * `refund_batch_export` row, and, for a line whose rate was still pending, copies
 * it onto the line in the same transaction (AC-5.6). Compiling, paying and discarding a batch never
 * look at any of this (AC-6.5): this router is not on their path.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { authzMiddleware, type AuthzVariables } from "../auth/authz.middleware";
import { jwtMiddleware } from "../auth/jwt.middleware";
import { GLOBAL_ENTITY_SCOPE } from "../authz/conditions";
import { canOpenAccountingRates } from "../authz/accountingViewer";
import { scopeForReviewAction } from "../review/review.service";
import { accountingPort, type AccountingPort } from "./accountingClient";
import { exportBatchFile, prepareExport } from "./export.repo";
import {
  ExportBatchParamSchema,
  ExportBlockedSchema,
  ExportProblemSchema,
  ExportSummarySchema,
} from "./export.schemas";
import { CONTENT_TYPE, exportFilename } from "./exportFormat";

const problem = <S extends number>(status: S, title: string, path: string, detail: string, code?: string) => ({
  type: `https://httpstatuses.com/${status}`,
  title,
  status,
  detail,
  instance: path,
  ...(code !== undefined ? { code } : {}),
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const problemResponse = (description: string) => json(ExportProblemSchema, description);

/**
 * SR-5 (security review S-06): the summary and the blocked 409 name employees and receipt numbers, so, like the file,
 * they are never kept by a cache or a proxy and never sniffed into another type.
 */
function noStore(c: Context): void {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
}

const summaryRoute = createRoute({
  method: "get",
  path: "/batches/{id}/accounting-export",
  tags: ["Accounting"],
  summary: "What the accounting export of a batch contains, and what blocks it",
  description:
    "For a compiled or paid batch: the number of rows (the approved, not rejected WellD CH lines), the number of " +
    "WellD Italia lines left out (AC-6.6) and the blockers: a missing exchange rate per (currency, month) (AC-6.5), a " +
    "line with no account or VAT code, with its date and type (AC-7.2), a line with no receipt number. The file is built " +
    "from what each line holds (its account, VAT code and exchange rate copies), so a batch whose lines all hold them " +
    "is exportable with Accounting unreachable and never reads it (AC-5.4). Only a foreign-currency line whose rate is " +
    "still pending (`ratePendingLineCount`) needs Accounting here: its rate in effect is read once; none in effect is a " +
    "`missingRates` item with its `reason` (AC-6.7); Accounting unreachable is `blockers.accountingUnavailable`, never a " +
    "missing rate (AC-6.6); `fetchAttempted` says whether Accounting tried its official source for it (G10). " +
    "`viewer.canOpenAccountingRates` says whether to link a missing rate to Accounting (AC-7.3). Writes nothing (AC-6.10). " +
    "Needs `request:review` and a review scope that covers `welld_ch` (AC-6.11).",
  security: [{ Bearer: [] }],
  request: { params: ExportBatchParamSchema },
  responses: {
    200: json(ExportSummarySchema, "The summary; `exportable` is false while anything blocks"),
    403: problemResponse("No `request:review`, or `accounting_export_out_of_scope`"),
    404: problemResponse("No such batch"),
    409: problemResponse("`batch_discarded` (AC-6.9)"),
  },
});

const fileRoute = createRoute({
  method: "get",
  path: "/batches/{id}/accounting-export/file",
  tags: ["Accounting"],
  summary: "Download the accounting export of a batch as an Excel workbook",
  description:
    "An XLSX workbook, one sheet `Sheet 1`: a header `Date | Description | Debit | Credit | Amount | Currency | Tax | Note` " +
    "and one row per approved, not rejected WellD CH line (AC-6.1, AC-6.2). The same " +
    "batch exported twice with no change in between gives identical bytes (AC-6.8). 409 `accounting_export_blocked` " +
    "(its body is the summary) when anything blocks: there is never a partial file. The download is logged " +
    "(actor, batch, rows, SHA-256, format version) BEFORE the file is sent; if the log cannot be written the answer " +
    "is 500 and no file leaves (AC-6.10). A line whose rate was pending gets the rate in effect copied onto it, in the " +
    "same transaction as the log row, and the audit trail records the exporter (AC-5.6); a refused or failed export " +
    "copies nothing.",
  security: [{ Bearer: [] }],
  request: { params: ExportBatchParamSchema },
  responses: {
    200: {
      content: { [CONTENT_TYPE]: { schema: z.string().openapi({ format: "binary" }) } },
      description:
        "The file. Headers: `Content-Disposition` (attachment, `refund-accounting-<cutoff>-<batchId>.xlsx`), " +
        "`X-Export-Row-Count`, `X-Export-Excluded-Line-Count`.",
    },
    403: problemResponse("No `request:review`, or `accounting_export_out_of_scope`"),
    404: problemResponse("No such batch"),
    409: {
      content: {
        "application/json": { schema: ExportBlockedSchema.or(ExportProblemSchema) },
      },
      description: "`batch_discarded`, or `accounting_export_blocked` with the summary as its body (G10)",
    },
    500: problemResponse("The export could not be recorded, so no file was produced"),
  },
});

export interface ExportRouterDeps {
  /** How Accounting is read; the port every route reads through unless a test hands in its own. */
  readonly accounting?: AccountingPort;
}

export function createExportRouter(deps: ExportRouterDeps = {}) {
  /** Looked up per request, so a port installed by a test after the router was built is honoured. */
  const accounting = (): AccountingPort => deps.accounting ?? accountingPort();

  const router = new OpenAPIHono<{ Variables: AuthzVariables }>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          problem(
            422,
            "Unprocessable Entity",
            c.req.path,
            result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
            "invalid_export_request",
          ),
          422,
        );
      }
      return undefined;
    },
  });

  for (const path of ["/batches/:id/accounting-export", "/batches/:id/accounting-export/file"]) {
    router.use(path, jwtMiddleware);
    router.use(path, authzMiddleware);
  }

  /** `null` when the caller may export, else the refusal's problem body (always 403). */
  function refusal(authz: AuthzVariables["authz"], path: string) {
    const scope = scopeForReviewAction(authz, "review");
    if (scope === undefined) {
      return problem(403, "Forbidden", path, "You do not have permission to export refund batches");
    }
    // `null` is a conditioned grant with no entity on the caller: it covers nothing.
    if (scope !== GLOBAL_ENTITY_SCOPE && scope !== "welld_ch") {
      return problem(
        403,
        "Forbidden",
        path,
        "The accounting export is WellD CH's books: your review scope does not cover WellD CH",
        "accounting_export_out_of_scope",
      );
    }
    return null;
  }

  /** AC-7.3, D17: decided here from the caller's resolved permissions, because a browser never evaluates conditions. */
  const viewerOf = (c: Context<{ Variables: AuthzVariables }>) => {
    const authz = c.get("authz");
    return { canOpenAccountingRates: canOpenAccountingRates(authz.permissions, authz) };
  };

  router.openapi(summaryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const denied = refusal(c.get("authz"), c.req.path);
    if (denied) return c.json(denied, 403);

    const result = await prepareExport(id, accounting());
    if (result.kind === "not_found") {
      return c.json(problem(404, "Not Found", c.req.path, `Refund batch ${id} not found`), 404);
    }
    if (result.kind === "discarded") {
      return c.json(problem(409, "Conflict", c.req.path, "The batch is discarded: it has no accounting export", "batch_discarded"), 409);
    }
    noStore(c);
    return c.json({ ...result.summary, viewer: viewerOf(c) }, 200);
  });

  router.openapi(fileRoute, async (c) => {
    const { id } = c.req.valid("param");
    const denied = refusal(c.get("authz"), c.req.path);
    if (denied) return c.json(denied, 403);

    let result: Awaited<ReturnType<typeof exportBatchFile>>;
    try {
      result = await exportBatchFile(id, { userId: c.get("userId"), email: c.get("email") }, accounting());
    } catch (error) {
      // The transaction failed (the log row, a rate copy, the commit): nothing was copied, logged or sent. Only the error
      // NAME is logged: no body, no line data, no database message.
      console.error(`[accounting-export] the export of batch ${id} failed, no file sent:`, error instanceof Error ? error.name : "error");
      return c.json(
        problem(500, "Internal Server Error", c.req.path, "The export could not be recorded, so no file was produced", "export_log_failed"),
        500,
      );
    }
    if (result.kind === "not_found") {
      return c.json(problem(404, "Not Found", c.req.path, `Refund batch ${id} not found`), 404);
    }
    if (result.kind === "discarded") {
      return c.json(problem(409, "Conflict", c.req.path, "The batch is discarded: it has no accounting export", "batch_discarded"), 409);
    }
    if (result.kind === "blocked") {
      // G10: the refusal IS the summary, with the problem members around it.
      const blocked = {
        ...result.summary,
        viewer: viewerOf(c),
        ...problem(409, "Conflict", c.req.path, "The accounting export is blocked: resolve the listed items first"),
        code: "accounting_export_blocked" as const,
      };
      noStore(c);
      return c.json(blocked, 409);
    }

    const { file, summary } = result;
    return c.body(file.bytes as unknown as string, 200, {
      "Content-Type": CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${exportFilename(result.batch.cutoff, summary.batchId)}"`,
      "X-Export-Row-Count": String(file.rowCount),
      "X-Export-Excluded-Line-Count": String(summary.excludedLineCount),
      // Personal and financial data: never kept by a cache or a proxy.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  return router;
}

export const exportRouter = createExportRouter();
