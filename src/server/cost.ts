import type { ProviderMeasurement, ProviderUsage } from "./ai";

/**
 * token 用量 → 微美元的折算。
 *
 * **这里算出来的不是账单金额，是按公开费率折算的成本上界。** 两个原因：
 *
 * 1. DeepSeek 的输入 token 分「缓存命中」与「未命中」两档计价，相差 30 倍。供应商没有拆分
 *    回报 `cached_tokens` 时，本模块按**全部未命中**计价——宁可高估预算占用，不可低估。
 * 2. 峰谷费率按调用发生的 UTC 时刻判定。本模块用调用时刻实时判定，但如果供应商侧的判定
 *    边界与本地时钟有偏差，跨边界的那一次调用可能落在另一档。
 *
 * token 数本身是供应商实测回报的，这一点没有估算成分。折算出的美元数与 DeepSeek 账单会有
 * 差异，`docs/acceptance/costs.md` 里对这个差异有专门说明。
 */

/** 每 token 的微美元单价。$X per 1M tokens 恰好等于 X 微美元/token。 */
export interface TokenRate {
  readonly cacheHitInput: number;
  readonly cacheMissInput: number;
  readonly output: number;
}

export interface ModelRates {
  readonly peak: TokenRate;
  readonly offPeak: TokenRate;
}

/**
 * 取数来源：DeepSeek 官方 API 文档定价页，取数日期 2026-09-12。
 * 峰谷制自 2026-08-16 16:00 UTC 起生效，谷时费率恰为峰时的一半。
 *
 * 另注：曾有公告称 2026-09-14 04:00 UTC 起 deepseek-v4-pro 请求改路由到 V4.1-Flash 并按
 * Flash 计费；该公告已被官方推翻——V4-Pro continue，计费方式不变。此处保留 Flash 费率是因为
 * `deepseek-flash` 是当前在售模型，不是为那次改路由准备的。
 */
export const MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  "deepseek-v4-pro": {
    offPeak: { cacheHitInput: 0.022, cacheMissInput: 0.66, output: 1.98 },
    peak: { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 },
  },
  "deepseek-flash": {
    offPeak: { cacheHitInput: 0.003, cacheMissInput: 0.15, output: 0.6 },
    peak: { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 },
  },
};

export class UnpricedModelError extends Error {
  constructor(readonly model: string) {
    super(
      `No published rate is registered for model "${model}", so its cost cannot be settled. ` +
        "Add it to MODEL_RATES with a dated source, or leave the attempt unsettled — " +
        "never fall back to a guessed rate.",
    );
    this.name = "UnpricedModelError";
  }
}

/**
 * 峰时为 UTC 周一至周五 01:00–04:00 与 06:00–10:00，其余（含整个周末）为谷时。
 * 区间左闭右开：04:00 整点属于谷时。
 */
