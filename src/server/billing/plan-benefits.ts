import { planKeys, type EntitlementPolicy, type Entitlements, type PlanKey } from "../../domain/entitlements";
import { readServerEnvironment } from "../environment";
import { loadEntitlementPolicy } from "./policy";

export type PlanBenefits =
  // 这个档位的权益是**当前真的在执行的**那一份，可以照着写出来。
  | { readonly state: "published"; readonly entitlements: Entitlements }
  // 权益存在但还没审定，或者根本没配。两种情况都不能当成对外承诺展示。
  | { readonly state: "unapproved" }
  | { readonly state: "unavailable" };

/**
 * 把三个档位各自的权益读出来，供定价页展示。
 *
 * 只给权益，不给价格：价格是商业决策，代码里没有，我不会替它编一个。
 * 免费档的数字直接展示，因为那就是此刻正在对每个用户执行的额度；
 * 付费档只有在策略被标记为已审定（`testOnly === false`）之后才展示数字——
 * 本机加载的是 `dev-unapproved-2026-09` 且 `testOnly: true`，把里面的数字
 * 印到公开定价页上，等于对外发布了一份没人签过字的承诺。
 */
export function readPlanBenefits(environment: Readonly<Record<string, string | undefined>>): Readonly<Record<PlanKey, PlanBenefits>> {
  let policy: EntitlementPolicy;
  try {
    // 环境读取也放在 try 里：定价页是公开页面，任何一处环境配置不全都不应该
    // 让它整页 500，最坏的结果应该是「这里暂时没有可展示的额度」。
    const raw = environment.BILLING_POLICY_JSON;
    policy = loadEntitlementPolicy({
      appEnvironment: readServerEnvironment(environment).appEnvironment,
      policy: raw ? (JSON.parse(raw) as unknown) : undefined,
    });
  } catch {
    // 策略缺失或不合法时定价页仍然要能打开，只是一个数字都不写。
    return Object.freeze(Object.fromEntries(planKeys.map((key) => [key, { state: "unavailable" } as const]))) as Readonly<Record<PlanKey, PlanBenefits>>;
  }
  return Object.freeze(Object.fromEntries(planKeys.map((key) => [
    key,
    key === "free" || !policy.testOnly
      ? { state: "published", entitlements: policy.plans[key].entitlements } as const
      : { state: "unapproved" } as const,
  ]))) as Readonly<Record<PlanKey, PlanBenefits>>;
}
