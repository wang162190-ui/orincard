import { expect, test } from "@playwright/test";
import { TOOL_REGISTRY } from "../../src/features/tools/registry";

test("T066 lists and opens all seven tool routes", async ({ page }) => {
  await page.goto("/tools");
  for (const tool of TOOL_REGISTRY) await expect(page.getByRole("link", { name: new RegExp(tool.label) })).toHaveAttribute("href", `/tools/${tool.id}`);
  for (const tool of TOOL_REGISTRY) {
    await page.goto(`/tools/${tool.id}`);
    await expect(page.getByRole("heading", { name: tool.label })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate candidate" })).toBeVisible();
  }
});
