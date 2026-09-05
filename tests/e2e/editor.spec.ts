import { expect, test, type Page } from "@playwright/test";

async function openEditor(page: Page, id: string) {
  await page.goto(`/editor/${id}`);
  await expect(page.getByRole("heading", { name: "Edit your carousel." })).toBeVisible();
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
}

test("edits offline and restores the isolated IndexedDB draft after reload", async ({
  context,
  page,
}) => {
  await openEditor(page, "local-e2e-offline");
  await context.setOffline(true);

  await page.getByRole("button", { name: "Slide 2: Lead with the conclusion" }).click();
  await page.getByLabel("Headline").fill("Recovered after an offline edit");
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");

  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  await page.getByRole("button", { name: "Slide 2: Recovered after an offline edit" }).click();
  await expect(page.getByLabel("Headline")).toHaveValue("Recovered after an offline edit");

  await page.goto("/editor/local-e2e-isolated");
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  await expect(page.getByRole("button", { name: "Slide 2: Lead with the conclusion" })).toBeVisible();
});

test("enforces 4-to-12 operations and matches pointer drag with the keyboard move path", async ({ page }) => {
  await openEditor(page, "local-e2e-operations");
  const slides = page.locator("[data-editor-slide-id]");
  await expect(slides).toHaveCount(6);

  for (let count = 6; count < 12; count += 1) {
    await page.getByRole("button", { name: "Add slide" }).click();
  }
  await expect(slides).toHaveCount(12);
  await expect(page.getByRole("button", { name: "Add slide" })).toBeDisabled();

  for (let count = 12; count > 4; count -= 1) {
    await page.getByRole("button", { name: "Delete slide 2" }).click();
  }
  await expect(slides).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Delete slide 2" })).toBeDisabled();

  await page.goto("/editor/local-e2e-pointer-sort");
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  const pointerSlides = page.locator("[data-editor-slide-id]");
  const before = await pointerSlides.evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset.editorSlideId),
  );
  await page.getByRole("button", { name: "Drag slide 4" }).dragTo(
    page.locator(`[data-editor-slide-id="${before[2]}"]`),
    { force: true },
  );
  await expect.poll(() =>
    pointerSlides.evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.editorSlideId),
    ),
  ).toEqual([before[0], before[1], before[3], before[2], before[4], before[5]]);
  const pointerOrder = await pointerSlides.evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset.editorSlideId),
  );

  await page.goto("/editor/local-e2e-keyboard-sort");
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  const moveButton = page.getByRole("button", { name: "Move slide 4 up" });
  await moveButton.focus();
  await page.keyboard.press("Enter");
  const keyboardOrder = await page.locator("[data-editor-slide-id]").evaluateAll((items) =>
    items.map((item) => (item as HTMLElement).dataset.editorSlideId),
  );
  expect(keyboardOrder).toEqual(pointerOrder);
});
