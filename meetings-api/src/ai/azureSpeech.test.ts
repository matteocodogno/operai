import { describe, expect, it } from "bun:test";
import { createAzureTranscriber } from "./azureSpeech";
import { TranscriptionError } from "./transcriber";

// plan.md § AI providers: Azure AI Speech fast transcription, one locale, diarization on.
// The network is a stubbed fetch; the real service is never called (AC-4.9).

interface Seen {
  url: string;
  headers: Headers;
  definition: Record<string, unknown>;
  audio: unknown;
  redirect: string | undefined;
}

const AUDIO = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" });

function stub(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as FormData;
    const entry: Seen = {
      url: String(url),
      headers: new Headers(init?.headers),
      definition: JSON.parse(String(body.get("definition"))),
      audio: body.get("audio"),
      redirect: init?.redirect,
    };
    seen.push(entry);
    // Like the real fetch: an aborted signal rejects a call that is still waiting.
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      Promise.resolve(respond(entry)).then(resolve, reject);
    });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ok = (phrases: unknown[]) => json({ durationMilliseconds: 9_000, combinedPhrases: [{ text: "x" }], phrases });
const phrase = (speaker: number | undefined, offsetMilliseconds: number, text: string) => ({
  speaker,
  offsetMilliseconds,
  durationMilliseconds: 1_000,
  text,
  locale: "it-IT",
});

const make = (respond: Parameters<typeof stub>[0], extra: Partial<Parameters<typeof createAzureTranscriber>[0]> = {}) => {
  const { seen, fetchImpl } = stub(respond);
  return { seen, transcriber: createAzureTranscriber({ region: "westeurope", key: "k-secret-123", fetchImpl, ...extra }) };
};

async function failure(run: Promise<unknown>): Promise<TranscriptionError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptionError);
    return error as TranscriptionError;
  }
  throw new Error("expected a TranscriptionError");
}

describe("the request", () => {
  it("posts the audio and a definition with ONE locale and diarization on", async () => {
    const { seen, transcriber } = make(() => ok([phrase(1, 0, "ciao")]));
    await transcriber.transcribe(AUDIO, "it-IT", 4);
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.url).toBe("https://westeurope.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15");
    expect(request.headers.get("Ocp-Apim-Subscription-Key")).toBe("k-secret-123");
    expect(request.definition).toEqual({ locales: ["it-IT"], diarization: { enabled: true, maxSpeakers: 4 } });
    expect((request.audio as File).size).toBe(3);
    expect(request.redirect).toBe("error");
  });

  it("uses en-US for English, and nothing else is accepted (AC-13.2: never auto-detect)", async () => {
    const { seen, transcriber } = make(() => ok([phrase(1, 0, "hello")]));
    await transcriber.transcribe(AUDIO, "en-US", 2);
    expect(seen[0]!.definition["locales"]).toEqual(["en-US"]);

    for (const locale of ["fr-FR", "it", "en-GB", "", "it-IT,en-US"]) {
      const before = seen.length;
      const error = await failure(transcriber.transcribe(AUDIO, locale as never, 2));
      expect(error.transient).toBe(false);
      expect(seen).toHaveLength(before); // refused before any network call
    }
  });

  it("clamps maxSpeakers to the provider's 2 to 35", async () => {
    const { seen, transcriber } = make(() => ok([phrase(1, 0, "a")]));
    for (const asked of [-3, 0, 1, 2, 35, 36, 999, 4.9, Number.NaN]) await transcriber.transcribe(AUDIO, "en-US", asked);
    const sent = seen.map((s) => (s.definition["diarization"] as { maxSpeakers: number }).maxSpeakers);
    expect(sent).toEqual([2, 2, 2, 2, 35, 35, 35, 4, 2]);
  });

  it("derives the host from the region, or honours the configured endpoint", async () => {
    const a = make(() => ok([phrase(1, 0, "a")]), { region: "italynorth" });
    await a.transcriber.transcribe(AUDIO, "it-IT", 2);
    expect(new URL(a.seen[0]!.url).host).toBe("italynorth.api.cognitive.microsoft.com");

    const b = make(() => ok([phrase(1, 0, "a")]), { endpoint: "https://westeurope.stt.speech.microsoft.com/" });
    await b.transcriber.transcribe(AUDIO, "it-IT", 2);
    expect(b.seen[0]!.url).toStartWith("https://westeurope.stt.speech.microsoft.com/speechtotext/transcriptions:transcribe?");
  });
});

