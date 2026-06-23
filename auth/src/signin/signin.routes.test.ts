import { describe, expect, test } from "bun:test";
import { signinRouter } from "./signin.routes";

async function getSignIn(path = "/sign-in"): Promise<Response> {
  return signinRouter.request(path);
}

describe("GET /sign-in", () => {
  test("returns 200 HTML", async () => {
    const res = await getSignIn();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("offers a Google sign-in control wired to the social endpoint", async () => {
    const res = await getSignIn();
    const html = await res.text();
    expect(html).toContain('data-provider="google"');
    expect(html).toContain("Continue with Google");
  });

  test("offers a GitHub sign-in control wired to the social endpoint", async () => {
    const res = await getSignIn();
    const html = await res.text();
    expect(html).toContain('data-provider="github"');
    expect(html).toContain("Continue with GitHub");
  });

  test("both controls post to POST /auth/sign-in/social with the matching provider", async () => {
    const res = await getSignIn();
    const html = await res.text();
    // single submit path used by both buttons, provider read from the control
    expect(html).toContain('fetch("/auth/sign-in/social"');
    expect(html).toContain('method: "POST"');
    expect(html).toContain('provider: provider');
    expect(html).toContain('getAttribute("data-provider")');
  });

  test("uses the Operai design system tokens", async () => {
    const res = await getSignIn();
    const html = await res.text();
    // dark ink palette + purple accent + DM Sans / Syne typefaces
    expect(html).toContain("#0d0d14"); // dark ink
    expect(html).toContain("#5b6af7"); // purple accent
    expect(html).toContain("DM+Sans");
    expect(html).toContain("Syne");
  });
});
