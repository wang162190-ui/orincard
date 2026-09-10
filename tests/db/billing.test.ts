import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const definitionPath = fileURLToPath(new URL("../../supabase/definitions/billing.sql", import.meta.url));
const policyTestPath = fileURLToPath(new URL("../../supabase/tests/billing.sql", import.meta.url));

describe("T069 billing database definition", () => {
  it("defines commented subscriptions, unique events and append-only audit", async () => {
    const [sql, policyTests] = await Promise.all([readFile(definitionPath, "utf8"), readFile(policyTestPath, "utf8")]);
    expect(sql.match(/comment on column public\.subscriptions\./g)).toHaveLength(12);
    expect(sql.match(/comment on column public\.billing_customers\./g)).toHaveLength(5);
    expect(sql).toContain("grant select, insert, update, delete on table public.billing_customers to service_role");
    expect(sql.match(/comment on column private\.billing_events\./g)).toHaveLength(8);
    expect(sql.match(/comment on column private\.billing_audit_log\./g)).toHaveLength(7);
    expect(sql).toContain("provider_event_id text primary key");
    expect(sql).toContain("provider_event_id text not null unique");
    expect(sql).toContain("where subscriptions.provider_updated_at <= excluded.provider_updated_at");
    expect(sql).toContain("billing audit is append only");
    expect(sql).toMatch(/subscriptions_select_own_active[\s\S]+auth\.uid\(\)/);
    expect(sql).toMatch(/revoke all on table private\.billing_events, private\.billing_audit_log[\s\S]+authenticated/);
    expect(sql).toContain("grant select (id, plan_key, policy_version, status");
    expect(sql).not.toContain("grant select on table public.subscriptions to authenticated");
    expect(sql).toContain("not (details ?| array['card', 'payment_method', 'client_secret', 'api_key', 'payload'])");
    expect(policyTests).toContain("duplicate event is acknowledged without a duplicate row");
    expect(policyTests).toContain("different invoice IDs are never merged by timestamp");
    expect(policyTests).toContain("another account cannot read the subscription");
    expect(policyTests).toContain("select * from finish(true)");
  });
});

describe.runIf(process.env.RUN_DB_TESTS === "1")("billing policies in the isolated development database", () => {
  it("passes the real pgTAP billing suite", () => {
    const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
    const productionRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF?.trim();
    if (process.env.APP_ENV !== "development" || !projectRef || (productionRef && projectRef === productionRef)) throw new Error("Database tests require an isolated development project ref");
    for (const file of [definitionPath, policyTestPath]) {
      const result = spawnSync("pnpm", ["exec", "supabase", "db", "query", "--linked", "--project-ref", projectRef, "--file", file], { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Supabase CLI database check failed:\n${result.stderr}`);
    }
  });
});
