import { task } from "@trigger.dev/sdk";
import { createSupabaseDeletionStore, runDeletionCleanup } from "../server/deletion";
import { createAdminSupabaseClient } from "../server/supabase";
import { CLEANUP_TASK_ID } from "./dispatch";

export function validateCleanupPayload(payload: unknown): { readonly deletionId: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload) || typeof (payload as { jobId?: unknown }).jobId !== "string" || (payload as { schemaVersion?: unknown }).schemaVersion !== 1) throw new Error("Invalid cleanup payload");
  return { deletionId: (payload as { jobId: string }).jobId };
}

export const cleanupTask = task({
  id: CLEANUP_TASK_ID,
  maxDuration: 300,
  run: async (payload: unknown) => runDeletionCleanup(createSupabaseDeletionStore(createAdminSupabaseClient()), validateCleanupPayload(payload).deletionId),
});
