/**
 * Unit tests for renderEmailTemplate (T7, specs/20260719-refund-monthly-processing,
 * plan.md §Email, ADR 20260719-refund-batch-signed-link-email-delivery), covering the new `refund_batch_compiled`
 * template — deep link + batch reference render, every field is
 * HTML-escaped (no injection surface, ADR 20260714-notify-api-email-channel-service-trust posture reused), the shape is
 * fixed (English-only, no attachment/PDF/presigned-URL content) — and a
 * regression check that the existing `invitation`/`invitation_resend`
 * templates are unaffected by the refactor to a single correlated
 * `{template, data}` parameter.
 */

import { describe, expect, it } from "bun:test";
import { formatNoticeWhen, renderEmailTemplate } from "./emailTemplates";

describe("renderEmailTemplate — refund_batch_compiled (T7, ADR 20260719-refund-batch-signed-link-email-delivery)", () => {
  const baseData = {
    batchUrl: "https://app.operai.welld.io/refund/batches/batch_123",
    batchReference: "batch_123",
    cutoff: "2026-07-19T23:59:59Z",
    generatedAt: "2026-07-20T08:00:00Z",
    requestCount: 7,
  };

  it("renders the app deep link and batch reference in the body", () => {
    const { html } = renderEmailTemplate({
      template: "refund_batch_compiled",
      data: baseData,
    });

    expect(html).toContain(baseData.batchUrl);
    expect(html).toContain(baseData.batchReference);
    expect(html).toContain(String(baseData.requestCount));
  });

  it("includes the batch reference in the subject", () => {
    const { subject } = renderEmailTemplate({
      template: "refund_batch_compiled",
      data: baseData,
    });

    expect(subject).toContain(baseData.batchReference);
  });

  it("never carries a PDF/attachment/presigned-URL concept — only the app deep link", () => {
    const { html } = renderEmailTemplate({
      template: "refund_batch_compiled",
      data: baseData,
    });

    expect(html.toLowerCase()).not.toContain(".pdf");
    expect(html.toLowerCase()).not.toContain("attachment");
    expect(html.toLowerCase()).not.toContain("presigned");
    expect(html.toLowerCase()).not.toContain("x-amz");
  });

  it("is English-only — no Italian copy (unlike the bilingual invitation templates)", () => {
    const { html, subject } = renderEmailTemplate({
      template: "refund_batch_compiled",
      data: baseData,
    });

    // The invitation templates' Italian copy always includes "invitato"/"scade"
    // — a cheap canary that this template never picked up bilingual rendering.
    expect(html).not.toContain("invitato");
    expect(html).not.toContain("scade");
    expect(subject).not.toContain("/");
  });

  it("HTML-escapes every string field — no injection surface", () => {
    const maliciousData = {
      batchUrl: 'https://app.operai.welld.io/refund/batches/"><script>alert(1)</script>',
      batchReference: '<img src=x onerror=alert(1)>',
      cutoff: baseData.cutoff,
      generatedAt: baseData.generatedAt,
      requestCount: 3,
    };

    const { html, subject } = renderEmailTemplate({
      template: "refund_batch_compiled",
      data: maliciousData,
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(subject).not.toContain("<img src=x onerror=alert(1)>");
    // Escaped forms are present instead
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("falls back to the escaped raw string for an unparseable date (defense-in-depth)", () => {
    const { html } = renderEmailTemplate({
      template: "refund_batch_compiled",
      data: { ...baseData, cutoff: "<not-a-date>" },
    });

    expect(html).toContain("&lt;not-a-date&gt;");
  });
});

describe("renderEmailTemplate — invitation family (regression)", () => {
  it("invitation still renders bilingual copy with the invite link and expiry", () => {
    const { subject, html } = renderEmailTemplate({
      template: "invitation",
      data: {
        inviteUrl: "https://auth.operai.welld.io/invite?id=inv_1&token=abc",
        inviterName: "Admin",
        expiresAt: "2026-07-16T10:00:00Z",
      },
    });

    expect(subject).toContain("invited");
    expect(html).toContain("https://auth.operai.welld.io/invite?id=inv_1&amp;token=abc");
    expect(html).toContain("invitato");
  });

  it("invitation_resend still renders its own copy", () => {
    const { subject } = renderEmailTemplate({
      template: "invitation_resend",
      data: {
        inviteUrl: "https://auth.operai.welld.io/invite?id=inv_1&token=abc",
        inviterName: "Admin",
        expiresAt: "2026-07-16T10:00:00Z",
      },
    });

    expect(subject).toContain("renewed");
  });
});

// ─── Decision emails (specs/20260716-refund-service AC-3.6, email channel) ──────

describe("renderEmailTemplate — refund_decision_approved", () => {
  const baseData = {
    requestUrl: "https://app.operai.welld.io/refund/requests/req_123",
    decidedAt: "2026-09-08T10:00:00Z",
    approvedTotals: [
      { currency: "CHF", amountCents: 215600 },
      { currency: "EUR", amountCents: 12624 },
    ],
  };

  it("renders the outcome, the deep link and one formatted figure per currency", () => {
    const { html, subject } = renderEmailTemplate({
      template: "refund_decision_approved",
      data: baseData,
    });

    expect(subject.toLowerCase()).toContain("approved");
    expect(html).toContain(baseData.requestUrl);
    expect(html).toContain("approved");
    // Integer minor units render as ISO code + comma decimal, the SAME shape
    // batches/pdf.ts uses — an employee comparing mail to PDF sees one format.
    expect(html).toContain("CHF 2156,00");
    expect(html).toContain("EUR 126,24");
  });

  it("renders cents below 10 with a leading zero (2156,05 not 2156,5)", () => {
    const { html } = renderEmailTemplate({
      template: "refund_decision_approved",
      data: { ...baseData, approvedTotals: [{ currency: "CHF", amountCents: 215605 }] },
    });

    expect(html).toContain("CHF 2156,05");
  });

  it("renders a whole-franc amount with explicit ,00 rather than bare units", () => {
    const { html } = renderEmailTemplate({
      template: "refund_decision_approved",
      data: { ...baseData, approvedTotals: [{ currency: "CHF", amountCents: 700 }] },
    });

    expect(html).toContain("CHF 7,00");
  });

  it("escapes every interpolated field (no injection surface, ADR 20260714-notify-api-email-channel-service-trust posture)", () => {
    const { html } = renderEmailTemplate({
      template: "refund_decision_approved",
      data: {
        ...baseData,
        requestUrl: 'https://x.test/"><script>alert(1)</script>',
        approvedTotals: [{ currency: '<img src=x onerror=1>', amountCents: 100 }],
      },
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;");
  });

  it("is English-only, and carries no attachment/presigned-URL concept", () => {
    const { html } = renderEmailTemplate({
      template: "refund_decision_approved",
      data: baseData,
    });

    expect(html.toLowerCase()).not.toContain("attachment");
    expect(html.toLowerCase()).not.toContain("presigned");
    expect(html.toLowerCase()).not.toContain("x-amz");
    expect(html.toLowerCase()).not.toContain("rimbors");
  });
});

describe("renderEmailTemplate — refund_decision_rejected", () => {
  const baseData = {
    requestUrl: "https://app.operai.welld.io/refund/requests/req_456",
    decidedAt: "2026-09-08T10:00:00Z",
  };

  it("renders the outcome and the deep link", () => {
    const { html, subject } = renderEmailTemplate({
      template: "refund_decision_rejected",
      data: baseData,
    });

    expect(subject.toLowerCase()).toContain("rejected");
    expect(html).toContain(baseData.requestUrl);
    expect(html).toContain("rejected");
  });

  // The rejected template has no money field at all, by shape (emails.schemas.ts) —
  // this pins that the RENDERER never invents one either. A rejected request has
  // nothing approved, so any figure in this mail would be a lie.
  it("carries no monetary figure whatsoever", () => {
    const { html } = renderEmailTemplate({
      template: "refund_decision_rejected",
      data: baseData,
    });

    expect(html).not.toMatch(/\b(CHF|EUR|USD|GBP)\b/);
    expect(html).not.toMatch(/\d+,\d{2}/);
  });

  // Deliberate product decision: the motivation stays behind sign-in rather
  // than being copied into an inbox that may outlive the employee's access.
  it("does not carry the rejection motivation — it points at the app instead", () => {
    const { html } = renderEmailTemplate({
      template: "refund_decision_rejected",
      data: baseData,
    });

    expect(html.toLowerCase()).not.toContain("motivation");
    expect(html).toContain(baseData.requestUrl);
  });
});

describe("renderEmailTemplate — notification_notice (specs/20261101-crm-notifications, ADR 20261101-notify-api-resolves-email-notice-address-from-auth)", () => {
  const data = {
    title: "Estimate requested",
    body: "Acme asked for an estimate on Big deal.",
    originApp: "crm",
    appBaseUrl: "https://operai.example.test",
    href: "/crm/deals/d_1",
  };

  it("uses the notification title as the subject", () => {
    expect(renderEmailTemplate({ template: "notification_notice", data }).subject).toBe(
      "Estimate requested",
    );
  });

  it("renders title, body, an absolute 'Open in Operai' link and the origin footer", () => {
    const { html } = renderEmailTemplate({ template: "notification_notice", data });
    expect(html).toContain("Estimate requested");
    expect(html).toContain("Acme asked for an estimate on Big deal.");
    expect(html).toContain('href="https://operai.example.test/crm/deals/d_1"');
    expect(html).toContain("Open in Operai");
    expect(html).toContain("Sent by Operai CRM");
  });

  it("labels the projects origin in the footer (specs/20261110-activities T24)", () => {
    const { html } = renderEmailTemplate({
      template: "notification_notice",
      data: { ...data, originApp: "projects", href: "/projects/p_1" },
    });
    expect(html).toContain("Sent by Operai Projects");
  });

  it("links to the app base URL alone when there is no link, tolerating a trailing slash", () => {
    const { html } = renderEmailTemplate({
      template: "notification_notice",
      data: { ...data, href: undefined, appBaseUrl: "https://operai.example.test/" },
    });
    expect(html).toContain('href="https://operai.example.test"');
  });

  it("escapes title, body and link, and keeps line breaks out of the subject", () => {
    const { subject, html } = renderEmailTemplate({
      template: "notification_notice",
      data: {
        ...data,
        title: '<script>alert(1)</script>\r\nBcc: x@y.z',
        body: '"><img src=x onerror=alert(1)>',
        href: '/crm/"><b>',
      },
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it("names the Projects tool in the footer for the projects origin (specs/20261103-projects-handoff)", () => {
    const { html } = renderEmailTemplate({
      template: "notification_notice",
      data: { ...data, originApp: "projects", href: "/projects/handoff" },
    });
    expect(html).toContain("Sent by Operai Projects");
  });

  it("names no tool in the footer for an unknown origin app", () => {
    const { html } = renderEmailTemplate({
      template: "notification_notice",
      data: { ...data, originApp: "nope" },
    });
    expect(html).toContain("Sent by Operai<");
  });
});

// Bidi override (RLO) + isolate (LRI): the characters a spoofed author address would carry past the schema.
const CTL = String.fromCodePoint(0x202e, 0x2066);

describe("renderEmailTemplate — legal_entity_change (specs/20261117-legal-entities T57, AC-9.11-9.13, design.md N1)", () => {
  const BASE_URL = "https://operai.example.test";
  const winter = {
    entity: "welld_ch" as const,
    action: "save" as const,
    restoredFrom: null,
    actorEmail: "anna.rossi@welld.ch" as string | null,
    storedAt: "2026-11-17T09:12:00.000Z",
    version: 8,
    protectedChanged: ["iban" as const],
    otherChanged: ["contacts.en" as const],
    iban: { old: { state: "tail" as const, last4: "5957" }, new: { state: "none" as const } },
  };
  // The paragraph of lines inside the frame: from the first sentence to the end of its <p>.
  const noticeLines = (html: string): string =>
    /<p [^>]*>((?:Change saved by|Version \d+ restored by)[\s\S]*?)<\/p>/.exec(html)![1]!;
  const render = (overrides: Record<string, unknown> = {}, baseUrl: string = BASE_URL) =>
    renderEmailTemplate(
      { template: "legal_entity_change", data: { ...winter, ...overrides } },
      { appBaseUrl: baseUrl },
    );

  it("renders the design's worked example: subject, heading, one row of lines, note, button and footer", () => {
    const { subject, html } = render();
    expect(subject).toBe("Legal details of WellD CH changed: IBAN");
    // The Operai frame (emailLayout.ts): English document, the heading, then one paragraph of lines.
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/<h1[^>]*>The legal details of WellD CH were changed<\/h1>/);
    expect(noticeLines(html)).toBe(
      [
        "Change saved by the account anna.rossi@welld.ch.",
        "When: 17 November 2026, 10:12 CET (Europe/Zurich).",
        "New version: 8.",
        "Details changed: IBAN.",
        "Old IBAN: …5957.",
        "New IBAN: none.",
        "Also changed: contacts line (English).",
      ].join("<br />"),
    );
    expect(html).toContain(
      ">This message names the details that changed. It does not show their values, except the last four characters of an IBAN.</p>",
    );
    expect(html).toContain(
      ">If you did not expect this change, open the history and restore the previous version if it is wrong. Then tell an administrator.</p>",
    );
    expect(html).toContain(">Open the history of WellD CH</a>");
    expect(html).toContain(">The link asks you to sign in. Only people who may see this history can open it.</p>");
    expect(html).toContain(
      "Sent by Operai Admin. You receive this notice because you may manage this legal entity, you are an administrator, you made the change, or this mailbox is set to receive these notices.",
    );
  });

  it("links to the absolute history of the entity, built from APP_BASE_URL (a trailing slash tolerated, & escaped)", () => {
    expect(render().html).toContain(
      'href="https://operai.example.test/admin/legal-entities?entity=welld_ch&amp;view=history"',
    );
    expect(render({ entity: "welld_it" }, "https://operai.example.test//").html).toContain(
      'href="https://operai.example.test/admin/legal-entities?entity=welld_it&amp;view=history"',
    );
    expect(render({ entity: "welld_it" }).subject).toBe("Legal details of WellD IT changed: IBAN");
  });

  it("a restore in a summer date reads 'Version m restored by …' and CEST", () => {
    const { html } = render({ action: "restore", restoredFrom: 5, storedAt: "2026-07-01T09:12:00Z" });
    expect(html).toContain("Version 5 restored by the account anna.rossi@welld.ch.");
    expect(html).not.toContain("Change saved by");
    expect(html).toContain("When: 1 July 2026, 11:12 CEST (Europe/Zurich).");
  });

  it("the zone abbreviation follows the offset on the date, also across both clock changes and at midnight", () => {
    const when = (iso: string) => formatNoticeWhen(iso);
    expect(when("2026-03-29T00:59:00Z")).toBe("29 March 2026, 01:59 CET (Europe/Zurich)");
    expect(when("2026-03-29T01:00:00Z")).toBe("29 March 2026, 03:00 CEST (Europe/Zurich)");
    expect(when("2026-10-25T00:59:00Z")).toBe("25 October 2026, 02:59 CEST (Europe/Zurich)");
    expect(when("2026-10-25T01:00:00Z")).toBe("25 October 2026, 02:00 CET (Europe/Zurich)");
    expect(when("2026-12-31T23:30:00Z")).toBe("1 January 2027, 00:30 CET (Europe/Zurich)");
    expect(when("2026-12-31T23:30:00-01:00")).toBe("1 January 2027, 01:30 CET (Europe/Zurich)");
    expect(when("2026-11-17T09:12:59Z")).toBe("17 November 2026, 10:12 CET (Europe/Zurich)");
  });

  it("IBAN tokens: none, set (no character) and a tail; the lines are left out unless the IBAN changed", () => {
    const set = render({ iban: { old: { state: "set" }, new: { state: "tail", last4: "A1B2" } } }).html;
    expect(set).toContain("Old IBAN: set (not shown).");
    expect(set).toContain("New IBAN: …A1B2.");
    const none = render({ iban: { old: { state: "none" }, new: { state: "set" } } }).html;
    expect(none).toContain("Old IBAN: none.");
    expect(none).toContain("New IBAN: set (not shown).");
    const noIban = render({ protectedChanged: ["legalName", "vatNumber"], iban: undefined }).html;
    expect(noIban).not.toContain("IBAN:");
    expect(noIban).toContain("Details changed: legal name and VAT number.");
  });

  it("lists names in the closed order whatever order they arrive in: 'a, b and c'; no 'Also changed' line when none", () => {
    const { subject, html } = render({
      protectedChanged: ["iban", "legalName", "vatNumber"],
      otherChanged: ["contacts.it", "address.it", "address.en", "contacts.en"],
    });
    expect(subject).toBe("Legal details of WellD CH changed: legal name, VAT number and IBAN");
    expect(html).toContain("Details changed: legal name, VAT number and IBAN.");
    expect(html).toContain(
      "Also changed: address (Italian), address (English), contacts line (Italian) and contacts line (English).",
    );
    expect(render({ otherChanged: [] }).html).not.toContain("Also changed");
  });

  it("every line is a whole sentence ending in a full stop", () => {
    const { html } = render({ otherChanged: ["address.it", "contacts.en"] });
    const sentences = noticeLines(html).split("<br />");
    expect(sentences).toHaveLength(7);
    for (const line of sentences) {
      expect(line).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("prints the author address as escaped text: a hostile local part is neutralised, no markup survives", () => {
    const hostile = `<script>alert(1)</script>"&'@example.test`;
    const { html } = render({ actorEmail: hostile });
    expect(html).not.toContain("<script>");
    expect(html).toContain(
      "Change saved by the account &lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;&#39;@example.test.",
    );
    expect(html).not.toContain(hostile);
  });

  it("strips controls and bidi characters a direct caller might pass (the schema refuses them before)", () => {
    const { html } = render({
      actorEmail: `${CTL}a${String.fromCodePoint(0x200b)}b\r\n\t${String.fromCodePoint(0)}@example.test${String.fromCodePoint(0x2028)}`,
    });
    expect(html).toContain("Change saved by the account ab@example.test.");
    expect([...html].filter((ch) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(ch) && ch !== "\n")).toEqual([]);
  });

  it("no mailto: link and no anchor around the address, in any case; the address is in the body once and never in the subject", () => {
    for (const overrides of [
      {},
      { action: "restore", restoredFrom: 5 },
      { actorEmail: null },
      { actorEmail: "a".repeat(64) + "@" + "b".repeat(63) + ".example.test" },
    ] as Record<string, unknown>[]) {
      const { subject, html } = render(overrides);
      expect(html.toLowerCase()).not.toContain("mailto");
      // The only link in the message is the history button.
      expect(html.match(/<a /g)).toHaveLength(1);
      const address = "actorEmail" in overrides ? overrides["actorEmail"] : winter.actorEmail;
      if (typeof address === "string") {
        expect(html.split(address)).toHaveLength(2);
        expect(subject).not.toContain(address);
        expect(subject).not.toContain("@");
      }
      expect(subject).toBe("Legal details of WellD CH changed: IBAN");
    }
  });

  it("an author with no address on record says so, for a save and for a restore; no name fallback", () => {
    const save = render({ actorEmail: null }).html;
    expect(noticeLines(save).startsWith("Change saved by an account with no email address on record.<br />")).toBe(true);
    expect(save).not.toContain("unnamed");
    expect(save).not.toContain("Anna");
    const restore = render({ actorEmail: null, action: "restore", restoredFrom: 5 }).html;
    expect(restore).toContain("Version 5 restored by an account with no email address on record.");
    expect(restore).not.toContain("Change saved by");
    // Every other line is unchanged.
    expect(save).toContain("New version: 8.");
  });

  it("an address that is nothing but controls reads as no address on record, never as a name", () => {
    expect(render({ actorEmail: `${String.fromCodePoint(0x202e)}${String.fromCodePoint(0)}` }).html).toContain(
      "Change saved by an account with no email address on record.",
    );
  });

  it("a 320-character address is printed whole, once, in a body far under the 2000 limit of the notice", () => {
    const longest = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(63)}.test`.slice(0, 320);
    const { html } = render({ actorEmail: longest });
    expect(html.split(longest)).toHaveLength(2);
  });

  it("refuses to render without APP_BASE_URL (the route answers `not_configured` before)", () => {
    expect(() => renderEmailTemplate({ template: "legal_entity_change", data: winter })).toThrow();
  });

  it("carries no value but the two IBAN tails: no full IBAN, name, VAT number or address, even from a fat sender", () => {
    const FULL_OLD = "CH9300762011623852957";
    const FULL_NEW = "DE89370400440532013000";
    const values = [FULL_OLD, FULL_NEW, "Acme Treuhand AG", "CHE-123.456.789", "Bahnhofstrasse 1", "info@acme.example"];
    const fat = {
      ...winter,
      protectedChanged: ["legalName", "vatNumber", "iban"],
      otherChanged: ["address.it", "contacts.en"],
      iban: { old: { state: "tail", last4: FULL_OLD.slice(-4) }, new: { state: "tail", last4: FULL_NEW.slice(-4) } },
      // What a careless sender might add; the template has no slot for any of it.
      oldLegalName: values[2], newVatNumber: values[3], address: values[4], contacts: values[5], oldIban: FULL_OLD, newIban: FULL_NEW,
    };
    const { subject, html } = renderEmailTemplate(
      { template: "legal_entity_change", data: fat as never },
      { appBaseUrl: BASE_URL },
    );
    for (const v of values) {
      expect(subject).not.toContain(v);
      expect(html).not.toContain(v);
    }
    expect(html).toContain("Old IBAN: …2957.");
    expect(html).toContain("New IBAN: …3000.");
  });
});
