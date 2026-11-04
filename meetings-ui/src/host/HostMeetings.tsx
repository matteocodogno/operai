import 'shell/tokens.css'
import { Card } from '@operai/ui'
import { strings } from '../strings'

/** The three strings a host passes (plan § Host integration contract › The UI half); nothing else. */
export type HostMeetingsProps = {
  hostApp: string
  entityType: string
  entityId: string
}

/**
 * HostMeetings — the remote's third exposed entry, `./HostMeetings` (vite.config.ts `exposes`),
 * loaded by the shell's `HostExtension` inside a host's page, e.g. the CRM deal (ADR-0060). It draws
 * a `Card` and no frame of its own. Placeholder (T53): T76 fills the list, Start meeting and the
 * link dialog in place. As with `App`, it must not import this package's own `index.css`.
 */
export default function HostMeetings(props: HostMeetingsProps) {
  void props // T76 reads hostApp, entityType and entityId
  return (
    <Card title={strings.host.panel.title} data-testid="meetings-host-panel">
      {null}
    </Card>
  )
}
