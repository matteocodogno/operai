/**
 * Object storage (T21, specs/015-hardware-inventory; AC-10.4, AC-10.6, AC-10.7;
 * ADR-0016 posture). Unit tests stub the S3 client's `send` but keep REAL
 * request signing; one round trip runs against the configured bucket (local
 * MinIO) and is skipped, visibly and with its reason, when that is unreachable.
 */

import { describe, it, expect } from "bun:test";
import { S3Client, HeadObjectCommand, DeleteObjectCommand, NotFound } from "@aws-sdk/client-s3";
import { setupTestAuth } from "../test-support/testAuth";

setupTestAuth(); // sets the environment `./storage` reads on import

const {
  createStorage,
  storage,
  sanitizeFileName,
  displayFileName,
  contentDisposition,
  isAllowedContentType,
  MAX_INVOICE_BYTES,
} = await import("./storage");
const { checkEuResidency, isAwsS3Endpoint, needsPathStyleAddressing } = await import("./s3Residency");
const { probeBucket, postToPresigned } = await import("../invoices/testMinio");

function stubbed(send: (command: unknown) => Promise<unknown>) {
  const client = new S3Client({
    region: "eu-central-1",
    endpoint: "http://localhost:9000",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIA-TEST", secretAccessKey: "secret-test" },
  });
  (client as unknown as { send: typeof send }).send = send;
  return createStorage({ client, bucket: "inv-test" });
}

describe("names", () => {
  it("sanitizeFileName strips paths, traversal, leading dots and odd characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\x\\inv oice (1).pdf")).toBe("inv_oice__1_.pdf");
    expect(sanitizeFileName("..hidden")).toBe("hidden");
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("../")).toBe("file");
    expect(sanitizeFileName("a".repeat(500)).length).toBe(200);
    expect(sanitizeFileName("fattura è.pdf")).toBe("fattura_e_.pdf");
  });

  it("displayFileName keeps readable names, drops paths, control and bidi characters", () => {
    expect(displayFileName("Fattura 2026-03 è.pdf")).toBe("Fattura 2026-03 è.pdf");
    expect(displayFileName("a/b\\c.pdf")).toBe("c.pdf");
    expect(displayFileName("in\u0000voice\r\n.pdf")).toBe("invoice.pdf");
    expect(displayFileName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(displayFileName("   ")).toBe("invoice");
    expect(displayFileName("..")).toBe("invoice");
    expect(displayFileName("x".repeat(500)).length).toBe(200);
  });

  it("contentDisposition cannot be split or quoted out of, and round-trips a unicode name", () => {
    const header = contentDisposition('a"b\r\nSet-Cookie: x=1;é.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith("inline; filename=\"")).toBe(true);
    const ascii = /filename="([^"]*)"/.exec(header)![1]!;
    expect(ascii).toMatch(/^[A-Za-z0-9._-]+$/);
    const star = /filename\*=UTF-8''(.*)$/.exec(header)![1]!;
    expect(star).not.toMatch(/['"();\s]/);
    expect(decodeURIComponent(contentDisposition("é.pdf").split("UTF-8''")[1]!)).toBe("é.pdf");
  });

  it("only pdf, jpeg and png are allowed", () => {
    for (const t of ["application/pdf", "image/jpeg", "image/png"]) expect(isAllowedContentType(t)).toBe(true);
    for (const t of ["text/plain", "image/gif", "application/pdf; x=1", "", "IMAGE/PNG"]) {
      expect(isAllowedContentType(t)).toBe(false);
    }
  });
});

