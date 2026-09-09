import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("AI asset atomic budget definition", () => {
  it("creates candidates with quota and cost reservations in one transaction and finalizes idempotently", async () => {
    const sql = await readFile(new URL("../../supabase/definitions/ai-asset-budget.sql", import.meta.url), "utf8");
    expect(sql).toContain("comment on table private.ai_asset_reservations");
    expect(sql.match(/comment on column private\.ai_asset_reservations\./g)).toHaveLength(11);
    expect(sql).toMatch(/server_create_ai_asset_candidate[\s\S]+for update[\s\S]+insert into public\.assets[\s\S]+reserved = reserved \+ 1/);
    expect(sql).toMatch(/server_finalize_ai_asset_candidate[\s\S]+state in \('settled', 'released'\)[\s\S]+reserved = reserved - 1/);
    expect(sql).toContain("spent_micro_usd = spent_micro_usd + case when p_succeeded");
    expect(sql).toContain("grant execute on function public.server_create_ai_asset_candidate");
    expect(sql).toContain("grant execute on function public.server_finalize_ai_asset_candidate");
  });
});
