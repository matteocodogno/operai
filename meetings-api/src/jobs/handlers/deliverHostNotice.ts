import { PermanentJobError, type JobHandler } from "../runner";

/**
 * STUB (specs/021-meetings T20). The `deliver_host_notice` handler delivers an
 * `unlinked` / `deleted` host notice until it is delivered (backoff 1 m, 5 m, 30 m, 2 h,
 * then every 6 h), through the host client.
 *
 * Until T20 replaces this body, a job of this kind fails at once with the closed code
 * `not_implemented` rather than pretending to succeed or retrying for ever.
 */
export const deliverHostNotice: JobHandler = async () => {
  throw new PermanentJobError("not_implemented");
};
