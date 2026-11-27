import { Banner, Card } from '@operai/ui'
import { consumptionOf } from '../lib/consumption'
import { useExtensionSeam } from '../lib/extensionSeam'
import type { Terms } from '../lib/types'
import { strings } from '../strings'
import ConsumptionBlock from './ConsumptionBlock'
import ExtensionContain from './ExtensionContain'
import { Loading } from './LoadState'

const unavailable = (
  <Banner tone="info" data-testid="project-hours-unavailable">
    {strings.project.hours.unavailable}
  </Banner>
)

const loadingSlot = <Loading label={strings.project.hours.loading} rows={1} />

/**
 * HoursSection — the ONE "Hours" card of the project page, right after Details (specs/20261112-project-hours AC-1.1,
 * AC-1.7, AC-2.1, AC-2.6, AC-4.9; design S1, D80). It holds two parts, top to bottom, and each is complete or absent:
 *
 * 1. the **consumption block** (this app's): what the terms sold set against the hours used, when the terms sold
 *    something comparable — otherwise nothing, and then no divider either (AC-1.7, D82);
 * 2. hours-ui's own **panel** (the total recorded and, behind a closed disclosure, the breakdown), a federated
 *    component loaded through the shell's `shell/extensions` seam as `hours.hostHours` with `{ on: 'project', targetId }`
 *    and nothing else (ADR 20261104-host-extension-federated-panel-through-the-shell, plan D-P4).
 *
 * Unlike `MeetingsSection`, which swaps a whole card for its fallback, this section owns the card: the frame and its
 * title are drawn in every state, and only the panel's slot changes — the loading line, the panel, or the host's own
 * "Hours are unavailable" notice, which a shell that predates the expose, a failing import, a module without
 * `HostExtension`, a panel that throws or one that does not answer in 5 s all end at. The block does not wait for the
 * seam and the notice does not hide the block: the two read from different owners and fail on their own, so a figure is
 * never taken from a part that could not read it. No retry on the notice: a failed module import is cached, so it says
 * to reload the page; the block's and the panel's own failures have their own Retry.
 *
 * Whether the person may see this project's hours is hours-api's answer as the caller; this host checks no permission
 * (AC-2.1: everyone who can read the project sees the card).
 */
export default function HoursSection({ projectId, terms }: { projectId: string; terms: Terms | null }) {
  const seam = useExtensionSeam()
  // The divider is drawn only between two parts, so only when the block is: `consumptionOf` says "none" for no terms and
  // for terms with nothing to compare, and anything else is a block (drawn from the terms, or read from hours-api).
  const hasBlock = consumptionOf(terms, null).variant !== 'none'
  return (
    <Card title={strings.project.hours.heading} data-testid="project-hours">
      <div className="flex flex-col gap-4">
        <ConsumptionBlock projectId={projectId} terms={terms} />
        {hasBlock && <div className="border-t border-rule" aria-hidden="true" data-testid="project-hours-divider" />}
        {seam.status === 'loading' ? (
          loadingSlot
        ) : seam.status === 'failed' ? (
          unavailable
        ) : (
          <ExtensionContain widget="the Hours section" resetKey={projectId} fallback={unavailable}>
            <seam.HostExtension
              name="hours.hostHours"
              props={{ on: 'project', targetId: projectId }}
              fallback={unavailable}
              loading={loadingSlot}
              resetKey={projectId}
            />
          </ExtensionContain>
        )}
      </div>
    </Card>
  )
}
