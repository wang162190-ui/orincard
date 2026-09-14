import { expect, test } from "@playwright/test";

// S12 的判据：登录后切换语言，会话不掉。
// 需要真实登录，所以和其他云端验收一样由开关控制，不在默认 e2e 跑里。
const cloud = process.env.ORINCARD_RUN_LOCALE_E2E === "1";
test.skip(!cloud, "Set ORINCARD_RUN_LOCALE_E2E=1 for the real S12 acceptance run.");
test.use({ screenshot: "off", trace: "off" });
test.setTimeout(120_000);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Locale session acceptance is missing required variable: ${name}`);
  return value;
}

test("S12 keeps the session across a locale switch", async ({ page }) => {
  const appOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000").origin;

  await page.goto("/login");
  await page.getByLabel("Email").fill(required("ORINCARD_AUTH_TEST_EMAIL"));
  const passwordField = page.getByLabel("Password");
  await passwordField.fill(required("ORINCARD_AUTH_TEST_PASSWORD"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await passwordField.fill("").catch(() => undefined);
  await expect(page).toHaveURL(`${appOrigin}/`, { timeout: 30_000 });

  // 先确认英文侧确实是已登录状态（私有 API 认得出这个会话）。
  const before = await page.request.get("/api/v1/projects");
  expect(before.status()).toBe(200);

  // 切到中文：走 middleware，会话 cookie 必须活着穿过语言协商。
  await page.goto("/zh-Hans/projects");
  await expect(page).toHaveURL(`${appOrigin}/zh-Hans/projects`);
  await expect(page).not.toHaveURL(/\/login/);
  expect(await page.locator("html").getAttribute("lang")).toBe("zh-Hans");

  // 中文侧同一个会话仍然有效；若刷新出来的 cookie 在 307 那一跳被丢掉，这里会变 401。
  const during = await page.request.get("/api/v1/projects");
  expect(during.status()).toBe(200);

  // next-intl 用 NEXT_LOCALE cookie 记住语言选择：选过中文之后，再访问无前缀的
  // `/projects` 会被 307 到 `/zh-Hans/projects`。这是刻意行为，不是回退失败——
  // 无前缀 URL 对已选中文的用户不再是英文入口。搜索引擎没有这个 cookie，仍然看到英文版。
  await page.goto("/projects");
  await expect(page).toHaveURL(`${appOrigin}/zh-Hans/projects`);
  expect(await page.locator("html").getAttribute("lang")).toBe("zh-Hans");

  // 显式切回英文（语言切换器做的就是写这个 cookie），会话同样不掉。
  await page.context().addCookies([{ name: "NEXT_LOCALE", value: "en", url: appOrigin }]);
  await page.goto("/projects");
  await expect(page).not.toHaveURL(/\/login/);
  expect(await page.locator("html").getAttribute("lang")).toBe("en");
  expect((await page.request.get("/api/v1/projects")).status()).toBe(200);
});
