/**
 * Test-only reader of the accounting export's XLSX workbook (specs/20261119-accounting, T73; 20261118 SO-6 to SO-12, AC-6.2,
 * AC-6.13 to AC-6.17). It replaces `parseAccountingCsv`: the download of `…/accounting-export/file` is an `.xlsx`, not a CSV.
 *
 * It follows the logic of refund-api's own test reader (`refund-api/src/test-support/xlsxReader.ts`: the ZIP central directory,
 * the package relationships, shared strings, the cell styles), written again here because the e2e project is a separate
 * package and may not import another package's sources. Node only (`node:zlib`), no dependency of any kind.
 *
 * One deliberate difference. refund-api's reader is strict about what its OWN writer produces (STORE entries only) because it
 * checks that writer; this one reads what a person's spreadsheet might make of the file as well, so a file that was opened and
 * saved again (DEFLATE entries, data descriptors, a ZIP comment, a different part order, cells without a `<v>`) still reads:
 *   - `readZip` finds the end record by scanning back, reads sizes from the CENTRAL DIRECTORY (the only place a data descriptor
 *     leaves them), STOREs as they are and DEFLATEs with `inflateRawSync`; every entry's size and CRC-32 are checked, so a file
 *     the browser saved cut short or altered fails here and not as a wrong cell;
 *   - `parseXml` is a small parser of the subset a worksheet uses; it refuses a DOCTYPE (no entity is ever defined by the file)
 *     and decodes only the five predefined entities and numeric references;
 *   - `readWorkbook` goes from the package root through the relationships to the sheet, never assuming a part's name, and
 *     places each cell by its own reference (`C7`), so an omitted empty cell does not shift the others.
 */

import { inflateRawSync } from 'node:zlib'

// ─── ZIP ─────────────────────────────────────────────────────────────────────

export interface ZipEntry {
  readonly name: string
  /** The entry's content, inflated when it was DEFLATEd. */
  readonly data: Uint8Array
}

let crcTable: Uint32Array | undefined

/** Bitwise-table CRC-32 (IEEE 802.3, as ZIP uses). */
export function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const SIG_END = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

