/**
 * ConditionChip — glyph+text chip describing one condition attached to a
 * permission rule (T15, specs/004-auth-roles-permissions, design.md Screen
 * A2: "condition badges ('Own records' / 'Entity' / 'Department' / 'Job
 * title')" and the component inventory's "Condition badges (Own/Any,
 * Entity/Dept/JobTitle chips)").
 *
 * `kind` mirrors the plan's `conditions` JSON shape verbatim
 * (plan.md §Data model): `{ ownership: "own" | "any", attributes: [{ key:
 * "entity" | "department" | "jobTitle" }] }` — so a rule row (Screen A2)
 * renders one ownership chip (`own`/`any`) plus zero or more attribute chips
 * (`entity`/`department`/`jobTitle`) with no translation layer needed
 * between the API contract and the UI.
 *
 * `self-approval` (T4, specs/010-self-approval-control, ADR-0026) is a NEW
 * chip kind for the `{key:"self-approval", match:"deny"}` attribute — a
 * deny carve-out on `request:approve`, the opposite polarity of the
 * affirmative `entity`/`department`/`jobTitle` attributes above. It always
 * renders as its OWN chip (attributes are separate array entries, so this
 * falls out of the existing per-attribute chip mapping) — never merged with
 * or hidden inside the entity chip (AC-1.4).
 *
 * NEW, small component; follows the same glyph-or-icon-plus-text badge
 * convention as `SystemBadge` / estimai-ui's `StatusBadge`/`WarningBadge` —
 * colour is never the only signal (design.md "Accessibility — contrast").
 */

export type ConditionChipKind = 'own' | 'any' | 'entity' | 'department' | 'jobTitle' | 'self-approval'

const CONDITION_META: Record<ConditionChipKind, { glyph: string; label: string; colorVar: string }> = {
  own: { glyph: '◉', label: 'Own records', colorVar: 'var(--acc)' },
  any: { glyph: '○', label: 'Any records', colorVar: 'var(--soft)' },
  entity: { glyph: '⌂', label: 'Entity', colorVar: 'var(--grn)' },
  department: { glyph: '▤', label: 'Department', colorVar: 'var(--grn)' },
  jobTitle: { glyph: '◈', label: 'Job title', colorVar: 'var(--grn)' },
  'self-approval': { glyph: '⚖', label: 'No self-approval', colorVar: 'var(--red)' },
}

export type ConditionChipProps = {
  kind: ConditionChipKind
}

export default function ConditionChip({ kind }: ConditionChipProps) {
  const meta = CONDITION_META[kind]

  return (
    <span
      data-testid={`condition-chip-${kind}`}
      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded"
      style={{ color: meta.colorVar, backgroundColor: 'color-mix(in srgb, currentColor 10%, transparent)' }}
    >
      <span aria-hidden="true">{meta.glyph}</span>
      <span>{meta.label}</span>
    </span>
  )
}
