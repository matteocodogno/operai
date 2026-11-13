/**
 * The export button and the workbook's headers and placeholders (T30). A stub from T22: the task
 * that owns this area fills it, and no other task edits it.
 *
 * `export` is a reserved word, so this one module exports `exportStrings` instead of `export`
 * (the aggregate still calls the namespace `strings.export`).
 */
const en = {}

const it: typeof en = {}

export const exportStrings = { en, it }
