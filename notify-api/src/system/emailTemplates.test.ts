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
