import { expect, test } from "@playwright/test";

const cloud = process.env.ORINCARD_RUN_TEXT_GENERATION_E2E === "1";
test.use({ screenshot: "off", trace: "off" });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Text generation acceptance is missing required variable: ${name}`);
  return value;
}

test("offers Topic/Text generation with the approved defaults and limits", async ({ page }) => {
  await page.goto("/create");

  await expect(page.getByRole("heading", { name: "Create a carousel" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Topic" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Text" }).click();
  await expect(page.getByLabel("Source text")).toBeVisible();
  await expect(page.getByLabel("Number of slides")).toHaveValue("6");
  await expect(page.getByLabel("Number of slides")).toHaveAttribute("min", "4");
  await expect(page.getByLabel("Number of slides")).toHaveAttribute("max", "12");
  await expect(page.getByLabel("Language")).toHaveValue("English");
  await expect(page.getByLabel("Platform")).toHaveValue("linkedin");
});

test.describe("T031 real Topic/Text generation", () => {
  test.skip(!cloud, "Set ORINCARD_RUN_TEXT_GENERATION_E2E=1 for real generation acceptance.");

  test("opens an editable anonymous Topic result with requested options", async ({ page }) => {
    await page.goto("/create");
    await page.getByLabel("Topic").fill("Build a calm weekly planning ritual");
    await page.getByLabel("Platform").selectOption("tiktok");
    await page.getByLabel("Number of slides").fill("4");
    await page.getByLabel("Instructions").fill("Use short, practical sentences.");
    await page.getByRole("button", { name: "Generate carousel" }).click();

    await expect(page).toHaveURL(/\/editor\/local-generated-/, { timeout: 60_000 });
    await expect(page.locator("[data-editor-slide-id]")).toHaveCount(4);
    await expect(page.getByRole("radio", { name: "TikTok" })).toBeChecked();
  });

  test("persists Text as a registered source, follows its job, and opens the result", async ({ page }) => {
    const email = required("ORINCARD_AUTH_TEST_EMAIL");
    const password = required("ORINCARD_AUTH_TEST_PASSWORD");
    const appUrl = new URL(required("PLAYWRIGHT_BASE_URL")).origin;

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    const passwordField = page.getByLabel("Password");
    await passwordField.fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await passwordField.fill("").catch(() => undefined);
    await expect(page).toHaveURL(`${appUrl}/`, { timeout: 30_000 });

    await page.goto("/create");
    await page.getByRole("tab", { name: "Text" }).click();
    await page.getByLabel("Source text").fill(
      "A useful weekly review separates what changed, what matters next, and what can be dropped.",
    );
    await page.getByLabel("Number of slides").fill("4");
    await page.getByLabel("Instructions").fill("Use a clear educational sequence.");
    const sourceRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/sources",
    );
    await page.getByRole("button", { name: "Generate carousel" }).click();
    const idempotencyKey = (await sourceRequest).headers()["idempotency-key"];

    expect(idempotencyKey).toMatch(/^source-[0-9a-f-]{36}$/i);

    await expect(page.getByText(/Generating:/)).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/editor\/local-generated-/, { timeout: 120_000 });
    await expect(page.locator("[data-editor-slide-id]")).toHaveCount(4);
    await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  });
});
