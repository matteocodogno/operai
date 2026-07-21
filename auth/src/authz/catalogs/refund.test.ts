/**
 * Unit tests for refund's declared catalog constant (T2,
 * specs/007-refund-service — refs AC-1.1, AC-5.4, AC-7.5, AC-8.2). Pure
 * structural checks — no DB, no registration — the registration path itself
 * (`upsertAppCatalog` via `seedRefundCatalog`) is covered by `../seed.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { REFUND_APP_ID, REFUND_CATALOG } from "./refund";

describe("REFUND_CATALOG (T2, AC-1.1/5.4/7.5/8.2)", () => {
  test("declares appId `refund`", () => {
    expect(REFUND_APP_ID).toBe("refund");
    expect(REFUND_CATALOG.appId).toBe(REFUND_APP_ID);
  });

  test("declares the app-access resource with a single, condition-free `access` action", () => {
    const accessResource = REFUND_CATALOG.resources.find((r) => r.key === REFUND_APP_ID);
    expect(accessResource).toBeDefined();
    expect(accessResource?.actions).toHaveLength(1);
    expect(accessResource?.actions[0]).toEqual({
      key: "access",
      label: "Access",
      supportedConditions: [],
    });
  });

  test("declares the `request` resource with exactly create/read/review/set-approved-total/approve/reject", () => {
    const requestResource = REFUND_CATALOG.resources.find((r) => r.key === "request");
    expect(requestResource).toBeDefined();
    expect(requestResource?.actions.map((a) => a.key).sort()).toEqual(
      ["approve", "create", "read", "reject", "review", "set-approved-total"].sort(),
    );
  });

  test("`create` supports no conditions — the creator simply owns what they create", () => {
    const requestResource = REFUND_CATALOG.resources.find((r) => r.key === "request");
    const create = requestResource?.actions.find((a) => a.key === "create");
    expect(create?.supportedConditions).toEqual([]);
  });

  test("`read` supports only `ownership` — an employee reads their own requests", () => {
    const requestResource = REFUND_CATALOG.resources.find((r) => r.key === "request");
    const read = requestResource?.actions.find((a) => a.key === "read");
    expect(read?.supportedConditions).toEqual(["ownership"]);
  });

  test("review/set-approved-total/reject each support only `entity` (ADR-0015)", () => {
    const requestResource = REFUND_CATALOG.resources.find((r) => r.key === "request");
    for (const key of ["review", "set-approved-total", "reject"]) {
      const action = requestResource?.actions.find((a) => a.key === key);
      expect(action?.supportedConditions).toEqual(["entity"]);
    }
  });

  test("declares exactly three resources — app access, `request`, and `rate` — nothing else", () => {
    expect(REFUND_CATALOG.resources.map((r) => r.key).sort()).toEqual(
      ["rate", "refund", "request"].sort(),
    );
  });
});

describe("REFUND_CATALOG self-approval condition (T1, specs/010-self-approval-control — AC-4.3, AC-5.1; ADR-0026)", () => {
  test("`approve` supports both `entity` and `self-approval` — the declared surface grows from one to two", () => {
    const requestResource = REFUND_CATALOG.resources.find((r) => r.key === "request");
    const approve = requestResource?.actions.find((a) => a.key === "approve");
    expect(approve?.supportedConditions).toEqual(["entity", "self-approval"]);
  });

  test("`self-approval` is declared on `approve` ONLY — absent from every other action, on every resource", () => {
    const declaring = REFUND_CATALOG.resources.flatMap((resource) =>
      resource.actions
        .filter((action) => action.supportedConditions.includes("self-approval"))
        .map((action) => `${resource.key}.${action.key}`),
    );
    expect(declaring).toEqual(["request.approve"]);
  });
});

describe("REFUND_CATALOG `rate` resource (T1, specs/009-mileage-rate)", () => {
  test("declares exactly `read` and `manage` actions", () => {
    const rateResource = REFUND_CATALOG.resources.find((r) => r.key === "rate");
    expect(rateResource).toBeDefined();
    expect(rateResource?.actions.map((a) => a.key).sort()).toEqual(["manage", "read"]);
  });

  test("`read` and `manage` are both UNCONDITIONED — no entity scope, unlike `request` (Decision 2)", () => {
    const rateResource = REFUND_CATALOG.resources.find((r) => r.key === "rate");
    for (const key of ["read", "manage"]) {
      const action = rateResource?.actions.find((a) => a.key === key);
      expect(action?.supportedConditions).toEqual([]);
    }
  });
});
