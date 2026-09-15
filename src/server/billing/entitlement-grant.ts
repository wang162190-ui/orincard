import type { SupabaseClient } from "@supabase/supabase-js";
import {
  entitlementsForPlan,
  isPlanKey,
  type EntitlementPolicy,
  type PlanKey,
} from "../../domain/entitlements";
import { loadEntitlementPolicy } from "./policy";

/**
 * 把权益策略翻译成额度桶。
 *
 * 在这个模块之前，`public.usage_accounts` 没有任何生产写入路径，于是
 * `private.submit_job` 对每一个真实用户都抛 22003 'insufficient usage balance'。
 * 详见 `supabase/migrations/20260915001000_usage_entitlement_grant.sql` 的注释。
 *
 * 策略的唯一真相仍然是 `BILLING_POLICY_JSON`（`./policy.ts`）。这里只做翻译，
 * 数据库那一侧的 `granted` 是入参，不含任何写死的数字。
 */

export interface UsagePeriod {
  /** ISO 时间戳，UTC 自然月的起点。 */
  readonly periodStart: string;
  /** ISO 时间戳，下一个自然月的起点（左闭右开，与 usage_accounts 的检查约束一致）。 */
  readonly periodEnd: string;
}

/**
 * 当前 UTC 自然月的边界。
 *
 * 刻意在 TS 里算而不是交给 SQL 的 `date_trunc('month', now())`——后者取的是会话时区，
 * 而 `private.submit_job` 是拿调用方传入的边界做**精确相等**匹配的。边界只要有一次
 * 算得不一样，桶就查不到，失败形态又会退回那句 'insufficient usage balance'。
 */
export function currentUsagePeriod(at: Date): UsagePeriod {
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return { periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString() };
}

export interface UsageGrant {
  readonly resource: string;
  readonly granted: number;
}

/**
 * 某方案在一个周期内应得的额度桶。
 *
 * 只有 `generation` 一项，因为 `Entitlements`（`src/domain/entitlements.ts`）只有
 * `monthlyGenerations` 这一个可数字段。`private.begin_ai_candidate`
 * （`supabase/definitions/ai-asset-budget.sql:45`）还会读 `resource = 'image'` 的桶，
 * 但策略里**没有**对应的数字——「免费用户送多少张图」是 B-1 未定的商业决策。
 * 在这里编一个数字出来会让那个决策以代码的形式被悄悄做掉，所以不发放。
 * 后果是明确的：portrait / ai_image 两类任务仍会 quota_exceeded，直到策略补上该字段。
 */
export function grantsForPlan(policy: EntitlementPolicy, planKey: PlanKey): readonly UsageGrant[] {
  return [{ resource: "generation", granted: entitlementsForPlan(policy, planKey).monthlyGenerations }];
}

export interface EntitlementGrantStore {
  /** 该用户服务端认定的方案；没有订阅记录就是 free。 */
  planKey(ownerId: string): Promise<PlanKey>;
  grant(input: {
    readonly ownerId: string;
    readonly resource: string;
    readonly period: UsagePeriod;
    readonly granted: number;
  }): Promise<void>;
}

/** 需要 service_role 客户端：`server_grant_usage_account` 对 anon 与 authenticated 都是 revoke 的。 */
export function createSupabaseEntitlementGrantStore(client: SupabaseClient): EntitlementGrantStore {
  return {
    async planKey(ownerId) {
      const { data, error } = await client
        .from("subscriptions")
        .select("plan_key,status")
        .eq("owner_id", ownerId)
        .maybeSingle();
      if (error) throw error;
      // 没有订阅记录即 free，与 src/app/api/v1/billing/route.ts 的读法保持一致。
      // 方案只从服务端持有的订阅推导，绝不接受客户端声明。
      const planKey = data?.plan_key;
      return isPlanKey(planKey) ? planKey : "free";
    },
    async grant(input) {
      const { error } = await client.rpc("server_grant_usage_account", {
        p_owner_id: input.ownerId,
        p_resource: input.resource,
        p_period_start: input.period.periodStart,
        p_period_end: input.period.periodEnd,
        p_granted: input.granted,
      });
      if (error) throw error;
    },
  };
}

/**
 * 确保该用户在**当前周期**持有其方案对应的全部额度桶。
 *
 * 幂等，且额度只升不降（降级在 SQL 侧会打破 `reserved + consumed <= granted`，
 * 只能等下个周期的新桶生效）。按周期而非按注册发放，所以跨月自动续上。
 */
export async function ensureEntitlementsForPeriod(input: {
  readonly store: EntitlementGrantStore;
  readonly policy: EntitlementPolicy;
  readonly ownerId: string;
  readonly at: Date;
}): Promise<UsagePeriod> {
  const period = currentUsagePeriod(input.at);
  const planKey = await input.store.planKey(input.ownerId);
  for (const { resource, granted } of grantsForPlan(input.policy, planKey)) {
    await input.store.grant({ ownerId: input.ownerId, resource, period, granted });
  }
  return period;
}

/**
 * 给提交路由用的发放回调；**权益策略没配置时返回 undefined**。
 *
 * 不在这里兜一个默认额度：额度数字属于 B-1 那 12 项未定商业决策，凭空编一个会让它以代码的
 * 形式被悄悄做掉。策略缺失时调用方不接这个回调，失败形态维持原样（QUOTA_EXCEEDED），
 * 是一个诚实的「没配」而不是一个假装能用的默认值。
 */
export function createEntitlementProvisioner(input: {
  readonly client: SupabaseClient;
  readonly appEnvironment: Parameters<typeof loadEntitlementPolicy>[0]["appEnvironment"];
  readonly rawPolicy: string | undefined;
}): ((ownerId: string, at: Date) => Promise<void>) | undefined {
  if (!input.rawPolicy) return undefined;
  const policy = loadEntitlementPolicy({
    appEnvironment: input.appEnvironment,
    policy: JSON.parse(input.rawPolicy),
  });
  const store = createSupabaseEntitlementGrantStore(input.client);
  return async (ownerId, at) => {
    await ensureEntitlementsForPeriod({ store, policy, ownerId, at });
  };
}
