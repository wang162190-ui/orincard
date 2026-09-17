import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectId = "11111111-1111-4111-8111-111111111111";

// 从发货数据派生，别再写死一个数字——上一版写死的 3 在模板扩到 14 之后就成了假红。
// 这里读文件而不是 `import ... from "*.json"`：Playwright 走 ESM 加载器，JSON 导入
// 需要 import attributes，读文件省掉那一整类配置问题。
const templates = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../content/templates.json", import.meta.url)), "utf8"),
) as ReadonlyArray<{ slug: string; category: string }>;

const educationTemplates = templates.filter((template) => template.category === "Education");

test("T075 lists controlled templates and exposes a slug detail", async ({ page }) => {
  await page.goto("/templates");

  await expect(page.getByRole("heading", { name: "Carousel templates" })).toBeVisible();
  await expect(page.getByTestId("template-list").getByRole("article")).toHaveCount(
    templates.length,
  );

  // 定位到具体那张卡片，不用 .first()：分类顺序一变，靠顺序的点击就会点开别的模板。
  // `exact` 是必需的：卡片加了预览图之后，图片本身也是个链接，无障碍名是
  // "View template Clear Idea"，不加 exact 会同时命中两个，直接 strict mode 报错。
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Clear Idea" }) })
    .getByRole("link", { name: "View template", exact: true })
    .click();

  await expect(page).toHaveURL(/\/templates\/clear-idea$/);
  await expect(page.getByRole("heading", { name: "Clear Idea" })).toBeVisible();
  await expect(page.getByTestId("template-slide")).toHaveCount(4);
});

test("D3 filters the gallery down to one category and back", async ({ page }) => {
  await page.goto("/templates");

  const list = page.getByTestId("template-list");
  await page.getByRole("group", { name: "Filter by category" })
    .getByRole("button", { name: "Education", exact: true })
    .click();

  await expect(list.getByRole("article")).toHaveCount(educationTemplates.length);
  await expect(list.getByRole("heading", { level: 2 })).toHaveText(["Education"]);

  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(list.getByRole("article")).toHaveCount(templates.length);
});

test("T075 creates an independent project copy only after an explicit click", async ({ page }) => {
  let creationCount = 0;
  await page.route("**/api/v1/projects", async (route) => {
    creationCount += 1;
    const requestBody = route.request().postDataJSON();
    const slideIds = requestBody.document.slides.map((slide: { id: string }) => slide.id);

    expect(requestBody.document.schemaVersion).toBe(1);
    expect(requestBody.document.templateId).toBe("paper");
    expect(slideIds).toHaveLength(4);
    expect(new Set(slideIds).size).toBe(4);
    expect(slideIds.every((id: string) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);

    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { projectId, revision: 1 } }),
    });
  });

  await page.goto("/templates/clear-idea");
  expect(creationCount).toBe(0);
  await page.getByRole("button", { name: "Use this template" }).click();

  await expect(page).toHaveURL(`/editor/${projectId}`);
  expect(creationCount).toBe(1);
});

test("T075 keeps the template visible when copy creation fails", async ({ page }) => {
  await page.route("**/api/v1/projects", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { message: "Sign in to create a project." } }),
  }));

  await page.goto("/templates/bold-launch");
  await page.getByRole("button", { name: "Use this template" }).click();

  await expect(page).toHaveURL(/\/templates\/bold-launch$/);
  await expect(page.locator('p[role="alert"]')).toHaveText("Sign in to create a project.");
  await expect(page.getByRole("button", { name: "Use this template" })).toBeEnabled();
});
