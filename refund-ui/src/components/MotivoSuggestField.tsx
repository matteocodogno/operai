/**
 * MotivoSuggestField — the Motivo text input of a `travel_km` expense line,
 * with an ARIA combobox-with-listbox popup offering the employee's own past
 * trips (T11, specs/014-motivo-autocomplete/tasks.md; design.md in full).
 *
 * It is the SAME `<input id="composer-motivo">` the composer has always had:
 * this component layers behaviour onto it, it does not add, move or restyle a
 * field. `ExpenseLineComposer` keeps owning the draft; this component owns
 * only the corpus, the popup and the keyboard.
 *
 * ## The spine — one derived boolean
 *
 *   open = enabled && !disabled && focused && !suppressed
 *          && queryQualifies(value) && matches.length > 0
 *
 * Every "no list" requirement is a conjunct of that expression rather than an
 * error branch (design.md's state table):
 *
 *   - AC-1.1 type is not `travel_km`  → `enabled`
 *   - AC-1.3 below 2 non-ws chars     → `queryQualifies(value)`
 *   - AC-1.6 nothing matches          → `matches.length > 0`
 *   - AC-5.2 corpus fetch failed/timed out → corpus stays `[]`, so
 *                                       `matches.length > 0` is false
 *   - corpus still in flight          → identical to the above, BY CONSTRUCTION
 *   - AC-5.3 Escape dismissed         → `!suppressed`
 *   - AC-5.5 blur / outside pointer    → `focused`
 *
 * There is therefore NO code path here that renders an empty state, a spinner,
 * a caption, a banner, a toast or a `role="alert"`. Design.md S3 (loading),
 * S6 (no match) and S7 (fetch failed) are three distinct causes with ONE
 * identical rendering, and that identity is the design: a loading indicator
 * would be the only thing able to tell them apart, and it would then need a
 * suppression branch on failure, which AC-5.2 forbids. Adding any such surface
 * is a spec violation (AC-1.6, AC-5.2), not a nicety.
 *
 * ## Corpus lifecycle (plan D1/D2/D6/D7)
 *
 *  - LAZY: nothing is fetched when `travel_km` is merely selected — only when
 *    the query FIRST reaches 2 non-whitespace characters, and at most once per
 *    `corpusEpoch`. Picking the type and changing one's mind costs nothing.
 *  - DEBOUNCED 150 ms on the network fetch only. Matching is never debounced —
 *    it is a synchronous filter over <=200 in-memory objects, re-run every
 *    keystroke (plan D2).
 *  - BOTH out-of-order guards, deliberately: a monotonic `requestTokenRef` is
 *    the CORRECTNESS mechanism (a resolved response whose token is stale is
 *    dropped without touching state, so a slow early response can never
 *    overwrite a fast later one — `MileageAmountField`'s exact precedent), and
 *    an `AbortController` is the RESOURCE mechanism (releases the socket on
 *    unmount, on `enabled` going false, and on epoch invalidation). Abort alone
 *    is insufficient: `fetch` abort races an already-resolved promise.
 *  - A 5 s `setTimeout` calling `abort()` implements AC-5.2's "does not answer
 *    in reasonable time".
 *  - ONE `.catch()` swallows every failure — network, 400, 403, 503, timeout,
 *    abort — into an empty corpus. It sets state and returns; it never wraps
 *    render logic, so a developer error cannot be swallowed into a permanently
 *    broken silent state (plan Security §5). It never propagates to
 *    `ExpenseLineComposer`'s own `error` state.
 *  - MEMORY ONLY. Component state that dies with the composer — never
 *    `localStorage`/`sessionStorage`/IndexedDB (ADR-0001's posture applied to
 *    personal data, and the spec's own explicit non-goal).
 *
 * ## The two traps this component exists to not fall into
 *
 * 1. **Enter must not submit the form.** The composer is a `<form>` whose
 *    submit adds the line. If Enter on a highlighted option does not call
 *    `preventDefault()`, the browser fires implicit form submission IN THE SAME
 *    EVENT — React's `setDraft` from the pick has not flushed, so the submit
 *    handler reads the PRE-PICK draft and posts a line with the old km and
 *    entity under the new motivo: a wrong reimbursement amount, added with no
 *    error and no visible sign. `preventDefault()` is therefore called on
 *    EXACTLY one branch (`Enter && open && active >= 0`) and nowhere else; the
 *    `active === -1` branch is byte-identical to today (AC-5.4). For the same
 *    reason an option is a `<li>`, never a `<button>` — a `<button>` inside a
 *    `<form>` defaults to `type="submit"`.
 * 2. **The list must not re-open on the motivo a pick just wrote.** After a
 *    pick, `value` holds a complete past motivo, which qualifies and matches
 *    itself, so the derived `open` would immediately go true again and cover
 *    the field it just filled (AC-3.5). One `suppressed` flag serves both
 *    Escape and pick, and it is cleared ONLY from the input's own `onChange` —
 *    never from a `value` change, because the pick itself changes `value`.
 *
 * ## Rendering
 *
 * Motivo is user-controlled free text and is rendered as React text children
 * only — no `dangerouslySetInnerHTML`, and no matched-substring highlighting
 * (plan D9), so no injection surface exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, FocusEvent as ReactFocusEvent } from 'react'
import { strings } from '../strings'
import { formatDate } from '../lib/dates'
import EntityBadge from './EntityBadge'
import { getTripSuggestions } from '../lib/suggestionsApi'
import type { TripSuggestion } from '../lib/suggestionsApi'
import { MAX_SUGGESTIONS, matchTripSuggestions, queryQualifies } from '../lib/tripSuggestions'

/** Debounce before the ONE corpus fetch (plan D2 — deliberately shorter than `MileageAmountField`'s 400 ms, which guards a fetch that repeats on every edit). */
const CORPUS_FETCH_DEBOUNCE_MS = 150

