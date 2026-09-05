import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const captureVisuals = process.env.ORINCARD_CAPTURE_VISUALS === "1";

async function capture(page: Page, name: string) {
  if (!captureVisuals) {
    return;
  }
  await mkdir("output/playwright", { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: `output/playwright/${name}.png`,
  });
}

test("preserves the approved paper, ink rail, signal and desktop three-column direction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/editor/local-visual-desktop");
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");

  const workbench = page.locator(".editor-workbench");
  const content = page.locator(".editor-content");
  const canvas = page.locator(".editor-canvas");
  const controls = page.locator(".editor-controls");
  await expect(workbench).toHaveCSS(
    "grid-template-columns",
    /\d+(?:\.\d+)?px \d+(?:\.\d+)?px \d+(?:\.\d+)?px/,
  );
  await expect(page.locator(".editor-filmstrip")).toHaveCSS("display", "flex");
  await expect(page.locator(".editor-filmstrip")).toHaveCSS("overflow-x", "auto");
  await expect(page.getByLabel("Headline")).toHaveCSS("border-radius", "12px");

  const [contentBox, canvasBox, controlsBox] = await Promise.all([
    content.boundingBox(),
    canvas.boundingBox(),
    controls.boundingBox(),
  ]);
  expect(contentBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(contentBox!.x).toBeLessThan(canvasBox!.x);
  expect(canvasBox!.x).toBeLessThan(controlsBox!.x);

  const colors = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    rail: getComputedStyle(document.querySelector<HTMLElement>(".rail")!).backgroundColor,
    selected: getComputedStyle(
      document.querySelector<HTMLElement>('[data-editor-slide-id="local-slide-01"]')!,
    ).backgroundColor,
  }));
  expect(colors.body).not.toBe(colors.rail);
  expect(colors.selected).not.toBe(colors.body);
  await expect(page.getByRole("link", { name: "Orincard home" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Content" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();

  await capture(page, "editor-desktop");
});

test("uses a canvas-first single column at the approved narrow breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/editor/local-visual-narrow");
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");

  await expect(page.locator(".editor-workbench")).toHaveCSS(
    "grid-template-columns",
    /\d+(?:\.\d+)?px/,
  );
  const [canvasBox, contentBox, controlsBox] = await Promise.all([
    page.locator(".editor-canvas").boundingBox(),
    page.locator(".editor-content").boundingBox(),
    page.locator(".editor-controls").boundingBox(),
  ]);
  expect(canvasBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(canvasBox!.y).toBeLessThan(contentBox!.y);
  expect(contentBox!.y).toBeLessThan(controlsBox!.y);

  await page.getByRole("button", { name: "Slide 2: Lead with the conclusion" }).click();
  await page.getByLabel("Headline").fill("Narrow screen remains editable");
  await expect(page.getByRole("heading", { name: "Narrow screen remains editable" })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  await capture(page, "editor-narrow");
});
