// QE of the follow-ups (specs/20261126-teams/qe-followups.md): one NUL at a time in every query, path and body string leaf of every documented operation of every service on the DEV stack. Run: cd shell && bun ../specs/20261126-teams/qe-followups-nul-sweep.ts [service]. Needs the stack up; creates the user qe-followup-probe@operai.test. 5xx whose CONTROL (no NUL) request was not a 5xx is a defect; LEAK = a NUL echoed outside `instance`.
import { seedAdminSession } from '../../shell/e2e/helpers/adminSession'

const SERVICES: Record<string, number> = {
  auth: 3001, estimai: 8080, notify: 8081, refund: 8082, inventory: 8083, crm: 8084,
  meetings: 8085, projects: 8086, activities: 8087, accounting: 8089, hours: 8090,
}
const only = process.argv[2]
const s = await seedAdminSession('qe-followup-probe@operai.test', 'QE Followup Probe')
const NUL = 'a\u0000b'
const SYSTEM = process.env.SWEEP_SYSTEM === '1' // round 1: also /system/* with the USER token (expects the identical 401 before any parsing; a 5xx is a defect)
const SKIP = [/^\/test-auth/, /^\/auth\//, ...(SYSTEM ? [] : [/^\/system\//]), /sign-out/, /^\/invite/, /^\/sign-in/, /^\/jwks/, /stream/, /\/health/]

type Ctx = { target: number; n: number; doc: any }
function resolve(doc: any, sch: any): any {
  let x = sch
  let guard = 0
  while (x && x.$ref && guard++ < 20) {
    const parts = x.$ref.replace(/^#\//, '').split('/')
    x = parts.reduce((a: any, k: string) => a?.[k], doc)
  }
  return x
}
function gen(sch: any, c: Ctx, depth = 0): any {
  sch = resolve(c.doc, sch)
  if (!sch || depth > 6) return null
  if (sch.allOf) return gen(sch.allOf[0], c, depth + 1)
  if (sch.oneOf) return gen(sch.oneOf[0], c, depth + 1)
  if (sch.anyOf) { const nn = sch.anyOf.find((a: any) => resolve(c.doc, a)?.type !== 'null') ?? sch.anyOf[0]; return gen(nn, c, depth + 1) }
  if (sch.enum) return sch.enum[0]
  const t = Array.isArray(sch.type) ? sch.type.find((x: string) => x !== 'null') : sch.type
  if (t === 'object' || sch.properties) {
    const o: any = {}
    for (const [k, v] of Object.entries<any>(sch.properties ?? {})) o[k] = gen(v, c, depth + 1)
    return o
  }
  if (t === 'array') { const first = gen(sch.items ?? {}, c, depth + 1); return (sch.maxItems === undefined || sch.maxItems >= 2) ? [first, gen(sch.items ?? {}, c, depth + 1)] : [first] } // round 1: a second element too, so a NUL in element #2 is reached
  if (t === 'integer' || t === 'number') return sch.minimum ?? 1
  if (t === 'boolean') return false
  const idx = c.n++
  if (idx === c.target) return NUL
  if (sch.format === 'email') return 'qe@operai.test'
  if (sch.format === 'uuid') return '00000000-0000-4000-8000-000000000000'
  if (sch.format === 'date') return '2026-01-01'
  if (sch.format === 'date-time') return '2026-01-01T00:00:00.000Z'
  let v = 'x'
  if (sch.minLength) v = 'x'.repeat(sch.minLength)
  return v
}
const sampleParam = (p: any, doc: any, nul: boolean) => {
  if (nul) return NUL
  const c: Ctx = { target: -2, n: 0, doc }
  const v = gen(p.schema ?? {}, c)
  return v ?? 'x'
}

const out: string[] = []
for (const [svc, port] of Object.entries(SERVICES)) {
  if (only && only !== svc) continue
  const base = `http://localhost:${port}`
  const doc: any = await (await fetch(`${base}/openapi.json`)).json()
  const H: Record<string, string> = { Authorization: `Bearer ${s.token}`, Cookie: s.cookieHeader }
  const counts: Record<string, number> = {}
  const bad: string[] = []
  const leaks: string[] = []
  let n = 0
  async function fire(label: string, method: string, path: string, qs: string, body: any, control: boolean): Promise<number> {
    const init: any = { method, headers: { ...H }, signal: AbortSignal.timeout(15000) }
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body) }
    let r: Response
    try { r = await fetch(`${base}${path}${qs ? '?' + qs : ''}`, init) } catch (e) { bad.push(`${label} FETCH-ERR ${(e as Error).message}`); return 0 }
    const txt = await r.text()
    if (r.status >= 500 && control) bad.push(`${label} control body: ${txt.slice(0, 240)} | sent: ${init.body ? String(init.body).slice(0, 400) : ''}`)
    if (!control) {
      n++
      counts[r.status] = (counts[r.status] ?? 0) + 1
      let stripped = txt
      try { const j = JSON.parse(txt); delete j.instance; stripped = JSON.stringify(j) } catch {}
      if (/u0000|%00|\u0000/i.test(stripped)) leaks.push(`${label} ${r.status} ECHO ${stripped.slice(0, 200)}`)
    }
    return r.status
  }
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    if (SKIP.some((re) => re.test(path))) continue
    if (SYSTEM && !/^\/system\//.test(path)) continue
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method]; if (!op) continue
      const params: any[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(doc, p))
      const jsonBody = op.requestBody?.content?.['application/json']?.schema
      const M = method.toUpperCase()
      const build = (nulParam: any | null, bodyTarget: number) => {
        let p = path; const q: string[] = []
        for (const pr of params) {
          const nul = pr === nulParam
          const v = sampleParam(pr, doc, nul)
          if (pr.in === 'path') p = p.replace(`{${pr.name}}`, encodeURIComponent(String(v)))
          else if (pr.in === 'query' && (pr.required || nul)) q.push(`${encodeURIComponent(pr.name)}=${encodeURIComponent(String(v))}`)
        }
        let body: any = undefined
        if (jsonBody) body = gen(jsonBody, { target: bodyTarget, n: 0, doc })
        return { p, q: q.join('&'), body }
      }
      const control = build(null, -2)
      const cs = await fire(`${M} ${path} CONTROL`, M, control.p, control.q, control.body, true)
      let leaves = 0
      if (jsonBody) { const c: Ctx = { target: -2, n: 0, doc }; gen(jsonBody, c); leaves = c.n }
      const targets: Array<[string, any, number]> = []
      for (const pr of params) if (pr.in === 'path' || pr.in === 'query') targets.push([`${pr.in}:${pr.name}`, pr, -2])
      for (let i = 0; i < Math.min(leaves, 80); i++) targets.push([`body#${i}`, null, i])
      if (jsonBody && !SYSTEM) {
        // round 1: every string leaf NUL at once, and a NUL in an unexpected key name
        const all = build(null, -2); const mark = (v: any): any => typeof v === 'string' ? NUL : Array.isArray(v) ? v.map(mark) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mark(x)])) : v
        const stAll = await fire(`${M} ${path} [body:all-leaves]`, M, all.p, all.q, mark(all.body), false)
        if (stAll >= 500) bad.push(`${cs >= 500 ? '(control also ' + cs + ') ' : ''}${M} ${path} [body:all-leaves] -> ${stAll}`)
        const kb = build(null, -2); if (kb.body && typeof kb.body === 'object' && !Array.isArray(kb.body)) kb.body['a\u0000b'] = 'x'
        const stKey = await fire(`${M} ${path} [body:key]`, M, kb.p, kb.q, kb.body, false)
        if (stKey >= 500) bad.push(`${cs >= 500 ? '(control also ' + cs + ') ' : ''}${M} ${path} [body:key] -> ${stKey}`)
      }
      for (const [name, pr, bt] of targets) {
        const b = build(pr, bt)
        const st = await fire(`${M} ${path} [${name}]`, M, b.p, b.q, b.body, false)
        if (st >= 500 && cs < 500) bad.push(`${M} ${path} [${name}] -> ${st} (control ${cs})`)
        else if (st >= 500) bad.push(`(control also ${cs}) ${M} ${path} [${name}] -> ${st}`)
      }
    }
  }
  out.push(`## ${svc} (${n} requests) ${JSON.stringify(counts)}`)
  for (const b of bad) out.push('  5xx: ' + b)
  for (const l of leaks) out.push('  LEAK: ' + l)
}
console.log(out.join('\n'))
