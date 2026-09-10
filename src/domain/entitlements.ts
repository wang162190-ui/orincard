export const planKeys = ["free", "pro", "creator"] as const;

export type PlanKey = (typeof planKeys)[number];
export type BillingInterval = "month" | "year";

export type Entitlements = Readonly<{
  maxPages: number;
  monthlyGenerations: number;
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
