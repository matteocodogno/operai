/**
 * The consolidated service-JWT middleware serves three /system routes (specs/021 AC-11.8, specs/018
 * AC-3.3, specs/024 `GET /system/companies`). A service credential is valid for ITS route only: meetings-api's host-notices token must
 * not open the estimate-notices route and estimai-api's estimate-notices token must not open the
 * host-notices route, whatever else each token carries (QE rebase-seam check, specs/021).
 */
import { TEST_ISSUER } from "../test-support/testAuth"; // sets the environment before ../lib/env is read
import { beforeEach, describe, expect, it } from "bun:test";
import { signServiceToken, app, resetWorld } from "../test-support/world";

void TEST_ISSUER;

const HOST = "/system/meeting-host/v1/notices";
const ESTIMATE = "/system/estimate-notices";
const COMPANIES = "/system/companies";
beforeEach(resetWorld);

const post = async (path: string, token: string) => {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  return res.status;
};

describe("cross-route service credentials are refused with 401", () => {
  it("meetings-api (host-notices.send) cannot post an estimate notice", async () => {
    const token = await signServiceToken({ sub: "system:meetings-api", scope: "notifications.push host-notices.send" });
    expect(await post(ESTIMATE, token)).toBe(401);
  });

  it("estimai-api (estimate-notices.send) cannot post a host notice", async () => {
    const token = await signServiceToken({ sub: "system:estimai-api", scope: "notifications.push estimate-notices.send" });
    expect(await post(HOST, token)).toBe(401);
  });

  it("even holding BOTH scopes, the sub allowlist keeps each caller on its own route", async () => {
    const both = "host-notices.send estimate-notices.send";
    expect(await post(ESTIMATE, await signServiceToken({ sub: "system:meetings-api", scope: both }))).toBe(401);
    expect(await post(HOST, await signServiceToken({ sub: "system:estimai-api", scope: both }))).toBe(401);
  });

  it("each caller passes the credential check on its own route (a malformed body is 422, not 401)", async () => {
    const meetings = await signServiceToken({ sub: "system:meetings-api", scope: "notifications.push host-notices.send" });
    const estimai = await signServiceToken({ sub: "system:estimai-api", scope: "notifications.push estimate-notices.send" });
    expect(await post(HOST, meetings)).toBe(422);
    expect(await post(ESTIMATE, estimai)).toBe(422);
  });

  it("only projects-api reads CRM companies: another client holding crm.companies.read is refused", async () => {
    const get = async (token: string) =>
      (await app.request(COMPANIES, { headers: { Authorization: `Bearer ${token}` } })).status;
    const scope = "crm.companies.read";
    expect(await get(await signServiceToken({ sub: "system:meetings-api", scope: `host-notices.send ${scope}` }))).toBe(401);
    expect(await get(await signServiceToken({ sub: "system:estimai-api", scope }))).toBe(401);
    expect(await get(await signServiceToken({ sub: "system:projects-api", scope }))).toBe(200);
  });
});
