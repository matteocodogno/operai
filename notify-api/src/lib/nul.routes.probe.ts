/**
 * Child-process script of `nul.routes.test.ts`; not part of the service. It loads the REAL app (`src/index.ts`: every router, every
 * middleware, the real error handler), fires each request of the case list it reads on stdin through `app.request`, and prints the
 * answers and the route table as one JSON line. The tokens are real RS256 JWTs the test signed, verified against the JWKS the test
 * serves. A child, because importing the whole app in the test process would load every router into the shared module registry.
 */
export {}; // a module, so the top-level awaits below type-check

const { app } = await import(process.cwd() + "/src/index.ts");
const { db } = await import(process.cwd() + "/src/lib/db.ts");

type Auth = "user" | "service";
type Case = { label: string; method: string; path: string; body?: unknown; auth: Auth; headers?: Record<string, string> };
const cases = JSON.parse(await Bun.stdin.text()) as Case[];
const bearer = { user: `Bearer ${process.env["USER_TOKEN"]}`, service: `Bearer ${process.env["SERVICE_TOKEN"]}` };
const userPrefix = process.env["USER_PREFIX"]!;

const results: Record<string, { status: number; body: string }> = {};
for (const c of cases) {
  const res = await app.request(c.path, {
    method: c.method,
    headers: {
      Authorization: bearer[c.auth],
      ...(c.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(c.headers ?? {}),
    },
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
  results[c.label] = { status: res.status, body: await res.text() };
}

// Nothing the cases wrote outlives the run: the rows of the caller and of the recipients the cases name, by their prefix.
await db.notification.deleteMany({ where: { recipientId: { startsWith: userPrefix } } });
await db.pushDevice.deleteMany({ where: { userId: { startsWith: userPrefix } } });
await db.emailDelivery.deleteMany({ where: { to: { startsWith: userPrefix } } });
const left =
  (await db.notification.count({ where: { recipientId: { startsWith: userPrefix } } })) +
  (await db.pushDevice.count({ where: { userId: { startsWith: userPrefix } } })) +
  (await db.emailDelivery.count({ where: { to: { startsWith: userPrefix } } }));

console.log(
  "RESULT " +
    JSON.stringify({
      routes: (app.routes as { method: string; path: string }[]).map((r) => `${r.method} ${r.path}`),
      results,
      left,
    }),
);
process.exit(0);
