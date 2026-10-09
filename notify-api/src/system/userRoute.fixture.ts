/**
 * Subprocess fixture for serviceJwt.isolation.test.ts — NOT a test file.
 *
 * Mounts the REAL jwtMiddleware (the guard on every user route) against the
 * JWKS the parent test serves, and prints the HTTP status it gives to a
 * service JWT and to a user JWT as `{"service":<n>,"user":<n>}`. Runs in its
 * own process so the module-scope JWKS and env are fully isolated from every
 * other test file (no mock.module, no load-order dependence).
 */

import { Hono } from "hono";
import { jwtMiddleware } from "../auth/jwt.middleware";

const app = new Hono();
app.use("/protected", jwtMiddleware);
app.get("/protected", (c) => c.json({ ok: true }));

const status = async (token: string) =>
  (
    await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).status;

const out = {
  service: await status(process.env["TEST_SERVICE_TOKEN"]!),
  user: await status(process.env["TEST_USER_TOKEN"]!),
};
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
