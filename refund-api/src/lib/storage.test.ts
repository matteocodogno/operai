/**
 * Unit tests for the S3-compatible storage wrapper (T9,
 * specs/007-refund-service, ADR-0016).
 *
 * Strategy: mock `@aws-sdk/s3-presigned-post`'s `createPresignedPost` and
 * `@aws-sdk/s3-request-presigner`'s `getSignedUrl` (the two functions
 * storage.ts calls to MINT signed URLs) via `mock.module()`, and spy on
 * `S3Client.prototype.send` (the low-level call HEAD/DELETE go through) — no
 * live bucket/network call ever happens, per T9's own done-when ("storage
 * MOCKED").
 *
 * AC coverage (T9 done-when)
 * ──────────────────────────
 * - presigned-POST params: content-length-range capped at MAX_ATTACHMENT_BYTES,
 *   Content-Type pinned to the exact declared value
 * - presigned GET expires in ~60s by default
 * - headObject returns null for a missing object (404/NotFound)
 * - sanitizeFileName strips path traversal / unsafe characters
 */

import { describe, it, expect, beforeEach, spyOn, mock } from "bun:test";

process.env["DATABASE_URL"] ??= "postgresql://test:test@localhost:5435/test";
process.env["ALLOWED_ORIGINS"] = "http://localhost:5173";
process.env["AUTH_JWKS_URL"] = "http://localhost:3001/auth/jwks";
process.env["AUTH_ISSUER"] = "http://localhost:3001";
process.env["AUTH_BASE_URL"] = "http://localhost:3001";
process.env["AUTH_AUDIENCE"] = "operai-suite";
process.env["NODE_ENV"] = "test";
process.env["NOTIFY_INTERNAL_TOKEN"] = "test-notify-internal-token-at-least-32-characters";
process.env["NOTIFY_INTERNAL_URL"] = "http://localhost:8081";
process.env["REFUND_S3_ENDPOINT"] =
  "https://test.s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_REGION"] = "auto";
process.env["REFUND_S3_EU_ENDPOINT_HOSTS"] = "s3.railway-eu-amsterdam.example.com";
process.env["REFUND_S3_BUCKET"] = "test-bucket";
process.env["REFUND_S3_ACCESS_KEY_ID"] = "test-key";
process.env["REFUND_S3_SECRET_ACCESS_KEY"] = "test-secret";

interface PresignedPostCall {
  Bucket?: string;
  Key?: string;
  Conditions?: unknown;
  Fields?: unknown;
  Expires?: number;
}
let presignedPostCall: PresignedPostCall | null = null;

interface GetSignedUrlCall {
  key: string | undefined;
  expiresIn: number;
}
let getSignedUrlCall: GetSignedUrlCall | null = null;

mock.module("@aws-sdk/s3-presigned-post", () => ({
  createPresignedPost: async (_client: unknown, params: PresignedPostCall) => {
    presignedPostCall = params;
    return {
      url: "https://mock-bucket.example.com/upload",
      fields: { key: params.Key ?? "" },
    };
  },
}));

mock.module("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (
    _client: unknown,
    command: { input: { Key?: string } },
    options: { expiresIn: number },
  ) => {
    getSignedUrlCall = { key: command.input.Key, expiresIn: options.expiresIn };
    return "https://mock-bucket.example.com/signed-get";
  },
}));

const storage = await import("./storage");
const { S3Client, DeleteObjectCommand, PutObjectCommand, NotFound } = await import(
  "@aws-sdk/client-s3"
);

beforeEach(() => {
  presignedPostCall = null;
  getSignedUrlCall = null;
});

