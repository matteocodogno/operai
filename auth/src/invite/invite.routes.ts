import { OpenAPIHono } from "@hono/zod-openapi";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import {
  effectiveInvitationStatus,
  findInvitationById,
} from "../invitations/invitations.repo";
import { hashInvitationToken, timingSafeEqualHex } from "../invitations/token";
import { env } from "../lib/env";

/**
 * Hosted invite-landing page (T9, specs/006-user-invitations — refs US-2
 * AC-2.2/AC-2.5, plan.md "Invite link & landing", ADR-0002 precedent).
 *
 * Server-rendered HTML at `GET /invite?id=<invId>&token=<raw>`, following
 * `signin.routes.ts`'s established pattern (Hono JSX/`html` tagged
 * templates, per-request CSP nonce, no external asset fetch). Public,
 * unauthenticated — the token itself grants NO access; it only gates this
 * VIEW and, on a valid pending match, prefills the "continue with
 * Google/GitHub" action. Actual activation happens strictly at the
 * verified-OAuth-email match in `user.create.after` (T8, ADR-0012) — this
 * page never writes to the database.
 *
 * `GET /invite/state?id&token` is the JSON seam behind the HTML page (also
 * usable directly by e2e tests / a future SPA): `{ state, email }`, where
 * `email` is disclosed ONLY on a valid, matching, still-pending token — the
 * one case where the invitee is proven to hold a legitimate link (AC-2.5,
 * "no enumeration beyond holder-of-link").
 *
 * Security posture (no enumeration, R3):
 *   - Unknown `id`, missing params, and a token that does not hash-match
 *     the stored `tokenHash` are ALL folded into the same `"invalid"` state
 *     — an attacker guessing ids/tokens learns nothing more than "this
 *     specific (id, token) pair doesn't work", never whether the id exists,
 *     nor an invitation's real status.
 *   - Only once the token DOES match does the response distinguish
 *     `expired`/`revoked`/`accepted` — safe to disclose because the caller
 *     has already proven possession of a valid link for that specific
 *     invitation.
 *   - `email`/(any other interpolated value) is only ever rendered via
 *     Hono's `html` auto-escaping tagged template — mirrors
 *     `signin.routes.ts`'s `errorBanner` discipline — never via `raw()`.
 */

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export type InviteState = "pending" | "expired" | "revoked" | "accepted" | "invalid";

export interface ResolvedInviteState {
  state: InviteState;
  email: string | null;
}

/**
 * The single place `(id, token)` is resolved to a state — used by BOTH the
 * HTML page and the JSON seam, so they can never disagree (mirrors
 * `invitations.repo.ts`'s "one shared function" discipline for effective
 * status).
 */
export async function resolveInviteState(
  id: string | undefined,
  token: string | undefined,
  now: Date = new Date(),
): Promise<ResolvedInviteState> {
  if (!id || !token) {
    return { state: "invalid", email: null };
  }

  const invitation = await findInvitationById(id);
  if (!invitation) {
    return { state: "invalid", email: null };
  }

  const providedHash = await hashInvitationToken(token);
  if (!timingSafeEqualHex(providedHash, invitation.tokenHash)) {
    // Wrong token for a real id (e.g. the OLD link after a resend, AC-3.3) —
    // never disclose the invitation's real status through a mismatched token.
    return { state: "invalid", email: null };
  }

  const effective = effectiveInvitationStatus(invitation, now);
  if (effective === "pending") {
    return { state: "pending", email: invitation.email };
  }
  // expired | accepted | revoked — safe to disclose: the token matched.
  return { state: effective, email: null };
}

// ─── Script-context JSON encoding (mirrors signin.routes.ts) ─────────────────

