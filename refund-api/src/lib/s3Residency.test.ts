/**
 * Unit tests for the EU-residency guard (OWASP A05 fix, specs/007-refund-service,
 * ADR-0016 Risk R8).
 *
 * Coverage (fix round done-when):
 *   - AWS-EU endpoint + EU region → pass
 *   - AWS-EU endpoint + non-EU region → reject
 *   - non-AWS endpoint + host present in REFUND_S3_EU_ENDPOINT_HOSTS → pass
 *   - non-AWS endpoint + host NOT present in the allowlist → reject
 *   - non-AWS endpoint + empty/unset allowlist → reject (fail closed, the
 *     regression this fix round closes — previously this was a silent no-op)
 *
 * Pure functions, no env.ts import — no environment variables required.
 */

import { describe, it, expect } from "bun:test";
import {
  checkEuResidency,
  isAwsS3Endpoint,
  needsPathStyleAddressing,
  EU_AWS_REGIONS,
} from "./s3Residency";

describe("isAwsS3Endpoint", () => {
  it("recognises a *.amazonaws.com host", () => {
    expect(isAwsS3Endpoint("https://s3.eu-central-1.amazonaws.com")).toBe(true);
  });

  it("rejects a non-AWS host", () => {
    expect(
      isAwsS3Endpoint("https://bucket.s3.railway-eu-amsterdam.example.com"),
    ).toBe(false);
  });

  it("rejects an unparsable URL", () => {
    expect(isAwsS3Endpoint("not-a-url")).toBe(false);
  });
});

describe("checkEuResidency — AWS endpoint branch", () => {
  it("AWS-EU region → pass (null)", () => {
    for (const region of EU_AWS_REGIONS) {
      expect(
        checkEuResidency(
          "https://s3.amazonaws.com",
          region,
          [],
        ),
      ).toBeNull();
    }
  });

  it("AWS non-EU region → reject", () => {
    const result = checkEuResidency(
      "https://s3.us-east-1.amazonaws.com",
      "us-east-1",
      [],
    );
    expect(result).not.toBeNull();
    expect(result).toContain("us-east-1");
    expect(result).toContain("not an EU AWS region");
  });

  it("AWS non-EU region → reject regardless of a populated (irrelevant) allowlist", () => {
    const result = checkEuResidency(
      "https://s3.us-east-1.amazonaws.com",
      "us-east-1",
      ["s3.railway-eu-amsterdam.example.com"],
    );
    expect(result).not.toBeNull();
  });
});

describe("checkEuResidency — non-AWS endpoint branch (OWASP A05 fix)", () => {
  const RAILWAY_HOST = "s3.railway-eu-amsterdam.example.com";
  const RAILWAY_ENDPOINT = `https://bucket.${RAILWAY_HOST}`;

  it("non-AWS host present in REFUND_S3_EU_ENDPOINT_HOSTS → pass (exact host match)", () => {
    const result = checkEuResidency("https://" + RAILWAY_HOST, "auto", [
      RAILWAY_HOST,
    ]);
    expect(result).toBeNull();
  });

  it("non-AWS host present in REFUND_S3_EU_ENDPOINT_HOSTS → pass (subdomain match)", () => {
    const result = checkEuResidency(RAILWAY_ENDPOINT, "auto", [RAILWAY_HOST]);
    expect(result).toBeNull();
  });

  it("non-AWS host NOT in the allowlist → reject", () => {
    const result = checkEuResidency(
      "https://bucket.s3.us-somewhere.example.com",
      "auto",
      [RAILWAY_HOST],
    );
    expect(result).not.toBeNull();
    expect(result).toContain("does not match any entry");
  });

  it("empty allowlist → reject (fail closed — the regression this fix closes)", () => {
    const result = checkEuResidency(RAILWAY_ENDPOINT, "auto", []);
    expect(result).not.toBeNull();
    expect(result).toContain("REFUND_S3_EU_ENDPOINT_HOSTS is empty/unset");
  });

  it("case-insensitive host matching", () => {
    const result = checkEuResidency(
      `https://Bucket.${RAILWAY_HOST.toUpperCase()}`,
      "auto",
      [RAILWAY_HOST],
    );
    expect(result).toBeNull();
  });

  it("does not match an unrelated host that merely CONTAINS the allowlist entry as a substring", () => {
    // e.g. "evil-s3.railway-eu-amsterdam.example.com.attacker.net" must NOT
    // be accepted just because the allowlisted string appears somewhere in it.
    const result = checkEuResidency(
      `https://${RAILWAY_HOST}.attacker.net`,
      "auto",
      [RAILWAY_HOST],
    );
    expect(result).not.toBeNull();
  });

  it("an unparsable endpoint URL → reject with a clear message", () => {
    const result = checkEuResidency("not-a-url", "auto", [RAILWAY_HOST]);
    expect(result).not.toBeNull();
    expect(result).toContain("is not a valid URL");
  });
});

describe("needsPathStyleAddressing", () => {
  it("false for AWS", () => {
    expect(needsPathStyleAddressing("https://s3.amazonaws.com")).toBe(false);
  });

  it("true for a non-AWS endpoint", () => {
    expect(
      needsPathStyleAddressing("https://bucket.s3.railway-eu-amsterdam.example.com"),
    ).toBe(true);
  });
});
