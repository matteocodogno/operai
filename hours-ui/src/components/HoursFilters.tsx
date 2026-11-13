import { useState } from 'react'
import { Button, Card, DateInput, Field, SearchPicker } from '@operai/ui'
import type { ComboboxOption } from '@operai/ui'
import type { TimeListsView } from '../lib/hoursApi.types'
import { PERIODS } from '../lib/period'
import type { RangeErrors } from '../lib/period'
import { searchDeals, searchProjects } from '../lib/searchers'
import type { DealChoice, ProjectChoice } from '../lib/searchers'
import { strings } from '../strings'
import ErrorBanner from './ErrorBanner'
import type { FilterPatch, HoursFilterState } from './HoursFiltersState'

/** The categories and work types the selects offer, from one `GET /time-lists?includeRetired=true`. */
export type ListsView = { status: 'loading' } | { status: 'error' } | { status: 'loaded'; lists: TimeListsView }

export type HoursFiltersProps = {
  /** The period and the two lists' choices as they are APPLIED: a choice the lists do not hold is not shown as one. */
  state: HoursFilterState
  /** What is wrong with a Custom range, by field. */
  rangeErrors: RangeErrors
  /** The picked project and deal, held in memory by the page (the URL carries no label). */
  project: ProjectChoice | null
  deal: DealChoice | null
  lists: ListsView
  /** Whether anything differs from the defaults: only then is "Clear filters" offered. */
  filtered: boolean
  /** A new value gives the pickers a new `key`, which empties text typed and never picked (Clear filters). */
  pickerKey: number
  onChange: (patch: FilterPatch) => void
  onProjectChange: (project: ProjectChoice | null) => void
  onDealChange: (deal: DealChoice | null) => void
  onClear: () => void
  onRetryLists: () => void
}

const projectOption = (project: ProjectChoice): ComboboxOption => ({
  id: project.id,
  label: project.name,
  secondaryLabel: project.companyName ?? undefined,
})
const dealOption = (deal: DealChoice): ComboboxOption => ({
  id: deal.id,
  label: deal.title,
  secondaryLabel: deal.companyName ?? undefined,
})

/**
 * HoursFilters — the Filters card of My hours (specs/029-time-tracking T24; AC-4.4; design S1 "Filters"):
 * Period (with From and To under Custom range), Project and Deal (server-side searches, as the person),
 * Category and Work type (both from one read of the lists). Controlled and presentational: it renders the
 * state it is given and reports every change as a patch — it never fetches the lists or the hours, and the
 * page owns the URL.
 *
 * Category lists every category including retired ones ("(retired)"), and Work type is ONE select with the
 * projects list and the deals list as two groups, because the lists repeat names but not ids. Names are
 * shown exactly as typed (AC-3.8). While the lists load, or when they fail, the two selects are
 * `aria-disabled` (reachable, doing nothing) and a failure says so inside the card with Retry; the period,
 * the project and the deal keep working.
 *
 * A date left empty is reported as "required" only after the person leaves the field, so typing a date
 * never flashes an error; "To before From" and "over 366 days" show at once.
 */
