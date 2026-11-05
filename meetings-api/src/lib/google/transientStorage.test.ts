import { describe, expect, it } from "bun:test";
import { GoogleApiError, type GoogleAuth } from "./auth";
import { createFakeTransientStorage } from "./fakeTransientStorage";
import {
  TransientObjectTooLargeError,
  createTransientStorage,
  readBucketConfig,
  regionalHost,
  transientKeys,
} from "./transientStorage";

// plan § G-2: the transient bucket is reached only through its regional endpoint, and only
// `transcribe/<meetingId>/` is ever listed or deleted.

const auth: GoogleAuth = { accessToken: async () => "tok", client: null as never };

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

/** A stub `fetch`: routes by script, records every request. */
function stub(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const record: Seen = { method: init?.method ?? "GET", url: new URL(String(input)), headers: new Headers(init?.headers) };
    seen.push(record);
    return respond(record);
  }) as unknown as typeof fetch;
  return { seen, impl };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const make = (location: string, fetchImpl: typeof fetch) => createTransientStorage({ bucket: "operai-transient", location, auth, fetchImpl });

describe("transientKeys", () => {
  it("lays an attempt out under transcribe/<meetingId>/<attempt>/", () => {
    expect(transientKeys.prefix("m_1")).toBe("transcribe/m_1/");
    expect(transientKeys.input("m_1", 2, 3)).toBe("transcribe/m_1/2/in/3.ogg");
    expect(transientKeys.outputPrefix("m_1", 2)).toBe("transcribe/m_1/2/out/");
  });

  it("refuses ids that could steer the path", () => {
    for (const id of ["", "a/b", "..", "a b", "x".repeat(65)]) expect(() => transientKeys.prefix(id)).toThrow();
    expect(() => transientKeys.input("m", 0, 1)).toThrow();
    expect(() => transientKeys.input("m", 1, 0)).toThrow();
  });
});

describe("regional endpoint (G7)", () => {
  it("derives storage.<location>.rep.googleapis.com from the bucket location, lowercased", () => {
    expect(regionalHost("EU")).toBe("storage.eu.rep.googleapis.com");
    expect(regionalHost("EUROPE-WEST4")).toBe("storage.europe-west4.rep.googleapis.com");
  });

  it("sends every object call (upload, download, list, delete) to the regional host", async () => {
    const s = stub((r) => {
      if (r.method === "POST") return json({});
      if (r.method === "DELETE") return new Response(null, { status: 204 });
      if (r.url.searchParams.get("alt") === "media") return new Response(new Uint8Array([1, 2, 3]));
      return json({ items: [{ name: "transcribe/m1/1/in/1.ogg" }] });
    });
    const storage = make("EUROPE-WEST4", s.impl);
    await storage.put("transcribe/m1/1/in/1.ogg", new Uint8Array([1]));
    await storage.read("transcribe/m1/1/in/1.ogg", 100);
    await storage.deletePrefix("transcribe/m1/");
    expect(s.seen.length).toBeGreaterThanOrEqual(4);
    for (const r of s.seen) {
      expect(r.url.protocol).toBe("https:");
      expect(r.url.host).toBe("storage.europe-west4.rep.googleapis.com");
      expect(r.headers.get("authorization")).toBe("Bearer tok");
    }
  });
});

describe("put", () => {
  it("creates the object with ifGenerationMatch=0 on the upload endpoint", async () => {
    const s = stub(() => json({}));
    await make("EU", s.impl).put("transcribe/m1/1/in/1.ogg", new Uint8Array([1, 2]));
    const { url, method } = s.seen[0]!;
    expect(method).toBe("POST");
    expect(url.pathname).toBe("/upload/storage/v1/b/operai-transient/o");
    expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
    expect(url.searchParams.get("uploadType")).toBe("media");
    expect(url.searchParams.get("name")).toBe("transcribe/m1/1/in/1.ogg");
  });

  it("an existing object (412) is a permanent failure, not an overwrite", async () => {
    const failure = (await make("EU", stub(() => json({}, 412)).impl).put("transcribe/m1/1/in/1.ogg", new Uint8Array()).catch((e: unknown) => e)) as GoogleApiError;
    expect(failure).toBeInstanceOf(GoogleApiError);
    expect(failure.transient).toBe(false);
  });

  it("refuses a key outside the transient layout without calling Google", async () => {
    const s = stub(() => json({}));
    const storage = make("EU", s.impl);
    for (const key of ["meetings/m1/audio.ogg", "transcribe/m1/audio.ogg", "transcribe/m1/1/in/../x", "transcribe/m1/1/in/..", "transcribe/m1/1/other/1.ogg"]) {
      await expect(storage.put(key, new Uint8Array())).rejects.toThrow();
    }
    expect(s.seen).toHaveLength(0);
  });
});

