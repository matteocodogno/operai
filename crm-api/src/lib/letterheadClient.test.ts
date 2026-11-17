/**
 * crm-api's render client for letterhead-api (specs/20261116-letterhead-service T27; AC-10.1, AC-10.6 to AC-10.8; plan
 * § API contracts; specs/20261117-legal-entities T28: content version 2 with the pin, AC-5.2, AC-6.2). The service is a stub
 * `fetch`: no network, no database.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../test-support/testAuth";
import type { LetterheadContent } from "../offers/blocks";
import { createLetterheadClient, LegalEntityVersionMismatch, LETTERHEAD_TIMEOUT_MS, type LetterheadClient } from "./letterheadClient";
import { ProblemError } from "./problem";
import type { ServiceTokenProvider } from "./serviceToken";

const content: LetterheadContent = {
  contentVersion: 2,
  entity: "welld_ch",
  language: "it",
  legalEntityVersion: 3,
  blocks: [{ type: "paragraph", runs: [{ text: "Gentile cliente SECRET-DOCUMENT-TEXT" }] }],
};

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 1, 2, 3]);
const previewBody = {
  letterheadVersion: 7,
  legalEntityVersion: 3,
  pageCount: 2,
  missingPlaceholders: ["iban"],
  unprintableCharacters: 0,
  pages: [
    { n: 1, image: "AAAA", text: "one" },
    { n: 2, image: "BBBB", text: "two" },
  ],
};
const pdfAnswer = (headers: Record<string, string> = {}): Response =>
  new Response(PDF, {
    status: 200,
    headers: { "Content-Type": "application/pdf", "Letterhead-Version": "7", "Legal-Entity-Version": "3", "Page-Count": "3", "Missing-Placeholders": "", "Unprintable-Characters": "0", ...headers },
  });
const problem = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ title: "x", status, code, detail: "SECRET-SERVICE-DETAIL" }), { status, headers: { "Content-Type": "application/problem+json", ...headers } });

type Answer = Response | "network-error" | "hang";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

function harness(answers: Answer[], options: { tokens?: string[]; timeoutMs?: number; now?: () => number; tokenFails?: boolean; onFetch?: () => void } = {}) {
  const calls: Call[] = [];
  const invalidated: string[] = [];
  const slept: number[] = [];
  let issued = 0;
  let current: string | null = null;
  const issue = options.tokens ?? ["t1", "t2", "t3"];
  // As the real provider: one token is cached until it is invalidated.
  const tokens: ServiceTokenProvider = {
    async getToken() {
      if (options.tokenFails) throw new Error("auth is down SECRET-TOKEN-DETAIL");
      current ??= issue[Math.min(issued++, issue.length - 1)]!;
      return current;
    },
    invalidate(token) {
      invalidated.push(token);
      if (current === token) current = null;
    },
  };
  let next = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    options.onFetch?.();
    calls.push({ url: String(url), init: init!, authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
    const answer = answers[Math.min(next++, answers.length - 1)]!;
    if (answer === "network-error") throw new TypeError("fetch failed SECRET-NETWORK-DETAIL");
    if (answer === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }
    return answer;
  }) as typeof fetch;
  const client = createLetterheadClient({
    baseUrl: "http://letterhead.test/",
    tokens,
    fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { calls, invalidated, slept, client };
}

async function refusal(promise: Promise<unknown>): Promise<ProblemError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error("the call did not fail");
}

/** What a log line, an error or its extras hold: nothing of the document, the service's text, a token or the secret. */
const LEAKS = ["SECRET-DOCUMENT-TEXT", "SECRET-SERVICE-DETAIL", "SECRET-NETWORK-DETAIL", "SECRET-TOKEN-DETAIL", "t1", "t2"];

let logged: string[] = [];
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logged = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  errorSpy.mockRestore();
});

function expectNoLeak(error: ProblemError): void {
  const everything = JSON.stringify({ message: error.message, extras: error.extras, code: error.code }) + logged.join("\n");
  for (const leak of LEAKS) expect(everything).not.toContain(leak);
}

