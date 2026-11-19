import { Banner } from '@operai/ui'
import { strings } from '../strings'

/** The compact, auto-dismissing confirmation of the person's own action (copied from letterheads-ui's `Saved`). */
export function Saved({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <Banner
      tone="success"
      compact
      autoDismiss
      onDismiss={onDismiss}
      dismissLabel={strings.common.dismiss}
      data-testid="accounting-saved"
    >
      {message}
    </Banner>
  )
}
