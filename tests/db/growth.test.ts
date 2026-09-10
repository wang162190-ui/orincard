import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const definition = fileURLToPath(new URL("../../supabase/definitions/growth.sql", import.meta.url));
const migration = fileURLToPath(new URL("../../supabase/migrations/20260910124717_growth_affiliate_support.sql", import.meta.url));
const pgTap = fileURLToPath(new URL("../../supabase/tests/growth.sql", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));

describe("T079 growth database definition", () => {
  it("keeps the migration identical and covers comments, isolation and reversal rules", async () => {
    const [sql, migrated, tests] = await Promise.all([readFile(definition, "utf8"), readFile(migration, "utf8"), readFile(pgTap, "utf8")]);
    expect(migrated).toBe(sql);
    for (const table of ["affiliate_accounts", "referrals", "commissions", "support_tickets"]) expect(sql).toContain(`alter table public.${table} enable row level security`);
    expect(sql.match(/comment on column public\.affiliate_accounts\./g)).toHaveLength(14);
    expect(sql.match(/comment on column public\.referrals\./g)).toHaveLength(11);
    expect(sql.match(/comment on column public\.commissions\./g)).toHaveLength(10);
    expect(sql.match(/comment on column public\.support_tickets\./g)).toHaveLength(8);
    expect(sql).toContain("referrals_one_active_owner");
    expect(sql).toContain("commission_reversal_shape");
    expect(sql).not.toContain("grant select on public.affiliate_accounts to authenticated");
    expect(tests).toContain("self referral is retained as rejected evidence");
    expect(tests).toContain("refund appends one negative reversal");
    expect(tests).toContain("another owner cannot read the application");
  });
});

describe.runIf(process.env.RUN_DB_TESTS === "1")("growth policies in the isolated development database", () => {
  it("passes the real pgTAP growth suite", () => {
    const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
    const productionRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF?.trim();
    if (process.env.APP_ENV !== "development" || !projectRef || (productionRef && projectRef === productionRef)) throw new Error("Database tests require an isolated development project ref");
    for (const file of [definition, pgTap]) {
      const result = spawnSync("pnpm", ["exec", "supabase", "db", "query", "--linked", "--project-ref", projectRef, "--file", file], { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Supabase CLI database check failed:\n${result.stderr}`);
    }
  });
});