export function readZip(bytes: Uint8Array): ZipEntry[] {
  const fail = (message: string): never => {
    throw new Error(`invalid ZIP: ${message}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 22) fail('shorter than an end record')

  // The end record is the last 22 bytes unless the archive carries a comment: scan back over at most the longest comment.
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === SIG_END && at + 22 + view.getUint16(at + 20, true) === bytes.length) {
      end = at
      break
    }
  }
  if (end < 0) fail('no end-of-central-directory record')
  const count = view.getUint16(end + 8, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryStart = view.getUint32(end + 16, true)
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) fail('a ZIP64 archive')
  if (directoryStart + directorySize > end) fail('the central directory runs past the end record')

  const entries: ZipEntry[] = []
  let at = directoryStart
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== SIG_CENTRAL) fail(`central header ${i} has a wrong signature`)
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const compressedSize = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localOffset = view.getUint32(at + 42, true)
    if ((flags & 0x0001) !== 0) fail(`entry ${i} is encrypted`)
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) fail(`entry ${i} needs ZIP64`)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at + 46, at + 46 + nameLength))

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) fail(`local header of ${name} has a wrong signature`)
    // The local header's own name and extra lengths place the data (they may differ from the directory's extra field).
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    const stored = bytes.subarray(dataStart, dataStart + compressedSize)
    if (stored.length !== compressedSize) fail(`entry ${name} is cut short`)
    let data: Uint8Array
    if (method === 0) data = stored
    else if (method === 8) data = inflateRawSync(stored)
    else return fail(`entry ${name} uses compression method ${method}`)
    if (data.length !== size) fail(`entry ${name}: size ${data.length}, the directory says ${size}`)
    if (crc32(data) !== crc) fail(`entry ${name}: CRC-32 mismatch`)
    if (!name.endsWith('/')) entries.push({ name, data })
    at += 46 + nameLength + extraLength + commentLength
  }
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) fail('duplicate entry names')
  return entries
}

// ─── XML ─────────────────────────────────────────────────────────────────────

export interface XmlElement {
  /** The local name: a namespace prefix (`x:row`) is dropped. */
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: readonly XmlElement[]
  /** The character data directly inside the element, in order, entities decoded. */
  readonly text: string
}

function decodeEntities(raw: string): string {
  return raw.replace(/&([^;&<\s]*);/g, (whole, body: string) => {
    switch (body) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
    }
    const numeric = /^#(?:x([0-9A-Fa-f]+)|([0-9]+))$/.exec(body)
    if (!numeric) throw new Error(`invalid XML: unknown reference ${whole}`)
    const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : parseInt(numeric[2]!, 10)
    if (!(code <= 0x10ffff)) throw new Error(`invalid XML: reference ${whole} is out of range`)
    return String.fromCodePoint(code)
  })
}

const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

export function parseXml(source: string): XmlElement {
  interface Open {
    name: string
    attributes: Record<string, string>
    children: XmlElement[]
    text: string
  }
  const stack: Open[] = []
  let root: XmlElement | undefined
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const fail = (message: string): never => {
    throw new Error(`invalid XML at ${i}: ${message}`)
  }
  const close = (open: Open): void => {
    const element: XmlElement = { name: open.name, attributes: open.attributes, children: open.children, text: open.text }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(element)
    else if (root === undefined) root = element
    else fail('more than one root element')
  }

  while (i < source.length) {
    if (source[i] !== '<') {
      const next = source.indexOf('<', i)
      const chunk = source.slice(i, next === -1 ? source.length : next)
      const parent = stack[stack.length - 1]
      if (parent) parent.text += decodeEntities(chunk)
      else if (chunk.trim() !== '') fail('text outside the root element')
      i += chunk.length
      continue
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i)
      if (end === -1) fail('an unterminated declaration')
      i = end + 2
    } else if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i)
      if (end === -1) fail('an unterminated comment')
      i = end + 3
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i)
      const parent = stack[stack.length - 1]
      if (end === -1 || !parent) fail('a misplaced CDATA section')
      parent!.text += source.slice(i + 9, end)
      i = end + 3
    } else if (source.startsWith('<!', i)) {
      fail('a DOCTYPE or other declaration')
    } else if (source[i + 1] === '/') {
      const end = source.indexOf('>', i)
      if (end === -1) fail('an unterminated end tag')
      const name = localName(source.slice(i + 2, end).trim())
      const open = stack.pop()
      if (!open || open.name !== name) fail(`end tag </${name}> does not match`)
      close(open!)
      i = end + 1
    } else {
      const match = /^<([^\s/>=]+)((?:\s+[^\s/>=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(source.slice(i, source.indexOf('>', i) + 1))
      if (!match) fail('a malformed start tag')
      const [whole, name, rawAttributes, selfClosing] = match!
      const attributes: Record<string, string> = {}
      for (const attribute of rawAttributes!.matchAll(/\s+([^\s/>=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attributes[attribute[1]!] = decodeEntities(attribute[2] ?? attribute[3] ?? '')
      }
      const open: Open = { name: localName(name!), attributes, children: [], text: '' }
      i += whole!.length
      if (selfClosing === '/') close(open)
      else stack.push(open)
    }
  }
  if (stack.length > 0) fail(`unclosed element <${stack[stack.length - 1]!.name}>`)
  if (root === undefined) fail('no root element')
  return root!
}

const childrenNamed = (element: XmlElement, name: string): XmlElement[] => element.children.filter((child) => child.name === name)
const firstChild = (element: XmlElement, name: string): XmlElement | undefined => element.children.find((child) => child.name === name)
const only = (element: XmlElement, name: string): XmlElement => {
  const found = childrenNamed(element, name)
  if (found.length !== 1) throw new Error(`expected exactly one <${name}> in <${element.name}>, found ${found.length}`)
  return found[0]!
}
/** The attribute of that local name whatever its prefix (`r:id`, or another prefix a spreadsheet chose). */
const attribute = (element: XmlElement, name: string): string | undefined => {
  const key = Object.keys(element.attributes).find((candidate) => localName(candidate) === name)
  return key === undefined ? undefined : element.attributes[key]
}

// ─── The workbook ────────────────────────────────────────────────────────────

export interface CellStyle {
  /** The number format code: a custom one, or the well-known built-in's (`General`, `0.00`, `@`), else `null`. */
  readonly formatCode: string | null
  readonly quotePrefix: boolean
}

export type Cell =
  | { readonly type: 'text'; readonly ref: string; readonly value: string; readonly style: CellStyle }
  /** `value` is the cell's own text, as stored: `9.62`, `5832`, `46083`. Never a float of ours. */
  | { readonly type: 'number'; readonly ref: string; readonly value: string; readonly style: CellStyle }
  | { readonly type: 'empty'; readonly ref: string; readonly style: CellStyle }

export interface Workbook {
  readonly entryNames: readonly string[]
  readonly sheetNames: readonly string[]
  /** Rows of the FIRST sheet, row 1 first; each row is its cells from column A to its last one (gaps are `empty`). */
  readonly rows: readonly (readonly Cell[])[]
  /** The references of every cell that holds a formula: an export never has one (AC-6.15). */
  readonly formulaCells: readonly string[]
  /** Every XML part as text, for a test that scans the raw markup. */
  readonly parts: Readonly<Record<string, string>>
}

const BUILT_IN_FORMATS: Readonly<Record<number, string>> = { 0: 'General', 1: '0', 2: '0.00', 49: '@' }

function resolveTarget(base: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `${base}${target}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return out.join('/')
}

const columnIndex = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1

/** The visible text of a shared-string item: every `<t>`, except the phonetic runs (`<rPh>`) a spreadsheet may add. */
function stringItemText(item: XmlElement): string {
  let out = ''
  const walk = (element: XmlElement): void => {
    if (element.name === 'rPh') return
    if (element.name === 't') out += element.text
    for (const child of element.children) walk(child)
  }
  walk(item)
  return out
}

export function readWorkbook(bytes: Uint8Array): Workbook {
  const entries = readZip(bytes)
  const parts: Record<string, string> = {}
  for (const entry of entries) {
    if (/\.(xml|rels)$/i.test(entry.name)) parts[entry.name] = new TextDecoder('utf-8', { fatal: true }).decode(entry.data)
  }
  const part = (name: string): string => {
    const text = parts[name]
    if (text === undefined) throw new Error(`the workbook has no part ${name}`)
    return text
  }

  const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const rootRels = parseXml(part('_rels/.rels'))
  const workbookRel = childrenNamed(rootRels, 'Relationship').find((r) => r.attributes['Type'] === `${OFFICE_REL}/officeDocument`)
  if (!workbookRel) throw new Error('no officeDocument relationship')
  const workbookPath = resolveTarget('', workbookRel.attributes['Target']!)
  const workbook = parseXml(part(workbookPath))
  const sheets = childrenNamed(only(workbook, 'sheets'), 'sheet')
  if (sheets.length === 0) throw new Error('the workbook has no sheet')
  const workbookDir = workbookPath.slice(0, workbookPath.lastIndexOf('/') + 1)
  const relsPath = `${workbookDir}_rels/${workbookPath.slice(workbookPath.lastIndexOf('/') + 1)}.rels`
  const rels = childrenNamed(parseXml(part(relsPath)), 'Relationship')
  const target = (type: string, id?: string): string | undefined => {
    const found = rels.filter((r) => r.attributes['Type'] === `${OFFICE_REL}/${type}` && (id === undefined || r.attributes['Id'] === id))
    if (found.length > 1 && id === undefined) throw new Error(`more than one ${type} relationship`)
    return found[0] === undefined ? undefined : resolveTarget(workbookDir, found[0].attributes['Target']!)
  }
  const sheetRelId = attribute(sheets[0]!, 'id')
  const sheetPath = sheetRelId === undefined ? undefined : target('worksheet', sheetRelId)
  if (sheetPath === undefined) throw new Error('the first sheet has no worksheet relationship')

  // Shared strings: absent when the sheet holds no text.
  const sharedPath = target('sharedStrings')
  const strings = sharedPath === undefined ? [] : childrenNamed(parseXml(part(sharedPath)), 'si').map(stringItemText)

  // Styles: the number format and the quote prefix of each `cellXfs` entry.
  const stylesPath = target('styles')
  const styles: CellStyle[] = []
  if (stylesPath !== undefined) {
    const styleSheet = parseXml(part(stylesPath))
    const numFmts = firstChild(styleSheet, 'numFmts')
    const formats = new Map<number, string>(
      (numFmts ? childrenNamed(numFmts, 'numFmt') : []).map((f) => [Number(f.attributes['numFmtId']), f.attributes['formatCode'] ?? '']),
    )
    const cellXfs = firstChild(styleSheet, 'cellXfs')
    for (const xf of cellXfs ? childrenNamed(cellXfs, 'xf') : []) {
      const numFmtId = Number(xf.attributes['numFmtId'] ?? 0)
      styles.push({ formatCode: formats.get(numFmtId) ?? BUILT_IN_FORMATS[numFmtId] ?? null, quotePrefix: xf.attributes['quotePrefix'] === '1' })
    }
  }
  const styleOf = (index: number): CellStyle => styles[index] ?? { formatCode: 'General', quotePrefix: false }

  const worksheet = parseXml(part(sheetPath))
  const formulaCells: string[] = []
  const rows: Cell[][] = []
  for (const row of childrenNamed(only(worksheet, 'sheetData'), 'row')) {
    const rowNumber = Number(row.attributes['r'] ?? rows.length + 1)
    const cells: Cell[] = []
    for (const c of childrenNamed(row, 'c')) {
      const ref = c.attributes['r']
      const letters = ref === undefined ? null : /^([A-Z]+)(\d+)$/.exec(ref)
      if (!letters || Number(letters[2]) !== rowNumber) throw new Error(`cell ${ref ?? '(no reference)'} is not in row ${rowNumber}`)
      const style = styleOf(Number(c.attributes['s'] ?? 0))
      if (firstChild(c, 'f')) formulaCells.push(ref!)
      const v = firstChild(c, 'v')
      const type = c.attributes['t'] ?? 'n'
      let cell: Cell
      if (type === 'inlineStr') {
        const inline = firstChild(c, 'is')
        cell = inline ? { type: 'text', ref: ref!, value: stringItemText(inline), style } : { type: 'empty', ref: ref!, style }
      } else if (v === undefined) {
        cell = { type: 'empty', ref: ref!, style }
      } else if (type === 's') {
        const index = Number(v.text)
        const value = strings[index]
        if (!Number.isInteger(index) || value === undefined) throw new Error(`cell ${ref} points at shared string ${v.text}`)
        cell = { type: 'text', ref: ref!, value, style }
      } else if (type === 'str') {
        cell = { type: 'text', ref: ref!, value: v.text, style }
      } else if (type === 'n') {
        cell = { type: 'number', ref: ref!, value: v.text.trim(), style }
      } else {
        throw new Error(`cell ${ref} has the unexpected type ${type}`)
      }
      cells[columnIndex(letters[1]!)] = cell
    }
    // Fill the gaps (a spreadsheet omits an empty cell it has nothing to say about).
    const dense: Cell[] = []
    for (let column = 0; column < cells.length; column++) {
      dense.push(cells[column] ?? { type: 'empty', ref: `?${rowNumber}`, style: styleOf(0) })
    }
    rows[rowNumber - 1] = dense
  }
  const dense = Array.from({ length: rows.length }, (_, index) => rows[index] ?? [])
  return { entryNames: entries.map((e) => e.name), sheetNames: sheets.map((s) => s.attributes['name'] ?? ''), rows: dense, formulaCells, parts }
}

// ─── The accounting export (AC-6.2) ──────────────────────────────────────────

/** The one sheet of the export (SO-8). */
export const ACCOUNTING_SHEET_NAME = 'Sheet 1'

/** The eight columns A to H, in this order (AC-6.2). No other column exists. */
export const ACCOUNTING_XLSX_HEADER = ['Date', 'Description', 'Debit', 'Credit', 'Amount', 'Currency', 'Tax', 'Note'] as const

/** The media type of the download. */
export const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface AccountingRow {
  /** 2 for the first data row (row 1 is the header). */
  readonly rowNumber: number
  /** The row's cells keyed by the header the FILE carries, so a renamed or moved column fails at the header, not as a missing key. */
  readonly cells: Readonly<Record<string, Cell>>
}

export interface AccountingWorkbook {
  readonly workbook: Workbook
  readonly sheetNames: readonly string[]
  /** What the header row says, cell by cell. */
  readonly header: readonly string[]
  readonly rows: readonly AccountingRow[]
}

/** The cell as text: a text cell's value, a number cell's own text, `''` for an empty cell. */
export function textOf(cell: Cell | undefined): string {
  return cell === undefined || cell.type === 'empty' ? '' : cell.value
}

/** A Date cell (a serial number of the 1900 date system) as `YYYY-MM-DD`; throws for anything else. */
export function isoDateOf(cell: Cell | undefined): string {
  if (cell === undefined || cell.type !== 'number' || !/^\d+$/.test(cell.value)) {
    throw new Error(`[xlsxReader] not a date serial: ${cell === undefined ? 'no cell' : `${cell.type} ${textOf(cell)}`}`)
  }
  // 1899-12-30 is serial 0 in the 1900 date system, which agrees with the real calendar from 1900-03-01 on.
  return new Date(Date.UTC(1899, 11, 30) + Number(cell.value) * 86_400_000).toISOString().slice(0, 10)
}

/** Reads the downloaded bytes as the accounting export: the sheet, the header and the data rows. */
export function parseAccountingWorkbook(bytes: Uint8Array): AccountingWorkbook {
  const workbook = readWorkbook(bytes)
  const [headerCells = [], ...body] = workbook.rows
  const header = headerCells.map((cell) => textOf(cell))
  const rows = body.map((cells, index): AccountingRow => ({
    rowNumber: index + 2,
    cells: Object.fromEntries(header.map((name, column) => [name, cells[column] ?? { type: 'empty', ref: `?${index + 2}`, style: { formatCode: 'General', quotePrefix: false } }])),
  }))
  return { workbook, sheetNames: workbook.sheetNames, header, rows }
}
