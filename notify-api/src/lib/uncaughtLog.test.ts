/**
 * Security review A09: since the routes keep the database's error as the `cause` (`dbFailure.ts`), the global error handler's fallback must
 * not log it. It logs the error's name and code only, so a sentinel in a Prisma-shaped cause message, or in the error's own, never reaches
 * the log. The REAL assembled app runs in a child process (own module registry, as `systemAuth.logPrivacy.test.ts`), which throws from
 * `GET /health` and prints what `console.error` received. This file reads no dotenv file: the child gets the test's own environment.
 */
import { describe, expect, it } from "bun:test";

const SENTINEL = "qe-sentinel-cause-7731@sentinel-uncaught.example";

describe("the uncaught fallback logs a database cause by nothing", () => {
  it("a Prisma-shaped cause whose message and meta carry a sentinel is not in the log; the line is the name and code of the error", async () => {
    const script = `
      const { eventBus } = await import("./src/notifications/eventBus");
      eventBus.connectionCount = () => {
        const cause = Object.assign(new Error("Invalid invocation: where { recipient: '" + process.env.QE_SENTINEL + "' }"), {
          name: "PrismaClientKnownRequestError", code: "P2024", meta: { args: process.env.QE_SENTINEL },
        });
        throw Object.assign(new Error("Unexpected database failure", { cause }), { code: "E_QE_BOOM" });
      };
      const server = (await import("./src/index")).default;
      const logged = [];
      for (const m of ["log", "info", "warn", "error"]) console[m] = (...a) => logged.push(a.join(" ") + " " + Bun.inspect(a, { depth: 8 }));
      const res = await server.fetch(new Request("http://localhost/health"));
      process.stdout.write("RESULT:" + JSON.stringify({ status: res.status, body: await res.text(), logged }));
      process.exit(0);
    `;
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, QE_SENTINEL: SENTINEL, NODE_ENV: "test", PUSH_ENABLED: "false", PORT: "18083" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const result = JSON.parse(out.slice(out.indexOf("RESULT:") + 7)) as { status: number; body: string; logged: string[] };
    expect(result.status).toBe(500);
    expect(result.body).not.toContain(SENTINEL);
    const uncaught = result.logged.filter((l) => l.startsWith("[uncaught]"));
    expect(uncaught).toHaveLength(1);
    expect(uncaught[0]).toContain("E_QE_BOOM");
    expect(result.logged.join("\n")).not.toMatch(/sentinel|invocation|P2024/i);
  }, 30_000);
});
