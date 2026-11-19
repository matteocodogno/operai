import { useCallback, useState } from 'react'
import { Button, Card, ListRows, Pagination, StatePanel } from '@operai/ui'
import { listActivities } from '../lib/activitiesApi'
import type { ActivityTarget } from '../lib/activitiesApi'
import type { Activity, CompanyRef } from '../lib/types'
import { useResource } from '../hooks/useResource'
import { strings } from '../strings'
import ActivityFormDialog from './ActivityFormDialog'
import ActivityItem from './ActivityItem'
import ActivityLoadFailure from './ActivityLoadFailure'
import { Loading, Saved } from './LoadState'

const PAGE_SIZE = 10

/**
 * ActivityTimeline — the "Activity" card of a company, contact or deal page
 * (AC-1.7, AC-4.5): the activities that concern `target`, newest first,
 * paginated, with "Log activity" in the card's action. Logging, editing,
 * completing or deleting reloads the current page so the order stays the
 * server's, behind the rows already shown (no skeleton: a row that is still
 * listed is never unmounted); each confirms with a compact success banner (INC-19).
 */
export default function ActivityTimeline({
  target,
  company,
  preset,
}: {
  target: ActivityTarget
  /** The company the composer logs at; null when the contact has no company (nothing to log at). */
  company: CompanyRef | null
  preset?: { contactId?: string; dealId?: string }
}) {
  const t = strings.activities
  const [page, setPage] = useState(1)
  const [composing, setComposing] = useState<{ activity?: Activity } | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const key = JSON.stringify(target)
  const load = useCallback(
    (signal: AbortSignal) =>
      listActivities(JSON.parse(key) as ActivityTarget, { page, pageSize: PAGE_SIZE }, { signal }),
    [key, page],
  )
  // A write in the card re-reads the list behind the rows on screen (`cacheKey`, as the Tasks page does): a row the
  // re-read still lists keeps its element, so the success message of hours-ui's Record hours, which lives in the row,
  // stays until the person dismisses it, saves again or leaves (specs/20261116-record-hours-in-place, design S3, G1).
  const activities = useResource(load, { cacheKey: `crm-activities:${JSON.stringify([key, page])}` })

  const changed = (message: string) => {
    setSaved(message)
    activities.retry()
  }

  let content
  if (activities.status === 'loading') content = <Loading label={t.loading} rows={2} />
  else if (activities.status === 'error')
    content = <ActivityLoadFailure error={activities.error} onRetry={activities.retry} />
  else if (activities.data!.total === 0)
    content = (
      <StatePanel headingLevel={4} title={t.emptyTitle}>
        {t.emptyBody}
      </StatePanel>
    )
  else
    content = (
      <div className="flex flex-col gap-3">
        <ListRows label={t.listLabel} testId="crm-activity-list">
          {activities.data!.items.map((activity) => (
            <ActivityItem
              key={activity.id}
              activity={activity}
              onChanged={() => changed(t.saved)}
              onEdit={(edited) => setComposing({ activity: edited })}
              onDeleted={() => changed(t.deleted)}
            />
          ))}
        </ListRows>
        {activities.data!.total > PAGE_SIZE && (
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={activities.data!.total}
            onPageChange={setPage}
            label={strings.common.pagination.label}
            previousLabel={strings.common.pagination.previous}
            nextLabel={strings.common.pagination.next}
            status={strings.common.pagination.status}
            testId="crm-activity-pagination"
          />
        )}
      </div>
    )

  return (
    <Card
      title={t.heading}
      action={
        company && (
          <Button size="sm" onClick={() => setComposing({})} aria-haspopup="dialog" data-testid="crm-activity-log">
            {t.log}
          </Button>
        )
      }
      data-testid="crm-activity-card"
    >
      <div className="flex flex-col gap-3">
        {saved && <Saved message={saved} onDismiss={() => setSaved(null)} />}
        {content}
      </div>
      {composing && company && (
        <ActivityFormDialog
          company={company}
          activity={composing.activity}
          preset={preset}
          onCancel={() => setComposing(null)}
          onSaved={(_saved, warning) => {
            const wasEdit = composing.activity !== undefined
            setComposing(null)
            if (!wasEdit) setPage(1)
            changed(warning ?? (wasEdit ? t.saved : t.logged))
          }}
        />
      )}
    </Card>
  )
}
