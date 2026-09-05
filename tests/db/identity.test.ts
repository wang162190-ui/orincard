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
    const [sql, policyTests] = await Promise.all([
      readFile(definitionPath, "utf8"),
      readFile(policyTestPath, "utf8"),
    ]);
    expect(sql).toContain("comment on table public.profiles");
    expect(sql.match(/comment on column public\.profiles\./g)).toHaveLength(6);
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on table public.profiles from anon, authenticated");
    expect(sql).toContain("grant select on table public.profiles to authenticated");
    expect(sql).toContain(
      "grant update (display_name, preferences) on table public.profiles to authenticated",
    );
    expect(sql).toMatch(/for update[\s\S]+using \([\s\S]+with check \(/);
    expect(sql).toMatch(
      /function private\.create_profile_for_auth_user\(\)[\s\S]+security definer[\s\S]+set search_path = ''/,
    );
    expect(sql).toContain(
      "revoke execute on function private.create_profile_for_auth_user() from public, anon, authenticated",
    );
    expect(policyTests).toContain("set local role anon");
    expect(policyTests).toContain("an owner cannot read another profile");
    expect(policyTests).toContain("a deleting account cannot read its workspace profile");
    expect(policyTests).toContain("select * from finish(true)");
  });
});

describe.runIf(process.env.RUN_DB_TESTS === "1")(
  "identity policies in the development cloud database",
  () => {
    it("passes the real pgTAP owner and account-state suite", () => {
      const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
      const productionRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF?.trim();
      if (
        process.env.APP_ENV !== "development" ||
        !projectRef ||
        (productionRef && projectRef === productionRef)
      ) {
        throw new Error("Database tests require an isolated development project ref");
      }

      for (const args of [
        [
          "db",
          "query",
          "--linked",
          "--project-ref",
          projectRef,
          "--file",
          definitionPath,
        ],
        [
          "test",
          "db",
          "--linked",
          "--project-ref",
          projectRef,
          policyTestPath,
        ],
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
