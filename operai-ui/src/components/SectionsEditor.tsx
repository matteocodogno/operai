import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { Field } from './Field'
import { Icon } from './Icon'

/** The part of a row the editor owns. A row may carry more fields; they are kept untouched. */
export type Section = { heading: string; body: string }

/** What is wrong with one row, by field. Validation is the app's: pass what it found. */
export type SectionRowErrors = { heading?: ReactNode; body?: ReactNode }

export type SectionsEditorProps<T extends Section = Section> = {
  sections: T[]
  onChange: (sections: T[]) => void
  /** A new blank row, for Add. */
  createSection: () => T
  /** Rows kept at least (Remove is disabled at this count). Default 0. */
  min?: number
  /** Rows allowed at most (Add is disabled at this count). Default: no limit. */
  max?: number
  /** One entry per row, in order; `null`/`undefined` for a row with nothing wrong. */
  rowErrors?: ReadonlyArray<SectionRowErrors | null | undefined>
  /** An error about the list as a whole (too few rows), announced as an alert. */
  listError?: ReactNode
  /**
   * Extra content for each row, under the text: a control that belongs to the
   * app's domain (a marker on one row). It receives the row and its index; to
   * change other rows, call the app's own `onChange`.
   */
  renderRowExtra?: (section: T, index: number) => ReactNode
  disabled?: boolean
  /** Prefix of every `data-testid`: `<p>-sections`, `<p>-sections-error`, `<p>-section-<i>[-up|-down|-remove]`, `<p>-section-add`. */
  testIdPrefix: string
  copy: {
    legend: string
    /** Help text under the legend (the limits, how rows are used). */
    hint?: string
    /** The row's caption ("Section 2"). */
    item: (n: number) => string
    /** The accessible labels of the two inputs ("Heading (2)", "Text (2)"). */
    headingLabel: (n: number) => string
    bodyLabel: (n: number) => string
    moveUp: (n: number) => string
    moveDown: (n: number) => string
    remove: (n: number) => string
    add: string
  }
}

/** Where keyboard focus goes once the app has applied the change. */
type PendingFocus =
  { kind: 'move'; to: number; direction: 'up' | 'down' } | { kind: 'remove'; at: number } | { kind: 'add' }

/**
 * SectionsEditor — an ordered list of headed text rows: heading, text, move
 * up/down, remove, add. Controlled, generic over the row type (extra fields
 * travel with the row), with min/max, per-row errors and a `renderRowExtra`
 * slot for what the app adds to each row. Copy and validation are the app's.
 *
 * Focus is kept where the person is working: after a move it stays on the
 * moved row's button (the other one if that move is now impossible), after a
 * removal it goes to the heading that took the place, after Add to the new
 * row's heading. A `fieldset`, so `disabled` disables everything inside.
 */
export function SectionsEditor<T extends Section>({
  sections,
  onChange,
  createSection,
  min = 0,
  max,
  rowErrors,
  listError,
  renderRowExtra,
  disabled = false,
  testIdPrefix,
  copy,
}: SectionsEditorProps<T>) {
  const root = useRef<HTMLFieldSetElement>(null)
  const pending = useRef<{ focus: PendingFocus; base: T[] } | null>(null)

  // After the app has applied a structural change, put focus where the person was working.
  useEffect(() => {
    const current = pending.current
    if (!current || current.base === sections) return
    pending.current = null
    const query = (selector: string) => root.current?.querySelector<HTMLElement>(selector)
    const { focus } = current
    if (focus.kind === 'move') {
      const last = sections.length - 1
      const wanted = focus.direction === 'up' ? (focus.to > 0 ? 'up' : 'down') : focus.to < last ? 'down' : 'up'
      query(`[data-row="${focus.to}"] [data-action="${wanted}"]`)?.focus()
    } else if (focus.kind === 'remove') {
      const at = Math.min(focus.at, sections.length - 1)
      if (at >= 0) query(`[data-row="${at}"] [data-field="heading"]`)?.focus()
      else query('[data-action="add"]')?.focus()
    } else {
      query(`[data-row="${sections.length - 1}"] [data-field="heading"]`)?.focus()
    }
  }, [sections])

  const change = (next: T[], focus: PendingFocus | null) => {
    pending.current = focus ? { focus, base: sections } : null
    onChange(next)
  }
  const update = (index: number, patch: Partial<T>) =>
    change(
      sections.map((section, at) => (at === index ? { ...section, ...patch } : section)),
      null,
    )
  const move = (from: number, to: number) => {
    const next = [...sections]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item!)
    change(next, { kind: 'move', to, direction: to < from ? 'up' : 'down' })
  }

  return (
    <fieldset ref={root} className="sections-editor" disabled={disabled} data-testid={`${testIdPrefix}-sections`}>
      <legend className="field-label">{copy.legend}</legend>
      {copy.hint && <p className="sections-editor-hint">{copy.hint}</p>}
      {listError && (
        <p className="form-error" role="alert" data-testid={`${testIdPrefix}-sections-error`}>
          {listError}
        </p>
      )}
      {sections.map((section, index) => {
        const errors = rowErrors?.[index] ?? null
        const n = index + 1
        return (
          <div
            key={index}
            className="sections-editor-row"
            data-row={index}
            data-testid={`${testIdPrefix}-section-${index}`}
          >
            <div className="sections-editor-row-head">
              <span className="sections-editor-row-label">{copy.item(n)}</span>
              <span className="sections-editor-row-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  aria-label={copy.moveUp(n)}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                  data-action="up"
                  data-testid={`${testIdPrefix}-section-${index}-up`}
                >
                  <Icon name="arrow-up" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  aria-label={copy.moveDown(n)}
                  disabled={index === sections.length - 1}
                  onClick={() => move(index, index + 1)}
                  data-action="down"
                  data-testid={`${testIdPrefix}-section-${index}-down`}
                >
                  <Icon name="arrow-down" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  aria-label={copy.remove(n)}
                  disabled={sections.length <= min}
                  onClick={() =>
                    change(
                      sections.filter((_, at) => at !== index),
                      { kind: 'remove', at: index },
                    )
                  }
                  data-action="remove"
                  data-testid={`${testIdPrefix}-section-${index}-remove`}
                >
                  <Icon name="trash" />
                </Button>
              </span>
            </div>
            <Field label={copy.headingLabel(n)} required error={errors?.heading}>
              {(control) => (
                <input
                  {...control}
                  value={section.heading}
                  data-field="heading"
                  onChange={(event) => update(index, { heading: event.target.value } as Partial<T>)}
                />
              )}
            </Field>
            <Field label={copy.bodyLabel(n)} error={errors?.body}>
              {(control) => (
                <textarea
                  {...control}
                  rows={5}
                  value={section.body}
                  onChange={(event) => update(index, { body: event.target.value } as Partial<T>)}
                />
              )}
            </Field>
            {renderRowExtra?.(section, index)}
          </div>
        )
      })}
      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={max !== undefined && sections.length >= max}
          onClick={() => change([...sections, createSection()], { kind: 'add' })}
          data-action="add"
          data-testid={`${testIdPrefix}-section-add`}
        >
          {copy.add}
        </Button>
      </div>
    </fieldset>
  )
}