describe("the answer", () => {
  it("maps phrases to segments with speaker labels by first appearance (AC-6.2)", async () => {
    const { transcriber } = make(() => ok([phrase(2, 0, "buongiorno"), phrase(1, 3_000, "salve"), phrase(2, 6_000, "iniziamo")]));
    const outcome = await transcriber.transcribe(AUDIO, "it-IT", 3);
    expect(outcome).toEqual({
      kind: "segments",
      segments: [
        { ordinal: 0, startMs: 0, endMs: 1_000, speakerKey: "s1", text: "buongiorno" },
        { ordinal: 1, startMs: 3_000, endMs: 4_000, speakerKey: "s2", text: "salve" },
        { ordinal: 2, startMs: 6_000, endMs: 7_000, speakerKey: "s1", text: "iniziamo" },
      ],
    });
  });

  it("gives one voice one label, also when the provider sends no speaker at all", async () => {
    const { transcriber } = make(() => ok([phrase(undefined, 0, "a"), phrase(undefined, 2_000, "b")]));
    const outcome = await transcriber.transcribe(AUDIO, "en-US", 2);
    expect(outcome.kind === "segments" && outcome.segments.map((s) => s.speakerKey)).toEqual(["s1", "s1"]);
  });

  it("reports noSpeech for zero phrases, or phrases with no text (AC-6.7)", async () => {
    for (const body of [{ phrases: [] }, { combinedPhrases: [], phrases: [] }, { phrases: [phrase(1, 0, "  ")] }, {}]) {
      const { transcriber } = make(() => json(body));
      expect(await transcriber.transcribe(AUDIO, "en-US", 2)).toEqual({ kind: "noSpeech" });
    }
  });
});

describe("failures", () => {
  const fails = async (status: number, body: unknown = { error: { message: "secret provider text k-secret-123" } }) => {
    const { transcriber } = make(() => json(body, status));
    return failure(transcriber.transcribe(AUDIO, "it-IT", 2));
  };

  it("a 4xx is permanent: the same bytes would be refused again", async () => {
    for (const status of [400, 401, 403, 404, 415, 422]) {
      const error = await fails(status);
      expect(error.transient, String(status)).toBe(false);
      expect(error.status).toBe(status);
    }
  });

  it("maps the permanent statuses to the closed failure codes", async () => {
    expect((await fails(400)).code).toBe("audio_unreadable");
    expect((await fails(415)).code).toBe("audio_unreadable");
    expect((await fails(413)).code).toBe("too_long");
    expect((await fails(401)).code).toBe("provider_rejected");
    expect((await fails(403)).code).toBe("provider_rejected");
  });

  it("429, 408 and every 5xx are transient", async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const error = await fails(status);
      expect(error.transient, String(status)).toBe(true);
      expect(error.code).toBe("provider_unavailable");
    }
  });

  it("a timeout is transient, and the request is really cut off", async () => {
    const { transcriber } = make(() => new Promise<Response>(() => {}), { timeoutMs: 20 });
    // the stub never answers: only the abort signal can end it
    const error = await failure(transcriber.transcribe(AUDIO, "it-IT", 2));
    expect(error.transient).toBe(true);
    expect(error.code).toBe("provider_unavailable");
  });

  it("a network error is transient", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const t = createAzureTranscriber({ region: "westeurope", key: "k", fetchImpl });
    expect((await failure(t.transcribe(AUDIO, "it-IT", 2))).transient).toBe(true);
  });

  it("a caller's abort ends the call without waiting for the provider", async () => {
    const controller = new AbortController();
    const { transcriber } = make(() => new Promise<Response>(() => {}));
    const pending = failure(transcriber.transcribe(AUDIO, "it-IT", 2, controller.signal));
    controller.abort();
    expect((await pending).transient).toBe(true);
  });

  it("a 200 that is not the expected JSON is transient, not 'no speech'", async () => {
    for (const make200 of [
      () => new Response("<html>gateway</html>", { status: 200 }),
      () => json({ phrases: "nope" }),
      () => json({ phrases: [{ text: 5 }] }),
      () => json([]),
    ]) {
      const { transcriber } = make(make200);
      const error = await failure(transcriber.transcribe(AUDIO, "it-IT", 2));
      expect(error.transient).toBe(true);
    }
  });

  it("never puts provider text, the key or the host in an error", async () => {
    const error = await fails(500);
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("k-secret-123");
    expect(JSON.stringify(error)).not.toContain("k-secret-123");
  });
});
