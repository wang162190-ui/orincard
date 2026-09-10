import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function workflow(name: string) {
  return readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
}

describe("T085 controlled deployment", () => {
  it("tests changes before creating an isolated Preview", async () => {
    const check = await workflow("check.yml");
    expect(check).toContain("preview:\n    needs: test");
    expect(check).toContain("environment: preview");
    expect(check).toContain('test "$SUPABASE_PROJECT_REF" != "$SUPABASE_PRODUCTION_PROJECT_REF"');
    expect(check).toContain("vercel@59.15.1 deploy --prebuilt");
    expect(check).not.toContain("vercel@59.15.1 deploy --prebuilt --prod");
  });

  it("releases one tested commit in test, migration, worker, website order", async () => {
    const release = await workflow("release.yml");
    expect(release).toContain("RELEASE_SHA: ${{ inputs.commit }}");
    expect(release.match(/ref: \$\{\{ env\.RELEASE_SHA \}\}/g)).toHaveLength(4);
    expect(release).toContain('test "$(git rev-parse HEAD)" = "$RELEASE_SHA"');
    expect(release).toMatch(/migrate:\n    needs: test[\s\S]+worker:\n    needs: migrate[\s\S]+website:\n    needs: worker/);
    expect(release).toContain("supabase db push --linked --include-all");
    expect(release).toContain('trigger deploy --env prod --external-id "$RELEASE_SHA"');
    expect(release).toContain("vercel@59.15.1 deploy --prebuilt --prod");
    expect(release).not.toMatch(/migration new|db diff|db pull/);
  });

  it("requires the protected production environment before mutation", async () => {
    const release = await workflow("release.yml");
    expect(release.match(/environment: production/g)).toHaveLength(3);
    expect(release.match(/test "\$SUPABASE_PROJECT_REF" = "\$SUPABASE_PRODUCTION_PROJECT_REF"/g)).toHaveLength(2);
    expect(release).toContain("cancel-in-progress: false");
  });

  it("keeps deploy configuration free of credentials and automatic migration hooks", async () => {
    const raw = await readFile(new URL("../../vercel.json", import.meta.url), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    expect(config).toMatchObject({ framework: "nextjs", buildCommand: "pnpm build" });
    expect(raw).not.toMatch(/secret|token|password|supabase db/i);
  });
});
