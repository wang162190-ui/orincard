import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("T059 deletion database permissions", () => {
  it("keeps deletion RPCs service-only and covers owner isolation with pgTAP", async () => {
    const [definition, tests] = await Promise.all([
      readFile(new URL("../../supabase/definitions/deletion.sql", import.meta.url), "utf8"),
      readFile(new URL("../../supabase/tests/deletion.sql", import.meta.url), "utf8"),
    ]);
    expect(definition).toContain("alter table public.deletion_requests enable row level security");
    expect(definition).toMatch(/revoke execute on function public\.server_request_project_deletion[\s\S]+grant execute[\s\S]+to service_role/);
    expect(definition).toMatch(/revoke execute on function public\.server_request_account_deletion[\s\S]+grant execute[\s\S]+to service_role/);
    expect(tests).toContain("another owner cannot request project deletion");
    expect(tests).toContain("owner cannot read a deleting project");
    expect(tests).toContain("select * from finish(true)");
  });
});