function scriptJsonEncode(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// ─── Copy (bilingual — IT + EN, matching the invite EMAIL's convention) ──────

const COPY: Record<
  Exclude<InviteState, "pending">,
  { it: string; en: string }
> = {
  expired: {
    it: "Questo invito è scaduto.",
    en: "This invitation has expired.",
  },
  revoked: {
    it: "Questo invito è stato revocato.",
    en: "This invitation has been revoked.",
  },
  accepted: {
    it: "Questo invito è già stato utilizzato.",
    en: "This invitation has already been used.",
  },
  invalid: {
    it: "Questo link non è valido.",
    en: "This link is not valid.",
  },
};

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

function providerButton(provider: "google" | "github", labelIt: string, labelEn: string): Html {
  return html`<button type="button" class="provider-btn" data-provider="${provider}">
    <span>${labelEn} · ${labelIt}</span>
  </button>`;
}

function invalidStateCard(state: Exclude<InviteState, "pending">): Html {
  const copy = COPY[state];
  return html`
    <p class="subtitle">${copy.en}</p>
    <p class="subtitle subtitle-it">${copy.it}</p>
  `;
}

function pendingStateCard(email: string): Html {
  return html`
    <p class="subtitle">
      You have been invited to Operai · Sei stato invitato a Operai
    </p>
    <p class="invite-email">${email}</p>
    <div class="providers">
      ${providerButton("google", "Continua con Google", "Continue with Google")}
      ${providerButton("github", "Continua con GitHub", "Continue with GitHub")}
    </div>
  `;
}

function renderInvitePage(opts: {
  resolved: ResolvedInviteState;
  nonce: string;
}): Html {
  const { resolved, nonce } = opts;
  const callbackURL = env.UI_HOME_URL;
  const isPending = resolved.state === "pending" && resolved.email !== null;

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0d0d14" />
        <title>Invitation · Operai</title>
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
            max-width: 420px;
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
            font-size: 24px;
            line-height: 1.25;
            margin: 0 0 12px;
          }
          .subtitle {
            color: var(--text);
            font-size: 14px;
            font-weight: 400;
            margin: 0 0 6px;
          }
          .subtitle-it {
            color: var(--muted);
          }
          .invite-email {
            font-family: var(--body), sans-serif;
            font-size: 14px;
            font-weight: 500;
            color: var(--acc-hi);
            background: var(--acc-lo);
            border-radius: 8px;
            padding: 8px 12px;
            margin: 16px 0 24px;
            word-break: break-all;
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
          <h1>${isPending ? "You're invited · Sei stato invitato" : "Invitation · Invito"}</h1>
          ${isPending && resolved.email !== null
            ? pendingStateCard(resolved.email)
            : invalidStateCard((resolved.state === "pending" ? "invalid" : resolved.state) as Exclude<InviteState, "pending">)}
          <p class="footnote">Authorized wellD accounts only.</p>
        </main>
        ${isPending
          ? html`<script nonce="${nonce}">
              (function () {
                var callbackURL = ${raw(scriptJsonEncode(callbackURL))};
                var buttons = document.querySelectorAll("[data-provider]");
                buttons.forEach(function (btn) {
                  btn.addEventListener("click", function () {
                    var provider = btn.getAttribute("data-provider");
                    buttons.forEach(function (b) { b.disabled = true; });
                    var body = { provider: provider, callbackURL: callbackURL };
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
            </script>`
          : ""}
      </body>
    </html>`;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const inviteRouter = new OpenAPIHono();

inviteRouter.get("/invite/state", async (c) => {
  const id = c.req.query("id");
  const token = c.req.query("token");
  const resolved = await resolveInviteState(id, token);
  return c.json(resolved, 200);
});

inviteRouter.get("/invite", async (c) => {
  const id = c.req.query("id");
  const token = c.req.query("token");
  const resolved = await resolveInviteState(id, token);

  // Per-request CSP nonce (same rationale as signin.routes.ts).
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...nonceBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  c.header(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "connect-src 'self'",
      "img-src 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");

  const page = renderInvitePage({ resolved, nonce });
  return c.html(page);
});