/** AC-5.2's "does not answer in reasonable time" (plan D2). */
const CORPUS_FETCH_TIMEOUT_MS = 5000

export type MotivoSuggestFieldProps = {
  /** `'composer-motivo'` — also the `data-testid` and the prefix for the `-listbox`/`-option-{i}`/`-live` ids. */
  id: string
  value: string
  onChange: (motivo: string) => void
  /** Fires only on an explicit pick; the parent overwrites motivo + km + entity in one `setDraft` (AC-3.1/3.4). */
  onPick: (suggestion: TripSuggestion) => void
  /** True only when the composer's expense type is `travel_km` (AC-1.1). */
  enabled: boolean
  /** The composer's `submitting`. */
  disabled: boolean
  /** Preserved from the input this component replaces — the composer's Motivo has always been `required`. */
  required?: boolean
  /** Bumped by the parent after a successful add → invalidates the cached corpus (plan D6). */
  corpusEpoch: number
}

export default function MotivoSuggestField({
  id,
  value,
  onChange,
  onPick,
  enabled,
  disabled,
  required = false,
  corpusEpoch,
}: MotivoSuggestFieldProps) {
  const t = strings.components.motivoSuggest
  const entityLabels = strings.badges.entity

  /** Memory only — never any web storage (plan D7, ADR-0001's posture). */
  const [corpus, setCorpus] = useState<readonly TripSuggestion[]>([])
  const [focused, setFocused] = useState(false)
  /** Set by a pick and by Escape; cleared ONLY by the input's own `onChange` (trap 2 above). */
  const [suppressed, setSuppressed] = useState(false)
  const [active, setActive] = useState(-1)
  /** Purely visual pointer feedback — deliberately does NOT set `active`, or an incidental mouse position would silently arm Enter and break AC-5.4. */
  const [hovered, setHovered] = useState(-1)
  /** Bumped by a pick so the caret can be moved to the end AFTER the parent's new `value` has committed. */
  const [pickTick, setPickTick] = useState(0)

  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const requestTokenRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The epoch whose fetch has already been issued — `null` re-arms the lazy fetch (plan D6). */
  const fetchedEpochRef = useRef<number | null>(null)

  const listboxId = `${id}-listbox`
  const liveRegionId = `${id}-live`
  const optionId = (index: number) => `${id}-option-${index}`

  const qualifies = queryQualifies(value)
  const matches = useMemo(() => matchTripSuggestions(corpus, value, MAX_SUGGESTIONS), [corpus, value])

  // THE spine. Every "no list" case is one of these conjuncts.
  const open = enabled && !disabled && focused && !suppressed && qualifies && matches.length > 0

  // `active` can only be advanced while the list is open, but the corpus
  // arriving (or the parent resetting `value`) can shrink `matches` underneath
  // it — clamp rather than trusting the raw index anywhere.
  const activeIndex = active >= 0 && active < matches.length ? active : -1

  /** Releases the socket and invalidates any in-flight response. Touches refs only, so it is stable. */
  const cancelInFlight = useCallback(() => {
    requestTokenRef.current += 1
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  // Epoch invalidation (plan D6): a successful add makes the cached corpus
  // stale, so abort anything in flight and re-arm the lazy fetch for the next
  // threshold crossing. Declared BEFORE the fetch effect so that on an epoch
  // change React runs this reset first and the fetch effect below sees a clean
  // `fetchedEpochRef`.
  useEffect(() => {
    cancelInFlight()
    fetchedEpochRef.current = null
  }, [corpusEpoch, cancelInFlight])

  // Switching the expense type away from `travel_km` must release the socket
  // (design.md "Corpus lifecycle"). The corpus itself is deliberately KEPT: it
  // is already in page memory, so discarding it buys no privacy and costs a
  // request if the employee switches back.
  useEffect(() => {
    if (enabled) return
    cancelInFlight()
  }, [enabled, cancelInFlight])

  // The one lazy, debounced corpus fetch (plan D1/D2/D6).
  useEffect(() => {
    if (!enabled || disabled || !qualifies) return
    if (fetchedEpochRef.current === corpusEpoch) return

    const debounce = setTimeout(() => {
      fetchedEpochRef.current = corpusEpoch
      requestTokenRef.current += 1
      const token = requestTokenRef.current
      const controller = new AbortController()
      abortRef.current = controller
      timeoutRef.current = setTimeout(() => controller.abort(), CORPUS_FETCH_TIMEOUT_MS)

      const settle = () => {
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current)
          timeoutRef.current = null
        }
        if (abortRef.current === controller) abortRef.current = null
      }

      void getTripSuggestions(controller.signal)
        .then((suggestions) => {
          settle()
          // Stale token: a later request already superseded this one. Drop it
          // WITHOUT touching state — this is the correctness guard, and it is
          // why abort alone would not be enough.
          if (requestTokenRef.current !== token) return
          setCorpus(suggestions)
        })
        .catch(() => {
          // AC-5.2: EVERY failure mode — network, 400, 403, 503, the 5 s
          // timeout, an abort — degrades to an empty corpus and nothing else.
          // No banner, no toast, no alert, no retry affordance, and nothing
          // propagated to the composer.
          settle()
          if (requestTokenRef.current !== token) return
          setCorpus([])
        })
    }, CORPUS_FETCH_DEBOUNCE_MS)

    return () => clearTimeout(debounce)
  }, [enabled, disabled, qualifies, corpusEpoch])

  // Unmount: release the socket and the timeout timer.
  useEffect(() => cancelInFlight, [cancelInFlight])

  // `aria-activedescendant` does NOT scroll the popup, so ArrowDown past the
  // last visible row would otherwise move an invisible highlight.
  useEffect(() => {
    if (!open || activeIndex < 0) return
    const element = document.getElementById(`${id}-option-${activeIndex}`)
    // jsdom does not implement scrollIntoView — optional-call it rather than
    // guarding the whole a11y behaviour behind an environment check.
    element?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex, id])

  // After a pick the caret belongs at the END of the inserted motivo, so
  // further typing appends rather than replaces (design.md F2 step 5). This
  // must run AFTER the parent's new `value` has committed — hence a tick
  // counter rather than a dependency on `value`, which a pick that re-writes
  // the identical motivo would not change.
  useEffect(() => {
    if (pickTick === 0) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    const end = input.value.length
    input.setSelectionRange?.(end, end)
  }, [pickTick])

  // AC-5.5's outside-pointer close. Two independent mechanisms are required:
  // the input's own `onBlur` (below) and this document-level listener, because
  // a pointerdown on a non-focusable region does not reliably blur in jsdom —
  // the environment the component tests run in. Added only while open.
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: Event) => {
      const target = event.target
      if (target instanceof Node && wrapperRef.current?.contains(target)) return
      setFocused(false)
      setActive(-1)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  const pick = (suggestion: TripSuggestion) => {
    // Set BEFORE handing control to the parent, so the list cannot flash back
    // open on the motivo the pick is about to write (trap 2).
    setSuppressed(true)
    setActive(-1)
    setHovered(-1)
    onPick(suggestion)
    setPickTick((tick) => tick + 1)
  }

  const handleChange = (nextValue: string) => {
    // The ONLY place `suppressed` is cleared: the employee typing (trap 2).
    setSuppressed(false)
    // A narrowed query re-orders the list, so the option at index 2 is now a
    // DIFFERENT trip. Preserving the index would silently re-aim Enter at
    // something never looked at — and km drives money.
    setActive(-1)
    onChange(nextValue)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!enabled || disabled) return

    switch (event.key) {
      case 'ArrowDown':
        if (open) {
          event.preventDefault()
          setActive((prev) => Math.min(prev + 1, matches.length - 1))
          return
        }
        // Closed: an explicit request to open, which is also the way back from
        // an Escape dismissal. Opening NEVER auto-highlights (AC-5.4).
        if (!focused || !qualifies || matches.length === 0) return
        event.preventDefault()
        setSuppressed(false)
        setActive(-1)
        return

      case 'ArrowUp':
        if (!open) return
        event.preventDefault()
        // Clamps down to -1 ("nothing highlighted"); from -1 it is a no-op.
        setActive((prev) => (prev <= -1 ? -1 : prev - 1))
        return

      case 'Home':
        if (!open) return
        event.preventDefault()
        setActive(0)
        return

      case 'End':
        if (!open) return
        event.preventDefault()
        setActive(matches.length - 1)
        return

      case 'Enter': {
        // ─── THE ENTER TRAP ───────────────────────────────────────────────
        // preventDefault() on EXACTLY this branch and nowhere else. Without
        // it the browser's implicit form submission fires in this same event,
        // before React has flushed the pick's `setDraft`, and the composer
        // posts a line carrying the PRE-PICK km and entity under the new
        // motivo. With `active === -1` we must not touch the event at all —
        // AC-5.4 requires that keypress to behave exactly as it does today.
        if (!open || activeIndex < 0) return
        const suggestion = matches[activeIndex]
        if (!suggestion) return
        event.preventDefault()
        pick(suggestion)
        return
      }

      case 'Escape':
        // Never swallow Escape when there is no popup to dismiss.
        if (!open) return
        event.preventDefault()
        setSuppressed(true)
        setActive(-1)
        return

      case 'Tab':
        // Never picks, and never `preventDefault` — focus must move on
        // normally. The accompanying blur is what closes the list (AC-5.5).
        setActive(-1)
        return

      default:
        return
    }
  }

  const handleBlur = (event: ReactFocusEvent<HTMLInputElement>) => {
    // Moving focus WITHIN the wrapper must not close the list.
    if (event.relatedTarget instanceof Node && wrapperRef.current?.contains(event.relatedTarget)) return
    setFocused(false)
    setActive(-1)
    // Deliberately does NOT set `suppressed`: re-focusing the field re-opens
    // the list, so an accidental click-away is recoverable without typing.
  }

  const optionAccessibleName = (suggestion: TripSuggestion) =>
    t.optionLabel(
      suggestion.motivo,
      suggestion.km,
      entityLabels[suggestion.entity],
      suggestion.count,
      formatDate(suggestion.lastUsedOn),
    )

  return (
    <div ref={wrapperRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        type="text"
        required={required}
        value={value}
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={enabled ? () => setFocused(true) : undefined}
        onBlur={enabled ? handleBlur : undefined}
        data-testid={id}
        // AC-1.1: when the expense type is not `travel_km` NONE of the
        // combobox wiring is rendered — not the roles, and not
        // `autoComplete="off"` either, so the other eleven expense types keep
        // today's native browser-history behaviour byte for byte.
        // `aria-haspopup` is omitted: it is implicit for `role="combobox"`.
        role={enabled ? 'combobox' : undefined}
        aria-expanded={enabled ? open : undefined}
        aria-controls={enabled ? listboxId : undefined}
        aria-autocomplete={enabled ? 'list' : undefined}
        aria-activedescendant={enabled && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete={enabled ? 'off' : undefined}
        className="text-sm px-2.5 py-1.5 border rounded"
        style={{ borderColor: 'var(--rule)', color: 'var(--text)', backgroundColor: 'var(--ink)' }}
      />

      {/*
        ALWAYS mounted, never conditionally rendered — a live region mounted at
        the same moment as its content is not reliably announced. It carries the
        COUNT only, never the option text (`aria-activedescendant` already makes
        the reader announce the active option; duplicating it is the classic
        double-announcement bug), and it is EMPTY in every state except an open
        list with >=1 option — a spoken "no suggestions" would be exactly the
        empty state AC-1.6 forbids, in the audio channel.
      */}
      <p id={liveRegionId} aria-live="polite" data-testid={liveRegionId} className="sr-only">
        {open ? t.available(matches.length) : ''}
      </p>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={t.listboxLabel}
          data-testid={listboxId}
          onMouseLeave={() => setHovered(-1)}
          className="absolute z-10 mt-1 border rounded-md shadow-lg overflow-y-auto"
          style={{
            top: '100%',
            left: 0,
            width: 'max(100%, 20rem)',
            maxWidth: 'calc(100vw - 1.5rem)',
            maxHeight: 'min(18rem, 50vh)',
            backgroundColor: 'var(--ink-mid)',
            borderColor: 'var(--rule)',
            overscrollBehavior: 'contain',
          }}
        >
          {matches.map((suggestion, index) => {
            const isActive = index === activeIndex
            return (
              <li
                // An <li>, never a <button>: a <button> inside a <form>
                // defaults to type="submit" — the Enter trap by another route.
                key={`${suggestion.normalisedMotivo}|${suggestion.km}|${suggestion.entity}`}
                id={optionId(index)}
                role="option"
                aria-selected={isActive}
                aria-label={optionAccessibleName(suggestion)}
                data-testid={`${id}-option-${index}`}
                // Keeps the pointer path from blurring the input before the
                // click lands, so the option is not unmounted under the tap.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHovered(index)}
                onClick={() => pick(suggestion)}
                className="px-3 py-2 cursor-pointer"
                style={{
                  // Two signals for the active option — tint AND a left accent
                  // bar — so it is never conveyed by colour alone (WCAG 1.4.1).
                  // The transparent-to-accent border swap causes no layout shift.
                  borderLeft: isActive ? '3px solid var(--acc)' : '3px solid transparent',
                  backgroundColor: isActive
                    ? 'var(--acc-lo)'
                    : index === hovered
                      ? 'color-mix(in srgb, var(--acc) 6%, transparent)'
                      : 'transparent',
                }}
              >
                {/*
                  Line 1 — identity: the motivo VERBATIM as originally typed
                  (AC-2.5), never the folded form. Truncated with CSS only, so
                  the full string still reaches the accessible name above.
                */}
                <div
                  title={suggestion.motivo}
                  className="text-sm overflow-hidden text-ellipsis whitespace-nowrap"
                  style={{ color: 'var(--text)' }}
                >
                  {suggestion.motivo}
                </div>
                {/*
                  Line 2 — left: the two facts besides motivo that a pick will
                  FILL, and what tells two same-motivo trips apart (AC-2.2).
                  Right: the ranking rationale, AC-2.3's two signals in ranking
                  order, right-aligned so the counts form a visibly
                  non-increasing ladder down the list (AC-1.7).
                */}
                <div className="flex items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--soft)' }}>
                  <span className="flex items-center gap-2">
                    <span>{t.km(suggestion.km)}</span>
                    <EntityBadge entity={suggestion.entity} />
                  </span>
                  <span>{t.usage(suggestion.count, formatDate(suggestion.lastUsedOn))}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
