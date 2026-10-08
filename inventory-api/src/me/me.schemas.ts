/**
 * Wire shapes for `/me/*` (T16, specs/015; AC-4.1, AC-4.2, ADR-0045).
 *
 * Own serializer, never `AssetView`: a `MyDevice` is built field by field from
 * five named values, so a price, a currency, an entity or a ledger figure
 * cannot reach the employee by a future column or a spread.
 */

import { z } from "@hono/zod-openapi";
import { CategorySchema } from "../assets/register.schemas";

export const MyDeviceSchema = z.object({
  assetId: z.string(),
  description: z.string(),
  category: CategorySchema,
  serialNumber: z.string().nullable(),
  assignedAt: z.string(),
});
export const MyPendingSchema = MyDeviceSchema.extend({ assignmentId: z.string() });

export const MyDevicesResponseSchema = z.object({
  devices: z.array(MyDeviceSchema),
  pending: z.array(MyPendingSchema),
});

export const AssignmentIdParamSchema = z.object({ id: z.string().min(1).max(64) });

export type MyDevice = z.infer<typeof MyDeviceSchema>;
export type MyPending = z.infer<typeof MyPendingSchema>;

export function toMyDevice(
  asset: { id: string; description: string; category: MyDevice["category"]; serialNumber: string | null },
  assignedAt: Date,
): MyDevice {
  return {
    assetId: asset.id,
    description: asset.description,
    category: asset.category,
    serialNumber: asset.serialNumber,
    assignedAt: assignedAt.toISOString(),
  };
}
