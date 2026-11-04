import type { ReactNode } from 'react'
import type { Range } from './fold'

/** Text with the given ranges wrapped in `<mark>` — plain text nodes only, never markup from the text. */
export function Highlight({ text, ranges }: { text: string; ranges: Range[] }) {
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let cursor = 0
  ranges.forEach((range, i) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push(
      <mark key={i} className="bg-acc/20 text-text">
        {text.slice(range.start, range.end)}
      </mark>,
    )
    cursor = range.end
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}
