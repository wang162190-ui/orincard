import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const definitionPath = fileURLToPath(
  new URL("../../supabase/definitions/identity.sql", import.meta.url),
);
const policyTestPath = fileURLToPath(
  new URL("../../supabase/tests/identity.sql", import.meta.url),
);

describe("identity database definition", () => {
  it("declares comments, explicit grants and complete owner RLS", async () => {
    const sql = await readFile(definitionPath, "utf8");
    expect(sql).toContain("comment on table public.profiles");
    expect(sql.match(/comment on column public\.profiles\./g)).toHaveLength(6);
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on table public.profiles from anon, authenticated");
    expect(sql).toContain("grant select on table public.profiles to authenticated");
    expect(sql).toMatch(/for update[\s\S]+using \([\s\S]+with check \(/);
  });
});

describe.runIf(process.env.RUN_DB_TESTS === "1")(
  "identity policies in the development cloud database",
  () => {
    it("passes the real pgTAP owner and account-state suite", () => {
      const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
      const productionRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF?.trim();
      if (!projectRef || !productionRef || projectRef === productionRef) {
        throw new Error("Database tests require distinct development and production project refs");
      }

      for (const args of [
        ["db", "query", "--project-ref", projectRef, "--file", definitionPath],
        ["test", "db", "--project-ref", projectRef, policyTestPath],
      ]) {
        const result = spawnSync("pnpm", ["exec", "supabase", ...args], {
          cwd: fileURLToPath(new URL("../..", import.meta.url)),
          encoding: "utf8",
        });
        if (result.status !== 0) {
          throw new Error(`Supabase CLI database check failed:\n${result.stderr}`);
        }
      }
    });
  },
);
