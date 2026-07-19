/**
 * Fixed, escaped templates for the internal email channel (T3,
 * specs/006-user-invitations, plan.md "Resend + i18n + failure", ADR-0011).
 *
 * `invitation`/`invitation_resend` are bilingual (IT + EN, in ONE email) —
 * the invitee has no User row and thus no locale preference. CLAUDE.md's
 * i18n rule ("the tool will need Italian and English at minimum") and
 * AC-2.1 ("offered in both Italian and English") are satisfied by rendering
 * both languages in a single message rather than guessing one.
 *
 * `refund_batch_compiled` (T7, specs/008-refund-monthly-processing,
 * ADR-0021) is deliberately **English-only** — the refund suite's v1 has no
 * Italian copy anywhere (spec 008 Non-goals) — and carries an **in-app deep
 * link**, never an attachment or a raw presigned URL: the recipient must
 * sign in and pass the same authz check as any other in-app batch view
 * before the PDF itself is ever reachable (AC-3.5).
 *
 * SECURITY (fixed templates, no injection surface — ADR-0011 Risks / plan.md
 * Security "template injection"): the only variable inputs are each
 * template's own `data.*` fields (the destination `to` is never
 * interpolated into the body at all). Every one is HTML-escaped before
 * interpolation — there is no free-form admin-supplied subject/body and no
 * reply-to field derived from user input, so there is nothing here for an
 * attacker to smuggle markup or headers through.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);

export type InvitationTemplateData = {
  inviteUrl: string;
  inviterName: string;
  expiresAt: string; // ISO 8601 — validated at the zod boundary (emails.schemas.ts)
};

/**
 * refund-api's `data` shape for `refund_batch_compiled` (T7,
 * specs/008-refund-monthly-processing, plan.md §Email, ADR-0021).
 * `batchUrl` is an in-app deep link (`<REFUND_APP_BASE_URL>/refund/batches/<id>`)
 * — never a storage/presigned URL — and `requestCount` is a plain integer
 * (nothing to escape); every other field is a string, escaped like any other
 * template input.
 */
export type RefundBatchCompiledTemplateData = {
  batchUrl: string;
  batchReference: string;
  cutoff: string; // ISO 8601 — validated at the zod boundary (emails.schemas.ts)
  generatedAt: string; // ISO 8601 — validated at the zod boundary (emails.schemas.ts)
  requestCount: number;
};

export type RenderedEmail = { subject: string; html: string };

export type EmailTemplateName =
  | "invitation"
  | "invitation_resend"
  | "refund_batch_compiled";

/**
 * Renders an ISO datetime as an escaped, human-legible ISO string. The input
 * is already zod-validated as an ISO 8601 datetime at the route boundary
 * before this is called, but the fallback (echoing the raw escaped input
 * rather than "Invalid Date") is deliberate defense-in-depth if that ever
 * changes.
 */
const formatIsoDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return escapeHtml(date.toISOString());
};

/** Copy per invitation-family template variant — kept in one place so IT/EN always ship together. */
const INVITATION_COPY: Record<
  "invitation" | "invitation_resend",
  {
    subject: string;
    introIt: (inviterName: string) => string;
    introEn: (inviterName: string) => string;
    ctaIt: string;
    ctaEn: string;
  }
> = {
  invitation: {
    subject:
      "Sei stato invitato a Operai / You've been invited to Operai",
    introIt: (inviterName) =>
      `${inviterName} ti ha invitato a unirti a Operai, il toolsuite di wellD.`,
    introEn: (inviterName) =>
      `${inviterName} has invited you to join Operai, wellD's internal toolsuite.`,
    ctaIt: "Accedi con Google o GitHub per accettare l'invito",
    ctaEn: "Continue with Google or GitHub to accept the invitation",
  },
  invitation_resend: {
    subject:
      "Nuovo link di invito Operai / Your Operai invite link has been renewed",
    introIt: (inviterName) =>
      `${inviterName} ha rinnovato il tuo invito a Operai — il link precedente non è più valido.`,
    introEn: (inviterName) =>
      `${inviterName} has renewed your Operai invitation — the previous link is no longer valid.`,
    ctaIt: "Accedi con Google o GitHub per accettare l'invito",
    ctaEn: "Continue with Google or GitHub to accept the invitation",
  },
};

