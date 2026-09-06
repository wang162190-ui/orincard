import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const definitionPath = fileURLToPath(new URL("../../supabase/definitions/jobs-usage.sql", import.meta.url));
const policyTestPath = fileURLToPath(new URL("../../supabase/tests/jobs-usage.sql", import.meta.url));

describe("jobs and usage database definition", () => {
  it("declares commented outbox, append-only accounting and idempotent transactions", async () => {
    const [sql, policyTests] = await Promise.all([readFile(definitionPath, "utf8"), readFile(policyTestPath, "utf8")]);

    for (const table of ["jobs", "usage_accounts", "usage_ledger"]) {
      expect(sql).toContain(`comment on table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    for (const table of ["cost_budgets", "cost_reservations", "cost_attempts", "operation_receipts", "request_guards"]) {
      expect(sql).toContain(`comment on table private.${table}`);
      expect(sql).toContain(`alter table private.${table} enable row level security`);
    }
    expect(sql.match(/comment on column public\.jobs\./g)).toHaveLength(21);
    expect(sql.match(/comment on column public\.usage_accounts\./g)).toHaveLength(9);
    expect(sql.match(/comment on column public\.usage_ledger\./g)).toHaveLength(7);
    expect(sql).toMatch(/function private\.submit_job\([\s\S]+security definer[\s\S]+set search_path = ''/);
    expect(sql).toMatch(/function private\.finalize_job\([\s\S]+for update/);
    expect(sql).toContain("cancel_requested_at = coalesce(cancel_requested_at, now())");
    expect(sql).toContain("on conflict (attempt_key) do nothing");
    expect(sql).toContain("drop function if exists private.save_project");
    expect(sql).toMatch(/function private\.save_project\([\s\S]+private\.operation_receipts[\s\S]+and revision = p_expected_revision/);
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(policyTests).toContain("duplicate submit returns the original job without a second reservation");
    expect(policyTests).toContain("same save receipt replays after revision advanced");
    expect(policyTests).toContain("duplicate finalize does not consume twice");
    expect(policyTests).toContain("concurrent reservations cannot overdraw an account");
    expect(policyTests).toContain("select * from finish(true)");
  });
});

describe.runIf(process.env.RUN_DB_TESTS === "1")(
  "job and accounting policies in the isolated development database",
  () => {
    it("passes the real pgTAP job and usage suite", () => {
      const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
      const productionRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF?.trim();
      if (process.env.APP_ENV !== "development" || !projectRef || (productionRef && projectRef === productionRef)) {
        throw new Error("Database tests require an isolated development project ref");
      }
      for (const file of [definitionPath, policyTestPath]) {
        const result = spawnSync("pnpm", ["exec", "supabase", "db", "query", "--linked", "--project-ref", projectRef, "--file", file], { cwd: root, encoding: "utf8" });
        if (result.status !== 0) throw new Error(`Supabase CLI database check failed:\n${result.stderr}`);
      }
    });
  },
);
