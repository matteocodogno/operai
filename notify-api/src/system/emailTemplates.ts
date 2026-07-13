/**
 * Bilingual (IT + EN, in ONE email) templates for the internal email channel
 * (T3, specs/006-user-invitations, plan.md "Resend + i18n + failure",
 * ADR-0011). The invitee has no User row and thus no locale preference —
 * CLAUDE.md's i18n rule ("the tool will need Italian and English at
 * minimum") and AC-2.1 ("offered in both Italian and English") are satisfied
 * by rendering both languages in a single message rather than guessing one.
 *
 * SECURITY (fixed templates, no injection surface — ADR-0011 Risks / plan.md
 * Security "template injection"): the only variable inputs are `inviteUrl`,
 * `inviterName`, and `expiresAt` (the destination `to` is not interpolated
 * into the body at all). Every one is HTML-escaped before interpolation —
 * there is no free-form admin-supplied subject/body and no reply-to field
 * derived from user input, so there is nothing here for an attacker to smuggle
 * markup or headers through.
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

export type RenderedEmail = { subject: string; html: string };

export type EmailTemplateName = "invitation" | "invitation_resend";

/**
 * Renders `expiresAt` as an escaped, human-legible ISO string. `expiresAt` is
 * already zod-validated as an ISO 8601 datetime at the route boundary before
 * this is called, but the fallback (echoing the raw escaped input rather than
 * "Invalid Date") is deliberate defense-in-depth if that ever changes.
 */
const formatExpiry = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return escapeHtml(date.toISOString());
};

/** Copy per template variant — kept in one place so IT/EN always ship together. */
const COPY: Record<
  EmailTemplateName,
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

export const renderEmailTemplate = (
  template: EmailTemplateName,
  data: InvitationTemplateData,
): RenderedEmail => {
  const inviteUrl = escapeHtml(data.inviteUrl);
  const inviterName = escapeHtml(data.inviterName);
  const expiresAt = formatExpiry(data.expiresAt);
  const copy = COPY[template];

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
