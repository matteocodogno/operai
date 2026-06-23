import { OpenAPIHono } from "@hono/zod-openapi";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/**
 * Hosted sign-in page for the Operai suite (ADR-0002).
 *
 * Server-rendered HTML served at `GET /sign-in`. It offers "Continue with
 * Google" and "Continue with GitHub" controls, each wired to the existing
 * Better Auth endpoint `POST /auth/sign-in/social` with the matching provider.
 *
 * Scope note (spec 002):
 *  - T1 (this task) renders the page and wires both provider controls.
 *  - T2 adds `redirect` validation against ALLOWED_ORIGINS and the
 *    `callbackURL` wiring (seam: `resolveCallbackURL` below).
 *  - T3 adds the OAuth-failure banner driven by `?error=<code>` (seam:
 *    `errorBanner` below).
 */

// ─── Provider catalogue ──────────────────────────────────────────────────────

type Provider = {
  id: "google" | "github";
  label: string;
  icon: HtmlEscapedString;
};

// Inline SVG marks keep the page self-contained (no external asset fetch,
// CSP-friendly per ADR-0002).
const GOOGLE_ICON = raw(
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/>' +
    '<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>' +
    '<path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/>' +
    '<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/>' +
    "</svg>",
);

const GITHUB_ICON = raw(
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 1A11 11 0 0 0 8.52 22.44c.55.1.75-.24.75-.53v-1.86c-3.06.67-3.71-1.47-3.71-1.47-.5-1.28-1.22-1.62-1.22-1.62-1-.68.08-.67.08-.67 1.1.08 1.68 1.13 1.68 1.13.98 1.69 2.58 1.2 3.21.92.1-.71.39-1.2.7-1.47-2.44-.28-5.01-1.22-5.01-5.43 0-1.2.43-2.18 1.13-2.95-.11-.28-.49-1.4.11-2.92 0 0 .92-.3 3.02 1.13a10.4 10.4 0 0 1 5.5 0c2.1-1.43 3.02-1.13 3.02-1.13.6 1.52.22 2.64.11 2.92.7.77 1.13 1.75 1.13 2.95 0 4.22-2.58 5.15-5.03 5.42.4.34.75 1.02.75 2.06v3.05c0 .3.2.64.76.53A11 11 0 0 0 12 1z"/>' +
    "</svg>",
);

const PROVIDERS: Provider[] = [
  { id: "google", label: "Continue with Google", icon: GOOGLE_ICON },
  { id: "github", label: "Continue with GitHub", icon: GITHUB_ICON },
];

// ─── Seams for T2 / T3 ───────────────────────────────────────────────────────

/**
 * T2 will validate `redirect` against ALLOWED_ORIGINS and fall back to
 * UI_HOME_URL. For T1 the post-login destination is intentionally left to
 * Better Auth's default, so this returns `null` (no `callbackURL` sent).
 */
function resolveCallbackURL(_redirect: string | undefined): string | null {
  return null;
}

/**
 * T3 will render a human-readable banner when `?error=<code>` is present.
 * For T1 this renders nothing.
 */
function errorBanner(_error: string | undefined): HtmlEscapedString | "" {
  return "";
}

// ─── Page ────────────────────────────────────────────────────────────────────

const TOKENS = `
  --ink:      #0d0d14;
  --ink-soft: #13131e;
  --ink-mid:  #1c1c2a;
  --rule:     #252536;
  --muted:    #5a5a7a;
  --text:     #ddddf0;
  --acc:      #5b6af7;
  --acc-hi:   #8b96ff;
  --acc-lo:   rgba(91, 106, 247, 0.14);
  --disp: 'Syne', sans-serif;
  --body: 'DM Sans', sans-serif;
`;

function providerButton(p: Provider): Html {
  return html`<button
    type="button"
    class="provider-btn"
    data-provider="${p.id}"
  >
    <span class="provider-icon">${p.icon}</span>
    <span>${p.label}</span>
  </button>`;
}

