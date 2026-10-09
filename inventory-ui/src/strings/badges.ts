/**
 * strings.badges — the labels of the status chips (T26, specs/015-hardware-
 * inventory; design.md § NEW components: AssetStatusBadge). The entity and
 * currency chips' labels live in `strings.common` (T25).
 */
export const badges = {
  /** `AssetStatusBadge`'s label per `AssetStatus` — verbatim the six wire values. */
  assetStatus: {
    ordered: 'Ordered',
    in_stock: 'In stock',
    assigned: 'Assigned',
    in_repair: 'In repair',
    lost: 'Lost',
    disposed: 'Disposed',
  },
} as const
