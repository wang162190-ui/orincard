import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const definitionPath = fileURLToPath(
  new URL("../../supabase/definitions/projects.sql", import.meta.url),
);
const policyTestPath = fileURLToPath(
  new URL("../../supabase/tests/projects.sql", import.meta.url),
);

describe("project database definition", () => {
  it("declares commented owner-isolated projects, immutable versions and CAS RPCs", async () => {
    const [sql, policyTests] = await Promise.all([
      readFile(definitionPath, "utf8"),
      readFile(policyTestPath, "utf8"),
    ]);

    expect(sql.match(/comment on table public\.(projects|project_versions)/g)).toHaveLength(2);
    expect(sql.match(/comment on column public\.projects\./g)).toHaveLength(11);
    expect(sql.match(/comment on column public\.project_versions\./g)).toHaveLength(7);
    expect(sql.match(/enable row level security/g)).toHaveLength(2);
    expect(sql).toContain("grant select on table public.projects, public.project_versions to authenticated");
    expect(sql).toContain("grant usage on schema private to service_role");
    expect(sql).toMatch(/projects_select_own_active[\s\S]+\(select auth\.uid\(\)\) = owner_id/);
    expect(sql).toMatch(/function private\.save_project\([\s\S]+security definer[\s\S]+set search_path = ''/);
    expect(sql).toContain("where id = p_project_id");
    expect(sql).toContain("and revision = p_expected_revision");
    expect(sql).toContain("raise exception using errcode = '40001'");
    expect(sql).toContain("revoke execute on function private.save_project");
    expect(sql).toMatch(/grant execute on function private\.save_project[\s\S]+to service_role/);
    expect(policyTests).toContain("two CAS saves cannot both succeed");
    expect(policyTests).toContain("project versions reject update and delete");
    expect(policyTests).toContain("authenticated clients cannot forge an owner");
    expect(policyTests).toContain("select * from finish(true)");
  });
});

describe.runIf(process.env.RUN_DB_TESTS === "1")(
  "project policies in the isolated development database",
  () => {
    it("passes the real pgTAP project suite", () => {
      const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
      const productionRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF?.trim();
      if (
        process.env.APP_ENV !== "development" ||
        !projectRef ||
        (productionRef && projectRef === productionRef)
      ) {
        throw new Error("Database tests require an isolated development project ref");
      }

      for (const file of [definitionPath, policyTestPath]) {
        const result = spawnSync(
          "pnpm",
          [
            "exec",
            "supabase",
            "db",
            "query",
            "--linked",
            "--project-ref",
            projectRef,
            "--file",
            file,
          ],
          { cwd: root, encoding: "utf8" },
        );
        if (result.status !== 0) {
          throw new Error(`Supabase CLI database check failed:\n${result.stderr}`);
        }
      }
    });
  },
);
