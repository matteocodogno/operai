import type { Context } from "hono";
import { nulRefusal } from "./inputText";

/**
 * `new OpenAPIHono({ defaultHook: zodIssuesHook })` for the routers that never had a hook of their
 * own: a path/query/body that fails its schema is a 400 whose body is
 * `{ success: false, error: { issues, name: "ZodError" } }`.
 *
 * That is the shape @hono/zod-openapi 0.x produced by serialising the ZodError (zod 3 exposes
 * `issues` and `name` as own enumerable members). zod 4's ZodError serialises as `{ name, message }`
 * with `message` the stringified issue list, so without this hook the migration to zod 4 would
 * have changed the wire shape of every validation failure. The `issues` themselves are zod 4's
 * (`path`, `message` and `code` are all still there; code names and default messages differ).
 */
export const zodIssuesHook = (
  result: { success: true } | { success: false; error: { issues: readonly unknown[] } },
  c: Context,
): Response | undefined => {
  if (result.success) return undefined;
  const nul = nulRefusal(result, c);
  if (nul) return nul;
  return c.json({ success: false, error: { issues: result.error.issues, name: "ZodError" } }, 400);
};
