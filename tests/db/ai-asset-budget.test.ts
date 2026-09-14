import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const definitionUrl = new URL("../../supabase/definitions/ai-asset-budget.sql", import.meta.url);
const migrationUrl = new URL("../../supabase/migrations/20260912020000_asset_cost_source.sql", import.meta.url);

describe("AI asset atomic budget definition", () => {
  it("creates candidates with quota and cost reservations in one transaction and finalizes idempotently", async () => {
    const sql = await readFile(definitionUrl, "utf8");
    expect(sql).toContain("comment on table private.ai_asset_reservations");
    expect(sql.match(/comment on column private\.ai_asset_reservations\./g)).toHaveLength(11);
    expect(sql).toMatch(/server_create_ai_asset_candidate[\s\S]+for update[\s\S]+insert into public\.assets[\s\S]+reserved = reserved \+ 1/);
    expect(sql).toMatch(/server_finalize_ai_asset_candidate[\s\S]+state in \('settled', 'released'\)[\s\S]+reserved = reserved - 1/);
    expect(sql).toContain("spent_micro_usd = spent_micro_usd + case when p_succeeded");
    expect(sql).toContain("grant execute on function public.server_create_ai_asset_candidate");
    expect(sql).toContain("grant execute on function public.server_finalize_ai_asset_candidate");
  });

  // 路线图 S3。改之前代码在供应商不回报成本时补 $0.025，落库后与实测成本无从分辨。
  it("records where each settled image cost came from instead of inventing one", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("cost_source text");
    expect(sql).toContain("cost_source is null or cost_source in ('measured', 'unmeasured_reserved')");
    // 供应商没报 → 按预留全额入账，不是按常数，也不是按 0（记 0 会让预算显得比实际宽松）。
    expect(sql).toContain("charged_micro_usd := coalesce(p_actual_micro_usd, reservation.reserved_micro_usd);");
    expect(sql).toContain("charged_source := case when p_actual_micro_usd is null then 'unmeasured_reserved' else 'measured' end;");
    expect(sql).toContain("cost_source = case when p_succeeded then charged_source else null end,");
  });

  // `supabase/definitions/*.sql` 不是迁移的镜像，而是基线迁移 20260906000100 的**生成源**
  // （scripts/prepare-migrations.mjs），`tests/db/migration-smoke.test.ts` 逐字节校验二者一致。
  // 所以基线之后的任何 schema 变更都只能写进新迁移，**绝不能回头改 definitions** —— 改了就等于
  // 篡改一个已经 apply 过的迁移。这条断言把这个约定钉死：定义基线里不该出现 S3 才引入的列。
  //
  // 之所以安全，还依赖第二个事实：`ai-asset-budget.sql` 不在任何 `supabase db query --file`
  // 重放列表里（被重放的是 identity / projects / assets / jobs-usage / billing / growth）。
  // 如果哪天给它加了 RUN_DB_TESTS 重放块，重放就会把基线版本的函数写回开发库、悄悄抹掉本次迁移。
  it("keeps the generated baseline frozen so the later migration is the only source of truth", async () => {
    const definition = await readFile(definitionUrl, "utf8");
    expect(definition, "S3 的列必须只存在于迁移里，不能回写进基线生成源").not.toContain("cost_source");
    expect(definition).toContain("p_actual_micro_usd bigint");
  });
});
