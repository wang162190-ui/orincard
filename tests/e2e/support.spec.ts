import { expect, test } from "@playwright/test";

test("T082 attaches only diagnostic IDs the user explicitly selects", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/support", async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ data: { ticketId: "support-test-1" } }) });
  });
  await page.goto("/support");
  await expect(page.getByRole("status")).toContainText("not attached unless you select");
  await page.getByLabel("Message").fill("Please help me inspect this export failure.");
  await page.getByLabel("Attach job ID").check();
  await page.getByRole("textbox", { name: "job ID", exact: true }).fill("11111111-1111-4111-8111-111111111111");
  await page.getByRole("button", { name: "Send to support" }).click();
  await expect(page.getByRole("status")).toContainText("support-test-1");
  expect(submitted).toEqual({ category: "account", message: "Please help me inspect this export failure.", diagnosticRefs: [{ type: "job", id: "11111111-1111-4111-8111-111111111111" }] });
});

test("T082 keeps unselected diagnostic values out after toggling selection off", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/support", async (route) => { submitted = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ data: { ticketId: "support-test-2" } }) }); });
  await page.goto("/support");
  await page.getByLabel("Message").fill("I need help with my saved account settings.");
  await page.getByLabel("Attach project ID").check();
  await page.getByRole("textbox", { name: "project ID", exact: true }).fill("22222222-2222-4222-8222-222222222222");
  await page.getByLabel("Attach project ID").uncheck();
  await page.getByRole("button", { name: "Send to support" }).click();
  await expect(page.getByRole("status")).toContainText("support-test-2");
  expect(submitted?.diagnosticRefs).toEqual([]);
});

// 三份正文在 2026-09-17 由产品所有者签成 approved，页面因此不再挂草稿横幅和 noindex。
// 原来还有一条断言找 "This directory is a review workspace."——那句话只存在于
// content/legal/README.md，从来没有被渲染过，一直是条假断言，这轮一并删掉。
test("T082 publishes approved legal routes with their policy version", async ({ page }) => {
  for (const slug of ["privacy", "terms", "affiliate"]) {
    await page.goto(`/legal/${slug}`);
    await expect(page.getByText(`Version ${slug}-2026-09-17. In effect now.`)).toBeVisible();
    await expect(page.getByText("Draft — not legally reviewed or approved for publication.")).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
  }
});
