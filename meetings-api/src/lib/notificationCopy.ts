/**
 * The text of every meetings notification, English and Italian (specs/021
 * AC-12.1, AC-12.2, AC-12.5; ADR-0065). notify-api has no per-user language, so
 * the service sends BOTH: `title`/`body` in English and `it: { title, body }`,
 * and notify-ui / the shell's ToastHost pick one from `<html lang>`.
 *
 * What a notification may carry: the meeting title and the outcome, plus (for an
 * added participant) the fixed sentence that the meeting was recorded or
 * transcribed with AI. NEVER transcript, summary or answer text: a function here
 * takes the meeting title and nothing else, so there is no way to pass content.
 *
 * Adding a kind means adding it to `NOTIFICATION_KINDS` AND to both languages:
 * the `Record` types make a missing one a compile error, and the parity test a
 * failing test.
 */

export const NOTIFICATION_KINDS = [
  "participant_added",
  "transcription_done",
  "transcription_failed",
  "summary_done",
  "summary_failed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationLanguage = "en" | "it";
export type NotificationSeverity = "info" | "success" | "warning";

/** notify-api's limits on `POST /system/notifications` (plan.md § auth / notify-api additions). */
export const MAX_TITLE = 200;
export const MAX_BODY = 2000;

interface Copy {
  readonly title: (meetingTitle: string) => string;
  readonly body: (meetingTitle: string) => string;
}

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const catalog: Record<NotificationLanguage, Record<NotificationKind, Copy>> = {
  en: {
    participant_added: {
      title: (t) => `You were added to a meeting: ${t}`,
      body: (t) =>
        `You were added as a participant of "${t}". The meeting was recorded or transcribed with AI. Open it to read the transcript and summaries.`,
    },
    transcription_done: {
      title: (t) => `Transcript ready: ${t}`,
      body: (t) => `The transcript of "${t}" is ready.`,
    },
    transcription_failed: {
      title: (t) => `Transcription failed: ${t}`,
      body: (t) => `The transcript of "${t}" could not be produced. Open the meeting to try again.`,
    },
    summary_done: {
      title: (t) => `Summary ready: ${t}`,
      body: (t) => `Your summary of "${t}" is ready.`,
    },
    summary_failed: {
      title: (t) => `Summary failed: ${t}`,
      body: (t) => `Your summary of "${t}" could not be generated. Open the meeting to try again.`,
    },
  },
  it: {
    participant_added: {
      title: (t) => `Sei stato aggiunto a una riunione: ${t}`,
      body: (t) =>
        `Sei stato aggiunto come partecipante a "${t}". La riunione è stata registrata o trascritta con l'IA. Aprila per leggere la trascrizione e i riassunti.`,
    },
    transcription_done: {
      title: (t) => `Trascrizione pronta: ${t}`,
      body: (t) => `La trascrizione di "${t}" è pronta.`,
    },
    transcription_failed: {
      title: (t) => `Trascrizione non riuscita: ${t}`,
      body: (t) => `Non è stato possibile produrre la trascrizione di "${t}". Apri la riunione per riprovare.`,
    },
    summary_done: {
      title: (t) => `Riassunto pronto: ${t}`,
      body: (t) => `Il tuo riassunto di "${t}" è pronto.`,
    },
    summary_failed: {
      title: (t) => `Riassunto non riuscito: ${t}`,
      body: (t) => `Non è stato possibile generare il tuo riassunto di "${t}". Apri la riunione per riprovare.`,
    },
  },
};

const SEVERITY: Record<NotificationKind, NotificationSeverity> = {
  participant_added: "info",
  transcription_done: "success",
  transcription_failed: "warning",
  summary_done: "success",
  summary_failed: "warning",
};

export interface RenderedNotification {
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly it: { readonly title: string; readonly body: string };
}

/**
 * The meeting title is user-entered (≤ 200 characters), so it is clipped inside the
 * surrounding sentence to keep the result inside notify-api's limits.
 */
export function renderNotification(kind: NotificationKind, meetingTitle: string): RenderedNotification {
  // Clip the inserted title first so the fixed words around it survive, then the whole.
  const t = clip(meetingTitle, 120);
  return {
    severity: SEVERITY[kind],
    title: clip(catalog.en[kind].title(t), MAX_TITLE),
    body: clip(catalog.en[kind].body(t), MAX_BODY),
    it: {
      title: clip(catalog.it[kind].title(t), MAX_TITLE),
      body: clip(catalog.it[kind].body(t), MAX_BODY),
    },
  };
}
