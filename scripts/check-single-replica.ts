#!/usr/bin/env bun
/**
 * scripts/check-single-replica.ts — refuse a second replica of a service that can only run as one process.
 *
 * Some services keep state IN PROCESS (a rate-limit window, an SSE fan-out, a job runner, a render pool). A second
 * replica would not share that state, it would double it. Nothing stopped someone raising `replicas` in
 * `.railway/railway.ts`; this offline check does (specs/20261126-teams R12, specs/20261126-teams/r12-r13-decision.md § 3).
 * It reads the file as text, so it needs no Railway token and no install.
 *
 * Each registered service must have exactly one `service("<name>", …)` call with exactly one literal
 * `replicas: { "<region>": <n>, … }` whose figures total exactly 1. A missing file, a missing, repeated or
 * non-literal `replicas` is a failure, never a skip.
 *
 * Usage:  bun scripts/check-single-replica.ts      (mise run replicas:check)
 * Test:   bun test scripts/check-single-replica.test.ts
 * Exit:   0 = every registered service has one replica, 1 = a violation or an unreadable file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SingleReplica {
  readonly service: string;
  /** Why one process is required, and what must change before a second one is allowed. Shown in the error. */
  readonly why: string;
}

/** Services whose correctness or budget depends on running ONE process. Add one when that becomes true. */
export const SINGLE_REPLICA: readonly SingleReplica[] = [
  {
    service: "projects-api",
    why: "its team-read limiters are per process (specs/20261126-teams D13, D15, R12): a second replica doubles TEAM_READ_SERVICE_LIMIT (2 400 / 10 min) past auth's `teams` allowance (3 000). First divide the figures in projects-api/src/lib/rateLimiter.ts by the replica count or move the windows to a shared store (ADR 20261126-teams-… escalation trigger)",
  },
  {
    service: "notify-api",
    why: "the SSE fan-out and the stream-ticket store are in process (ADR 20260713-sse-stream-auth-short-lived-ticket; notify-api/src/notifications/eventBus.ts, ticketStore.ts)",
  },
  {
    service: "meetings-api",
    why: "the in-process durable job runner (ADR 20261104-durable-job-runner-work-queued-state-derived; AGENTS.md 'single replica')",
  },
  {
    service: "letterhead-api",
    why: "the render pool, its queue and the per-caller share are in process (ADR 20261116-renders-run-in-killable-worker-processes-and-concurrency-is-bounded-by-memory; .railway/railway.ts comment)",
  },
  {
    service: "accounting-api",
    why: "the rate fetch is single flight per (entity, month) in process; a second replica doubles the calls to the federal source (.railway/railway.ts comment)",
  },
];

export const RAILWAY_FILE = ".railway/railway.ts";

/** Where a service's call ends: the next declaration of anything. */
const BLOCK_END = /\b(?:service|bucket|volume|postgres)\(|\breturn\s+project\(/g;

/** Drop `//` line comments (a `//` after `:` is a URL, not a comment). */
function stripComments(text: string): string {
  return text.replace(/(^|\s)\/\/.*$/gm, "$1");
}

export type Replicas = { ok: true; total: number } | { ok: false; reason: string };

/** The replica total of one service, or why it cannot be read. */
export function replicasOf(source: string, service: string): Replicas {
  const text = stripComments(source);
  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const starts = [...text.matchAll(new RegExp(`\\bservice\\(\\s*"${escaped}"\\s*,`, "g"))];
  if (starts.length === 0) return { ok: false, reason: `no service("${service}", …) call found` };
  if (starts.length > 1) return { ok: false, reason: `service("${service}", …) is declared ${starts.length} times` };
  const from = (starts[0]!.index ?? 0) + starts[0]![0].length;
  BLOCK_END.lastIndex = from;
  const end = BLOCK_END.exec(text);
  const block = text.slice(from, end ? end.index : text.length);

  const keys = [...block.matchAll(/\breplicas\s*:/g)];
  if (keys.length === 0) return { ok: false, reason: "no `replicas` entry (Railway's default is not a promise of one)" };
  if (keys.length > 1) return { ok: false, reason: `\`replicas\` appears ${keys.length} times` };
  const literal = block.match(/\breplicas\s*:\s*\{([^{}]*)\}/);
  if (!literal) return { ok: false, reason: '`replicas` is not a literal `{ "<region>": <integer> }` object' };

  let total = 0;
  const entries = literal[1]!
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (entries.length === 0) return { ok: false, reason: "`replicas` is empty" };
  for (const entry of entries) {
    const m = entry.match(/^"([^"]+)"\s*:\s*(\d+)$/);
    if (!m) return { ok: false, reason: `\`replicas\` entry \`${entry}\` is not "<region>": <integer>` };
    total += Number(m[2]);
  }
  return { ok: true, total };
}

/** Violations of the registry against the text of `.railway/railway.ts`. */
export function checkReplicas(registry: readonly SingleReplica[], source: string): string[] {
  const errors: string[] = [];
  for (const { service, why } of registry) {
    const r = replicasOf(source, service);
    if (r.ok && r.total === 1) continue;
    const found = r.ok ? `found ${r.total}` : `cannot be read: ${r.reason}`;
    errors.push(
      `${service}: ${RAILWAY_FILE} must give it exactly 1 replica (${found}).\n` +
        `  Why: ${why}\n` +
        `  To run more, make the change the reason names first, then remove its entry from SINGLE_REPLICA\n` +
        `  in scripts/check-single-replica.ts in the same commit.`,
    );
  }
  return errors;
}

export function checkFile(registry: readonly SingleReplica[], root: string): string[] {
  const path = join(root, RAILWAY_FILE);
  if (!existsSync(path)) return [`${RAILWAY_FILE} not found (looked in ${root}); the check never skips a missing file`];
  return checkReplicas(registry, readFileSync(path, "utf8"));
}

if (import.meta.main) {
  const root = process.env.SINGLE_REPLICA_ROOT ?? join(import.meta.dir, "..");
  const errors = checkFile(SINGLE_REPLICA, root);
  if (errors.length > 0) {
    console.error(errors.join("\n\n"));
    process.exit(1);
  }
  console.log(`single-replica: ${SINGLE_REPLICA.length} services, each exactly 1 replica in ${RAILWAY_FILE}`);
}
