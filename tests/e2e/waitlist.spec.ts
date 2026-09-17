import { expect, test } from "@playwright/test";

// 免费档的额度来自运行时正在执行的那份策略，所以这里断言的是「页面写出来的数字」
// 和「服务端真的会发放的数字」是同一个来源，而不是页面上另抄的一份文案。
test("T104 publishes the free allowances that are actually enforced", async ({ page }) => {
  await page.goto("/pricing");
  const summary = await page.request.get("/api/v1/billing");
  const free = summary.ok() ? ((await summary.json()) as { data: { entitlements: { maxPages: number } } }).data.entitlements : null;

  await expect(page.getByText(/Up to \d+ pages per carousel/)).toBeVisible();
  if (free) await expect(page.getByText(`Up to ${free.maxPages} pages per carousel`)).toBeVisible();
});

test("T104 withholds paid allowances and prices that nobody has approved", async ({ page }) => {
  await page.goto("/pricing");
  // 付费档在定价策略仍是 testOnly 时只给定性描述。把 dev-unapproved 的数字印上去，
  // 等于对外发布了一份没人签过字的承诺。
  await expect(page.getByText("Exact allowances for this plan are published once its pricing policy is approved.").first()).toBeVisible();
  await expect(page.getByText("Price not announced yet.").first()).toBeVisible();
  await expect(page.getByText("$")).toHaveCount(0);
});

test("T104 actually submits the waitlist email instead of only showing a notice", async ({ page }) => {
  await page.goto("/pricing");
  await page.getByLabel("Email address").fill("Waitlist.Probe@Example.com");
  const [request] = await Promise.all([
    page.waitForRequest((candidate) => candidate.url().includes("/api/v1/waitlist") && candidate.method() === "POST"),
    page.getByRole("button", { name: "Join waitlist" }).last().click(),
  ]);

  // 地址在提交前就小写化：数据库的唯一约束建在列上，大小写不同会各占一行。
  expect(request.postDataJSON()).toEqual({ email: "waitlist.probe@example.com", source: "pricing", locale: "en" });
  // 结果如实反映服务端的回答：表还没建好时页面必须显示失败，不能假装登记成功。
  const response = await request.response();
  await expect(page.getByRole("status").last()).toHaveText(
    response?.ok() ? "You are on the waitlist. We will email you when paid plans open." : "We could not record your email. Please try again.",
  );
});
