/**
 * Zod schemas for the push device routes (T5, specs/20261111-push-notifications, plan.md
 * §API contracts). The response DTO is deliberately the ONLY shape a device leaves the
 * service in: `endpoint`, `p256dh` and `auth` are subscription secrets and have no field here.
 */

import { createECDH } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { NO_NUL, hasNoNul } from "@/lib/nulInput";
import { MAX_PUSH_ENDPOINT_LENGTH } from "./pushEndpoint";

// Canonical unpadded base64url of exactly `bytes` bytes (the round trip rejects stray bits).
const base64UrlBytes = (bytes: number) => (v: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return false;
  const buf = Buffer.from(v, "base64url");
  return buf.length === bytes && buf.toString("base64url") === v;
};

// A 65-byte p256dh must also be a point on P-256: an invalid one would make the encryption
// of every later push throw. computeSecret validates the point and throws otherwise.
const isP256Point = (v: string) => {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(Buffer.from(v, "base64url"));
    return true;
  } catch {
    return false;
  }
};

export const PushConfigResponseSchema = z
  .union([
    z.object({ enabled: z.literal(true), vapidPublicKey: z.string() }),
    z.object({ enabled: z.literal(false) }),
  ])
  .openapi("PushConfig");

export const RegisterDeviceSchema = z
  .object({
    // Length is a schema (400) concern; whether the host is a push service is the 422.
    endpoint: z.string().min(1).max(MAX_PUSH_ENDPOINT_LENGTH).refine(hasNoNul, NO_NUL),
    keys: z.object({
      p256dh: z
        .string()
        .refine(base64UrlBytes(65), "p256dh must be 65 bytes of unpadded base64url")
        .refine(isP256Point, "p256dh must be a P-256 point"),
      auth: z.string().refine(base64UrlBytes(16), "auth must be 16 bytes of unpadded base64url"),
    }),
  })
  .openapi("RegisterPushDevice");

export const PushDeviceSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    createdAt: z.string().datetime(),
  })
  .openapi("PushDevice");

export const PushDeviceListSchema = z.object({ items: z.array(PushDeviceSchema) }).openapi("PushDeviceList");

export const DeviceIdParamSchema = z.object({
  id: z.string().min(1).refine(hasNoNul, NO_NUL).openapi({ param: { name: "id", in: "path" } }),
});

/** RFC 7807 Problem JSON with the machine-readable `code` extension member the plan names. */
export const PushProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number(),
    detail: z.string(),
    instance: z.string(),
    code: z.string().optional(),
  })
  .openapi("PushProblem");
