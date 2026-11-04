import { PermanentJobError, type JobHandler } from "../runner";

/**
 * STUB (specs/021-meetings T32). The `transcribe` handler sends `audio.ogg` to the
 * transcriber and stores the segments in one transaction (`ready` / `noSpeech` / `failed`).
 *
 * Until T32 replaces this body, a job of this kind fails at once with the closed code
 * `not_implemented` rather than pretending to succeed or retrying for ever.
 */
export const transcribe: JobHandler = async () => {
  throw new PermanentJobError("not_implemented");
};