export default function HoursFilters({
  state,
  rangeErrors,
  project,
  deal,
  lists,
  filtered,
  pickerKey,
  onChange,
  onProjectChange,
  onDealChange,
  onClear,
  onRetryLists,
}: HoursFiltersProps) {
  const t = strings.filters
  const [touched, setTouched] = useState({ from: false, to: false })
  const listsReady = lists.status === 'loaded'

  const fromError = rangeErrors.from === 'required' && touched.from ? t.rangeErrors.fromRequired : undefined
  const toError =
    rangeErrors.to === 'required'
      ? touched.to
        ? t.rangeErrors.toRequired
        : undefined
      : rangeErrors.to === 'before-from'
        ? t.rangeErrors.toBeforeFrom
        : rangeErrors.to === 'too-long'
          ? t.rangeErrors.tooLong
          : undefined

  /** What the first option of a list select says: the wait, or "all". */
  const anyLabel = (any: string) => (lists.status === 'loading' ? t.listsLoading : any)

  return (
    <Card
      title={t.title}
      data-testid="hours-filters"
      action={
        filtered ? (
          <Button variant="ghost" size="sm" onClick={onClear} data-testid="hours-filters-clear">
            {t.clear}
          </Button>
        ) : undefined
      }
    >
      <form role="search" aria-label={t.landmarkLabel} onSubmit={(event) => event.preventDefault()}>
        {lists.status === 'error' && (
          <ErrorBanner
            title={t.listsError.title}
            message={t.listsError.body}
            onRetry={onRetryLists}
            testId="hours-filters-lists-error"
          />
        )}
        <div className="grid items-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <Field label={t.period.label}>
            {(control) => (
              <select
                {...control}
                value={state.period}
                onChange={(event) => {
                  const period = PERIODS.find((candidate) => candidate === event.target.value)
                  if (period !== undefined) onChange({ period })
                }}
                data-testid="hours-filter-period"
              >
                {PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {t.period.options[period]}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {state.period === 'custom' && (
            <>
              <Field label={t.from} error={fromError} errorRole="alert">
                {(control) => (
                  <DateInput
                    {...control}
                    value={state.from}
                    onChange={(event) => onChange({ from: event.target.value })}
                    onBlur={() => setTouched((current) => ({ ...current, from: true }))}
                    data-testid="hours-filter-from"
                  />
                )}
              </Field>
              <Field label={t.to} error={toError} errorRole="alert">
                {(control) => (
                  <DateInput
                    {...control}
                    value={state.to}
                    onChange={(event) => onChange({ to: event.target.value })}
                    onBlur={() => setTouched((current) => ({ ...current, to: true }))}
                    data-testid="hours-filter-to"
                  />
                )}
              </Field>
            </>
          )}

          <SearchPicker<ProjectChoice>
            key={`project-${pickerKey}`}
            label={t.project.label}
            value={project}
            onChange={onProjectChange}
            search={searchProjects}
            toOption={projectOption}
            messages={t.project.messages}
            testId="hours-filter-project"
          />

          <SearchPicker<DealChoice>
            key={`deal-${pickerKey}`}
            label={t.deal.label}
            value={deal}
            onChange={onDealChange}
            search={searchDeals}
            toOption={dealOption}
            messages={t.deal.messages}
            testId="hours-filter-deal"
          />

          <Field label={t.category.label}>
            {(control) => (
              <select
                {...control}
                value={listsReady ? state.categoryId : ''}
                aria-disabled={listsReady ? undefined : true}
                onChange={(event) => {
                  if (listsReady) onChange({ categoryId: event.target.value })
                }}
                data-testid="hours-filter-category"
              >
                <option value="">{anyLabel(t.category.any)}</option>
                {listsReady &&
                  lists.lists.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.retired ? t.category.retired(category.name) : category.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>

          <Field label={t.workType.label}>
            {(control) => (
              <select
                {...control}
                value={listsReady ? state.workTypeId : ''}
                aria-disabled={listsReady ? undefined : true}
                onChange={(event) => {
                  if (listsReady) onChange({ workTypeId: event.target.value })
                }}
                data-testid="hours-filter-work-type"
              >
                <option value="">{anyLabel(t.workType.any)}</option>
                {listsReady && lists.lists.workTypes.project.length > 0 && (
                  <optgroup label={t.workType.projectGroup}>
                    {lists.lists.workTypes.project.map((workType) => (
                      <option key={workType.id} value={workType.id}>
                        {workType.retired ? t.workType.retired(workType.name) : workType.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {listsReady && lists.lists.workTypes.deal.length > 0 && (
                  <optgroup label={t.workType.dealGroup}>
                    {lists.lists.workTypes.deal.map((workType) => (
                      <option key={workType.id} value={workType.id}>
                        {workType.retired ? t.workType.retired(workType.name) : workType.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
          </Field>
        </div>
      </form>
    </Card>
  )
}
