/**
 * Fixed, escaped templates for the internal email channel (T3,
 * specs/20260713-user-invitations, plan.md "Resend + i18n + failure", ADR 20260714-notify-api-email-channel-service-trust).
 *
 * `invitation`/`invitation_resend` are bilingual (IT + EN, in ONE email) —
 * the invitee has no User row and thus no locale preference. CLAUDE.md's
 * i18n rule ("the tool will need Italian and English at minimum") and
 * AC-2.1 ("offered in both Italian and English") are satisfied by rendering
 * both languages in a single message rather than guessing one.
 *
 * `refund_batch_compiled` (T7, specs/20260719-refund-monthly-processing,
 * ADR 20260719-refund-batch-signed-link-email-delivery) is deliberately **English-only** — the refund suite's v1 has no
 * Italian copy anywhere (spec 008 Non-goals) — and carries an **in-app deep
 * link**, never an attachment or a raw presigned URL: the recipient must
 * sign in and pass the same authz check as any other in-app batch view
 * before the PDF itself is ever reachable (AC-3.5).
 *
 * SECURITY (fixed templates, no injection surface — ADR 20260714-notify-api-email-channel-service-trust Risks / plan.md
 * Security "template injection"): the only variable inputs are each
 * template's own `data.*` fields (the destination `to` is never
 * interpolated into the body at all). Every one is HTML-escaped before
 * interpolation — there is no free-form admin-supplied subject/body and no
 * reply-to field derived from user input, so there is nothing here for an
 * attacker to smuggle markup or headers through.
 */

import {
  badge,
  button,
  divider,
  escapeHtml,
  facts,
  heading,
  languageTag,
  lines,
  link,
  paragraph,
  renderFrame,
  strong,
} from "./emailLayout";

// Every template renders into the Operai frame (emailLayout.ts): the ink header with the wordmark, a light card, one
// button and a footer. The frame and its blocks escape every text they are given; a template passes caller data only
// as text, never as markup.

export type InvitationTemplateData = {
  inviteUrl: string;
  inviterName: string;
  expiresAt: string; // ISO 8601 — validated at the zod boundary (emails.schemas.ts)
};

/**
 * refund-api's `data` shape for `refund_batch_compiled` (T7,
 * specs/20260719-refund-monthly-processing, plan.md §Email, ADR 20260719-refund-batch-signed-link-email-delivery).
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

/**
 * refund-api's `data` shapes for the two decision emails (specs/20260716-refund-
 * service AC-3.6, email-channel extension). `requestUrl` is an in-app deep
 * link (`<REFUND_APP_BASE_URL>/refund/requests/<id>`), same posture as
 * `batchUrl`. `approvedTotals` arrives as integer minor units and is
 * formatted here at render time — refund-api owns money COMPUTATION
 * (ADR 20260720-mileage-rate-money-precision-integer-micros's round-exactly-once rule), this owns its presentation, the same
 * split `refund_batch_compiled` already uses for `cutoff`/`requestCount`.
 */
export type RefundDecisionApprovedTemplateData = {
  requestUrl: string;
  decidedAt: string; // ISO 8601 — validated at the zod boundary (emails.schemas.ts)
  approvedTotals: readonly { currency: string; amountCents: number }[];
};

export type RefundDecisionRejectedTemplateData = {
  requestUrl: string;
  decidedAt: string; // ISO 8601 — validated at the zod boundary (emails.schemas.ts)
};

/**
 * `notification_notice` (specs/20261101-crm-notifications, ADR 20261101-notify-api-resolves-email-notice-address-from-auth). Unlike every
 * template above, this one is not a caller-supplied `data` shape: notify-api
 * builds it from the notification it just stored, so it is reachable only
 * from POST /system/notifications and never from /system/emails (where the
 * caller names the address). `appBaseUrl` is notify-api's own APP_BASE_URL;
 * `href` is the notification's `link.href`, already guarded as a relative
 * in-suite path (notifications.schemas.ts).
 */
export type NotificationNoticeTemplateData = {
  title: string;
  body: string;
  originApp: string;
  appBaseUrl: string;
  href?: string | undefined;
};

/**
 * `legal_entity_change` (specs/20261117-legal-entities T57, AC-9.11-9.13, design.md N1; plan "Amendment 2026-11-17
 * after security review" G5). The shape is the zod `data` (emails.schemas.ts) and is closed: the only values it can
 * carry are an entity, an action, two version numbers, the author's account email, a timestamp, names from two closed sets and
 * an IBAN token whose longest member is four characters.
 */
