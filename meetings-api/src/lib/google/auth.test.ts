import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GoogleApiError, createGoogleAuth, isTransientStatus, toGoogleApiError } from "./auth";

// plan § G-6, G-8: the explicit key, never ADC; the token is cached; failures map without provider text.

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const key = { projectId: "operai-meetings-test", clientEmail: "meetings-api@operai-meetings-test.iam.gserviceaccount.com", privateKey };

interface Call {
  readonly url: string;
  readonly body: string;
}

/** A token endpoint stub: answers by script, records what was asked. */
function tokenEndpoint(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    calls.push({ url: request.url, body: await request.text() });
    const answer = answers.shift() ?? answers[answers.length - 1];
    if (answer instanceof Error) throw answer;
    return answer!.clone();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const tokenResponse = (token = "ya29.test-token", expiresIn = 3600) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });

describe("createGoogleAuth", () => {
  it("exchanges the signed assertion at oauth2.googleapis.com and returns the token", async () => {
    const stub = tokenEndpoint(tokenResponse());
    const auth = createGoogleAuth({ key, fetchImpl: stub.impl });
    expect(await auth.accessToken()).toBe("ya29.test-token");
    expect(stub.calls).toHaveLength(1);
    expect(new URL(stub.calls[0]!.url).host).toBe("oauth2.googleapis.com");
    const form = new URLSearchParams(stub.calls[0]!.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")?.split(".")).toHaveLength(3);
  });

  it("caches the token: a second call does not reach the endpoint", async () => {
    const stub = tokenEndpoint(tokenResponse());
    const auth = createGoogleAuth({ key, fetchImpl: stub.impl });
    await auth.accessToken();
    await auth.accessToken();
    expect(stub.calls).toHaveLength(1);
  });

  it("exposes the same credentials as a client for the Vertex SDK", async () => {
    const stub = tokenEndpoint(tokenResponse("ya29.shared"));
    const auth = createGoogleAuth({ key, fetchImpl: stub.impl });
    await auth.accessToken();
    expect((await auth.client.getRequestHeaders()).get("authorization")).toBe("Bearer ya29.shared");
    expect(stub.calls).toHaveLength(1);
  });

  it("maps a 5xx and a network error to a transient failure, retrying nothing itself", async () => {
    for (const answer of [new Response("{}", { status: 503 }), new Error("socket hang up")]) {
      const stub = tokenEndpoint(answer);
      const failure = await createGoogleAuth({ key, fetchImpl: stub.impl }).accessToken().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(GoogleApiError);
      expect((failure as GoogleApiError).transient).toBe(true);
      expect(stub.calls).toHaveLength(1);
    }
  });

  it("maps a revoked or expired key (400 invalid_grant, 401) to a permanent failure with no provider text", async () => {
    for (const status of [400, 401]) {
      const stub = tokenEndpoint(new Response(JSON.stringify({ error: "invalid_grant", error_description: `key for ${key.clientEmail}` }), { status }));
      const failure = (await createGoogleAuth({ key, fetchImpl: stub.impl }).accessToken().catch((e: unknown) => e)) as GoogleApiError;
      expect(failure).toBeInstanceOf(GoogleApiError);
      expect(failure.transient).toBe(false);
      expect(failure.status).toBe(status);
      expect(failure.message).not.toContain(key.clientEmail);
      expect(failure.message).not.toContain("invalid_grant");
    }
  });

  it("treats an answer without a token as transient", async () => {
    const stub = tokenEndpoint(new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }));
    const failure = (await createGoogleAuth({ key, fetchImpl: stub.impl }).accessToken().catch((e: unknown) => e)) as GoogleApiError;
    expect(failure).toBeInstanceOf(GoogleApiError);
    expect(failure.transient).toBe(true);
  });
});

describe("failure mapping", () => {
  it("408, 429 and 5xx are transient; other statuses are not", () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529]) expect(isTransientStatus(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 413, 422]) expect(isTransientStatus(status)).toBe(false);
  });

  it("reads a status from a thrown error and treats anything else as transient", () => {
    expect(toGoogleApiError({ status: 403 })).toMatchObject({ transient: false, status: 403 });
    expect(toGoogleApiError({ response: { status: 502 } })).toMatchObject({ transient: true, status: 502 });
    expect(toGoogleApiError(new Error("boom"))).toMatchObject({ transient: true });
    const already = new GoogleApiError(false, 404);
    expect(toGoogleApiError(already)).toBe(already);
  });
});
