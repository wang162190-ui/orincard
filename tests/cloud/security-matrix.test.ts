import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExportDownloadError,
  createSupabaseExportDownloadStore,
} from "../../src/app/api/v1/exports/[id]/download/route";

// T092 跨账号与故障幂等矩阵。
// 这个文件只在 ORINCARD_RUN_SECURITY_MATRIX_CLOUD=1 时运行，且必须跑在开发 Supabase 上：
// 断言全部来自真实 RLS、真实 RPC、真实 Storage，没有任何 mock 顶替。
// 打开开关但缺变量时它在 beforeAll 显式失败并点名缺哪一个，不会 skip 后当作通过。

const cloud =
  process.env.ORINCARD_RUN_SECURITY_MATRIX_CLOUD === "1" ? describe : describe.skip;

const REQUIRED_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "ORINCARD_AUTH_TEST_EMAIL",
  "ORINCARD_AUTH_TEST_PASSWORD",
  "ORINCARD_AUTH_OTHER_EMAIL",
  "ORINCARD_AUTH_OTHER_PASSWORD",
] as const;

type RequiredVariable = (typeof REQUIRED_VARIABLES)[number];

function readCredentials(): Record<RequiredVariable, string> {
  const values = {} as Record<RequiredVariable, string>;
  const missing: string[] = [];
  for (const name of REQUIRED_VARIABLES) {
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
      continue;
    }
    values[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `ORINCARD_RUN_SECURITY_MATRIX_CLOUD=1 requires development variables: ${missing.join(", ")}. ` +
        "Configure them in your own shell against the development project; the test never reads .env files.",
    );
  }
  return values;
}

function requestHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function forgedExpiredJwt(subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ aud: "authenticated", role: "authenticated", sub: subject, exp: 1, iat: 0 }),
  ).toString("base64url");
  return `${header}.${payload}.forged-signature`;
}

interface ExportFixture {
  readonly exportId: string;
  readonly jobId: string;
  readonly assetId: string;
  readonly objectKey: string;
  readonly projectVersionId: string;
}

