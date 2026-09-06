import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const migrationPath = fileURLToPath(
  new URL("../../supabase/migrations/20260906000100_walking_skeleton.sql", import.meta.url),
);

describe("walking skeleton migration", () => {
  it("is deterministic, complete and restricted to the development project", async () => {
    const prepared = spawnSync(
      "node",
      ["scripts/prepare-migrations.mjs", "--check"],
      { cwd: root, encoding: "utf8" },
    );
    expect(prepared.status, prepared.stderr).toBe(0);

    const [migration, config] = await Promise.all([
      readFile(migrationPath, "utf8"),
      readFile(new URL("../../supabase/config.toml", import.meta.url), "utf8"),
    ]);
    const productionRejected = spawnSync(
      "node",
      ["scripts/prepare-migrations.mjs", "--check"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          SUPABASE_PROJECT_REF: "production-ref",
          SUPABASE_PRODUCTION_PROJECT_REF: "production-ref",
        },
      },
    );
    expect(productionRejected.status).not.toBe(0);
    expect(productionRejected.stderr).toContain("production");
    expect(migration.match(/-- source: supabase\/definitions\//g)).toHaveLength(4);
    expect(migration).toContain("comment on table public.profiles");
    expect(migration).toContain("comment on table public.projects");
    expect(migration).toContain("comment on table public.assets");
    expect(migration).toContain("comment on table public.jobs");
    expect(config).toContain("auto_expose_new_tables = false");
    expect(config).toContain("major_version = 17");
  });
});

describe.runIf(process.env.RUN_DB_MIGRATION_TESTS === "1")(
  "clean local Supabase database",
  () => {
    it("replays the migration and passes every pgTAP suite", () => {
      for (const args of [
        ["db", "reset", "--local", "--no-seed"],
        ["test", "db", "--local", "supabase/tests"],
      ]) {
        const result = spawnSync("pnpm", ["exec", "supabase", ...args], {
          cwd: root,
          encoding: "utf8",
        });
        if (result.status !== 0) {
          throw new Error(`Supabase migration smoke failed:\n${result.stderr}`);
        }
      }
    });
  },
);
