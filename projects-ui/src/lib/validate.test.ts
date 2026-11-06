import { describe, expect, it } from 'vitest'
import { first, hasErrors, maxLength, optional, required } from './validate'

describe('validate', () => {
  it('required refuses blank and whitespace, accepts text', () => {
    expect(required('')).toBe('This field is required.')
    expect(required('   ')).toBe('This field is required.')
    expect(required('Koordy')).toBeNull()
  })

  it('maxLength counts the trimmed text (the server trims too)', () => {
    expect(maxLength(`  ${'a'.repeat(200)}  `, 200)).toBeNull()
    expect(maxLength('a'.repeat(201), 200)).toBe('Use at most 200 characters.')
  })

  it('first returns the first failing message', () => {
    expect(first(null, 'second', 'third')).toBe('second')
    expect(first(null, null)).toBeNull()
  })

  it('optional trims and turns empty into null', () => {
    expect(optional('  x ')).toBe('x')
    expect(optional('  ')).toBeNull()
  })

  it('hasErrors is true when any field has a message', () => {
    expect(hasErrors({ name: undefined, type: 'x' })).toBe(true)
    expect(hasErrors({ name: undefined })).toBe(false)
  })
})