cloud("T092 cross-account and failure idempotency matrix", () => {
  let owner: SupabaseClient;
  let other: SupabaseClient;
  let admin: SupabaseClient;
  let supabaseUrl: string;
  let publishableKey: string;
  let ownerId: string;
  let otherId: string;
  let runId: string;
  let isolationProjectId: string;
  let concurrencyProjectId: string;
  let artifact: ExportFixture;
  let billingEventId: string;

  beforeAll(async () => {
    const credentials = readCredentials();
    supabaseUrl = credentials.NEXT_PUBLIC_SUPABASE_URL;
    publishableKey = credentials.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    const { createClient } = await import("@supabase/supabase-js");
    const options = { auth: { autoRefreshToken: false, persistSession: false } } as const;
    owner = createClient(supabaseUrl, publishableKey, options);
    other = createClient(supabaseUrl, publishableKey, options);
    admin = createClient(supabaseUrl, credentials.SUPABASE_SECRET_KEY, options);

    const [ownerLogin, otherLogin] = await Promise.all([
      owner.auth.signInWithPassword({
        email: credentials.ORINCARD_AUTH_TEST_EMAIL,
        password: credentials.ORINCARD_AUTH_TEST_PASSWORD,
      }),
      other.auth.signInWithPassword({
        email: credentials.ORINCARD_AUTH_OTHER_EMAIL,
        password: credentials.ORINCARD_AUTH_OTHER_PASSWORD,
      }),
    ]);
    expect(ownerLogin.error).toBeNull();
    expect(otherLogin.error).toBeNull();
    const signedInOwner = ownerLogin.data.user?.id;
    const signedInOther = otherLogin.data.user?.id;
    if (!signedInOwner || !signedInOther) {
      throw new Error("Both development test accounts must sign in before the matrix runs.");
    }
    if (signedInOwner === signedInOther) {
      throw new Error(
        "ORINCARD_AUTH_TEST_EMAIL and ORINCARD_AUTH_OTHER_EMAIL must be two different accounts.",
      );
    }
    ownerId = signedInOwner;
    otherId = signedInOther;

    runId = crypto.randomUUID();
    billingEventId = `evt_t092_${runId}`;
    isolationProjectId = await createProject(`T092 isolation ${runId}`);
    concurrencyProjectId = await createProject(`T092 concurrency ${runId}`);
    artifact = await createReadyExport(isolationProjectId);
  }, 120_000);

  afterAll(async () => {
    if (admin) {
      if (artifact) {
        await admin.from("exports").delete().eq("id", artifact.exportId);
        await admin.from("assets").delete().eq("id", artifact.assetId);
        await admin.storage.from("exports").remove([artifact.objectKey]);
        await admin.from("jobs").delete().eq("id", artifact.jobId);
      }
      for (const projectId of [isolationProjectId, concurrencyProjectId]) {
        if (projectId) {
          await admin
            .from("projects")
            .update({ state: "deleted", deleted_at: new Date().toISOString() })
            .eq("id", projectId);
        }
      }
    }
    await Promise.all([
      owner?.auth.signOut({ scope: "local" }),
      other?.auth.signOut({ scope: "local" }),
    ]);
  }, 120_000);

  async function createProject(title: string): Promise<string> {
    const created = await admin.rpc("server_create_project", {
      p_owner_id: ownerId,
      p_title: title,
      p_platform: "linkedin",
      p_document: { schemaVersion: 1, title, platform: "linkedin" },
      p_idempotency_key: `t092-create-${title}`,
      p_request_hash: requestHash(title),
    });
    expect(created.error).toBeNull();
    const projectId = (created.data as { projectId?: string } | null)?.projectId;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/i);
    return projectId as string;
  }

  // 造一件真实可下载的成品：真实 RPC 建任务与导出记录，真实对象上传到 exports 桶，
  // 再把导出记录置为 ready。断言全部走 RLS 与生产授权代码，不绕过。
  async function createReadyExport(projectId: string): Promise<ExportFixture> {
    const idempotencyKey = `t092-export-${runId}`;
    const created = await admin.rpc("server_create_exports", {
      p_owner_id: ownerId,
      p_project_id: projectId,
      p_expected_revision: 1,
      p_formats: ["png_zip"],
      p_options: {},
      p_confirmed_warnings: [],
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash(idempotencyKey),
    });
    expect(created.error).toBeNull();
    const rows = (created.data ?? []) as ReadonlyArray<{
      export_id: string;
      job_id: string;
      format: string;
    }>;
    expect(rows).toHaveLength(1);
    const [row] = rows;

    const version = await admin
      .from("project_versions")
      .select("id")
      .eq("project_id", projectId)
      .eq("revision", 1)
      .maybeSingle();
    expect(version.error).toBeNull();
    const projectVersionId = (version.data as { id?: string } | null)?.id;
    expect(projectVersionId).toMatch(/^[0-9a-f-]{36}$/i);

    const bytes = Buffer.from(`orincard-t092-${runId}`);
    const objectKey = `${ownerId}/t092-${runId}/matrix.zip`;
    const uploaded = await admin.storage
      .from("exports")
      .upload(objectKey, bytes, { contentType: "application/zip", upsert: false });
    expect(uploaded.error).toBeNull();

    const asset = await admin
      .from("assets")
      .insert({
        owner_id: ownerId,
        kind: "derived",
        purpose: "export",
        bucket: "exports",
        object_key: objectKey,
        mime: "application/zip",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        rights: { projectVersionId },
        state: "ready",
      })
      .select("id")
      .maybeSingle();
    expect(asset.error).toBeNull();
    const assetId = (asset.data as { id?: string } | null)?.id;
    expect(assetId).toMatch(/^[0-9a-f-]{36}$/i);

    const ready = await admin
      .from("exports")
      .update({ state: "ready", asset_id: assetId })
      .eq("id", row.export_id);
    expect(ready.error).toBeNull();

    return {
      exportId: row.export_id,
      jobId: row.job_id,
      assetId: assetId as string,
      objectKey,
      projectVersionId: projectVersionId as string,
    };
  }

  it("1 盗 ID：另一账号猜到真实 ID 也读不到项目、快照、导出与对象", async () => {
    const ownerRead = await owner.from("projects").select("id").eq("id", isolationProjectId);
    expect(ownerRead).toMatchObject({ error: null, data: [{ id: isolationProjectId }] });

    const stolenProject = await other.from("projects").select("id").eq("id", isolationProjectId);
    const stolenVersions = await other
      .from("project_versions")
      .select("id")
      .eq("project_id", isolationProjectId);
    const stolenExport = await other.from("exports").select("id").eq("id", artifact.exportId);
    const stolenAsset = await other.from("assets").select("id").eq("id", artifact.assetId);
    expect(stolenProject).toMatchObject({ error: null, data: [] });
    expect(stolenVersions).toMatchObject({ error: null, data: [] });
    expect(stolenExport).toMatchObject({ error: null, data: [] });
    expect(stolenAsset).toMatchObject({ error: null, data: [] });

    // 生产授权代码：所有者拿得到，另一账号即便同时报出真实 exportId 与真实 ownerId 也只得到 404。
    const ownerStore = createSupabaseExportDownloadStore(owner);
    const otherStore = createSupabaseExportDownloadStore(other);
    await expect(ownerStore.authorize(ownerId, artifact.exportId, new Date())).resolves.toMatchObject({
      bucket: "exports",
      objectPath: artifact.objectKey,
    });
    await expect(otherStore.authorize(otherId, artifact.exportId, new Date())).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    await expect(otherStore.authorize(ownerId, artifact.exportId, new Date())).rejects.toBeInstanceOf(
      ExportDownloadError,
    );

    const ownerObject = await owner.storage.from("exports").download(artifact.objectKey);
    const stolenObject = await other.storage.from("exports").download(artifact.objectKey);
    expect(ownerObject.error).toBeNull();
    expect(ownerObject.data?.size).toBeGreaterThan(0);
    expect(stolenObject.error).not.toBeNull();
    expect(stolenObject.data).toBeNull();
  }, 60_000);

  it("2 改 owner：直改 owner_id、越权写入与直调服务端 RPC 全部被拒且行不变", async () => {
    const before = await admin
      .from("projects")
      .select("owner_id,revision,title")
      .eq("id", isolationProjectId)
      .maybeSingle();
    expect(before.error).toBeNull();

    const stolenOwner = await other
      .from("projects")
      .update({ owner_id: otherId })
      .eq("id", isolationProjectId);
    const stolenTitle = await other
      .from("projects")
      .update({ title: "forged" })
      .eq("id", isolationProjectId);
    const selfOwnerRewrite = await owner
      .from("projects")
      .update({ owner_id: otherId })
      .eq("id", isolationProjectId);
    expect(stolenOwner.error).not.toBeNull();
    expect(stolenTitle.error).not.toBeNull();
    expect(selfOwnerRewrite.error).not.toBeNull();

    // 服务端 RPC 只授予 service_role；登录用户不能自己调用，也不能借 p_owner_id 冒名。
    const directRpc = await other.rpc("server_save_project", {
      p_owner_id: ownerId,
      p_project_id: isolationProjectId,
      p_expected_revision: 1,
      p_title: "forged",
      p_platform: "linkedin",
      p_document: { schemaVersion: 1, title: "forged", platform: "linkedin" },
      p_reason: "manual",
      p_idempotency_key: `t092-forged-${runId}`,
      p_request_hash: requestHash(`t092-forged-${runId}`),
    });
    expect(directRpc.error).not.toBeNull();

    // 服务端身份下用错误的 owner 保存别人的项目：命中 owner 绑定，不是行不存在就是 CAS 失败。
    const wrongOwner = await admin.rpc("server_save_project", {
      p_owner_id: otherId,
      p_project_id: isolationProjectId,
      p_expected_revision: 1,
      p_title: "forged",
      p_platform: "linkedin",
      p_document: { schemaVersion: 1, title: "forged", platform: "linkedin" },
      p_reason: "manual",
      p_idempotency_key: `t092-wrong-owner-${runId}`,
      p_request_hash: requestHash(`t092-wrong-owner-${runId}`),
    });
    expect(wrongOwner.error).not.toBeNull();

    const after = await admin
      .from("projects")
      .select("owner_id,revision,title")
      .eq("id", isolationProjectId)
      .maybeSingle();
    expect(after.error).toBeNull();
    expect(after.data).toEqual(before.data);
  }, 60_000);

  it("3 过期 JWT：Auth 与 Data API 都拒绝，且不回任何项目数据", async () => {
    const expired = forgedExpiredJwt(ownerId);
    const rejected = await owner.auth.getUser(expired);
    expect(rejected.error).not.toBeNull();
    expect(rejected.data.user).toBeNull();

    const response = await fetch(
      `${supabaseUrl}/rest/v1/projects?select=id,title&id=eq.${isolationProjectId}`,
      { headers: { apikey: publishableKey, Authorization: `Bearer ${expired}` } },
    );
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(isolationProjectId);
    expect(body).not.toContain("T092 isolation");

    const anonymous = await fetch(
      `${supabaseUrl}/rest/v1/projects?select=id&id=eq.${isolationProjectId}`,
      { headers: { apikey: publishableKey } },
    );
    expect(anonymous.ok ? JSON.parse(await anonymous.text()) : []).toEqual([]);
  }, 60_000);

  it("4 并发保存：同一 revision 只成功一次，重放同一幂等键不再产生新版本", async () => {
    const first = `t092-save-a-${runId}`;
    const second = `t092-save-b-${runId}`;
    const payload = (title: string) => ({
      p_owner_id: ownerId,
      p_project_id: concurrencyProjectId,
      p_expected_revision: 1,
      p_title: title,
      p_platform: "linkedin",
      p_document: { schemaVersion: 1, title, platform: "linkedin" },
      p_reason: "manual",
    });
    const [a, b] = await Promise.all([
      admin.rpc("server_save_project", {
        ...payload("T092 concurrent A"),
        p_idempotency_key: first,
        p_request_hash: requestHash(first),
      }),
      admin.rpc("server_save_project", {
        ...payload("T092 concurrent B"),
        p_idempotency_key: second,
        p_request_hash: requestHash(second),
      }),
    ]);

    const winners = [a, b].filter((result) => result.error === null);
    const losers = [a, b].filter((result) => result.error !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.error).toMatchObject({ code: "40001" });
    expect(winners[0]?.data).toMatchObject({ projectId: concurrencyProjectId, revision: 2 });

    const saved = await admin
      .from("projects")
      .select("revision")
      .eq("id", concurrencyProjectId)
      .maybeSingle();
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ revision: 2 });

    const versions = await admin
      .from("project_versions")
      .select("revision")
      .eq("project_id", concurrencyProjectId);
    expect(versions.error).toBeNull();
    expect((versions.data ?? []).map((row) => (row as { revision: number }).revision).sort()).toEqual([
      1, 2,
    ]);

    // 同一幂等键重放：回执重放，revision 与版本数都不再增长。
    const winnerKey = winners[0] === a ? first : second;
    const winnerTitle = winners[0] === a ? "T092 concurrent A" : "T092 concurrent B";
    const replay = await admin.rpc("server_save_project", {
      ...payload(winnerTitle),
      p_idempotency_key: winnerKey,
      p_request_hash: requestHash(winnerKey),
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(winners[0]?.data);
    const afterReplay = await admin
      .from("project_versions")
      .select("revision")
      .eq("project_id", concurrencyProjectId);
    expect(afterReplay.error).toBeNull();
    expect(afterReplay.data ?? []).toHaveLength(2);
  }, 60_000);

  it("5 重复回调：同一供应商事件只登记一次，重复领取无效，未登记事件不能应用", async () => {
    const registered = await admin.rpc("server_register_billing_event", {
      p_provider_event_id: billingEventId,
      p_type: "customer.subscription.updated",
      p_subject_id: `sub_t092_${runId}`,
    });
    expect(registered.error).toBeNull();
    expect(registered.data).toBe(true);

    const duplicate = await admin.rpc("server_register_billing_event", {
      p_provider_event_id: billingEventId,
      p_type: "customer.subscription.updated",
      p_subject_id: `sub_t092_${runId}`,
    });
    expect(duplicate.error).toBeNull();
    expect(duplicate.data).toBe(false);

    const claimed = await admin.rpc("server_claim_billing_event", {
      p_provider_event_id: billingEventId,
    });
    expect(claimed.error).toBeNull();
    expect(claimed.data).toMatchObject([{ provider_event_id: billingEventId, attempt: 1 }]);

    const reclaimed = await admin.rpc("server_claim_billing_event", {
      p_provider_event_id: billingEventId,
    });
    expect(reclaimed.error).toBeNull();
    expect(reclaimed.data).toEqual([]);

    // 失败后可重试，attempt 递增；这是重复投递能恢复而不是重复生效的证据。
    const failed = await admin.rpc("server_fail_billing_event", {
      p_provider_event_id: billingEventId,
      p_error_code: "T092_MATRIX",
    });
    expect(failed.error).toBeNull();
    const retried = await admin.rpc("server_claim_billing_event", {
      p_provider_event_id: billingEventId,
    });
    expect(retried.error).toBeNull();
    expect(retried.data).toMatchObject([{ provider_event_id: billingEventId, attempt: 2 }]);
    await admin.rpc("server_fail_billing_event", {
      p_provider_event_id: billingEventId,
      p_error_code: "T092_MATRIX",
    });

    // 未验签、未登记的事件不能直接应用。
    const unregistered = await admin.rpc("server_apply_billing_event", {
      p_provider_event_id: `evt_t092_unregistered_${runId}`,
      p_owner_id: ownerId,
      p_provider_customer_id: `cus_t092_${runId}`,
      p_provider_subscription_id: `sub_t092_${runId}`,
      p_plan_key: "pro",
      p_policy_version: "2026-09",
      p_status: "active",
      p_current_period_start: "2026-09-01T00:00:00.000Z",
      p_current_period_end: "2026-10-01T00:00:00.000Z",
      p_cancel_at_period_end: false,
      p_provider_updated_at: "2026-09-10T00:00:00.000Z",
      p_provider_invoice_id: `in_t092_${runId}`,
      p_action: "subscription_sync",
      p_details: {},
    });
    expect(unregistered.error).not.toBeNull();

    // 登录用户不能自己调用回调入口。
    const byUser = await other.rpc("server_register_billing_event", {
      p_provider_event_id: `evt_t092_user_${runId}`,
      p_type: "customer.subscription.updated",
      p_subject_id: `sub_t092_${runId}`,
    });
    expect(byUser.error).not.toBeNull();
  }, 60_000);

  it("6 未知上游状态：无法识别的订阅状态与未绑定的导出回写都被拒且不落库", async () => {
    const before = await admin
      .from("subscriptions")
      .select("owner_id,status,plan_key,provider_updated_at")
      .eq("owner_id", ownerId)
      .maybeSingle();
    expect(before.error).toBeNull();

    const unknownStatus = await admin.rpc("server_apply_billing_event", {
      p_provider_event_id: billingEventId,
      p_owner_id: ownerId,
      p_provider_customer_id: `cus_t092_${runId}`,
      p_provider_subscription_id: `sub_t092_${runId}`,
      p_plan_key: "pro",
      p_policy_version: "2026-09",
      p_status: "chargeback_from_the_future",
      p_current_period_start: "2026-09-01T00:00:00.000Z",
      p_current_period_end: "2026-10-01T00:00:00.000Z",
      p_cancel_at_period_end: false,
      p_provider_updated_at: "2026-09-10T00:00:00.000Z",
      p_provider_invoice_id: `in_t092_${runId}`,
      p_action: "subscription_sync",
      p_details: {},
    });
    expect(unknownStatus.error).not.toBeNull();

    const unknownPlan = await admin.rpc("server_apply_billing_event", {
      p_provider_event_id: billingEventId,
      p_owner_id: ownerId,
      p_provider_customer_id: `cus_t092_${runId}`,
      p_provider_subscription_id: `sub_t092_${runId}`,
      p_plan_key: "enterprise_unknown",
      p_policy_version: "2026-09",
      p_status: "active",
      p_current_period_start: "2026-09-01T00:00:00.000Z",
      p_current_period_end: "2026-10-01T00:00:00.000Z",
      p_cancel_at_period_end: false,
      p_provider_updated_at: "2026-09-10T00:00:00.000Z",
      p_provider_invoice_id: `in_t092_${runId}`,
      p_action: "subscription_sync",
      p_details: {},
    });
    expect(unknownPlan.error).not.toBeNull();

    const after = await admin
      .from("subscriptions")
      .select("owner_id,status,plan_key,provider_updated_at")
      .eq("owner_id", ownerId)
      .maybeSingle();
    expect(after.error).toBeNull();
    expect(after.data).toEqual(before.data);

    // 上游拿着真实 ID 但状态对不上时回写导出：绑定检查失败，成品与任务都不变。
    const jobBefore = await admin
      .from("jobs")
      .select("state,result_ref")
      .eq("id", artifact.jobId)
      .maybeSingle();
    expect(jobBefore.error).toBeNull();

    const unboundWriteback = await admin.rpc("server_finalize_export", {
      p_job_id: artifact.jobId,
      p_export_id: artifact.exportId,
      p_asset_id: artifact.assetId,
      p_manifest: {},
      p_result_ref: {
        exportId: artifact.exportId,
        assetId: artifact.assetId,
        projectVersionId: artifact.projectVersionId,
        format: "png_zip",
      },
      p_finished_at: new Date().toISOString(),
    });
    expect(unboundWriteback.error).not.toBeNull();

    const jobAfter = await admin
      .from("jobs")
      .select("state,result_ref")
      .eq("id", artifact.jobId)
      .maybeSingle();
    expect(jobAfter.error).toBeNull();
    expect(jobAfter.data).toEqual(jobBefore.data);
  }, 60_000);

  it("7 删除后下载：项目转入删除后授权与对象读取立刻失效", async () => {
    const before = createSupabaseExportDownloadStore(owner);
    await expect(before.authorize(ownerId, artifact.exportId, new Date())).resolves.toMatchObject({
      objectPath: artifact.objectKey,
    });

    const deleted = await admin
      .from("projects")
      .update({ state: "deleted", deleted_at: new Date().toISOString() })
      .eq("id", isolationProjectId);
    expect(deleted.error).toBeNull();

    const store = createSupabaseExportDownloadStore(owner);
    await expect(store.authorize(ownerId, artifact.exportId, new Date())).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });

    const project = await owner.from("projects").select("id").eq("id", isolationProjectId);
    const exports = await owner.from("exports").select("id").eq("id", artifact.exportId);
    const versions = await owner
      .from("project_versions")
      .select("id")
      .eq("project_id", isolationProjectId);
    expect(project).toMatchObject({ error: null, data: [] });
    expect(exports).toMatchObject({ error: null, data: [] });
    expect(versions).toMatchObject({ error: null, data: [] });

    const object = await owner.storage.from("exports").download(artifact.objectKey);
    expect(object.error).not.toBeNull();
    expect(object.data).toBeNull();
  }, 60_000);
});
