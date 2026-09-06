import { schedules } from "@trigger.dev/sdk";
import {
  createSupabaseJobStore,
  reconcileJobs,
  triggerRunController,
} from "../server/jobs";
import { createAdminSupabaseClient } from "../server/supabase";
import { triggerDispatcher } from "./dispatch";

const STALE_AFTER_MS = 5 * 60 * 1_000;

export const reconcileJobsTask = schedules.task({
  id: "orincard-reconcile-jobs",
  cron: "*/5 * * * *",
  maxDuration: 60,
  run: async () => {
    const before = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    return reconcileJobs(
      createSupabaseJobStore(createAdminSupabaseClient()),
      triggerRunController,
      triggerDispatcher,
      before,
    );
  },
});
