#!/usr/bin/env node
// Opens the suite in the default browser once it answers — used by the
// `mise run dev*` tasks. Usage: node scripts/open-when-ready.mjs <open-url> [wait-url...]
// Every wait-url (and the open-url itself) must respond before the browser
// opens. Set OPERAI_NO_OPEN=1 to skip (CI, e2e, remote shells). Never fails the
// task: on timeout it prints the URL and exits 0.

import { spawn } from "node:child_process";

const [openUrl, ...waitUrls] = process.argv.slice(2);
const TIMEOUT_MS = 120_000;
const INTERVAL_MS = 500;

if (!openUrl) {
  console.error("usage: open-when-ready.mjs <open-url> [wait-url...]");
  process.exit(0);
}
if (process.env.OPERAI_NO_OPEN || process.env.CI) process.exit(0);

// Any HTTP response counts as "up" — only a refused/failed connection does not.
async function responds(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

const pending = new Set([openUrl, ...waitUrls]);
const deadline = Date.now() + TIMEOUT_MS;

while (pending.size > 0 && Date.now() < deadline) {
  for (const url of pending) {
    if (await responds(url)) pending.delete(url);
  }
  if (pending.size > 0) await new Promise((r) => setTimeout(r, INTERVAL_MS));
}

if (pending.size > 0) {
  console.error(`[open] still not answering after ${TIMEOUT_MS / 1000}s: ${[...pending].join(", ")} — open ${openUrl} yourself`);
  process.exit(0);
}

const command =
  process.platform === "darwin" ? ["open", [openUrl]]
  : process.platform === "win32" ? ["cmd", ["/c", "start", "", openUrl]]
  : ["xdg-open", [openUrl]];

const child = spawn(command[0], command[1], { stdio: "ignore", detached: true });
child.on("error", () => console.error(`[open] could not launch a browser — open ${openUrl} yourself`));
child.unref();
console.log(`[open] ${openUrl}`);
