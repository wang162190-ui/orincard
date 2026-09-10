import { expect, test } from "@playwright/test";

test("T078 exposes canonical public content and a public-only sitemap", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/$/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("carousel worth saving");

  const sitemap = await request.get("/sitemap.xml");
  const xml = await sitemap.text();
  expect(sitemap.ok()).toBe(true);
  expect(xml).toContain("/pricing");
  expect(xml).toContain("/templates/clear-idea");
  expect(xml).toContain("/help/getting-started");
  expect(xml).not.toContain("/projects");
});

test("T078 marks private routes noindex independently of robots access rules", async ({ request }) => {
  const privatePage = await request.get("/projects");
  expect(privatePage.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toContain("Disallow: /projects/");
  expect(privatePage.status()).not.toBe(403);
});
