import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createGoogleAuth } from "../lib/google/auth";
import { LanguageModelError, type OutputSchema } from "./languageModel";
import { createVertexClient, createVertexLanguageModel, vertexBaseUrl } from "./vertexClaude";

// plan § G-4, G-8, G-12: the host is derived and pinned, retries are off, the request carries exactly the one
// forced tool and nothing else, and every failure maps to a closed code. Nothing reaches Google.

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const KEY = { projectId: "operai-meetings-test", clientEmail: "meetings-api@operai-meetings-test.iam.gserviceaccount.com", privateKey };
const SCHEMA: OutputSchema = {
  name: "submit_summary",
  description: "Submit the summary",
  jsonSchema: { type: "object", properties: { sections: { type: "array", items: { type: "string" } } }, required: ["sections"] },
};
const REQUEST = { system: "You summarise.", messages: [{ role: "user" as const, text: "Quoted transcript: hello" }], maxTokens: 1024 };

interface Seen {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

const reply = (over: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-0",
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
  content: [{ type: "tool_use", id: "tu_1", name: "submit_summary", input: { sections: ["a"] } }],
  ...over,
});
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A model over the REAL SDK client, with both the Vertex wire and the token exchange stubbed. */
function build(respond: () => Response | Promise<Response>, over: { location?: string } = {}) {
  const seen: Seen[] = [];
  const tokenCalls: string[] = [];
  const wire = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    seen.push({ url: new URL(request.url), method: request.method, headers: request.headers, body: JSON.parse(await request.clone().text()) });
    const answer = respond();
    if (answer instanceof Response) return answer;
    return answer;
  }) as unknown as typeof fetch;
  const tokenFetch = (async (input: string | URL | Request) => {
    tokenCalls.push(String(input instanceof Request ? input.url : input));
    return jsonResponse({ access_token: "ya29.vertex", expires_in: 3600, token_type: "Bearer" });
  }) as unknown as typeof fetch;
  const auth = createGoogleAuth({ key: KEY, fetchImpl: tokenFetch });
  const client = createVertexClient({ location: over.location ?? "eu", projectId: KEY.projectId, authClient: auth.client, fetchImpl: wire });
  return { model: createVertexLanguageModel({ client, modelId: "claude-sonnet-5-0" }), seen, tokenCalls };
}

const rejection = async (promise: Promise<unknown>): Promise<LanguageModelError> => (await promise.then(() => undefined, (e: unknown) => e)) as LanguageModelError;

const AMBIENT = ["ANTHROPIC_VERTEX_BASE_URL", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(AMBIENT.map((k) => [k, process.env[k]]));
  // The ambient environment of a hostile or sloppy host: every default the SDK would read.
  process.env["ANTHROPIC_VERTEX_BASE_URL"] = "https://evil.example/v1";
  process.env["CLOUD_ML_REGION"] = "us-central1";
  process.env["ANTHROPIC_VERTEX_PROJECT_ID"] = "someone-elses-project";
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-must-not-be-sent";
  process.env["GOOGLE_APPLICATION_CREDENTIALS"] = "/nonexistent/adc.json";
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the endpoint (R13, S2)", () => {
  it("is the eu multi-region host and names locations/eu and OUR project, even with the SDK's env defaults set", async () => {
    const { model, seen } = build(() => jsonResponse(reply()));
    await model.complete(REQUEST, SCHEMA);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.host).toBe("aiplatform.eu.rep.googleapis.com");
    expect(seen[0]!.url.pathname).toBe("/v1/projects/operai-meetings-test/locations/eu/publishers/anthropic/models/claude-sonnet-5-0:rawPredict");
    expect(seen[0]!.method).toBe("POST");
    for (const header of [...seen[0]!.headers.values()]) {
      expect(header).not.toContain("sk-ant-must-not-be-sent");
    }
  });

  it("derives the host from the location, and refuses global, the US and London", () => {
    expect(vertexBaseUrl("eu")).toBe("https://aiplatform.eu.rep.googleapis.com/v1");
    expect(vertexBaseUrl("europe-west4")).toBe("https://europe-west4-aiplatform.googleapis.com/v1");
    const authClient = createGoogleAuth({ key: KEY }).client;
    for (const location of ["global", "us", "us-central1", "europe-west2", ""]) {
      expect(() => createVertexClient({ location, projectId: KEY.projectId, authClient }), location).toThrow();
    }
  });

  it("authenticates with the explicit service-account token, never ADC", async () => {
    const { model, seen, tokenCalls } = build(() => jsonResponse(reply()));
    await model.complete(REQUEST, SCHEMA);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer ya29.vertex");
    expect(tokenCalls).toHaveLength(1);
    expect(new URL(tokenCalls[0]!).host).toBe("oauth2.googleapis.com");
  });
});

