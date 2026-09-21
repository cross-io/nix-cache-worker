import type { ScheduledController, ExecutionContext } from "@cloudflare/workers-types";
import { app } from "./app";
import type { WorkerEnv } from "./env";
import { runQueuedJobs, scheduleGcJob } from "./jobs/jobs";
import { cleanupExpiredNarinfoReservations } from "./routes/narinfo";
import { now } from "./storage/db";
import { cleanupUploadSessions } from "./storage/uploads";

async function scheduleGarbageCollection(env: WorkerEnv): Promise<void> {
  await cleanupUploadSessions(env, 100);
  await cleanupExpiredNarinfoReservations(env);
  await scheduleGcJob(env, "cron", { scheduledAt: now() });
  await runQueuedJobs(env, 4);
}

const worker = {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    await scheduleGarbageCollection(env);
  },
};

export default worker;