describe("read", () => {
  it("returns the bytes and asks for the media of the encoded object name", async () => {
    const s = stub(() => new Response(new Uint8Array([7, 8, 9])));
    expect(await make("EU", s.impl).read("transcribe/m1/1/out/a_transcript.json", 10)).toEqual(new Uint8Array([7, 8, 9]));
    expect(s.seen[0]!.url.pathname).toBe("/download/storage/v1/b/operai-transient/o/transcribe%2Fm1%2F1%2Fout%2Fa_transcript.json");
    expect(s.seen[0]!.url.searchParams.get("alt")).toBe("media");
  });

  it("refuses a declared size over the ceiling before reading", async () => {
    const big = new Response(new Uint8Array(10), { headers: { "content-length": "999999" } });
    await expect(make("EU", stub(() => big).impl).read("transcribe/m1/1/out/x.json", 100)).rejects.toBeInstanceOf(TransientObjectTooLargeError);
  });

  it("refuses a stream that exceeds the ceiling even when it declares nothing", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(60));
        controller.close();
      },
    });
    await expect(make("EU", stub(() => new Response(body)).impl).read("transcribe/m1/1/out/x.json", 100)).rejects.toBeInstanceOf(TransientObjectTooLargeError);
  });

  it("a 404 is a permanent failure and a 503 a transient one", async () => {
    const f404 = (await make("EU", stub(() => json({}, 404)).impl).read("transcribe/m1/1/out/x.json", 10).catch((e: unknown) => e)) as GoogleApiError;
    expect(f404.transient).toBe(false);
    const f503 = (await make("EU", stub(() => json({}, 503)).impl).read("transcribe/m1/1/out/x.json", 10).catch((e: unknown) => e)) as GoogleApiError;
    expect(f503.transient).toBe(true);
  });
});

