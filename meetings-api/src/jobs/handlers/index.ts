import { db } from "../../lib/db";
import { env } from "../../lib/env";
import type { JobKind } from "../../lib/generated/prisma/client";
import { createRunner, type JobHandler, type Runner } from "../runner";
import { deliverHostNotice } from "./deliverHostNotice";
import { prepareAudio } from "./prepareAudio";
import { summarize } from "./summarize";
import { transcribe } from "./transcribe";

/** One handler per job kind (ADR-0062). A later task replaces a stub by editing its own file only. */
export const handlers: Record<JobKind, JobHandler> = {
  prepare_audio: prepareAudio,
  transcribe,
  summarize,
  deliver_host_notice: deliverHostNotice,
};

/**
 * Starts the worker loop inside this process (`MEETINGS_WORKER` on or only) with a dedicated
 * LISTEN connection, and drains on SIGTERM: stop claiming, let running work finish within
 * Railway's grace period. Returns `null` when the worker is switched off.
 */
export async function startWorker(): Promise<Runner | null> {
  if (env.MEETINGS_WORKER === "off") return null;
  const runner = createRunner({ db, handlers, listenUrl: env.DATABASE_URL });
  await runner.start();
  process.once("SIGTERM", () => {
    console.log("[jobs] SIGTERM: draining");
    void runner.stop().then(() => process.exit(0));
  });
  return runner;
}
