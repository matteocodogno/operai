/**
 * The four built-in summary templates (specs/021-meetings AC-8.1, AC-8.6; plan.md
 * § Data model). They live in CODE, not in the table: nothing to seed, nothing a user or
 * a migration can edit, and an id that is stable across environments. Read-only by
 * construction - every view is a copy, and the CRUD routes refuse a `builtin:` id.
 *
 * Names, headings and instructions exist in English and Italian. A summary in a language
 * snapshots the built-in in THAT language (`builtinSnapshot`), so its headings read in the
 * output language (AC-8.6); the server renders headings from the snapshot, never from
 * model output (ADR-0067).
 */

export type TemplateLanguage = "en" | "it";

/** AC-8.2's limits, shared by the built-ins and the CRUD routes (a duplicate of a built-in is always valid). */
export const TEMPLATE_LIMITS = {
  name: 80,
  /** Sections per template, at least 1. */
  sections: 15,
  heading: 80,
  instruction: 500,
  generalInstructions: 2000,
} as const;

export interface TemplateSection {
  heading: string;
  instruction: string;
}

export interface BuiltinTemplate {
  readonly id: string;
  readonly name: Readonly<Record<TemplateLanguage, string>>;
  readonly sections: Readonly<Record<TemplateLanguage, readonly TemplateSection[]>>;
  readonly generalInstructions: Readonly<Record<TemplateLanguage, string | null>>;
}

/** What a summary keeps of its template (`summary.template`, AC-7.5). */
export interface TemplateSnapshot {
  readonly source: "builtin" | "shared" | "personal";
  readonly templateId: string;
  readonly name: string;
  readonly sections: readonly TemplateSection[];
  readonly generalInstructions: string | null;
}

const GENERAL = {
  en: "Write plain prose and short lists in the output language. State only what the transcript says; never invent names, figures, dates or decisions. Attribute a statement to a speaker only when the transcript makes it clear who said it.",
  it: "Scrivi in prosa semplice e con brevi elenchi nella lingua richiesta. Riporta solo ciò che dice la trascrizione; non inventare nomi, cifre, date o decisioni. Attribuisci una frase a chi parla solo quando la trascrizione lo rende chiaro.",
} as const;

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    id: "builtin:minutes",
    name: { en: "Meeting minutes", it: "Verbale della riunione" },
    sections: {
      en: [
        { heading: "Summary", instruction: "Two to four sentences on what the meeting was about and how it ended." },
        { heading: "Topics discussed", instruction: "The main topics in the order they came up, each with the key points made." },
        { heading: "Decisions", instruction: "Each decision that was taken, one per line, with who agreed to it if the transcript says." },
        { heading: "Action items", instruction: "Each task agreed, one per line: what, who owns it and the due date, when stated." },
        { heading: "Open questions", instruction: "Questions or issues left unresolved that need a follow-up." },
      ],
      it: [
        { heading: "Riepilogo", instruction: "Da due a quattro frasi su di cosa si è parlato e come si è conclusa la riunione." },
        { heading: "Argomenti trattati", instruction: "Gli argomenti principali nell'ordine in cui sono emersi, con i punti chiave di ciascuno." },
        { heading: "Decisioni", instruction: "Ogni decisione presa, una per riga, indicando chi era d'accordo se la trascrizione lo dice." },
        { heading: "Azioni da svolgere", instruction: "Ogni compito concordato, uno per riga: cosa, chi se ne occupa e la scadenza, se indicata." },
        { heading: "Questioni aperte", instruction: "Domande o problemi rimasti irrisolti che richiedono un seguito." },
      ],
    },
    generalInstructions: GENERAL,
  },
  {
    id: "builtin:sales-discovery",
    name: { en: "Sales discovery call", it: "Chiamata di discovery commerciale" },
    sections: {
      en: [
        { heading: "Customer and context", instruction: "Who the customer is, their business and why they are talking to us now." },
        { heading: "Needs and pain points", instruction: "What the customer wants to achieve and what is not working today, in their own terms." },
        { heading: "Current solution", instruction: "What they use today, who runs it and what they like or dislike about it." },
        { heading: "Budget and timeline", instruction: "Any figure, budget range, deadline or milestone mentioned, exactly as stated." },
        { heading: "Decision process", instruction: "Who decides, who influences, and the steps and criteria of the decision." },
        { heading: "Objections and risks", instruction: "Concerns raised, competitors named and anything that could stop the deal." },
        { heading: "Next steps", instruction: "What each side committed to do next, with dates when stated." },
      ],
      it: [
        { heading: "Cliente e contesto", instruction: "Chi è il cliente, la sua attività e perché ci parla proprio ora." },
        { heading: "Esigenze e criticità", instruction: "Cosa vuole ottenere il cliente e cosa oggi non funziona, con le sue parole." },
        { heading: "Soluzione attuale", instruction: "Cosa usa oggi, chi la gestisce e cosa gli piace o non gli piace." },
        { heading: "Budget e tempistiche", instruction: "Cifre, fasce di budget, scadenze o traguardi citati, esattamente come detti." },
        { heading: "Processo decisionale", instruction: "Chi decide, chi influenza, e i passaggi e i criteri della decisione." },
        { heading: "Obiezioni e rischi", instruction: "Dubbi sollevati, concorrenti citati e tutto ciò che potrebbe bloccare l'opportunità." },
        { heading: "Prossimi passi", instruction: "Cosa si è impegnata a fare ciascuna parte, con le date se indicate." },
      ],
    },
    generalInstructions: GENERAL,
  },
  {
    id: "builtin:one-on-one",
    name: { en: "1:1", it: "1:1" },
    sections: {
      en: [
        { heading: "Topics discussed", instruction: "The subjects covered, in the order they came up, with the key points." },
        { heading: "Progress and wins", instruction: "What went well and what was completed since the last conversation." },
        { heading: "Challenges and blockers", instruction: "What is difficult, blocked or worrying, and what support was asked for." },
        { heading: "Feedback", instruction: "Feedback given in either direction, kept to what was actually said." },
        { heading: "Goals and development", instruction: "Goals, growth topics and career points raised." },
        { heading: "Action items", instruction: "What each person agreed to do before the next conversation." },
      ],
      it: [
        { heading: "Argomenti discussi", instruction: "I temi affrontati, nell'ordine in cui sono emersi, con i punti chiave." },
        { heading: "Progressi e risultati", instruction: "Cosa è andato bene e cosa è stato completato dall'ultimo colloquio." },
        { heading: "Difficoltà e blocchi", instruction: "Cosa è difficile, bloccato o preoccupante, e quale supporto è stato richiesto." },
        { heading: "Feedback", instruction: "Il feedback dato in entrambe le direzioni, limitato a ciò che è stato detto davvero." },
        { heading: "Obiettivi e crescita", instruction: "Obiettivi, temi di crescita e questioni di carriera emersi." },
        { heading: "Azioni da svolgere", instruction: "Cosa si è impegnata a fare ciascuna persona prima del prossimo colloquio." },
      ],
    },
    generalInstructions: GENERAL,
  },
  {
    id: "builtin:action-items",
    name: { en: "Action items", it: "Azioni da intraprendere" },
    sections: {
      en: [
        { heading: "Action items", instruction: "Every task that was agreed, one per line: what has to be done, who owns it and the due date when stated." },
        { heading: "Decisions to follow up", instruction: "Decisions whose consequences still need someone to act on them." },
        { heading: "Open questions", instruction: "Questions raised and not answered, with who was asked, when known." },
      ],
      it: [
        { heading: "Azioni da intraprendere", instruction: "Ogni compito concordato, uno per riga: cosa va fatto, chi se ne occupa e la scadenza, se indicata." },
        { heading: "Decisioni da seguire", instruction: "Decisioni le cui conseguenze richiedono ancora che qualcuno agisca." },
        { heading: "Questioni aperte", instruction: "Domande sollevate e rimaste senza risposta, con la persona interpellata quando nota." },
      ],
    },
    generalInstructions: GENERAL,
  },
];

