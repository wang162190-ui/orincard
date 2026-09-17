import { expect, test } from "@playwright/test";

const summary = {
  planKey: "pro",
  policyVersion: "sandbox-2026-09",
  status: "past_due",
  currentPeriod: { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" },
  cancelAtPeriodEnd: false,
  entitlements: { maxPages: 20, monthlyGenerations: 40, hdExport: true, pptxExport: true, mp4Export: true },
  balances: [{ resource: "generation", granted: 40, reserved: 2, consumed: 10, remaining: 28, periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z" }],
};

test("T072 shows payment, period and balance states and keeps cancellation in Stripe portal", async ({ page }) => {
  const projectDeletes: string[] = [];
  let portalCalls = 0;
  page.on("request", (request) => { if (request.method() === "DELETE" && request.url().includes("/projects/")) projectDeletes.push(request.url()); });
  await page.route("**/api/v1/billing", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: summary }) }));
  await page.route("**/api/v1/billing/portal", async (route) => { portalCalls += 1; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { url: "/billing?portal=opened" } }) }); });

  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByText("PRO · past due")).toBeVisible();
  await expect(page.getByText("Your latest payment needs attention.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("balance-row")).toContainText("28 remaining · 10 used · 2 pending");
  await expect(page.getByText("Maximum pages: 20")).toBeVisible();

  await page.getByRole("button", { name: "Cancel at period end" }).click();
  await expect.poll(() => portalCalls).toBe(1);
  expect(projectDeletes).toEqual([]);

  // portal 接口返回的是一个跳转地址，应用点完之后会真的跳过去。不等这次跳转落地就直接
  // goto，会把在途的导航打断，Playwright 抛 net::ERR_ABORTED——这是用例自己的竞态，
  // 不是产品行为。
  await page.waitForURL(/portal=opened/);
  await page.goto("/billing");
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await page.getByLabel("Email address").fill("creator@example.com");
  await page.getByRole("button", { name: "Join waitlist" }).click();
  await expect(page.getByRole("status")).toContainText("has not been submitted or stored");
});

test("T072 reports scheduled cancellation without deleting saved work", async ({ page }) => {
  await page.route("**/api/v1/billing", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { ...summary, status: "active", cancelAtPeriodEnd: true } }) }));
  await page.goto("/billing");
  await expect(page.getByText("Cancellation is scheduled for the end of the current period.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel at period end" })).toBeVisible();
});
