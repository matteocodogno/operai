/** Ids and wiring of the split-receipt hint (see `ExpenseLineComposerHint.tsx`); kept out of the component file so it exports only a component. */

import type { FieldControlProps } from '@operai/ui'

export const COMPOSER_SPLIT_HINT_ID = 'composer-split-hint'

/** The id of the hint inside one line's in-place editor. */
export const rowSplitHintId = (lineId: string): string => `row-${lineId}-split-hint`

/** A control's props from `Field`, with the hint added to what describes it while the hint is shown. */
export function withSplitHint(control: FieldControlProps, hintId: string, shown: boolean): FieldControlProps {
  if (!shown) return control
  const describedBy = [control['aria-describedby'], hintId].filter(Boolean).join(' ')
  return { ...control, 'aria-describedby': describedBy }
}