export const builtinIds = (): string[] => BUILTIN_TEMPLATES.map((t) => t.id);

const find = (id: string): BuiltinTemplate | undefined => BUILTIN_TEMPLATES.find((t) => t.id === id);

export interface BuiltinView {
  id: string;
  name: string;
  sections: TemplateSection[];
  generalInstructions: string | null;
}

/** A built-in in one language, as a COPY: the caller may do what it likes with it. */
export function builtinView(id: string, language: TemplateLanguage): BuiltinView | undefined {
  const template = find(id);
  if (!template) return undefined;
  return {
    id: template.id,
    name: template.name[language],
    sections: template.sections[language].map((s) => ({ ...s })),
    generalInstructions: template.generalInstructions[language],
  };
}

/** The snapshot a summary generated from a built-in keeps, in the summary's language (AC-7.5, AC-8.6). */
export function builtinSnapshot(id: string, language: TemplateLanguage): TemplateSnapshot | undefined {
  const view = builtinView(id, language);
  if (!view) return undefined;
  return { source: "builtin", templateId: view.id, name: view.name, sections: view.sections, generalInstructions: view.generalInstructions };
}

/** `it` or `en` from an `Accept-Language` header: the best acceptable of the two, English by default. */
export function parseAcceptLanguage(header: string | undefined): TemplateLanguage {
  let best: { language: TemplateLanguage; q: number } | null = null;
  for (const part of (header ?? "").split(",")) {
    const [tag = "", ...params] = part.trim().split(";");
    const primary = tag.trim().toLowerCase().split("-")[0];
    if (primary !== "it" && primary !== "en") continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    if (!Number.isFinite(q) || q <= 0) continue;
    if (best === null || q > best.q) best = { language: primary, q };
  }
  return best?.language ?? "en";
}