function renderSignInPage(opts: {
  redirect: string | undefined;
  error: string | undefined;
}): Html {
  const callbackURL = resolveCallbackURL(opts.redirect);

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0d0d14" />
        <title>Sign in · Operai</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500&display=swap"
        />
        <style>
          :root {${raw(TOKENS)}}
          * { box-sizing: border-box; }
          html, body { height: 100%; margin: 0; }
          body {
            background: var(--ink);
            color: var(--text);
            font-family: var(--body), sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
          }
          .card {
            width: 100%;
            max-width: 380px;
            background: var(--ink-soft);
            border: 1px solid var(--rule);
            border-radius: 16px;
            padding: 40px 32px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
          }
          .brand {
            font-family: var(--disp), sans-serif;
            font-weight: 800;
            font-size: 13px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--acc-hi);
            margin: 0 0 24px;
          }
          .brand .dot { color: var(--acc); }
          h1 {
            font-family: var(--disp), sans-serif;
            font-weight: 700;
            font-size: 26px;
            line-height: 1.2;
            margin: 0 0 8px;
          }
          .subtitle {
            color: var(--muted);
            font-size: 14px;
            font-weight: 300;
            margin: 0 0 28px;
          }
          .providers {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .provider-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            width: 100%;
            padding: 13px 16px;
            font-family: var(--body), sans-serif;
            font-size: 14px;
            font-weight: 500;
            color: var(--text);
            background: var(--ink-mid);
            border: 1px solid var(--rule);
            border-radius: 10px;
            cursor: pointer;
            transition: border-color 0.15s, background 0.15s;
          }
          .provider-btn:hover {
            border-color: var(--acc);
            background: var(--acc-lo);
          }
          .provider-btn:disabled {
            opacity: 0.6;
            cursor: progress;
          }
          .provider-icon {
            display: inline-flex;
            color: var(--text);
          }
          .error-banner {
            border: 1px solid rgba(247, 91, 91, 0.4);
            background: rgba(247, 91, 91, 0.1);
            color: #ffb4b4;
            border-radius: 10px;
            padding: 12px 14px;
            font-size: 13px;
            margin: 0 0 20px;
          }
          .footnote {
            margin: 24px 0 0;
            font-size: 12px;
            color: var(--muted);
            text-align: center;
          }
        </style>
      </head>
      <body>
        <main class="card">
          <p class="brand">Operai<span class="dot">.</span></p>
          <h1>Sign in to EstimAI</h1>
          <p class="subtitle">AI tools built by craftspeople, for craftspeople.</p>
          ${errorBanner(opts.error)}
          <div class="providers">
            ${PROVIDERS.map((p) => providerButton(p))}
          </div>
          <p class="footnote">Authorized wellD accounts only.</p>
        </main>
        <script>
          (function () {
            var callbackURL = ${raw(JSON.stringify(callbackURL))};
            var buttons = document.querySelectorAll("[data-provider]");
            buttons.forEach(function (btn) {
              btn.addEventListener("click", function () {
                var provider = btn.getAttribute("data-provider");
                buttons.forEach(function (b) { b.disabled = true; });
                var body = { provider: provider };
                if (callbackURL) body.callbackURL = callbackURL;
                fetch("/auth/sign-in/social", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify(body),
                })
                  .then(function (res) { return res.json(); })
                  .then(function (data) {
                    if (data && data.url) {
                      window.location.href = data.url;
                    } else {
                      buttons.forEach(function (b) { b.disabled = false; });
                    }
                  })
                  .catch(function () {
                    buttons.forEach(function (b) { b.disabled = false; });
                  });
              });
            });
          })();
        </script>
      </body>
    </html>`;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const signinRouter = new OpenAPIHono();

signinRouter.get("/sign-in", (c) => {
  const redirect = c.req.query("redirect");
  const error = c.req.query("error");
  const page = renderSignInPage({ redirect, error });
  return c.html(page);
});