describe("the request (AC-7.10, ADR-0067)", () => {
  it("carries the system prompt, the messages, max_tokens, exactly ONE tool and tool_choice forced to it", async () => {
    const { model, seen } = build(() => jsonResponse(reply()));
    await model.complete(REQUEST, SCHEMA);
    const body = seen[0]!.body;
    expect(body["system"]).toBe("You summarise.");
    expect(body["messages"]).toEqual([{ role: "user", content: "Quoted transcript: hello" }]);
    expect(body["max_tokens"]).toBe(1024);
    expect(body["tools"]).toEqual([{ name: "submit_summary", description: "Submit the summary", input_schema: SCHEMA.jsonSchema }]);
    expect(body["tool_choice"]).toEqual({ type: "tool", name: "submit_summary" });
    expect(body["anthropic_version"]).toBeDefined(); // Vertex takes the API version from the body
    expect(body["model"]).toBeUndefined(); // ...and the model from the path
  });

  it("has no cache_control, advanced_ai_enabled, beta, server tool or stream anywhere in the body, and no beta header", async () => {
    const { model, seen } = build(() => jsonResponse(reply()));
    await model.complete(REQUEST, SCHEMA);
    const text = JSON.stringify(seen[0]!.body);
    for (const forbidden of ["cache_control", "advanced_ai_enabled", "betas", "anthropic_beta", "web_search", "code_execution", "bash", "computer", "text_editor", "mcp_servers", "container", "stream"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    const tools = seen[0]!.body["tools"] as { type?: string }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type === undefined || tools[0]!.type === "custom").toBe(true);
    expect([...seen[0]!.headers.keys()].some((k) => k.toLowerCase().includes("beta"))).toBe(false);
    expect(new URL(seen[0]!.url).searchParams.has("beta")).toBe(false);
  });

  it("does not retry: one call, then the failure", async () => {
    let calls = 0;
    const { model } = build(() => {
      calls += 1;
      return jsonResponse({ type: "error", error: { type: "overloaded_error", message: "x" } }, 529);
    });
    expect((await rejection(model.complete(REQUEST, SCHEMA))).transient).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("the reply", () => {
  it("returns the forced tool's input, unvalidated", async () => {
    const { model } = build(() => jsonResponse(reply()));
    expect(await model.complete(REQUEST, SCHEMA)).toEqual({ sections: ["a"] });
  });

  it("is invalid_output (transient) when it stops for another reason, calls another tool, has no tool block, or is cut short", async () => {
    const variants = [
      reply({ stop_reason: "end_turn", content: [{ type: "text", text: "hello" }] }),
      reply({ stop_reason: "max_tokens" }),
      reply({ content: [{ type: "tool_use", id: "t", name: "other_tool", input: {} }] }),
      reply({ content: [{ type: "text", text: "no tool" }] }),
      reply({ content: [] }),
    ];
    for (const variant of variants) {
      const { model } = build(() => jsonResponse(variant));
      const error = await rejection(model.complete(REQUEST, SCHEMA));
      expect(error).toBeInstanceOf(LanguageModelError);
      expect(error).toMatchObject({ code: "invalid_output", transient: true });
    }
  });
});

describe("failures map into the closed codes (G-8)", () => {
  const body = (message: string) => ({ type: "error", error: { type: "api_error", message } });

  for (const status of [408, 429, 500, 502, 503, 504, 529]) {
    it(`HTTP ${status} is provider_unavailable (transient) and carries the status`, async () => {
      const { model } = build(() => jsonResponse(body("x"), status));
      expect(await rejection(model.complete(REQUEST, SCHEMA))).toMatchObject({ code: "provider_unavailable", transient: true, status });
    });
  }

  for (const status of [400, 401, 403, 404, 413, 422]) {
    it(`HTTP ${status} is provider_rejected (permanent)`, async () => {
      const { model } = build(() => jsonResponse(body("x"), status));
      expect(await rejection(model.complete(REQUEST, SCHEMA))).toMatchObject({ code: "provider_rejected", transient: false, status });
    });
  }

  it("a network failure is transient, with no status", async () => {
    const { model } = build(() => {
      throw new Error("ECONNRESET");
    });
    expect(await rejection(model.complete(REQUEST, SCHEMA))).toMatchObject({ code: "provider_unavailable", transient: true });
  });

  it("the caller's abort stops the call and is not a rejection of the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { model } = build(() => jsonResponse(reply()));
    const error = await rejection(model.complete(REQUEST, SCHEMA, controller.signal));
    expect(error).toBeInstanceOf(LanguageModelError);
    expect(error.transient).toBe(true);
  });

  it("never puts provider text, the prompt, a URL or the project in the message", async () => {
    const { model } = build(() => jsonResponse(body("echo: Quoted transcript: hello secret-prompt-text"), 400));
    const error = await rejection(model.complete(REQUEST, SCHEMA));
    for (const leak of ["secret-prompt-text", "Quoted transcript", "googleapis", "operai-meetings-test", "claude-sonnet"]) {
      expect(error.message).not.toContain(leak);
    }
  });
});
