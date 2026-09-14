import type { ProviderMeasurement } from "./ai";
import { attemptKey, priceMeasurements, UnpricedModelError } from "./cost";

/**
 * 把供应商实测用量结算到 private.cost_attempts。
 *
 * ## 为什么结算失败不让生成失败
 *
 * 结算是记账动作，发生在供应商调用**之后**——那时 token 已经烧掉了，产物也已经拿到。此时抛错
 * 只会把一次已经花过钱的成功生成变成用户可见的失败，钱照花，用户还拿不到东西。所以这里的失败
 * 一律吞掉并 `console.error`，不向上冒泡。
 *
 * 吞掉是安全的，因为漏记的方向是**保守**的：尝试保持在 `sent` / `unknown`，预留继续占着额度不被
 * 释放。也就是说漏记会让预算显得比实际更紧，而不是更松，不会导致超支。代价是那笔预留要等对账
 * 巡检回收——而巡检本身当前是坏的（见 docs/acceptance/costs.md 的阻断 1，修复在路线图 S6）。
 */

interface RpcClient {
  rpc(name: string, parameters: Readonly<Record<string, unknown>>): PromiseLike<{
    readonly data: unknown;
    readonly error: unknown;
  }>;
}

/**
 * 收集一次任务内的全部 measurement。
 *
 * 生成路径的 schema 修复重试会发两次供应商调用，但它们共用同一个 attempt_key，而
 * `settle_cost_attempt` 重复结算且参数不同会抛 23505。所以必须先收集、后合并、只结算一次。
 */
export interface MeasurementCollector {
  readonly onMeasurement: (measurement: ProviderMeasurement) => Promise<void>;
  readonly collected: () => readonly ProviderMeasurement[];
}

export function createMeasurementCollector(): MeasurementCollector {
  const measurements: ProviderMeasurement[] = [];
  return {
    onMeasurement: async (measurement) => {
      measurements.push(measurement);
    },
    collected: () => measurements,
  };
}

function reportSettlementFailure(context: string, reason: unknown): void {
  const detail = reason instanceof Error ? reason.message : String(reason);
  // 只记上下文与原因，不记正文、不记 token 明细以外的任何请求内容。
  console.error(`[cost] settlement failed (${context}): ${detail}`);
}

async function settleVia(
  client: RpcClient,
  rpcName: string,
  baseParameters: Readonly<Record<string, unknown>>,
  measurements: readonly ProviderMeasurement[],
  context: string,
  at: Date,
): Promise<boolean> {
  let priced;
  try {
    priced = priceMeasurements(measurements, at);
  } catch (reason) {
    // 未登记费率的模型走到这里。宁可不结算，也不写一个猜的数字。
    reportSettlementFailure(
      reason instanceof UnpricedModelError ? `${context}, unpriced model` : context,
      reason,
    );
    return false;
  }
  // 供应商没回报用量时不结算，也不算失败——不估算、不补零。
  if (!priced) return false;

  try {
    const { error } = await client.rpc(rpcName, {
      ...baseParameters,
      p_provider_operation_id: priced.providerOperationId,
      p_usage: priced.usagePayload,
      p_actual_micro_usd: priced.actualMicroUsd,
    });
    if (error) {
      reportSettlementFailure(context, error);
      return false;
    }
    return true;
  } catch (reason) {
    reportSettlementFailure(context, reason);
    return false;
  }
}

/**
 * 生成任务：attempt_key 由数据库按 `public.jobs.attempt` 自行解析，应用层不拼 key。
 * 见 `supabase/migrations/20260912010000_settlement_entrypoints.sql`。
 */
export function settleGenerationUsage(input: {
  readonly client: RpcClient;
  readonly jobId: string;
  readonly leaseToken: string;
  readonly measurements: readonly ProviderMeasurement[];
  readonly at?: Date;
}): Promise<boolean> {
  return settleVia(
    input.client,
    "server_settle_generation_usage",
    { p_job_id: input.jobId, p_lease_token: input.leaseToken },
    input.measurements,
    `generation ${input.jobId}`,
    input.at ?? new Date(),
  );
}

/**
 * 已由既有 SQL 函数登记过尝试行的任务路径（rewrite / regenerate 的 `:candidate:1`）。
 * **只结算，不重复登记**——再 register 一次会另开一行、把同一次调用计两遍。
 */
export function settleKeyedJobUsage(input: {
  readonly client: RpcClient;
  readonly jobId: string;
  readonly operation: string;
  readonly sequence: number;
  readonly measurements: readonly ProviderMeasurement[];
  readonly at?: Date;
}): Promise<boolean> {
  const key = attemptKey(input.jobId, input.operation, input.sequence);
  return settleVia(
    input.client,
    "server_settle_cost_attempt",
    { p_job_id: input.jobId, p_attempt_key: key },
    input.measurements,
    key,
    input.at ?? new Date(),
  );
}

/**
 * 没有任何 SQL 侧登记的任务路径（text tool）：必须先 register 出尝试行，否则
 * `settle_cost_attempt` 会因「cost attempt not found」失败。
 *
 * 登记发生在供应商调用**之前**，登记失败就不该发起调用——那说明预留不在，继续跑等于绕过预算。
 * 因此这里的失败**向上冒泡**，与结算失败的处理相反。
 */
export async function registerJobCostAttempt(input: {
  readonly client: RpcClient;
  readonly jobId: string;
  readonly operation: string;
  readonly sequence: number;
}): Promise<string> {
  const key = attemptKey(input.jobId, input.operation, input.sequence);
  const { error } = await input.client.rpc("server_register_cost_attempt", {
    p_job_id: input.jobId,
    p_attempt_key: key,
  });
  if (error) {
    throw error instanceof Error
      ? error
      : new Error(`Failed to register cost attempt ${key}`);
  }
  return key;
}

/** 访客生成：预留挂在 guest_guard_id 上，job_id 为 null，走独立的一对入口。 */
export async function registerGuestCostAttempt(input: {
  readonly client: RpcClient;
  readonly guardId: string;
  readonly attemptKey: string;
}): Promise<void> {
  const { error } = await input.client.rpc("server_register_guest_cost_attempt", {
    p_guard_id: input.guardId,
    p_attempt_key: input.attemptKey,
  });
  if (error) {
    throw error instanceof Error
      ? error
      : new Error(`Failed to register guest cost attempt ${input.attemptKey}`);
  }
}

export function settleGuestUsage(input: {
  readonly client: RpcClient;
  readonly guardId: string;
  readonly attemptKey: string;
  readonly measurements: readonly ProviderMeasurement[];
  readonly at?: Date;
}): Promise<boolean> {
  return settleVia(
    input.client,
    "server_settle_guest_cost_attempt",
    { p_guard_id: input.guardId, p_attempt_key: input.attemptKey },
    input.measurements,
    `guest ${input.attemptKey}`,
    input.at ?? new Date(),
  );
}
