import { PermanentJobError, type JobHandler } from "../runner";

/**
 * STUB (specs/021-meetings T94). The `summarize` handler builds the prompt from the
 * summary's snapshot and the current transcript, validates the output and writes the
 * sections under the summary's attemptId guard.
 *
 * Until T94 replaces this body, a job of this kind fails at once with the closed code
 * `not_implemented` rather than pretending to succeed or retrying for ever.
 */
export const summarize: JobHandler = async () => {
  throw new PermanentJobError("not_implemented");
};
