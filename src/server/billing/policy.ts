import {
  planKeys,
  type BillingInterval,
  type EntitlementPolicy,
  type Entitlements,
  type PlanKey,
  type PlanPolicy,
} from "../../domain/entitlements";

type AppEnvironment = "development" | "preview" | "production" | "test";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

/**
 * 可选的非负整数。字段缺失返回 `undefined`，**不补 0**。
 *
 * 不能复用 `positiveInteger`：它要求 > 0，而把某个方案的图片额度配成 0
 * 是一个合法且有意义的配置（「这个方案不送图」）。把「没配」折叠成 0 会让
 * 两件不同的事看起来一样，发放侧就再也分不出来了。
 */
function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function parseEntitlements(value: unknown, label: string): Entitlements {
  const input = object(value, label);
  const monthlyImages = optionalNonNegativeInteger(
    input.monthlyImages,
    `${label}.monthlyImages`,
  );
  return Object.freeze({
    maxPages: positiveInteger(input.maxPages, `${label}.maxPages`),
    monthlyGenerations: positiveInteger(
      input.monthlyGenerations,
      `${label}.monthlyGenerations`,
    ),
    // 缺省时不放这个键，而不是放一个 undefined：让 `"monthlyImages" in entitlements`
    // 这种判断也能如实反映「没配」。
    ...(monthlyImages === undefined ? {} : { monthlyImages }),
    hdExport: boolean(input.hdExport, `${label}.hdExport`),
    pptxExport: boolean(input.pptxExport, `${label}.pptxExport`),
    mp4Export: boolean(input.mp4Export, `${label}.mp4Export`),
  });
}

function parsePlan(value: unknown, planKey: PlanKey): PlanPolicy {
  const input = object(value, `plans.${planKey}`);
  const rawPrices = object(input.priceIds ?? {}, `plans.${planKey}.priceIds`);
  const priceIds: Partial<Record<BillingInterval, string>> = {};
  for (const interval of ["month", "year"] as const) {
    const priceId = rawPrices[interval];
    if (priceId !== undefined) {
      if (typeof priceId !== "string" || priceId.trim() === "") {
        throw new Error(`plans.${planKey}.priceIds.${interval} must be a non-empty string`);
      }
      priceIds[interval] = priceId;
    }
  }
  return Object.freeze({
    entitlements: parseEntitlements(input.entitlements, `plans.${planKey}.entitlements`),
    priceIds: Object.freeze(priceIds),
  });
}

export function parseEntitlementPolicy(value: unknown): EntitlementPolicy {
  const input = object(value, "Billing policy");
  if (typeof input.version !== "string" || input.version.trim() === "") {
    throw new Error("Billing policy version is required");
  }
  if (typeof input.testOnly !== "boolean") {
    throw new Error("Billing policy testOnly flag is required");
  }
  const rawPlans = object(input.plans, "Billing policy plans");
  const plans = Object.fromEntries(
    planKeys.map((planKey) => [planKey, parsePlan(rawPlans[planKey], planKey)]),
  ) as Record<PlanKey, PlanPolicy>;
  return Object.freeze({
    version: input.version,
    testOnly: input.testOnly,
    plans: Object.freeze(plans),
  });
}

export function loadEntitlementPolicy(options: {
  appEnvironment: AppEnvironment;
  policy: unknown;
}): EntitlementPolicy {
  if (options.policy === undefined || options.policy === null) {
    throw new Error("BILLING_NOT_CONFIGURED: an approved entitlement policy is required");
  }
  const policy = parseEntitlementPolicy(options.policy);
  if (options.appEnvironment === "production" && policy.testOnly) {
    throw new Error("BILLING_NOT_CONFIGURED: test-only pricing cannot be loaded in production");
  }
  return policy;
}

export function priceIdForCheckout(
  policy: EntitlementPolicy,
  planKey: Exclude<PlanKey, "free">,
  interval: BillingInterval,
): string {
  const priceId = policy.plans[planKey].priceIds[interval];
  if (!priceId) throw new Error("BILLING_NOT_CONFIGURED: requested plan price is unavailable");
  return priceId;
}
