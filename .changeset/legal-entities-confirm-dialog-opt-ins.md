---
'@operai/ui': minor
---

`ConfirmDialog` gets three opt-in props; without them every dialog looks and behaves as before. `scrollBody` caps the dialog at the screen's height and scrolls its body between the title and the footer, so Cancel and Confirm stay in view with a long body on a 320 px phone (`Dialog` takes the same `scrollBody`). `confirmDisabledReason` makes Confirm `aria-disabled` and described by a reason while it cannot be used yet (details still loading or unreadable), keeping it a focus stop while Cancel, Escape and × keep working. `size` sets the dialog's width, and `Dialog` gets a `wide` size (520 px).
