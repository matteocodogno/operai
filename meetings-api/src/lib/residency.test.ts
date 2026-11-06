import { describe, expect, it } from "bun:test";
import {
  SPEECH_ALLOWED_LOCATIONS,
  VERTEX_ALLOWED_LOCATIONS,
  checkNoVertexBaseUrlOverride,
  checkSpeechLocation,
  checkVertexLocation,
  checkVertexModelId,
  parseServiceAccountKey,
  vertexHost,
} from "./residency";

// AC-4.9: transcription and language processing stay in the EU.
describe("checkSpeechLocation (S1)", () => {
  it("allows eu only", () => {
    expect([...SPEECH_ALLOWED_LOCATIONS]).toEqual(["eu"]);
    expect(checkSpeechLocation("eu")).toBeNull();
    for (const location of ["us", "global", "europe-west4", "EU", ""]) expect(checkSpeechLocation(location)).not.toBeNull();
  });

  it("never echoes the value it refuses", () => {
    expect(checkSpeechLocation("secret-loc-9") ?? "").not.toContain("secret-loc-9");
  });
});

describe("checkVertexLocation (S2)", () => {
  it("allows eu, europe-west1 and europe-west4", () => {
    expect([...VERTEX_ALLOWED_LOCATIONS].sort()).toEqual(["eu", "europe-west1", "europe-west4"]);
    for (const location of VERTEX_ALLOWED_LOCATIONS) expect(checkVertexLocation(location)).toBeNull();
  });

  it("refuses global, the US, London and anything else", () => {
    for (const location of ["global", "us", "us-central1", "europe-west2", "europe-west3", "eu-central-1", ""]) {
      expect(checkVertexLocation(location)).not.toBeNull();
    }
  });

  it("never echoes the value it refuses", () => {
    expect(checkVertexLocation("us-secret-9") ?? "").not.toContain("us-secret-9");
  });
});

describe("vertexHost", () => {
  it("uses the eu multi-region host for eu and the regional host otherwise", () => {
    expect(vertexHost("eu")).toBe("aiplatform.eu.rep.googleapis.com");
    expect(vertexHost("europe-west4")).toBe("europe-west4-aiplatform.googleapis.com");
  });
});

describe("checkVertexModelId (S3)", () => {
  it("accepts Claude ids, versioned or not", () => {
    for (const id of ["claude-sonnet-5-0", "claude-opus-4-7@20260401", "claude-haiku-4.5"]) expect(checkVertexModelId(id)).toBeNull();
  });

  it("refuses Fable and Mythos in any case, and anything that is not a Claude id", () => {
    for (const id of ["claude-fable-1", "claude-sonnet-mythos", "CLAUDE-FABLE", "gemini-3", "claude_x", "claude-", "", "claude-a b"]) {
      expect(checkVertexModelId(id)).not.toBeNull();
    }
  });

  it("never echoes the id", () => {
    expect(checkVertexModelId("claude-fable-secret") ?? "").not.toContain("secret");
  });
});

describe("parseServiceAccountKey (S4)", () => {
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  const good = { type: "service_account", project_id: "proj-abcde", client_email: "a@b.c", private_key: "k" };

  it("returns the parts this service uses", () => {
    const r = parseServiceAccountKey(encode(good), "proj-abcde");
    expect(r.error).toBeUndefined();
    expect(r.key).toEqual({ projectId: "proj-abcde", clientEmail: "a@b.c", privateKey: "k" });
  });

  it("refuses non-base64, non-JSON, non-objects, other types, other projects and missing members", () => {
    const bad = [
      "***",
      "",
      Buffer.from("nope").toString("base64"),
      encode([good]),
      encode({ ...good, type: "external_account" }),
      encode({ ...good, project_id: "other-project" }),
      encode({ ...good, project_id: undefined }),
      encode({ ...good, client_email: undefined }),
      encode({ ...good, private_key: undefined }),
    ];
    for (const encoded of bad) expect(parseServiceAccountKey(encoded, "proj-abcde").error).toBeDefined();
  });

  it("its messages never contain the key, the email or the project ids", () => {
    const encoded = encode({ ...good, project_id: "other-project" });
    const message = parseServiceAccountKey(encoded, "proj-abcde").error ?? "";
    for (const secret of ["other-project", "proj-abcde", "a@b.c", encoded]) expect(message).not.toContain(secret);
  });
});

describe("checkNoVertexBaseUrlOverride (S5)", () => {
  it("passes when unset or empty and refuses any value without echoing it", () => {
    expect(checkNoVertexBaseUrlOverride(undefined)).toBeNull();
    expect(checkNoVertexBaseUrlOverride("")).toBeNull();
    expect(checkNoVertexBaseUrlOverride("https://evil.example") ?? "").not.toContain("evil");
    expect(checkNoVertexBaseUrlOverride("https://evil.example")).not.toBeNull();
  });
});