describe("mintPresignedPost", () => {
  it("signs a policy capped at 10 MiB, pinned to the declared content type and key", async () => {
    const s = stubbed(async () => ({}));
    const { url, fields } = await s.mintPresignedPost("inventory/welld_ch/abc/inv.pdf", "application/pdf");
    expect(url).toContain("inv-test");
    expect(fields["key"]).toBe("inventory/welld_ch/abc/inv.pdf");
    expect(fields["Content-Type"]).toBe("application/pdf");
    const policy = JSON.parse(Buffer.from(fields["Policy"]!, "base64").toString("utf8")) as {
      conditions: unknown[];
    };
    const flat = JSON.stringify(policy.conditions);
    expect(flat).toContain(JSON.stringify(["content-length-range", 1, MAX_INVOICE_BYTES]));
    expect(flat).toContain(JSON.stringify(["eq", "$Content-Type", "application/pdf"]));
    expect(flat).toContain(JSON.stringify({ key: "inventory/welld_ch/abc/inv.pdf" }));
  });

  it("the policy is valid for 60 seconds, not minutes (a short window to overwrite a confirmed key)", async () => {
    const s = stubbed(async () => ({}));
    const { fields } = await s.mintPresignedPost("inventory/welld_ch/abc/inv.pdf", "application/pdf");
    const { expiration } = JSON.parse(Buffer.from(fields["Policy"]!, "base64").toString("utf8")) as {
      expiration: string;
    };
    const seconds = (Date.parse(expiration) - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(50);
    expect(seconds).toBeLessThanOrEqual(61);
  });
});

describe("headObject", () => {
  it("returns size and content type, and sends a HEAD for the key", async () => {
    let seen: unknown;
    const s = stubbed(async (command) => {
      seen = command;
      return { ContentLength: 1234, ContentType: "application/pdf", ETag: '"abc"' };
    });
    expect(await s.headObject("k")).toEqual({ sizeBytes: 1234, contentType: "application/pdf", etag: '"abc"' });
    expect(seen).toBeInstanceOf(HeadObjectCommand);
    expect((seen as HeadObjectCommand).input).toEqual({ Bucket: "inv-test", Key: "k" });
  });

  it("is null for a missing object, typed or by status, and throws on any other fault", async () => {
    const typed = stubbed(async () => {
      throw new NotFound({ message: "nf", $metadata: {} });
    });
    expect(await typed.headObject("k")).toBeNull();
    const byStatus = stubbed(async () => {
      throw Object.assign(new Error("x"), { $metadata: { httpStatusCode: 404 } });
    });
    expect(await byStatus.headObject("k")).toBeNull();
    const denied = stubbed(async () => {
      throw Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
    });
    await expect(denied.headObject("k")).rejects.toThrow("denied");
  });
});

describe("mintPresignedGet", () => {
  it("lives 60 s by default and overrides the response type and disposition in the signature", async () => {
    const s = stubbed(async () => ({}));
    const url = new URL(await s.mintPresignedGet("inventory/welld_ch/abc/inv.pdf", {
      contentType: "application/pdf",
      fileName: 'fat"tura.pdf',
    }));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(url.searchParams.get("response-content-disposition")).toContain("inline; filename=");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.pathname).toContain("inventory/welld_ch/abc/inv.pdf");
  });
});

describe("deleteObject", () => {
  it("sends a DELETE for the key", async () => {
    let seen: unknown;
    const s = stubbed(async (command) => ((seen = command), {}));
    await s.deleteObject("k");
    expect(seen).toBeInstanceOf(DeleteObjectCommand);
    expect((seen as DeleteObjectCommand).input).toEqual({ Bucket: "inv-test", Key: "k" });
  });
});

describe("EU residency (ported from refund-api)", () => {
  it("an AWS endpoint needs an EU region", () => {
    const aws = "https://s3.eu-central-1.amazonaws.com";
    expect(checkEuResidency(aws, "eu-central-1", [])).toBeNull();
    expect(checkEuResidency(aws, "us-east-1", [])).toContain("not an EU AWS region");
    expect(isAwsS3Endpoint(aws)).toBe(true);
    expect(needsPathStyleAddressing(aws)).toBe(false);
  });

  it("any other endpoint fails closed unless its host is on the operator's allowlist", () => {
    const own = "https://s3.eu-ams.example.com";
    expect(checkEuResidency(own, "us-east-1", [])).toContain("empty/unset");
    expect(checkEuResidency(own, "us-east-1", ["other.example.com"])).toContain("does not match");
    expect(checkEuResidency(own, "us-east-1", ["eu-ams.example.com"])).toBeNull();
    expect(checkEuResidency("https://evil-eu-ams.example.com", "x", ["eu-ams.example.com"])).toContain("does not match");
    expect(checkEuResidency("not a url", "x", ["x"])).toContain("not a valid URL");
    expect(needsPathStyleAddressing(own)).toBe(true);
  });
});

// ─── The real bucket ─────────────────────────────────────────────────────────

const unreachable = await probeBucket();
if (unreachable) console.warn(`[storage.test] SKIPPING the object-storage round trip: ${unreachable}`);

describe.skipIf(unreachable !== null)("against the configured bucket (MinIO)", () => {
  it("mint -> upload -> head -> signed GET -> delete", async () => {
    const key = `inventory/test/${crypto.randomUUID()}/rt.pdf`;
    const bytes = new TextEncoder().encode("%PDF-1.4 round trip");
    const upload = await storage.mintPresignedPost(key, "application/pdf");
    expect((await postToPresigned(upload, bytes, "application/pdf")).ok).toBe(true);
    expect(await storage.headObject(key)).toEqual({
      sizeBytes: bytes.length,
      contentType: "application/pdf",
      etag: expect.any(String),
    });

    const res = await fetch(await storage.mintPresignedGet(key, { contentType: "application/pdf", fileName: "Fattura è.pdf" }));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''Fattura%20%C3%A8.pdf");

    await storage.deleteObject(key);
    expect(await storage.headObject(key)).toBeNull();
  });

  it("the bucket itself refuses a forged content type and an oversize body", async () => {
    const key = `inventory/test/${crypto.randomUUID()}/bad.pdf`;
    const upload = await storage.mintPresignedPost(key, "application/pdf");
    // The stored type is the policy-pinned form field; trying to change it breaks the signature.
    const forged = { ...upload, fields: { ...upload.fields, "Content-Type": "text/plain" } };
    expect((await postToPresigned(forged, new Uint8Array(10), "text/plain")).ok).toBe(false);
    expect((await postToPresigned(upload, new Uint8Array(MAX_INVOICE_BYTES + 1), "application/pdf")).ok).toBe(false);
    expect(await storage.headObject(key)).toBeNull();
  });
});
