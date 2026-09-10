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
  await expect(page.getByText(/No email is collected or stored/)).toBeVisible();
  await expect(page.getByText(/\$\d+/)).toHaveCount(0);
  await expect(page.locator('a[href*="checkout"], form[action*="billing"], form[action*="stripe"]')).toHaveCount(0);
});