const renderInvitation = (
  template: "invitation" | "invitation_resend",
  data: InvitationTemplateData,
): RenderedEmail => {
  const inviteUrl = escapeHtml(data.inviteUrl);
  const inviterName = escapeHtml(data.inviterName);
  const expiresAt = formatIsoDate(data.expiresAt);
  const copy = INVITATION_COPY[template];

  const html = [
    '<div style="font-family: sans-serif; line-height: 1.6; color: #1a1a1a;">',
    `<p>${copy.introIt(inviterName)}</p>`,
    `<p><a href="${inviteUrl}">${copy.ctaIt}</a></p>`,
    `<p>Il link scade il ${expiresAt}.</p>`,
    "<hr />",
    `<p>${copy.introEn(inviterName)}</p>`,
    `<p><a href="${inviteUrl}">${copy.ctaEn}</a></p>`,
    `<p>This link expires on ${expiresAt}.</p>`,
    "</div>",
  ].join("\n");

  return { subject: copy.subject, html };
};

/**
 * `refund_batch_compiled` (T7, specs/008-refund-monthly-processing,
 * plan.md §Email, ADR-0021) — English-only. Body carries the in-app deep
 * link (`batchUrl`) as the sole call to action; no PDF/attachment/presigned
 * URL anywhere in the template (ADR-0021 Non-goal).
 */
const renderRefundBatchCompiled = (
  data: RefundBatchCompiledTemplateData,
): RenderedEmail => {
  const batchUrl = escapeHtml(data.batchUrl);
  const batchReference = escapeHtml(data.batchReference);
  const cutoff = formatIsoDate(data.cutoff);
  const generatedAt = formatIsoDate(data.generatedAt);
  // requestCount is zod-validated as a non-negative integer (emails.schemas.ts)
  // — a plain number, nothing to HTML-escape.
  const requestCount = data.requestCount;

  const subject = `Refund batch compiled — ${batchReference}`;

  const html = [
    '<div style="font-family: sans-serif; line-height: 1.6; color: #1a1a1a;">',
    `<p>Refund batch <strong>${batchReference}</strong> has been compiled (cutoff ${cutoff}, generated ${generatedAt}) with ${requestCount} request(s).</p>`,
    `<p><a href="${batchUrl}">Open the batch in Operai</a></p>`,
    "<p>Sign-in is required to view the batch and download the compiled PDF.</p>",
    "</div>",
  ].join("\n");

  return { subject, html };
};

/**
 * A single correlated `{template, data}` pair per template — deliberately
 * ONE parameter (not two) so a discriminated-union caller (emails.routes.ts
 * passing `c.req.valid("json")` straight through) keeps the compiler's
 * template↔data correlation intact. Splitting `template`/`data` into two
 * separate parameters would let TypeScript widen each independently and
 * silently accept a mismatched pairing (e.g. `refund_batch_compiled` with
 * invitation `data`) — this shape makes that a compile error instead.
 */
export type EmailTemplateRequest =
  | { template: "invitation"; data: InvitationTemplateData }
  | { template: "invitation_resend"; data: InvitationTemplateData }
  | { template: "refund_batch_compiled"; data: RefundBatchCompiledTemplateData };

export const renderEmailTemplate = (request: EmailTemplateRequest): RenderedEmail => {
  switch (request.template) {
    case "refund_batch_compiled":
      return renderRefundBatchCompiled(request.data);
    case "invitation":
    case "invitation_resend":
      return renderInvitation(request.template, request.data);
  }
};
