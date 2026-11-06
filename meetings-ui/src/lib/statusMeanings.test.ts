import { STATUS } from '@operai/ui'
import { describe, expect, it } from 'vitest'
import { en, it as italian } from '../strings'
import { MEETING_STATUS_MEANING, SUMMARY_STATUS_MEANING } from './statusMeanings'

describe('status meanings (design.md Conventions › Statuses)', () => {
  it('maps every derived meeting status to the suite dictionary, as the design fixes it', () => {
    expect(MEETING_STATUS_MEANING).toEqual({
      draft: 'draft',
      recording: 'pending',
      interrupted: 'attention',
      processing: 'pending',
      ready: 'settled',
      failed: 'failed',
    })
  })

  it('maps every summary status the same way', () => {
    expect(SUMMARY_STATUS_MEANING).toEqual({ generating: 'pending', ready: 'settled', failed: 'failed' })
  })

  it('only uses meanings the library knows (a typo would render no badge style)', () => {
    for (const meaning of [...Object.values(MEETING_STATUS_MEANING), ...Object.values(SUMMARY_STATUS_MEANING)]) {
      expect(Object.keys(STATUS)).toContain(meaning)
    }
  })

  it('has a label for each status in both languages, and no label without a status', () => {
    for (const catalog of [en, italian]) {
      expect(Object.keys(catalog.common.status.meeting).sort()).toEqual(Object.keys(MEETING_STATUS_MEANING).sort())
      expect(Object.keys(catalog.common.status.summary).sort()).toEqual(Object.keys(SUMMARY_STATUS_MEANING).sort())
    }
  })
})
