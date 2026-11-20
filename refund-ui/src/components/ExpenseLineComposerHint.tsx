/**
 * The split-receipt hint, shared by the add-line form (`ExpenseLineComposer`) and the in-place line editor
 * (`ExpenseLineRow`, edit mode) — specs/20261119-accounting T83, SG-1 and SG-2 of specs/20261118-refund-accounting-export
 * design.md "Sign-off round sync". One rule in one place: the hint is shown for a WellD CH line with an Amount
 * (never mileage), validates nothing, and:
 *
 *   - sits AFTER the Entity (the field it depends on) in document order, below the grid of fields, so a keyboard user who
 *     fills the form in order meets it where it applies, and its appearance never reflows the row of fields;
 *   - lives in a polite live region that is always mounted (an empty region is announced nothing; content added to it
 *     is announced), so choosing WellD CH says the sentence once, without moving focus;
 *   - describes both the Entity select and the Amount input (`aria-describedby`), so it is read when either is focused.
 */

export function SplitReceiptHint({ id, shown, text }: { id: string; shown: boolean; text: string }) {
  return (
    <div aria-live="polite" data-testid={`${id}-region`}>
      {shown && (
        <p id={id} className="field-hint mt-2" data-testid={id}>
          {text}
        </p>
      )}
    </div>
  )
}