describe("deletePrefix", () => {
  it("refuses transcribe/, another meeting layout, a deeper prefix and malformed ones, without calling Google", async () => {
    const s = stub(() => json({ items: [] }));
    const storage = make("EU", s.impl);
    for (const prefix of ["", "transcribe/", "transcribe", "transcribe//", "transcribe/m1", "transcribe/m1/1/", "meetings/m1/", "/", "transcribe/a/../"]) {
      await expect(storage.deletePrefix(prefix)).rejects.toThrow();
    }
    expect(s.seen).toHaveLength(0);
  });

  it("lists page by page and deletes every object under the prefix", async () => {
    const s = stub((r) => {
      if (r.method === "DELETE") return new Response(null, { status: 204 });
      return r.url.searchParams.get("pageToken") === "p2"
        ? json({ items: [{ name: "transcribe/m1/1/out/a.json" }] })
        : json({ items: [{ name: "transcribe/m1/1/in/1.ogg" }, { name: "transcribe/m1/1/in/2.ogg" }], nextPageToken: "p2" });
    });
    expect(await make("EU", s.impl).deletePrefix("transcribe/m1/")).toBe(3);
    const lists = s.seen.filter((r) => r.method === "GET");
    expect(lists).toHaveLength(2);
    expect(lists[0]!.url.searchParams.get("prefix")).toBe("transcribe/m1/");
    expect(s.seen.filter((r) => r.method === "DELETE").map((r) => decodeURIComponent(r.url.pathname.split("/o/")[1]!)).sort()).toEqual([
      "transcribe/m1/1/in/1.ogg",
      "transcribe/m1/1/in/2.ogg",
      "transcribe/m1/1/out/a.json",
    ]);
  });

  it("never deletes a name outside the prefix, whatever the listing says", async () => {
    const s = stub((r) =>
      r.method === "DELETE" ? new Response(null, { status: 204 }) : json({ items: [{ name: "transcribe/m2/1/in/1.ogg" }, { name: "meetings/m1/audio.ogg" }, { name: "transcribe/m1/1/in/1.ogg" }] }),
    );
    expect(await make("EU", s.impl).deletePrefix("transcribe/m1/")).toBe(1);
    expect(s.seen.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("an object that is already gone (404) is fine; any other failure rejects", async () => {
    const gone = stub((r) => (r.method === "DELETE" ? json({}, 404) : json({ items: [{ name: "transcribe/m1/1/in/1.ogg" }] })));
    expect(await make("EU", gone.impl).deletePrefix("transcribe/m1/")).toBe(1);

    const denied = stub((r) => (r.method === "DELETE" ? json({}, 403) : json({ items: [{ name: "transcribe/m1/1/in/1.ogg" }] })));
    await expect(make("EU", denied.impl).deletePrefix("transcribe/m1/")).rejects.toBeInstanceOf(GoogleApiError);
  });

  it("a failed listing rejects (the caller answers 503 and changes nothing)", async () => {
    await expect(make("EU", stub(() => json({}, 500)).impl).deletePrefix("transcribe/m1/")).rejects.toBeInstanceOf(GoogleApiError);
  });
});

describe("keyOfUri", () => {
  it("maps this bucket's gs:// URIs back to keys and refuses anything else", () => {
    const storage = make("EU", stub(() => json({})).impl);
    expect(storage.uri("transcribe/m1/1/in/1.ogg")).toBe("gs://operai-transient/transcribe/m1/1/in/1.ogg");
    expect(storage.keyOfUri("gs://operai-transient/transcribe/m1/1/out/a.json")).toBe("transcribe/m1/1/out/a.json");
    expect(storage.keyOfUri("gs://other-bucket/transcribe/m1/1/out/a.json")).toBeNull();
    expect(storage.keyOfUri("gs://operai-transient/other/a.json")).toBeNull();
    expect(storage.keyOfUri("https://operai-transient/transcribe/m1/1/out/a.json")).toBeNull();
  });
});

describe("readBucketConfig", () => {
  it("reads the metadata from the global endpoint with the fields N2 needs", async () => {
    const s = stub(() => json({ location: "EU" }));
    expect(await readBucketConfig({ bucket: "operai-transient", auth, fetchImpl: s.impl })).toEqual({ location: "EU" });
    expect(s.seen[0]!.url.host).toBe("storage.googleapis.com");
    expect(s.seen[0]!.url.pathname).toBe("/storage/v1/b/operai-transient");
    const fields = s.seen[0]!.url.searchParams.get("fields")!.split(",");
    for (const field of ["location", "lifecycle", "versioning", "softDeletePolicy", "retentionPolicy", "defaultEventBasedHold", "iamConfiguration"]) {
      expect(fields).toContain(field);
    }
  });

  it("retries once on a transient failure, then gives up", async () => {
    let n = 0;
    const flaky = stub(() => (n++ === 0 ? json({}, 503) : json({ location: "EU" })));
    expect(await readBucketConfig({ bucket: "b-ucket", auth, fetchImpl: flaky.impl })).toEqual({ location: "EU" });
    expect(flaky.seen).toHaveLength(2);

    const down = stub(() => json({}, 503));
    await expect(readBucketConfig({ bucket: "b-ucket", auth, fetchImpl: down.impl })).rejects.toBeInstanceOf(GoogleApiError);
    expect(down.seen).toHaveLength(2);
  });

  it("does not retry a permanent refusal", async () => {
    const denied = stub(() => json({}, 403));
    await expect(readBucketConfig({ bucket: "b-ucket", auth, fetchImpl: denied.impl })).rejects.toBeInstanceOf(GoogleApiError);
    expect(denied.seen).toHaveLength(1);
  });
});

describe("the fake", () => {
  it("keeps the same prefix rule and records calls in order", async () => {
    const fake = createFakeTransientStorage();
    await fake.put("transcribe/m1/1/in/1.ogg", new Uint8Array([1]));
    await expect(fake.deletePrefix("transcribe/")).rejects.toThrow();
    expect(await fake.deletePrefix("transcribe/m1/")).toBe(1);
    expect(fake.events.map((e) => e.op)).toEqual(["put", "deletePrefix"]);
    fake.failWith(new Error("down"));
    await expect(fake.deletePrefix("transcribe/m1/")).rejects.toThrow("down");
  });
});