describe("the render calls (AC-10.1, AC-10.3)", () => {
  it("posts the content as the service principal and returns the PDF with the letterhead version it was made with", async () => {
    const { client, calls } = harness([pdfAnswer({ "Missing-Placeholders": "iban, vat", "Unprintable-Characters": "2" })]);
    const rendered = await client.pdf(content);
    expect(rendered.bytes).toEqual(PDF);
    expect(rendered).toMatchObject({ letterheadVersion: 7, legalEntityVersion: 3, pageCount: 3, missingPlaceholders: ["iban", "vat"], unprintableCharacters: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://letterhead.test/v1/render/pdf");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.authorization).toBe("Bearer t1");
    expect(new Headers(calls[0]!.init.headers).get("Content-Type")).toBe("application/json");
    // A redirect would replay the credential and the document elsewhere.
    expect(calls[0]!.init.redirect).toBe("error");
    // The content as built, and no `letterheadVersion` member unless one was asked for.
    expect(calls[0]!.body).toEqual(JSON.parse(JSON.stringify(content)));
    expect("letterheadVersion" in calls[0]!.body).toBe(false);
  });

  it("sends content version 2 with the version of the issuer's details it used, and no entityData (AC-5.2)", async () => {
    const { client, calls } = harness([pdfAnswer(), new Response(JSON.stringify(previewBody), { status: 200 })]);
    await client.pdf(content);
    await client.preview(content);
    for (const call of calls) {
      expect(call.body["contentVersion"]).toBe(2);
      expect(call.body["legalEntityVersion"]).toBe(3);
      expect(call.body).not.toHaveProperty("entityData");
    }
  });

  it("a sample that prints nothing of the issuer may go without a pin: the member is not sent and no version is checked", async () => {
    const { client, calls } = harness([pdfAnswer({ "Legal-Entity-Version": "12" })]);
    const { legalEntityVersion: _, ...sample } = content;
    const rendered = await client.pdf(sample);
    expect(calls[0]!.body).not.toHaveProperty("legalEntityVersion");
    expect(rendered.legalEntityVersion).toBe(12);
  });

  it("names a letterhead version only when asked, and takes the pages a preview asks for", async () => {
    const { client, calls } = harness([pdfAnswer(), new Response(JSON.stringify(previewBody), { status: 200 })]);
    await client.pdf(content, { letterheadVersion: 4 });
    expect(calls[0]!.body["letterheadVersion"]).toBe(4);
    const preview = await client.preview(content, { pages: [1, 2] });
    expect(calls[1]!.url).toBe("http://letterhead.test/v1/render/preview?pages=1,2");
    expect(preview).toEqual(previewBody);
  });

  it("a preview without pages asks for all of them", async () => {
    const { client, calls } = harness([new Response(JSON.stringify(previewBody), { status: 200 })]);
    await client.preview(content);
    expect(calls[0]!.url).toBe("http://letterhead.test/v1/render/preview");
  });

  it("refuses a call it should not make: a letterhead version or a page that is not a positive integer", async () => {
    const { client, calls } = harness([pdfAnswer()]);
    await expect(client.pdf(content, { letterheadVersion: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(client.preview(content, { pages: [1, 0] })).rejects.toBeInstanceOf(RangeError);
    await expect(client.preview(content, { pages: [1.5] })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("is one call per request, with the shared 35 s bound", () => {
    expect(LETTERHEAD_TIMEOUT_MS).toBe(35_000);
  });
});

describe("failures are two Problems (AC-10.6, AC-10.7, AC-10.8)", () => {
  it("409 letterhead_not_configured when the service says the entity has no active letterhead; nothing of the answer is echoed", async () => {
    const { client, calls } = harness([problem(409, "letterhead_not_configured")]);
    const error = await refusal(client.pdf(content));
    expect(error.status).toBe(409);
    expect(error.code).toBe("letterhead_not_configured");
    expect(error.extras).toEqual({ entity: "welld_ch" });
    expect(calls).toHaveLength(1);
    expectNoLeak(error);
    // The preview says the same.
    const again = await refusal(harness([problem(409, "letterhead_not_configured")]).client.preview(content));
    expect(again.code).toBe("letterhead_not_configured");
  });

  it("503 layout_service_unavailable for every other answer: a refusal, a server error, a missing version, an unknown 409", async () => {
    for (const [status, code, reason] of [
      [400, "bad_request", undefined],
      [404, "letterhead_version_not_found", "letterhead_version_not_found"],
      [409, "something_else", undefined],
      [413, "request_too_large", "request_too_large"],
      [422, "invalid_content", "invalid_content"],
      [422, "header_overflow", "header_overflow"],
      // An old letterhead-api does not know content version 2: the skew fails closed (decision 6).
      [422, "unsupported_content_version", "unsupported_content_version"],
      // The service cannot read the registry within its cache rule (AC-5.5): no document, and not the caller's to fix.
      [503, "legal_entities_unavailable", "legal_entities_unavailable"],
      // The service's mismatch answer with another status is not the pin's: it is a plain refusal.
      [422, "legal_entity_version_mismatch", "legal_entity_version_mismatch"],
      [422, "footer_overflow", "footer_overflow"],
      [422, "too_many_pages", "too_many_pages"],
      [500, "internal", undefined],
      [502, "bad_gateway", undefined],
      [503, "unavailable", undefined],
      [504, "render_timeout", "render_timeout"],
    ] as const) {
      const { client, calls } = harness([problem(status, code)]);
      const error = await refusal(client.pdf(content));
      expect([status, error.status, error.code]).toEqual([status, 503, "layout_service_unavailable"]);
      // The service's own code travels as `reason` when it is one of its closed list; any other text is dropped.
      expect(error.extras).toEqual(reason === undefined ? {} : { reason });
      expect(calls).toHaveLength(1); // none of these is retried
      expectNoLeak(error);
    }
  });

  it("503 for a body that is not a problem at all, and for a status with no body", async () => {
    for (const answer of [new Response("<html>SECRET-SERVICE-DETAIL</html>", { status: 502 }), new Response(null, { status: 500 })]) {
      const error = await refusal(harness([answer]).client.pdf(content));
      expect([error.status, error.code]).toEqual([503, "layout_service_unavailable"]);
      expectNoLeak(error);
    }
  });

  it("503 when the service cannot be reached, and nothing of the network error is echoed", async () => {
    const { client, calls } = harness(["network-error"]);
    const error = await refusal(client.pdf(content));
    expect([error.status, error.code]).toEqual([503, "layout_service_unavailable"]);
    expect(calls).toHaveLength(1);
    expectNoLeak(error);
    expect(logged.join("\n")).toContain("TypeError");
  });

  it("503 on a redirect: the fetch is told to refuse it, and its refusal is the same failure", async () => {
    const { client } = harness(["network-error"]);
    expect((await refusal(client.pdf(content))).code).toBe("layout_service_unavailable");
  });

  it("503 when the call outlasts its bound (AC-10.6: times out), without a retry", async () => {
    const { client, calls } = harness(["hang"], { timeoutMs: 30 });
    const started = Date.now();
    const error = await refusal(client.pdf(content));
    expect([error.status, error.code]).toEqual([503, "layout_service_unavailable"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
  });

  it("503 when the body does not arrive in time even though the headers did (a real socket: the deadline stays armed)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("%PDF-"));
              // never closed
            },
          }),
          { status: 200, headers: { "Content-Type": "application/pdf", "Letterhead-Version": "1", "Page-Count": "1", "Unprintable-Characters": "0" } },
        ),
    });
    try {
      const tokens: ServiceTokenProvider = { getToken: async () => "t1", invalidate: () => undefined };
      const client = createLetterheadClient({ baseUrl: `http://localhost:${server.port}`, tokens, timeoutMs: 300 });
      const started = Date.now();
      const error = await refusal(client.pdf(content));
      expect(error.code).toBe("layout_service_unavailable");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await server.stop(true);
    }
  });

  it("503 when the CRM is not configured for the service: no URL, or no token provider; the service is not called", async () => {
    const tokens: ServiceTokenProvider = { getToken: async () => "t", invalidate: () => undefined };
    let fetched = 0;
    const fetchImpl = (async () => {
      fetched += 1;
      return pdfAnswer();
    }) as unknown as typeof fetch;
    const noUrl: LetterheadClient = createLetterheadClient({ baseUrl: undefined, tokens, fetchImpl });
    const noTokens: LetterheadClient = createLetterheadClient({ baseUrl: "http://letterhead.test", tokens: null, fetchImpl });
    for (const client of [noUrl, noTokens]) {
      expect((await refusal(client.pdf(content))).code).toBe("layout_service_unavailable");
      expect((await refusal(client.preview(content))).code).toBe("layout_service_unavailable");
    }
    expect(fetched).toBe(0);
  });

  it("503 when no service token can be had; nothing of the token error is echoed and the service is not called", async () => {
    const { client, calls } = harness([pdfAnswer()], { tokenFails: true });
    const error = await refusal(client.pdf(content));
    expect(error.code).toBe("layout_service_unavailable");
    expect(calls).toHaveLength(0);
    expectNoLeak(error);
  });

  it("503 for a 200 that is not the contract's: a preview body of the wrong shape, a PDF without its headers or bytes", async () => {
    const badPreviews = [{}, { ...previewBody, pageCount: "2" }, { ...previewBody, pages: [{ n: 1, image: 5, text: "" }] }, { ...previewBody, missingPlaceholders: [1] }, { ...previewBody, letterheadVersion: 0 }, []];
    for (const body of badPreviews) {
      const error = await refusal(harness([new Response(JSON.stringify(body), { status: 200 })]).client.preview(content));
      expect(error.code).toBe("layout_service_unavailable");
    }
    expect((await refusal(harness([new Response("not json", { status: 200 })]).client.preview(content))).code).toBe("layout_service_unavailable");

    const bad: Response[] = [
      pdfAnswer({ "Content-Type": "text/html" }),
      new Response(PDF, { status: 200, headers: { "Content-Type": "application/pdf", "Page-Count": "3", "Unprintable-Characters": "0" } }), // no Letterhead-Version
      pdfAnswer({ "Letterhead-Version": "0" }),
      pdfAnswer({ "Letterhead-Version": "seven" }),
      pdfAnswer({ "Page-Count": "" }),
      new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), { status: 200, headers: { "Content-Type": "application/pdf", "Letterhead-Version": "7", "Page-Count": "1", "Unprintable-Characters": "0" } }),
    ];
    for (const answer of bad) expect((await refusal(harness([answer]).client.pdf(content))).code).toBe("layout_service_unavailable");
  });
});

describe("the pin on the issuer's details (decision 8, AC-6.2)", () => {
  const mismatch = (extra: Record<string, unknown> = { currentVersion: 4 }) =>
    new Response(JSON.stringify({ title: "x", status: 409, code: "legal_entity_version_mismatch", detail: "SECRET-SERVICE-DETAIL", ...extra }), {
      status: 409,
      headers: { "Content-Type": "application/problem+json" },
    });

  it("409 legal_entity_version_mismatch is a LegalEntityVersionMismatch: the service's version is kept, it is a 503 layout_service_unavailable for a caller that does not retry, and it is not retried here", async () => {
    for (const call of [(client: LetterheadClient) => client.pdf(content), (client: LetterheadClient) => client.preview(content)]) {
      const { client, calls } = harness([mismatch(), pdfAnswer()]);
      const error = await refusal(call(client));
      expect(error).toBeInstanceOf(LegalEntityVersionMismatch);
      expect((error as LegalEntityVersionMismatch).currentVersion).toBe(4);
      expect([error.status, error.code]).toEqual([503, "layout_service_unavailable"]);
      expect(error.extras).toEqual({ reason: "legal_entity_version_mismatch" });
      expect(calls).toHaveLength(1);
      expectNoLeak(error);
    }
  });

  it("the current version is kept only when it is a positive whole number", async () => {
    for (const extra of [{}, { currentVersion: "4" }, { currentVersion: 0 }, { currentVersion: 1.5 }]) {
      const error = await refusal(harness([mismatch(extra)]).client.pdf(content));
      expect(error).toBeInstanceOf(LegalEntityVersionMismatch);
      expect((error as LegalEntityVersionMismatch).currentVersion).toBeNull();
    }
  });

  it("503 legal_entities_unavailable (with Retry-After) is the plain unavailable answer, never retried and never a mismatch", async () => {
    const { client, calls, slept } = harness([problem(503, "legal_entities_unavailable", { "Retry-After": "5" }), pdfAnswer()]);
    const error = await refusal(client.pdf(content));
    expect(error).not.toBeInstanceOf(LegalEntityVersionMismatch);
    expect([error.status, error.code, error.extras]).toEqual([503, "layout_service_unavailable", { reason: "legal_entities_unavailable" }]);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("an answer that does not name the pinned version is not usable: one PDF never mixes two versions of the details", async () => {
    const wrongBody = { ...previewBody, legalEntityVersion: 2 };
    const { legalEntityVersion: _, ...bodyWithout } = previewBody;
    for (const body of [wrongBody, bodyWithout, { ...previewBody, legalEntityVersion: 0 }]) {
      const error = await refusal(harness([new Response(JSON.stringify(body), { status: 200 })]).client.preview(content));
      expect([error.status, error.code]).toEqual([503, "layout_service_unavailable"]);
    }
    for (const headers of [{ "Legal-Entity-Version": "2" }, { "Legal-Entity-Version": "" }, { "Legal-Entity-Version": "0" }, { "Legal-Entity-Version": "three" }]) {
      expect((await refusal(harness([pdfAnswer(headers)]).client.pdf(content))).code).toBe("layout_service_unavailable");
    }
    const missing = new Response(PDF, { status: 200, headers: { "Content-Type": "application/pdf", "Letterhead-Version": "7", "Page-Count": "3", "Unprintable-Characters": "0" } });
    expect((await refusal(harness([missing]).client.pdf(content))).code).toBe("layout_service_unavailable");
  });
});

describe("no retry storm (AC-10.6): one retry at most, whatever the reason", () => {
  it("429 busy: waits the answer's Retry-After once and asks again", async () => {
    const { client, calls, slept } = harness([problem(429, "busy", { "Retry-After": "1" }), pdfAnswer()]);
    const rendered = await client.pdf(content);
    expect(rendered.letterheadVersion).toBe(7);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([1_000]);
    // The same document and the same token.
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(calls[1]!.authorization).toBe("Bearer t1");
  });

  it("429 twice: the second one is the answer, 503; exactly two requests and one wait", async () => {
    const { client, calls, slept } = harness([problem(429, "busy", { "Retry-After": "2" }), problem(429, "busy", { "Retry-After": "2" }), pdfAnswer()]);
    const error = await refusal(client.pdf(content));
    expect([error.status, error.code]).toEqual([503, "layout_service_unavailable"]);
    expect(error.extras).toEqual({ reason: "busy" });
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([2_000]);
  });

  it("429 without Retry-After waits 2 s (the service's own); with a date it waits until then", async () => {
    const none = harness([problem(429, "busy"), pdfAnswer()]);
    await none.client.pdf(content);
    expect(none.slept).toEqual([2_000]);

    let clock = 1_000_000;
    const dated = harness([problem(429, "busy", { "Retry-After": new Date(clock + 3_000).toUTCString() }), pdfAnswer()], { now: () => clock });
    await dated.client.pdf(content);
    expect(dated.slept[0]).toBeGreaterThanOrEqual(2_000);
    expect(dated.slept[0]).toBeLessThanOrEqual(3_000);

    clock = 0;
    const garbage = harness([problem(429, "busy", { "Retry-After": "soon" }), pdfAnswer()]);
    await garbage.client.pdf(content);
    expect(garbage.slept).toEqual([2_000]);
  });

  it("a Retry-After of 0 retries at once; one beyond 5 s is not waited for: 503 after a single request", async () => {
    const zero = harness([problem(429, "busy", { "Retry-After": "0" }), pdfAnswer()]);
    await zero.client.pdf(content);
    expect(zero.slept).toEqual([0]);

    const long = harness([problem(429, "busy", { "Retry-After": "30" }), pdfAnswer()]);
    const error = await refusal(long.client.pdf(content));
    expect(error.code).toBe("layout_service_unavailable");
    expect(long.calls).toHaveLength(1);
    expect(long.slept).toEqual([]);
  });

  it("does not retry when the wait does not fit in what is left of the 35 s", async () => {
    let clock = 0;
    // The 429 arrives 34.5 s after the call started: 0.5 s are left, the wait is 2 s.
    const { client, calls, slept } = harness([problem(429, "busy", { "Retry-After": "2" }), pdfAnswer()], { now: () => clock, onFetch: () => (clock += 34_500) });
    const error = await refusal(client.pdf(content));
    expect(error.code).toBe("layout_service_unavailable");
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("401: drops that token, retries once with a fresh one; a second 401 is the answer (a configuration fault is not looped on)", async () => {
    const ok = harness([problem(401, "unauthorized"), pdfAnswer()]);
    await ok.client.pdf(content);
    expect(ok.invalidated).toEqual(["t1"]);
    expect(ok.calls.map((call) => call.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
    expect(ok.slept).toEqual([]);

    const twice = harness([problem(401, "unauthorized"), problem(401, "unauthorized"), pdfAnswer()]);
    const error = await refusal(twice.client.pdf(content));
    expect(error.code).toBe("layout_service_unavailable");
    expect(twice.calls).toHaveLength(2);
    expect(twice.invalidated).toEqual(["t1"]);
  });

  it("a 401 then a 429, and a 429 then a 401, are still ONE retry in all", async () => {
    const a = harness([problem(401, "unauthorized"), problem(429, "busy", { "Retry-After": "1" }), pdfAnswer()]);
    expect((await refusal(a.client.pdf(content))).code).toBe("layout_service_unavailable");
    expect(a.calls).toHaveLength(2);
    expect(a.slept).toEqual([]);

    const b = harness([problem(429, "busy", { "Retry-After": "1" }), problem(401, "unauthorized"), pdfAnswer()]);
    expect((await refusal(b.client.pdf(content))).code).toBe("layout_service_unavailable");
    expect(b.calls).toHaveLength(2);
    expect(b.slept).toEqual([1_000]);
  });

  it("a server error is never retried: the generation's transaction rolls back and the person tries again", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { client, calls } = harness([problem(status, "x"), pdfAnswer()]);
      await refusal(client.pdf(content));
      expect(calls).toHaveLength(1);
    }
  });
});
