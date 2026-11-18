/**
 * The outbound client (T9, specs/20261118-refund-accounting-export; AC-5.6;
 * security surface 3). No test here touches the network: the fetcher is a fake.
 */

import { describe, expect, it } from "bun:test";
import {
  BAZG_HOST,
  bazgUrl,
  fetchBazgMonth,
  FX_MAX_BODY_BYTES,
  type FxFetcher,
} from "./bazgSource";

const ok = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

describe("bazgUrl", () => {
  it("is a constant https host and a validated year and month", () => {
    expect(bazgUrl("2026-03")).toBe("https://www.backend-rates.bazg.admin.ch/api/xmlavgmonth?j=2026&m=03");
    expect(BAZG_HOST).toBe("www.backend-rates.bazg.admin.ch");
  });

  it("refuses anything that is not YYYY-MM, so no input can reshape the URL", () => {
    for (const bad of ["2026-3", "2026-13", "2026-03&x=1", "../x", "", "2026-03-01", "evil.example/?"]) {
      expect(() => bazgUrl(bad)).toThrow(RangeError);
    }
  });
});

describe("fetchBazgMonth", () => {
  it("returns the body and the exact URL, asking with redirect:error and a signal", async () => {
    const seen: { url: string; redirect: string; hasSignal: boolean }[] = [];
    const fetcher: FxFetcher = async (url, init) => {
      seen.push({ url, redirect: init.redirect, hasSignal: init.signal instanceof AbortSignal });
      return ok("<x/>");
    };
    const res = await fetchBazgMonth("2026-03", { fetcher });
    expect(res).toEqual({ ok: true, url: bazgUrl("2026-03"), body: "<x/>" });
    expect(seen).toEqual([{ url: bazgUrl("2026-03"), redirect: "error", hasSignal: true }]);
  });

  it("reports an HTTP error status as http_<status>", async () => {
    for (const status of [404, 429, 500, 503]) {
      const res = await fetchBazgMonth("2026-03", { fetcher: async () => new Response("no", { status }) });
      expect(res).toMatchObject({ ok: false, code: `http_${status}` });
    }
  });

  it("treats a thrown fetch (DNS, TLS, a refused redirect) as `network`, without the message", async () => {
    const res = await fetchBazgMonth("2026-03", {
      fetcher: async () => {
        throw new TypeError("redirect mode is set to error: https://evil.example/");
      },
    });
    expect(res).toEqual({ ok: false, url: bazgUrl("2026-03"), code: "network" });
  });

  it("times out a call that never answers, as `timeout`", async () => {
    const fetcher: FxFetcher = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    const res = await fetchBazgMonth("2026-03", { fetcher, callTimeoutMs: 30 });
    expect(res).toMatchObject({ ok: false, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("the caller's own signal (the whole-trigger budget) also ends it as `timeout`", async () => {
    const fetcher: FxFetcher = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const res = await fetchBazgMonth("2026-03", { fetcher, signal: AbortSignal.timeout(20), callTimeoutMs: 5000 });
    expect(res).toMatchObject({ ok: false, code: "timeout" });
  });

  it("refuses a body over the cap, by Content-Length without reading it", async () => {
    let read = false;
    const body = new ReadableStream({
      pull(controller) {
        read = true;
        controller.enqueue(new Uint8Array(10));
      },
    }, { highWaterMark: 0 });
    const res = await fetchBazgMonth("2026-03", {
      fetcher: async () => new Response(body, { status: 200, headers: { "content-length": String(FX_MAX_BODY_BYTES + 1) } }),
    });
    expect(res).toMatchObject({ ok: false, code: "too_large" });
    expect(read).toBe(false);
  });

  it("stops reading a stream with no length once it passes the cap", async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(100 * 1024));
        if (chunks > 1000) controller.close();
      },
    });
    const res = await fetchBazgMonth("2026-03", { fetcher: async () => new Response(body, { status: 200 }) });
    expect(res).toMatchObject({ ok: false, code: "too_large" });
    expect(chunks).toBeLessThan(20);
  });

  it("accepts a body exactly at the cap and decodes UTF-8", async () => {
    const text = "Ä".repeat(10);
    const res = await fetchBazgMonth("2026-03", { fetcher: async () => ok(text), maxBytes: new TextEncoder().encode(text).length });
    expect(res).toMatchObject({ ok: true, body: text });
  });
});
