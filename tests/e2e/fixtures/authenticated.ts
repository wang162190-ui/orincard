import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";

/**
 * 共享的真实登录 fixture。
 *
 * 在它之前，需要登录态的 spec 各自抄一遍 UI 登录流程（见
 * `tests/e2e/walking-skeleton.spec.ts` 的 `/login` 那一段）。抄第三遍的时候，
 * 三份就会开始漂移——而登录是每个登录态断言的前置条件，漂移一次就是一整类测试失效。
 *
 * 这里只登录**一次**（worker 级），把 storageState 复用给同一个 worker 里的所有测试。
 * `playwright.config.ts` 是 `workers: 1`，所以实际上整轮只发生一次登录。
 */

/** 与 `ORINCARD_RUN_WALKING_SKELETON_E2E` 同一个口径：真实登录默认不跑。 */
export const runsAgainstCloud = process.env.ORINCARD_RUN_FULL_PRODUCT_E2E === "1";

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Full-product acceptance is missing required variable: ${name}`);
  return value;
}

export function appBaseUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL?.trim() || "http://127.0.0.1:3000";
}

type AuthWorkerFixtures = {
  /** 已登录会话的 storageState 文件路径。worker 级，整轮只产生一次。 */
  readonly authenticatedStorageState: string;
};

export const authenticatedTest = base.extend<object, AuthWorkerFixtures>({
  authenticatedStorageState: [
    async ({ browser }, use) => {
      const email = requiredEnv("ORINCARD_AUTH_TEST_EMAIL");
      const password = requiredEnv("ORINCARD_AUTH_TEST_PASSWORD");
      const baseURL = appBaseUrl();
      const statePath = join(await mkdtemp(join(tmpdir(), "orincard-auth-")), "state.json");

      // browser.newContext() 不继承 config 里的 use.baseURL，必须显式传。
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      try {
        await page.goto("/login");
        await page.getByLabel("Email").fill(email);
        const passwordField = page.getByLabel("Password");
        await passwordField.fill(password);
        await page.getByRole("button", { name: "Sign in" }).click();
        // 登录成功后落回首页。断言它而不是等固定时间：密码错误时页面停在 /login，
        // 此时应当立刻失败并说清楚，而不是让后面每一条断言都以「未登录」的形态失败。
        await expect(page, "sign-in did not land on the home page").toHaveURL(
          `${new URL(baseURL).origin}/`,
          { timeout: 30_000 },
        );
        // 密码不留在输入框里：失败时 Playwright 会存截图与 trace。
        await passwordField.fill("").catch(() => undefined);
        await context.storageState({ path: statePath });
      } finally {
        await context.close();
      }

      await use(statePath);
    },
    { scope: "worker" },
  ],

  // 覆盖 storageState 选项：导入 authenticatedTest 的 spec 里，每个 page 都是登录态。
  storageState: async ({ authenticatedStorageState }, use) => {
    await use(authenticatedStorageState);
  },
});

export { expect };
