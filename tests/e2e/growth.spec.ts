import { expect, test } from "@playwright/test";

test("T084 keeps the public growth entrances available", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Turn what you know into a carousel worth saving." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Plans" }).first()).toHaveAttribute("href", "/pricing");
  await expect(page.getByRole("link", { name: "Explore free tools" })).toHaveAttribute("href", "/tools");

  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: /templates/i })).toBeVisible();
  await page.goto("/affiliate");
  await expect(page.getByRole("heading", { name: "Share Orincard responsibly" })).toBeVisible();
});

test("T084 does not attribute an affiliate visit without explicit consent", async ({ page }) => {
  await page.goto("/affiliate?ref=TEST_CODE");
  const response = await page.request.post("/api/v1/affiliate/attribute", {
    data: { code: "TEST_CODE", consent: false },
  });

  expect(response.status()).toBe(204);
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("T084 submits an affiliate application and keeps links pending until approval", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/affiliate/apply", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { id: "affiliate-test-1", status: "pending" } }),
    });
  });
  await page.goto("/affiliate");
  await page.getByLabel("Primary channel").fill("Newsletter");
  await page.getByLabel("Audience and promotion plan").fill("Product designers who opted in to receive practical workflow notes.");
  await page.getByRole("button", { name: "Apply for review" }).click();

  await expect(page.getByRole("status")).toContainText("referral link appears only after approval");
  expect(submitted).toEqual({
    channel: "Newsletter",
    audience: "Product designers who opted in to receive practical workflow notes.",
  });
});

test("T084 shows pending and approved affiliate status without purchaser identity", async ({ page }) => {
  const endpoint = "**/api/v1/affiliate/dashboard";
  await page.route("**/api/v1/affiliate/dashboard", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { status: "pending", referralUrl: null, clicks: 0, conversions: 0, grossCommissionCents: 0, refundedCommissionCents: 0, netCommissionCents: 0 } }) });
  });

  await page.goto("/affiliate/dashboard");
  await expect(page.getByText("pending", { exact: true })).toBeVisible();
  await expect(page.getByText("A referral link is available after approval.")).toBeVisible();
  await page.unroute(endpoint);
  await page.route(endpoint, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { status: "approved", referralUrl: "http://127.0.0.1:3000/affiliate?ref=APPROVED_CODE", clicks: 8, conversions: 2, grossCommissionCents: 1200, refundedCommissionCents: 300, netCommissionCents: 900 } }) });
  });
  await page.reload();
  await expect(page.getByRole("link", { name: /APPROVED_CODE/ })).toBeVisible();
  await expect(page.getByText("$9.00")).toBeVisible();
  await expect(page.getByText("never disclose purchaser identities")).toBeVisible();
});

test("T084 sends only support diagnostic IDs selected by the user", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/support", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ data: { ticketId: "support-growth-1" } }) });
  });
  await page.goto("/support");
  await page.getByLabel("Message").fill("Please help me understand this export failure.");
  await page.getByLabel("Attach export ID").check();
  await page.getByRole("textbox", { name: "export ID", exact: true }).fill("11111111-1111-4111-8111-111111111111");
  await page.getByRole("button", { name: "Send to support" }).click();

  await expect(page.getByRole("status")).toContainText("support-growth-1");
  expect(submitted?.diagnosticRefs).toEqual([{ type: "export", id: "11111111-1111-4111-8111-111111111111" }]);
});

test("T084 exposes legal text only as non-indexed, unapproved review drafts", async ({ page }) => {
  for (const slug of ["privacy", "terms", "affiliate"]) {
    await page.goto(`/legal/${slug}`);
    await expect(page.getByText("Draft — not legally reviewed or approved for publication.")).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByRole("heading", { name: "Review status" })).toBeVisible();
  }
});
