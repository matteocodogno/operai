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
      personId: '',
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
      personId: '',
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

describe('parseFilterSearch for Everyone’s hours (T29: Person, and Person as the default Group by)', () => {
  it('an empty URL is the defaults, grouped by person and with no one chosen', () => {
    expect(parseFilterSearch({}, 'everyone')).toEqual({
      ...DEFAULT_FILTERS,
      personId: '',
      group: 'person',
    })
  })

  it('reads the person, and Group by person among the others', () => {
    expect(parseFilterSearch({ person: 'u-ada', group: 'deal' }, 'everyone')).toMatchObject({
      personId: 'u-ada',
      group: 'deal',
    })
    expect(parseFilterSearch({ group: 'person' }, 'everyone').group).toBe('person')
  })

  it('My hours knows no Person: a person in its URL is nobody, and Group by person is the default there', () => {
    expect(parseFilterSearch({ person: 'u-ada', group: 'person' })).toMatchObject({ personId: '', group: 'project' })
    expect(parseFilterSearch({ person: 'u-ada' }, 'mine').personId).toBe('')
  })

  it('an id the router parsed as a number is the same id as text', () => {
    expect(parseFilterSearch({ person: 1234 }, 'everyone').personId).toBe('1234')
  })

  it('an id outside the id rule is nobody: it never reaches the API (empty, 65 characters, a comma, a NUL, a space at either end)', () => {
    for (const bad of ['a'.repeat(65), 'a,b', 'a\u0000b', ' u-ada', 'u-ada ', '   ']) {
      expect(parseFilterSearch({ person: bad }, 'everyone').personId).toBe('')
    }
    expect(parseFilterSearch({ person: 'a'.repeat(64) }, 'everyone').personId).toBe('a'.repeat(64))
    expect(parseFilterSearch({ person: 'two words' }, 'everyone').personId).toBe('two words')
  })

  it('an unknown group is the view’s default', () => {
    expect(parseFilterSearch({ group: 'day' }, 'everyone').group).toBe('person')
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

  it('writes the person, and leaves "everyone" (no one chosen) out of the URL', () => {
    expect(applyFilterPatch({ period: 'lastWeek' }, { personId: 'u-ada' }, 'everyone')).toEqual({
      period: 'lastWeek',
      person: 'u-ada',
    })
    expect(applyFilterPatch({ person: 'u-ada' }, { personId: '' }, 'everyone')).toEqual({})
  })

  it('the default Group by is the view’s own: person on Everyone’s hours, project on My hours', () => {
    expect(applyFilterPatch({ group: 'deal' }, { group: 'person' }, 'everyone')).toEqual({})
    expect(applyFilterPatch({}, { group: 'project' }, 'everyone')).toEqual({ group: 'project' })
    expect(applyFilterPatch({}, { group: 'person' })).toEqual({ group: 'person' })
    expect(applyFilterPatch({ group: 'deal' }, { group: 'project' }, 'mine')).toEqual({})
  })

  it('a date emptied in Custom is kept as empty, so the range reads as incomplete and nothing is sent', () => {
    expect(
      parseFilterSearch(applyFilterPatch({ period: 'custom', from: '2026-11-01', to: '2026-11-30' }, { from: '' })),
    ).toMatchObject({ period: 'custom', from: '', to: '2026-11-30' })
  })
})

describe('clearFilterSearch (Clear filters)', () => {
  it('drops period, dates, person, category and work type, and keeps Group by (a view choice, not a filter) and other keys', () => {
    expect(
      clearFilterSearch({
        period: 'custom',
        from: '2026-10-05',
        to: '2026-10-09',
        category: 'tc-1',
        workType: 'wt-1',
        group: 'deal',
        person: 'u-1',
        elsewhere: 'kept',
      }),
    ).toEqual({ group: 'deal', elsewhere: 'kept' })
  })
})

describe('isFiltered (when "Clear filters" is offered)', () => {
  const none = { project: null, deal: null }

  it('is false for the defaults, whatever Group by is', () => {
    expect(isFiltered(DEFAULT_FILTERS, none)).toBe(false)
    expect(isFiltered({ ...DEFAULT_FILTERS, group: 'month' }, none)).toBe(false)
  })

  it('is true when the person differs (Everyone’s hours)', () => {
    expect(isFiltered({ ...DEFAULT_FILTERS, personId: 'u-ada' }, none)).toBe(true)
  })

  it('is true when the period, the category, the work type, the project or the deal differ', () => {
    expect(isFiltered({ ...DEFAULT_FILTERS, period: 'lastMonth' }, none)).toBe(true)
    expect(isFiltered({ ...DEFAULT_FILTERS, categoryId: 'tc-1' }, none)).toBe(true)
    expect(isFiltered({ ...DEFAULT_FILTERS, workTypeId: 'wt-1' }, none)).toBe(true)
    expect(isFiltered(DEFAULT_FILTERS, { project: { id: 'p1' }, deal: null })).toBe(true)
    expect(isFiltered(DEFAULT_FILTERS, { project: null, deal: { id: 'd1' } })).toBe(true)
  })
})
