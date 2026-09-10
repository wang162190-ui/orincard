import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

test("T075 lists controlled templates and exposes a slug detail", async ({ page }) => {
  await page.goto("/templates");

  await expect(page.getByRole("heading", { name: "Carousel templates" })).toBeVisible();
  await expect(page.getByTestId("template-list").getByRole("article")).toHaveCount(3);
  await page.getByRole("link", { name: "View template" }).first().click();

  await expect(page).toHaveURL(/\/templates\/clear-idea$/);
  await expect(page.getByRole("heading", { name: "Clear Idea" })).toBeVisible();
  await expect(page.getByTestId("template-slide")).toHaveCount(4);
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
  await expect(page.getByRole("alert")).toHaveText("Sign in to create a project.");
  await expect(page.getByRole("button", { name: "Use this template" })).toBeEnabled();
});
