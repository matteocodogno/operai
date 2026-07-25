/**
 * Shared `.env`/template parser — a plain `KEY=VALUE` reader used by both the
 * CLI (`index.ts`) and the template resolver (`resolve.ts`). Kept dependency-free
 * and side-effect-free so it stays trivially testable.
 */

export type ServiceEnv = Record<string, string>;

/** Parse a `KEY=VALUE` env/template blob. Ignores blanks/comments, strips an
 * optional `export ` prefix and one layer of matching surrounding quotes.
 * Values may contain `${{railway.refs}}` or `${OP:1password/refs}` verbatim. */
export function parseEnvFile(text: string): ServiceEnv {
  const out: ServiceEnv = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) continue;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]!] = val;
  }
  return out;
}
