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
  let checkoutBody: unknown;
  page.on("request", (request) => { if (request.method() === "DELETE" && request.url().includes("/projects/")) projectDeletes.push(request.url()); });
  await page.route("**/api/v1/billing", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: summary }) }));
  await page.route("**/api/v1/billing/portal", async (route) => { portalCalls += 1; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { url: "/billing?portal=opened" } }) }); });
  await page.route("**/api/v1/billing/checkout", async (route) => { checkoutBody = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { url: "/billing?checkout=opened" } }) }); });

  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  await expect(page.getByText("PRO · past due")).toBeVisible();
  await expect(page.getByText("Your latest payment needs attention.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("balance-row")).toContainText("28 remaining · 10 used · 2 pending");
  await expect(page.getByText("Maximum pages: 20")).toBeVisible();

  await page.getByRole("button", { name: "Cancel at period end" }).click();
  await expect.poll(() => portalCalls).toBe(1);
  expect(projectDeletes).toEqual([]);

  await page.goto("/billing");
  await page.getByRole("button", { name: "Upgrade" }).click();
  await page.getByLabel("Creator").check();
  await page.getByLabel("Billing interval").selectOption("year");
  await page.getByRole("button", { name: "Continue to secure checkout" }).click();
  await expect.poll(() => checkoutBody).toEqual({ planKey: "creator", interval: "year" });
});

test("T072 reports scheduled cancellation without deleting saved work", async ({ page }) => {
  await page.route("**/api/v1/billing", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { ...summary, status: "active", cancelAtPeriodEnd: true } }) }));
  await page.goto("/billing");
  await expect(page.getByText("Cancellation is scheduled for the end of the current period.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel at period end" })).toBeVisible();
});
