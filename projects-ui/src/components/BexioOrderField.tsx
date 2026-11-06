import { useState } from 'react'
import { Button, FactList, Field } from '@operai/ui'
import { useScope } from '../hooks/useScope'
import { isStaleWrite } from '../lib/api'
import { errorMessage, fieldErrorOf } from '../lib/errors'
import { setBexioOrderId } from '../lib/projectsApi'
import type { PurchaseOrder } from '../lib/types'
import { maxLength, optional } from '../lib/validate'
import { strings } from '../strings'

const MAX_LENGTH = 64

/**
 * BexioOrderField — a purchase order's Bexio order id (specs/021 AC-3.1 – AC-3.3). Only a holder
 * of the Bexio-order capability (`GET /scope`'s `bexio`) gets an input; everyone
 * else reads the value, with no control (the server refuses them too). The id is
 * free text up to 64 characters, trimmed; an empty field clears it. Saving sends
 * the purchase order's `version` as If-Match and bumps it, so someone who
 * edited the same purchase order meanwhile is the one asked to reload (`onStale`).
 */
export default function BexioOrderField({
  projectId,
  purchaseOrder,
  onSaved,
  onStale,
}: {
  projectId: string
  purchaseOrder: Pick<PurchaseOrder, 'id' | 'bexioOrderId' | 'version'>
  onSaved: (next: PurchaseOrder) => void
  onStale: () => void
}) {
  const t = strings.purchaseOrder.bexio
  const { bexio } = useScope()
  const current = purchaseOrder.bexioOrderId ?? ''
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!bexio) {
    return (
      <FactList
        testId={`purchase-order-bexio-${purchaseOrder.id}`}
        items={[{ id: 'bexio', term: t.label, value: purchaseOrder.bexioOrderId ?? t.none }]}
      />
    )
  }

  const submit = () => {
    const tooLong = maxLength(value, MAX_LENGTH)
    setError(tooLong === null ? null : t.tooLong)
    if (tooLong !== null) return
    setBusy(true)
    setBexioOrderId(projectId, purchaseOrder.version, optional(value)).then(
      (next) => {
        setBusy(false)
        setValue(next.bexioOrderId ?? '')
        onSaved(next)
      },
      (failure: unknown) => {
        setBusy(false)
        if (isStaleWrite(failure)) return onStale()
        setError(fieldErrorOf(failure)?.message ?? errorMessage(failure))
      },
    )
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy) submit()
      }}
      data-testid={`purchase-order-bexio-${purchaseOrder.id}`}
    >
      <Field label={t.label} hint={t.hint} error={error}>
        {(control) => (
          <div className="flex items-start gap-2">
            <input
              {...control}
              className="min-w-0 flex-1"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <Button type="submit" busy={busy} disabled={value.trim() === current}>
              {busy ? t.saving : t.save}
            </Button>
          </div>
        )}
      </Field>
    </form>
  )
}
