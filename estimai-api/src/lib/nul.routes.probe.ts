/**
 * Child-process script of `nul.routes.test.ts`; not part of the service. It loads the REAL app (`src/index.ts`: every router, every
 * middleware, the real error handler), fires each request of the case list it reads on stdin through `app.request`, and prints the
 * answers and the route table as one JSON line. The tokens are real RS256 JWTs the test signed, verified against the JWKS the test
 * serves. A child, because importing the whole app in the test process would load every router into the shared module registry.
 */
export {}; // a module, so the top-level awaits below type-check

const { app } = await import(process.cwd() + "/src/index.ts");

type Case = { label: string; method: string; path: string; body?: unknown; auth: "user" | "service"; headers?: Record<string, string> };
const cases = JSON.parse(await Bun.stdin.text()) as Case[];
const bearer = { user: `Bearer ${process.env["USER_TOKEN"]}`, service: `Bearer ${process.env["SERVICE_TOKEN"]}` };

const call = async (c: Case, owned: string) => {
  const res = await app.request(c.path.replaceAll("{owned}", owned), {
    method: c.method,
    headers: {
      Authorization: bearer[c.auth],
      ...(c.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(c.headers ?? {}),
    },
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
  return { status: res.status, body: await res.text() };
};

// A real estimate of the caller's own for EVERY case (a control may delete or close it), so a body reached only after the access
// check (collaborators) is reached and the NUL is the only thing wrong with the request.
const create = async (): Promise<string> => {
  const res = await call(
    {
      label: "setup",
      method: "POST",
      path: "/estimates",
      auth: "user",
      body: { name: "nul-routes", author: "", content: { params: {}, releases: [], acts: [] } },
    },
    "",
  );
  return (JSON.parse(res.body) as { id: string }).id;
};

/** The ids of the estimates an answer says were created: a created estimate (`id`) or the imported elements of a batch. */
const createdBy = (body: string): string[] => {
  try {
    const json = JSON.parse(body) as { id?: unknown; results?: { status?: string; id?: string }[] };
    return [
      ...(typeof json.id === "string" && /^c[a-z0-9]{20,}$/.test(json.id) ? [json.id] : []),
      ...(json.results ?? []).flatMap((r) => (r.status === "imported" && typeof r.id === "string" ? [r.id] : [])),
    ];
  } catch {
    return [];
  }
};

const results: Record<string, { status: number; body: string }> = {};
for (const c of cases) {
  const owned = await create();
  try {
    const res = await call(c, owned);
    results[c.label] = res;
    // An estimate a control created (a create, an import) is deleted too: nothing a case leaves behind outlives the run.
    for (const id of createdBy(res.body)) await call({ label: "cleanup", method: "DELETE", path: `/estimates/${id}`, auth: "user" }, owned);
  } finally {
    // A deleted one answers 404, which is fine.
    await call({ label: "cleanup", method: "DELETE", path: "/estimates/{owned}", auth: "user" }, owned);
  }
}

// What the run left behind for the caller (the test asserts none).
const left = (JSON.parse((await call({ label: "left", method: "GET", path: "/estimates", auth: "user" }, "")).body) as unknown[]).length;

console.log(
  "RESULT " +
    JSON.stringify({
      routes: (app.routes as { method: string; path: string }[]).map((r) => `${r.method} ${r.path}`),
      results,
      left,
    }),
);
process.exit(0);
