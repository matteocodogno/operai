/**
 * crm-api's read of projects-api (specs/022 T10, T21, AC-3.4, ADR-0060): `GET
 * /system/purchase-orders?dealIds=` as the service principal, to show a deal's project and Bexio
 * order id on the deal page. The read FAILS SOFT: nothing here throws, and "projects-api did not
 * answer" is `known: false`, distinct from "answered, this deal has no purchase order" (`known:
 * true`, `delivery: null`).
 */

import { describe, expect, it, spyOn } from "bun:test";
import "../test-support/testAuth";
import { createProjectsReader, projectsReaderFromEnv } from "./projects";
import type { ServiceTokenProvider } from "./serviceToken";

type Answer = { status: number; body?: unknown } | "network-error";

function harness(answers: Answer[] = [{ status: 200, body: { items: [] } }], tokensIssued: string[] = ["t1", "t2"]) {
  const calls: { url: string; authorization: string | null }[] = [];
  const invalidated: string[] = [];
  let issued = 0;
  const tokens: ServiceTokenProvider = {
    async getToken() {
      return tokensIssued[Math.min(issued++, tokensIssued.length - 1)]!;
    },
    invalidate(token) {
      invalidated.push(token);
    },
  };
  let next = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization") });
    const answer = answers[Math.min(next++, answers.length - 1)]!;
    if (answer === "network-error") throw new TypeError("fetch failed");
    return Response.json(answer.body ?? {}, { status: answer.status });
  }) as typeof fetch;
  return { calls, invalidated, reader: createProjectsReader({ baseUrl: "http://projects.test", tokens, fetchImpl }) };
}

const item = (over: Record<string, unknown> = {}) => ({
  dealId: "deal-1",
  purchaseOrderId: "purchase-order-1",
  project: { id: "project-1", name: "Koordy" },
  bexioOrderId: "BX-1001",
  ...over,
});

describe("createProjectsReader().deliveryOf(dealId)", () => {
  it("reads the deal's purchase order as the service principal and returns its project and Bexio order id", async () => {
    const { calls, reader } = harness([{ status: 200, body: { items: [item()] } }]);
    expect(await reader.deliveryOf("deal-1")).toEqual({
      known: true,
      delivery: { project: { id: "project-1", name: "Koordy" }, bexioOrderId: "BX-1001" },
    });
    expect(calls).toEqual([{ url: "http://projects.test/system/purchase-orders?dealIds=deal-1", authorization: "Bearer t1" }]);
  });

  it("keeps an empty Bexio order id as null", async () => {
    const { reader } = harness([{ status: 200, body: { items: [item({ bexioOrderId: null })] } }]);
    expect(await reader.deliveryOf("deal-1")).toMatchObject({ known: true, delivery: { bexioOrderId: null } });
  });

  it("answers `known: true` with no delivery when projects-api has no purchase order for the deal", async () => {
    const { reader } = harness([{ status: 200, body: { items: [] } }]);
    expect(await reader.deliveryOf("deal-1")).toEqual({ known: true, delivery: null });
  });

  it("ignores a purchase order that is not the deal's own", async () => {
    const { reader } = harness([{ status: 200, body: { items: [item({ dealId: "deal-2" })] } }]);
    expect(await reader.deliveryOf("deal-1")).toEqual({ known: true, delivery: null });
  });

  it("answers `known: false`, never throws, when projects-api is down, unreachable or answers nonsense", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const answer of [
        { status: 503 },
        { status: 500 },
        { status: 400 },
        "network-error" as const,
        { status: 200, body: { nope: true } },
        { status: 200, body: { items: [{ dealId: "deal-1", project: null }] } },
      ] satisfies Answer[]) {
        expect(await harness([answer]).reader.deliveryOf("deal-1")).toEqual({ known: false, delivery: null });
      }
    } finally {
      quiet.mockRestore();
    }
  });

  it("drops the token and retries once on a 401, then gives up quietly", async () => {
    const retried = harness([{ status: 401 }, { status: 200, body: { items: [item()] } }]);
    expect(await retried.reader.deliveryOf("deal-1")).toMatchObject({ known: true, delivery: { project: { id: "project-1" } } });
    expect(retried.calls.map((c) => c.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
    expect(retried.invalidated).toEqual(["t1"]);

    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const refused = harness([{ status: 401 }]);
      expect(await refused.reader.deliveryOf("deal-1")).toEqual({ known: false, delivery: null });
      expect(refused.calls).toHaveLength(2);
    } finally {
      quiet.mockRestore();
    }
  });

  it("never logs the token or the body of an answer", async () => {
    const logged: string[] = [];
    const quiet = spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.join(" ")));
    try {
      await harness([{ status: 500, body: { detail: "secret-body-detail" } }], ["secret-token"]).reader.deliveryOf("deal-1");
    } finally {
      quiet.mockRestore();
    }
    expect(logged.join("\n")).not.toContain("secret-token");
    expect(logged.join("\n")).not.toContain("secret-body-detail");
  });
});

describe("projectsReaderFromEnv()", () => {
  const configured = {
    PROJECTS_INTERNAL_URL: "http://projects.test",
    SERVICE_CLIENT_ID: "crm-api",
    SERVICE_CLIENT_SECRET: "a-service-client-secret-of-32-chars-or-more",
    AUTH_BASE_URL: "http://auth.test",
  };

  it("is null (delivery unknown) without PROJECTS_INTERNAL_URL or without the service client", () => {
    expect(projectsReaderFromEnv({ ...configured, PROJECTS_INTERNAL_URL: undefined })).toBeNull();
    expect(projectsReaderFromEnv({ ...configured, SERVICE_CLIENT_ID: undefined })).toBeNull();
    expect(projectsReaderFromEnv({ ...configured, SERVICE_CLIENT_SECRET: undefined })).toBeNull();
  });

  it("trades the crm-api service client for the token it reads projects-api with", async () => {
    const calls: { url: string; body: unknown; authorization: string | null }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      calls.push({
        url: href,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (href.endsWith("/system/service-token")) return Response.json({ token: "minted-jwt", expiresInSeconds: 300 });
      return Response.json({ items: [item()] });
    }) as typeof fetch;

    const reader = projectsReaderFromEnv(configured, fetchImpl);
    expect(reader).not.toBeNull();
    expect(await reader!.deliveryOf("deal-1")).toMatchObject({ known: true, delivery: { project: { name: "Koordy" } } });

    expect(calls[0]).toMatchObject({
      url: "http://auth.test/system/service-token",
      body: { clientId: "crm-api", clientSecret: configured.SERVICE_CLIENT_SECRET },
    });
    expect(calls[1]).toMatchObject({
      url: "http://projects.test/system/purchase-orders?dealIds=deal-1",
      authorization: "Bearer minted-jwt",
    });
  });
});
