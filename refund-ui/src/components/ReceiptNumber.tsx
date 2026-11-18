/**
 * ReceiptNumber — a line's receipt number (`MC26/014`), in full, in mono, with a visually hidden
 * "Receipt number" label so a screen reader hears what the code is (specs/20261118-refund-accounting-export,
 * design S9, UX-8). One rule, three call sites: the line row, the request page and the batch page.
 *
 * Renders nothing for a line without one (not yet approved, or rejected): never a dash or a placeholder.
 */

import { VisuallyHidden } from '@operai/ui'
import { strings } from '../strings'

export type ReceiptNumberProps = {
  value: string | null | undefined
}

export default function ReceiptNumber({ value }: ReceiptNumberProps) {
  if (value === null || value === undefined || value === '') return null
  return (
    <span className="font-mono text-sm" data-testid="receipt-number">
      <VisuallyHidden>{`${strings.pages.requestDetail.lines.receiptNumberLabel} `}</VisuallyHidden>
      {value}
    </span>
  )
}