export function isPeakHour(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export interface PricedUsage {
  /** 向上取整到整数微美元。settle_cost_attempt 只收 bigint，且宁可高估。 */
  readonly actualMicroUsd: number;
  /** 写进 private.cost_attempts.usage 的载荷，按该列的约定只放数字。 */
  readonly usagePayload: Readonly<Record<string, number>>;
}

export function priceTextUsage(input: {
  readonly model: string;
  readonly usage: ProviderUsage;
  readonly at: Date;
}): PricedUsage {
  const rates = MODEL_RATES[input.model];
  if (!rates) throw new UnpricedModelError(input.model);
  const rate = isPeakHour(input.at) ? rates.peak : rates.offPeak;

  // 供应商没拆分缓存明细时按全部未命中计价，得到上界。
  const cachedInput = input.usage.cachedInputTokens ?? 0;
  const uncachedInput = input.usage.inputTokens - cachedInput;

  const microUsd =
    cachedInput * rate.cacheHitInput +
    uncachedInput * rate.cacheMissInput +
    input.usage.outputTokens * rate.output;

  const usagePayload: Record<string, number> = {
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    totalTokens: input.usage.totalTokens,
    // 费率本身就标明了走的是峰时还是谷时，不必另存布尔量，也就守住了「usage 只放数字」的约定。
    rateCacheHitInputMicroUsdPerToken: rate.cacheHitInput,
    rateCacheMissInputMicroUsdPerToken: rate.cacheMissInput,
    rateOutputMicroUsdPerToken: rate.output,
  };
  // 键缺失即代表供应商未拆分回报，与「拆分后命中 0 个」是两回事，不能混为 0。
  if (input.usage.cachedInputTokens !== null) {
    usagePayload.cachedInputTokens = input.usage.cachedInputTokens;
  }

  return { actualMicroUsd: Math.ceil(microUsd), usagePayload };
}

/**
 * attempt_key 的统一形状，必须与既有 SQL 侧逐字符一致——**行是 SQL 先插的，这里只负责结算它**，
 * 拼错一个字符就会另开一行尝试并把同一次调用计两遍。三条既有约定：
 *
 * | operation    | sequence 的含义 | 插入方 |
 * |---|---|---|
 * | `generation` | `public.jobs.attempt + 1` | `20260907002243_b04.sql:294` |
 * | `transcribe` | `trunc(offsetSeconds)`，**不是尝试次数** | `20260908110457_b05_parse_budget.sql:114` |
 * | `candidate`  | 恒为 `1` | `20260907002243_b04.sql:395` |
 *
 * 注意 `generation` 一个 key 覆盖整个 job attempt：若该次 attempt 内发生了 schema 修复重试，
 * 两次供应商调用共用同一个 key。调用方应把多次 measurement **累加后结算一次**，
 * 而不是结算两次——`settle_cost_attempt` 是幂等的，第二次不会累加，只会被忽略或覆盖。
 */
export function attemptKey(jobId: string, operation: string, sequence: number): string {
  return `job:${jobId}:${operation}:${sequence}`;
}

/**
 * 访客生成的 attempt_key。
 *
 * 访客路径没有 `public.jobs` 行（`cost_reservations_subject_check` 要求 job_id 与 guest_guard_id
 * 二选一），所以既有的 `job:` 前缀在这里没有意义，也不存在可递增的 `jobs.attempt`。序号恒为 1：
 * 一次 guard 对应一次供应商调用，重跑同一个 guard 应当复用同一行而不是把同一笔预留计两遍。
 */
export function guestAttemptKey(guardId: string): string {
  return `guest:${guardId}:generation:1`;
}

/** 把同一个 attempt_key 下的多次供应商调用合并成一笔，供 generation 的修复重试路径使用。 */
export function mergeUsage(measurements: readonly ProviderUsage[]): ProviderUsage | null {
  if (measurements.length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cached = 0;
  // 只要有一次没拆分回报缓存明细，合并结果就整体按未报处理——不能拿另一次的明细替它作证。
  let cachedKnown = true;
  for (const m of measurements) {
    inputTokens += m.inputTokens;
    outputTokens += m.outputTokens;
    totalTokens += m.totalTokens;
    if (m.cachedInputTokens === null) cachedKnown = false;
    else cached += m.cachedInputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: cachedKnown ? cached : null,
  };
}

export interface PricedMeasurements extends PricedUsage {
  /** 多次调用时用逗号连接去重后的供应商操作 ID；供应商没回报 ID 时为空串。 */
  readonly providerOperationId: string;
}

/**
 * 把同一个 attempt_key 下的全部供应商调用折算成一笔结算。
 *
 * **逐次定价再求和**，不是先合并 token 再定价：两次调用可能用不同模型，也可能一次落谷时、
 * 一次跨过峰时边界。求和后再套单一费率会算错，而且错在哪一侧不可控。
 */
export function priceMeasurements(
  measurements: readonly ProviderMeasurement[],
  at: Date,
): PricedMeasurements | null {
  const merged = mergeUsage(measurements.map((m) => m.usage));
  if (!merged) return null;

  let actualMicroUsd = 0;
  const rateFingerprints = new Set<string>();
  let firstPayload: Readonly<Record<string, number>> | null = null;
  for (const measurement of measurements) {
    const priced = priceTextUsage({ model: measurement.model, usage: measurement.usage, at });
    actualMicroUsd += priced.actualMicroUsd;
    firstPayload ??= priced.usagePayload;
    rateFingerprints.add(
      [
        priced.usagePayload.rateCacheHitInputMicroUsdPerToken,
        priced.usagePayload.rateCacheMissInputMicroUsdPerToken,
        priced.usagePayload.rateOutputMicroUsdPerToken,
      ].join("/"),
    );
  }

  const usagePayload: Record<string, number> = {
    inputTokens: merged.inputTokens,
    outputTokens: merged.outputTokens,
    totalTokens: merged.totalTokens,
    providerCallCount: measurements.length,
  };
  if (merged.cachedInputTokens !== null) {
    usagePayload.cachedInputTokens = merged.cachedInputTokens;
  }
  // 各次费率不一致时就不写费率列——写任何一档都会误导对账，宁可只留 token 数与总额。
  if (rateFingerprints.size === 1 && firstPayload) {
    usagePayload.rateCacheHitInputMicroUsdPerToken =
      firstPayload.rateCacheHitInputMicroUsdPerToken;
    usagePayload.rateCacheMissInputMicroUsdPerToken =
      firstPayload.rateCacheMissInputMicroUsdPerToken;
    usagePayload.rateOutputMicroUsdPerToken = firstPayload.rateOutputMicroUsdPerToken;
  }

  const ids = [...new Set(measurements.map((m) => m.providerOperationId).filter(Boolean))];
  return { actualMicroUsd, usagePayload, providerOperationId: ids.join(",") };
}