describe("mintPresignedPost", () => {
  it("pins content-length-range to MAX_ATTACHMENT_BYTES and Content-Type to the exact declared value", async () => {
    await storage.mintPresignedPost(
      "refund/req1/line1/att1/file.pdf",
      "application/pdf",
    );

    expect(presignedPostCall?.Bucket).toBe("test-bucket");
    expect(presignedPostCall?.Key).toBe("refund/req1/line1/att1/file.pdf");
    expect(presignedPostCall?.Conditions).toEqual([
      ["content-length-range", 0, storage.MAX_ATTACHMENT_BYTES],
      ["eq", "$Content-Type", "application/pdf"],
    ]);
    expect(presignedPostCall?.Fields).toEqual({ "Content-Type": "application/pdf" });
  });

  it("MAX_ATTACHMENT_BYTES is exactly 10 MiB", () => {
    expect(storage.MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("mintPresignedGet", () => {
  it("targets the given object key and defaults to a 60s expiry", async () => {
    const url = await storage.mintPresignedGet("refund/req1/line1/att1/file.pdf");

    expect(url).toBe("https://mock-bucket.example.com/signed-get");
    expect(getSignedUrlCall?.key).toBe("refund/req1/line1/att1/file.pdf");
    expect(getSignedUrlCall?.expiresIn).toBe(60);
  });

  it("honours an explicit expiry override", async () => {
    await storage.mintPresignedGet("refund/x", 30);
    expect(getSignedUrlCall?.expiresIn).toBe(30);
  });
});

describe("headObject", () => {
  it("returns size + content-type when the object exists", async () => {
    const sendSpy = spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      ContentLength: 20481,
      ContentType: "application/pdf",
      $metadata: {},
    } as never);

    const result = await storage.headObject("refund/req1/line1/att1/file.pdf");

    expect(result).toEqual({ sizeBytes: 20481, contentType: "application/pdf" });
    sendSpy.mockRestore();
  });

  it("returns null when the object does not exist (NotFound)", async () => {
    const sendSpy = spyOn(S3Client.prototype, "send").mockRejectedValueOnce(
      new NotFound({ message: "not found", $metadata: {} }) as never,
    );

    const result = await storage.headObject("refund/missing");

    expect(result).toBeNull();
    sendSpy.mockRestore();
  });
});

describe("deleteObject", () => {
  it("sends a DeleteObjectCommand scoped to the given key and bucket", async () => {
    let captured: InstanceType<typeof DeleteObjectCommand> | null = null;
    const sendSpy = spyOn(S3Client.prototype, "send").mockImplementationOnce(
      async (command: unknown) => {
        captured = command as InstanceType<typeof DeleteObjectCommand>;
        return {} as never;
      },
    );

    await storage.deleteObject("refund/req1/line1/att1/file.pdf");

    expect(captured).toBeInstanceOf(DeleteObjectCommand);
    expect((captured as unknown as { input: { Key: string; Bucket: string } }).input.Key).toBe(
      "refund/req1/line1/att1/file.pdf",
    );
    expect(
      (captured as unknown as { input: { Key: string; Bucket: string } }).input.Bucket,
    ).toBe("test-bucket");
    sendSpy.mockRestore();
  });
});

describe("putObject", () => {
  it("sends a PutObjectCommand with the given key, body, content-type, and bucket (T2, specs/008)", async () => {
    let captured: InstanceType<typeof PutObjectCommand> | null = null;
    const sendSpy = spyOn(S3Client.prototype, "send").mockImplementationOnce(
      async (command: unknown) => {
        captured = command as InstanceType<typeof PutObjectCommand>;
        return {} as never;
      },
    );

    const body = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    await storage.putObject("refund/batches/b1/compiled.pdf", body, "application/pdf");

    expect(captured).toBeInstanceOf(PutObjectCommand);
    const input = (
      captured as unknown as {
        input: { Key: string; Bucket: string; Body: unknown; ContentType: string };
      }
    ).input;
    expect(input.Key).toBe("refund/batches/b1/compiled.pdf");
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Body).toBe(body);
    expect(input.ContentType).toBe("application/pdf");
    sendSpy.mockRestore();
  });
});

describe("sanitizeFileName", () => {
  it("strips path separators — no directory traversal survives into the object key", () => {
    expect(storage.sanitizeFileName("../../etc/passwd")).not.toContain("/");
    expect(storage.sanitizeFileName("..\\..\\windows\\system32\\file.txt")).not.toContain(
      "\\",
    );
  });

  it("only allows [a-zA-Z0-9._-] — every other character is replaced", () => {
    const result = storage.sanitizeFileName("my receipt (1)!.pdf");
    expect(result).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("falls back to 'file' for an empty or only-unsafe name", () => {
    expect(storage.sanitizeFileName("///")).toBe("file");
    expect(storage.sanitizeFileName("")).toBe("file");
  });

  it("caps length at 200 characters", () => {
    const long = `${"a".repeat(300)}.pdf`;
    expect(storage.sanitizeFileName(long).length).toBeLessThanOrEqual(200);
  });
});

describe("isAllowedContentType", () => {
  it("accepts pdf/jpeg/png", () => {
    expect(storage.isAllowedContentType("application/pdf")).toBe(true);
    expect(storage.isAllowedContentType("image/jpeg")).toBe(true);
    expect(storage.isAllowedContentType("image/png")).toBe(true);
  });

  it("rejects any other content type", () => {
    expect(storage.isAllowedContentType("application/zip")).toBe(false);
    expect(storage.isAllowedContentType("text/html")).toBe(false);
    expect(storage.isAllowedContentType("application/pdf; charset=utf-8")).toBe(false);
  });
});