export type LegalEntityIbanToken =
  | { state: "none" }
  | { state: "set" }
  | { state: "tail"; last4: string };

export type LegalEntityChangeTemplateData = {
  entity: "welld_it" | "welld_ch";
  action: "save" | "restore";
  restoredFrom: number | null;
  /** The author's account email as recorded (zod: an address, at most 320 characters) or null. Never a display name. */
  actorEmail: string | null;
  storedAt: string; // ISO 8601 — validated at the zod boundary
  version: number;
  protectedChanged: readonly ("legalName" | "vatNumber" | "iban")[];
  otherChanged: readonly ("address.it" | "address.en" | "contacts.it" | "contacts.en")[];
  iban?: { old: LegalEntityIbanToken; new: LegalEntityIbanToken } | undefined;
};

export type RenderedEmail = { subject: string; html: string };

export type EmailTemplateName =
  | "invitation"
  | "invitation_resend"
  | "refund_batch_compiled"
  | "refund_decision_approved"
  | "refund_decision_rejected"
  | "notification_notice"
  | "legal_entity_change";

/**
 * An ISO datetime in the suite's format, `dd.mm.yyyy HH:mm UTC` (the server knows no reader time zone, so it says
 * which one it uses). Returns TEXT: the blocks escape it. The input is zod-validated as ISO 8601 at the route
 * boundary; the fallback (the raw input, escaped by the block) is defence in depth if that ever changes.
 */
