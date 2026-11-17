import { Banner } from './Banner'

export type ErrorSummaryItem = {
  /** What `onGo` receives: the id (or path) of the control that holds the problem. */
  id: string
  /** The sentence, naming the value in words: "{Value}: {what to do}". The same text the control's own error says. */
  text: string
}

export type ErrorSummaryProps = {
  /** "Nothing was saved. 3 values need your attention." — app-owned copy, count included. */
  title: string
  /** One line under the title, e.g. how to use the list. Omit when the title says enough. */
  hint?: string
  /** The problems of the refused save, in the order the page shows its controls. Empty renders nothing. */
  items: readonly ErrorSummaryItem[]
  /** Moves focus to the control of the item (find the control, `.focus()`). */
  onGo: (id: string) => void
  /** Prefix for `data-testid`s: the banner is `testId`, its title `${testId}-title`, each button `${testId}-item`. */
  testId?: string
}

/**
 * ErrorSummary — the list of what a refused save refused. An assertive `danger` Banner (`role="alert"`:
 * announced once, when it appears) whose title says that nothing was saved and how many values need attention,
 * over one button per problem that moves focus to its control. It is the second way in: the page has already
 * moved focus to the first refused control, and every control carries its own `aria-invalid` and error.
 * Presentational: it holds no copy and fetches nothing.
 */
export function ErrorSummary({ title, hint, items, onGo, testId }: ErrorSummaryProps) {
  if (items.length === 0) return null
  return (
    <Banner
      tone="danger"
      live="assertive"
      title={title}
      titleTestId={testId ? `${testId}-title` : undefined}
      data-testid={testId}
    >
      {hint && <p className="m-0">{hint}</p>}
      <ul className={hint ? 'm-0 mt-2 flex list-none flex-col gap-1 p-0' : 'm-0 flex list-none flex-col gap-1 p-0'}>
        {items.map((item, index) => (
          <li key={`${item.id}|${index}`}>
            <button
              type="button"
              className="link cursor-pointer border-0 bg-transparent p-0 text-left text-sm"
              onClick={() => onGo(item.id)}
              data-testid={testId ? `${testId}-item` : undefined}
            >
              {item.text}
            </button>
          </li>
        ))}
      </ul>
    </Banner>
  )
}
