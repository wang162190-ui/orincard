export const planKeys = ["free", "pro", "creator"] as const;

export type PlanKey = (typeof planKeys)[number];
export type BillingInterval = "month" | "year";

export type Entitlements = Readonly<{
  maxPages: number;
  monthlyGenerations: number;
  /**
   * 每周期可生成的 AI 图片张数，喂给 `resource = 'image'` 那个额度桶。
   *
   * 刻意是**可选**的：现存的 `BILLING_POLICY_JSON` 里没有这个字段，做成必填会让
   * `loadEntitlementPolicy` 直接抛错，把 `/billing` 和所有提交路由一起打崩。
   * 缺省时行为与加这个字段之前完全一致——不发放 image 桶，portrait / ai_image
   * 仍 quota_exceeded，是一个诚实的「没配」。`0` 与 `undefined` 含义不同：
   * 前者是「明确配成不给」，后者是「还没决定」。
   */
  monthlyImages?: number;
  hdExport: boolean;
  pptxExport: boolean;
  mp4Export: boolean;
}>;

export type PlanPolicy = Readonly<{
  entitlements: Entitlements;
  priceIds: Partial<Record<BillingInterval, string>>;
}>;

export type EntitlementPolicy = Readonly<{
  version: string;
  testOnly: boolean;
  plans: Readonly<Record<PlanKey, PlanPolicy>>;
}>;

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && planKeys.includes(value as PlanKey);
}

export function entitlementsForPlan(
  policy: EntitlementPolicy,
  serverPlanKey: PlanKey,
): Entitlements {
  return policy.plans[serverPlanKey].entitlements;
}
