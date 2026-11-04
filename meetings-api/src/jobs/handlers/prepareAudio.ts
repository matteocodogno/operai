import { PermanentJobError, type JobHandler } from "../runner";

/**
 * STUB (specs/021-meetings T30). The `prepare_audio` handler streams the chunks or the
 * uploaded original to a temp dir, normalises it to mono 16 kHz opus with ffmpeg, stores
 * `audio.ogg` and enqueues `transcribe`.
 *
 * Until T30 replaces this body, a job of this kind fails at once with the closed code
 * `not_implemented` rather than pretending to succeed or retrying for ever.
 */
export const prepareAudio: JobHandler = async () => {
  throw new PermanentJobError("not_implemented");
};
