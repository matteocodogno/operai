import { useEffect, useRef, useState } from 'react'
import { Combobox } from './Combobox'
import type { ComboboxOption } from './Combobox'
import { Field } from './Field'

/**
 * What the app's `search` answers. The library knows nothing of the app's HTTP client, so the app
 * maps its own 403 to `forbidden` (the caller may not search this kind of record) and its 503 or
 * network failure to `unavailable`.
 */
export type SearchResult<T> = { ok: true; items: T[] } | { ok: false; reason: 'forbidden' | 'unavailable' }

export type SearchPickerProps<T> = {
  label: string
  hint?: string
  required?: boolean
  /** The field's error (from validation or a 422); the app writes the sentence. */
  error?: string | null
  /** Closed to input and to searching, e.g. while a dialog saves. */
  disabled?: boolean
  /** The picked item. The field shows `toOption(value).label`; it follows the app when this changes. */
  value: T | null
  /** The picked item, or `null` as soon as the person types after a pick. Free text is never reported. */
  onChange: (value: T | null) => void
  /**
   * The server-side search, called once the person stops typing. `q` is the trimmed text and is `''`
   * when the list opens on an empty field. Pass `signal` to `fetch`: it aborts when the text changes,
   * the list closes or the picker unmounts. The latest function is used, so a new one on every render
   * is fine. A rejection or a throw reads as `unavailable`.
   */
  search: (q: string, signal: AbortSignal) => Promise<SearchResult<T>>
  /** How an item shows in the list and, after a pick, in the field. `id` is unique per list. */
  toOption: (item: T) => ComboboxOption
  messages: {
    /** In the list, and announced, while the answer for this text has not arrived. */
    searching: string
    noMatch: string
    forbidden: string
    unavailable: string
    /** The polite announcement of how many items the answer holds (never called with 0). */
    count: (n: number) => string
  }
  /** How long the typing must pause before searching. Default 250 ms. */
  delayMs?: number
  /** `data-testid` of the field; the input is `<testId>-input`, its list `<testId>-input-listbox`. */
  testId: string
}

const DEFAULT_DELAY_MS = 250

type Answer<T> = { session: number; q: string; result: SearchResult<T> }

/**
 * SearchPicker — pick one record out of a search the SERVER answers (a project, a deal, a company),
 * where `PersonPicker` filters a list it already holds. A `Combobox` in a `Field` that owns what the
 * "dumb" `Combobox` leaves to the caller:
 *
 * - debounce, then one `search` call per settled text; a new text, a closed list or an unmount
 *   aborts the request in flight, and an answer to an older text is discarded even when the app's
 *   `search` ignores the signal;
 * - picked, never typed: typing after a pick reports `null`, and what is typed is never reported;
 * - what the list says while it has no options: searching, no match, forbidden, unavailable, each
 *   also announced politely, and the number of results when there are some;
 * - every time the list opens it asks again and says "searching" until that answer arrives (a
 *   cached list could be one permission or one booking out of date).
 *
 * The text in the field is the value's label, or what the person is typing. Half-typed text is
 * dropped when the app sets a value; to clear it from outside with the value staying `null`
 * (a "Clear filters" button), give the picker a new `key`.
 */
export function SearchPicker<T>({
  label,
  hint,
  required = false,
  error,
  disabled = false,
  value,
  onChange,
  search,
  toOption,
  messages,
  delayMs = DEFAULT_DELAY_MS,
  testId,
}: SearchPickerProps<T>) {
  const [draft, setDraft] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  // Which opening of the list an answer belongs to (an answer is only valid for its own).
  const [session, setSession] = useState(0)
  const [answer, setAnswer] = useState<Answer<T> | null>(null)

  const picked = value === null ? null : toOption(value)
  const pickedId = picked?.id ?? null
  // A value the app sets (another item, a reset) replaces half-typed text. Compared by id so that an
  // app passing a new object for the same item on every render does not loop.
  const [seenId, setSeenId] = useState(pickedId)
  if (pickedId !== seenId) {
    setSeenId(pickedId)
    if (pickedId !== null) setDraft(null)
  }

  const text = draft ?? picked?.label ?? ''
  const q = text.trim()
  const isOpen = open && !disabled

  const searchRef = useRef(search)
  useEffect(() => {
    searchRef.current = search
  })

  useEffect(() => {
    if (!isOpen) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      new Promise<SearchResult<T>>((resolve) => resolve(searchRef.current(q, controller.signal)))
        .catch((): SearchResult<T> => ({ ok: false, reason: 'unavailable' }))
        .then((result) => {
          if (!controller.signal.aborted) setAnswer({ session, q, result })
        })
    }, delayMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [isOpen, q, session, delayMs])

  const settled = answer !== null && answer.session === session && answer.q === q ? answer.result : null
  const entries = (settled?.ok ? settled.items : []).map((item) => ({ item, option: toOption(item) }))
  const status =
    settled === null
      ? messages.searching
      : settled.ok
        ? entries.length > 0
          ? messages.count(entries.length)
          : messages.noMatch
        : messages[settled.reason]

  const openList = () => {
    if (disabled) return
    if (!open) setSession((current) => current + 1)
    setOpen(true)
  }

  return (
    <Field label={label} hint={hint} error={error} required={required} testId={testId}>
      {(control) => (
        <Combobox
          id={control.id}
          ariaInvalid={control['aria-invalid']}
          ariaDescribedBy={control['aria-describedby']}
          ariaRequired={control['aria-required']}
          value={text}
          onValueChange={(next) => {
            setDraft(next)
            openList()
            if (value !== null) onChange(null)
          }}
          options={entries.map((entry) => entry.option)}
          onSelect={(option) => {
            const entry = entries.find((candidate) => candidate.option.id === option.id)
            if (!entry) return
            setDraft(null)
            setOpen(false)
            onChange(entry.item)
          }}
          isOpen={isOpen}
          onOpenChange={(next) => (next ? openList() : setOpen(false))}
          onFocus={openList}
          onBlur={() => setOpen(false)}
          emptyState={status}
          liveRegionText={isOpen ? status : ''}
          disabled={disabled}
          testId={`${testId}-input`}
        />
      )}
    </Field>
  )
}