const formatIsoDate = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getUTCDate())}.${two(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
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
  const expiresAt = formatIsoDate(data.expiresAt);
  const copy = INVITATION_COPY[template];

  // Both languages in one card (the invitee has no account and so no language): Italian first, then English.
  const html = renderFrame({
    lang: "it",
    title: copy.subject,
    preheader: copy.introEn(data.inviterName),
    body: [
      heading(template === "invitation" ? "Benvenuto in Operai · Welcome to Operai" : "Il tuo invito è stato rinnovato · Your invitation was renewed"),
      languageTag("Italiano"),
      paragraph(copy.introIt(data.inviterName)),
      button(data.inviteUrl, copy.ctaIt),
      paragraph(`Il link scade il ${expiresAt}.`, { muted: true, small: true }),
      divider(),
      languageTag("English"),
      paragraph(copy.introEn(data.inviterName)),
      button(data.inviteUrl, copy.ctaEn),
      paragraph(`This link expires on ${expiresAt}.`, { muted: true, small: true }),
    ],
    footer: [
      "Se non ti aspettavi questo invito, puoi ignorare questa email.",
      "If you did not expect this invitation, you can ignore this email.",
    ],
  });

  return { subject: copy.subject, html };
};

/**
 * `refund_batch_compiled` (T7, specs/20260719-refund-monthly-processing,
 * plan.md §Email, ADR 20260719-refund-batch-signed-link-email-delivery) — English-only. Body carries the in-app deep
 * link (`batchUrl`) as the sole call to action; no PDF/attachment/presigned
 * URL anywhere in the template (ADR 20260719-refund-batch-signed-link-email-delivery Non-goal).
 */
const renderRefundBatchCompiled = (
  data: RefundBatchCompiledTemplateData,
): RenderedEmail => {
  // The reference is escaped in the subject as it always was: a subject is shown by mail clients that may render it.
  const subject = `Refund batch compiled — ${escapeHtml(data.batchReference)}`;
  // requestCount is zod-validated as a non-negative integer (emails.schemas.ts).
  const html = renderFrame({
    lang: "en",
    title: `Refund batch compiled — ${data.batchReference}`,
    preheader: `Batch ${data.batchReference} is ready with ${data.requestCount} request(s).`,
    tool: "Refund",
    body: [
      heading("Refund batch compiled"),
      paragraph(["Refund batch ", strong(data.batchReference), " has been compiled and is ready for payment."]),
      facts([
        ["Batch", data.batchReference],
        ["Requests", String(data.requestCount)],
        ["Cutoff", formatIsoDate(data.cutoff)],
        ["Generated", formatIsoDate(data.generatedAt)],
      ]),
      button(data.batchUrl, "Open the batch in Operai"),
      paragraph("Sign-in is required to view the batch and download the compiled PDF.", { muted: true, small: true }),
    ],
    footer: ["Sent by Operai Refund to the accounting distribution address."],
  });

  return { subject, html };
};

/**
 * Money presentation for the decision emails: integer minor units in, an
 * ISO-code + comma-decimal string out ("CHF 2156,00").
 *
 * Mirrors refund-api's own PDF renderer (`batches/pdf.ts`'s `formatAmount`)
 * character-for-character ON PURPOSE, so an employee comparing the email
 * against the compiled PDF sees the same figure written the same way. This
 * is presentation only — it never rounds, because it never receives anything
 * to round: `amountCents` is already the exact integer refund-api computed
 * under ADR 20260720-mileage-rate-money-precision-integer-micros's round-exactly-once rule.
 *
 * `currency` is zod-bound to the four supported codes and `amountCents` to an
 * integer (emails.schemas.ts). The result is TEXT: the block it lands in escapes
 * it, so the currency is still escaped rather than trusting a boundary two files away.
 */
const formatMinorUnits = (amountCents: number, currency: string): string => {
  const negative = amountCents < 0;
  const abs = Math.abs(amountCents);
  const whole = Math.trunc(abs / 100);
  const decimals = (abs % 100).toString().padStart(2, "0");
  return `${currency} ${negative ? "-" : ""}${whole},${decimals}`;
};

/**
 * `refund_decision_approved` (specs/20260716-refund-service AC-3.6) — English-only,
 * matching `refund_batch_compiled` rather than the bilingual invitation
 * family: an employee HAS a User row and a suite locale, so guessing a
 * language in the mail body would contradict the app they are about to open.
 * Both languages in one body is the invitation family's answer to a
 * recipient with no account; that reasoning does not transfer here.
 *
 * Carries the approved figure inline (one line per currency) so the outcome
 * is legible from the inbox, plus the deep link for everything else.
 */
const renderRefundDecisionApproved = (
  data: RefundDecisionApprovedTemplateData,
): RenderedEmail => {
  const subject = "Your expense request was approved";
  const totals = data.approvedTotals.map((t) => formatMinorUnits(t.amountCents, t.currency));
  const html = renderFrame({
    lang: "en",
    title: subject,
    preheader: `Approved total: ${totals.join(", ")}`,
    tool: "Refund",
    tone: "success",
    body: [
      badge("Approved", "success"),
      heading("Your expense request was approved"),
      paragraph(["Your expense reimbursement request was ", strong("approved"), "."]),
      facts([
        ["Approved total", lines(totals)],
        ["Decided", formatIsoDate(data.decidedAt)],
      ]),
      button(data.requestUrl, "Open the request in Operai"),
      paragraph("Sign-in is required to view the request.", { muted: true, small: true }),
    ],
    footer: ["Sent by Operai Refund."],
  });

  return { subject, html };
};

/**
 * `refund_decision_rejected` (specs/20260716-refund-service AC-3.6) — English-only,
 * same reasoning as the approved variant.
 *
 * Deliberately carries NO amount (nothing was approved) and NO rejection
 * motivation: the motivation stays behind sign-in in the app rather than
 * being copied into an inbox that may outlive the employee's access. The
 * mail's job is to make the decision impossible to miss and point at the
 * detail.
 */
const renderRefundDecisionRejected = (
  data: RefundDecisionRejectedTemplateData,
): RenderedEmail => {
  const subject = "Your expense request was rejected";
  const html = renderFrame({
    lang: "en",
    title: subject,
    preheader: "Open the request in Operai to see the reason.",
    tool: "Refund",
    tone: "danger",
    body: [
      badge("Rejected", "danger"),
      heading("Your expense request was rejected"),
      paragraph(["Your expense reimbursement request was ", strong("rejected"), "."]),
      facts([["Decided", formatIsoDate(data.decidedAt)]]),
      button(data.requestUrl, "Open the request in Operai"),
      paragraph(
        ["See the reason in the request and, if appropriate, submit a corrected one. ", link(data.requestUrl, "Open the request"), "."],
        { muted: true, small: true },
      ),
      paragraph("Sign-in is required to view the request.", { muted: true, small: true }),
    ],
    footer: ["Sent by Operai Refund."],
  });

  return { subject, html };
};

/** originApp -> the tool's display name for the footer. An unknown app gets a bare "Sent by Operai". */
const ORIGIN_APP_LABELS: Readonly<Record<string, string>> = {
  estimai: "EstimAI",
  refund: "Refund",
  admin: "Admin",
  inventory: "Inventory",
  crm: "CRM",
  projects: "Projects",
};

/**
 * `notification_notice` — English-only (specs/20261101-crm-notifications D-5), the email twin of an
 * in-app notification: the title, the body text, one button back into Operai
 * and a footer naming the origin tool. No per-event fields, so one fixed,
 * escaped template serves every tool.
 */
const renderNotificationNotice = (
  data: NotificationNoticeTemplateData,
): RenderedEmail => {
  const originLabel = ORIGIN_APP_LABELS[data.originApp];
  const sentBy = originLabel ? `Sent by Operai ${originLabel}` : "Sent by Operai";
  const url = `${data.appBaseUrl.replace(/\/+$/, "")}${data.href ?? ""}`;

  // The subject is the plain title; line breaks are stripped so it can never
  // add a header line.
  const subject = data.title.replace(/[\r\n]+/g, " ");

  const html = renderFrame({
    lang: "en",
    title: subject,
    preheader: data.body,
    tool: originLabel,
    body: [heading(data.title), paragraph(data.body), button(url, "Open in Operai")],
    footer: [sentBy, "You receive this email because the notification asked for one. The same notification is in Operai."],
  });

  return { subject, html };
};

// ─── legal_entity_change (T57) ───────────────────────────────────────────────

const LEGAL_ENTITY_LABELS = { welld_it: "WellD IT", welld_ch: "WellD CH" } as const;
const PROTECTED_LABELS = { legalName: "legal name", vatNumber: "VAT number", iban: "IBAN" } as const;
const OTHER_LABELS = {
  "address.it": "address (Italian)",
  "address.en": "address (English)",
  "contacts.it": "contacts line (Italian)",
  "contacts.en": "contacts line (English)",
} as const;
// The closed orders a notice lists names in (design.md N1), whatever order the caller sent them in.
const PROTECTED_ORDER = ["legalName", "vatNumber", "iban"] as const;
const OTHER_ORDER = ["address.it", "address.en", "contacts.it", "contacts.en"] as const;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const NOTICE_TIME_ZONE = "Europe/Zurich";
const zurichParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: NOTICE_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

/**
 * `17 November 2026, 10:12 CET (Europe/Zurich)` (design.md N1, DR-15): the stored instant in Europe/Zurich, day
 * without a leading zero, 24-hour time without seconds. The abbreviation is derived from the zone's offset on that
 * instant — CET at +01:00, CEST at +02:00 — never from `Intl`'s short name, which is "GMT+1" in many locales.
 */
export const formatNoticeWhen = (iso: string): string => {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  const parts = zurichParts.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  const [year, month, day, hour, minute, second] = [
    part("year"), part("month"), part("day"), part("hour"), part("minute"), part("second"),
  ] as [number, number, number, number, number, number];
  // The wall clock read as if it were UTC, minus the true instant (cut to the whole second), is the zone's offset.
  const offsetMinutes = Math.round(
    (Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(instant.getTime() / 1000) * 1000) / 60000,
  );
  const abbreviation =
    offsetMinutes === 60 ? "CET" : offsetMinutes === 120 ? "CEST" : `UTC${offsetMinutes >= 0 ? "+" : "-"}${Math.abs(offsetMinutes / 60)}`;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return `${day} ${MONTHS[month - 1]} ${year}, ${time} ${abbreviation} (${NOTICE_TIME_ZONE})`;
};

/** Controls (Cc), format characters (Cf: bidi marks, embeddings, isolates, zero-width) and the line/paragraph separators. */
const stripControlsAndBidi = (value: string): string =>
  value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();

/** `a`, `a and b`, `a, b and c`. */
const joinNames = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

const ibanTokenText = (token: LegalEntityIbanToken): string =>
  token.state === "none" ? "none" : token.state === "set" ? "set (not shown)" : `…${token.last4}`;

const renderLegalEntityChange = (
  data: LegalEntityChangeTemplateData,
  appBaseUrl: string,
): RenderedEmail => {
  const entity = LEGAL_ENTITY_LABELS[data.entity];
  const protectedNames = PROTECTED_ORDER.filter((n) => data.protectedChanged.includes(n)).map((n) => PROTECTED_LABELS[n]);
  const otherNames = OTHER_ORDER.filter((n) => data.otherChanged.includes(n)).map((n) => OTHER_LABELS[n]);
  const details = joinNames(protectedNames);
  // Closed values only: the subject can never hold a line break or a value (design.md N1, `email.subject`).
  const subject = `Legal details of ${entity} changed: ${details}`;

  // D9 (design.md N1): the author is named by the account's email, as escaped text and never as a link, and never
  // by a name. With no address (null) the sentence says so; nothing falls back to a name. The zod boundary already
  // refuses controls and blanks; stripping again keeps a direct caller from smuggling a line break into the body.
  const author = data.actorEmail === null ? "" : stripControlsAndBidi(data.actorEmail);
  const isRestore = data.action === "restore" && data.restoredFrom !== null;
  const byAction =
    author === ""
      ? isRestore
        ? `Version ${data.restoredFrom} restored by an account with no email address on record.`
        : "Change saved by an account with no email address on record."
      : isRestore
        ? `Version ${data.restoredFrom} restored by the account ${escapeHtml(author)}.`
        : `Change saved by the account ${escapeHtml(author)}.`;

  // Every line is a whole sentence ending in a full stop. Values already escaped or closed; the IBAN token holds
  // `…` and four characters of [A-Z0-9] (zod) and is escaped regardless.
  const lines = [
    byAction,
    `When: ${escapeHtml(formatNoticeWhen(data.storedAt))}.`,
    `New version: ${data.version}.`,
    `Details changed: ${details}.`,
  ];
  if (data.iban !== undefined && data.protectedChanged.includes("iban")) {
    lines.push(`Old IBAN: ${escapeHtml(ibanTokenText(data.iban.old))}.`);
    lines.push(`New IBAN: ${escapeHtml(ibanTokenText(data.iban.new))}.`);
  }
  if (otherNames.length > 0) lines.push(`Also changed: ${joinNames(otherNames)}.`);

  const url = escapeHtml(
    `${appBaseUrl.replace(/\/+$/, "")}/admin/legal-entities?entity=${data.entity}&view=history`,
  );

  const html = [
    '<div lang="en" style="font-family: sans-serif; line-height: 1.6; color: #1a1a1a;">',
    `<p><strong>The legal details of ${entity} were changed</strong></p>`,
    `<p>${lines.join("<br>\n")}</p>`,
    "<p>This message names the details that changed. It does not show their values, except the last four characters of an IBAN.</p>",
    "<p>If you did not expect this change, open the history and restore the previous version if it is wrong. Then tell an administrator.</p>",
    `<p><a href="${url}" style="display: inline-block; padding: 8px 16px; background: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 4px;">Open the history of ${entity}</a></p>`,
    "<p>The link asks you to sign in. Only people who may see this history can open it.</p>",
    '<p style="color: #666666; font-size: 12px;">Sent by Operai Admin. You receive this notice because you may manage this legal entity, you are an administrator, you made the change, or this mailbox is set to receive these notices.</p>',
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
  | { template: "refund_batch_compiled"; data: RefundBatchCompiledTemplateData }
  | { template: "refund_decision_approved"; data: RefundDecisionApprovedTemplateData }
  | { template: "refund_decision_rejected"; data: RefundDecisionRejectedTemplateData }
  | { template: "notification_notice"; data: NotificationNoticeTemplateData }
  | { template: "legal_entity_change"; data: LegalEntityChangeTemplateData };

/** What a render may need beyond the request itself. */
export type RenderContext = {
  /** notify-api's own APP_BASE_URL: the link of `legal_entity_change` is built from it, never from the caller. */
  appBaseUrl?: string | undefined;
};

export const renderEmailTemplate = (
  request: EmailTemplateRequest,
  context: RenderContext = {},
): RenderedEmail => {
  switch (request.template) {
    case "legal_entity_change":
      if (context.appBaseUrl === undefined) throw new Error("legal_entity_change needs APP_BASE_URL");
      return renderLegalEntityChange(request.data, context.appBaseUrl);
    case "refund_batch_compiled":
      return renderRefundBatchCompiled(request.data);
    case "refund_decision_approved":
      return renderRefundDecisionApproved(request.data);
    case "refund_decision_rejected":
      return renderRefundDecisionRejected(request.data);
    case "notification_notice":
      return renderNotificationNotice(request.data);
    case "invitation":
    case "invitation_resend":
      return renderInvitation(request.template, request.data);
  }
};
