/**
 * Unit tests for renderEmailTemplate (T7, specs/008-refund-monthly-processing,
 * plan.md §Email, ADR-0021), covering the new `refund_batch_compiled`
 * template — deep link + batch reference render, every field is
 * HTML-escaped (no injection surface, ADR-0011 posture reused), the shape is
 * fixed (English-only, no attachment/PDF/presigned-URL content) — and a
 * regression check that the existing `invitation`/`invitation_resend`
 * templates are unaffected by the refactor to a single correlated
 * `{template, data}` parameter.
 */

import { describe, expect, it } from "bun:test";
import { renderEmailTemplate } from "./emailTemplates";

describe("renderEmailTemplate — refund_batch_compiled (T7, ADR-0021)", () => {
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

// ─── Decision emails (specs/007-refund-service AC-3.6, email channel) ──────

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

  it("escapes every interpolated field (no injection surface, ADR-0011 posture)", () => {
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
