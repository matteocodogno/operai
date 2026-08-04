/**
 * Unit tests for src/lib/addressCoordinates.ts — the AC-2.6 coordinate-
 * staleness truth table (T8, specs/012-employee-address/tasks.md).
 */

import { describe, expect, it } from 'vitest'
import { coordinatesForSave } from './addressCoordinates'
import type { AddressComponents } from './googlePlaces'

const base: AddressComponents = {
  countryCode: 'CH',
  city: 'Zürich',
  street: 'Bahnhofstrasse',
  houseNumber: '12b',
  postalCode: '8001',
  region: 'Zürich',
}

const coords = { lat: 47.3702, lng: 8.5397 }

describe('coordinatesForSave', () => {
  it('retains coordinates when current is byte-identical to the snapshot', () => {
    expect(coordinatesForSave(base, { ...base }, coords)).toEqual({ latitude: 47.3702, longitude: 8.5397 })
  })

  it.each(Object.keys(base) as (keyof AddressComponents)[])(
    'discards coordinates when %s alone differs from the snapshot',
    (key) => {
      const edited: AddressComponents = { ...base, [key]: `${base[key]}-edited` }
      expect(coordinatesForSave(edited, base, coords)).toEqual({ latitude: null, longitude: null })
    },
  )

  it('discards coordinates when snapshot is null (AC-3.4 — never selected a suggestion)', () => {
    expect(coordinatesForSave(base, null, coords)).toEqual({ latitude: null, longitude: null })
  })

  it('discards coordinates when coords itself is null, even with a matching snapshot', () => {
    expect(coordinatesForSave(base, { ...base }, null)).toEqual({ latitude: null, longitude: null })
  })

  it('discards coordinates when both snapshot and coords are null', () => {
    expect(coordinatesForSave(base, null, null)).toEqual({ latitude: null, longitude: null })
  })

  it('is order-insensitive — comparing plain equal objects regardless of key order', () => {
    const reordered: AddressComponents = {
      region: base.region,
      postalCode: base.postalCode,
      houseNumber: base.houseNumber,
      street: base.street,
      city: base.city,
      countryCode: base.countryCode,
    }
    expect(coordinatesForSave(reordered, base, coords)).toEqual({ latitude: 47.3702, longitude: 8.5397 })
  })
})
