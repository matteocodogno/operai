/**
 * What a browser does when the focused control stops being focusable, which jsdom does not (specs/20261116-record-hours-in-place,
 * QE D2). A button that becomes `disabled`, or a field inside a `<fieldset disabled>`, loses focus and the document's focus
 * is left on <body> (the HTML "focus fixup rule", run when the page is next rendered); jsdom keeps `document.activeElement`
 * on the disabled control. A dialog's Save is disabled while a save runs and so is every field, so without this a test cannot
 * see a focus that a person loses to a refusal: it would find the keyboard on Save because nothing ever took it off.
 *
 * Call it before the render and undo it with what it returns. A task after a `disabled` attribute changes, if the focused
 * control is still disabled then, focus goes to the body; a control that was enabled again in the meantime keeps it. That
 * is also why a request that answers within the same task (a mock that rejects at once) never loses focus, and a test of it
 * has to answer later, as a request does (`rejectAfterAFrame`).
 */
export const emulateFocusFixup = (): (() => void) => {
  let scheduled: ReturnType<typeof setTimeout> | undefined
  const fixup = () => {
    scheduled = undefined
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || active === document.body || !active.matches(':disabled')) return
    // `blur()` does nothing on a control that is no longer a focus target, so focus is given to the body itself.
    const tabindex = document.body.getAttribute('tabindex')
    document.body.setAttribute('tabindex', '-1')
    document.body.focus()
    if (tabindex === null) document.body.removeAttribute('tabindex')
    else document.body.setAttribute('tabindex', tabindex)
  }
  const observer = new MutationObserver(() => {
    scheduled ??= setTimeout(fixup, 0)
  })
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['disabled'] })
  return () => {
    observer.disconnect()
    clearTimeout(scheduled)
  }
}

/** `value` once the time a request takes has passed: a page is rendered (and focus fixed up) before it answers. */
export const afterAFrame = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 40))

/** A save that takes as long as one does and is then refused with `error`. */
export const rejectAfterAFrame = (error: unknown): Promise<never> =>
  afterAFrame(undefined).then(() => Promise.reject(error))
