/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emulateFocusFixup } from './focusFixup'

// The emulation is only worth trusting if it can be seen to do what a browser does, and nothing more.
let stop: () => void
beforeEach(() => {
  document.body.innerHTML =
    '<form><fieldset id="fields"><input id="field" /></fieldset><button id="save" type="submit">Save</button><button id="other">Other</button></form>'
  stop = emulateFocusFixup()
})
afterEach(() => {
  stop()
  document.body.innerHTML = ''
})

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
// Longer than the task the fixup waits for.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

describe('emulateFocusFixup', () => {
  it('takes focus off a button that becomes disabled, and leaves it on the body', async () => {
    el('save').focus()
    el<HTMLButtonElement>('save').disabled = true
    await settle()
    expect(document.activeElement).toBe(document.body)
  })

  it('takes focus off a field whose fieldset becomes disabled', async () => {
    el('field').focus()
    el<HTMLFieldSetElement>('fields').disabled = true
    await settle()
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus alone when another control is the one disabled', async () => {
    el('save').focus()
    el<HTMLButtonElement>('other').disabled = true
    await settle()
    expect(document.activeElement).toBe(el('save'))
  })

  it('does not take away focus that was given once the control was enabled again', async () => {
    el('save').focus()
    el<HTMLButtonElement>('save').disabled = true
    await settle()
    el<HTMLButtonElement>('save').disabled = false
    el('save').focus()
    await settle()
    expect(document.activeElement).toBe(el('save'))
  })

  it('leaves focus alone on a control that was enabled again before the page was rendered', async () => {
    el('save').focus()
    el<HTMLButtonElement>('save').disabled = true
    el<HTMLButtonElement>('save').disabled = false
    await settle()
    expect(document.activeElement).toBe(el('save'))
  })

  it('stops when it is undone', async () => {
    stop()
    el('save').focus()
    el<HTMLButtonElement>('save').disabled = true
    await settle()
    expect(document.activeElement).toBe(el('save'))
  })
})
