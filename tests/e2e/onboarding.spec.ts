import { expect, test } from "@playwright/test";

/**
 * D4 的两件事，在真实浏览器里各验一遍：
 * 生成之前能先挑模板（挑完真的改了下面的选项，不是个装饰），
 * 以及第一次进编辑器有引导、看完之后不再出现。
 */
test("D4 seeds the generation options from the picked template", async ({ page }) => {
  await page.goto("/create");

  const platform = page.getByRole("combobox", { name: "Platform", exact: true });
  const template = page.getByRole("combobox", { name: "Template", exact: true });
  await expect(platform).toHaveValue("linkedin");
  await expect(template).toHaveValue("paper");

  // Modern Metrics 是 16:9 + signal，与默认值两项都不同，所以它能同时证明两项都被灌进去了。
  await page.locator('[data-template-slug="modern-metrics"]').click();

  await expect(platform).toHaveValue("presentation");
  await expect(template).toHaveValue("signal");
  await expect(page.getByTestId("template-picker").getByRole("status")).toContainText(
    "Modern Metrics",
  );

  // 反过来：用户自己把画幅改回去，选中态必须自己消失，不能继续显示一个不成立的选择。
  await platform.selectOption("linkedin");
  await expect(page.locator('[data-template-slug="modern-metrics"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("D4 shows the editor onboarding once and then never again", async ({ page }) => {
  await page.goto("/editor/local-onboarding-check");

  const onboarding = page.getByTestId("editor-onboarding");
  await expect(onboarding).toBeVisible();
  await expect(onboarding).toContainText("Step 1 of 3");

  await onboarding.getByRole("button", { name: "Next" }).click();
  await expect(onboarding).toContainText("Step 2 of 3");
  await onboarding.getByRole("button", { name: "Next" }).click();
  await expect(onboarding).toContainText("Step 3 of 3");

  await onboarding.getByRole("button", { name: "Got it" }).click();
  await expect(onboarding).toBeHidden();

  await page.reload();
  await expect(page.getByTestId("editor-onboarding")).toHaveCount(0);
  // 引导收起之后编辑器本身照常在，没被它挡住。
  await expect(page.getByRole("region", { name: /canvas/i })).toBeVisible();
});
