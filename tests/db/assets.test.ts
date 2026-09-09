import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const definitionPath = fileURLToPath(
  new URL("../../supabase/definitions/assets.sql", import.meta.url),
);
const policyTestPath = fileURLToPath(
  new URL("../../supabase/tests/assets.sql", import.meta.url),
);

describe("asset database definition", () => {
  it("declares commented owner-bound brands, sources, assets and private storage", async () => {
    const [sql, policyTests] = await Promise.all([
      readFile(definitionPath, "utf8"),
      readFile(policyTestPath, "utf8"),
    ]);

    for (const table of ["brand_kits", "assets", "sources", "project_asset_refs", "brand_asset_refs"]) {
      expect(sql).toContain(`comment on table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql.match(/comment on column public\.brand_kits\./g)).toHaveLength(8);
    expect(sql.match(/comment on column public\.assets\./g)).toHaveLength(20);
    expect(sql.match(/comment on column public\.sources\./g)).toHaveLength(11);
    expect(sql.match(/comment on column public\.project_asset_refs\./g)).toHaveLength(6);
    expect(sql.match(/comment on column public\.brand_asset_refs\./g)).toHaveLength(4);
    expect(sql).toMatch(/function private\.enforce_owned_resource_links\([\s\S]+security definer[\s\S]+set search_path = ''/);
    expect(sql).toContain("revoke execute on function private.enforce_owned_resource_links()");
    expect(sql).toContain("create trigger projects_sync_brand_kit_id");
    expect(sql).toContain("requested_brand_id := nullif(new.document #>> '{brandSnapshot,kitId}', '')");
    expect(sql).toContain("where id = requested_brand_id::uuid and owner_id = new.owner_id and state = 'active'");
    expect(sql).toContain("comment on trigger projects_sync_brand_kit_id on public.projects");
    expect(sql).toContain("create policy storage_download_owned_or_referenced_assets");
    expect(sql).toContain("values ('sources', 'sources', false), ('assets', 'assets', false)");
    expect(sql).toContain("on storage.objects for select to authenticated");
    expect(sql).not.toContain("grant insert on table storage.objects");
    expect(policyTests).toContain("cross-account project asset references are rejected");
    expect(policyTests).toContain("historical references keep an asset readable");
    expect(policyTests).toContain("deleted assets are not downloadable");
    expect(policyTests).toContain("select * from finish(true)");
  });
});

describe.runIf(process.env.RUN_DB_TESTS === "1")(
  "asset policies in the isolated development database",
  () => {
    it("passes the real pgTAP asset suite", () => {
      const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
      const productionRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF?.trim();
      if (process.env.APP_ENV !== "development" || !projectRef || (productionRef && projectRef === productionRef)) {
        throw new Error("Database tests require an isolated development project ref");
      }

      for (const file of [definitionPath, policyTestPath]) {
        const result = spawnSync(
          "pnpm",
          ["exec", "supabase", "db", "query", "--linked", "--project-ref", projectRef, "--file", file],
          { cwd: root, encoding: "utf8" },
        );
        if (result.status !== 0) {
          throw new Error(`Supabase CLI database check failed:\n${result.stderr}`);
        }
      }
    });
  },
);
