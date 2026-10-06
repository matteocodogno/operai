/**
 * strings.categories — the label of each `AssetCategory` wire value, shared by
 * the assets list filter (T29), the register form (T30) and the devices view
 * (T31). Filled by T29 because three pages need it and no task's `touch:` list
 * owned it (reported as drift on T29).
 */
export const categories = {
  laptop: 'Laptop',
  desktop: 'Desktop',
  phone: 'Phone',
  tablet: 'Tablet',
  monitor: 'Monitor',
  peripheral: 'Peripheral',
  other: 'Other',
} as const
