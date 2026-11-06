import { describe, expect, it } from 'vitest'
import { mailtoHref, telHref } from './links'

/**
 * A contact's email and phone are third-party data read from the CRM (T18 M5, L9): they are only ever the
 * rest of a URL whose scheme is fixed here, never an `href` themselves, so a value such as `javascript:...`
 * cannot become a script link, and a recipient cannot be added to a `mailto:` through `?`, `&` or `,`.
 */
describe('mailtoHref', () => {
  it('builds a mailto: link with the address readable', () => {
    expect(mailtoHref('jane.roe@acme.example')).toBe('mailto:jane.roe@acme.example')
  })

  it('never lets the value choose the scheme', () => {
    expect(mailtoHref('javascript:alert(1)')).toMatch(/^mailto:/)
    expect(mailtoHref('javascript:alert(1)')).not.toMatch(/^mailto:javascript:/)
  })

  it.each(['a@b.example?bcc=x@evil.example', 'a@b.example&subject=hi', 'a@b.example,x@evil.example', 'a@b.example#x'])(
    'encodes what would add a recipient, a header or a fragment: %s',
    (value) => {
      expect(mailtoHref(value)).not.toMatch(/[?&,#]/)
    },
  )

  it('has no link for a blank value', () => {
    expect(mailtoHref('  ')).toBeNull()
  })
})

describe('telHref', () => {
  it('builds a tel: link from the digits and a leading plus', () => {
    expect(telHref('+41 44 123 45 67')).toBe('tel:+41441234567')
    expect(telHref('(044) 123-45-67')).toBe('tel:0441234567')
  })

  it('never lets the value choose the scheme or carry anything but a number', () => {
    expect(telHref('javascript:alert(1)') ?? 'tel:').toMatch(/^tel:[0-9+]*$/)
    expect(telHref('+41 44 123;phone-context=evil')).toBe('tel:+4144123')
  })

  it('has no link for a value without digits', () => {
    expect(telHref('n/a')).toBeNull()
  })
})
