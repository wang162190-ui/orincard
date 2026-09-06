import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL(
  "../../supabase/migrations/20260906050000_server_rpc_wrappers.sql",
  import.meta.url,
);

describe("server-only Data API RPC wrappers", () => {
  it("keeps private transaction functions hidden behind service-role-only public RPCs", async () => {
    const sql = await readFile(migration, "utf8");

    for (const name of [
      "server_create_project",
      "server_save_project",
      "server_submit_job",
      "server_request_job_cancellation",
      "server_mark_job_dispatched",
      "server_claim_job_retry",
    ]) {
      expect(sql).toContain(`function public.${name}`);
      expect(sql).toContain(`comment on function public.${name}`);
      expect(sql).toMatch(
        new RegExp(
          `revoke execute on function public\\.${name}\\([\\s\\S]+?from public, anon, authenticated`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `grant execute on function public\\.${name}\\([\\s\\S]+?to service_role`,
        ),
      );
    }

    expect(sql).not.toContain("grant usage on schema private to anon");
    expect(sql).not.toContain("grant usage on schema private to authenticated");
    expect(sql).toMatch(
      /function public\.server_create_project\([\s\S]+?p_idempotency_key text,[\s\S]+?p_request_hash text[\s\S]+?returns jsonb/,
    );
    expect(sql).toContain("operation_name := 'create_project'");
  });
});
