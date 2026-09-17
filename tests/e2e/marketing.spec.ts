import { expect, test } from "@playwright/test";

test("T074 presents the original marketing path and honest paid-plan waitlist", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /carousel worth saving/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create your first carousel" })).toHaveAttribute("href", "/create");
  await expect(page.getByRole("link", { name: "Explore free tools" })).toHaveAttribute("href", "/tools");
  await expect(page.getByRole("link", { name: "Join the waitlist" })).toHaveAttribute("href", "/pricing#waitlist");

  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1, name: /paid-plan waitlist/i })).toBeVisible();
  for (const plan of ["Free", "Pro", "Creator"]) await expect(page.getByRole("heading", { name: plan, exact: true })).toBeVisible();
  // 2026-09-17：这里原本断言「No email is collected or stored」。等候名单接上之后那句话就是假的——
  // 邮箱真的会写进 public.waitlist_signups。改成断言页面确实有登记表单，并如实说明这个地址的唯一用途。
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByText(/We store the address for that notice only/)).toBeVisible();
  await expect(page.getByText(/\$\d+/)).toHaveCount(0);
  await expect(page.locator('a[href*="checkout"], form[action*="billing"], form[action*="stripe"]')).toHaveCount(0);
});

// S15 的判据：语言切换器在真实浏览器里真的能切，而且切过去之后页面上的字**确实变成中文**。
// 单测里 useRouter 是被短路的（jsdom 没有挂载的 app router），所以真假只以这一条为准。
test("S15 switches the rendered language from the public header", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1, name: /paid-plan waitlist/i })).toBeVisible();

  // 这里用 exact：界面语言切换器和创作页的「生成语言」字段曾经同名 "Language"，
  // 子串匹配让那条真实的 a11y 重名缺陷混了过去，是 accessibility.spec.ts 的严格模式把它抓出来的。
  await page.getByRole("combobox", { name: "Interface language", exact: true }).selectOption("zh-Hans");
  await expect(page).toHaveURL(/\/zh-Hans\/pricing$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  await expect(page.getByRole("heading", { level: 1, name: "先免费开始。付费套餐可加入等候名单。" })).toBeVisible();
  // 同一条路径的中英两版必须落在同一个页面上，而不是被丢回首页。
  await expect(page.getByRole("heading", { name: "创作者版", exact: true })).toBeVisible();

  await page.getByRole("combobox", { name: "界面语言", exact: true }).selectOption("en");
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1, name: /paid-plan waitlist/i })).toBeVisible();
});
