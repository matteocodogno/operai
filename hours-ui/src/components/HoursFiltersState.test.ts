/**
 * The filters as URL search params (specs/029-time-tracking T24; design § Frame of `hours-ui`: "Filters
 * live in URL search params (`period`, `from`, `to`, `person`, `category`, `workType`, `group`)"). A
 * default is left out of the URL, anything unknown or malformed falls back to the default so garbage in a
 * pasted link never reaches the API, and writing one filter keeps every other key of the URL.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILTERS,
  applyFilterPatch,
  clearFilterSearch,
  isFiltered,
  parseFilterSearch,
} from './HoursFiltersState'

describe('parseFilterSearch', () => {
  it('an empty URL is the defaults: This month, no category or work type, grouped by project', () => {
    expect(parseFilterSearch({})).toEqual({
      period: 'thisMonth',
      from: '',
      to: '',
      categoryId: '',
      workTypeId: '',
      group: 'project',
    })
    expect(DEFAULT_FILTERS).toEqual(parseFilterSearch({}))
  })

  it('reads every filter', () => {
    expect(
      parseFilterSearch({
        period: 'custom',
        from: '2026-10-05',
        to: '2026-10-09',
        category: 'tc-1',
        workType: 'wt-1',
        group: 'month',
      }),
    ).toEqual({
      period: 'custom',
      from: '2026-10-05',
      to: '2026-10-09',
      categoryId: 'tc-1',
      workTypeId: 'wt-1',
      group: 'month',
    })
  })

  it('an unknown period or group is the default, not an error', () => {
    expect(parseFilterSearch({ period: 'forever', group: 'person' })).toMatchObject({
      period: 'thisMonth',
      group: 'project',
    })
    expect(parseFilterSearch({ group: 'day' }).group).toBe('project')
  })

  it('an id the router parsed as a number is the same id as text (TanStack reads ?workType=123 as 123)', () => {
    expect(parseFilterSearch({ category: 123, workType: 4 })).toMatchObject({ categoryId: '123', workTypeId: '4' })
  })

  it('anything that is not text or a number is nothing', () => {
    expect(parseFilterSearch({ category: { a: 1 }, from: ['2026-01-01'], to: true, workType: null })).toMatchObject({
      categoryId: '',
      from: '',
      to: '',
      workTypeId: '',
    })
  })
})

describe('applyFilterPatch: what the URL becomes when one filter changes', () => {
  it('sets the filter and keeps every other key, including one it does not know', () => {
    expect(applyFilterPatch({ group: 'month', person: 'u-1' }, { categoryId: 'tc-1' })).toEqual({
      group: 'month',
      person: 'u-1',
      category: 'tc-1',
    })
  })

  it('leaves a default out of the URL: This month, no category, no work type, grouped by project', () => {
    expect(applyFilterPatch({ period: 'lastWeek' }, { period: 'thisMonth' })).toEqual({})
    expect(applyFilterPatch({ category: 'tc-1', workType: 'wt-1' }, { categoryId: '', workTypeId: '' })).toEqual({})
    expect(applyFilterPatch({ group: 'deal' }, { group: 'project' })).toEqual({})
  })

  it('a preset carries no dates: leaving Custom drops from and to', () => {
    expect(
      applyFilterPatch({ period: 'custom', from: '2026-10-05', to: '2026-10-09' }, { period: 'lastMonth' }),
    ).toEqual({ period: 'lastMonth' })
    expect(
      applyFilterPatch({ period: 'custom', from: '2026-10-05', to: '2026-10-09' }, { period: 'thisMonth' }),
    ).toEqual({})
  })

  it('Custom keeps the dates it is given', () => {
    expect(applyFilterPatch({}, { period: 'custom', from: '2026-11-01', to: '2026-11-30' })).toEqual({
      period: 'custom',
      from: '2026-11-01',
      to: '2026-11-30',
    })
    expect(applyFilterPatch({ period: 'custom', from: '2026-11-01', to: '2026-11-30' }, { to: '2026-11-15' })).toEqual({
      period: 'custom',
      from: '2026-11-01',
      to: '2026-11-15',
    })
  })

  it('a date emptied in Custom is kept as empty, so the range reads as incomplete and nothing is sent', () => {
    expect(
      parseFilterSearch(applyFilterPatch({ period: 'custom', from: '2026-11-01', to: '2026-11-30' }, { from: '' })),
    ).toMatchObject({ period: 'custom', from: '', to: '2026-11-30' })
  })
})

describe('clearFilterSearch (Clear filters)', () => {
  it('drops period, dates, category and work type, and keeps Group by (a view choice, not a filter) and other keys', () => {
    expect(
      clearFilterSearch({
        period: 'custom',
        from: '2026-10-05',
        to: '2026-10-09',
        category: 'tc-1',
        workType: 'wt-1',
        group: 'deal',
        person: 'u-1',
      }),
    ).toEqual({ group: 'deal', person: 'u-1' })
  })
})

describe('isFiltered (when "Clear filters" is offered)', () => {
  const none = { project: null, deal: null }

  it('is false for the defaults, whatever Group by is', () => {
    expect(isFiltered(DEFAULT_FILTERS, none)).toBe(false)
    expect(isFiltered({ ...DEFAULT_FILTERS, group: 'month' }, none)).toBe(false)
  })

  it('is true when the period, the category, the work type, the project or the deal differ', () => {
    expect(isFiltered({ ...DEFAULT_FILTERS, period: 'lastMonth' }, none)).toBe(true)
    expect(isFiltered({ ...DEFAULT_FILTERS, categoryId: 'tc-1' }, none)).toBe(true)
    expect(isFiltered({ ...DEFAULT_FILTERS, workTypeId: 'wt-1' }, none)).toBe(true)
    expect(isFiltered(DEFAULT_FILTERS, { project: { id: 'p1' }, deal: null })).toBe(true)
    expect(isFiltered(DEFAULT_FILTERS, { project: null, deal: { id: 'd1' } })).toBe(true)
  })
})
